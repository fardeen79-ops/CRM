import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer, makeWebhookDispatcher } from '../src/server.js';
import http from 'node:http';
import { createUser } from '../src/auth.js';

const PASSWORD = 'password123';
let server, base;
const dispatched = [];

before(async () => {
  const db = openDb(':memory:');
  const ids = {};
  for (const [name, email, role] of [
    ['Manager', 'sm@t.local', 'sales_manager'],
    ['Mira', 'mis@t.local', 'mis'],
    ['Boss', 'bh@t.local', 'business_head'],
    ['Lead', 'lead@t.local', 'team_leader'],
    ['Pam', 'proc@t.local', 'processing'],
    ['Pete', 'proc2@t.local', 'processing'],
    ['Gina', 'gov@t.local', 'governance'],
  ]) ids[email] = createUser(db, { name, email, role, password: PASSWORD }).id;
  const profile = (code) => ({ sales_code: code, team_leader_id: ids['lead@t.local'], sales_manager_id: ids['sm@t.local'] });
  createUser(db, { name: 'Sally', email: 'sales@t.local', role: 'sales', password: PASSWORD, ...profile('S-001') });
  createUser(db, { name: 'Sid', email: 'sales2@t.local', role: 'sales', password: PASSWORD, ...profile('S-002') });
  server = createServer(db, { dispatch: (t) => dispatched.push(...t), itEmail: 'it-recordings@t.local' });
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
    // Every new file needs a region and core product; tests that don't care get defaults.
    if (method === 'POST' && path === '/cases' && body) body = { region: 'DXB', core_product: 'personal_loan', ...body };
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
  const newUser = { name: 'New', email: 'New@T.local', role: 'processing', password: 'longenough' };
  // A local mobile number is required; WhatsApp is optional and stored with its country code.
  assert.equal((await lead('POST', '/users', newUser)).status, 400);
  const r = await lead('POST', '/users', { ...newUser, mobile_number: '+971 50 123 4567', whatsapp_number: '050 765 4321' });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.user.email, r.data.user.mobile_number, r.data.user.whatsapp_number], ['new@t.local', '0501234567', '+971507654321']);
  assert.equal((await lead('POST', '/users', { ...newUser, mobile_number: '0501234567' })).status, 409);
  assert.equal((await lead('POST', '/users', { ...newUser, email: 'x@t.local', mobile_number: '12345' })).status, 400);
  const edited = await lead('PATCH', `/users/${r.data.user.id}`, { whatsapp_number: '+44 7700 900123', email: 'renamed@t.local' });
  assert.deepEqual([edited.data.user.whatsapp_number, edited.data.user.email], ['+447700900123', 'renamed@t.local']);
  assert.equal((await lead('PATCH', `/users/${r.data.user.id}`, { email: 'sales@t.local' })).status, 409);
  await lead('PATCH', `/users/${r.data.user.id}`, { active: false });
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'renamed@t.local', password: 'longenough' }),
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

test('sourcing date and email are captured; files start as Sent to checker', async () => {
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

test('only team leader, MIS, sales manager and business head can change case status', async () => {
  const sales = await login('sales@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  const set = (who, case_status, note) => who('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status, note });

  assert.equal((await set(sales, 'completed')).status, 403);
  const proc = await login('proc@t.local');
  assert.equal((await set(proc, 'completed')).status, 403);
  assert.ok(!(await proc('GET', `/cases/${id}`)).data.case.allowed_actions.includes('set_case_status'));
  for (const email of ['lead@t.local', 'mis@t.local', 'sm@t.local', 'bh@t.local']) {
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

  r = await set(lead, 'completed');
  assert.equal(r.data.case.case_status, 'completed');
  assert.equal((await set(lead, 'completed')).status, 409); // already completed
  const bh = await login('bh@t.local');
  r = await set(bh, 'rejected', 'Policy decline');
  assert.equal(r.data.case.case_status, 'rejected');

  const types = (await lead('GET', `/cases/${id}`)).data.case.events.filter((e) => e.type === 'case_status').map((e) => e.detail);
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

test('processors mark verification completed, pending or rejected; case status is separate', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const lead = await login('lead@t.local');

  // Rejected: needs a note, closes verification, alerts sales and team leaders, leaves case status alone
  let id = (await sales('POST', '/cases', newCase)).data.case.id;
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'reject_verification' })).status, 400);
  let r = await proc('POST', `/cases/${id}/actions`, { action: 'reject_verification', reason: 'customer_denied', note: 'Customer says they never applied' });
  assert.equal(r.data.case.status, 'rejected');
  assert.equal(r.data.case.case_status, 'sent_to_check');
  assert.ok((await sales('GET', '/notifications')).data.items.some((n) => /verification rejected/.test(n.message)));
  assert.ok((await lead('GET', '/notifications')).data.items.some((n) => /verification rejected/.test(n.message)));
  // Rejecting the case is a separate decision, and not the processor's
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'rejected', note: 'Fraud suspected' })).status, 403);
  r = await lead('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'rejected', note: 'Fraud suspected' });
  assert.equal(r.data.case.case_status, 'rejected');

  // Completed verification does not complete the case; marking the case completed is a separate step
  id = (await sales('POST', '/cases', newCase)).data.case.id;
  r = await proc('POST', `/cases/${id}/actions`, { action: 'complete' });
  assert.equal(r.data.case.status, 'completed');
  assert.equal(r.data.case.case_status, 'sent_to_check');
  r = await (await login('mis@t.local'))('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed' });
  assert.equal(r.data.case.case_status, 'completed');
  assert.equal(r.data.case.status, 'completed');

  // Pending still goes to the team leader
  id = (await sales('POST', '/cases', newCase)).data.case.id;
  r = await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'documents_pending', note: 'Salary slips missing' });
  assert.equal(r.data.case.status, 'incomplete');
  assert.ok((await lead('GET', '/notifications')).data.items.some((n) => /verification pending/.test(n.message)));
});

