// Custom roles: defined by IT, Dubai MIS and business heads on top of a built-in role, with fewer
// screens, reports, uploads, downloads or pricing.
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
  add('Irfan', 'it@t.local', 'it');
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
  add('Maya', 'mis-auh@t.local', 'mis', { region: 'AUH' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB' });
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
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: r.headers.get('content-type')?.includes('json') ? await r.json() : await r.text() };
  };
}

test('IT, Dubai MIS and business heads define roles; others cannot', async () => {
  const it = await login('it@t.local');
  const mis = await login('mis@t.local');
  const misAuh = await login('mis-auh@t.local');
  const head = await login('head@t.local');
  const gov = await login('gov@t.local');
  for (const who of [it, mis, head]) assert.equal((await who('GET', '/roles')).status, 200);
  for (const who of [misAuh, gov]) assert.equal((await who('GET', '/roles')).status, 403);
  const cat = (await it('GET', '/roles')).data;
  assert.ok(cat.builtin.some((r) => r.key === 'mis' && r.pages.includes('reports') && r.reports.includes('sourcing')));
  assert.ok(cat.pages.cases && cat.uploads.assets && cat.reports.sourcing);
  assert.deepEqual([(await it('GET', '/me')).data.meta.can_manage_roles, (await misAuh('GET', '/me')).data.meta.can_manage_roles], [true, false]);
});

test('a role based on MIS with fewer screens, two reports, no uploads, no downloads and no pricing', async () => {
  const it = await login('it@t.local');
  const mis = await login('mis@t.local');
  // Validation: a name, a known base, and pages or reports outside the base are dropped.
  assert.equal((await it('POST', '/roles', { base: 'mis' })).status, 400);
  assert.equal((await it('POST', '/roles', { label: 'X', base: 'ceo' })).status, 400);
  assert.equal((await it('POST', '/roles', { label: 'MIS', base: 'mis' })).status, 409);
  const made = (await it('POST', '/roles', { label: 'Reporting Analyst', base: 'mis', pages: ['cases', 'reports', 'staff', 'uploads', 'roles'], reports: ['sourcing', 'pipeline', 'assets'], uploads: [], downloads: false, payout: false, description: 'Reads reports only' })).data.role;
  assert.deepEqual([made.key, made.base, made.pages, made.reports, made.uploads, made.downloads, made.payout], ['reporting_analyst', 'mis', ['cases', 'reports', 'staff', 'uploads', 'roles'], ['sourcing', 'pipeline', 'assets'], [], false, false]);
  assert.equal((await it('POST', '/roles', { label: 'reporting analyst', base: 'mis' })).status, 409);
  // A user on the role: created with the custom key, stored as its base, labelled by the role.
  const u = (await mis('POST', '/users', { name: 'Rita', email: 'rita@t.local', role: 'reporting_analyst', region: 'DXB', mobile_number: '0501112233', hrms_code: 'EN77001', password: PASSWORD })).data.user;
  assert.deepEqual([u.role, u.role_key], ['mis', 'reporting_analyst']);
  const rita = await login('rita@t.local');
  const me = (await rita('GET', '/me')).data;
  assert.deepEqual([me.user.role, me.user.role_key, me.meta.perms.custom, me.meta.perms.pages, me.meta.perms.downloads, me.meta.perms.payout, me.meta.role_labels.reporting_analyst, me.meta.can_see_payout, me.meta.can_manage_roles], ['mis', 'reporting_analyst', true, ['cases', 'reports', 'staff', 'uploads', 'roles'], false, false, 'Reporting Analyst', false, true]);
  // Screens she was not given are refused; the ones she has work as for MIS.
  assert.equal((await rita('GET', '/cases')).status, 200);
  assert.equal((await rita('GET', '/users')).status, 200);
  assert.equal((await rita('GET', '/targets')).status, 403);
  assert.equal((await rita('GET', '/hierarchy')).status, 403);
  assert.equal((await rita('GET', '/assets')).status, 403);
  assert.equal((await rita('GET', '/conversations')).status, 403);
  // Only the two reports she was given, no CSV, and nothing of the pricing.
  assert.deepEqual((await rita('GET', '/reports')).data.reports.map((r) => r.key).sort(), ['assets', 'pipeline', 'sourcing']);
  assert.equal((await rita('GET', '/reports/sourcing?cycle=2026-10')).status, 200);
  assert.equal((await rita('GET', '/reports/register?cycle=2026-10')).status, 404);
  assert.equal((await rita('GET', '/reports/sourcing?cycle=2026-10&format=csv')).status, 403);
  assert.equal((await mis('GET', '/reports/sourcing?cycle=2026-10&format=csv')).status, 200);
  assert.ok(!('revenue_aed' in ((await rita('GET', '/reports/sourcing?cycle=2026-10')).data.rows[0] || {})));
  // No uploads at all, even though MIS can.
  assert.equal((await rita('POST', '/import/users', { csv: 'x', dry_run: true })).status, 403);
  assert.equal((await rita('POST', '/import/assets', { csv: 'x', dry_run: true })).status, 403);
  // Widening the role takes effect at once; it cannot be deleted while Rita has it.
  assert.equal((await it('PATCH', '/roles/reporting_analyst', { pages: ['cases', 'reports', 'targets'], uploads: ['assets'], downloads: true })).status, 200);
  assert.equal((await rita('GET', '/targets')).status, 200);
  assert.equal((await rita('GET', '/reports/sourcing?cycle=2026-10&format=csv')).status, 200);
  assert.equal((await rita('POST', '/import/assets', { csv: 'Tab no,Serial no\nT1,S1', dry_run: true })).status, 403); // uploads page not in pages
  assert.equal((await it('PATCH', '/roles/reporting_analyst', { pages: ['cases', 'reports', 'uploads'], uploads: ['assets'] })).status, 200);
  assert.equal((await rita('POST', '/import/assets', { csv: 'Tab no,Serial no\nT1,S1', dry_run: true })).status, 200);
  assert.equal((await rita('POST', '/import/users', { csv: 'x', dry_run: true })).status, 403);
  assert.equal((await it('DELETE', '/roles/reporting_analyst')).status, 409);
  assert.equal((await it('PATCH', '/roles/reporting_analyst', { base: 'governance' })).status, 400);
  // Moving Rita back to plain MIS frees the role; the bulk staff upload accepts the role's name too.
  assert.equal((await mis('PATCH', `/users/${u.id}`, { role: 'mis' })).data.user.role_key, null);
  const up = (await mis('POST', '/import/users', { csv: 'Full name,HRMS code,Email,Role,Region,Password\nRavi,EN77002,ravi@t.local,Reporting Analyst,DXB,password123', dry_run: true })).data;
  assert.equal(up.ok, 1, JSON.stringify(up.rows));
  assert.equal((await it('DELETE', '/roles/reporting_analyst')).status, 200);
  assert.equal((await mis('POST', '/users', { name: 'Zed', email: 'zed@t.local', role: 'reporting_analyst', mobile_number: '0501112299', hrms_code: 'EN77009', password: PASSWORD })).status, 400);
});

