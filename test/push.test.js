// Phone alerts: VAPID signing, payload encryption and the device routes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser, loginId } from './helpers/create-user.mjs';
import { vapidKeys, vapidAuthorization, encryptPayload, pushToUsers } from '../src/push.js';
import { notify } from '../src/cases.js';

const PASSWORD = 'password123';
let db, server, base, ids;
// A pretend push service: records what the CRM sends and answers with the status the test asks for.
const received = [];
let answer = 201;
const pushFetch = async (url, init) => {
  received.push({ url, headers: init.headers, body: Buffer.from(init.body) });
  return { status: typeof answer === 'function' ? answer(url) : answer };
};

const fromB64url = (s) => Buffer.from(s, 'base64url');
/** A device's key pair and auth secret, like a browser's PushSubscription. */
function device(endpoint) {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const auth = crypto.randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: auth.toString('base64url') } } };
}
/** Decrypts an aes128gcm body the way a browser does (RFC 8291). */
function decrypt(dev, body) {
  const salt = body.subarray(0, 16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const cipherText = body.subarray(21 + idlen);
  const shared = dev.ecdh.computeSecret(asPublic);
  const hkdf = (s, ikm, info, len) => Buffer.from(crypto.hkdfSync('sha256', ikm, s, info, len));
  const ikm = hkdf(dev.auth, shared, Buffer.concat([Buffer.from('WebPush: info\0'), dev.ecdh.getPublicKey(), asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const d = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  d.setAuthTag(cipherText.subarray(-16));
  const plain = Buffer.concat([d.update(cipherText.subarray(0, -16)), d.final()]);
  assert.equal(plain.at(-1), 2, 'last record delimiter');
  return plain.subarray(0, -1).toString();
}

before(async () => {
  db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('Tara TL', 'tl@t.local', 'team_leader', { region: 'DXB', hrms_code: 'P1' });
  add('Sam Sales', 'sam@t.local', 'sales', { region: 'DXB', hrms_code: 'P2', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'] });
  server = createServer(db, { pushFetch });
  await new Promise((r) => server.listen(0, r));
  base = `http://127.0.0.1:${server.address().port}/api`;
});
after(() => server.close());

async function login(email) {
  const res = await fetch(`${base}/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: loginId(email), password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', cookie }, body: body ? JSON.stringify(body) : undefined });
    return { status: r.status, data: await r.json().catch(() => null) };
  };
}

test('the server makes one VAPID key pair and keeps it', () => {
  const a = vapidKeys(db);
  const b = vapidKeys(db);
  assert.deepEqual(a, b);
  assert.equal(fromB64url(a.publicKey).length, 65);
  assert.equal(fromB64url(a.privateKey).length, 32);
});

test('the VAPID token is an ES256 JWT for the push service, checked with the public key', () => {
  const keys = vapidKeys(db);
  const header = vapidAuthorization(keys, 'https://web.push.apple.com/abc', 1_900_000_000);
  const m = header.match(/^vapid t=([^,]+), k=(.+)$/);
  assert.ok(m);
  assert.equal(m[2], keys.publicKey);
  const [h, c, sig] = m[1].split('.');
  assert.deepEqual(JSON.parse(fromB64url(h)), { typ: 'JWT', alg: 'ES256' });
  const claims = JSON.parse(fromB64url(c));
  assert.equal(claims.aud, 'https://web.push.apple.com');
  assert.equal(claims.exp, 1_900_000_000);
  assert.match(claims.sub, /^mailto:/);
  const pub = fromB64url(keys.publicKey);
  const key = crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: pub.subarray(1, 33).toString('base64url'), y: pub.subarray(33).toString('base64url') }, format: 'jwk' });
  assert.ok(crypto.verify('sha256', Buffer.from(`${h}.${c}`), { key, dsaEncoding: 'ieee-p1363' }, fromB64url(sig)));
});

test('a payload encrypted for a device decrypts on that device and nowhere else', () => {
  const dev = device('https://fcm.googleapis.com/fcm/send/one');
  const body = encryptPayload(dev.subscription, JSON.stringify({ title: 'STRIDE', body: 'hello' }));
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.deepEqual(JSON.parse(decrypt(dev, body)), { title: 'STRIDE', body: 'hello' });
  const other = device('https://fcm.googleapis.com/fcm/send/two');
  assert.throws(() => decrypt(other, body));
  assert.throws(() => encryptPayload({ endpoint: 'https://x', keys: { p256dh: 'AAAA', auth: 'AAAA' } }, 'x'), /not valid/);
});

test('a person turns alerts on with a device and every notification reaches it, with the unread count', async () => {
  const sam = await login('sam@t.local');
  const key = await sam('GET', '/push/key');
  assert.equal(key.status, 200);
  assert.equal(key.data.key, vapidKeys(db).publicKey);
  assert.equal(key.data.devices, 0);
  const phone = device('https://web.push.apple.com/sam-phone');
  const sub = await sam('POST', '/push/subscribe', { subscription: phone.subscription });
  assert.equal(sub.status, 200);
  assert.equal(sub.data.devices, 1);
  // Registering the same device again keeps one row.
  assert.equal((await sam('POST', '/push/subscribe', { subscription: phone.subscription })).data.devices, 1);
  assert.equal((await sam('POST', '/push/subscribe', { subscription: { endpoint: 'http://plain', keys: {} } })).status, 400);

  received.length = 0;
  notify(db, [ids['sam@t.local']], null, 'CRM-000042 (Test customer) was returned to you: fix the salary', '#/cases/42');
  notify(db, [ids['sam@t.local']], null, 'CRM-000043 (Second) validated and sent for verification', '#/messages/1');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 2);
  const first = received[0];
  assert.equal(first.url, phone.subscription.endpoint);
  assert.equal(first.headers['content-encoding'], 'aes128gcm');
  assert.equal(first.headers.ttl, '86400');
  assert.match(first.headers.authorization, /^vapid t=.+, k=/);
  const msg = JSON.parse(decrypt(phone, first.body));
  assert.equal(msg.title, 'STRIDE');
  assert.equal(msg.body, 'CRM-000042 (Test customer) was returned to you: fix the salary');
  assert.equal(msg.url, '/#/cases/42');
  assert.equal(msg.tag, null);
  // The badge is the unread count when the alert leaves: both alerts went after both notifications were written.
  assert.equal(msg.badge, 2);
  assert.equal(JSON.parse(decrypt(phone, received[1].body)).badge, 2);
  // Once read, the next alert carries the lower count.
  await sam('POST', '/notifications/read', {});
  received.length = 0;
  notify(db, [ids['sam@t.local']], null, 'CRM-000044 (Third) sent back');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(JSON.parse(decrypt(phone, received[0].body)).badge, 1);

  // A test alert from the profile page goes to the device too.
  received.length = 0;
  const t = await sam('POST', '/push/test');
  assert.equal(t.data.sent, 1, JSON.stringify(t));
  assert.match(JSON.parse(decrypt(phone, received[0].body)).body, /Test alert for Sam Sales/);

  // Only the people notified are pushed: the team leader has no device, and gets nothing.
  received.length = 0;
  notify(db, [ids['tl@t.local']], null, 'To validate: CRM-000042');
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(received.length, 0);

  // A real file: the team leader turns alerts on, and Sam's submission reaches their phone linking to the file.
  const tl = await login('tl@t.local');
  const tlPhone = device('https://web.push.apple.com/tl-phone');
  await tl('POST', '/push/subscribe', { subscription: tlPhone.subscription });
  received.length = 0;
  const made = await sam('POST', '/cases', { journey_type: 'emirates_id', customer_name: 'Pushed customer', region: 'DXB', phone: '+971 50 111 2222', city: 'Dubai', product: 'auto_loan', amount: 50000, auto_loan_type: 'used', car_make: 'Nissan', car_model: 'Patrol', car_year: 2023, al_lead_source: 'Walk-in', al_interest_rate: 4, al_tenure: 48 });
  assert.equal(made.status, 201, JSON.stringify(made.data));
  await new Promise((r) => setTimeout(r, 50));
  const toTl = received.filter((r) => r.url === tlPhone.subscription.endpoint);
  assert.equal(toTl.length, 1);
  const alert = JSON.parse(decrypt(tlPhone, toTl[0].body));
  assert.match(alert.body, /^To validate: CRM-\d+ \(Pushed customer\) from Sam Sales/);
  assert.equal(alert.url, `/#/cases/${made.data.case.id}`);
  assert.equal(alert.tag, `case-${made.data.case.id}`);
  await tl('POST', '/push/unsubscribe', { endpoint: tlPhone.subscription.endpoint });
});

test('a device another account used moves to the person now signed in on it, and sign-out forgets it', async () => {
  const sam = await login('sam@t.local');
  const tl = await login('tl@t.local');
  const tab = device('https://fcm.googleapis.com/fcm/send/shared-tab');
  assert.equal((await sam('POST', '/push/subscribe', { subscription: tab.subscription })).data.devices, 2);
  assert.equal((await tl('POST', '/push/subscribe', { subscription: tab.subscription })).data.devices, 1);
  assert.equal((await sam('GET', '/push/key')).data.devices, 1);
  received.length = 0;
  notify(db, [ids['tl@t.local']], null, 'Action required: CRM-000042');
  await new Promise((r) => setTimeout(r, 50));
  assert.deepEqual(received.map((r) => r.url), [tab.subscription.endpoint]);
  assert.equal((await tl('POST', '/push/unsubscribe', { endpoint: tab.subscription.endpoint })).data.devices, 0);
  // Sam cannot forget a device that is not his.
  assert.equal((await sam('POST', '/push/unsubscribe', { endpoint: tab.subscription.endpoint })).data.devices, 1);
});

test('a device the push service no longer knows is forgotten; other failures keep it', async () => {
  const sam = await login('sam@t.local');
  const gone = device('https://updates.push.services.mozilla.com/gone');
  const flaky = device('https://updates.push.services.mozilla.com/flaky');
  await sam('POST', '/push/subscribe', { subscription: gone.subscription });
  await sam('POST', '/push/subscribe', { subscription: flaky.subscription });
  assert.equal((await sam('GET', '/push/key')).data.devices, 3);
  answer = (url) => (url.endsWith('/gone') ? 410 : url.endsWith('/flaky') ? 503 : 201);
  const r = await pushToUsers(db, [ids['sam@t.local']], { body: 'x' }, { fetchImpl: pushFetch, log: { warn() {} } });
  answer = 201;
  assert.equal(r.sent, 1);
  assert.equal((await sam('GET', '/push/key')).data.devices, 2);
  assert.ok(db.prepare('SELECT failed_at FROM push_subscriptions WHERE endpoint = ?').get(flaky.subscription.endpoint).failed_at);
});

test('the service worker and badge icon are served', async () => {
  const sw = await fetch(`${base.replace('/api', '')}/sw.js`);
  assert.equal(sw.status, 200);
  assert.match(sw.headers.get('content-type'), /javascript/);
  assert.match(await sw.text(), /addEventListener\('push'/);
  assert.equal((await fetch(`${base.replace('/api', '')}/icons/badge-96.png`)).headers.get('content-type'), 'image/png');
  const it = http; void it;
});
