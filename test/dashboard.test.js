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
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
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

test('the business head dashboard shows core team vs cross-sell contribution per product, and the loan reports list each loan', async () => {
  const head = await login('head@t.local');
  const tl2 = await login('tl2@t.local');
  const cycle = (await head('GET', '/me')).data.meta.current_cycle;
  const d = (await head('GET', '/dashboard')).data;
  const pl = d.contribution.find((x) => x.product === 'personal_loan');
  // Lina (core loans) and Rina (multi product) are core; Cara (core cards) cross-sold her loan.
  assert.ok(pl.core.files >= 3 && pl.cross.files >= 1, JSON.stringify(pl));
  assert.equal(pl.core.amount + pl.cross.amount, pl.total.amount);
  assert.equal(Math.round(pl.core.pct + pl.cross.pct), 100);
  const cc = d.contribution.find((x) => x.product === 'credit_card');
  assert.equal(cc.unit, 'points');
  // The card breakdown counts Mass, Premium and Super Premium on each side.
  assert.deepEqual(Object.keys(cc.core.cards), ['Mass', 'Premium', 'Super Premium', 'noon', 'other']);
  assert.equal(Object.values(cc.core.cards).reduce((a, b) => a + b, 0) + Object.values(cc.cross.cards).reduce((a, b) => a + b, 0), cc.total.files);
  assert.equal((await tl2('GET', '/dashboard')).data.contribution, null);
  const loans = (await head('GET', `/reports/personal_loans?cycle=${cycle}`)).data;
  const cara = loans.rows.find((r) => r.staff === 'Cara');
  assert.deepEqual([cara.sold_as, cara.loan_type, cara.disbursed, cara.counted], ['Cross-sell', 'Fresh', 120000, 120000]);
  assert.equal(loans.totals.disbursed, loans.rows.reduce((n, r) => n + r.disbursed, 0));
  // A team leader's report covers their own team only.
  assert.ok((await tl2('GET', `/reports/personal_loans?cycle=${cycle}`)).data.rows.every((r) => r.team_leader === 'TL Two'));
  const autos = (await head('GET', `/reports/auto_loans?cycle=${cycle}`)).data;
  assert.deepEqual(autos.columns.map((c) => c.key).slice(-3), ['rate_pct', 'points', 'completed_on']);
});