test('team leaders never see company, salary, Emirates ID or passport; processors lose them once verification is completed or rejected', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const lead = await login('lead@t.local');
  const sm = await login('sm@t.local');
  const mis = await login('mis@t.local');
  const bh = await login('bh@t.local');
  const secret = { company_name: 'Hidden Trading LLC', salary: 41000, eid_number: '784-1991-7654321-0', passport_number: 'P7654321' };
  const id = (await sales('POST', '/cases', { ...newCase, ...secret })).data.case.id;
  const fields = async (who) => {
    const c = (await who('GET', `/cases/${id}`)).data.case;
    return { company_name: c.company_name, salary: c.salary, eid_number: c.eid_number, passport_number: c.passport_number, hidden: c.hidden_fields };
  };
  const shown = { ...secret, hidden: [] };
  const hidden = { company_name: null, salary: null, eid_number: null, passport_number: null, hidden: ['company_name', 'salary', 'eid_number', 'passport_number'] };

  assert.deepEqual(await fields(sales), shown);
  assert.deepEqual(await fields(sm), shown);
  assert.deepEqual(await fields(mis), shown);
  assert.deepEqual(await fields(bh), shown);
  assert.deepEqual(await fields(lead), hidden);
  assert.deepEqual(await fields(proc), shown); // needed for the verification call

  // Also hidden in lists, and searching cannot reveal a match
  const leadRow = (await lead('GET', '/cases')).data.cases.find((c) => c.id === id);
  assert.equal(leadRow.eid_number, null);
  assert.equal(leadRow.company_name, null);
  for (const q of ['7654321', 'P7654321', 'Hidden Trading']) {
    assert.ok(!(await lead('GET', `/cases?q=${q}`)).data.cases.some((c) => c.id === id), q);
    assert.ok((await mis('GET', `/cases?q=${q}`)).data.cases.some((c) => c.id === id), q);
  }
  assert.ok((await proc('GET', '/cases?q=P7654321')).data.cases.some((c) => c.id === id));

  // Verification Pending: the processor still sees the details
  let r = await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'documents_pending', note: 'Missing slips' });
  assert.equal(r.data.case.eid_number, secret.eid_number);
  assert.deepEqual(await fields(proc), shown);
  assert.ok((await proc('GET', '/cases?q=P7654321')).data.cases.some((c) => c.id === id));
  assert.deepEqual(await fields(lead), hidden);

  // Back to the queue, then verification Completed: hidden from the processor (response redacted too)
  await lead('POST', `/cases/${id}/actions`, { action: 'reverify' });
  assert.deepEqual(await fields(proc), shown);
  r = await proc('POST', `/cases/${id}/actions`, { action: 'complete' });
  assert.equal(r.data.case.eid_number, null);
  assert.deepEqual(await fields(proc), hidden);
  assert.ok(!(await proc('GET', '/cases?q=P7654321')).data.cases.some((c) => c.id === id));

  // Verification Rejected hides them as well
  const id2 = (await sales('POST', '/cases', { ...newCase, ...secret })).data.case.id;
  await proc('POST', `/cases/${id2}/actions`, { action: 'reject_verification', note: 'Employer denies' });
  assert.equal((await proc('GET', `/cases/${id2}`)).data.case.passport_number, null);

  // A team leader can replace a hidden value (e.g. for an edit request) without ever reading it
  r = await lead('PUT', `/cases/${id}`, { passport_number: 'Q1112223' });
  assert.equal(r.status, 200);
  assert.equal(r.data.case.passport_number, null);
  assert.equal((await fields(sm)).passport_number, 'Q1112223');
  assert.equal((await fields(sm)).eid_number, secret.eid_number); // untouched fields keep their values
});

