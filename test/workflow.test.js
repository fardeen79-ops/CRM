import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';

const PASSWORD = 'password123';
let server, base;
const dispatched = [];

before(async () => {
  const db = openDb(':memory:');
  for (const [name, email, role] of [
    ['Lead', 'lead@t.local', 'team_leader'],
    ['Sally', 'sales@t.local', 'sales'],
    ['Sid', 'sales2@t.local', 'sales'],
    ['Pam', 'proc@t.local', 'processing'],
    ['Pete', 'proc2@t.local', 'processing'],
  ]) createUser(db, { name, email, role, password: PASSWORD });
  server = createServer(db, { dispatch: (t) => dispatched.push(...t) });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { cookie, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
}

const newCase = { customer_name: 'Asha Rao', phone: '+91 98765 43210', city: 'Pune', product: 'personal_loan', amount: '1,50,000' };

test('rejects unauthenticated access and bad credentials', async () => {
  assert.equal((await fetch(`${base}/api/cases`)).status, 401);
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'sales@t.local', password: 'wrong' }),
  });
  assert.equal(res.status, 401);
});

test('full workflow: source → verify incomplete → TL returns → sales resubmits → verified', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const proc2 = await login('proc2@t.local');
  const lead = await login('lead@t.local');

  // Sales adds sourcing data
  let r = await sales('POST', '/cases', newCase);
  assert.equal(r.status, 201);
  const id = r.data.case.id;
  assert.equal(r.data.case.status, 'pending_verification');
  assert.equal(r.data.case.amount, 150000);
  assert.match(r.data.case.ref, /^CRM-0+\d+$/);

  // Processing sees it in the queue
  r = await proc('GET', '/cases?status=pending_verification');
  assert.ok(r.data.cases.some((c) => c.id === id));

  // Processing cannot create cases
  assert.equal((await proc('POST', '/cases', newCase)).status, 403);

  // Claim + log call
  r = await proc('POST', `/cases/${id}/actions`, { action: 'claim' });
  assert.equal(r.data.case.status, 'in_verification');
  assert.equal(r.data.case.assigned_to_name, 'Pam');

  // Another processor cannot act on a claimed case
  assert.equal((await proc2('POST', `/cases/${id}/actions`, { action: 'complete' })).status, 409);

  r = await proc('POST', `/cases/${id}/actions`, { action: 'log_call', outcome: 'no_answer' });
  assert.equal(r.data.case.call_attempts, 1);

  // Incomplete requires a reason and a note
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'customer_unreachable' })).status, 400);
  r = await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'incorrect_details', note: 'Phone belongs to someone else' });
  assert.equal(r.status, 200);
  assert.equal(r.data.case.status, 'incomplete');

  // Team leader is triggered: notification + webhook trigger
  const notes = await lead('GET', '/notifications');
  assert.ok(notes.data.unread >= 1);
  assert.match(notes.data.items[0].message, /Action required/);
  assert.equal(dispatched.at(-1).event, 'case.incomplete');
  assert.equal(dispatched.at(-1).case_id, id);
  const stats = await lead('GET', '/stats');
  assert.equal(stats.data.by_status.incomplete, 1);

  // Only a team leader can act on an incomplete case
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'reverify' })).status, 403);
  assert.equal((await lead('POST', `/cases/${id}/actions`, { action: 'return_to_sales' })).status, 400); // note required
  r = await lead('POST', `/cases/${id}/actions`, { action: 'return_to_sales', note: 'Please get the correct number' });
  assert.equal(r.data.case.status, 'returned_to_sales');

  // Sales is notified, edits and resubmits
  const salesNotes = await sales('GET', '/notifications');
  assert.ok(salesNotes.data.items.some((n) => /returned to you/.test(n.message)));
  r = await sales('PUT', `/cases/${id}`, { phone: '+91 90000 00000' });
  assert.equal(r.status, 200);
  assert.equal(r.data.case.phone, '+91 90000 00000');
  r = await sales('POST', `/cases/${id}/actions`, { action: 'resubmit' });
  assert.equal(r.data.case.status, 'pending_verification');
  assert.equal(r.data.case.assigned_to, null);

  // Processor verifies directly (auto-assigns)
  r = await proc2('POST', `/cases/${id}/actions`, { action: 'complete', note: 'Customer confirmed' });
  assert.equal(r.data.case.status, 'completed');
  assert.equal(r.data.case.verified_by_name, 'Pete');

  // Completed cases are locked
  assert.equal((await sales('PUT', `/cases/${id}`, { city: 'Mumbai' })).status, 403);
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'other', note: 'x' })).status, 409);

  // Audit trail captures every step
  r = await lead('GET', `/cases/${id}`);
  assert.deepEqual(
    r.data.case.events.map((e) => e.type).reverse(),
    ['created', 'claim', 'log_call', 'mark_incomplete', 'return_to_sales', 'edited', 'resubmit', 'complete']
  );
});

