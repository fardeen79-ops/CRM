// The asset register: tabs issued to sales staff, kept by the IT department.
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
  add('TL Dubai', 'tl@t.local', 'team_leader');
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Amal', 'amal@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Irfan', 'it@t.local', 'it');
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
  add('Gina', 'gov@t.local', 'governance');
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
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
}

const tab = (serial, extra = {}) => ({ serial_no: serial, tab_no: `TAB-${serial.slice(-3)}`, charger: true, stylus: false, card_reader: true, network: 'etisalat', sim_number: '8997101234567', entra_id: 'dana@derbygroup.ae', mobile_number: '0501234567', ...extra });

test('IT registers tabs, assigns them, changes status; sales staff see their own; the inventory report lists all', async () => {
  const it = await login('it@t.local');
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const mis = await login('mis@t.local');
  const gov = await login('gov@t.local');
  // IT is confined to the register: no files, no staff changes, but it can read the staff list without salaries.
  assert.equal((await it('GET', '/cases')).status, 403);
  assert.equal((await it('GET', '/stats')).status, 403);
  assert.equal((await it('POST', '/users', { name: 'X', email: 'x@t.local', role: 'sales', password: PASSWORD })).status, 403);
  const staff = (await it('GET', '/users')).data.users;
  assert.ok(staff.some((u) => u.name === 'Dana') && !('salary' in staff[0]) && !('mobile_number' in staff[0]));
  // Register a tab: it starts with IT.
  assert.equal((await it('POST', '/assets', { tab_no: 'T1' })).status, 400);
  assert.equal((await it('POST', '/assets', tab('SN001', { network: 'virgin' }))).status, 400);
  const a = (await it('POST', '/assets', tab('SN001'))).data.asset;
  assert.deepEqual([a.status, a.holder_id, a.charger, a.stylus, a.card_reader, a.network], ['it_custody', null, 1, 0, 1, 'etisalat']);
  assert.equal((await it('POST', '/assets', tab('sn001'))).status, 409);
  // Assign to Dana: in use with her; she sees it, Amal does not.
  const assigned = (await it('POST', `/assets/${a.id}/assign`, { holder_id: ids['dana@t.local'], note: 'Issued at induction' })).data.asset;
  assert.deepEqual([assigned.status, assigned.holder_name, assigned.holder_sales_code], ['in_use', 'Dana', 'D-1']);
  assert.equal((await dana('GET', '/assets/mine')).data.asset.tab_no, 'TAB-001');
  assert.equal((await amal('GET', '/assets/mine')).data.asset, null);
  assert.equal((await dana('GET', `/assets/${a.id}`)).data.asset.serial_no, 'SN001');
  assert.equal((await amal('GET', `/assets/${a.id}`)).status, 404);
  assert.equal((await dana('GET', '/assets')).status, 403);
  assert.equal((await dana('POST', `/assets/${a.id}/status`, { status: 'it_custody' })).status, 403);
  // One tab per person: a second tab cannot go to Dana until hers is back.
  const b = (await it('POST', '/assets', tab('SN002', { network: 'du' }))).data.asset;
  assert.equal((await it('POST', `/assets/${b.id}/assign`, { holder_id: ids['dana@t.local'] })).status, 409);
  // Edit details; the serial must stay unique.
  assert.equal((await it('PATCH', `/assets/${b.id}`, { stylus: true, serial_no: 'SN001' })).status, 409);
  assert.equal((await it('PATCH', `/assets/${b.id}`, { stylus: true, entra_id: 'amal@derbygroup.ae' })).data.asset.stylus, 1);
  // Status changes: back to IT clears the holder and remembers them; handed over on exit the same.
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'in_use' })).status, 400);
  assert.equal((await it('POST', `/assets/${b.id}/status`, { status: 'handed_over' })).status, 400);
  const back = (await it('POST', `/assets/${a.id}/status`, { status: 'it_custody', note: 'Screen repair' })).data.asset;
  assert.deepEqual([back.status, back.holder_id, back.previous_holder_name, back.status_note], ['it_custody', null, 'Dana', 'Screen repair']);
  assert.equal((await dana('GET', '/assets/mine')).data.asset, null);
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'it_custody' })).status, 409);
  assert.equal((await it('POST', `/assets/${b.id}/assign`, { holder_id: ids['dana@t.local'] })).status, 200);
  const gone = (await mis('POST', `/assets/${b.id}/status`, { status: 'handed_over', note: 'Resigned 30 Sep' })).data.asset;
  assert.deepEqual([gone.status, gone.previous_holder_name], ['handed_over', 'Dana']);
  const events = (await it('GET', `/assets/${a.id}`)).data.events.map((e) => e.type);
  assert.deepEqual(events, ['status', 'assigned', 'registered']);
  // The register and its summary, for IT, MIS and the business head.
  const reg = (await mis('GET', '/assets')).data;
  assert.deepEqual([reg.assets.length, reg.summary.total, reg.summary.it_custody, reg.summary.handed_over, reg.summary.in_use, reg.summary.staff_without_tab], [2, 2, 1, 1, 0, 2]);
  assert.equal((await it('GET', '/assets?q=SN002')).data.assets.length, 1);
  assert.equal((await it('GET', '/assets?status=handed_over')).data.assets[0].tab_no, 'TAB-002');
  // The inventory report.
  const rep = (await it('GET', '/reports/assets')).data;
  assert.deepEqual(rep.rows.map((r) => [r.tab_no, r.status, r.previous_holder, r.network]), [['TAB-001', 'With IT custody', 'Dana', 'Etisalat'], ['TAB-002', 'Handed over on exit', 'Dana', 'du']]);
  assert.match(rep.note, /2 tabs/);
  assert.ok((await it('GET', '/reports')).data.reports.every((r) => r.key === 'assets'));
  assert.equal((await gov('GET', '/reports/assets')).status, 404);
  assert.equal((await it('GET', '/reports/sourcing')).status, 404);
});
