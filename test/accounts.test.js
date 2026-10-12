// The accounts role: sees the incentive calculations for a cycle and downloads the payout file, nothing
// else. A business head's salary is seen only by the CEO, accounts, or that business head. Customer phone
// numbers never go into a downloaded file.
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
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB', hrms_code: 'EN1' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB', hrms_code: 'EN5' });
  add('Sally', 'sally@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000, hrms_code: 'EN6' });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Bina', 'head2@t.local', 'business_head', { region: 'AUH', hrms_code: 'EN7' });
  add('Yusuf', 'ceo@t.local', 'ceo', { region: 'DXB', hrms_code: 'EN4' });
  add('Asha', 'accounts@t.local', 'accounts', { region: 'DXB', hrms_code: 'EN8' });
  add('Amir', 'biker@t.local', 'staff', { region: 'DXB', hrms_code: 'EN9', salary: 3500 });
  db.prepare('UPDATE users SET salary = ? WHERE id = ?').run(45000, ids['head@t.local']);
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: await r.json() };
  };
  call.text = async (path) => { const r = await fetch(`${base}/api${path}`, { headers: { cookie } }); return { status: r.status, text: await r.text(), disposition: r.headers.get('content-disposition') }; };
  return call;
}

test('accounts sees the incentive reports and the payout file for a cycle, and nothing else', async () => {
  const acc = await login('accounts@t.local'); const mis = await login('mis@t.local'); const sally = await login('sally@t.local');
  const me = (await acc('GET', '/me')).data;
  assert.equal(me.user.role, 'accounts');
  assert.deepEqual(me.meta.perms.pages, ['reports']);
  const keys = me.meta.reports.map((r) => r.key).sort();
  assert.deepEqual(keys, ['al_incentives', 'incentive_payout', 'incentives', 'pl_incentives', 'pl_sm_incentives', 'pl_tl_incentives', 'sm_incentives', 'tl_incentives']);
  const cycle = me.meta.current_cycle;
  assert.equal((await acc('GET', '/cases')).status, 403);
  assert.equal((await acc('GET', '/users')).status, 403);
  assert.equal((await acc('GET', `/pnl?cycle=${cycle}`)).status, 403);
  assert.equal((await acc('GET', `/reports/register?cycle=${cycle}`)).status, 404, 'no file-level reports');

  // Sally sells three cards past her target: an incentive and the bonus to pay.
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  for (let i = 0; i < 3; i++) {
    const r = await sally('POST', '/cases', { region: 'DXB', phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Card Customer', core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', fpd });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    assert.equal((await mis('POST', `/cases/${r.data.case.id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200);
  }
  // Three cards' points; the target is set at one and a half cards, so half the points are excess.
  const p = (await sally('GET', `/incentives/me?cycle=${cycle}`)).data.incentive.card_points;
  assert.equal((await mis('PUT', '/targets', { cycle, targets: [{ user_id: ids['sally@t.local'], credit_card: Math.round(p / 2) }] })).status, 200);
  const mine = (await sally('GET', `/incentives/me?cycle=${cycle}`)).data.incentive;
  assert.ok(mine.incentive_aed > 0, JSON.stringify(mine));
  assert.equal(mine.incentive_aed, Math.round(p / 2) * mine.rate);

  const rep = (await acc('GET', `/reports/incentives?cycle=${cycle}`)).data;
  assert.equal(rep.rows.find((r) => r.staff === 'Sally').incentive_aed, mine.incentive_aed, 'the same calculation the business head sees');
  assert.equal(rep.rows.find((r) => r.staff === 'Sally').hrms_code, 'EN6', 'the sheet carries the HRMS code');
  assert.ok(rep.columns.some((c) => c.key === 'hrms_code'));
  const pay = (await acc('GET', `/reports/incentive_payout?cycle=${cycle}`)).data;
  // Sally's own incentive, her team leader's and her sales manager's on the team's cards: one line each, every scheme added up.
  const tl = (await acc('GET', `/reports/tl_incentives?cycle=${cycle}`)).data.rows.find((r) => r.leader === 'TL Dubai');
  const sm = (await acc('GET', `/reports/sm_incentives?cycle=${cycle}`)).data.rows.find((r) => r.manager === 'SM One');
  assert.ok(tl.incentive_aed > 0 && sm.incentive_aed > 0);
  assert.deepEqual(pay.rows.map((r) => [r.hrms_code, r.name, r.role, r.card_aed, r.leader_aed, r.manager_aed, r.total_aed, r.schemes]), [
    ['EN6', 'Sally', 'sales', mine.incentive_aed, 0, 0, mine.incentive_aed, 'Credit card'],
    ['EN5', 'TL Dubai', 'team_leader', 0, tl.incentive_aed, 0, tl.incentive_aed, 'Credit card team leader'],
    ['EN1', 'SM One', 'sales_manager', 0, 0, sm.incentive_aed, sm.incentive_aed, 'Credit card sales manager'],
  ]);
  assert.equal(pay.totals.total_aed, Math.round((mine.incentive_aed + tl.incentive_aed + sm.incentive_aed) * 100) / 100);
  assert.equal(pay.totals.hrms_code, '3 people');
  assert.equal((await acc('GET', '/reports/incentive_payout?from=2026-10-01&to=2026-10-31')).status, 400, 'a cycle, not dates');
  // The file itself.
  const csv = await acc.text(`/reports/incentive_payout?cycle=${cycle}&format=csv`);
  assert.equal(csv.status, 200);
  assert.match(csv.disposition, /attachment; filename="incentive_payout-/);
  assert.match(csv.text, /^HRMS code,Name,Role,Sales code,Region,Cycle,Credit card \(AED\),/);
  assert.match(csv.text, new RegExp(`\r\nEN6,Sally,sales,D-1,DXB,${cycle},${mine.incentive_aed},`));
  // The business head and MIS run the same file.
  assert.equal((await mis('GET', `/reports/incentive_payout?cycle=${cycle}`)).data.rows.length, 3);
});

test('customer phone numbers never go into a downloaded file', async () => {
  const mis = await login('mis@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const reg = (await mis('GET', `/reports/register?cycle=${cycle}`)).data;
  assert.ok(reg.columns.some((c) => c.key === 'phone'), 'the phone shows on screen, masked');
  assert.ok(reg.rows.length > 0);
  const csv = await mis.text(`/reports/register?cycle=${cycle}&format=csv`);
  assert.equal(csv.status, 200);
  const header = csv.text.split('\r\n')[0];
  assert.ok(!/phone/i.test(header), header);
  assert.ok(!/4444|333/.test(csv.text), 'no part of the number in any row');
  assert.match(header, /Customer,City/);
});

test("a business head's salary is seen only by the CEO, accounts, or that business head", async () => {
  const mis = await login('mis@t.local'); const bilal = await login('head@t.local'); const bina = await login('head2@t.local'); const ceo = await login('ceo@t.local');
  const id = ids['head@t.local'];
  const row = (list) => list.data.users.find((u) => u.id === id);
  const viaMis = row(await mis('GET', '/users'));
  assert.deepEqual([viaMis.salary, viaMis.salary_hidden], [null, true]);
  const viaBina = row(await bina('GET', '/users'));
  assert.deepEqual([viaBina.salary, viaBina.salary_hidden], [null, true], 'another business head cannot see it');
  assert.equal(row(await bilal('GET', '/users')).salary, 45000, 'the business head sees their own');
  assert.equal(row(await mis('GET', '/users')).salary_hidden, true);
  assert.equal((await bilal('GET', '/me')).data.user.salary, 45000);
  // Setting it follows the same rule; everyone else's salary is open to MIS as before.
  assert.equal((await mis('PATCH', `/users/${id}`, { salary: 50000 })).status, 403);
  assert.equal((await bina('PATCH', `/users/${id}`, { salary: 50000 })).status, 403);
  assert.equal((await bilal('PATCH', `/users/${id}`, { salary: 46000 })).status, 200);
  assert.equal(row(await bilal('GET', '/users')).salary, 46000);
  assert.equal((await mis('PATCH', `/users/${ids['sm@t.local']}`, { salary: 30000 })).status, 200, 'a manager salary is set by MIS');
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.id === ids['sm@t.local']).salary, 30000);
  // The CEO's profit and loss carries the business heads line; another business head sees it folded into support.
  const cycle = (await ceo('GET', '/me')).data.meta.current_cycle;
  const ceoRows = (await ceo('GET', `/pnl?cycle=${cycle}`)).data.pnl.rows;
  assert.equal(ceoRows.find((l) => l.role === 'business_head').salary, 46000);
  const binaRows = (await bina('GET', `/pnl?cycle=${cycle}`)).data.pnl.rows;
  assert.ok(!binaRows.some((l) => l.role === 'business_head'));
  assert.equal(binaRows.find((l) => l.role === 'support').salary, 46000 + 3500, 'folded with processing, MIS, governance, IT and other staff (the biker)');
  const repRows = (await bina('GET', `/reports/pnl?cycle=${cycle}`)).data.rows;
  assert.ok(!repRows.some((l) => /^Business heads$/.test(l.label || l.line || '')), JSON.stringify(repRows[0]));
});

test('the incentive sheets are split by region and hierarchy, with card types counted before the points', async () => {
  const mis = await login('mis@t.local');
  const cycle = (await mis('GET', '/me')).data.meta.current_cycle;
  const rep = (await mis('GET', `/reports/incentives?cycle=${cycle}`)).data;
  const keys = rep.columns.map((c) => c.key);
  // Card types sit between the cards sold and the points.
  assert.ok(keys.indexOf('mass_cards') > keys.indexOf('cards_sold') && keys.indexOf('super_premium_cards') < keys.indexOf('card_points'));
  const sally = rep.rows.find((r) => r.staff === 'Sally');
  assert.deepEqual([sally.cards_sold, sally.mass_cards + sally.premium_only_cards + sally.super_premium_cards + sally.noon_cards + sally.other_cards], [3, 3]);
  assert.equal(sally.premium_only_cards + sally.super_premium_cards, sally.premium_cards, 'the premium-or-above count is the two premium types');
  // One person, so one team leader, one sales manager and one region subtotal, in that order after her row.
  assert.deepEqual(rep.rows.map((r) => r._group || 'row'), ['row', 'team_leader', 'sales_manager', 'region']);
  const tl = rep.rows[1]; const reg = rep.rows[3];
  assert.match(tl.staff, /^Team leader total · TL Dubai \(1\)/);
  assert.match(reg.staff, /^Region total · DXB \(1\)/);
  assert.deepEqual([tl.cards_sold, tl.incentive_aed, reg.incentive_aed, tl.criterion, tl.mix_pct], [3, sally.incentive_aed, sally.incentive_aed, undefined, undefined]);
  assert.equal(rep.totals.staff, '1 staff', 'the grand total counts people, not subtotal lines');
  assert.equal(rep.totals.mass_cards + rep.totals.premium_only_cards + rep.totals.super_premium_cards + rep.totals.noon_cards + rep.totals.other_cards, 3);
  // The team leader and manager sheets carry the same type counts and their own subtotals.
  const tls = (await mis('GET', `/reports/tl_incentives?cycle=${cycle}`)).data;
  assert.deepEqual(tls.rows.map((r) => r._group || 'row'), ['row', 'sales_manager', 'region']);
  assert.equal(tls.rows[0].mass_cards + tls.rows[0].premium_only_cards + tls.rows[0].super_premium_cards + tls.rows[0].noon_cards + tls.rows[0].other_cards, 3);
  const sms = (await mis('GET', `/reports/sm_incentives?cycle=${cycle}`)).data;
  assert.deepEqual(sms.rows.map((r) => r._group || 'row'), ['row', 'region']);
  assert.ok(sms.columns.map((c) => c.key).indexOf('super_premium_cards') < sms.columns.map((c) => c.key).indexOf('points'));
  // The CSV carries the subtotal lines too.
  const csv = await mis.text(`/reports/incentives?cycle=${cycle}&format=csv`);
  assert.match(csv.text, /\r\nTeam leader total · TL Dubai \(1\),/);
});

test('staff with no access are on the books for the profit and loss but cannot sign in', async () => {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'biker@t.local', password: PASSWORD }) });
  assert.equal(res.status, 403);
  assert.match((await res.json()).error, /no CRM access/);
  const ceo = await login('ceo@t.local');
  const cycle = (await ceo('GET', '/me')).data.meta.current_cycle;
  const rows = (await ceo('GET', `/pnl?cycle=${cycle}`)).data.pnl.rows;
  assert.equal(rows.find((l) => l.role === 'staff').salary, 3500, 'the biker counts in the profit and loss');
  assert.equal((await ceo('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.pnl.rows.find((l) => l.role === 'staff'), undefined, 'in his own region only');
  const mis = await login('mis@t.local');
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.email === 'biker@t.local').role, 'staff');
});

test('a role that needs a hierarchy carries it: a team leader reports to a sales manager, set on the staff page or with the role change', async () => {
  const mis = await login('mis@t.local');
  const tl = ids['tl@t.local']; const sm = ids['sm@t.local'];
  // The team leader's reporting line, edited on its own.
  assert.equal((await mis('PATCH', `/users/${tl}`, { sales_manager_id: sm })).status, 200);
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.id === tl).sales_manager_id, sm);
  assert.equal((await mis('PATCH', `/users/${tl}`, { sales_manager_id: tl })).status, 400, 'not to themselves');
  assert.equal((await mis('PATCH', `/users/${tl}`, { sales_manager_id: ids['mis@t.local'] })).status, 400, 'only an active sales manager');
  assert.equal((await mis('PATCH', `/users/${tl}`, { sales_manager_id: '' })).status, 200);
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.id === tl).sales_manager_id, null);
  // Changing the biker to a team leader asks for, and keeps, the line in the same save.
  const biker = ids['biker@t.local'];
  assert.equal((await mis('PATCH', `/users/${biker}`, { role: 'team_leader', sales_manager_id: sm })).status, 200);
  const b = (await mis('GET', '/users')).data.users.find((u) => u.id === biker);
  assert.deepEqual([b.role, b.sales_manager_id], ['team_leader', sm]);
  // Back to a role with no hierarchy: the line is cleared.
  assert.equal((await mis('PATCH', `/users/${biker}`, { role: 'staff' })).status, 200);
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.id === biker).sales_manager_id, null);
  // A new team leader can be created with their manager.
  const r = await mis('POST', '/users', { name: 'TL New', email: 'tlnew@t.local', role: 'team_leader', password: PASSWORD, region: 'DXB', hrms_code: 'EN20', mobile_number: '0501234567', sales_manager_id: sm });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  assert.equal((await mis('GET', '/users')).data.users.find((u) => u.email === 'tlnew@t.local').sales_manager_id, sm);
});

test('anyone changes their own password with the current one; other sessions of theirs end', async () => {
  const first = await login('sm@t.local'); const second = await login('sm@t.local');
  assert.equal((await first('POST', '/password', { current: 'wrong', password: 'newpassword1' })).status, 400);
  assert.equal((await first('POST', '/password', { current: PASSWORD, password: 'short' })).status, 400);
  assert.equal((await first('POST', '/password', { current: PASSWORD, password: 'newpassword1' })).status, 200);
  assert.equal((await second('GET', '/me')).status, 401, 'the other session is signed out');
  assert.equal((await first('GET', '/me')).status, 200, 'this one stays');
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sm@t.local', password: 'newpassword1' }) });
  assert.equal(res.status, 200);
  assert.equal((await first('POST', '/password', { current: 'newpassword1', password: PASSWORD })).status, 200);
});

test('my profile: the numbers can be changed by the person themselves, nothing else', async () => {
  const sm = await login('sm@t.local');
  const me = (await sm('GET', '/me')).data.user;
  assert.equal(me.email, 'sm@t.local');
  const r = await sm('PATCH', '/me', { mobile_number: '0501112233', whatsapp_number: '+971501112233' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  assert.deepEqual([r.data.user.mobile_number, r.data.user.whatsapp_number], ['0501112233', '+971501112233']);
  assert.equal((await sm('PATCH', '/me', { role: 'business_head' })).status, 400, 'only the numbers');
  assert.equal((await sm('PATCH', '/me', { mobile_number: '12345' })).status, 400, 'a UAE mobile number or blank');
  assert.equal((await sm('GET', '/me')).data.user.role, 'sales_manager');
});