test('team leader can send back for re-verification or reject', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const lead = await login('lead@t.local');

  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'customer_unreachable', note: 'No answer x3' });
  let r = await lead('POST', `/cases/${id}/actions`, { action: 'reverify' });
  assert.equal(r.data.case.status, 'pending_verification');
  assert.equal(r.data.case.assigned_to, null);

  await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'customer_denied', note: 'Says never applied' });
  r = await lead('POST', `/cases/${id}/actions`, { action: 'reject', note: 'Fake lead' });
  assert.equal(r.data.case.status, 'rejected');
  assert.deepEqual(r.data.case.allowed_actions, []);
});

test('sales staff only see their own cases and input is validated', async () => {
  const sales = await login('sales@t.local');
  const sales2 = await login('sales2@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;

  assert.equal((await sales2('GET', `/cases/${id}`)).status, 404);
  assert.ok(!(await sales2('GET', '/cases')).data.cases.some((c) => c.id === id));

  assert.equal((await sales('POST', '/cases', { customer_name: 'X' })).status, 400);
  assert.equal((await sales('POST', '/cases', { customer_name: 'X', phone: 'abc' })).status, 400);
  assert.equal((await sales('POST', '/cases', { customer_name: 'X', phone: '9876543210', email: 'bad' })).status, 400);
});

test('only team leaders manage users', async () => {
  const sales = await login('sales@t.local');
  const lead = await login('lead@t.local');
  assert.equal((await sales('GET', '/users')).status, 403);
  const r = await lead('POST', '/users', { name: 'New', email: 'new@t.local', role: 'processing', password: 'longenough' });
  assert.equal(r.status, 201);
  assert.equal((await lead('POST', '/users', { name: 'New', email: 'new@t.local', role: 'processing', password: 'longenough' })).status, 409);
  await lead('PATCH', `/users/${r.data.user.id}`, { active: false });
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'new@t.local', password: 'longenough' }),
  });
  assert.equal(res.status, 401);
});

test('product must be one of the fixed options, and a bundle needs two or more products', async () => {
  const sales = await login('sales@t.local');
  const base = { customer_name: 'Bundle Test', phone: '9876543210' };

  assert.equal((await sales('POST', '/cases', base)).status, 400); // product required
  assert.equal((await sales('POST', '/cases', { ...base, product: 'home_loan' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'bundle' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['credit_card'] })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['credit_card', 'mortgage'] })).status, 400);

  let r = await sales('POST', '/cases', { ...base, product: 'auto_loan' });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.product_label, 'Auto Loan');
  assert.equal(r.data.case.bundle_products, null);

  r = await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['accounts', 'personal_loan', 'accounts'] });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.bundle_products, 'personal_loan,accounts');
  assert.equal(r.data.case.product_label, 'Bundle: Personal Loan + Accounts');
  const id = r.data.case.id;

  // Editing only the bundle contents keeps the product; switching away from bundle clears them.
  r = await sales('PUT', `/cases/${id}`, { bundle_products: 'credit_card,auto_loan,accounts', credit_card: 'Skywards Infinite Credit Card' });
  assert.equal(r.data.case.product_label, 'Bundle: Credit Card (Skywards Infinite Credit Card) + Auto Loan + Accounts');
  assert.equal((await sales('PUT', `/cases/${id}`, { bundle_products: ['accounts'] })).status, 400);
  r = await sales('PUT', `/cases/${id}`, { product: 'credit_card', bundle_products: ['accounts', 'auto_loan'] });
  assert.equal(r.data.case.product, 'credit_card');
  assert.equal(r.data.case.bundle_products, null);
  assert.equal(r.data.case.credit_card, 'Skywards Infinite Credit Card'); // kept from before

  const me = await sales('GET', '/me');
  assert.deepEqual(Object.keys(me.data.meta.products), ['personal_loan', 'credit_card', 'auto_loan', 'accounts']);
});

test('credit card cases must name a card from the list', async () => {
  const sales = await login('sales@t.local');
  const base = { customer_name: 'Card Test', phone: '9876543210' };

  assert.equal((await sales('POST', '/cases', { ...base, product: 'credit_card' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'credit_card', credit_card: 'Made Up Card' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['credit_card', 'accounts'] })).status, 400);

  let r = await sales('POST', '/cases', { ...base, product: 'credit_card', credit_card: 'noon One Visa Credit Card' });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.product_label, 'Credit Card (noon One Visa Credit Card)');
  const id = r.data.case.id;

  // Card is searchable
  assert.ok((await sales('GET', '/cases?q=noon%20One')).data.cases.some((c) => c.id === id));

  // Only the card can change; dropping the Credit Card product clears it.
  r = await sales('PUT', `/cases/${id}`, { credit_card: 'LuLu Platinum Mastercard Credit Card' });
  assert.equal(r.data.case.credit_card, 'LuLu Platinum Mastercard Credit Card');
  r = await sales('PUT', `/cases/${id}`, { product: 'personal_loan' });
  assert.equal(r.data.case.credit_card, null);

  // A card is ignored for products that are not credit cards
  r = await sales('POST', '/cases', { ...base, product: 'auto_loan', credit_card: 'Voyager World' });
  assert.equal(r.data.case.credit_card, null);

  const me = await sales('GET', '/me');
  const cards = me.data.meta.credit_cards.flatMap((f) => f.cards);
  assert.equal(cards.length, 29);
  assert.ok(!cards.some((c) => /Family Total|All Cards/.test(c)));
});
