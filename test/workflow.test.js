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
    ['Manager', 'sm@t.local', 'sales_manager'],
    ['Mira', 'mis@t.local', 'mis'],
    ['Boss', 'bh@t.local', 'business_head'],
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

const newCase = { customer_name: 'Asha Rao', phone: '+91 98765 43210', city: 'Pune', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '1,50,000', interest_rate: 6.5 };

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
  assert.equal(r.data.case.loan_amount, 150000);
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
  assert.deepEqual(r.data.case.allowed_actions, ['set_case_status']); // verification is over; case status can still change
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

  r = await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['accounts', 'personal_loan', 'accounts'], personal_loan_type: 'buy_out', buyout_bank: 'RAKBANK', loan_amount: '1,50,000', interest_rate: 6.5 });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.bundle_products, 'personal_loan,accounts');
  assert.equal(r.data.case.product_label, 'Bundle: Personal Loan (Buy Out from RAKBANK) + Accounts');
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
  r = await sales('PUT', `/cases/${id}`, { product: 'personal_loan', personal_loan_type: 'top_up', loan_amount: '1,50,000', interest_rate: 6.5, full_loan_amount: 200000, incremental_amount: 50000 });
  assert.equal(r.data.case.credit_card, null);

  // A card is ignored for products that are not credit cards
  r = await sales('POST', '/cases', { ...base, product: 'auto_loan', credit_card: 'Voyager World' });
  assert.equal(r.data.case.credit_card, null);

  const me = await sales('GET', '/me');
  const cards = me.data.meta.credit_cards.flatMap((f) => f.cards);
  assert.equal(cards.length, 29);
  assert.ok(!cards.some((c) => /Family Total|All Cards/.test(c)));
});

test('personal loan cases must say Top Up, Buy Out or Fresh', async () => {
  const sales = await login('sales@t.local');
  const base = { customer_name: 'Loan Test', phone: '9876543210' };

  assert.equal((await sales('POST', '/cases', { ...base, product: 'personal_loan' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'personal_loan', personal_loan_type: 'refinance' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, product: 'bundle', bundle_products: ['personal_loan', 'accounts'] })).status, 400);

  let r = await sales('POST', '/cases', { ...base, product: 'personal_loan', personal_loan_type: 'top_up', loan_amount: '1,50,000', interest_rate: 6.5, full_loan_amount: 200000, incremental_amount: 50000 });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.product_label, 'Personal Loan (Top Up)');
  const id = r.data.case.id;

  r = await sales('PUT', `/cases/${id}`, { personal_loan_type: 'fresh' });
  assert.equal(r.data.case.personal_loan_type, 'fresh');

  // Bundle with both a personal loan and a credit card needs both details
  assert.equal((await sales('PUT', `/cases/${id}`, { product: 'bundle', bundle_products: ['personal_loan', 'credit_card'] })).status, 400);
  r = await sales('PUT', `/cases/${id}`, { product: 'bundle', bundle_products: ['personal_loan', 'credit_card'], credit_card: 'Share Visa Signature Credit Card' });
  assert.equal(r.data.case.product_label, 'Bundle: Personal Loan (Fresh) + Credit Card (Share Visa Signature Credit Card)');

  // Dropping the personal loan clears the type; a type is ignored for other products
  r = await sales('PUT', `/cases/${id}`, { product: 'auto_loan' });
  assert.equal(r.data.case.personal_loan_type, null);
  r = await sales('POST', '/cases', { ...base, product: 'accounts', personal_loan_type: 'buy_out' });
  assert.equal(r.data.case.personal_loan_type, null);
});

test('a buy-out personal loan must name the bank it is bought out from', async () => {
  const sales = await login('sales@t.local');
  const base = { customer_name: 'Buyout Test', phone: '9876543210', product: 'personal_loan', loan_amount: '1,50,000', interest_rate: 6.5 };

  assert.equal((await sales('POST', '/cases', { ...base, personal_loan_type: 'buy_out' })).status, 400);
  let r = await sales('POST', '/cases', { ...base, personal_loan_type: 'buy_out', buyout_bank: 'Mashreq' });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.product_label, 'Personal Loan (Buy Out from Mashreq)');
  const id = r.data.case.id;

  // A bank outside the list is accepted, and the bank is searchable
  r = await sales('PUT', `/cases/${id}`, { buyout_bank: 'Some Small Bank' });
  assert.equal(r.data.case.buyout_bank, 'Some Small Bank');
  assert.ok((await sales('GET', '/cases?q=Small%20Bank')).data.cases.some((c) => c.id === id));

  // Switching to another loan type clears the bank; a bank is ignored for Fresh/Top Up
  r = await sales('PUT', `/cases/${id}`, { personal_loan_type: 'top_up', full_loan_amount: 200000, incremental_amount: 50000 });
  assert.equal(r.data.case.buyout_bank, null);
  r = await sales('POST', '/cases', { ...base, personal_loan_type: 'fresh', buyout_bank: 'Mashreq' });
  assert.equal(r.data.case.buyout_bank, null);

  const me = await sales('GET', '/me');
  assert.ok(me.data.meta.banks.flatMap((g) => g.banks).includes('Emirates NBD'));
});

