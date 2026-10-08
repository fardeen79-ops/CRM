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

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
}
const file = (name) => ({ customer_name: name, phone: '+971 50 111 2222', city: 'Dubai', product: 'auto_loan', amount: 50000, core_product: 'auto_loan' });
const names = (list) => list.map((c) => c.customer_name).sort();

test('a sales person\'s files default to their own region', async () => {
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const d = await dana('POST', '/cases', file('Dubai customer'));
  assert.equal(d.status, 201, JSON.stringify(d.data));
  assert.equal(d.data.case.region, 'DXB');
  const a = await amal('POST', '/cases', file('Abu Dhabi customer'));
  assert.equal(a.data.region ?? a.data.case.region, 'AUH');
  // An explicit region still wins.
  const x = await amal('POST', '/cases', { ...file('Abu Dhabi staff, Dubai customer'), region: 'DXB' });
  assert.equal(x.data.case.region, 'DXB');
  ids.dubaiCase = d.data.case.id;
  ids.auhCase = a.data.case.id;
});

test('processors with a region see only that region\'s files; one without sees all', async () => {
  const dxb = await login('proc-dxb@t.local');
  const auh = await login('proc-auh@t.local');
  const all = await login('proc-all@t.local');
  assert.deepEqual(names((await dxb('GET', '/cases')).data.cases), ['Abu Dhabi staff, Dubai customer', 'Dubai customer']);
  assert.deepEqual(names((await auh('GET', '/cases')).data.cases), ['Abu Dhabi customer']);
  assert.equal((await all('GET', '/cases')).data.cases.length, 3);
  // Direct access, the dashboard and the case discussion follow the same rule.
  assert.equal((await auh('GET', `/cases/${ids.dubaiCase}`)).status, 404);
  assert.equal((await auh('POST', `/cases/${ids.dubaiCase}/assign`, {})).status, 404);
  assert.equal((await auh('GET', `/cases/${ids.dubaiCase}/messages`)).status, 404);
  assert.equal((await dxb('GET', `/cases/${ids.dubaiCase}`)).status, 200);
  assert.equal((await auh('GET', '/stats')).data.total, 1);
  assert.equal((await dxb('GET', '/stats')).data.total, 2);
});

test('team leaders, sales managers and assistant sales managers see only their teams', async () => {
  const tlD = await login('tl-dxb@t.local');
  const tlA = await login('tl-auh@t.local');
  const sm1 = await login('sm1@t.local');
  const sm2 = await login('sm2@t.local');
  const asm = await login('asm1@t.local');
  assert.deepEqual(names((await tlD('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.deepEqual(names((await tlA('GET', '/cases')).data.cases), ['Abu Dhabi customer', 'Abu Dhabi staff, Dubai customer']);
  assert.deepEqual(names((await sm1('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.deepEqual(names((await asm('GET', '/cases')).data.cases), ['Dubai customer']);
  assert.equal((await sm2('GET', '/cases')).data.cases.length, 2);
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
  assert.equal((await mis('GET', '/cases')).data.cases.length, 4);
  assert.equal((await gov('GET', '/cases')).data.cases.length, 4);
  const tl = await login('tl-dxb@t.local');
  const proc = ids['proc-all@t.local'];
  assert.equal((await tl('PATCH', `/users/${proc}`, { region: 'SHJ' })).status, 400);
  assert.equal((await tl('PATCH', `/users/${proc}`, { region: 'auh' })).data.user.region, 'AUH');
  const nowAuh = await login('proc-all@t.local');
  assert.equal((await nowAuh('GET', '/cases')).data.cases.length, 1);
  const users = (await tl('GET', '/users')).data.users;
  assert.equal(users.find((u) => u.email === 'dana@t.local').asm_name, 'ASM One');
});
