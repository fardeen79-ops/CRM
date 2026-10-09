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

test('profit and loss for the business head: revenue less salaries paid and incentives, estimates flagged', async () => {
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
  let p = (await head('GET', `/pnl?cycle=${cycle}`)).data.pnl;
  // Nothing uploaded: Dana and Pat are estimated from their profile salaries.
  assert.deepEqual([p.revenue.total, p.revenue.by_product.auto_loan, p.salaries, p.salaries_estimated, p.without_upload, p.uploaded_people], [875, 875, 0, 5000, 7, 0]);
  assert.equal(p.rows.find((l) => l.role === 'sales').salary_estimated, 5000);
  // Salaries paid uploaded for the cycle, with an actual incentive for Dana.
  const csv = `HRMS code,Cycle,Salary paid (AED),Incentive paid (AED),Notes\nEN1,${cycle},4800,300,Joined mid-cycle\nEN3,${cycle},20000,,\nEN2,${cycle},7000,,\nZZ9,${cycle},1,,`;
  const up = (await head('POST', '/import/payroll', { csv })).data;
  assert.deepEqual([up.ok, up.failed], [3, 1]);
  assert.equal((await mis('POST', '/import/payroll', { csv: `HRMS code,Cycle,Salary paid (AED)\nEN2,${cycle},7100`, dry_run: true })).status, 200);
  p = (await head('GET', `/pnl?cycle=${cycle}`)).data;
  assert.deepEqual([p.pnl.salaries, p.pnl.salaries_estimated, p.pnl.without_upload, p.pnl.incentives, p.pnl.costs, p.pnl.net, p.pnl.uploaded_people], [31800, 0, 4, 300, 32100, -31225, 3]);
  const sales = p.pnl.rows.find((l) => l.role === 'sales');
  assert.deepEqual([sales.staff, sales.salary_paid, sales.incentive_paid, sales.incentive_override, sales.cost], [1, 4800, 300, 1, 5100]);
  assert.equal(p.payroll.find((x) => x.hrms_code === 'EN1').notes, 'Joined mid-cycle');
  // The report carries the same lines.
  const rep = (await head('GET', `/reports/pnl?cycle=${cycle}`)).data;
  assert.equal(rep.rows.find((r) => r.line === 'Net').amount, -31225);
  assert.equal(rep.rows.find((r) => r.line === 'Revenue').amount, 875);
  assert.match(rep.note, /3 people have a salary uploaded/);
  assert.equal((await head('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.pnl.revenue.total, 0);
});
