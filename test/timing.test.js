// Timing approvals: files sourced on a Sunday or entered after 6 pm wait for the team; top-up secondary buyouts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { timing } from '../src/cases.js';

const PASSWORD = 'password123';
let server, base, ids;

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm1@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('TL Two', 'tl2@t.local', 'team_leader', { region: 'DXB' });
  add('Cara', 'cara@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'credit_card', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Lina', 'lina@t.local', 'sales', { region: 'DXB', sales_code: 'D-3', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Pat', 'proc@t.local', 'processing', { region: 'DXB' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Gina', 'gov@t.local', 'governance');
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: await r.json() };
  };
}


const UAE = (iso) => Date.parse(iso) - 4 * 3600e3; // a UAE wall-clock time as an instant
const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const loan = (extra = {}) => ({ region: 'DXB', core_product: 'personal_loan', customer_name: 'Timing Test', phone: '+971 50 777 8888', city: 'Dubai', salary: 15000, source: 'Walk-in', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 60000, interest_rate: 6, pl_tenure: 48, fpd, ...extra });

test('a file sourced on a Sunday waits for the team leader or sales manager before verification', async () => {
  const cara = await login('cara@t.local');
  const tl2 = await login('tl2@t.local');
  const proc = await login('proc@t.local');
  timing.now = () => UAE('2026-10-05T10:00:00'); // Monday morning
  const normal = (await cara('POST', '/cases', loan({ sourcing_date: '2026-10-05' }))).data.case;
  assert.deepEqual([normal.status, normal.timing_flag], ['pending_verification', null]);
  const sunday = (await cara('POST', '/cases', loan({ sourcing_date: '2026-10-04' }))).data.case;
  assert.deepEqual([sunday.status, sunday.timing_flag], ['awaiting_approval', 'sunday']);
  assert.ok(sunday.events.some((e) => e.type === 'timing_flagged' && /Sunday/.test(e.detail)));
  assert.ok((await tl2('GET', '/notifications')).data.items.some((n) => n.case_id === sunday.id && /Sunday/.test(n.message)));
  assert.equal((await proc('POST', `/cases/${sunday.id}/actions`, { action: 'claim' })).status, 409);
  const seen = (await tl2('GET', `/cases/${sunday.id}`)).data.case;
  assert.ok(seen.allowed_actions.includes('approve_timing') && !seen.allowed_actions.includes('approve_card'));
  assert.equal((await proc('POST', `/cases/${sunday.id}/actions`, { action: 'approve_timing' })).status, 403);
  const ok = (await tl2('POST', `/cases/${sunday.id}/actions`, { action: 'approve_timing', note: 'Weekend campaign' })).data.case;
  assert.deepEqual([ok.status, ok.timing_approved_by_name, ok.timing_note], ['pending_verification', 'TL Two', 'Weekend campaign']);
  assert.equal((await proc('POST', `/cases/${sunday.id}/actions`, { action: 'claim' })).status, 200);
});

test('a file entered after 6 pm is flagged; the team can return it and it waits again on resubmission', async () => {
  const cara = await login('cara@t.local');
  const sm = await login('sm1@t.local');
  timing.now = () => UAE('2026-10-05T17:59:00');
  assert.equal((await cara('POST', '/cases', loan({ sourcing_date: '2026-10-05' }))).data.case.status, 'pending_verification');
  timing.now = () => UAE('2026-10-05T18:00:00');
  const late = (await cara('POST', '/cases', loan({ sourcing_date: '2026-10-05' }))).data.case;
  assert.deepEqual([late.status, late.timing_flag], ['awaiting_approval', 'after_hours']);
  assert.equal((await sm('POST', `/cases/${late.id}/actions`, { action: 'decline_timing' })).status, 400);
  const back = (await sm('POST', `/cases/${late.id}/actions`, { action: 'decline_timing', note: 'Enter it tomorrow with the documents' })).data.case;
  assert.equal(back.status, 'returned_to_sales');
  assert.equal((await cara('POST', `/cases/${late.id}/actions`, { action: 'resubmit' })).data.case.status, 'awaiting_approval');
  assert.equal((await sm('POST', `/cases/${late.id}/actions`, { action: 'approve_timing' })).data.case.status, 'pending_verification');
  // Sunday evening carries both flags.
  timing.now = () => UAE('2026-10-04T19:30:00');
  assert.equal((await cara('POST', '/cases', loan({ sourcing_date: '2026-10-04' }))).data.case.timing_flag, 'sunday,after_hours');
  timing.now = () => UAE('2026-10-05T10:00:00');
});