test('files capture region, core product and the sales staff details from the user profile', async () => {
  const sales = await login('sales@t.local');
  const lead = await login('lead@t.local');
  const sm = await login('sm@t.local');

  // Profile on /me pre-fills the form
  const me = (await sales('GET', '/me')).data.user;
  assert.deepEqual([me.sales_code, me.team_leader_name, me.sales_manager_name], ['S-001', 'Lead', 'Manager']);

  // Region and core product are required and checked
  assert.equal((await sales('POST', '/cases', { ...newCase, region: '' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...newCase, region: 'SHJ' })).status, 400);
  assert.equal((await sales('POST', '/cases', { ...newCase, core_product: 'accounts' })).status, 400);

  let r = await sales('POST', '/cases', { ...newCase, region: 'auh', core_product: 'multi_product', sales_staff_id: 999 });
  assert.equal(r.status, 201);
  const c = r.data.case;
  assert.equal(c.region, 'AUH');
  assert.equal(c.core_product, 'multi_product');
  // Sales staff always file as themselves, whatever is sent
  assert.deepEqual([c.sales_staff_name, c.sales_code, c.team_leader_name, c.sales_manager_name], ['Sally', 'S-001', 'Lead', 'Manager']);

  // A team leader enters a file for Sid: Sid owns it, sees it and is notified about it
  assert.equal((await lead('POST', '/cases', newCase)).status, 400); // must pick the sales person
  const staff = (await sm('GET', '/sales-staff')).data.staff;
  assert.equal((await sales('GET', '/sales-staff')).status, 403);
  const sid = staff.find((s) => s.name === 'Sid');
  assert.equal(sid.sales_code, 'S-002');
  r = await lead('POST', '/cases', { ...newCase, sales_staff_id: sid.id });
  assert.equal(r.data.case.sales_staff_name, 'Sid');
  const sidLogin = await login('sales2@t.local');
  assert.ok((await sidLogin('GET', '/cases')).data.cases.some((x) => x.id === r.data.case.id));
  await sm('POST', `/cases/${r.data.case.id}/actions`, { action: 'set_case_status', case_status: 'completed' });
  assert.ok((await sidLogin('GET', '/notifications')).data.items.some((n) => n.case_id === r.data.case.id));

  // Searching by sales code finds the files
  assert.ok((await lead('GET', '/cases?q=S-002')).data.cases.some((x) => x.id === r.data.case.id));

  // The details are a snapshot: changing the profile later does not rewrite old files
  const users = (await lead('GET', '/users')).data.users;
  const sally = users.find((u) => u.email === 'sales@t.local');
  assert.equal((await lead('PATCH', `/users/${sally.id}`, { sales_code: 'S-002' })).status, 400); // taken by Sid
  assert.equal((await lead('PATCH', `/users/${sally.id}`, { sales_code: 'S-101' })).data.user.sales_code, 'S-101');
  assert.equal((await sales('GET', `/cases/${c.id}`)).data.case.sales_code, 'S-001');
  await lead('PATCH', `/users/${sally.id}`, { sales_code: 'S-001' });
});

test('registering sales staff requires a sales code, team leader and sales manager', async () => {
  const lead = await login('lead@t.local');
  const users = (await lead('GET', '/users')).data.users;
  const tl = users.find((u) => u.role === 'team_leader').id;
  const smId = users.find((u) => u.role === 'sales_manager').id;
  const mis = users.find((u) => u.role === 'mis').id;
  const base = { name: 'New Sales', email: 'ns@t.local', role: 'sales', password: 'longenough', mobile_number: '0501234567' };

  assert.equal((await lead('POST', '/users', base)).status, 400);
  assert.equal((await lead('POST', '/users', { ...base, sales_code: 'S-900', team_leader_id: mis, sales_manager_id: smId })).status, 400);
  assert.equal((await lead('POST', '/users', { ...base, sales_code: 'S-001', team_leader_id: tl, sales_manager_id: smId })).status, 400);
  const r = await lead('POST', '/users', { ...base, sales_code: 's-900', team_leader_id: tl, sales_manager_id: smId });
  assert.equal(r.status, 201);
  assert.deepEqual([r.data.user.sales_code, r.data.user.team_leader_name, r.data.user.sales_manager_name], ['S-900', 'Lead', 'Manager']);
  // Other roles don't need (or get) a profile
  const p = await lead('POST', '/users', { name: 'Proc 3', email: 'p3@t.local', role: 'processing', password: 'longenough', mobile_number: '0501234567', sales_code: 'X-1' });
  assert.equal(p.data.user.sales_code, null);
});

