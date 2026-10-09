// Verification: completion on deviation, and processors allocated to sales team leaders.
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
  add('SM One', 'sm1@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('TL Two', 'tl2@t.local', 'team_leader', { region: 'DXB' });
  add('Dana', 'dana@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Cara', 'cara@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'credit_card', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Lina', 'lina@t.local', 'sales', { region: 'DXB', sales_code: 'D-3', core_product: 'personal_loan', team_leader_id: ids['tl2@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  add('Pat', 'pat@t.local', 'processing', { region: 'DXB' });
  add('Omar', 'omar@t.local', 'processing', { region: 'DXB' });
  add('Vera', 'vlead@t.local', 'processing_lead', { region: 'DXB' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
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
    return { status: r.status, data: await r.json() };
  };
}


const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
const loan = (extra = {}) => ({ region: 'DXB', core_product: 'personal_loan', customer_name: 'Alloc Test', phone: '+971 50 222 3333', city: 'Dubai', salary: 15000, source: 'Walk-in', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 60000, interest_rate: 6, pl_tenure: 48, fpd, sourcing_date: '2026-10-05', ...extra });

test('a processor can complete verification on a deviation, with a mandatory note', async () => {
  const dana = await login('dana@t.local');
  const pat = await login('pat@t.local');
  const c = (await dana('POST', '/cases', loan())).data.case;
  assert.equal(c.status, 'pending_verification');
  assert.ok((await pat('GET', `/cases/${c.id}`)).data.case.allowed_actions.includes('complete_deviation'));
  assert.equal((await pat('POST', `/cases/${c.id}/actions`, { action: 'complete_deviation' })).status, 400);
  const done = (await pat('POST', `/cases/${c.id}/actions`, { action: 'complete_deviation', note: 'Customer abroad; employer HR confirmed the details in writing' })).data.case;
  assert.deepEqual([done.status, done.verified_basis, done.verified_by_name], ['completed', 'deviation', 'Pat']);
  assert.ok(done.events.some((e) => e.type === 'complete_deviation' && e.detail === 'deviation' && /HR confirmed/.test(e.note)));
  assert.ok((await dana('GET', '/notifications')).data.items.some((n) => n.case_id === c.id && /based on deviation/.test(n.message)));
});

test('the verification team leader allocates processors to sales team leaders; their files reach that processor only', async () => {
  const cara = await login('cara@t.local');
  const dana = await login('dana@t.local');
  const pat = await login('pat@t.local');
  const omar = await login('omar@t.local');
  const vera = await login('vlead@t.local');
  const head = await login('head@t.local');
  assert.equal((await vera('GET', '/me')).data.user.role_key, 'processing_lead');
  assert.ok((await vera('GET', '/me')).data.meta.perms.pages.includes('allocation'));
  // Only the verification team leader (or a business head) allocates.
  assert.equal((await pat('GET', '/allocations')).status, 403);
  const list = (await vera('GET', '/allocations')).data;
  assert.ok(list.team_leaders.some((t) => t.id === ids['tl2@t.local']) && list.processors.some((p) => p.id === ids['pat@t.local']));
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { processor_id: ids['dana@t.local'] })).status, 400);
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { processor_id: ids['pat@t.local'] })).status, 200);
  assert.equal((await head('GET', '/allocations')).data.team_leaders.find((t) => t.id === ids['tl2@t.local']).processor_name, 'Pat');
  // Cara (TL Two's team) sources a file: Pat sees and claims it, Omar cannot, Vera sees everything.
  const c = (await cara('POST', '/cases', loan({ customer_name: 'Routed File' }))).data.case;
  const d = (await dana('POST', '/cases', loan({ customer_name: 'Shared File', phone: '+971 50 222 4444' }))).data.case;
  const ids_of = (r) => r.data.cases.map((x) => x.id);
  assert.ok(ids_of(await pat('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.ok(!ids_of(await omar('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.ok(ids_of(await omar('GET', '/cases?status=pending_verification')).includes(d.id));
  assert.ok(ids_of(await vera('GET', '/cases?status=pending_verification')).includes(c.id));
  assert.equal((await omar('GET', `/cases/${c.id}`)).status, 404);
  assert.equal((await omar('POST', `/cases/${c.id}/actions`, { action: 'claim' })).status, 404);
  assert.equal((await pat('POST', `/cases/${c.id}/actions`, { action: 'claim' })).status, 200);
  // Clearing the allocation puts the team leader's files back in the shared queue.
  assert.equal((await vera('PUT', `/allocations/${ids['tl2@t.local']}`, { processor_id: null })).status, 200);
  assert.equal((await omar('GET', `/cases/${c.id}`)).status, 200);
  // The built-in role cannot be edited or deleted.
  assert.equal((await head('DELETE', '/roles/processing_lead')).status, 400);
});
