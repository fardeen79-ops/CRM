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
  assert.equal(binaRows.find((l) => l.role === 'support').salary, 46000, 'folded with processing, MIS, governance and IT');
  const repRows = (await bina('GET', `/reports/pnl?cycle=${cycle}`)).data.rows;
  assert.ok(!repRows.some((l) => /^Business heads$/.test(l.label || l.line || '')), JSON.stringify(repRows[0]));
});