test('governance marks files for QC, requests recordings after verification, adds complaints and scores calls', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const gov = await login('gov@t.local');
  const lead = await login('lead@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  const act = (who, body) => who('POST', `/cases/${id}/actions`, body);
  const allowed = async (who) => (await who('GET', `/cases/${id}`)).data.case.allowed_actions;

  // Before verification: QC and complaint yes; recording and score not yet
  assert.deepEqual((await allowed(gov)).sort(), ['flag_urgent', 'mark_qc', 'set_complaint']);
  assert.equal((await act(gov, { action: 'request_recording' })).status, 403);
  assert.equal((await act(gov, { action: 'score_quality', score: 80 })).status, 403);
  // Governance cannot change case status or edit
  assert.equal((await act(gov, { action: 'set_case_status', case_status: 'completed' })).status, 403);
  assert.equal((await gov('PUT', `/cases/${id}`, { city: 'x' })).status, 403);
  // Other roles cannot do governance actions
  assert.equal((await act(lead, { action: 'mark_qc' })).status, 403);

  let r = await act(gov, { action: 'mark_qc', note: 'Random sample' });
  assert.equal(r.data.case.qc_flag, 1);
  assert.equal(r.data.case.qc_by_name, 'Gina');
  assert.ok((await gov('GET', '/cases?qc=1')).data.cases.some((c) => c.id === id));

  assert.equal((await act(gov, { action: 'set_complaint', complaint_number: '' })).status, 400);
  assert.equal((await act(gov, { action: 'set_complaint', complaint_number: '<x>' })).status, 400);
  r = await act(gov, { action: 'set_complaint', complaint_number: 'CMP-2026-0091' });
  assert.equal(r.data.case.complaint_number, 'CMP-2026-0091');
  assert.ok((await lead('GET', '/cases?q=CMP-2026')).data.cases.some((c) => c.id === id));

  // Processor verifies; now recording requests and scoring open up
  await act(proc, { action: 'complete' });
  assert.ok((await allowed(gov)).includes('request_recording'));
  assert.equal((await act(gov, { action: 'request_recording' })).status, 400); // reason required
  r = await act(gov, { action: 'request_recording', note: 'Customer disputes consent' });
  assert.equal(r.data.case.recording_status, 'pending_approval');
  assert.equal((await act(gov, { action: 'request_recording', note: 'again' })).status, 403); // already pending

  // The business head approves (only they can); IT is emailed for the file
  const bh = await login('bh@t.local');
  assert.ok((await bh('GET', '/notifications')).data.items.some((n) => n.message.startsWith('Recording approval needed')));
  assert.ok((await bh('GET', '/cases?recording=pending_approval')).data.cases.some((c) => c.id === id));
  assert.equal((await act(gov, { action: 'approve_recording' })).status, 403);
  assert.equal((await act(lead, { action: 'approve_recording' })).status, 403);
  assert.equal((await act(proc, { action: 'receive_recording', recording_ref: 'x' })).status, 403);
  const before = dispatched.length;
  r = await act(bh, { action: 'approve_recording', note: 'OK for complaint review' });
  assert.equal(r.data.case.recording_status, 'approved');
  assert.equal(r.data.case.recording_decided_by_name, 'Boss');
  const email = dispatched.slice(before).find((t) => t.event === 'recording.it_request');
  assert.equal(email.to, 'it-recordings@t.local');
  assert.match(email.subject, /Call recording request: CRM-/);
  assert.match(email.body, /Customer disputes consent/);
  assert.match(email.body, /Verified by: Pam/);
  assert.equal(r.data.case.recording_email.to, 'it-recordings@t.local');
  assert.ok((await gov('GET', '/notifications')).data.items.some((n) => /IT has been asked for the file/.test(n.message)));

  // Governance records the file once IT shares it
  assert.equal((await act(gov, { action: 'receive_recording' })).status, 400);
  r = await act(gov, { action: 'receive_recording', recording_ref: 'https://share.example/rec/88231.wav' });
  assert.equal(r.data.case.recording_status, 'received');
  assert.equal(r.data.case.recording_ref, 'https://share.example/rec/88231.wav');
  // A new request can be raised later if needed
  assert.ok((await allowed(gov)).includes('request_recording'));

  // Declining needs a reason
  const id2 = (await sales('POST', '/cases', newCase)).data.case.id;
  await proc('POST', `/cases/${id2}/actions`, { action: 'complete' });
  await gov('POST', `/cases/${id2}/actions`, { action: 'request_recording', note: 'Sample check' });
  assert.equal((await bh('POST', `/cases/${id2}/actions`, { action: 'decline_recording' })).status, 400);
  r = await bh('POST', `/cases/${id2}/actions`, { action: 'decline_recording', note: 'Not needed for samples' });
  assert.equal(r.data.case.recording_status, 'declined');

  // Scores are 0 to 10 with at most one decimal
  for (const bad of ['', 11, -1, 7.55, 'x', 86]) assert.equal((await act(gov, { action: 'score_quality', score: bad })).status, 400, String(bad));
  r = await act(gov, { action: 'score_quality', score: 8.5, note: 'Good disclosure, missed DOB check' });
  assert.equal(r.data.case.qc_score, 8.5);
  assert.ok((await proc('GET', '/notifications')).data.items.some((n) => /scored 8.5\/10/.test(n.message)));
  const stats = (await gov('GET', '/stats')).data;
  assert.equal(stats.governance.scored >= 1, true);
  assert.equal(stats.processors.find((p) => p.name === 'Pam').qc_avg, 8.5);

  r = await act(gov, { action: 'clear_qc' });
  assert.equal(r.data.case.qc_flag, 0);

  // Sales staff never see any of it
  const own = (await sales('GET', `/cases/${id}`)).data.case;
  for (const f of ['qc_flag', 'qc_score', 'complaint_number', 'recording_ref', 'recording_status', 'recording_email']) assert.equal(f in own, false, f);
  assert.ok(!(await sales('GET', '/cases?q=CMP-2026')).data.cases.length);
  assert.equal((await sales('GET', '/stats')).data.governance, undefined);
});

