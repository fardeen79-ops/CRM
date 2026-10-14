// The bank's application status on a file: set by MIS, by product, with the CRM's case status derived from it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { BANK_STATUSES, caseStatusOf, bankStatusLabel, matchBankStatus } from '../src/bank-status.js';

const PASSWORD = 'password123';
let server, base, ids;
const HRMS = {}; // the HRMS code of each fixture, the username at sign-in

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (HRMS[email] = extra.hrms_code || null, ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
  add('Pam', 'proc@t.local', 'processing');
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: HRMS[email] || email, password: PASSWORD }) });
  const cookie = r.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const res = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, data: await res.json().catch(() => ({})) };
  };
}
const loan = (extra = {}) => ({ journey_type: 'emirates_id', customer_name: 'Loan Customer', region: 'DXB', phone: '+971 50 111 2222', city: 'Dubai', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 100000, interest_rate: 8.5, pl_tenure: 48, fpd: '2026-11-01', source: 'Walk-in', ...extra });
const card = (extra = {}) => ({ journey_type: 'emirates_id', customer_name: 'Card Customer', region: 'DXB', phone: '+971 50 111 3333', city: 'Dubai', product: 'credit_card', credit_card: 'Titanium Credit Card', card_fee_type: 'fyf', salary: 32000, salary_bank: 'Mashreq', source: 'Walk-in', ...extra });

test("the bank's lists per product and what each status means for the case", () => {
  assert.deepEqual(Object.values(BANK_STATUSES).map((l) => l.length), [27, 19, 29]);
  assert.equal(caseStatusOf('COMPLETED'), 'completed');
  assert.equal(caseStatusOf('AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER'), 'sent_to_check'); // account opened, still waiting for the salary credit
  for (const s of ['REJECTED', 'REJECTED_BY_CHECKER', 'REJECTED_BY_COMPLIANCE', 'CANCELLED', 'CANCELLED_FSK_HIT', 'TERMINATE']) assert.equal(caseStatusOf(s), 'rejected', s);
  for (const s of ['AWAITING_CUSTOMER_ACTION', 'AWAITING_USER_ACTION', 'RETURNED_BY_CHECKER', 'Refer To Sourcing, FV, OV, CV', 'BANK_STATEMENT_FAILED']) assert.equal(caseStatusOf(s), 'applicant_review', s);
  for (const s of ['SENT_TO_RCC', 'SUBMITTED', 'ON_HOLD', 'Underwriter', 'PDOC', 'REJECT_REVIEW']) assert.equal(caseStatusOf(s), 'sent_to_check', s);
  assert.equal(bankStatusLabel('AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER'), 'AO completed, waiting for salary transfer');
  assert.equal(bankStatusLabel('REFERRED_BY_RCC'), 'Referred by RCC');
  assert.equal(bankStatusLabel('Dealer Document Collection'), 'Dealer Document Collection');
  assert.equal(matchBankStatus('sent to rcc', ['credit_card']), 'SENT_TO_RCC');
  assert.equal(matchBankStatus('Vehicle Registration', ['personal_loan']), null); // not a loan status
  assert.equal(matchBankStatus('refer to sourcing,fv,ov,cv', ['auto_loan']), 'Refer To Sourcing, FV, OV, CV');
});

