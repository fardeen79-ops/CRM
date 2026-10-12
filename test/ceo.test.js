// The CEO dashboard: the business head's one-screen view of a cycle, built from the P&L, targets,
// yield, down-sell loss, pipeline, staff on zero and the regions. Nobody else can open it.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';

const PASSWORD = 'password123';
let server, base, ids;

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('TL Abu Dhabi', 'tl2@t.local', 'team_leader', { region: 'AUH' });
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Aziz', 'aziz@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm@t.local'], salary: 6000 });
  add('Zed', 'zed@t.local', 'sales', { region: 'AUH', sales_code: 'A-2', core_product: 'credit_card', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm@t.local'], salary: 4000 });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Yusuf', 'ceo@t.local', 'ceo', { region: 'DXB', hrms_code: 'EN4' });
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

test('the business head gets the headline numbers; the regions sit side by side; nobody else can open it', async () => {
  const dana = await login('dana@t.local'); const aziz = await login('aziz@t.local');
  const mis = await login('mis@t.local'); const head = await login('head@t.local');
  const cycle = (await head('GET', '/me')).data.meta.current_cycle;
  assert.equal((await mis('GET', `/ceo?cycle=${cycle}`)).status, 403);
  assert.equal((await dana('GET', `/ceo?cycle=${cycle}`)).status, 403);
  const empty = (await head('GET', `/ceo?cycle=${cycle}`)).data;
  assert.equal(empty.money.revenue.now, 0);
  assert.equal(empty.pipeline.sourced.now, 0);
  assert.equal(empty.zero.zero_ends.pct, 100, 'nobody has completed anything yet');
  assert.equal(empty.yield.yield_pct, null);

  // Dana disburses a 100,000 loan at 9% in Dubai; Aziz a 200,000 loan at 8% in Abu Dhabi.
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const file = async (who, region, over) => {
    const r = await who('POST', '/cases', { region, phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Loan Customer', core_product: 'personal_loan', product: 'personal_loan', personal_loan_type: 'fresh', pl_tenure: 48, fpd, ...over });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.case.id;
  };
  const a = await file(dana, 'DXB', { loan_amount: 100000, interest_rate: 9 });
  const b = await file(aziz, 'AUH', { loan_amount: 200000, interest_rate: 8 });
  await file(aziz, 'AUH', { loan_amount: 50000, interest_rate: 7 }); // still open
  for (const [id, amount] of [[a, 100000], [b, 200000]]) assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: amount })).status, 200);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: ids['dana@t.local'], personal_loan: 200000 }, { user_id: ids['aziz@t.local'], personal_loan: 200000 }] })).status, 200);

  const d = (await head('GET', `/ceo?cycle=${cycle}`)).data;
  assert.equal(d.cycle, cycle);
  assert.ok(d.money.revenue.now > 0, 'the bank pays on the two completed loans');
  assert.equal(d.money.files.now, 2);
  assert.equal(d.money.revenue.before, 0);
  assert.equal(d.pipeline.sourced.now, 3); assert.equal(d.pipeline.completed, 2); assert.equal(d.pipeline.open, 1);
  assert.equal(d.pipeline.conversion_pct, 66.7);
  assert.equal(d.yield.yield_pct, 8.33); assert.equal(d.yield.below_min, true);
  assert.equal(d.zero.zero_ends.count, 1, 'Zed has no completed file');
  assert.equal(d.zero.zero_ends.pct, 33.3);
  assert.equal(d.trend.length, 6); assert.equal(d.trend.at(-1).completed, 2);
  assert.deepEqual(d.people, { sales: 3, leaders: 3, processing: 0, other: 3 });
  const pl = d.production.find((p) => p.product === 'personal_loan');
  assert.deepEqual([pl.target, pl.achieved, pl.pct, pl.files], [400000, 300000, 75, 2]);
  assert.deepEqual(d.regions.map((x) => [x.region, x.files, x.yield_pct, x.staff, x.zero_ends_pct]), [['DXB', 1, 9, 1, 0], ['AUH', 1, 8, 2, 50]]);
  assert.equal(d.loss.payout_lost, 0);
  // One region only: no side-by-side table, and the numbers are that region's.
  const auh = (await head('GET', `/ceo?cycle=${cycle}&region=AUH`)).data;
  assert.deepEqual(auh.regions, []);
  assert.equal(auh.money.files.now, 1); assert.equal(auh.yield.yield_pct, 8); assert.equal(auh.pipeline.open, 1);
  assert.equal((await head('GET', '/ceo?cycle=bad')).status, 400);
});

test('the CEO profile is a business head role that carries the dashboard and no uploads', async () => {
  const ceo = await login('ceo@t.local');
  const me = (await ceo('GET', '/me')).data;
  assert.equal(me.user.role, 'business_head'); assert.equal(me.user.role_key, 'ceo');
  assert.equal(me.meta.perms.label, 'CEO');
  assert.deepEqual(me.meta.perms.pages, ['ceo', 'pnl', 'reports']);
  assert.deepEqual(me.meta.perms.uploads, []);
  const cycle = me.meta.current_cycle;
  const d = (await ceo('GET', `/ceo?cycle=${cycle}`)).data;
  assert.equal(d.cycle, cycle);
  assert.equal((await ceo('GET', `/pnl?cycle=${cycle}`)).status, 200);
  assert.equal((await ceo('GET', `/reports/pnl?cycle=${cycle}`)).status, 200);
  assert.equal((await ceo('GET', '/cases')).status, 403, 'no files, targets or staff for the CEO profile');
  assert.equal((await ceo('GET', `/targets?cycle=${cycle}`)).status, 403);
  // No power button: the CEO reads the business and never holds files as verified.
  assert.equal(me.meta.can_use_tat_switch, false);
  assert.equal((await ceo('PUT', '/tat-switch', { on: true })).status, 403);
});