test('approved recording requests are posted to the IT email relay', async () => {
  const received = [];
  const relay = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => { received.push(JSON.parse(body)); res.end('ok'); });
  });
  await new Promise((r) => relay.listen(0, r));
  const dispatch = makeWebhookDispatcher({ emailUrl: `http://localhost:${relay.address().port}/send` });
  dispatch([{ event: 'recording.it_request', case_id: 7, ref: 'CRM-000007', to: 'it@bank.example', subject: 'Call recording request: CRM-000007', body: 'Hello IT team' }]);
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 20));
  relay.close();
  assert.deepEqual(received[0], { to: 'it@bank.example', subject: 'Call recording request: CRM-000007', text: 'Hello IT team', ref: 'CRM-000007', case_id: 7 });
});

test('while verification is pending, recordings cannot be retrieved; governance flags it for urgent verification instead', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const gov = await login('gov@t.local');
  const lead = await login('lead@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  const act = (who, body) => who('POST', `/cases/${id}/actions`, body);
  const allowed = async (who) => (await who('GET', `/cases/${id}`)).data.case.allowed_actions;

  await act(proc, { action: 'mark_incomplete', reason: 'customer_unreachable', note: 'No answer' });
  assert.ok(!(await allowed(gov)).includes('request_recording'));
  assert.equal((await act(gov, { action: 'request_recording', note: 'Complaint' })).status, 403);
  assert.ok((await allowed(gov)).includes('score_quality')); // the call still happened and can be scored

  assert.equal((await act(gov, { action: 'flag_urgent' })).status, 400); // reason required
  let r = await act(gov, { action: 'flag_urgent', note: 'Customer complaint escalated' });
  assert.equal(r.data.case.urgent_flag, 1);
  assert.equal(r.data.case.urgent_by_name, 'Gina');
  assert.ok((await proc('GET', '/notifications')).data.items.some((n) => n.message.startsWith('URGENT verification')));
  assert.ok((await lead('GET', '/notifications')).data.items.some((n) => n.message.startsWith('URGENT verification')));
  assert.equal((await gov('GET', '/stats')).data.governance.urgent, 1);
  // Urgent files lead the queues
  assert.equal((await lead('GET', '/cases')).data.cases[0].id, id);
  // Not visible to sales
  assert.equal('urgent_flag' in (await sales('GET', `/cases/${id}`)).data.case, false);

  // Sent back to the queue, still urgent; once verified the flag clears and the recording can be requested
  await act(lead, { action: 'reverify' });
  assert.equal((await gov('GET', `/cases/${id}`)).data.case.urgent_flag, 1);
  r = await act(proc, { action: 'complete' });
  assert.equal((await gov('GET', `/cases/${id}`)).data.case.urgent_flag, 0);
  assert.ok(!(await allowed(gov)).includes('flag_urgent'));
  assert.ok((await allowed(gov)).includes('request_recording'));
  assert.equal((await gov('GET', '/stats')).data.governance.urgent, 0);
});