test('MIS sets the bank status on a file and the case status follows; sales and processors cannot', async () => {
  const dana = await login('dana@t.local');
  const mis = await login('mis@t.local');
  const proc = await login('proc@t.local');
  const tl = await login('tl@t.local');
  const f = (await dana('POST', '/cases', loan({ app_id: 'BS-1' }))).data.case;
  const page = (await mis('GET', `/cases/${f.id}`)).data.case;
  assert.ok(page.allowed_actions.includes('set_bank_status'));
  assert.deepEqual(page.bank_status_options.map((o) => o.value), BANK_STATUSES.personal_loan);
  assert.equal(page.bank_status_options.find((o) => o.value === 'COMPLETED').case_status, 'completed');
  assert.ok(!(await proc('GET', `/cases/${f.id}`)).data.case.allowed_actions.includes('set_bank_status'));
  assert.equal((await dana('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'SENT_TO_RCC' })).status, 403);
  // A card status is not a loan status
  assert.equal((await mis('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'SENT_TO_COMPLIANCE' })).status, 400);

  // In process at the bank: the case status stays Sent to checker
  let r = await mis('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'SENT_TO_RCC' });
  assert.equal(r.status, 200);
  assert.deepEqual([r.data.case.bank_status, r.data.case.bank_status_label, r.data.case.case_status, r.data.case.bank_status_by_name], ['SENT_TO_RCC', 'Sent to RCC', 'sent_to_check', 'Mira']);
  assert.equal((await mis('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'SENT_TO_RCC' })).status, 409);

  // Waiting on the customer: Applicant review, with the bank status as the note, and the file's leaders told
  r = await mis('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'awaiting customer action' });
  assert.deepEqual([r.data.case.bank_status, r.data.case.case_status, r.data.case.case_status_note], ['AWAITING_CUSTOMER_ACTION', 'applicant_review', 'Bank status: Awaiting customer action']);
  assert.ok((await tl('GET', '/notifications')).data.items.some((n) => /Applicant review/.test(n.message) && n.case_id === f.id));
  assert.ok((await dana('GET', '/notifications')).data.items.some((n) => /Applicant review/.test(n.message) && n.case_id === f.id));

  // Completed: the loan's disbursal is recorded, given or taken from the file
  r = await tl('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'COMPLETED', pl_disbursed_amount: 95000 });
  assert.deepEqual([r.data.case.case_status, r.data.case.pl_disbursed_amount], ['completed', 95000]);
  const types = r.data.case.events.map((e) => e.type);
  assert.ok(types.includes('bank_status') && types.includes('case_status') && types.includes('disbursal'));
  assert.equal(r.data.case.events.find((e) => e.type === 'bank_status').detail, 'COMPLETED');

  // Rejected afterwards clears the completion
  r = await mis('POST', `/cases/${f.id}/actions`, { action: 'set_bank_status', bank_status: 'CANCELLED_FSK_HIT', note: 'FSK hit' });
  assert.deepEqual([r.data.case.case_status, r.data.case.case_status_note, r.data.case.pl_disbursed_amount], ['rejected', 'FSK hit', null]);
});

test('the Case status upload takes a Bank status column, by product, and the case status follows', async () => {
  const dana = await login('dana@t.local');
  const mis = await login('mis@t.local');
  const a = (await dana('POST', '/cases', card({ app_id: 'BS-CARD-1' }))).data.case.id;
  const b = (await dana('POST', '/cases', loan({ app_id: 'BS-LOAN-2', loan_amount: 70000 }))).data.case.id;
  const c = (await dana('POST', '/cases', card({ app_id: 'BS-CARD-3' }))).data.case.id;
  const d = (await dana('POST', '/cases', loan({ app_id: 'BS-LOAN-4' }))).data.case.id;
  const csv = ['Reference,Bank status,Case status,Note,Personal loan disbursed (AED)',
    'BS-CARD-1,AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER,,,',
    'BS-LOAN-2,Completed,,,',
    `CRM-${String(c).padStart(6, '0')},Vehicle Registration,,,`,
    `CRM-${String(d).padStart(6, '0')},,Rejected,Duplicate,`,
  ].join('\n');
  const done = (await mis('POST', '/import/case_status', { csv })).data;
  assert.deepEqual(done.rows.map((x) => x.ok), [true, true, false, true], JSON.stringify(done.rows.map((x) => x.error || x.label)));
  assert.match(done.rows[0].label, /AO completed, waiting for salary transfer → Sent to checker/);
  assert.match(done.rows[1].label, /Completed → Completed/);
  assert.match(done.rows[2].error, /not a bank status for a Credit Card file/);
  const ca = (await mis('GET', `/cases/${a}`)).data.case;
  assert.deepEqual([ca.bank_status, ca.case_status], ['AO_COMPLETED_WAITING_FOR_SALARY_TRANSFER', 'sent_to_check']);
  const cb = (await mis('GET', `/cases/${b}`)).data.case;
  assert.deepEqual([cb.bank_status, cb.case_status, cb.pl_disbursed_amount], ['COMPLETED', 'completed', 70000]); // blank disbursal takes the loan amount
  assert.deepEqual([(await mis('GET', `/cases/${d}`)).data.case.case_status, (await mis('GET', `/cases/${c}`)).data.case.bank_status], ['rejected', null]);
  // The bank status is on the reports
  const reg = (await mis('GET', '/reports/register?from=2026-01-01&to=2026-12-31')).data;
  assert.ok(reg.columns.some((c) => c.key === 'bank_status'));
  assert.ok(reg.rows.some((r) => r.bank_status === 'AO completed, waiting for salary transfer'));
});
