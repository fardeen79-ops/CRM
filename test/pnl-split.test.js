// Profit and loss: everyone who is not a sales executive is split across regions by SE count. A
// team leader or manager by the regions of the SEs under them; business heads, processing, MIS,
// governance and IT by the business's SE count per region.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { regionShares } from '../src/pnl.js';

const PASSWORD = 'password123';
let server, base, ids;

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB', salary: 30000 });
  add('TL Mixed', 'tl@t.local', 'team_leader', { region: 'DXB', salary: 12000, sales_manager_id: ids['sm@t.local'] });
  add('TL Empty', 'tl2@t.local', 'team_leader', { region: 'AUH', salary: 9000, sales_manager_id: ids['sm@t.local'] });
  // Three SEs under TL Mixed: two in Dubai, one in Abu Dhabi.
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Dina', 'dina@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Aziz', 'aziz@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 6000 });
  add('Pat', 'proc@t.local', 'processing', { region: 'AUH', salary: 4500 });
  add('Gina', 'gov@t.local', 'governance', { salary: 7500 });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Yusuf', 'ceo@t.local', 'ceo', { region: 'DXB', hrms_code: 'EN4' });
  // Salaries and reporting lines for non-sales people are set on the Staff page; set them directly here.
  const set = db.prepare('UPDATE users SET salary = ?, sales_manager_id = ? WHERE id = ?');
  set.run(30000, null, ids['sm@t.local']); set.run(12000, ids['sm@t.local'], ids['tl@t.local']); set.run(9000, ids['sm@t.local'], ids['tl2@t.local']);
  set.run(4500, null, ids['proc@t.local']); set.run(7500, null, ids['gov@t.local']);
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
    return { status: r.status, data: await r.json() };
  };
}

test('shares follow the SEs: a leader by their own team, overheads by the business, nobody by their own region', () => {
  const people = [
    { id: 1, role: 'sales', region: 'DXB', team_leader_id: 10, sales_manager_id: 20 }, { id: 2, role: 'sales', region: 'DXB', team_leader_id: 10, sales_manager_id: 20 },
    { id: 3, role: 'sales', region: 'AUH', team_leader_id: 10, sales_manager_id: 20, asm_id: 30 },
    { id: 10, role: 'team_leader', region: 'DXB' }, { id: 11, role: 'team_leader', region: 'AUH' }, { id: 20, role: 'sales_manager', region: 'DXB' }, { id: 30, role: 'asm', region: 'AUH' },
    { id: 40, role: 'processing', region: 'AUH' }, { id: 41, role: 'governance', region: null },
  ];
  const sharesOf = regionShares(people);
  const pct = (p) => Object.fromEntries(sharesOf(p).map(([k, v]) => [k, Math.round(v * 1000) / 10]));
  assert.deepEqual(pct(people[0]), { DXB: 100 });
  assert.deepEqual(pct(people[3]), { DXB: 66.7, AUH: 33.3 }, 'team leader with two SEs in Dubai and one in Abu Dhabi');
  assert.deepEqual(pct(people[4]), { DXB: 66.7, AUH: 33.3 }, 'a team leader with no SEs follows the business');
  assert.deepEqual(pct(people[6]), { AUH: 100 }, 'an ASM with one SE in Abu Dhabi');
  assert.deepEqual(pct(people[7]), { DXB: 66.7, AUH: 33.3 }, 'processing follows the business, not its own region');
  assert.deepEqual(pct(people[8]), { DXB: 66.7, AUH: 33.3 });
  assert.deepEqual(regionShares([{ id: 5, role: 'mis', region: 'DXB' }])({ id: 5, role: 'mis', region: 'DXB' }), [['DXB', 1]], 'with no SEs at all, the own region');
});

test('the statement and the hierarchy carry each person at their share per region', async () => {
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
  // TL Mixed: two of three SEs in Dubai, so 8,000 there and 4,000 in Abu Dhabi. TL Empty has no SEs and follows the business (also 2:1).
  assert.equal(by(dxb, 'team_leader').salary, 8000 + 6000);
  assert.equal(by(auh, 'team_leader').salary, 4000 + 3000);
  assert.equal(by(dxb, 'team_leader').staff, 1.33);
  // The sales manager and the overheads follow the same 2:1 split; Pat's own region (Abu Dhabi) does not matter.
  assert.equal(by(dxb, 'sales_manager').salary, 20000);
  assert.equal(by(dxb, 'processing').salary, 3000);
  assert.equal(by(auh, 'processing').salary, 1500);
  assert.equal(by(dxb, 'governance').salary, 5000);
  assert.equal(by(auh, 'sales').salary, 6000, 'sales executives stay whole in their own region');
  assert.equal(dxb.salaries + auh.salaries, all.pnl.salaries);

  const { tree, total } = (await head('GET', `/pnl?cycle=${cycle}`)).data.tree;
  assert.deepEqual(tree.map((n) => n.key), ['AUH', 'DXB'], 'no "No region set" bucket: Gina follows the SEs');
  const dxbT = tree.find((n) => n.key === 'DXB'); const auhT = tree.find((n) => n.key === 'AUH');
  const sm = (t) => t.children.find((n) => n.label === 'SM One');
  const tlMixed = (t) => sm(t).children.find((n) => n.label === 'TL Mixed');
  assert.equal(tlMixed(dxbT).salary, 8000 + 5000 + 5000, 'team leader share plus the two Dubai SEs');
  assert.equal(tlMixed(auhT).salary, 4000 + 6000);
  assert.equal(tlMixed(dxbT).headcount, 2.67);
  assert.equal(sm(dxbT).salary - tlMixed(dxbT).salary - sm(dxbT).children.find((n) => n.label === 'TL Empty').salary, 20000);
  assert.equal(dxbT.children.find((n) => n.kind === 'overheads').salary, 3000 + 5000);
  assert.equal(auhT.children.find((n) => n.kind === 'overheads').salary, 1500 + 2500);
  assert.equal(total.salary, all.pnl.salaries);
  assert.equal(total.headcount, 10, 'the CEO account counts as a business head');
  const one = (await head('GET', `/pnl?cycle=${cycle}&region=AUH`)).data.tree;
  assert.equal(one.tree.length, 1);
  assert.equal(one.total.salary, auh.salaries);
});
