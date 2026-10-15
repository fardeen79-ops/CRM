// The bank month-end report: Dubai MIS, per cycle, split by product, full customer numbers for five days after the cycle ends.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser, loginId } from './helpers/create-user.mjs';
import { timing } from '../src/cases.js';

const PASSWORD = 'password123';
const UAE = (s) => Date.parse(`${s}+04:00`);
let db, server, base, ids;

before(async () => {
  db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('Sally', 'sally@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Aisha', 'mis-auh@t.local', 'mis', { region: 'AUH', hrms_code: 'EN4' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Hamad', 'head-auh@t.local', 'business_head', { region: 'AUH', hrms_code: 'EN5' });
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => { server.close(); timing.now = () => Date.now(); });

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: loginId(email), password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body, raw = false) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: raw ? await r.text() : await r.json().catch(() => null) };
  };
}

test('Dubai MIS pulls the bank month-end report per cycle, split by product, with full numbers for five days after the cycle ends', async () => {
  const sally = await login('sally@t.local'); const mis = await login('mis@t.local'); const auh = await login('mis-auh@t.local'); const head = await login('head@t.local');
  const file = (over) => sally('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', city: 'Dubai', salary: 15000, source: 'Walk-in', sourcing_date: '2026-09-10', ...over });
  const card = await file({ customer_name: 'Card Customer', phone: '+971 50 111 2222', alt_phone: '+971 4 222 3333', core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf' });
  assert.equal(card.status, 201, JSON.stringify(card.data));
  const loan = await file({ customer_name: 'Loan Customer', phone: '+971 50 333 4444', core_product: 'personal_loan', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 60000, interest_rate: 6, pl_tenure: 48, fpd: '2026-11-05' });
  assert.equal(loan.status, 201, JSON.stringify(loan.data));
  // Only Dubai MIS and the Dubai business head have it.
  const headAuh = await login('head-auh@t.local');
  assert.ok((await mis('GET', '/reports')).data.reports.some((r) => r.key === 'bank_month_end'));
  assert.ok((await head('GET', '/reports')).data.reports.some((r) => r.key === 'bank_month_end'));
  assert.ok(!(await auh('GET', '/reports')).data.reports.some((r) => r.key === 'bank_month_end'));
  assert.ok(!(await headAuh('GET', '/reports')).data.reports.some((r) => r.key === 'bank_month_end'));
  assert.equal((await auh('GET', '/reports/bank_month_end?cycle=2026-09')).status, 404);
  assert.equal((await headAuh('GET', '/reports/bank_month_end?cycle=2026-09')).status, 404);
  assert.equal((await sally('GET', '/reports/bank_month_end?cycle=2026-09')).status, 404);
  // Not before the cycle ends, and only per cycle.
  timing.now = () => UAE('2026-09-19T10:00:00');
  assert.match((await mis('GET', '/reports/bank_month_end?cycle=2026-09')).data.error, /ends on 2026-09-20/);
  assert.match((await mis('GET', '/reports/bank_month_end?from=2026-08-21&to=2026-09-20')).data.error, /choose a cycle/);
  // From the last day of the cycle to five days after: full numbers, grouped by product, downloadable with the numbers.
  for (const day of ['2026-09-20', '2026-09-25']) {
    timing.now = () => UAE(`${day}T10:00:00`);
    const r = (await mis('GET', '/reports/bank_month_end?cycle=2026-09')).data;
    assert.equal(r.full_phones, true, day);
    assert.deepEqual(r.columns.slice(0, 1).map((c) => c.key), ['product_group']);
    assert.deepEqual(r.rows.map((x) => [x.product_group, x.customer, x.phone, x.alt_phone]), [['Credit cards', 'Card Customer', '+971 50 111 2222', '+971 4 222 3333'], ['Personal loans', 'Loan Customer', '+971 50 333 4444', '']]);
    assert.match(r.note, /in full until 2026-09-25/);
    assert.equal(r.totals.product_group, 'Credit cards 1 · Personal loans 1');
    assert.equal((await head('GET', '/reports/bank_month_end?cycle=2026-09')).data.rows[0].phone, '+971 50 111 2222');
    const csv = (await mis('GET', '/reports/bank_month_end?cycle=2026-09&format=csv', null, true)).data;
    assert.match(csv, /Product,Ref,App ID/);
    assert.match(csv, /,Phone,Alternate phone,/);
    assert.match(csv, /\+971 50 111 2222,\+971 4 222 3333/);
  }
  // The case register never downloads the numbers, even inside the window.
  const reg = (await mis('GET', '/reports/register?cycle=2026-09&format=csv', null, true)).data;
  assert.doesNotMatch(reg, /\+971 50 111 2222|Phone/);
  // After the window the numbers are masked, on screen and in the file.
  timing.now = () => UAE('2026-09-26T10:00:00');
  const late = (await mis('GET', '/reports/bank_month_end?cycle=2026-09')).data;
  assert.equal(late.full_phones, false);
  assert.match(late.note, /closed on 2026-09-25/);
  assert.ok(late.rows.every((x) => !x.phone.includes('111 2222') && !x.phone.includes('333 4444') && !('alt_phone' in x)), JSON.stringify(late.rows.map((x) => x.phone)));
  const lateCsv = (await mis('GET', '/reports/bank_month_end?cycle=2026-09&format=csv', null, true)).data;
  assert.doesNotMatch(lateCsv, /\+971 50 111 2222|Phone/);
  // Every pull is on record with whether the numbers were in full.
  const runs = (await head('GET', '/reports')).data.recent.filter((x) => x.report === 'bank_month_end');
  assert.ok(runs.some((x) => x.filters.phones === 'full') && runs.some((x) => x.filters.phones === 'masked'));
});
