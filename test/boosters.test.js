// Boosters: product campaigns with dates, shown with progress to the staff they cover and their leaders.
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
  add('TL Abu Dhabi', 'tla@t.local', 'team_leader', { region: 'AUH' });
  add('Cara', 'cara@t.local', 'sales', { region: 'DXB', sales_code: 'D-2', core_product: 'credit_card', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Lina', 'lina@t.local', 'sales', { region: 'DXB', sales_code: 'D-3', core_product: 'personal_loan', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Amal', 'amal@t.local', 'sales', { region: 'AUH', sales_code: 'A-1', core_product: 'credit_card', team_leader_id: ids['tla@t.local'], sales_manager_id: ids['sm1@t.local'] });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB' });
  add('Pat', 'proc@t.local', 'processing', { region: 'DXB' });
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
const today = () => new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
const plus = (d) => new Date(Date.now() + 4 * 3600e3 + d * 864e5).toISOString().slice(0, 10);

test('business heads run boosters per product with dates; covered staff and their leaders see them with progress', async () => {
  const head = await login('head@t.local');
  const mis = await login('mis@t.local');
  const cara = await login('cara@t.local');
  const lina = await login('lina@t.local');
  const amal = await login('amal@t.local');
  const tl = await login('tl@t.local');
  const sm = await login('sm1@t.local');
  const proc = await login('proc@t.local');
  assert.equal((await cara('POST', '/boosters', { title: 'x' })).status, 403);
  assert.equal((await head('POST', '/boosters', { title: 'No dates', product: 'credit_card' })).status, 400);
  assert.equal((await head('POST', '/boosters', { title: 'Backwards', product: 'credit_card', starts_on: plus(3), ends_on: today() })).status, 400);
  // A Dubai card booster running now, for core card staff.
  const b = (await head('POST', '/boosters', { title: 'Premium push', product: 'credit_card', reward: 'AED 150 extra per Premium card', starts_on: plus(-2), ends_on: plus(5), region: 'DXB', audience: 'core' })).data.booster;
  assert.deepEqual([b.status, b.product, b.region, b.created_by_name], ['running', 'credit_card', 'DXB', 'Bilal']);
  // Cara (DXB cards) sees it; Lina (loans) and Amal (AUH) do not; the team leader and manager see it with the covered names.
  const mine = (await cara('GET', '/dashboard')).data.boosters;
  assert.deepEqual([mine.length, mine[0].title, mine[0].covered, mine[0].days_left, mine[0].progress.files], [1, 'Premium push', 1, 5, 0]);
  assert.equal((await lina('GET', '/dashboard')).data.boosters.length, 0, 'lina');
  assert.equal((await amal('GET', '/dashboard')).data.boosters.length, 0, 'amal');
  const tlv = (await tl('GET', '/dashboard')).data.boosters[0];
  assert.deepEqual([tlv.covered, tlv.covered_names], [1, ['Cara']]);
  assert.equal((await sm('GET', '/dashboard')).data.boosters[0].covered, 1);
  assert.equal((await proc('GET', '/dashboard')).status, 200);
  // Progress: Cara completes a card in the window.
  const c = (await cara('POST', '/cases', { region: 'DXB', core_product: 'credit_card', customer_name: 'Boost Card', phone: '+971 50 123 4567', city: 'Dubai', salary: 32000, source: 'Walk-in', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', sourcing_date: today() })).data.case;
  assert.equal((await mis('POST', `/cases/${c.id}/actions`, { action: 'set_case_status', case_status: 'completed' })).status, 200);
  assert.deepEqual((await cara('GET', '/dashboard')).data.boosters[0].progress, { files: 1, staff_with_files: 1, aed: 0 });
  // An upcoming all-products booster for everyone shows ahead of time; an ended one from long ago does not.
  assert.equal((await mis('POST', '/boosters', { title: 'Month end', product: 'all', audience: 'all', starts_on: plus(7), ends_on: plus(10) })).status, 201);
  assert.equal((await mis('POST', '/boosters', { title: 'Old', product: 'all', audience: 'all', starts_on: plus(-40), ends_on: plus(-30) })).status, 201);
  const lv = (await lina('GET', '/dashboard')).data.boosters;
  assert.deepEqual(lv.map((x) => [x.title, x.status, x.days_to_start]), [['Month end', 'upcoming', 7]]);
  // Edit, switch off, delete.
  const list = (await head('GET', '/boosters')).data.boosters;
  assert.equal(list.length, 3);
  assert.equal((await head('PUT', `/boosters/${b.id}`, { active: false })).data.booster.status, 'off');
  assert.deepEqual((await cara('GET', '/dashboard')).data.boosters.map((x) => x.title), ['Month end']);
  assert.equal((await head('DELETE', `/boosters/${b.id}`)).status, 200);
  assert.equal((await head('GET', '/boosters')).data.boosters.length, 2);
});
