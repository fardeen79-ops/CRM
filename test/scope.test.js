// Who sees which files: processors by region, team leaders, sales managers and assistant sales
// managers by team. MIS, business heads and governance see everything.
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
  add('SM One', 'sm1@t.local', 'sales_manager');
  add('SM Two', 'sm2@t.local', 'sales_manager');
  add('ASM One', 'asm1@t.local', 'asm');
  add('TL Dubai', 'tl-dxb@t.local', 'team_leader');
  add('TL Abu Dhabi', 'tl-auh@t.local', 'team_leader');
  add('Proc Dubai', 'proc-dxb@t.local', 'processing', { region: 'DXB' });
  add('Proc Abu Dhabi', 'proc-auh@t.local', 'processing', { region: 'AUH' });
  add('Proc Anywhere', 'proc-all@t.local', 'processing');
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
  add('Mina', 'mis-auh@t.local', 'mis', { region: 'AUH' });
  add('Gina', 'gov@t.local', 'governance');
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl-dxb@t.local'], sales_manager_id: ids['sm1@t.local'], asm_id: ids['asm1@t.local'] });
  add('Amal', 'amal@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', team_leader_id: ids['tl-auh@t.local'], sales_manager_id: ids['sm2@t.local'] });
  server = createServer(db, { dispatch: () => {} });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

/** Staff are managed by MIS (and business heads); tests reach the users API through an MIS sign-in. */
const staffAdmin = async (...args) => (await login('mis@t.local'))(...args);

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
}
const file = (name, region = 'DXB') => ({ customer_name: name, region, phone: '+971 50 111 2222', city: 'Dubai', product: 'auto_loan', amount: 50000, core_product: 'auto_loan', auto_loan_type: 'used', car_make: 'Nissan', car_model: 'Patrol', car_year: 2023, al_lead_source: 'Walk-in', al_interest_rate: 4, al_tenure: 48 });
const names = (list) => list.map((c) => c.customer_name).sort();

test('a file starts in the sales person\'s region but can name any region', async () => {
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const d = await dana('POST', '/cases', file('Dubai customer'));
  assert.equal(d.status, 201, JSON.stringify(d.data));
  assert.equal(d.data.case.region, 'DXB');
  const a = await amal('POST', '/cases', file('Abu Dhabi customer', 'AUH'));
  assert.equal(a.data.case.region, 'AUH');
  const d2 = await amal('POST', '/cases', { ...file('Default region'), region: '' });
  assert.equal(d2.data.case.region, 'AUH');
  ids.defaultCase = d2.data.case.id;
  const x = await amal('POST', '/cases', file('Abu Dhabi staff, Dubai customer'));
  assert.equal(x.data.case.region, 'DXB');
  ids.dubaiCase = d.data.case.id;
  ids.auhCase = a.data.case.id;
});

test('processors with a region see only that region\'s files; one without sees all', async () => {
  const dxb = await login('proc-dxb@t.local');
  const auh = await login('proc-auh@t.local');
  const all = await login('proc-all@t.local');
  assert.deepEqual(names((await dxb('GET', '/cases')).data.cases), ['Abu Dhabi staff, Dubai customer', 'Dubai customer']);
  assert.deepEqual(names((await auh('GET', '/cases')).data.cases), ['Abu Dhabi customer', 'Default region']);
  assert.equal((await all('GET', '/cases')).data.cases.length, 4);
  // Direct access, the dashboard and the case discussion follow the same rule.
  assert.equal((await auh('GET', `/cases/${ids.dubaiCase}`)).status, 404);
  assert.equal((await auh('POST', `/cases/${ids.dubaiCase}/assign`, {})).status, 404);
  assert.equal((await auh('GET', `/cases/${ids.dubaiCase}/messages`)).status, 404);
  assert.equal((await dxb('GET', `/cases/${ids.dubaiCase}`)).status, 200);
  assert.equal((await auh('GET', '/stats')).data.total, 2);
  assert.equal((await dxb('GET', '/stats')).data.total, 2);
});

