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

test('bulk upload of the tab register: new serials are registered, known ones updated, holders issued, statuses moved', async () => {
  const it = await login('it@t.local');
  const gov = await login('gov@t.local');
  const csv = ['Tab no,Serial no,Charger,Stylus,Card reader,Network,SIM card number,Microsoft Entra ID,Mobile number registered,Issued to,Status,Notes',
    'TAB-201,SN201,Yes,No,Yes,Etisalat,89971012000201,amal@derbygroup.ae,050 111 0201,A-1,,New batch',
    'TAB-202,SN202,Yes,Yes,No,du,89971012000202,,,,,Spare',
    'TAB-203,SN203,No,No,No,,,,,ZZ-9,,',
    'TAB-001-B,SN001,Yes,Yes,Yes,du,,,,,With IT custody,Relabelled',
    'TAB-204,SN204,Yes,No,No,Etisalat,,,,,Active in use,'].join('\n');
  const preview = (await it('POST', '/import/assets', { csv, dry_run: true })).data;
  assert.deepEqual([preview.dry_run, preview.total, preview.ok, preview.failed], [true, 5, 3, 2]);
  assert.match(preview.rows[2].error, /ZZ-9/);
  assert.match(preview.rows[4].error, /Issued to/);
  assert.equal((await it('GET', '/assets?q=SN201')).data.assets.length, 0);
  const done = (await it('POST', '/import/assets', { csv })).data;
  assert.deepEqual([done.ok, done.failed], [3, 2]);
  const amal = (await it('GET', '/assets?q=SN201')).data.assets[0];
  assert.deepEqual([amal.status, amal.holder_name, amal.stylus, amal.network, amal.notes], ['in_use', 'Amal', 0, 'etisalat', 'New batch']);
  assert.equal((await it('GET', '/assets?q=SN202')).data.assets[0].status, 'it_custody');
  const relabelled = (await it('GET', '/assets?q=SN001')).data.assets[0];
  assert.deepEqual([relabelled.tab_no, relabelled.stylus, relabelled.network, relabelled.status], ['TAB-001-B', 1, 'du', 'it_custody']);
  // Uploading again with the holder moved to IT custody returns the tab.
  const again = (await it('POST', '/import/assets', { csv: 'Tab no,Serial no,Status\nTAB-201,SN201,Handed over on exit' })).data;
  assert.equal(again.ok, 1);
  const back = (await it('GET', '/assets?q=SN201')).data.assets[0];
  assert.deepEqual([back.status, back.holder_id, back.previous_holder_name], ['handed_over', null, 'Amal']);
  assert.equal((await gov('POST', '/import/assets', { csv })).status, 403);
  assert.ok((await it('GET', '/me')).data.meta.import_columns.assets.some((c) => c.key === 'issued_to'));
});

test('returned to bank: a status with a date, in the register, the upload and the inventory', async () => {
  const it = await login('it@t.local');
  const a = (await it('POST', '/assets', { tab_no: 'TAB-401', serial_no: 'SN401', holder_id: ids['amal@t.local'] })).data.asset;
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'returned_to_bank' })).status, 400);
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'returned_to_bank', returned_on: '2099-01-01' })).status, 400);
  const r = (await it('POST', `/assets/${a.id}/status`, { status: 'returned_to_bank', returned_on: '2026-10-01', note: 'Batch 3 return' })).data.asset;
  assert.deepEqual([r.status, r.returned_on, r.holder_id, r.previous_holder_name], ['returned_to_bank', '2026-10-01', null, 'Amal']);
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'returned_to_bank', returned_on: '2026-10-01' })).status, 409);
  assert.equal((await it('POST', `/assets/${a.id}/status`, { status: 'returned_to_bank', returned_on: '2026-10-02' })).data.asset.returned_on, '2026-10-02');
  assert.match((await it('GET', `/assets/${a.id}`)).data.events[0].detail, /Returned to bank on 2026-10-02/);
  const up = (await it('POST', '/import/assets', { csv: 'Tab no,Serial no,Status,Returned to bank on\nTAB-402,SN402,Returned to bank,2026-09-30\nTAB-403,SN403,Returned to bank,' })).data;
  assert.deepEqual([up.ok, up.failed], [1, 1]);
  assert.match(up.rows[1].error, /returned to the bank/);
  const row = (await it('GET', '/reports/assets')).data.rows.find((x) => x.tab_no === 'TAB-402');
  assert.deepEqual([row.status, row.returned_on], ['Returned to bank', '2026-09-30']);
  assert.equal((await it('GET', '/assets?status=returned_to_bank')).data.assets.length, 2);
  assert.equal((await it('GET', '/assets')).data.summary.returned_to_bank, 2);
});

test('each user gets their own dashboard data: cycle, file counts in scope, six-cycle trend, incentive', async () => {
  const dana = await login('dana@t.local');
  const it = await login('it@t.local');
  const d = (await dana('GET', '/dashboard')).data;
  assert.ok(/^\d{4}-\d{2}$/.test(d.cycle) && d.days >= 28 && d.days_left >= 0 && d.day >= 1);
  assert.deepEqual(Object.keys(d.files).sort(), ['applicant_review', 'awaiting_approval', 'completed', 'in_verification', 'open', 'rejected', 'returned', 'sourced', 'verification_pending']);
  assert.equal(d.trend.length, 6);
  assert.equal(d.trend[5].cycle, d.cycle);
  assert.ok(d.incentive === null || typeof d.incentive.total === 'number');
  assert.equal((await it('GET', '/dashboard')).status, 403);
});
