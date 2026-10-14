// Personal loan yield: the amount-weighted average rate on loans disbursed in a cycle, for each
// sales person, team leader, manager, region and overall, against the minimum.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser, loginId } from './helpers/create-user.mjs';
import { yieldOf, PL_MIN_YIELD } from '../src/yield.js';

const PASSWORD = 'password123';
let server, base, ids;
const HRMS = {}; // the HRMS code of each fixture, the username at sign-in

before(async () => {
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (HRMS[email] = extra.hrms_code || null, ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM Dubai', 'sm@t.local', 'sales_manager', { region: 'DXB' });
  add('SM Abu Dhabi', 'sm2@t.local', 'sales_manager', { region: 'AUH' });
  add('TL Leena', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('TL Omar', 'tl2@t.local', 'team_leader', { region: 'AUH' });
  add('Dev', 'dev@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'] });
  add('Anita', 'anita@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'] });
  add('Noor', 'noor@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm2@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
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

test('yield is the rate weighted by amount, per loan type, against the minimum', () => {
  const y = yieldOf([{ type: 'fresh', disbursed: 300000, rate: 5 }, { type: 'buy_out', disbursed: 100000, rate: 9 }]);
  assert.equal(y.yield_pct, 6);
  assert.equal(y.fresh_pct, 5); assert.equal(y.buy_out_pct, 9); assert.equal(y.top_up_pct, null);
  assert.equal(y.buy_out_share_pct, 25);
  assert.equal(y.vs_min, Math.round((6 - PL_MIN_YIELD) * 100) / 100);
  assert.equal(y.below_min, true);
  assert.equal(y.interest_aed, 24000);
  const none = yieldOf([{ type: 'fresh', disbursed: 50000, rate: null }]);
  assert.equal(none.yield_pct, null); assert.equal(none.unrated, 1); assert.equal(none.disbursed, 50000);
  assert.equal(yieldOf([]).files, 0);
});

test('each level sees its own yield on the dashboard and in the report', async () => {
  const dev = await login('dev@t.local'); const anita = await login('anita@t.local'); const noor = await login('noor@t.local');
  const mis = await login('mis@t.local'); const tl = await login('tl@t.local'); const sm = await login('sm@t.local'); const head = await login('head@t.local');
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const file = async (who, region, over) => {
    const r = await who('POST', '/cases', { journey_type: 'emirates_id', region, phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Loan Customer', core_product: 'personal_loan', product: 'personal_loan', personal_loan_type: 'fresh', pl_tenure: 48, fpd, ...over });
    assert.equal(r.status, 201, JSON.stringify(r.data));
    return r.data.case.id;
  };
  // Dev: two fresh loans at 9% and 8%; Anita: a buy-out at 7% (big) and a fresh at 9.5%; Noor in AUH: one at 8.49%.
  const loans = [
    [dev, 'DXB', { loan_amount: 100000, interest_rate: 9 }, 100000],
    [dev, 'DXB', { loan_amount: 100000, interest_rate: 8 }, 100000],
    [anita, 'DXB', { loan_amount: 300000, interest_rate: 7, personal_loan_type: 'buy_out', buyout_bank: 'Mashreq', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Mashreq', amount: 290000 }] }, 300000],
    [anita, 'DXB', { loan_amount: 100000, interest_rate: 9.5 }, 100000],
    [noor, 'AUH', { loan_amount: 200000, interest_rate: 8.49 }, 200000],
  ];
  for (const [who, region, over, disbursed] of loans) {
    const id = await file(who, region, over);
    assert.equal((await mis('POST', `/cases/${id}/actions`, { action: 'set_case_status', case_status: 'completed', pl_disbursed_amount: disbursed })).status, 200);
  }
  // A loan not yet disbursed does not count.
  await file(dev, 'DXB', { loan_amount: 500000, interest_rate: 2 });

  const mine = (await dev('GET', '/dashboard')).data.pl_yield;
  assert.equal(mine.yield_pct, 8.5); assert.equal(mine.files, 2); assert.equal(mine.disbursed, 200000); assert.equal(mine.below_min, false); assert.equal(mine.vs_min, 0.01);
  assert.deepEqual(mine.members, []);
  const hers = (await anita('GET', '/dashboard')).data.pl_yield;
  assert.equal(hers.yield_pct, 7.63, 'buy-out at 7% on 300k and fresh at 9.5% on 100k'); assert.equal(hers.buy_out_share_pct, 75); assert.equal(hers.below_min, true);

  const team = (await tl('GET', '/dashboard')).data.pl_yield;
  assert.equal(team.yield_pct, 7.92); assert.equal(team.files, 4);
  assert.equal(team.member_label, 'Sales staff');
  assert.deepEqual(team.members.map((m) => [m.name, m.yield_pct, m.below_min]), [['Dev', 8.5, false], ['Anita', 7.63, true]]);
  assert.equal(team.below, 1);

  const teams = (await sm('GET', '/dashboard')).data.pl_yield;
  assert.equal(teams.member_label, 'Team leader');
  assert.deepEqual(teams.members.map((m) => [m.name, m.files]), [['TL Leena', 4]]);

  const all = (await head('GET', '/dashboard')).data.pl_yield;
  assert.equal(all.files, 5); assert.equal(all.yield_pct, 8.06);
  assert.deepEqual(all.members.map((m) => [m.name, m.region, m.yield_pct]), [['TL Omar', 'AUH', 8.49], ['TL Leena', 'DXB', 7.92]]);
  const auh = (await head('GET', '/dashboard?region=AUH')).data.pl_yield;
  assert.equal(auh.files, 1); assert.equal(auh.yield_pct, 8.49); assert.equal(auh.below_min, false);

  const cycle = (await head('GET', '/dashboard')).data.cycle;
  const rep = (await head('GET', `/reports/pl_yield?cycle=${cycle}`)).data;
  assert.equal(rep.name, 'Personal loan yield');
  const levels = rep.rows.map((r) => `${r.level}:${r.name}`);
  assert.deepEqual(levels, ['Overall:Overall', 'Region:AUH', 'Region:DXB', 'Sales manager:SM Abu Dhabi', 'Sales manager:SM Dubai', 'Team leader:TL Omar', 'Team leader:TL Leena', 'Sales staff:Noor', 'Sales staff:Dev', 'Sales staff:Anita']);
  const dxb = rep.rows.find((r) => r.level === 'Region' && r.name === 'DXB');
  assert.equal(dxb.yield_pct, 7.92); assert.equal(dxb.fresh_pct, 8.83); assert.equal(dxb.buy_out_pct, 7); assert.equal(dxb.status, 'Below minimum');
  assert.equal(rep.rows.find((r) => r.name === 'Dev').status, 'Above minimum');
  // A team leader's report is their team only; sales staff cannot run it.
  const tlRep = (await tl('GET', `/reports/pl_yield?cycle=${cycle}`)).data;
  assert.deepEqual(tlRep.rows.map((r) => r.name), ['Overall', 'DXB', 'SM Dubai', 'TL Leena', 'Dev', 'Anita']);
  assert.equal((await dev('GET', `/reports/pl_yield?cycle=${cycle}`)).status, 404);
  assert.equal((await dev('GET', '/me')).data.meta.pl_min_yield, PL_MIN_YIELD);
});
