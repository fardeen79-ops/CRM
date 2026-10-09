// Leads: a sales person's prospects, seen only by them and their team leader, converted into files.
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
  add('TL Dubai', 'tl-dxb@t.local', 'team_leader');
  add('TL Abu Dhabi', 'tl-auh@t.local', 'team_leader');
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', team_leader_id: ids['tl-dxb@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Amal', 'amal@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', team_leader_id: ids['tl-auh@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
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

test('leads belong to the sales person and are seen by their team leader only', async () => {
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const tlDxb = await login('tl-dxb@t.local');
  const tlAuh = await login('tl-auh@t.local');
  const mis = await login('mis@t.local');
  assert.equal((await dana('POST', '/leads', { first_name: 'Omar', phone: '050' })).status, 400);
  const l = (await dana('POST', '/leads', { first_name: 'Omar', last_name: 'Haddad', phone: '+971 50 123 4567', company_name: 'Emaar', salary: '12,000', product: 'credit_card', source: 'Referral', follow_up_at: '2026-10-12', notes: 'Wants a travel card' })).data.lead;
  assert.deepEqual([l.customer_name, l.salary, l.status, l.owner_name], ['Omar Haddad', 12000, 'open', 'Dana']);
  assert.equal((await dana('GET', '/leads')).data.leads.length, 1);
  assert.equal((await tlDxb('GET', '/leads')).data.leads[0].owner_name, 'Dana');
  assert.equal((await amal('GET', '/leads')).data.leads.length, 0);
  assert.equal((await tlAuh('GET', '/leads')).data.leads.length, 0);
  assert.equal((await amal('GET', `/leads/${l.id}`)).status, 404);
  assert.equal((await tlAuh('GET', `/leads/${l.id}`)).status, 404);
  assert.equal((await mis('GET', '/leads')).status, 403);
  // The team leader sees but does not change; the owner edits.
  assert.equal((await tlDxb('PATCH', `/leads/${l.id}`, { notes: 'x' })).status, 403);
  assert.equal((await dana('PATCH', `/leads/${l.id}`, { company_name: 'Emaar Properties' })).data.lead.company_name, 'Emaar Properties');
  // A team leader can add a lead for one of their staff, not for someone else's.
  assert.equal((await tlAuh('POST', '/leads', { owner_id: ids['dana@t.local'], first_name: 'X', last_name: 'Y', phone: '+971 50 000 0000' })).status, 400);
  assert.equal((await tlDxb('POST', '/leads', { owner_id: ids['dana@t.local'], first_name: 'Sara', last_name: 'Ali', phone: '+971 50 000 0001' })).data.lead.owner_name, 'Dana');
});

test('a lead converts into a case with its details, or is marked not interested or not eligible', async () => {
  const dana = await login('dana@t.local');
  const amal = await login('amal@t.local');
  const l = (await dana('POST', '/leads', { first_name: 'Noor', last_name: 'Salem', phone: '+971 55 222 3333', company_name: 'ADNOC', salary: 15000, product: 'personal_loan', city: 'Dubai' })).data.lead;
  // Another sales person cannot convert it.
  const body = { customer_name: 'Noor Salem', first_name: 'Noor', last_name: 'Salem', region: 'DXB', phone: '+971 55 222 3333', city: 'Dubai', product: 'personal_loan', core_product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 100000, interest_rate: 6, pl_tenure: 48, fpd: '2026-12-01', secondary_buyout: 'no', salary: 15000, company_name: 'ADNOC', source: 'Lead', lead_id: l.id };
  assert.equal((await amal('POST', '/cases', { ...body, region: 'AUH' })).status, 404);
  const c = (await dana('POST', '/cases', body)).data.case;
  assert.ok(c?.id, 'case created from the lead');
  const after = (await dana('GET', `/leads/${l.id}`)).data.lead;
  assert.deepEqual([after.status, after.case_id], ['converted', c.id]);
  assert.equal((await dana('POST', '/cases', body)).status, 409);
  assert.equal((await dana('POST', `/leads/${l.id}/status`, { status: 'not_interested' })).status, 409);
  // Not interested / not eligible, with a note, and reopen.
  const m = (await dana('POST', '/leads', { first_name: 'Tariq', last_name: 'Aziz', phone: '+971 50 999 8888' })).data.lead;
  const ni = (await dana('POST', `/leads/${m.id}/status`, { status: 'not_interested', note: 'Happy with his bank' })).data.lead;
  assert.deepEqual([ni.status, ni.status_note], ['not_interested', 'Happy with his bank']);
  assert.equal((await dana('PATCH', `/leads/${m.id}`, { notes: 'x' })).status, 409);
  assert.equal((await dana('POST', `/leads/${m.id}/status`, { status: 'open' })).data.lead.status, 'open');
  assert.equal((await dana('POST', `/leads/${m.id}/status`, { status: 'not_eligible', note: 'Salary below AED 5,000' })).data.lead.status, 'not_eligible');
  const { counts } = (await dana('GET', '/leads?status=converted')).data;
  assert.deepEqual([counts.converted, counts.not_eligible, counts.open], [1, 1, 2]);
});