test('bulk upload of users: preview saves nothing, import keeps good rows and reports the rest', async () => {
  const lead = await login('lead@t.local');
  const mis = await login('mis@t.local');
  const csv = [
    'Full name,Email,Role,Local mobile,WhatsApp number,Sales code,Team leader email,Sales manager email,Temporary password',
    'Bulk Seller,bulk.seller@t.local,Sales,050 111 2222,,BLK-1,bulk.lead@t.local,sm@t.local,',
    'Bulk Lead,bulk.lead@t.local,Team Leader,+971501112223,+971501112223,,,,longenough1',
    'No Phone,nophone@t.local,MIS,,,,,,',
    'Dup,sales@t.local,MIS,0501112224,,,,,',
    'Excel,excel@t.local,MIS,9.71501E+11,,,,,',
  ].join('\r\n');
  // Only MIS and business heads can bulk upload, not even team leaders.
  assert.equal((await lead('POST', '/import/users', { csv })).status, 403);
  const preview = await mis('POST', '/import/users', { csv, dry_run: true });
  assert.equal(preview.status, 200);
  assert.deepEqual([preview.data.ok, preview.data.failed], [2, 3]);
  assert.equal(preview.data.rows[0].temp_password, undefined);
  const users = () => lead('GET', '/users').then((r) => r.data.users.map((u) => u.email));
  assert.ok(!(await users()).includes('bulk.lead@t.local'));

  const done = await mis('POST', '/import/users', { csv });
  assert.deepEqual([done.data.ok, done.data.failed], [2, 3]);
  // The sales row names a team leader added further down the same file.
  assert.equal(done.data.rows[0].ok, true);
  assert.match(done.data.rows[0].temp_password, /^\w{10}$/);
  assert.equal(done.data.rows[1].temp_password, undefined);
  assert.match(done.data.rows[2].error, /mobile number is required/i);
  assert.match(done.data.rows[3].error, /already exists/);
  assert.match(done.data.rows[4].error, /scientific notation/);
  assert.deepEqual(done.data.rows[4].cells.slice(0, 2), ['Excel', 'excel@t.local']);
  assert.ok((await users()).includes('bulk.seller@t.local'));
  const login2 = await fetch(`${base}/api/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email: 'bulk.seller@t.local', password: done.data.rows[0].temp_password }),
  });
  assert.equal(login2.status, 200);

  const bad = await mis('POST', '/import/users', { csv: 'Name,Email\nA,a@t.local' });
  assert.equal(bad.status, 400);
  assert.match(bad.data.error, /missing these columns: Role, Local mobile/);
});

test('bulk upload of cases by sales code, with labels, UAE dates and duplicate App IDs', async () => {
  const lead = await login('lead@t.local');
  const sales = await login('sales@t.local');
  const head = await login('bh@t.local');
  const header = 'Sales code,Sourcing date,Region,Core product,First name,Middle name,Last name,Mobile number,Product,Personal loan type,Loan amount,Interest rate,Full loan amount,Incremental amount,Buy-out bank,Credit card,Bundle products,App ID,Emirates ID';
  const csv = [
    header,
    'S-002,01/10/2026,Dubai,Personal Loan,Rami,,Haddad,0501234567,personal loan,Top Up,"150,000",6.5,250000,100000,,,,BULK-APP-1,784199012345671',
    'S-002,2026-10-02,AUH,Multi product,Lina,Maria,Costa,0501234567,Bundle,Buy Out,90000,7,,,abu dhabi islamic bank (adib),infinite credit card,Personal Loan; Credit Card,BULK-APP-2,',
    'S-002,02/10/2026,DXB,Credit Card,Copy,,Paste,0501234567,Credit Card,,,,,,,Infinite Credit Card,,bulk-app-1,',
    'NOPE,02/10/2026,DXB,Auto Loan,A,,B,0501234567,Auto Loan,,,,,,,,,,',
  ].join('\n');
  for (const who of [sales, lead]) assert.equal((await who('POST', '/import/cases', { csv })).status, 403);
  const done = await head('POST', '/import/cases', { csv });
  assert.equal(done.status, 200);
  assert.deepEqual(done.data.rows.map((r) => r.ok), [true, true, false, false]);
  assert.match(done.data.rows[2].error, /also on line 2/);
  assert.match(done.data.rows[3].error, /sales code NOPE/);
  const c1 = (await lead('GET', `/cases/${done.data.rows[0].id}`)).data.case;
  assert.deepEqual([c1.sales_staff_name, c1.sourcing_date, c1.region, c1.personal_loan_type, c1.loan_amount, c1.case_status], ['Sid', '2026-10-01', 'DXB', 'top_up', 150000, 'sent_to_check']);
  const c2 = (await lead('GET', `/cases/${done.data.rows[1].id}`)).data.case;
  assert.deepEqual([c2.bundle_products, c2.credit_card, c2.buyout_bank], ['personal_loan,credit_card', 'Infinite Credit Card', 'Abu Dhabi Islamic Bank (ADIB)']);
  assert.ok(c2.events.some((e) => e.type === 'bulk_upload'));

  // Uploading the same file again finds the duplicates.
  const again = await head('POST', '/import/cases', { csv, dry_run: true });
  assert.match(again.data.rows[0].error, /already on CRM-/);

  // The sales person owns an uploaded file: Sid sees it, and a blank sales code is an error.
  const sid = await login('sales2@t.local');
  assert.equal((await sid('GET', `/cases/${done.data.rows[0].id}`)).status, 200);
  const blank = await head('POST', '/import/cases', { csv: [header, ',03/10/2026,DXB,Auto Loan,No,,Code,0501234567,Auto Loan,,,,,,,,,,'].join('\n') });
  assert.match(blank.data.rows[0].error, /Sales code is required/);
  // MIS and business heads still can't add single files from the New case form.
  assert.equal((await head('POST', '/cases', newCase)).status, 403);
});

test('targets per sales cycle: MIS sets them, completed cases count, TL and SM see their team', async () => {
  const { cycleOf, uaeDay } = await import('../src/cycles.js');
  const cycle = cycleOf(uaeDay());
  const mis = await login('mis@t.local');
  const lead = await login('lead@t.local');
  const sm = await login('sm@t.local');
  const sally = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const users = (await lead('GET', '/users')).data.users;
  const sallyId = users.find((u) => u.email === 'sales@t.local').id;

  // Only MIS and business heads set targets.
  assert.equal((await lead('PUT', '/targets', { cycle, targets: [{ user_id: sallyId, credit_card: 5 }] })).status, 403);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: sallyId, credit_card: 1.5 }] })).status, 400);
  // Loan targets are AED amounts to disburse; a count-style decimal is rejected for cards.
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: sallyId, personal_loan: '1,500,000.50' }] })).status, 400);
  const set = await mis('PUT', '/targets', { cycle, targets: [{ user_id: sallyId, credit_card: 5, personal_loan: '1,500,000', auto_loan: '' }] });
  assert.equal(set.status, 200);

  const before = (await sally('GET', `/targets?cycle=${cycle}`)).data;
  assert.equal(before.staff.length, 1);
  const start = before.staff[0].achieved;

  // A bundle with a card and a loan, completed now: counts once for each product.
  const id = (await sally('POST', '/cases', { ...newCase, product: 'bundle', bundle_products: ['personal_loan', 'credit_card'], credit_card: 'Infinite Credit Card' })).data.case.id;
  assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_card_status', card_status: 'active' })).status, 403); // not completed yet
  // Completing records the amount actually disbursed (here less than the AED 150,000 applied for).
  assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: '-5' })).status, 400);
  const completed = await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: '140,000' });
  assert.equal(completed.data.case.pl_disbursed_amount, 140000);

  const mine = (await sally('GET', `/targets?cycle=${cycle}`)).data;
  assert.deepEqual(mine.units, { credit_card: 'count', personal_loan: 'aed', auto_loan: 'aed', accounts: 'count' });
  assert.equal(mine.is_current, true);
  assert.ok(mine.days_left >= 1 && mine.days_left <= 31);
  assert.deepEqual(mine.staff[0].target, { credit_card: 5, personal_loan: 1500000 });
  assert.equal(mine.staff[0].achieved.credit_card, start.credit_card + 1);
  assert.equal(mine.staff[0].achieved.personal_loan, start.personal_loan + 140000);
  assert.equal(mine.staff[0].cases.personal_loan, before.staff[0].cases.personal_loan + 1);

  // MIS corrects the disbursed amount later; the target moves with it.
  assert.equal((await sally('POST', `/cases/${id}/actions`, { action: 'set_disbursal', pl_disbursed_amount: 1 })).status, 403);
  await mis('POST', `/cases/${id}/actions`, { action: 'set_disbursal', pl_disbursed_amount: 145000 });
  assert.equal((await sally('GET', `/targets?cycle=${cycle}`)).data.staff[0].achieved.personal_loan, start.personal_loan + 145000);
  assert.equal(mine.staff[0].cards.unmapped >= 1, true);
  assert.equal(mine.can_set, false);

  // Team leader and sales manager see their team with a rolled-up target.
  const team = (await lead('GET', `/targets?cycle=${cycle}`)).data;
  assert.ok(team.staff.length >= 2);
  assert.equal(team.total.target.credit_card, 5);
  assert.equal(team.total.target.personal_loan, 1500000);
  assert.ok((await sm('GET', `/targets?cycle=${cycle}`)).data.by_team_leader.length >= 1);
  assert.equal((await proc('GET', '/targets')).status, 403);
  // Another cycle has no targets.
  const next = (await mis('GET', `/targets?cycle=${cycle.slice(0, 4)}-${cycle.slice(5) === '12' ? '11' : '12'}`)).data;
  assert.equal(next.is_current, false);

  // Cases list drill-down: completed in this cycle, for one sales person.
  const list = (await lead('GET', `/cases?cycle=${cycle}&staff=${sallyId}`)).data.cases;
  assert.ok(list.some((c) => c.id === id));
});

test('card activation is mapped on completed card cases, one by one or from a bank report', async () => {
  const mis = await login('mis@t.local');
  const head = await login('bh@t.local');
  const sally = await login('sales@t.local');
  const lead = await login('lead@t.local');
  const make = async (extra) => (await sally('POST', '/cases', { ...newCase, product: 'credit_card', credit_card: 'Infinite Credit Card', ...extra })).data.case.id;
  const a = await make({ app_id: 'CARD-APP-1' });
  const b = await make({ eid_number: '784-1991-7654321-5' });
  const c = await make({});
  const loan = (await sally('POST', '/cases', newCase)).data.case.id;
  for (const id of [a, b, c, loan]) await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed' });

  // One at a time from the case page.
  assert.ok((await mis('GET', `/cases/${a}`)).data.case.allowed_actions.includes('set_card_status'));
  assert.ok(!(await lead('GET', `/cases/${a}`)).data.case.allowed_actions.includes('set_card_status'));
  assert.ok(!(await mis('GET', `/cases/${loan}`)).data.case.allowed_actions.includes('set_card_status'));
  let r = await mis('POST', `/cases/${a}/actions`, { action: 'set_card_status', card_status: 'active', activation_date: '2099-01-01' });
  assert.equal(r.status, 400);
  r = await mis('POST', `/cases/${a}/actions`, { action: 'set_card_status', card_status: 'active', activation_date: '2026-01-05' });
  assert.deepEqual([r.data.case.card_status, r.data.case.card_activation_date, r.data.case.card_status_by_name], ['active', '2026-01-05', 'Mira']);

  // From a bank report, matched by CRM reference, App ID or Emirates ID.
  const ref = (id) => `CRM-${String(id).padStart(6, '0')}`;
  const csv = ['Reference,Card status,Activation date',
    `CARD-APP-1,Inactive,`,
    `784199176543215,active,03/02/2026`,
    `${ref(loan)},Active,`,
    `NOPE-1,Active,`,
  ].join('\n');
  assert.equal((await lead('POST', '/import/cards', { csv })).status, 403);
  const done = (await head('POST', '/import/cards', { csv })).data;
  assert.deepEqual(done.rows.map((x) => x.ok), [true, true, false, false]);
  assert.match(done.rows[0].email, /Sally \(S-001\)/);
  assert.match(done.rows[2].error, /not a completed credit card case/);
  assert.match(done.rows[3].error, /No case found/);
  assert.equal((await sally('GET', `/cases/${b}`)).data.case.card_activation_date, '2026-02-03');
  // Every status carries a date: inactive since the given date, or today when none is given.
  const { uaeDay } = await import('../src/cycles.js');
  assert.equal((await sally('GET', `/cases/${a}`)).data.case.card_activation_date, uaeDay());
  r = await mis('POST', `/cases/${a}/actions`, { action: 'set_card_status', card_status: 'inactive', activation_date: '2026-03-01' });
  assert.deepEqual([r.data.case.card_status, r.data.case.card_activation_date], ['inactive', '2026-03-01']);
  assert.match(r.data.case.events[0].detail, /Inactive since 2026-03-01/);
  // Clearing the mapping clears the date too.
  r = await mis('POST', `/cases/${a}/actions`, { action: 'set_card_status', card_status: '' });
  assert.deepEqual([r.data.case.card_status, r.data.case.card_activation_date], [null, null]);
  await mis('POST', `/cases/${a}/actions`, { action: 'set_card_status', card_status: 'inactive', activation_date: '2026-03-01' });

  // Tracking lists, scoped for sales staff to their own cases.
  const ids = async (who, q) => (await who('GET', `/cases?card=${q}`)).data.cases.map((x) => x.id);
  assert.ok((await ids(lead, 'inactive')).includes(a));
  assert.ok((await ids(lead, 'active')).includes(b));
  assert.ok((await ids(sally, 'unmapped')).includes(c));
  assert.ok(!(await ids(lead, 'all')).includes(loan));
});

test('targets bulk upload by sales code and cycle', async () => {
  const mis = await login('mis@t.local');
  const sally = await login('sales@t.local');
  const csv = ['Sales code,Cycle,Credit Card,Personal Loan disbursal (AED),Auto Loan disbursal (AED),Accounts',
    'S-001,Jan 2030,12,"AED 1,200,000",,',
    'S-002,01/2030,,,,',
    'S-001,2030-01,1,,,',
    'X-9,Jan 2030,1,,,',
  ].join('\n');
  const done = (await mis('POST', '/import/targets', { csv })).data;
  assert.deepEqual(done.rows.map((x) => x.ok), [true, false, false, false]);
  assert.match(done.rows[1].error, /at least one product/);
  assert.match(done.rows[2].error, /already has a row/);
  const t = (await sally('GET', '/targets?cycle=2030-01')).data.staff[0].target;
  assert.deepEqual(t, { credit_card: 12, personal_loan: 1200000 });
});

test('completing a loan records the disbursed amount, suggested from the file', async () => {
  const sally = await login('sales@t.local');
  const mis = await login('mis@t.local');
  const complete = (id, extra = {}) => mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', ...extra });
  // Fresh personal loan: the loan amount. Top up: the incremental amount (the new money).
  const fresh = (await sally('POST', '/cases', newCase)).data.case.id;
  assert.equal((await complete(fresh)).data.case.pl_disbursed_amount, 150000);
  const topUp = (await sally('POST', '/cases', { ...newCase, personal_loan_type: 'top_up', loan_amount: 300000, full_loan_amount: 300000, incremental_amount: 80000 })).data.case.id;
  assert.equal((await complete(topUp)).data.case.pl_disbursed_amount, 80000);
  // An auto loan with no amount on file needs the disbursed amount.
  const auto = (await sally('POST', '/cases', { ...newCase, product: 'auto_loan', core_product: 'auto_loan' })).data.case.id;
  const r = await complete(auto);
  assert.equal(r.status, 400);
  assert.match(r.data.error, /auto loan disbursed amount/i);
  assert.equal((await complete(auto, { al_disbursed_amount: 95000 })).data.case.al_disbursed_amount, 95000);
  // Moving a case out of Completed clears its disbursal, so it stops counting.
  const back = await mis('POST', `/cases/${auto}/actions`, { action: 'set_case_status', case_status: 'applicant_review', note: 'Disbursal reversed' });
  assert.equal(back.data.case.al_disbursed_amount, null);
  // A card-only case has no disbursal.
  const card = (await sally('POST', '/cases', { ...newCase, product: 'credit_card', credit_card: 'Infinite Credit Card' })).data.case.id;
  const c = (await complete(card)).data.case;
  assert.deepEqual([c.pl_disbursed_amount, c.allowed_actions.includes('set_disbursal')], [null, false]);
});
