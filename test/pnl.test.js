// Profit and loss: revenue on completed files less salaries paid (uploaded) and incentives, by role.
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
  add('SM One', 'sm1@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'], salary: 5000, hrms_code: 'EN1' });
  add('Pat', 'proc@t.local', 'processing', { region: 'DXB', salary: 4000 });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
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

test('profit and loss for the business head: revenue less profile salaries and incentives', async () => {
  const dana = await login('dana@t.local');
  const mis = await login('mis@t.local');
  const head = await login('head@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  // One used-car auto loan of 50,000 completed: the bank pays 1.75% = AED 875.
  const c = (await dana('POST', '/cases', { customer_name: 'PL Customer', region: 'DXB', phone: '+971 50 111 2222', city: 'Dubai', product: 'auto_loan', amount: 50000, core_product: 'auto_loan', auto_loan_type: 'used', car_make: 'Nissan', car_model: 'Patrol', car_year: 2023, al_lead_source: 'Walk-in', al_interest_rate: 3.5, al_tenure: 48, salary: 9000, source: 'Walk-in' })).data.case;
  assert.ok(c, 'case created');
  assert.equal((await mis('POST', `/cases/${c.id}/actions`, { action: 'set_case_status', case_status: 'completed', al_disbursed_amount: 50000 })).status, 200);
  // Only the business head sees it.
  assert.equal((await mis('GET', `/pnl?cycle=${cycle}`)).status, 403);
  assert.equal((await gov('GET', `/reports/pnl?cycle=${cycle}`)).status, 404);
  const p = (await head('GET', `/pnl?cycle=${cycle}`)).data.pnl;
  // Salaries come from the staff profiles: Dana's 5,000 (a profile salary is kept for sales staff; Pat's was not stored).
  assert.deepEqual([p.revenue.total, p.revenue.by_product.auto_loan, p.salaries, p.people], [875, 875, 5000, 7]);
  const sales = p.rows.find((l) => l.role === 'sales');
  assert.deepEqual([sales.staff, sales.salary, sales.cost], [1, 5000, 5000 + sales.incentive]);
  assert.equal(p.costs, p.salaries + p.incentives);
  assert.equal(p.net, 875 - p.costs);
  assert.equal((await head('POST', '/import/payroll', { csv: 'x' })).status, 404, 'the salaries-paid upload is gone');
  // The report carries the same lines.
  const rep = (await head('GET', `/reports/pnl?cycle=${cycle}`)).data;
  assert.equal(rep.rows.find((r) => r.line === 'Net').amount, p.net);
  assert.equal(rep.rows.find((r) => r.line === 'Revenue').amount, 875);
  assert.match(rep.note, /staff profiles/);
  assert.equal((await head('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.pnl.revenue.total, 0);
});

test('the profit and loss follows region and hierarchy: region → sales manager → team leader → staff, overheads at region level', async () => {
  const head = await login('head@t.local');
  const mis = await login('mis@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const { tree, total } = (await head('GET', `/pnl?cycle=${cycle}`)).data.tree;
  const dxb = tree.find((n) => n.key === 'DXB');
  assert.ok(dxb, 'DXB region');
  const sm = dxb.children.find((n) => n.label === 'SM One');
  const tl = sm.children.find((n) => n.label === 'TL Dubai');
  const dana = tl.children.find((n) => n.label === 'Dana');
  // Dana's file (AED 875), her profile salary (5,000) and her scheme incentive sit on her line; her leaders carry their own salaries (none set).
  const inc = dana.incentives;
  assert.deepEqual([dana.revenue, dana.files, dana.salary, dana.net], [875, 1, 5000, 875 - 5000 - inc]);
  assert.deepEqual([tl.revenue, tl.headcount, tl.salary, tl.net], [875, 2, 5000, dana.net], 'the team leader line rolls up Dana; the leader has no salary of their own');
  assert.deepEqual([sm.revenue, sm.headcount], [875, 3]);
  const oh = dxb.children.find((n) => n.kind === 'overheads');
  // Pat, Mira, Bilal and Gina (no profile salaries) are the overheads; all follow the business's SEs, who are all in Dubai.
  assert.deepEqual([oh.headcount, oh.salary, oh.revenue], [4, 0, 0]);
  assert.deepEqual([dxb.revenue, dxb.costs, dxb.net], [875, 5000 + inc, 875 - 5000 - inc]);
  assert.deepEqual([total.net, total.headcount], [875 - 5000 - inc, 7]);
  // Gina has no region of her own, but overheads follow the SEs, so there is no "No region set" bucket.
  assert.equal(tree.find((n) => n.key === 'NONE'), undefined);
  assert.equal((await head('GET', `/pnl?cycle=${cycle}&region=DXB`)).data.tree.tree.length, 1);
  const rep = (await head('GET', `/reports/pnl_hierarchy?cycle=${cycle}`)).data;
  assert.deepEqual(rep.rows.slice(0, 4).map((r) => [r.level, r.name]), [['Region', 'DXB (Dubai)'], ['Sales manager', 'SM One'], ['Team leader', 'TL Dubai'], ['Staff', 'Dana']]);
  assert.equal(rep.totals.net, total.net);
});
