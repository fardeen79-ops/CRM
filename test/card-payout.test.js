// The bank pays a card only once it is activated, within 90 days of the temp end, in the cycle of
// the activation. Loans pay on disbursal. The profit and loss, the dashboard and the reports follow.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { cardActivation } from '../src/payouts.js';

const PASSWORD = 'password123';
let server, base, ids, db;

before(async () => {
  db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('Sally', 'sally@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
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

test('where a card stands with the bank', () => {
  const base = { journey_type: 'emirates_id', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', case_status: 'completed', case_status_at: '2026-09-25T06:00:00.000Z' };
  assert.equal(cardActivation({ ...base, case_status: 'sent_to_check' }).status, 'none');
  assert.equal(cardActivation({ ...base, card_status: 'inactive' }).status, 'awaiting');
  assert.deepEqual([cardActivation({ ...base, card_status: 'active', card_activation_date: '2026-10-10' }).status, cardActivation({ ...base, card_status: 'active', card_activation_date: '2026-10-10' }).days], ['paid', 15]);
  assert.equal(cardActivation({ ...base, card_status: 'active', card_activation_date: '2026-12-24' }).status, 'paid', 'day 90 is inside the window');
  assert.equal(cardActivation({ ...base, card_status: 'active', card_activation_date: '2026-12-25' }).status, 'not_paid', 'day 91 is outside it');
  assert.equal(cardActivation({ ...base, card_status: 'out_of_range' }).status, 'not_paid');
});

test('a card pays in the cycle it is activated, within 90 days; a loan pays when it completes', async () => {
  const sally = await login('sally@t.local'); const mis = await login('mis@t.local'); const head = await login('head@t.local');
  const cycle = (await head('GET', '/me')).data.meta.current_cycle; // 2026-10: 21 Sep to 20 Oct, today 5 Oct
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const file = async (over) => {
    const r = await sally('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Card Customer', fpd, ...over });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.case.id;
  };
  const card = await file({ core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf' });
  const loan = await file({ core_product: 'personal_loan', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 100000, interest_rate: 9, pl_tenure: 48 });
  for (const [id, extra] of [[card, {}], [loan, { pl_disbursed_amount: 100000 }]]) assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', ...extra })).status, 200);
  const potential = (await mis('GET', `/cases/${card}`)).data.case.payout;
  assert.ok(potential.total > 0);
  assert.deepEqual([potential.earned, potential.card.status], [0, 'awaiting'], 'completed, not activated: nothing paid yet');
  // The profit and loss: the loan's 3% is in, the card is not.
  let pnl = (await head('GET', `/pnl?cycle=${cycle}`)).data.pnl;
  assert.deepEqual([pnl.revenue.total, pnl.revenue.by_product.credit_card, pnl.revenue.by_product.personal_loan, pnl.revenue.files], [3000, 0, 3000, 1]);
  let dash = (await head('GET', '/stats')).data.revenue;
  assert.deepEqual([dash.completed_aed, dash.completed_files, dash.awaiting_aed, dash.awaiting_files], [3000, 1, potential.total, 1]);
  const srcRow = (await mis('GET', `/reports/sourcing?cycle=${cycle}`)).data.rows.find((r) => r.staff === 'Sally');
  assert.deepEqual([srcRow.revenue_aed, srcRow.revenue_pending_aed], [3000, potential.total]);
  const reg = (await mis('GET', `/reports/register?cycle=${cycle}`)).data.rows;
  assert.deepEqual(reg.find((r) => /card/i.test(r.product)).payout_status, 'Awaiting activation');
  // Activated today, inside the window: paid in this cycle, and the CEO sees it.
  assert.equal((await mis('POST', `/cases/${card}/actions`, { action: 'set_card_status', card_status: 'active', activation_date: '2026-10-05' })).status, 200);
  assert.equal((await mis('GET', `/cases/${card}`)).data.case.payout.card.status, 'paid');
  pnl = (await head('GET', `/pnl?cycle=${cycle}`)).data.pnl;
  assert.deepEqual([pnl.revenue.total, pnl.revenue.by_product.credit_card, pnl.revenue.files], [3000 + potential.total, potential.total, 2]);
  assert.equal((await head('GET', `/pnl?cycle=${cycle}`)).data.tree.total.revenue, 3000 + potential.total);
  assert.equal((await head('GET', `/ceo?cycle=${cycle}`)).data.money.revenue.now, 3000 + potential.total);
  dash = (await head('GET', '/stats')).data.revenue;
  assert.deepEqual([dash.completed_aed, dash.awaiting_aed], [3000 + potential.total, 0]);
  assert.equal((await mis('GET', `/reports/register?cycle=${cycle}`)).data.rows.find((r) => /card/i.test(r.product)).payout_status, 'Paid');
  // The same card with a temp end 107 days before that activation: outside the window, never paid.
  db.prepare("UPDATE cases SET case_status_at = '2026-06-20T06:00:00.000Z' WHERE id = ?").run(card);
  const late = (await mis('GET', `/cases/${card}`)).data.case.payout;
  assert.deepEqual([late.earned, late.card.status], [0, 'not_paid']);
  assert.equal((await head('GET', `/pnl?cycle=${cycle}`)).data.pnl.revenue.by_product.credit_card, 0);
  // Activated on day 66 instead: paid in the cycle of that activation (September), not in this one.
  assert.equal((await mis('POST', `/cases/${card}/actions`, { action: 'set_card_status', card_status: 'active', activation_date: '2026-08-25' })).status, 200);
  assert.equal((await mis('GET', `/cases/${card}`)).data.case.payout.card.status, 'paid');
  assert.equal((await head('GET', `/pnl?cycle=${cycle}`)).data.pnl.revenue.by_product.credit_card, 0);
  const sep = (await head('GET', '/pnl?cycle=2026-09')).data.pnl;
  assert.deepEqual([sep.revenue.by_product.credit_card, sep.revenue.files], [potential.total, 1]);
});