test('customer identity fields and personal loan amounts are captured and validated', async () => {
  const sales = await login('sales@t.local');
  const base = {
    first_name: 'Mohammed', middle_name: 'Ali', last_name: 'Rahman', phone: '+971 50 123 4567',
    company_name: 'Acme Trading LLC', salary: '25,000', eid_number: '784 1990 1234567 1',
    passport_number: 'n 1234567', bidaya_id: 'BID-0042', app_id: 'APP-7781',
    product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '120,000', interest_rate: '5.99',
  };

  let r = await sales('POST', '/cases', base);
  assert.equal(r.status, 201);
  const c = r.data.case;
  assert.equal(c.customer_name, 'Mohammed Ali Rahman');
  assert.equal(c.eid_number, '784-1990-1234567-1');
  assert.equal(c.passport_number, 'N1234567');
  assert.equal(c.salary, 25000);
  assert.equal(c.loan_amount, 120000);
  assert.equal(c.interest_rate, 5.99);
  assert.equal(c.full_loan_amount, null);

  // Required names, EID / passport format, rate and loan amount rules
  assert.equal((await sales('POST', '/cases', { ...base, first_name: '' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, last_name: '' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, eid_number: '123-4567' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, passport_number: 'AB' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, interest_rate: '' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, interest_rate: '120' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, loan_amount: '0' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...base, salary: 'lots' })).status, 400);

  // Top Up needs the full and incremental amounts, and the increment cannot exceed the full amount
  const topUp = { ...base, personal_loan_type: 'top_up' };
  assert.equal((await sales('POST', '/cases', topUp)).status, 400);
  assert.equal((await sales('POST', '/cases', { ...topUp, full_loan_amount: 100000, incremental_amount: 150000 })).status, 400);
  r = await sales('POST', '/cases', { ...topUp, full_loan_amount: '180,000', incremental_amount: '60,000' });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.full_loan_amount, 180000);
  assert.equal(r.data.case.incremental_amount, 60000);

  // Changing only the middle name rebuilds the full name; IDs are searchable
  r = await sales('PUT', `/cases/${c.id}`, { middle_name: '' });
  assert.equal(r.data.case.customer_name, 'Mohammed Rahman');
  for (const q of ['784199012345671', 'N1234567', 'BID-0042', 'APP-7781', 'Acme']) {
    assert.ok((await sales('GET', `/cases?q=${encodeURIComponent(q)}`)).data.cases.some((x) => x.id === c.id), q);
  }

  // Dropping the personal loan clears its amounts
  r = await sales('PUT', `/cases/${c.id}`, { product: 'accounts' });
  assert.equal(r.data.case.loan_amount, null);
  assert.equal(r.data.case.interest_rate, null);
});

test('sourcing date and email are captured; files start as Sent to check', async () => {
  const sales = await login('sales@t.local');
  let r = await sales('POST', '/cases', { ...newCase, email: 'asha@example.com', sourcing_date: '2026-09-30' });
  assert.equal(r.status, 201);
  assert.equal(r.data.case.case_status, 'sent_to_check');
  assert.equal(r.data.case.sourcing_date, '2026-09-30');
  assert.equal(r.data.case.email, 'asha@example.com');

  // Defaults to today when not given; rejects bad and future dates
  r = await sales('POST', '/cases', newCase);
  assert.equal(r.data.case.sourcing_date, new Date().toISOString().slice(0, 10));
  assert.equal((await sales('POST', '/cases', { ...newCase, sourcing_date: '30/09/2026' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...newCase, sourcing_date: '2099-01-01' })).status, 400);
});

