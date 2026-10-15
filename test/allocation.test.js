// Verification: completion on deviation, and processors allocated to sales team leaders.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser, loginId } from './helpers/create-user.mjs';

const PASSWORD = 'password123';
let server, base, ids;
const HRMS = {}; // the HRMS code of each fixture, the username at sign-in

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (HRMS[email] = extra.hrms_code || null, ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm1@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('TL Two', 'tl2@t.local', 'team_leader', { region: 'DXB' });
  add('TL Abu Dhabi', 'tl3@t.local', 'team_leader', { region: 'AUH' });
  add('SM Direct', 'sm2@t.local', 'sales_manager', { region: 'DXB' });
  add('Nour', 'nour@t.local', 'sales', { region: 'DXB', sales_code: 'D-9', core_product: 'credit_card', team_leader_id: ids['sm2@t.local'], sales_manager_id: ids['sm2@t.local'] });
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Cara', 'cara@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'credit_card', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Lina', 'lina@t.local', 'sales', { region: 'DXB', sales_code: 'D-3', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Pat', 'pat@t.local', 'processing', { region: 'DXB' });
  add('Omar', 'omar@t.local', 'processing', { region: 'DXB' });
  add('Aziz', 'aziz@t.local', 'processing', { region: 'AUH' });
  add('Vera', 'vlead@t.local', 'processing_lead', { region: 'DXB' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Gina', 'gov@t.local', 'governance');
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function loginCookie(email) {
  const r = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: HRMS[email] || loginId(email), password: PASSWORD }) });
  return r.headers.get('set-cookie').split(';')[0];
}
async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: HRMS[email] || loginId(email), password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: await r.json() };
  };
}

