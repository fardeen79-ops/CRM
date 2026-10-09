// Dashboard tiles for team leaders and above: what each core team cross-sold this cycle.
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
  add('TL Two', 'tl2@t.local', 'team_leader', { region: 'DXB' });
  add('Cara', 'cara@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'credit_card', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Lina', 'lina@t.local', 'sales', { region: 'DXB', sales_code: 'D-3', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Rina', 'rina@t.local', 'sales', { region: 'DXB', sales_code: 'D-4', core_product: 'multi_product', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
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

test('team leaders and above see what each core team cross-sold this cycle', async () => {
  const cara = await login('cara@t.local');
  const lina = await login('lina@t.local');
  const mis = await login('mis@t.local');
  const tl2 = await login('tl2@t.local');
  const tl = await login('tl@t.local');
  const head = await login('head@t.local');
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const base = { region: 'DXB', phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in' };
  // Core card staff Cara sells a card with a personal loan; core loan staff Lina sells a loan with a card, and a loan alone.
  const a = (await cara('POST', '/cases', { ...base, customer_name: 'Card Plus Loan', core_product: 'credit_card', product: 'bundle', bundle_products: ['credit_card', 'personal_loan'], credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', personal_loan_type: 'fresh', loan_amount: 120000, interest_rate: 6, pl_tenure: 48, fpd })).data.case;
  const b = (await lina('POST', '/cases', { ...base, customer_name: 'Loan Plus Card', core_product: 'personal_loan', product: 'bundle', bundle_products: ['personal_loan', 'credit_card'], credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', personal_loan_type: 'fresh', loan_amount: 80000, interest_rate: 6, pl_tenure: 48, fpd })).data.case;
  const c = (await lina('POST', '/cases', { ...base, customer_name: 'Loan Only', core_product: 'personal_loan', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 50000, interest_rate: 6, pl_tenure: 48, fpd })).data.case;
  assert.ok(a && b && c, 'cases created');
  for (const [id, amount] of [[a.id, 120000], [b.id, 80000], [c.id, 50000]]) assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: amount })).status, 200);
  const cross = (await tl2('GET', '/dashboard')).data.cross_sell;
  assert.deepEqual(cross.find((t) => t.core === 'credit_card').products, [{ product: 'personal_loan', label: 'Personal Loans', files: 1, amount: 120000 }]);
  assert.deepEqual(cross.find((t) => t.core === 'personal_loan').products, [{ product: 'credit_card', label: 'Credit Cards', files: 1, amount: 0 }]);
  // The other team leader's scope has none of these files; the business head sees everything; sales staff get no tiles.
  assert.deepEqual((await tl('GET', '/dashboard')).data.cross_sell, []);
  assert.equal((await head('GET', '/dashboard')).data.cross_sell.find((t) => t.core === 'credit_card').products[0].amount, 120000);
  assert.equal((await cara('GET', '/dashboard')).data.cross_sell, null);
});

test('multi product staff are paid under each product scheme they hold a target for, with nothing counted twice', async () => {
  const rina = await login('rina@t.local');
  const mis = await login('mis@t.local');
  const head = await login('head@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  // No targets yet: nothing applies.
  let mine = (await rina('GET', `/incentives/me?cycle=${cycle}`)).data;
  assert.deepEqual([mine.type, mine.incentive, mine.products], ['multi_product', null, []]);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: ids['rina@t.local'], credit_card: 2, personal_loan: 100000 }] })).status, 200);
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const base = { region: 'DXB', phone: '+971 50 444 5555', city: 'Dubai', salary: 32000, source: 'Walk-in', sourcing_date: '2026-10-05' };
  const a = (await rina('POST', '/cases', { ...base, customer_name: 'Card And Loan', core_product: 'multi_product', product: 'bundle', bundle_products: ['credit_card', 'personal_loan'], credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', personal_loan_type: 'fresh', loan_amount: 700000, interest_rate: 6, pl_tenure: 48, fpd })).data.case;
  assert.ok(a, 'case created');
  assert.equal((await mis('POST', `/cases/${a.id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: 700000 })).status, 200);
  mine = (await rina('GET', `/incentives/me?cycle=${cycle}`)).data;
  assert.deepEqual(mine.products.map((p) => p.type), ['credit_card', 'personal_loan']);
  const cc = mine.products[0].incentive; const pl = mine.products[1].incentive;
  // The loan adds no points to the card scheme; the card pays nothing in the loan scheme; the loan itself pays its band.
  assert.deepEqual([cc.pl_excluded, cc.pl_points, cc.pl_counted], [true, 0, 700000]);
  assert.deepEqual([pl.cards_excluded, pl.cards_sold, pl.cards_incentive_aed, pl.pl_counted, pl.rate_pct], [true, 1, 0, 700000, 0.4]);
  assert.equal(pl.incentive_aed, 2800);
  const d = (await rina('GET', '/dashboard')).data.incentive;
  assert.deepEqual(d.parts.map((p) => p.type), ['credit_card', 'personal_loan']);
  assert.equal(d.total, Math.round((cc.incentive_aed + pl.incentive_aed) * 100) / 100);
  // She appears in both product reports, with the same figures.
  assert.equal((await head('GET', `/reports/pl_incentives?cycle=${cycle}`)).data.rows.find((r) => r.staff === 'Rina').incentive_aed, 2800);
  assert.equal((await head('GET', `/reports/incentives?cycle=${cycle}`)).data.rows.find((r) => r.staff === 'Rina').pl_points, 0);
});