test('a role based on sales keeps the sales workflow and profile; the base cannot change on the fly', async () => {
  const head = await login('head@t.local');
  const mis = await login('mis@t.local');
  const r = (await head('POST', '/roles', { label: 'Senior Sales', base: 'sales', pages: ['cases', 'targets'] })).data.role;
  assert.deepEqual([r.key, r.pages, r.uploads], ['senior_sales', ['cases', 'targets'], []]);
  const u = (await mis('POST', '/users', { name: 'Sami', email: 'sami@t.local', role: 'Senior Sales', region: 'DXB', sales_code: 'D-9', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'], mobile_number: '0501112244', hrms_code: 'EN77003', password: PASSWORD })).data.user;
  assert.deepEqual([u.role, u.role_key, u.sales_code], ['sales', 'senior_sales', 'D-9']);
  const sami = await login('sami@t.local');
  assert.equal((await sami('GET', '/cases')).status, 200);
  assert.equal((await sami('GET', '/conversations')).status, 403);
  assert.equal((await sami('GET', '/roles')).status, 403);
  assert.equal((await mis('GET', '/users')).data.users.find((x) => x.id === u.id).role_key, 'senior_sales');
});

test('a custom sales role with My tab reaches its own tab but not the register', async () => {
  const head = await login('head@t.local');
  const mis = await login('mis@t.local');
  const it = await login('it@t.local');
  assert.equal((await head('POST', '/roles', { label: 'Tab Sales', base: 'sales', pages: ['cases', 'my_tab'] })).status, 201);
  const u = (await mis('POST', '/users', { name: 'Tess', email: 'tess@t.local', role: 'tab_sales', region: 'DXB', sales_code: 'D-8', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'], mobile_number: '0501112255', hrms_code: 'EN77004', password: PASSWORD })).data.user;
  const a = (await it('POST', '/assets', { tab_no: 'TAB-9', serial_no: 'SN9', holder_id: u.id })).data.asset;
  const tess = await login('tess@t.local');
  assert.equal((await tess('GET', '/assets/mine')).data.asset.tab_no, 'TAB-9');
  assert.equal((await tess('GET', `/assets/${a.id}`)).status, 200);
  assert.equal((await tess('GET', '/assets')).status, 403);
  assert.equal((await tess('GET', '/targets')).status, 403);
});