test('sales staff see what their open files could earn and how much more they need to start earning', async () => {
  const lina = await login('lina@t.local');
  const mis = await login('mis@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: ids['lina@t.local'], personal_loan: 900000 }] })).status, 200);
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  // Two loans still in the system: fresh 400,000 and a top-up adding 200,000 (counted at its share).
  const base = { region: 'DXB', core_product: 'personal_loan', phone: '+971 50 999 0001', city: 'Dubai', salary: 15000, source: 'Walk-in', product: 'personal_loan', interest_rate: 6, pl_tenure: 48, fpd, sourcing_date: '2026-10-05' };
  assert.equal((await lina('POST', '/cases', { ...base, customer_name: 'Open One', personal_loan_type: 'fresh', loan_amount: 400000 })).status, 201);
  assert.equal((await lina('POST', '/cases', { ...base, customer_name: 'Open Two', phone: '+971 50 999 0002', personal_loan_type: 'top_up', loan_amount: 200000, full_loan_amount: 500000, incremental_amount: 200000 })).status, 201);
  const i = (await lina('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  const p = i.potential;
  // Completed so far: Lina's two loans from earlier tests (80,000 + 50,000 = 130,000), below the first band.
  assert.equal(i.pl_counted, 130000);
  assert.equal(p.open_files, 2);
  assert.equal(p.pl_counted, 130000 + 400000 + 200000 * i.topup_share / 100);
  assert.equal(p.needed_now, 600000 - 130000);
  assert.equal(p.needed_after, Math.max(0, 600000 - p.pl_counted));
  assert.equal(p.incentive_aed, Math.round(p.pl_counted * p.rate_pct) / 100);
  const d = (await lina('GET', '/dashboard')).data.incentive;
  assert.deepEqual([d.open_files, d.potential], [2, p.incentive_aed]);
});

test('the submission calendar: green days for a sales person, team-share colours for a team leader', async () => {
  const lina = await login('lina@t.local');
  const cara = await login('cara@t.local');
  const tl2 = await login('tl2@t.local');
  const mis = await login('mis@t.local');
  const cal = (await lina('GET', '/dashboard')).data.calendar;
  assert.ok(cal.days.length >= 28 && cal.start <= cal.today && cal.today <= cal.end);
  // Lina sourced files on 2026-10-05 in earlier tests: a green day; a weekday with nothing is red; weekends off; future blank.
  const oct5 = cal.days.find((d) => d.date === '2026-10-05');
  assert.deepEqual([oct5.status, oct5.files > 0], ['green', true]);
  assert.ok(cal.days.filter((d) => d.date > cal.today).every((d) => d.status === 'future'));
  // Sunday is the day off; Saturday is a working day and goes red like any other.
  assert.ok(cal.days.filter((d) => d.date <= cal.today && !d.files && d.dow === 0).every((d) => d.status === 'off'));
  assert.ok(cal.days.filter((d) => d.date <= cal.today && !d.files && d.dow !== 0).every((d) => d.status === 'red'));
  assert.ok(cal.days.some((d) => d.dow === 6 && d.date <= cal.today && d.status === 'red'));
  // The team leader: TL Two has Cara, Lina and Rina; on 2026-10-05 Lina and Rina sourced → 2 of 3 = 66.7% → orange.
  const tcal = (await tl2('GET', '/dashboard')).data.calendar;
  const t5 = tcal.days.find((d) => d.date === '2026-10-05');
  assert.deepEqual([t5.team, t5.staff, t5.pct, t5.status], [3, 2, 66.7, 'orange']);
  // Cara submits too: 3 of 3 → green.
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  assert.equal((await cara('POST', '/cases', { region: 'DXB', core_product: 'personal_loan', customer_name: 'Cal Day', phone: '+971 50 123 4321', city: 'Dubai', salary: 15000, source: 'Walk-in', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 60000, interest_rate: 6, pl_tenure: 48, fpd, sourcing_date: '2026-10-05' })).status, 201);
  assert.equal((await tl2('GET', '/dashboard')).data.calendar.days.find((d) => d.date === '2026-10-05').status, 'green');
  // MIS has no calendar.
  assert.equal((await mis('GET', '/dashboard')).data.calendar, null);
});

test('leaders see how many of their staff are on zero ends or disbursals and zero submissions, with names', async () => {
  const tl = await login('tl@t.local');
  const tl2 = await login('tl2@t.local');
  const head = await login('head@t.local');
  const cara = await login('cara@t.local');
  // TL Two's team: Cara, Lina and Rina all sourced and completed files in earlier tests.
  const z2 = (await tl2('GET', '/dashboard')).data.zero;
  assert.equal(z2.team, 3);
  assert.deepEqual([z2.zero_ends.count, z2.zero_submissions.count], [0, 0]);
  // TL Dubai's team: Dana has not sourced anything, so she is on zero for both.
  const z1 = (await tl('GET', '/dashboard')).data.zero;
  assert.deepEqual([z1.team, z1.zero_ends.count, z1.zero_ends.pct, z1.zero_ends.staff.map((s) => s.name), z1.zero_submissions.count], [1, 1, 100, ['Dana'], 1]);
  // The business head sees everyone; sales staff get nothing.
  const zh = (await head('GET', '/dashboard')).data.zero;
  assert.equal(zh.team, 4);
  assert.equal(zh.zero_ends.pct, 25);
  assert.equal((await cara('GET', '/dashboard')).data.zero, null);
});
