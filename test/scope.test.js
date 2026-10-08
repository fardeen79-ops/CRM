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
  add('Mira', 'mis@t.local', 'mis');
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
const file = (name, region = 'DXB') => ({ customer_name: name, region, phone: '+971 50 111 2222', city: 'Dubai', product: 'auto_loan', amount: 50000, core_product: 'auto_loan' });
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
