// The credit card bonus: AED 1,000 added to a sales person's incentive once the cycle's points reach
// the bonus level of their salary band, loaded with the salary bands.
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
  add('Sally', 'sally@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
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

test('the bonus level comes with the salary band and pays AED 1,000 once the points reach it', async () => {
  const mis = await login('mis@t.local'); const sally = await login('sally@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const card = async () => {
    const r = await sally('POST', '/cases', { region: 'DXB', phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Card Customer', core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', fpd });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await mis('POST', `/cases/${r.data.case.id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200);
  };
  // One card first, to learn its points; the bands are then set relative to that: target at 1.5 cards, bonus at 2.5.
  await card();
  const p = (await sally('GET', `/incentives/me?cycle=${cycle}`)).data.incentive.card_points;
  assert.ok(p > 0, 'a card earns points');
  const target = Math.round(p * 1.5); const bonus = Math.round(p * 2.5);
  // Bands with the bonus column: the bonus must sit above the target and only on credit card bands.
  const bad = (await mis('POST', '/import/target_rules', { csv: `Product,Salary from (AED),Salary to (AED),Target,Bonus at (points)\nCredit Card,4000,5999,${target},${target - 1}\nPersonal Loan,0,9999,600000,700000\n` })).data;
  assert.deepEqual(bad.rows.map((r) => r.ok), [false, false]);
  assert.match(bad.rows[0].error, /above the target/); assert.match(bad.rows[1].error, /credit card bands only/);
  const ok = (await mis('POST', '/import/target_rules', { csv: `Product,Salary from (AED),Salary to (AED),Target,Bonus at (points)\nCredit Card,4000,5999,${target},${bonus}\nCredit Card,6000,9999,${target * 2},\n` })).data;
  assert.deepEqual(ok.rows.map((r) => r.ok), [true, true]);
  assert.equal((await mis('POST', '/targets/generate', { cycle })).status, 200);
  // Two cards: over the target, short of the bonus level.
  await card();
  const r2 = (n) => Math.round(n * 100) / 100;
  let mine = (await sally('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.total_points, mine.target, mine.excess_points, mine.bonus_points, mine.bonus_met, mine.bonus_aed], [2 * p, target, r2(2 * p - target), bonus, false, 0]);
  assert.equal(mine.incentive_aed, mine.points_aed);
  assert.deepEqual([mine.potential.bonus_points, mine.potential.bonus_needed_now, mine.potential.bonus_met_after], [bonus, r2(bonus - 2 * p), false]);
  // A third card: past the bonus level, so AED 1,000 is added to the points incentive.
  await card();
  mine = (await sally('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.total_points, mine.bonus_met, mine.bonus_aed, mine.incentive_aed], [3 * p, true, 1000, r2(mine.points_aed + 1000)]);
  assert.equal(mine.points_aed, r2((3 * p - target) * mine.rate));
  // The incentives report carries the bonus.
  const rep = (await mis('GET', `/reports/incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.staff === 'Sally');
  assert.deepEqual([row.bonus_points, row.bonus_aed, row.incentive_aed], [bonus, 1000, mine.incentive_aed]);
  assert.ok(rep.columns.some((c) => c.key === 'bonus_aed'));
});
