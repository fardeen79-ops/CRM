// Profit and loss by region: every person's cost sits whole in their own region, sales staff and
// non-sales staff alike. Nobody is split across regions; a person with no region set is counted
// under "No region set" and in the all-regions view only.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser, loginId } from './helpers/create-user.mjs';
import { regionShares } from '../src/pnl.js';

const PASSWORD = 'password123';
let server, base, ids;
const HRMS = {}; // the HRMS code of each fixture, the username at sign-in

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (HRMS[email] = extra.hrms_code || null, ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB', salary: 30000 });
  add('TL Mixed', 'tl@t.local', 'team_leader', { region: 'DXB', salary: 12000 });
  add('TL Empty', 'tl2@t.local', 'team_leader', { region: 'AUH', salary: 9000 });
  // Three SEs under TL Mixed: two in Dubai, one in Abu Dhabi.
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Dina', 'dina@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Aziz', 'aziz@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 6000 });
  add('Pat', 'proc@t.local', 'processing', { region: 'AUH', salary: 4500 });
  add('Gina', 'gov@t.local', 'governance', { salary: 7500 });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Yusuf', 'ceo@t.local', 'ceo', { region: 'DXB', hrms_code: 'EN4' });
  db.prepare('UPDATE users SET sales_manager_id = ? WHERE id IN (?, ?)').run(ids['sm@t.local'], ids['tl@t.local'], ids['tl2@t.local']);
  server = createServer(db);
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: HRMS[email] || loginId(email), password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: await r.json() };
  };
}

test('everyone sits whole in their own region, whatever their team looks like', () => {
  const people = [
    { id: 1, role: 'sales', region: 'DXB', team_leader_id: 10 }, { id: 3, role: 'sales', region: 'AUH', team_leader_id: 10 },
    { id: 10, role: 'team_leader', region: 'DXB' }, { id: 40, role: 'processing', region: 'AUH' }, { id: 41, role: 'governance', region: null },
  ];
  const sharesOf = regionShares(people);
  assert.deepEqual(sharesOf(people[0]), [['DXB', 1]]);
  assert.deepEqual(sharesOf(people[2]), [['DXB', 1]], 'a team leader with staff in both regions stays whole in their own');
  assert.deepEqual(sharesOf(people[3]), [['AUH', 1]]);
  assert.deepEqual(sharesOf(people[4]), [['NONE', 1]], 'no region set: the No region set bucket');
});

test('the statement and the hierarchy carry each person once, in their own region', async () => {
  const bilal = await login('head@t.local'); const head = await login('ceo@t.local');
  const cycle = (await head('GET', '/me')).data.meta.current_cycle;
  const all = (await head('GET', `/pnl?cycle=${cycle}`)).data;
  const roles = Object.fromEntries(all.pnl.rows.map((l) => [l.role, l]));
  // Nothing is lost or doubled: every salary counts once across the business.
  assert.equal(all.pnl.salaries, 30000 + 12000 + 9000 + 5000 + 5000 + 6000 + 4500 + 7500);
  assert.equal(roles.team_leader.staff, 2);
  assert.equal(roles.processing.salary, 4500, 'the CEO sees every line by role');
  // A business head who is not the CEO sees the support roles (business heads included) as one line.
  const folded = (await bilal('GET', `/pnl?cycle=${cycle}`)).data.pnl;
  assert.ok(!folded.rows.some((l) => ['business_head', 'processing', 'governance'].includes(l.role)));
  assert.equal(folded.rows.find((l) => l.role === 'support').salary, 4500 + 7500);
  assert.equal(folded.salaries, all.pnl.salaries);
  const dxb = (await head('GET', `/pnl?cycle=${cycle}&region=DXB`)).data.pnl;
  const auh = (await head('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.pnl;
  const by = (p, role) => p.rows.find((l) => l.role === role);
  // TL Mixed is a Dubai cost in full, although one of the three SEs is in Abu Dhabi; TL Empty is Abu Dhabi's.
  assert.equal(by(dxb, 'team_leader').salary, 12000);
  assert.equal(by(auh, 'team_leader').salary, 9000);
  assert.equal(by(dxb, 'team_leader').staff, 1);
  assert.equal(by(dxb, 'sales_manager').salary, 30000);
  assert.equal(by(dxb, 'processing'), undefined, 'Pat is an Abu Dhabi cost only');
  assert.equal(by(auh, 'processing').salary, 4500);
  assert.equal(by(dxb, 'governance'), undefined, 'Gina has no region, so she is in the all-regions view only');
  assert.equal(by(auh, 'sales').salary, 6000);
  assert.equal(dxb.salaries + auh.salaries, all.pnl.salaries - 7500);

  const { tree, total } = (await head('GET', `/pnl?cycle=${cycle}`)).data.tree;
  assert.deepEqual(tree.map((n) => n.key), ['AUH', 'DXB', 'NONE'], 'Gina sits under No region set');
  const dxbT = tree.find((n) => n.key === 'DXB'); const auhT = tree.find((n) => n.key === 'AUH');
  const sm = (t) => t.children.find((n) => n.label === 'SM One');
  const tlMixed = (t) => sm(t).children.find((n) => n.label === 'TL Mixed');
  assert.equal(tlMixed(dxbT).salary, 12000 + 5000 + 5000, 'the team leader whole plus the two Dubai SEs');
  assert.equal(tlMixed(auhT).salary, 6000, 'in Abu Dhabi only Aziz, under the same team leader');
  assert.equal(tlMixed(dxbT).headcount, 3);
  assert.equal(sm(dxbT).salary - sm(dxbT).children.reduce((n, c) => n + c.salary, 0), 30000, 'the sales manager whole in Dubai');
  assert.equal(sm(auhT).salary - sm(auhT).children.reduce((n, c) => n + c.salary, 0), 0, 'and nothing of them in Abu Dhabi');
  assert.equal(auhT.children.find((n) => n.kind === 'overheads').salary, 4500);
  assert.equal(tree.find((n) => n.key === 'NONE').salary, 7500);
  assert.equal(total.salary, all.pnl.salaries);
  assert.equal(total.headcount, 10);
  const one = (await head('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.tree;
  assert.equal(one.tree.length, 1);
  assert.equal(one.total.salary, auh.salaries);
});