test('team leaders, sales managers and assistant sales managers see only their teams', async () => {
  const tlD = await login('tl-dxb@t.local');
  const tlA = await login('tl-auh@t.local');
  const sm1 = await login('sm1@t.local');
  const sm2 = await login('sm2@t.local');
  const asm = await login('asm1@t.local');
  assert.deepEqual(names((await tlD('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.deepEqual(names((await tlA('GET', '/cases')).data.cases), ['Abu Dhabi customer', 'Abu Dhabi staff, Dubai customer', 'Default region']);
  assert.deepEqual(names((await sm1('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.deepEqual(names((await asm('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.equal((await sm2('GET', '/cases')).data.cases.length, 3);
  assert.equal((await tlD('GET', `/cases/${ids.auhCase}`)).status, 404);
  assert.equal((await asm('GET', `/cases/${ids.auhCase}`)).status, 404);
  assert.equal((await sm1('GET', '/stats')).data.total, 1);
  // The staff picker and the targets page are limited to the team too.
  assert.deepEqual((await tlD('GET', '/sales-staff')).data.staff.map((s) => s.name), ['Dana']);
  assert.deepEqual((await asm('GET', '/sales-staff')).data.staff.map((s) => s.name), ['Dana']);
  assert.deepEqual((await sm2('GET', '/targets')).data.staff.map((s) => s.name), ['Amal']);
  assert.deepEqual((await asm('GET', '/targets')).data.staff.map((s) => s.name), ['Dana']);
  // An assistant sales manager can enter a file for their own staff, not someone else's.
  assert.equal((await asm('POST', '/cases', { ...file('ASM entered'), sales_staff_id: ids['dana@t.local'] })).status, 201);
  const other = await sm1('PUT', `/cases/${ids.dubaiCase}`, { sales_staff_id: ids['amal@t.local'] });
  assert.equal(other.status, 403);
});

test('MIS and governance see every file; the region is saved and editable on a user', async () => {
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  assert.equal((await mis('GET', '/cases')).data.cases.length, 5);
  assert.equal((await gov('GET', '/cases')).data.cases.length, 5);
  const tl = await login('tl-dxb@t.local');
  const proc = ids['proc-all@t.local'];
  assert.equal((await staffAdmin('PATCH', `/users/${proc}`, { region: 'SHJ' })).status, 400);
  assert.equal((await staffAdmin('PATCH', `/users/${proc}`, { region: 'auh' })).data.user.region, 'AUH');
  const nowAuh = await login('proc-all@t.local');
  assert.equal((await nowAuh('GET', '/cases')).data.cases.length, 2);
  const users = (await staffAdmin('GET', '/users')).data.users;
  assert.equal(users.find((u) => u.email === 'dana@t.local').asm_name, 'ASM One');
});

test('region view, hierarchy and reports follow the viewer\'s scope', async () => {
  const bh = await login('mis@t.local');
  const tl = await login('tl-dxb@t.local');
  const gov = await login('gov@t.local');
  const sales = await login('dana@t.local');
  // A business head or MIS can narrow lists and counts to one region.
  assert.equal((await bh('GET', '/cases?region=AUH')).data.cases.length, 2);
  assert.equal((await bh('GET', '/stats?region=AUH')).data.total, 2);
  assert.equal((await bh('GET', '/stats')).data.total, 5);
  // The hierarchy: region → sales manager → team leader → staff for MIS; staff only for a team leader.
  const h = (await bh('GET', '/hierarchy')).data;
  assert.deepEqual(h.levels, ['region', 'sales_manager', 'team_leader', 'staff']);
  assert.deepEqual(h.nodes.map((n) => n.name), ['AUH', 'DXB']);
  assert.equal(h.nodes[1].children[0].children[0].children[0].name, 'Dana');
  assert.equal(h.total.sourced, 5);
  // The region view of the team: Amal's files, whichever region they name.
  const onlyAuh = (await bh('GET', '/hierarchy?region=AUH')).data;
  assert.deepEqual(onlyAuh.nodes.map((n) => n.name), ['AUH']);
  assert.equal(onlyAuh.total.sourced, 3);
  const tlView = (await tl('GET', '/hierarchy')).data;
  assert.deepEqual(tlView.levels, ['staff']);
  assert.deepEqual(tlView.nodes.map((n) => n.name), ['Dana']);
  assert.equal((await sales('GET', '/hierarchy')).data.nodes.length, 1);
  // Reports: the list depends on the role, the rows on the scope.
  const misList = (await bh('GET', '/reports')).data.reports.map((r) => r.key);
  assert.ok(misList.includes('sourcing') && misList.includes('cards') && !misList.includes('governance'));
  const govList = (await gov('GET', '/reports')).data.reports.map((r) => r.key);
  assert.ok(govList.includes('governance') && govList.includes('access') && !govList.includes('targets'));
  assert.equal((await tl('GET', '/reports/governance')).status, 404);
  const all = (await bh('GET', '/reports/sourcing')).data;
  assert.deepEqual(all.rows.map((r) => r.staff).sort(), ['Amal', 'Dana']);
  assert.equal(all.totals.sourced, 5);
  const mine = (await tl('GET', '/reports/sourcing')).data;
  assert.deepEqual(mine.rows.map((r) => r.staff), ['Dana']);
  const auh = (await bh('GET', '/reports/pipeline?region=AUH')).data;
  assert.equal(auh.totals.files, 2);
  assert.equal((await bh('GET', '/reports/pipeline?region=SHJ')).status, 400);
  assert.equal((await bh('GET', '/reports/targets?from=2026-01-01&to=2026-01-31')).status, 400);
  const dated = (await bh('GET', '/reports/register?from=2026-01-01&to=2026-12-31')).data;
  assert.equal(dated.rows.length, 5);
  assert.match(dated.rows[0].phone, /•/); // personal details stay masked in exports
  // CSV download, and the run shows up for governance.
  const csv = await fetch(`${base}/api/reports/register?format=csv`, { headers: { cookie: (await loginCookie('mis@t.local')) } });
  assert.equal(csv.status, 200);
  assert.match(csv.headers.get('content-type'), /text\/csv/);
  assert.match((await csv.text()).replace(/^\uFEFF/, ''), /^Ref,Sourced,Region/);
  const access = (await gov('GET', '/reports/access')).data;
  assert.ok(access.rows.some((r) => r.user === 'Mira' && r.reports_run >= 3));
});

test('a team change moves open files to the new team and leaves completed ones behind', async () => {
  const tl = await login('tl-dxb@t.local');
  const tlA = await login('tl-auh@t.local');
  const sm1 = await login('sm1@t.local');
  const sm2 = await login('sm2@t.local');
  const mis = await login('mis@t.local');
  // Dana completes one file under TL Dubai / SM One, and has open ones there too.
  const done = (await tl('GET', '/cases')).data.cases.find((c) => c.customer_name === 'Dubai customer');
  assert.equal((await mis('POST', `/cases/${done.id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200);
  const before = (await tl('GET', '/cases')).data.cases.length;
  assert.ok(before >= 2);
  // Dana moves to TL Abu Dhabi and SM Two.
  const moved = await staffAdmin('PATCH', `/users/${ids['dana@t.local']}`, { team_leader_id: ids['tl-auh@t.local'], sales_manager_id: ids['sm2@t.local'], asm_id: '' });
  assert.equal(moved.status, 200);
  assert.equal(moved.data.moved_cases, before - 1);
  // The completed file stays with the old team; the open ones went to the new team.
  const oldTeam = (await tl('GET', '/cases')).data.cases;
  assert.deepEqual(oldTeam.map((c) => c.id), [done.id]);
  assert.equal((await sm1('GET', '/cases')).data.cases.length, 1);
  const newTeam = (await tlA('GET', '/cases')).data.cases;
  assert.equal(newTeam.filter((c) => c.sales_staff_name === 'Dana').length, before - 1);
  assert.ok(newTeam.every((c) => c.id !== done.id));
  assert.ok((await sm2('GET', '/cases')).data.cases.some((c) => c.sales_staff_name === 'Dana'));
  const movedCase = (await tlA('GET', `/cases/${newTeam.find((c) => c.sales_staff_name === 'Dana').id}`)).data.case;
  assert.equal(movedCase.team_leader_name, 'TL Abu Dhabi');
  assert.ok(movedCase.events.some((e) => e.type === 'team_change'));
  // The old team leader keeps the completed file in their team view; the new one gets Dana with targets.
  const oldView = (await tl('GET', '/hierarchy')).data;
  assert.deepEqual(oldView.nodes.map((n) => [n.name, Boolean(n.previous_team), n.kpis.completed]), [['Dana', true, 1]]);
  const newView = (await tlA('GET', '/hierarchy')).data;
  assert.deepEqual(newView.nodes.map((n) => n.name).sort(), ['Amal', 'Dana']);
  assert.equal(newView.nodes.find((n) => n.name === 'Dana').kpis.completed, 0);
  // A team leader can only move a file to staff in their own team.
  assert.equal((await tl('PUT', `/cases/${done.id}`, { sales_staff_id: ids['amal@t.local'] })).status, 403);
});

async function loginCookie(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  return res.headers.get('set-cookie').split(';')[0];
}

test('date of joining is saved on a user and validated', async () => {
  const tl = await login('tl-dxb@t.local');
  const id = ids['amal@t.local'];
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { doj: '01/03/2024' })).data.user.doj, '2024-03-01');
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { doj: '2024-13-01' })).status, 400);
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { doj: '2099-01-01' })).status, 400);
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { doj: '' })).data.user.doj, null);
  const made = await staffAdmin('POST', '/users', { name: 'Joiner', email: 'joiner@t.local', role: 'processing', password: 'longenough', mobile_number: '0501239876', hrms_code: 'EN77777', doj: '2025-06-15' });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  assert.equal(made.data.user.doj, '2025-06-15');
});

test('a date of leaving disables the account from that day', async () => {
  const tl = await login('tl-dxb@t.local');
  const id = ids['proc-all@t.local'];
  const today = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  const soon = new Date(Date.now() + 10 * 864e5).toISOString().slice(0, 10);
  // A future leaving date keeps the account working for now.
  let r = await staffAdmin('PATCH', `/users/${id}`, { dol: soon });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.user.dol, r.data.user.active], [soon, 1]);
  assert.equal((await login('proc-all@t.local') && 'ok'), 'ok');
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { dol: '2099-01-01' })).status, 400);
  assert.equal((await staffAdmin('PATCH', `/users/${ids['amal@t.local']}`, { doj: '2025-01-01', dol: '2024-12-01' })).status, 400);
  // A leaving date that has arrived disables the account and ends its sessions.
  const who = await login('proc-all@t.local');
  r = await staffAdmin('PATCH', `/users/${id}`, { dol: today });
  assert.equal(r.data.user.active, 0);
  assert.equal((await who('GET', '/me')).status, 401);
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { active: true })).status, 400);
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { dol: '' })).data.user.dol, null);
  assert.equal((await staffAdmin('PATCH', `/users/${id}`, { active: true })).data.user.active, 1);
  assert.equal((await staffAdmin('PATCH', `/users/${ids['mis@t.local']}`, { dol: today })).status, 400);
});

test('a card below the salary requirement needs a reason or team approval; a higher card is suggested', async () => {
  const dana = await login('dana@t.local');
  // Dana moved to TL Abu Dhabi and SM Two earlier in this file, so they are her approvers.
  const tl = await login('tl-auh@t.local');
  const proc = await login('proc-dxb@t.local');
  const sm = await login('sm2@t.local');
  const card = (extra) => ({ customer_name: 'Card Customer', region: 'DXB', phone: '+971 50 111 3333', city: 'Dubai', product: 'credit_card', core_product: 'credit_card', credit_card: 'Skywards Infinite Credit Card', card_fee_type: 'fyf', ...extra });
  // The list carries each card's salary requirement; Skywards Infinite needs AED 30,000 in the bank's list.
  const cards = (await dana('GET', '/me')).data.meta.credit_cards.flatMap((f) => f.cards);
  assert.equal(cards.find((k) => k.name === 'Skywards Infinite Credit Card').min_salary, 30000);
  // No salary: refused, with the requirement in the message.
  const noSalary = await dana('POST', '/cases', card({}));
  assert.equal(noSalary.status, 400);
  assert.match(noSalary.data.error, /salary.*30,000/);
  // Salary meets the requirement: straight to verification.
  const fine = await dana('POST', '/cases', card({ salary: 32000 }));
  assert.equal(fine.status, 201, JSON.stringify(fine.data));
  assert.equal(fine.data.case.status, 'pending_verification');
  assert.equal(fine.data.case.card_min_salary, 30000);
  // Below with a reason: goes for verification, the reason recorded against the sales person.
  const promo = await dana('POST', '/cases', card({ salary: 9000, card_salary_exception: 'promotion', card_exception_note: 'Oct campaign' }));
  assert.equal(promo.status, 201, JSON.stringify(promo.data));
  assert.deepEqual([promo.data.case.status, promo.data.case.card_salary_exception, promo.data.case.card_exception_by_name, promo.data.case.card_exception_note], ['pending_verification', 'promotion', 'Dana', 'Oct campaign']);
  assert.ok(promo.data.case.events.some((e) => e.type === 'card_exception'));
  assert.equal((await dana('POST', '/cases', card({ salary: 9000, card_salary_exception: 'discount' }))).status, 400);
  // Below with no reason: waits for the team, invisible to processors, and the team is told.
  const wait = await dana('POST', '/cases', card({ salary: 9000 }));
  assert.equal(wait.status, 201, JSON.stringify(wait.data));
  const id = wait.data.case.id;
  assert.equal(wait.data.case.status, 'awaiting_approval');
  assert.ok(!(await proc('GET', '/cases?status=pending_verification')).data.cases.some((c) => c.id === id));
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'claim' })).status, 409);
  assert.ok((await tl('GET', '/notifications')).data.items.some((n) => /Approval needed/.test(n.message) && n.case_id === id));
  assert.equal((await tl('GET', '/stats')).data.card_approvals, 1);
  assert.ok((await sm('GET', '/cases?status=awaiting_approval')).data.cases.some((c) => c.id === id));
  // The sales person can still add the reason themselves, which releases the file.
  const self = await dana('PUT', `/cases/${id}`, { card_salary_exception: 'deviation' });
  assert.deepEqual([self.data.case.status, self.data.case.card_salary_exception], ['pending_verification', 'deviation']);
  assert.equal((await dana('PUT', `/cases/${id}`, { card_salary_exception: '' })).data.case.status, 'awaiting_approval');
  // The team leader records the reason and sends it on, or returns it with a note.
  assert.equal((await tl('POST', `/cases/${id}/actions`, { action: 'approve_card' })).status, 400);
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'approve_card', exception: 'promotion' })).status, 403);
  const approved = (await tl('POST', `/cases/${id}/actions`, { action: 'approve_card', exception: 'promotion', note: 'Approved for the campaign' })).data.case;
  assert.deepEqual([approved.status, approved.card_salary_exception, approved.card_exception_by_name], ['pending_verification', 'promotion', 'TL Abu Dhabi']);
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'claim' })).status, 200);
  const back = await dana('POST', '/cases', card({ salary: 9000 }));
  assert.equal((await sm('POST', `/cases/${back.data.case.id}/actions`, { action: 'decline_card' })).status, 400);
  const declined = (await sm('POST', `/cases/${back.data.case.id}/actions`, { action: 'decline_card', note: 'Offer the Titanium card instead' })).data.case;
  assert.equal(declined.status, 'returned_to_sales');
  // Resubmitting without fixing it goes back to approval; raising the salary clears it.
  assert.equal((await dana('POST', `/cases/${back.data.case.id}/actions`, { action: 'resubmit' })).data.case.status, 'awaiting_approval');
  assert.equal((await dana('PUT', `/cases/${back.data.case.id}`, { salary: 31000 })).data.case.status, 'pending_verification');
});

test('auto loans need the car and loan details; tenures are capped at 60 and 48 months', async () => {
  const dana = await login('dana@t.local');
  const base = file('Car buyer');
  const bad = async (patch, re) => { const r = await dana('POST', '/cases', { ...base, ...patch }); assert.equal(r.status, 400, JSON.stringify(r.data)); assert.match(r.data.error, re); };
  await bad({ auto_loan_type: '' }, /New or Used/);
  await bad({ car_make: '' }, /car make/i);
  await bad({ car_year: 1980 }, /Car year/);
  await bad({ car_year: 2025.5 }, /whole year/);
  await bad({ al_lead_source: '' }, /lead source/i);
  await bad({ al_interest_rate: '' }, /ROI/);
  await bad({ al_tenure: 61 }, /tenure.*60/i);
  await bad({ al_tenure: 0 }, /tenure/i);
  await bad({ amount: '' }, /amount/i);
  const ok = await dana('POST', '/cases', { ...base, dealer_details: 'Arabian Automobiles, Deira' });
  assert.equal(ok.status, 201, JSON.stringify(ok.data));
  assert.deepEqual([ok.data.case.auto_loan_type, ok.data.case.car_make, ok.data.case.car_year, ok.data.case.al_tenure, ok.data.case.dealer_details], ['used', 'Nissan', 2023, 48, 'Arabian Automobiles, Deira']);
  // Personal loans need a tenure of at most 48 months.
  const pl = { customer_name: 'Loan buyer', region: 'DXB', phone: '+971 50 111 4444', city: 'Dubai', product: 'personal_loan', core_product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 100000, interest_rate: 6, fpd: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) };
  assert.equal((await dana('POST', '/cases', pl)).status, 400);
  assert.equal((await dana('POST', '/cases', { ...pl, pl_tenure: 49 })).status, 400);
  assert.equal((await dana('POST', '/cases', { ...pl, pl_tenure: 48 })).data.case.pl_tenure, 48);
});

test('fresh loans confirm secondary buyouts; buy-out loans list the primary buyout and any secondary ones', async () => {
  const dana = await login('dana@t.local');
  const pl = { customer_name: 'Buyout Customer', region: 'DXB', phone: '+971 50 111 5555', city: 'Dubai', product: 'personal_loan', core_product: 'personal_loan', loan_amount: 200000, interest_rate: 6, pl_tenure: 48, fpd: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) };
  // Fresh: no secondary buyouts.
  const none = await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'no' });
  assert.equal(none.status, 201, JSON.stringify(none.data));
  assert.deepEqual([none.data.case.secondary_buyout, none.data.case.pl_buyouts], ['no', []]);
  // Fresh with secondary buyouts: two cards (bank and limit each) and a mortgage.
  const list = [{ role: 'secondary', kind: 'credit_card', bank: 'Mashreq', amount: 20000 }, { role: 'secondary', kind: 'credit_card', bank: 'FAB', amount: 15000 }, { role: 'secondary', kind: 'mortgage', bank: 'ADCB', amount: 900000 }];
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'yes' })).status, 400);
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'yes', pl_buyouts: [{ role: 'secondary', kind: 'credit_card', bank: '', amount: 5000 }] })).status, 400);
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'yes', pl_buyouts: [{ role: 'secondary', kind: 'boat', bank: 'FAB', amount: 5000 }] })).status, 400);
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'maybe' })).status, 400);
  const fresh = await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'yes', pl_buyouts: list });
  assert.equal(fresh.status, 201, JSON.stringify(fresh.data));
  assert.equal(fresh.data.case.pl_buyouts.length, 3);
  assert.equal(fresh.data.case.pl_buyouts.filter((b) => b.kind === 'credit_card').length, 2);
  // Answering No drops any secondary entries that were sent.
  const dropped = await dana('PUT', `/cases/${fresh.data.case.id}`, { secondary_buyout: 'no', pl_buyouts: list });
  assert.deepEqual(dropped.data.case.pl_buyouts, []);
  // Buy-out: the primary buyout is required and names the bank the loan is bought out from.
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'buy_out', secondary_buyout: 'no' })).status, 400);
  // The primary buyout must be the personal loan being bought out; a personal loan cannot be a secondary buyout.
  const noLoan = await dana('POST', '/cases', { ...pl, personal_loan_type: 'buy_out', secondary_buyout: 'no', pl_buyouts: [{ role: 'primary', kind: 'non_stl_loan', bank: 'RAKBANK', amount: 180000 }] });
  assert.equal(noLoan.status, 400);
  assert.match(noLoan.data.error, /personal loan/);
  assert.equal((await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'yes', pl_buyouts: [{ role: 'secondary', kind: 'personal_loan', bank: 'RAKBANK', amount: 1000 }] })).status, 400);
  const buy = await dana('POST', '/cases', { ...pl, personal_loan_type: 'buy_out', secondary_buyout: 'yes', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'RAKBANK', amount: 180000 }, { role: 'primary', kind: 'credit_card', bank: 'Mashreq', amount: 10000 }, { role: 'secondary', kind: 'auto_loan', bank: 'Emirates NBD', amount: 60000 }] });
  assert.equal(buy.status, 201, JSON.stringify(buy.data));
  assert.deepEqual([buy.data.case.buyout_bank, buy.data.case.product_label, buy.data.case.pl_buyouts.length], ['RAKBANK', 'Personal Loan (Buy Out from RAKBANK)', 3]);
  // A primary entry on a fresh loan is ignored; the bulk upload format reads into the same list.
  const stray = await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'no', pl_buyouts: [{ role: 'primary', kind: 'mortgage', bank: 'ADCB', amount: 1 }] });
  assert.deepEqual(stray.data.case.pl_buyouts, []);
});

test('the salary transfer bank is saved on the file', async () => {
  const dana = await login('dana@t.local');
  const r = await dana('POST', '/cases', { ...file('Salary bank'), salary_bank: 'Emirates NBD' });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal(r.data.case.salary_bank, 'Emirates NBD');
  assert.equal((await dana('PUT', `/cases/${r.data.case.id}`, { salary_bank: 'Some Other Bank' })).data.case.salary_bank, 'Some Other Bank');
});

test('reports list card deviations, promotions, approvals waiting and cards sold below eligibility', async () => {
  const dana = await login('dana@t.local');
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  const tl = await login('tl-auh@t.local');
  const card = (extra) => ({ customer_name: 'Report Card', region: 'DXB', phone: '+971 50 111 6666', city: 'Dubai', product: 'credit_card', core_product: 'credit_card', credit_card: 'Titanium Credit Card', card_fee_type: 'fyf', salary_bank: 'Mashreq', ...extra });
  // Titanium needs 5,000; a salary of 32,000 qualifies for higher cards, so this is sold below eligibility.
  const low = await dana('POST', '/cases', card({ salary: 32000 }));
  assert.equal(low.status, 201, JSON.stringify(low.data));
  assert.ok(low.data.case.card_higher_options > 0);
  assert.equal(low.data.case.card_eligible_category, 'Super Premium');
  // A deviation on an Infinite card.
  const dev = await dana('POST', '/cases', card({ credit_card: 'Skywards Infinite Credit Card', salary: 9000, card_salary_exception: 'deviation', card_exception_note: 'DEV-77' }));
  assert.equal(dev.status, 201, JSON.stringify(dev.data));
  assert.equal(dev.data.case.card_higher_options, 0);
  const exc = (await mis('GET', '/reports/card_exceptions')).data;
  const devRow = exc.rows.find((r) => r.ref === dev.data.case.ref);
  assert.deepEqual([devRow.reason, devRow.decided_by, devRow.note, devRow.card], ['Product deviation', 'Dana (sales)', 'DEV-77', 'Skywards Infinite Credit Card']);
  assert.ok(exc.rows.some((r) => r.reason === 'New promotion'));
  assert.ok(exc.rows.some((r) => r.reason === 'Awaiting approval') || exc.totals.reason.includes('awaiting'));
  assert.ok(!exc.rows.some((r) => r.ref === low.data.case.ref));
  const down = (await gov('GET', '/reports/card_downsell')).data;
  // The points the file lost against the best card the salary qualified for.
  const lowRowPts = down.rows.find((r) => r.ref === low.data.case.ref);
  assert.deepEqual([lowRowPts.points_sold, lowRowPts.points_eligible, lowRowPts.points_lost], [650, 1050, 400]);
  assert.ok(down.totals.points_lost >= 400);
  const lowRow = down.rows.find((r) => r.ref === low.data.case.ref);
  assert.deepEqual([lowRow.category, lowRow.eligible_category, lowRow.higher_options > 0], ['Mass', 'Super Premium', true]);
  assert.ok(!down.rows.some((r) => r.ref === dev.data.case.ref));
  // Team leaders see only their team; the sourcing and governance summaries carry the counts.
  const tlView = (await tl('GET', '/reports/card_exceptions')).data;
  assert.ok(tlView.rows.every((r) => r.team_leader === 'TL Abu Dhabi'));
  const srcRow = (await mis('GET', '/reports/sourcing')).data.rows.find((r) => r.staff === 'Dana' && r.team_leader === 'TL Abu Dhabi');
  assert.ok(srcRow.deviations >= 1 && srcRow.below_eligibility >= 1);
  const govRow = (await gov('GET', '/reports/governance')).data.rows.find((r) => r.region === 'DXB');
  assert.ok(govRow.deviations >= 1 && govRow.below_eligibility >= 1);
  assert.deepEqual((await mis('GET', '/reports')).data.reports.map((r) => r.key).filter((k) => k.startsWith('card_')), ['card_exceptions', 'card_downsell']);
});

test('payouts: what the bank pays per file, for the business head and DXB MIS only, in reports and on the dashboard', async () => {
  const dana = await login('dana@t.local');
  const tl = await login('tl-dxb@t.local');
  const mis = await login('mis@t.local');
  const misAuh = await login('mis-auh@t.local');
  const gov = await login('gov@t.local');
  const sm = await login('sm1@t.local');
  const proc = await login('proc-dxb@t.local');
  const card = (extra) => ({ customer_name: 'Payout Card', region: 'DXB', phone: '+971 50 111 7777', city: 'Dubai', product: 'credit_card', core_product: 'credit_card', credit_card: 'Titanium Credit Card', card_fee_type: 'fyf', salary: 32000, ...extra });
  const mass = (await dana('POST', '/cases', card({}))).data.case;
  assert.equal(mass.payout, undefined); // sales staff never see it
  const seen = (await mis('GET', `/cases/${mass.id}`)).data.case.payout;
  assert.equal(seen.total, 1400);
  // Nobody else: not team leaders, sales managers, governance, processors or MIS outside Dubai.
  for (const who of [tl, sm, gov, proc, misAuh]) { const r = await who('GET', `/cases/${mass.id}`); if (r.status === 200) assert.equal(r.data.case.payout, undefined); }
  assert.equal((await gov('GET', `/cases/${mass.id}`)).data.case.payout, undefined); // governance sees the file, not the payout
  assert.equal((await misAuh('GET', '/me')).data.meta.payout_rates, undefined);
  assert.equal((await misAuh('GET', '/stats')).data.revenue, undefined);
  assert.ok(!(await gov('GET', '/reports/card_downsell')).data.columns.some((c) => c.key.startsWith('payout')));
  assert.ok(!(await tl('GET', '/reports/sourcing')).data.columns.some((c) => c.key === 'revenue_aed'));
  const noon = (await dana('POST', '/cases', card({ credit_card: 'noon One Visa Credit Card' }))).data.case;
  assert.equal((await mis('GET', `/cases/${noon.id}`)).data.case.payout.total, 1100);
  const premium = (await dana('POST', '/cases', card({ credit_card: 'Skywards Signature Credit Card' }))).data.case;
  assert.equal((await mis('GET', `/cases/${premium.id}`)).data.case.payout.total, 2000);
  // Personal loans: 3% of the amount, 1.5% when buying out an Emirates Islamic loan.
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const pl = { customer_name: 'Payout Loan', region: 'DXB', phone: '+971 50 111 8888', city: 'Dubai', product: 'personal_loan', core_product: 'personal_loan', loan_amount: 100000, interest_rate: 6, pl_tenure: 48, fpd };
  const fresh = (await dana('POST', '/cases', { ...pl, personal_loan_type: 'fresh', secondary_buyout: 'no' })).data.case;
  assert.equal((await mis('GET', `/cases/${fresh.id}`)).data.case.payout.total, 3000);
  const eib = (await dana('POST', '/cases', { ...pl, personal_loan_type: 'buy_out', secondary_buyout: 'no', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Emirates Islamic', amount: 100000 }] })).data.case;
  assert.equal(eib.status !== undefined, true);
  const eibPay = (await mis('GET', `/cases/${eib.id}`)).data.case.payout;
  assert.equal(eibPay.total, 1500);
  assert.match(eibPay.parts[0].basis, /Emirates Islamic/);
  const other = (await dana('POST', '/cases', { ...pl, personal_loan_type: 'buy_out', secondary_buyout: 'no', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Mashreq', amount: 100000 }] })).data.case;
  assert.equal((await mis('GET', `/cases/${other.id}`)).data.case.payout.total, 3000);
  // Auto loans: 1.75% used, 0.70% new.
  const used = (await dana('POST', '/cases', file('Payout Used'))).data.case;
  assert.equal((await mis('GET', `/cases/${used.id}`)).data.case.payout.total, 875);
  const brandNew = (await dana('POST', '/cases', { ...file('Payout New'), auto_loan_type: 'new', car_year: 2026 })).data.case;
  assert.equal((await mis('GET', `/cases/${brandNew.id}`)).data.case.payout.total, 350);
  // Reports: the down-sell report prices the lost upgrade; the sourcing and register reports carry payout for managers only.
  const down = (await mis('GET', '/reports/card_downsell')).data;
  const row = down.rows.find((r) => r.ref === mass.ref);
  assert.deepEqual([row.payout_earned, row.payout_possible, row.payout_lost], [1400, 2600, 1200]);
  assert.ok(down.totals.payout_lost >= 1200);
  assert.ok((await mis('GET', '/reports/sourcing')).data.columns.some((c) => c.key === 'revenue_aed'));
  const ds = await dana('GET', '/reports/sourcing');
  assert.ok(ds.status !== 200 || !ds.data.columns.some((c) => c.key === 'revenue_aed'));
  assert.ok((await mis('GET', '/reports/register')).data.rows.some((r) => r.ref === mass.ref && r.payout_aed === 1400));
  const dd = await dana('GET', '/reports/card_downsell');
  assert.ok(dd.status !== 200 || !dd.data.columns.some((c) => c.key.startsWith('payout')));
  // Dashboard: revenue earned this cycle and in the pipeline, for managers and above.
  const stats = (await mis('GET', '/stats')).data;
  assert.ok(stats.revenue.pipeline_aed >= 1400 + 1100 + 2000 + 3000 + 1500 + 3000 + 875 + 350);
  assert.equal((await dana('GET', '/stats')).data.revenue, undefined);
  // DXB MIS can change a rate by upload; a team leader or AUH MIS cannot.
  assert.equal((await tl('POST', '/import/payout_rules', { csv: 'Rule,Value\ncard:Mass,1500\n' })).status, 403);
  assert.equal((await misAuh('POST', '/import/payout_rules', { csv: 'Rule,Value\ncard:Mass,1500\n' })).status, 403);
  const up = (await mis('POST', '/import/payout_rules', { csv: 'Rule,Value\ncard:Mass,1500\nMass card (AED per card),1500\nnonsense,1\n' })).data;
  assert.equal(up.ok, 2);
  assert.equal(up.failed, 1);
  assert.equal((await mis('GET', `/cases/${mass.id}`)).data.case.payout.total, 1500);
  assert.equal((await mis('GET', '/me')).data.meta.payout_rates['card:Mass'], 1500);
  assert.equal((await mis('POST', '/import/payout_rules', { csv: 'Rule,Value\ncard:Mass,1400\n' })).data.ok, 1);
  assert.equal((await mis('GET', `/cases/${mass.id}`)).data.case.payout.total, 1400);
});

test('staff master shapes from the real list: a manager leading a team, a team with no sales manager, targets by core product', async () => {
  const mis = await login('mis@t.local');
  const bh = await login('bh@t.local').catch(() => null);
  const admin = bh || mis;
  // Bulk upload: every role needs an HRMS code, nobody needs a mobile; a sales manager may lead a team directly; the sales manager column may be blank.
  const csv = [
    'Full name,HRMS code,Email,Role,Local mobile,WhatsApp number,Date of joining,Date of leaving,Region,Sales code,Team leader email,Sales manager email,Assistant sales manager email,Monthly salary (AED),Core product,Temporary password',
    'Praveen Lead,L7001,praveen.lead@t.local,Sales manager,,,,,AUH,,,,,,,',
    'Raji Lead,L7002,raji.lead@t.local,Team leader,,,,,DXB,,,,,,,',
    'Direct Report,7001,hrms7001@t.local,Sales,,,2025-01-15,,AUH,P-1,praveen.lead@t.local,praveen.lead@t.local,,5000,Credit Cards,',
    'No Manager,7002,hrms7002@t.local,Sales,,,2025-02-15,,DXB,R-1,raji.lead@t.local,,,4500,Auto Loans,',
    'Multi Seller,7003,hrms7003@t.local,Sales,,,2025-03-15,,DXB,R-2,raji.lead@t.local,,,6000,Multi product,',
    'No Code,,nocode@t.local,Sales,,,2025-03-15,,DXB,R-3,raji.lead@t.local,,,6000,Credit Cards,',
  ].join('\n');
  const up = (await admin('POST', '/import/users', { csv })).data;
  assert.equal(up.ok, 5, JSON.stringify(up.rows.filter((r) => !r.ok)));
  assert.equal(up.failed, 1);
  assert.match(up.rows[5].error, /HRMS code is required/);
  const users = (await admin('GET', '/users')).data.users;
  const direct = users.find((u) => u.sales_code === 'P-1');
  const praveen = users.find((u) => u.email === 'praveen.lead@t.local');
  assert.equal(direct.team_leader_id, praveen.id);
  assert.equal(direct.sales_manager_id, praveen.id);
  assert.equal(users.find((u) => u.sales_code === 'R-1').sales_manager_id, null);
  // The manager sees the file of the staff member they lead directly, through either field.
  const as = async (email, password) => {
    const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) });
    assert.equal(res.status, 200, email);
    const cookie = res.headers.get('set-cookie').split(';')[0];
    return async (method, path, body) => { const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) }); return { status: r.status, data: await r.json() }; };
  };
  const praveenLogin = await as('praveen.lead@t.local', up.rows[0].temp_password);
  const sold = (await (await as('7001', up.rows[2].temp_password))('POST', '/cases', { ...file('Direct customer'), region: 'AUH' })).data.case;
  assert.equal((await praveenLogin('GET', `/cases/${sold.id}`)).status, 200);
  // Targets follow the core product: one product per staff member, every product for multi-product staff.
  const bands = ['Product,Salary from (AED),Salary to (AED),Target', 'Credit Card,4000,4499,5850', 'Credit Card,4500,4999,6650', 'Credit Card,5000,5499,7450', 'Credit Card,6000,6499,9050',
    'Personal Loan,6000,6499,700000', 'Auto Loan,4500,4999,3200', 'Auto Loan,6000,6499,5600'].join('\n');
  assert.equal((await mis('POST', '/import/target_rules', { csv: bands })).data.failed, 0);
  const gen = (await mis('POST', '/targets/generate', { cycle: '2027-01' })).data;
  const t = (name) => gen.set.find((s) => s.name === name)?.targets;
  assert.deepEqual(t('Direct Report'), { credit_card: 7450 });
  assert.deepEqual(t('No Manager'), { auto_loan: 3200 });
  assert.deepEqual(t('Multi Seller'), { credit_card: 9050, personal_loan: 700000, auto_loan: 5600 });
});

test('credit card incentives: points beyond target at AED 1.25 with the premium mix or cross-sell, else AED 0.70', async () => {
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const mis = await login('mis@t.local');
  const misAuh = await login('mis-auh@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const ids = Object.fromEntries((await mis('GET', '/users')).data.users.map((u) => [u.email, u.id]));
  for (const email of ['dana@t.local', 'amal@t.local']) assert.equal((await mis('PATCH', `/users/${ids[email]}`, { core_product: 'credit_card' })).status, 200);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: ids['dana@t.local'], credit_card: 1000 }, { user_id: ids['amal@t.local'], credit_card: 100 }] })).status, 200);
  const complete = (id, extra = {}) => mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', ...extra });
  const card = (who, name, extra) => who('POST', '/cases', { customer_name: name, region: 'DXB', phone: '+971 50 111 9999', city: 'Dubai', product: 'credit_card', core_product: 'credit_card', credit_card: 'Titanium Credit Card', card_fee_type: 'fyf', salary: 32000, ...extra });
  // Dana: two Mass cards (650 each) and one Premium (800) = 2,100 points, 33.3% premium mix.
  for (const [name, extra] of [['Inc Mass 1', {}], ['Inc Mass 2', {}], ['Inc Premium', { credit_card: 'Skywards Signature Credit Card' }]]) {
    const c = (await card(dana, name, extra)).data.case; assert.equal((await complete(c.id)).status, 200, name);
  }
  // Plus a fresh loan of 100,000 (1,000 points) and an Emirates Islamic buy-out of 100,000 (counts 50,000 = 500 points).
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const pl = (extra) => dana('POST', '/cases', { customer_name: 'Inc Loan', region: 'DXB', phone: '+971 50 111 9998', city: 'Dubai', product: 'personal_loan', core_product: 'personal_loan', loan_amount: 100000, interest_rate: 6, pl_tenure: 48, fpd, secondary_buyout: 'no', ...extra });
  const fresh = (await pl({ personal_loan_type: 'fresh' })).data.case; assert.equal((await complete(fresh.id, { pl_disbursed_amount: 100000 })).status, 200);
  const eib = (await pl({ personal_loan_type: 'buy_out', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Emirates Islamic', amount: 100000 }] })).data.case;
  assert.equal((await complete(eib.id, { pl_disbursed_amount: 100000 })).status, 200);
  const mine = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.cards_sold, mine.premium_cards, mine.mix_pct, mine.card_points], [3, 1, 33.3, 2100]);
  assert.deepEqual([mine.pl_disbursed, mine.pl_counted, mine.eib_loans, mine.pl_points], [200000, 150000, 1, 1500]);
  assert.deepEqual([mine.total_points, mine.target, mine.excess_points, mine.criterion, mine.rate, mine.incentive_aed], [3600, 1000, 2600, 'mix', 1.25, 3250]);
  // Amal: one Mass card, no premium mix and no cross-sell: the lower rate.
  const a = (await card(amal, 'Inc Amal', { region: 'AUH' })).data.case; assert.equal((await complete(a.id)).status, 200);
  const his = (await amal('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([his.total_points, his.excess_points, his.criterion, his.rate, his.incentive_aed], [650, 550, 'none', 0.7, 385]);
  // The report: business head or DXB MIS only, per cycle.
  const rep = (await mis('GET', `/reports/incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.staff === 'Dana');
  assert.deepEqual([row.incentive_aed, row.criterion, row.rate], [3250, 'Premium mix', 'AED 1.25']);
  assert.equal(rep.rows.find((r) => r.staff === 'Amal').incentive_aed, 385);
  assert.ok(rep.totals.incentive_aed >= 3635);
  assert.equal((await mis('GET', `/reports/incentives?region=AUH&cycle=${cycle}`)).data.rows.some((r) => r.staff === 'Dana'), false);
  assert.equal((await mis('GET', '/reports/incentives?from=2026-01-01&to=2026-01-31')).status, 400);
  assert.equal((await misAuh('GET', `/reports/incentives?cycle=${cycle}`)).status, 404);
  assert.equal((await gov('GET', `/reports/incentives?cycle=${cycle}`)).status, 404);
  assert.ok(!(await misAuh('GET', '/reports')).data.reports.some((r) => r.key === 'incentives'));
  assert.equal((await gov('GET', `/incentives/me?cycle=${cycle}`)).status, 403);
});

test('personal loan incentives: a banded percentage of the cycle\'s production, Emirates Islamic buy-outs at half', async () => {
  const amal = await login('amal@t.local');
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const amalId = (await mis('GET', '/users')).data.users.find((u) => u.email === 'amal@t.local').id;
  assert.equal((await mis('PATCH', `/users/${amalId}`, { core_product: 'personal_loan' })).status, 200);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: amalId, personal_loan: 600000 }] })).status, 200);
  const complete = (id, extra = {}) => mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', ...extra });
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const pl = (name, extra) => amal('POST', '/cases', { customer_name: name, region: 'AUH', phone: '+971 50 111 9997', city: 'Abu Dhabi', product: 'personal_loan', core_product: 'personal_loan', loan_amount: 100000, interest_rate: 6, pl_tenure: 48, fpd, secondary_buyout: 'no', ...extra });
  // Below AED 600K nothing is paid.
  const first = (await pl('PL Inc 1', { personal_loan_type: 'fresh' })).data.case; assert.equal((await complete(first.id, { pl_disbursed_amount: 500000 })).status, 200);
  let mine = (await amal('GET', `/incentives/me?cycle=${cycle}`)).data;
  assert.equal(mine.type, 'personal_loan');
  // At 500,000 she is at the card threshold (target less 100,000): the Mass card she cross-sold earlier pays AED 500.
  assert.deepEqual([mine.incentive.pl_counted, mine.incentive.rate_pct, mine.incentive.core_aed, mine.incentive.cards_threshold, mine.incentive.cards_qualified, mine.incentive.cards.Mass, mine.incentive.cards_incentive_aed, mine.incentive.incentive_aed, mine.incentive.next_band.short_by], [500000, 0, 0, 500000, true, 1, 500, 500, 100000]);
  // A fresh 200,000 takes production to 700,000: 0.40% on the whole = 2,800.
  const second = (await pl('PL Inc 2', { personal_loan_type: 'fresh' })).data.case; assert.equal((await complete(second.id, { pl_disbursed_amount: 200000 })).status, 200);
  mine = (await amal('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.pl_counted, mine.band, mine.rate_pct, mine.core_aed, mine.incentive_aed, mine.achievement_pct], [700000, 'AED 600K to AED 750K', 0.4, 2800, 3300, 116.7]);
  // An Emirates Islamic buy-out of 600,000 counts 300,000: production 1,000,000 at 0.75% = 7,500.
  const eib = (await pl('PL Inc 3', { personal_loan_type: 'buy_out', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Emirates Islamic', amount: 600000 }] })).data.case;
  assert.equal((await complete(eib.id, { pl_disbursed_amount: 600000 })).status, 200);
  mine = (await amal('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.pl_disbursed, mine.pl_counted, mine.eib_loans, mine.band, mine.rate_pct, mine.core_aed, mine.incentive_aed], [1300000, 1000000, 1, 'AED 1M to AED 1.25M', 0.75, 7500, 8000]);
  // A top-up counts 70% of its incremental amount: 100,000 more on a 300,000 loan adds 70,000 (production 1,070,000, still 0.75% = 8,025).
  const topUp = (await pl('PL Inc 4', { personal_loan_type: 'top_up', full_loan_amount: 300000, incremental_amount: 100000 })).data.case;
  assert.equal((await complete(topUp.id, { pl_disbursed_amount: 300000 })).status, 200);
  mine = (await amal('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.top_ups, mine.pl_counted, mine.core_aed, mine.incentive_aed], [1, 1070000, 8025, 8525]);
  const rep = (await mis('GET', `/reports/pl_incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.staff === 'Amal');
  assert.deepEqual([row.core_aed, row.cards_incentive_aed, row.incentive_aed, row.rate, row.band, row.top_ups, row.mass_cards], [8025, 500, 8525, '0.75%', 'AED 1M to AED 1.25M', 1, 1]);
  assert.match(rep.note, /Mass AED 500/);
  assert.match(rep.note, /60% of target in the next sales cycle/);
  assert.equal((await gov('GET', `/reports/pl_incentives?cycle=${cycle}`)).status, 404);
});

test('auto loan incentives: points at the payout rate, excess over target, AED 1.10 or 0.60 a point by new and used disbursal', async () => {
  const dana = await login('dana@t.local');
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const danaId = (await mis('GET', '/users')).data.users.find((u) => u.email === 'dana@t.local').id;
  assert.equal((await mis('PATCH', `/users/${danaId}`, { core_product: 'auto_loan' })).status, 200);
  // The bank's worked example: threshold 2,000 points.
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: danaId, auto_loan: 2000 }] })).status, 200);
  const complete = (id, extra = {}) => mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', ...extra });
  // Earlier tests completed auto loans for Dana in this cycle: work from that baseline.
  const b = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  const mult = (fullAed) => (b.full_payout_aed + fullAed >= 250000 ? 1.1 : 0.6);
  const al = (name, extra) => dana('POST', '/cases', { ...file(name), ...extra });
  // Payout class defaults to full payout and is validated.
  assert.equal((await al('AL Bad', { al_payout_class: 'half' })).status, 400);
  // New car 200,000 at 0.80% = 1,600 points; below AED 250,000 of new and used disbursal the multiplier is 0.60.
  const brandNew = (await al('AL Inc 1', { auto_loan_type: 'new', car_year: 2026, amount: 200000 })).data.case;
  assert.equal(brandNew.al_payout_class, 'full');
  assert.equal((await complete(brandNew.id, { al_disbursed_amount: 200000 })).status, 200);
  let mine = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data;
  assert.equal(mine.type, 'auto_loan');
  assert.deepEqual([mine.incentive.points, mine.incentive.multiplier, mine.incentive.short_by], [b.points + 1600, mult(200000), Math.max(0, 250000 - b.full_payout_aed - 200000)]);
  assert.equal(mine.incentive.incentive_aed, Math.max(0, b.points + 1600 - 2000) * mult(200000));
  // Used car 300,000 = 2,400 points: 4,000 points, 2,000 excess, new + used now 500,000 so AED 1.10 a point.
  const used = (await al('AL Inc 2', { amount: 300000 })).data.case;
  assert.equal((await complete(used.id, { al_disbursed_amount: 300000 })).status, 200);
  mine = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.points, mine.excess_points, mine.full_payout_met, mine.multiplier, mine.incentive_aed], [b.points + 4000, b.points + 2000, true, 1.1, (b.points + 2000) * 1.1]);
  // An algo loan of 100,000 earns 250 points but does not count towards the 250,000: 2,250 excess × 1.10 = AED 2,475 (the bank's example).
  const algo = (await al('AL Inc 3', { amount: 100000 })).data.case;
  assert.equal((await complete(algo.id, { al_disbursed_amount: 100000, al_payout_class: 'algo' })).status, 200);
  mine = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.algo_loans - b.algo_loans, mine.algo_aed - b.algo_aed, mine.full_payout_aed - b.full_payout_aed, mine.points - b.points, mine.excess_points - b.points, mine.incentive_aed], [1, 100000, 500000, 4250, 2250, Math.round((b.points + 2250) * 110) / 100]);
  // A low-payout non-algo loan earns nothing; the class can be set when the file is sourced and shows on the file.
  const low = (await al('AL Inc 4', { amount: 80000, al_payout_class: 'low' })).data.case;
  assert.equal(low.al_payout_class, 'low');
  assert.equal((await complete(low.id, { al_disbursed_amount: 80000 })).status, 200);
  mine = (await dana('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.deepEqual([mine.low_loans - b.low_loans, mine.loans - b.loans, mine.disbursed - b.disbursed, mine.points - b.points, mine.incentive_aed, mine.achievement_pct], [1, 4, 680000, 4250, Math.round((b.points + 2250) * 110) / 100, Math.round(((b.points + 4250) / 2000) * 1000) / 10]);
  // The same points count as target achievement.
  const targets = (await dana('GET', `/targets?cycle=${cycle}`)).data;
  console.error('TARGETS', JSON.stringify(targets).slice(0, 1500), b.points);
  // The report: business head or DXB MIS only, per cycle.
  const rep = (await mis('GET', `/reports/al_incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.staff === 'Dana');
  assert.deepEqual([row.target, row.points, row.excess_points, row.full_payout_met, row.multiplier, row.incentive_aed], [2000, b.points + 4250, b.points + 2250, 'Yes', 'AED 1.10', Math.round((b.points + 2250) * 110) / 100]);
  assert.match(rep.note, /60% of target in the next sales cycle/);
  assert.equal((await gov('GET', `/reports/al_incentives?cycle=${cycle}`)).status, 404);
  assert.equal((await mis('GET', '/reports/al_incentives?from=2026-01-01&to=2026-01-31')).status, 400);
});

test('credit card team leader incentives: team card points beyond 75% of combined targets, AED 0.30 or 0.20, plus 0.15% of PL cross-sell', async () => {
  const mis = await login('mis@t.local');
  const tl = await login('tl-dxb@t.local');
  const tlAuh = await login('tl-auh@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const danaId = (await mis('GET', '/users')).data.users.find((u) => u.email === 'dana@t.local').id;
  // Dana back on cards (the card incentive test gave her 2,100 card points, 1 of 3 Premium, AED 200,000 of personal loans).
  const tlId = (await mis('GET', '/users')).data.users.find((u) => u.email === 'tl-dxb@t.local').id;
  assert.equal((await mis('PATCH', `/users/${danaId}`, { core_product: 'credit_card', team_leader_id: tlId })).status, 200);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: danaId, credit_card: 1000 }] })).status, 200);
  const mine = (await tl('GET', `/incentives/me?cycle=${cycle}`)).data;
  assert.equal(mine.type, 'team_leader');
  assert.deepEqual(mine.teams.map((t) => t.type), ['cc_team_leader']);
  const i = mine.teams[0].incentive;
  assert.deepEqual([i.team_size, i.combined_target, i.threshold, i.points, i.excess_points, i.mix_pct, i.criterion, i.rate], [1, 1000, 750, 2100, 1350, 33.3, 'mix', 0.3]);
  assert.deepEqual([i.core_aed, i.cross_sell_aed, i.cross_sell_incentive_aed, i.incentive_aed], [405, 200000, 300, 705]);
  // The bank's example: 100,000 combined targets, 95,000 points, 20,000 excess at AED 0.30 = 6,000.
  assert.equal(Math.max(0, 95000 - (100000 * mine.tl_rules.threshold_share) / 100) * mine.tl_rules.rate_high, 6000);
  // A leader with no core card staff has nothing to show; the report lists leaders of core card staff only.
  const amalId = (await mis('GET', '/users')).data.users.find((u) => u.email === 'amal@t.local').id;
  assert.equal((await mis('PATCH', `/users/${amalId}`, { core_product: 'personal_loan' })).status, 200);
  assert.equal((await tlAuh('GET', `/incentives/me?cycle=${cycle}`)).data.teams.some((t) => t.type === 'cc_team_leader'), false);
  const rep = (await mis('GET', `/reports/tl_incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.leader === 'TL Dubai');
  assert.deepEqual([row.threshold, row.excess_points, row.criterion, row.rate, row.core_aed, row.cross_sell_incentive_aed, row.incentive_aed], [750, 1350, 'Premium mix', 'AED 0.30', 405, 300, 705]);
  assert.equal(rep.rows.some((r) => r.leader === 'TL Abu Dhabi'), false);
  assert.match(rep.note, /60% of target in the next sales cycle/);
  assert.equal((await gov('GET', `/reports/tl_incentives?cycle=${cycle}`)).status, 404);
  assert.equal((await gov('GET', `/incentives/me?cycle=${cycle}`)).status, 403);
});

test('personal loan team leader incentives: banded percentage of the team\'s whole production, cards cross-sold paid from 80%', async () => {
  const mis = await login('mis@t.local');
  const tlAuh = await login('tl-auh@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const users = (await mis('GET', '/users')).data.users;
  const amalId = users.find((u) => u.email === 'amal@t.local').id;
  const tlId = users.find((u) => u.email === 'tl-auh@t.local').id;
  // Amal: core personal loans, target 600,000, counted production 1,070,000 (178.3%) and one Mass card from the earlier tests.
  assert.equal((await mis('PATCH', `/users/${amalId}`, { core_product: 'personal_loan', team_leader_id: tlId })).status, 200);
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: amalId, personal_loan: 600000 }] })).status, 200);
  const mine = (await tlAuh('GET', `/incentives/me?cycle=${cycle}`)).data;
  const team = mine.teams.find((t) => t.type === 'pl_team_leader');
  assert.ok(team);
  const i = team.incentive;
  assert.deepEqual([i.team_size, i.combined_target, i.pl_counted, i.achievement_pct, i.band, i.rate_pct, i.core_aed], [1, 600000, 1070000, 178.3, '150% and above', 0.25, 2675]);
  assert.deepEqual([i.cards.Mass, i.cards_aed, i.qualified, i.cards_incentive_aed, i.incentive_aed], [1, 20, true, 20, 2695]);
  // Below 80% nothing is paid, cards included.
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: amalId, personal_loan: 2000000 }] })).status, 200);
  const low = (await tlAuh('GET', `/incentives/me?cycle=${cycle}`)).data.teams.find((t) => t.type === 'pl_team_leader').incentive;
  assert.deepEqual([low.achievement_pct, low.rate_pct, low.core_aed, low.qualified, low.cards_incentive_aed, low.incentive_aed], [53.5, 0, 0, false, 0, 0]);
  // 80% to 99.99% pays 0.05% on the whole production.
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: amalId, personal_loan: 1200000 }] })).status, 200);
  const mid = (await tlAuh('GET', `/incentives/me?cycle=${cycle}`)).data.teams.find((t) => t.type === 'pl_team_leader').incentive;
  assert.deepEqual([mid.achievement_pct, mid.rate_pct, mid.core_aed, mid.cards_incentive_aed, mid.incentive_aed], [89.2, 0.05, 535, 20, 555]);
  const rep = (await mis('GET', `/reports/pl_tl_incentives?cycle=${cycle}`)).data;
  const row = rep.rows.find((r) => r.leader === 'TL Abu Dhabi');
  assert.deepEqual([row.achievement_pct, row.rate, row.core_aed, row.mass_cards, row.qualified, row.incentive_aed], [89.2, '0.05%', 535, 1, 'Yes', 555]);
  assert.match(rep.note, /60% of target in the next sales cycle/);
  assert.equal((await gov('GET', `/reports/pl_tl_incentives?cycle=${cycle}`)).status, 404);
});

test('sales manager incentives: per-card slabs for card managers, a banded percentage of loan production for managers with loan staff', async () => {
  const mis = await login('mis@t.local');
  const sm1 = await login('sm1@t.local');
  const asm = await login('asm1@t.local');
  const sm2 = await login('sm2@t.local');
  const gov = await login('gov@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  // Dana (cards, target 1,000, 2,100 points, 3 cards) reports to SM One and ASM One: 210% of target, AED 50 a card.
  const users = (await mis('GET', '/users')).data.users;
  const id = (email) => users.find((u) => u.email === email).id;
  assert.equal((await mis('PATCH', `/users/${id('dana@t.local')}`, { core_product: 'credit_card', team_leader_id: id('tl-dxb@t.local'), sales_manager_id: id('sm1@t.local'), asm_id: id('asm1@t.local') })).status, 200);
  assert.equal((await mis('PATCH', `/users/${id('amal@t.local')}`, { core_product: 'personal_loan', team_leader_id: id('tl-auh@t.local'), sales_manager_id: id('sm2@t.local') })).status, 200);
  const mine = (await sm1('GET', `/incentives/me?cycle=${cycle}`)).data;
  const cc = mine.teams.find((t) => t.type === 'cc_sales_manager');
  assert.deepEqual([cc.incentive.team_size, cc.incentive.combined_target, cc.incentive.points, cc.incentive.achievement_pct, cc.incentive.slab, cc.incentive.cards_sold, cc.incentive.aed_per_card, cc.incentive.incentive_aed], [1, 1000, 2100, 210, '150% and above', 3, 50, 150]);
  assert.equal((await asm('GET', `/incentives/me?cycle=${cycle}`)).data.teams.find((t) => t.type === 'cc_sales_manager').incentive.incentive_aed, 150);
  // The bank's example: 120% achievement with 500 cards pays AED 35 each.
  assert.equal(500 * mine.cc_sm_slabs.find((s) => s.label === '110% to 124.99%').aed, 17500);
  // SM One has no core loan staff: no loan block, and Dana's AED 200,000 of cross-sold loans has no target to count against.
  assert.equal(mine.teams.some((t) => t.type === 'pl_sales_manager'), false);
  // SM Two manages Amal (core loans, target 1,200,000, production 1,070,000 = 89.2%): 0.02% of the whole production.
  const pl = (await sm2('GET', `/incentives/me?cycle=${cycle}`)).data.teams.find((t) => t.type === 'pl_sales_manager').incentive;
  assert.deepEqual([pl.core_staff, pl.combined_target, pl.core_counted, pl.cross_sell_counted, pl.achievement_pct, pl.band, pl.rate_pct, pl.incentive_aed], [1, 1200000, 1070000, 0, 89.2, '80% to 99.99%', 0.02, 214]);
  const rep = (await mis('GET', `/reports/sm_incentives?cycle=${cycle}`)).data;
  assert.deepEqual(rep.rows.filter((r) => ['SM One', 'ASM One'].includes(r.manager)).map((r) => [r.role, r.slab, r.incentive_aed]), [['asm', '150% and above', 150], ['sales_manager', '150% and above', 150]]);
  const plRep = (await mis('GET', `/reports/pl_sm_incentives?cycle=${cycle}`)).data;
  assert.deepEqual([plRep.rows.find((r) => r.manager === 'SM Two').rate, plRep.rows.find((r) => r.manager === 'SM Two').incentive_aed, plRep.rows.some((r) => r.manager === 'SM One')], ['0.0200%', 214, false]);
  assert.equal((await gov('GET', `/reports/sm_incentives?cycle=${cycle}`)).status, 404);
  // Cards cross-sold by loan staff in the team are added to the card manager's numbers: Amal's Mass card (650 points) under SM One.
  assert.equal((await mis('PATCH', `/users/${id('amal@t.local')}`, { core_product: 'personal_loan', team_leader_id: id('tl-auh@t.local'), sales_manager_id: id('sm1@t.local') })).status, 200);
  const x = (await sm1('GET', `/incentives/me?cycle=${cycle}`)).data.teams.find((t) => t.type === 'cc_sales_manager').incentive;
  assert.deepEqual([x.team_size, x.cards_sold, x.cross_sell_cards, x.points, x.achievement_pct, x.incentive_aed], [1, 4, 1, 2750, 275, 200]);
});