test('only team leader, MIS, sales manager, processor and business head can change case status', async () => {
  const sales = await login('sales@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  const set = (who, case_status, note) => who('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status, note });

  assert.equal((await set(sales, 'completed')).status, 403);
  for (const email of ['lead@t.local', 'mis@t.local', 'sm@t.local', 'proc@t.local', 'bh@t.local']) {
    const who = await login(email);
    assert.ok((await who('GET', `/cases/${id}`)).data.case.allowed_actions.includes('set_case_status'), email);
  }

  const mis = await login('mis@t.local');
  assert.equal((await set(mis, 'sent_to_check', 'x')).status, 400); // not a choice in the dropdown
  assert.equal((await set(mis, 'applicant_review')).status, 400); // note required
  let r = await set(mis, 'applicant_review', 'Salary certificate missing');
  assert.equal(r.data.case.case_status, 'applicant_review');
  assert.equal(r.data.case.case_status_by_name, 'Mira');

  // Sales is told, team leaders are alerted
  assert.ok((await sales('GET', '/notifications')).data.items.some((n) => /Applicant review/.test(n.message)));
  const lead = await login('lead@t.local');
  assert.ok((await lead('GET', '/notifications')).data.items.some((n) => n.message.startsWith('Applicant review:')));

  const proc = await login('proc@t.local');
  r = await set(proc, 'completed');
  assert.equal(r.data.case.case_status, 'completed');
  assert.equal((await set(proc, 'completed')).status, 409); // already completed
  const bh = await login('bh@t.local');
  r = await set(bh, 'rejected', 'Policy decline');
  assert.equal(r.data.case.case_status, 'rejected');

  const types = (await lead('GET', `/cases/${id}`)).data.case.events.map((e) => e.detail).filter(Boolean);
  assert.deepEqual(types.slice(0, 3), ['rejected', 'completed', 'applicant_review']);
});

test('in Applicant review sales cannot edit, but can send an edit request to the TL or SM queue', async () => {
  const sales = await login('sales@t.local');
  const sm = await login('sm@t.local');
  const lead = await login('lead@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;

  // Before review, sales can edit and cannot request edits
  assert.equal((await sales('PUT', `/cases/${id}`, { city: 'Dubai' })).status, 200);
  assert.equal((await sales('POST', `/cases/${id}/actions`, { action: 'request_edit', to: 'sales_manager', note: 'x' })).status, 403);

  await sm('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'applicant_review', note: 'Wrong EID' });
  assert.equal((await sales('PUT', `/cases/${id}`, { city: 'Abu Dhabi' })).status, 403);
  let r = await sales('GET', `/cases/${id}`);
  assert.equal(r.data.case.can_edit, false);
  assert.ok(r.data.case.allowed_actions.includes('request_edit'));

  assert.equal((await sales('POST', `/cases/${id}/actions`, { action: 'request_edit', to: 'mis', note: 'x' })).status, 400);
  assert.equal((await sales('POST', `/cases/${id}/actions`, { action: 'request_edit', to: 'sales_manager' })).status, 400);
  r = await sales('POST', `/cases/${id}/actions`, { action: 'request_edit', to: 'sales_manager', note: 'Correct EID is 784-1990-1234567-1' });
  assert.equal(r.data.case.edit_request_to, 'sales_manager');

  // It lands in the sales manager's queue, not the team leader's
  assert.ok((await sm('GET', '/cases?edit_requests=mine')).data.cases.some((c) => c.id === id));
  assert.ok(!(await lead('GET', '/cases?edit_requests=mine')).data.cases.some((c) => c.id === id));
  assert.equal((await sm('GET', '/stats')).data.edit_requests, 1);
  assert.ok((await sm('GET', '/notifications')).data.items.some((n) => n.message.startsWith('Edit request:')));

  // The sales manager edits the details and marks the request done; sales is told
  r = await sm('PUT', `/cases/${id}`, { eid_number: '784-1990-1234567-1' });
  assert.equal(r.status, 200);
  const mis = await login('mis@t.local');
  assert.equal((await mis('PUT', `/cases/${id}`, { city: 'x' })).status, 403); // MIS can set status but not edit
  assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'resolve_edit_request' })).status, 403);
  r = await sm('POST', `/cases/${id}/actions`, { action: 'resolve_edit_request', note: 'EID updated' });
  assert.equal(r.data.case.edit_request_to, null);
  assert.ok((await sales('GET', '/notifications')).data.items.some((n) => /requested changes were made/.test(n.message)));

  // Closed cases cannot be edited by anyone
  await sm('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed' });
  assert.equal((await sm('PUT', `/cases/${id}`, { city: 'x' })).status, 403);
});