test('a card below salary on a Sunday needs both approvals before it goes for verification', async () => {
  const cara = await login('cara@t.local');
  const tl2 = await login('tl2@t.local');
  timing.now = () => UAE('2026-10-04T11:00:00');
  const c = (await cara('POST', '/cases', { region: 'DXB', core_product: 'credit_card', customer_name: 'Both Rules', phone: '+971 50 777 9999', city: 'Dubai', salary: 9000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: '2026-10-04' })).data.case;
  timing.now = () => UAE('2026-10-05T10:00:00');
  assert.equal(c.status, 'awaiting_approval');
  const seen = (await tl2('GET', `/cases/${c.id}`)).data.case;
  assert.ok(seen.allowed_actions.includes('approve_card') && seen.allowed_actions.includes('approve_timing'));
  const one = (await tl2('POST', `/cases/${c.id}/actions`, { action: 'approve_card', exception: 'promotion' })).data.case;
  assert.deepEqual([one.status, one.card_salary_exception, one.allowed_actions.includes('approve_card')], ['awaiting_approval', 'promotion', false]);
  assert.equal((await tl2('POST', `/cases/${c.id}/actions`, { action: 'approve_timing' })).data.case.status, 'pending_verification');
});

test('a top-up loan can carry secondary buyout details', async () => {
  const lina = await login('lina@t.local');
  const r = await lina('POST', '/cases', loan({ sourcing_date: '2026-10-05', personal_loan_type: 'top_up', full_loan_amount: 200000, incremental_amount: 50000, secondary_buyout: 'yes', pl_buyouts: [{ role: 'secondary', kind: 'credit_card', bank: 'HSBC', amount: 20000 }] }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.case.secondary_buyout, 'yes');
  assert.deepEqual(r.data.case.pl_buyouts.map((b) => [b.role, b.kind, b.bank]), [['secondary', 'credit_card', 'HSBC']]);
  assert.equal((await lina('POST', '/cases', loan({ sourcing_date: '2026-10-05', personal_loan_type: 'top_up', full_loan_amount: 200000, incremental_amount: 50000, secondary_buyout: 'yes' }))).status, 400);
  const none = (await lina('POST', '/cases', loan({ sourcing_date: '2026-10-05', personal_loan_type: 'top_up', full_loan_amount: 200000, incremental_amount: 50000, secondary_buyout: 'no' }))).data.case;
  assert.deepEqual([none.secondary_buyout, none.pl_buyouts], ['no', []]);
});

test('governance marks a complaint valid or invalid; a valid one removes the file from incentive with a remark', async () => {
  const cara = await login('cara@t.local');
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  const head = await login('head@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const card = { region: 'DXB', core_product: 'credit_card', customer_name: 'Complaint Case', phone: '+971 50 123 9999', city: 'Dubai', salary: 32000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: '2026-10-05' };
  const a = (await cara('POST', '/cases', card)).data.case;
  const b = (await cara('POST', '/cases', { ...card, customer_name: 'Clean Case', phone: '+971 50 123 8888' })).data.case;
  for (const id of [a.id, b.id]) assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200);
  const before = (await cara('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([before.cards_sold, before.excluded_files, before.remark], [2, 0, '']);
  // No decision until there is a complaint number; then Valid or Invalid only.
  assert.equal((await gov('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'valid' })).status, 403);
  await gov('POST', `/cases/${a.id}/actions`, { action: 'set_complaint', complaint_number: 'CMP-2026-0500' });
  assert.equal((await gov('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'maybe' })).status, 400);
  assert.equal((await mis('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'valid' })).status, 403);
  const valid = (await gov('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'valid', note: 'Mis-sold fee' })).data.case;
  assert.deepEqual([valid.complaint_status, valid.complaint_decided_by_name, valid.complaint_decision_note], ['valid', 'Gina', 'Mis-sold fee']);
  assert.ok(valid.events.some((e) => e.type === 'complaint_decision' && e.detail === 'valid'));
  assert.ok((await cara('GET', '/notifications')).data.items.some((n) => n.case_id === a.id && /Removed from incentive due to valid complaint cases/.test(n.message)));
  const after = (await cara('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([after.cards_sold, after.files, after.excluded_files, after.remark], [1, 1, 1, 'Removed from incentive due to valid complaint cases (1 file)']);
  const row = (await head('GET', `/reports/incentives?cycle=${cycle}`)).data.rows.find((r) => r.staff === 'Cara');
  assert.deepEqual([row.cards_sold, row.excluded_files, row.remark], [1, 1, 'Removed from incentive due to valid complaint cases (1 file)']);
  // Invalid puts it back.
  assert.equal((await gov('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'valid' })).status, 409);
  assert.equal((await gov('POST', `/cases/${a.id}/actions`, { action: 'decide_complaint', complaint_status: 'invalid' })).data.case.complaint_status, 'invalid');
  assert.equal((await cara('GET', `/incentives/me?cycle=${cycle}`)).data.incentive.cards_sold, 2);
});