/** The team leader validates a sales submission so it reaches verification. */
async function tlOk(id, who = 'tl@t.local') {
  const r = await (await login(who))('POST', `/cases/${id}/actions`, { action: 'validate' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return r.data.case;
}


const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const loan = (extra = {}) => ({ journey_type: 'emirates_id', region: 'DXB', core_product: 'personal_loan', customer_name: 'Alloc Test', phone: '+971 50 222 3333', city: 'Dubai', salary: 15000, source: 'Walk-in', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 60000, interest_rate: 6, pl_tenure: 48, fpd, sourcing_date: '2026-10-05', ...extra });

test('a processor can complete verification on a deviation, with a mandatory note', async () => {
  const dana = await login('dana@t.local');
  const pat = await login('pat@t.local');
  const c = (await dana('POST', '/cases', loan())).data.case;
  assert.equal(c.status, 'awaiting_approval');
  await tlOk(c.id);
  assert.ok((await pat('GET', `/cases/${c.id}`)).data.case.allowed_actions.includes('complete_deviation'));
  assert.equal((await pat('POST', `/cases/${c.id}/actions`, { action: 'complete_deviation' })).status, 400);
  const done = (await pat('POST', `/cases/${c.id}/actions`, { action: 'complete_deviation', note: 'Customer abroad; employer HR confirmed the details in writing' })).data.case;
  assert.deepEqual([done.status, done.verified_basis, done.verified_by_name], ['completed', 'deviation', 'Pat']);
  assert.ok(done.events.some((e) => e.type === 'complete_deviation' && e.detail === 'deviation' && /HR confirmed/.test(e.note)));
  assert.ok((await dana('GET', '/notifications')).data.items.some((n) => n.case_id === c.id && /based on deviation/.test(n.message)));
});

test('the verification team leader allocates processors to sales team leaders; their files reach that processor only', async () => {
  const cara = await login('cara@t.local');
  const dana = await login('dana@t.local');
  const pat = await login('pat@t.local');
  const omar = await login('omar@t.local');
  const vera = await login('vlead@t.local');
  const head = await login('head@t.local');
  assert.equal((await vera('GET', '/me')).data.user.role_key, 'processing_lead');
  assert.ok((await vera('GET', '/me')).data.meta.perms.pages.includes('allocation'));
  // Only the verification team leader (or a business head) allocates.
  assert.equal((await pat('GET', '/allocations')).status, 403);
  const list = (await vera('GET', '/allocations')).data;
  assert.ok(list.team_leaders.some((t) => t.id === ids['tl2@t.local']) && list.processors.some((p) => p.id === ids['pat@t.local']));
  // A sales manager who leads a team directly is listed too, with their role; one who does not is not.
  const smRow = list.team_leaders.find((t) => t.id === ids['sm2@t.local']);
  assert.equal(smRow?.role, 'sales_manager'); assert.equal(smRow.staff, 1);
  assert.ok(!list.team_leaders.some((t) => t.id === ids['sm1@t.local']));
  assert.equal((await vera('PUT', `/allocations/${ids['sm2@t.local']}`, { product: 'all', processor_id: ids['omar@t.local'] })).status, 200);
  assert.equal((await vera('PUT', `/allocations/${ids['sm1@t.local']}`, { product: 'all', processor_id: ids['omar@t.local'] })).status, 404);
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'all', processor_id: ids['dana@t.local'] })).status, 400);
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'mortgage', processor_id: ids['pat@t.local'] })).status, 400);
  // All products of TL Two's team go to Pat.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'all', processor_id: ids['pat@t.local'] })).status, 200);
  const tl2 = (await head('GET', '/allocations')).data.team_leaders.find((t) => t.id === ids['tl2@t.local']);
  assert.deepEqual(Object.values(tl2.products).map((a) => a.processor_name), ['Pat', 'Pat', 'Pat']);
  // Cara (TL Two's team) sources a loan: Pat sees and claims it, Omar cannot, Vera sees everything.
  const c = (await cara('POST', '/cases', loan({ customer_name: 'Routed File' }))).data.case;
  const d = (await dana('POST', '/cases', loan({ customer_name: 'Shared File', phone: '+971 50 222 4444' }))).data.case;
  await tlOk(c.id, 'tl2@t.local'); await tlOk(d.id);
  const ids_of = (r) => r.data.cases.map((x) => x.id);
  assert.ok(ids_of(await pat('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.ok(!ids_of(await omar('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.ok(ids_of(await omar('GET', '/cases?status=pending_verification')).includes(d.id));
  assert.ok(ids_of(await vera('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.equal((await omar('GET', `/cases/${c.id}`)).status, 404);
  assert.equal((await omar('POST', `/cases/${c.id}/actions`, { action: 'claim' })).status, 404);
  assert.equal((await pat('POST', `/cases/${c.id}/actions`, { action: 'claim' })).status, 200);
  // Split by product: cards to Omar, loans stay with Pat, auto loans back to the shared queue.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'credit_card', processor_id: ids['omar@t.local'] })).status, 200);
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'auto_loan', processor_id: null })).status, 200);
  const card = (await cara('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', core_product: 'credit_card', customer_name: 'Card File', phone: '+971 50 222 5555', city: 'Dubai', salary: 32000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: '2026-10-05' })).data.case;
  const auto = (await cara('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', core_product: 'auto_loan', customer_name: 'Auto File', phone: '+971 50 222 6666', city: 'Dubai', salary: 20000, source: 'Walk-in', product: 'auto_loan', auto_loan_type: 'new', amount: 90000, car_make: 'Toyota', car_model: 'Camry', car_year: 2026, al_lead_source: 'Dealer referral', al_interest_rate: 3.25, al_tenure: 60, sourcing_date: '2026-10-05' })).data.case;
  assert.equal((await omar('GET', `/cases/${card.id}`)).status, 200);
  assert.equal((await pat('GET', `/cases/${card.id}`)).status, 404);
  assert.equal((await pat('GET', `/cases/${c.id}`)).status, 200);
  assert.equal((await omar('GET', `/cases/${c.id}`)).status, 404);
  assert.equal((await omar('GET', `/cases/${auto.id}`)).status, 200);
  assert.equal((await pat('GET', `/cases/${auto.id}`)).status, 200);
  // Clearing everything puts the team leader's files back in the shared queue.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'all', processor_id: null })).status, 200);
  assert.equal((await omar('GET', `/cases/${c.id}`)).status, 200);
  // The built-in role cannot be edited or deleted.
  assert.equal((await head('DELETE', '/roles/processing_lead')).status, 400);
});

test('the allocation list can be narrowed to one region: its team leaders, and its processors plus those with no region', async () => {
  const lead = await login('vlead@t.local');
  const all = (await lead('GET', '/allocations')).data;
  assert.deepEqual([all.region, all.team_leaders.length, all.processors.length], [null, 4, 4]);
  const dxb = (await lead('GET', '/allocations?region=DXB')).data;
  assert.equal(dxb.region, 'DXB');
  assert.deepEqual(dxb.team_leaders.map((t) => t.name).sort(), ['SM Direct', 'TL Dubai', 'TL Two']);
  assert.deepEqual(dxb.processors.map((p) => p.name).sort(), ['Omar', 'Pat', 'Vera']);
  const auh = (await lead('GET', '/allocations?region=auh')).data;
  assert.deepEqual([auh.team_leaders.map((t) => t.name), auh.processors.map((p) => p.name)], [['TL Abu Dhabi'], ['Aziz']]);
  assert.equal((await lead('GET', '/allocations?region=XYZ')).status, 400);
});

test('the Daily MIS dashboard: headcount, submissions, ends by category, disbursals in millions, productivity and yield by region', async () => {
  const mis = await login('mis@t.local');
  const dana = await login('dana@t.local');
  const cara = await login('cara@t.local');
  const head = await login('head@t.local');
  // A completed Premium card, a completed loan with its rate, a completed auto loan; one card still open.
  const card = (await cara('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', customer_name: 'MIS Card', phone: '+971 50 333 1111', city: 'Dubai', salary: 32000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: '2026-10-02' })).data.case;
  const open = (await cara('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', customer_name: 'MIS Card Open', phone: '+971 50 333 1112', city: 'Dubai', salary: 32000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: '2026-10-03' })).data.case;
  const pl = (await dana('POST', '/cases', loan({ customer_name: 'MIS Loan', phone: '+971 50 333 2222', loan_amount: 2600000, interest_rate: 8 }))).data.case;
  const al = (await cara('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', customer_name: 'MIS Auto', phone: '+971 50 333 3333', city: 'Dubai', salary: 20000, source: 'Walk-in', product: 'auto_loan', auto_loan_type: 'new', amount: 550000, car_make: 'Toyota', car_model: 'Camry', car_year: 2025, dealer_details: 'Al Futtaim', al_lead_source: 'Walk-in', al_interest_rate: 3.5, al_tenure: 48 })).data.case;
  assert.ok(card.id && open.id && pl.id && al.id);
  for (const c of [card, pl, al]) assert.equal((await head('POST', `/cases/${c.id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200, c.customer_name);
  const rep = (await mis('GET', '/reports/daily_mis?cycle=2026-10')).data;
  assert.equal(rep.dashboard, true);
  assert.equal(rep.as_of, '2026-10-20');
  const cc = rep.tables.find((t) => t.key === 'cc');
  const dxb = cc.rows.find((r) => r.region === 'DXB');
  assert.equal(dxb.hc, 2); // Nour and Cara are core card staff in DXB
  assert.ok(dxb.submissions >= 2);
  assert.equal(dxb.premium, 1); assert.equal(dxb.total_end, 1); assert.equal(dxb.prod, 0.5);
  assert.equal(cc.total.total_end, 1);
  const plT = rep.tables.find((t) => t.key === 'pl');
  const plDxb = plT.rows.find((r) => r.region === 'DXB');
  assert.deepEqual([plDxb.hc, plDxb.disb_m, plDxb.prod, plDxb.yield_pct], [2, 2.6, 1.3, 8]); // Dana and one more core loan seller in DXB
  const alT = rep.tables.find((t) => t.key === 'al');
  assert.equal(alT.rows.find((r) => r.region === 'DXB').disb_m, 0.6);
  assert.equal(alT.total.disb_m, 0.6);
  // The spreadsheet download stacks the three tables, one column naming the table.
  assert.deepEqual(rep.columns.slice(0, 2).map((c) => c.key), ['table', 'region']);
  assert.ok(rep.rows.some((r) => r.table === 'PL report' && r.region === 'Total'));
  const csv = await fetch(`${base}/api/reports/daily_mis?cycle=2026-10&format=csv`, { headers: { cookie: (await loginCookie('mis@t.local')) } });
  assert.equal(csv.status, 200);
});

test('MIS downloads every file ever sourced with the All files report; it needs no period and others do not get it', async () => {
  const mis = await login('mis@t.local');
  const dana = await login('dana@t.local');
  const vera = await login('vlead@t.local');
  assert.ok((await mis('GET', '/reports')).data.reports.some((r) => r.key === 'all_files'));
  assert.ok(!(await vera('GET', '/reports')).data.reports.some((r) => r.key === 'all_files'));
  assert.equal((await vera('GET', '/reports/all_files')).status, 404);
  const oldR = await dana('POST', '/cases', loan({ customer_name: 'Old File', phone: '+971 50 222 8888', sourcing_date: '2024-01-15', fpd: '2024-03-01' }));
  assert.equal(oldR.status, 201, JSON.stringify(oldR.data));
  const old = oldR.data.case;
  const rep = (await mis('GET', '/reports/all_files')).data;
  assert.ok(rep.rows.some((r) => r.ref === `CRM-${String(old.id).padStart(6, '0')}` && r.customer === 'Old File'), 'a file sourced long before the current cycle is in it');
  assert.ok(rep.columns.some((c) => c.key === 'bank_status') && rep.columns.some((c) => c.key === 'case_status'));
  assert.equal(rep.truncated, false);
  assert.match(rep.totals.ref, /files$/);
  // The dated register is still limited to its period
  const reg = (await mis('GET', '/reports/register?from=2026-10-01&to=2026-10-31')).data;
  assert.ok(!reg.rows.some((r) => r.customer === 'Old File'));
});

test('the verification team leader runs the Files in process report: every open file, who it waits on, calls and TAT', async () => {
  const vera = await login('vlead@t.local');
  const pat = await login('pat@t.local');
  const dana = await login('dana@t.local');
  const list = (await vera('GET', '/reports')).data.reports.map((r) => r.key);
  assert.deepEqual(list, ['open_files']);
  assert.equal((await pat('GET', '/reports/open_files')).status, 404);
  const c = (await dana('POST', '/cases', loan({ customer_name: 'Open Report File', phone: '+971 50 222 7777' }))).data.case;
  await tlOk(c.id);
  await pat('POST', `/cases/${c.id}/actions`, { action: 'log_call', outcome: 'no_answer' });
  const rep = (await vera('GET', '/reports/open_files')).data;
  assert.equal(rep.status ?? 200, 200);
  const row = rep.rows.find((r) => r.customer === 'Open Report File');
  assert.ok(row, JSON.stringify(rep.rows.slice(0, 2)));
  assert.equal(row.verification, 'In verification');
  assert.equal(row.waiting_on, 'Processor: Pat');
  assert.equal(row.calls, 1); assert.equal(row.last_call, 'No answer');
  assert.ok(Number.isInteger(row.days_open) && row.days_open >= 0); // the suite pins the sourcing clock, so the exact count varies
  assert.ok(rep.columns.some((k) => k.key === 'tat') && rep.columns.some((k) => k.key === 'waiting_on'));
  // A completed file leaves the report.
  const head = await login('head@t.local');
  await pat('POST', `/cases/${c.id}/actions`, { action: 'complete', note: 'ok' });
  await head('POST', `/cases/${c.id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: 100000 });
  assert.ok(!(await vera('GET', '/reports/open_files')).data.rows.some((r) => r.customer === 'Open Report File'));
  // The download leaves the phone out.
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: loginId('vlead@t.local'), password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const csv = await fetch(`${base}/api/reports/open_files?format=csv`, { headers: { cookie } });
  assert.equal(csv.status, 200); assert.ok(!/Phone/.test((await csv.text()).split('\n')[0]));
});

test('the verification team leader moves a file to another processor with a reason, and the queue shows where a waiting file sits', async () => {
  const cara = await login('cara@t.local');
  const pat = await login('pat@t.local');
  const omar = await login('omar@t.local');
  const vera = await login('vlead@t.local');
  const sales = cara;
  // TL Two's loans go to Pat: a waiting file says so before anyone picks it up.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'personal_loan', processor_id: ids['pat@t.local'] })).status, 200);
  const f = (await cara('POST', '/cases', loan({ customer_name: 'Moved File', phone: '+971 50 222 7777' }))).data.case;
  await tlOk(f.id, 'tl2@t.local');
  let seen = (await vera('GET', '/cases?status=pending_verification')).data.cases.find((x) => x.id === f.id);
  assert.equal(seen.allocated_to, 'Pat');
  assert.equal((await vera('GET', `/cases/${f.id}`)).data.case.allocated_to, 'Pat');
  assert.equal((await sales('GET', `/cases/${f.id}`)).data.case.allocated_to, undefined); // sales staff are not shown the queue
  // A shared-queue file says any processor.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'personal_loan', processor_id: null })).status, 200);
  seen = (await vera('GET', '/cases?status=pending_verification')).data.cases.find((x) => x.id === f.id);
  assert.equal(seen.allocated_to, null);
  assert.deepEqual(seen.allocated_to_ids, []);
  // Pat picks it up and goes on a break; only Vera can move it, and a reason is required.
  assert.equal((await pat('POST', `/cases/${f.id}/actions`, { action: 'claim' })).status, 200);
  const detail = (await vera('GET', `/cases/${f.id}`)).data.case;
  assert.ok(detail.allowed_actions.includes('reassign'));
  // Vera is in DXB: Omar (DXB) is offered, Pat (who has the file) and Aziz (AUH) are not, and AUH is refused outright.
  assert.ok(detail.processors.some((p) => p.id === ids['omar@t.local']) && !detail.processors.some((p) => p.id === ids['pat@t.local']));
  assert.ok(!detail.processors.some((p) => p.id === ids['aziz@t.local']));
  assert.match((await vera('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['aziz@t.local'], note: 'Urgent' })).data.error, /your region/);
  assert.ok(!(await omar('GET', `/cases/${f.id}`)).data.case.allowed_actions.includes('reassign'));
  assert.equal((await omar('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['omar@t.local'], note: 'Taking it' })).status, 403);
  assert.equal((await vera('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['omar@t.local'] })).status, 400);
  assert.equal((await vera('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['cara@t.local'], note: 'Urgent' })).status, 400);
  const moved = await vera('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['omar@t.local'], note: 'Urgent file, Pat is on a break' });
  assert.equal(moved.status, 200, JSON.stringify(moved.data));
  assert.deepEqual([moved.data.case.status, moved.data.case.assigned_to], ['in_verification', ids['omar@t.local']]);
  assert.ok(moved.data.case.events.some((e) => e.type === 'reassign' && e.detail === 'Pat → Omar' && /on a break/.test(e.note)));
  // The file is in Omar's queue even though it was allocated to Pat's team leader, and Pat no longer sees it there.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'personal_loan', processor_id: ids['pat@t.local'] })).status, 200);
  assert.ok((await omar('GET', '/cases?status=in_verification')).data.cases.some((x) => x.id === f.id));
  assert.ok((await omar('GET', '/cases?status=pending_verification,in_verification&assigned=me')).status === 200);
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { product: 'personal_loan', processor_id: null })).status, 200);
  // Omar works it now, Pat no longer can; both were told.
  assert.ok((await omar('GET', `/cases/${f.id}`)).data.case.allowed_actions.includes('complete'));
  assert.ok(!(await pat('GET', `/cases/${f.id}`)).data.case.allowed_actions.includes('complete'));
  assert.ok((await omar('GET', '/notifications')).data.items.some((n) => /moved to you by Vera from Pat/.test(n.message) && n.case_id === f.id));
  assert.ok((await pat('GET', '/notifications')).data.items.some((n) => /was moved to Omar by Vera/.test(n.message) && n.case_id === f.id));
  assert.equal((await vera('POST', `/cases/${f.id}/actions`, { action: 'reassign', processor_id: ids['omar@t.local'], note: 'Again' })).status, 409);
  // A waiting file can be handed straight to a processor too.
  const g = (await cara('POST', '/cases', loan({ customer_name: 'Waiting File', phone: '+971 50 222 8888' }))).data.case;
  await tlOk(g.id, 'tl2@t.local');
  const handed = await vera('POST', `/cases/${g.id}/actions`, { action: 'reassign', processor_id: ids['pat@t.local'], note: 'Customer is waiting on the line' });
  assert.equal(handed.status, 200, JSON.stringify(handed.data));
  assert.deepEqual([handed.data.case.status, handed.data.case.assigned_to_name], ['in_verification', 'Pat']);
  assert.ok(handed.data.case.events.some((e) => e.type === 'reassign' && e.detail === 'queue → Pat'));
});
