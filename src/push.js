// Phone alerts: Web Push to the devices a person has turned alerts on with (the CRM added to the
// Home Screen on a phone or tab). Implements VAPID (RFC 8292) and aes128gcm payload encryption
// (RFC 8291 / RFC 8188) with node:crypto alone, so the server needs no package and sends each
// alert straight to the push service of the device (Apple, Google or Mozilla).
import crypto from 'node:crypto';
import { ADMIN_EMAIL } from './auth.js';

const KEY = 'vapid_keys';
const now = () => new Date().toISOString();
const b64url = (buf) => Buffer.from(buf).toString('base64url');
const fromB64url = (s) => Buffer.from(String(s || ''), 'base64url');

/** The server's VAPID key pair, made once and kept in the settings table so subscriptions stay valid across restarts. */
export function vapidKeys(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(KEY);
  if (row) return JSON.parse(row.value);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  const keys = { publicKey: b64url(ecdh.getPublicKey()), privateKey: b64url(ecdh.getPrivateKey()) };
  db.prepare('INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, NULL, ?)').run(KEY, JSON.stringify(keys), now());
  return keys;
}

const CONTACT = process.env.VAPID_SUBJECT || `mailto:${ADMIN_EMAIL}`;

/** A short-lived VAPID token for one push service, signed with the server's key (ES256). */
export function vapidAuthorization(keys, endpoint, exp = Math.floor(Date.now() / 1000) + 12 * 3600) {
  const pub = fromB64url(keys.publicKey);
  const key = crypto.createPrivateKey({
    key: { kty: 'EC', crv: 'P-256', x: b64url(pub.subarray(1, 33)), y: b64url(pub.subarray(33, 65)), d: keys.privateKey },
    format: 'jwk',
  });
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: new URL(endpoint).origin, exp, sub: CONTACT }));
  const signature = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `vapid t=${header}.${claims}.${b64url(signature)}, k=${keys.publicKey}`;
}

const hkdf = (salt, ikm, info, length) => Buffer.from(crypto.hkdfSync('sha256', ikm, salt, info, length));

/** Encrypts a payload for one subscription: the aes128gcm body the push service forwards untouched. */
export function encryptPayload(subscription, payload) {
  const uaPublic = fromB64url(subscription.keys.p256dh);
  const authSecret = fromB64url(subscription.keys.auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error('Subscription keys are not valid');
  const local = crypto.createECDH('prime256v1');
  local.generateKeys();
  const asPublic = local.getPublicKey();
  const shared = local.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const ikm = hkdf(authSecret, shared, Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic]), 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  // One record: the payload, then the 0x02 delimiter that marks the last record.
  const body = Buffer.concat([cipher.update(Buffer.concat([Buffer.from(payload), Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const rs = Buffer.alloc(4);
  rs.writeUInt32BE(4096);
  return Buffer.concat([salt, rs, Buffer.from([asPublic.length]), asPublic, body]);
}

/** Sends one encrypted message to one device. Resolves with the push service's status. */
export async function sendPush(keys, subscription, payload, { ttl = 24 * 3600, fetchImpl = fetch } = {}) {
  const res = await fetchImpl(subscription.endpoint, {
    method: 'POST',
    headers: {
      authorization: vapidAuthorization(keys, subscription.endpoint),
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(ttl),
      urgency: 'high',
    },
    body: encryptPayload(subscription, JSON.stringify(payload)),
  });
  return res.status;
}

const isValid = (s) => s && typeof s.endpoint === 'string' && /^https:\/\//.test(s.endpoint) && s.endpoint.length < 2000
  && s.keys && typeof s.keys.p256dh === 'string' && typeof s.keys.auth === 'string';

/** Remembers a device for the signed-in person; a device that another account used before moves to this one. */
export function subscribe(db, user, subscription, userAgent = null) {
  if (!isValid(subscription)) throw Object.assign(new Error('That device could not be registered for alerts'), { status: 400 });
  db.prepare(`INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at)
    VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(endpoint) DO UPDATE SET user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent, failed_at = NULL`)
    .run(user.id, subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth, userAgent ? String(userAgent).slice(0, 300) : null, now());
  return { ok: true, devices: deviceCount(db, user) };
}

/** Forgets a device, for instance when its person signs out. */
export function unsubscribe(db, user, endpoint) {
  if (typeof endpoint === 'string') db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, user.id);
  return { ok: true, devices: deviceCount(db, user) };
}

export const deviceCount = (db, user) => db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(user.id).n;

const unreadOf = (db, userId) => db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(userId).n;

/**
 * Pushes an alert to every device of the given people, with their unread count for the app badge.
 * Devices the push service no longer knows (404, 410) are forgotten. Never throws: a phone being
 * off or a push service being down must not fail the action that raised the alert.
 */
export async function pushToUsers(db, userIds, { title = 'STRIDE', body, url = '/', tag = null }, { fetchImpl = fetch, log = console } = {}) {
  const ids = [...new Set(userIds.filter(Boolean))];
  if (!ids.length) return { sent: 0 };
  const subs = db.prepare(`SELECT * FROM push_subscriptions WHERE user_id IN (${ids.map(() => '?').join(',')})`).all(...ids);
  if (!subs.length) return { sent: 0 };
  const keys = vapidKeys(db);
  let sent = 0;
  await Promise.all(subs.map(async (s) => {
    const payload = { title, body, url, tag, badge: unreadOf(db, s.user_id) };
    try {
      const status = await sendPush(keys, { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload, { fetchImpl });
      if (status === 404 || status === 410) db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(s.id);
      else if (status >= 200 && status < 300) { sent += 1; db.prepare('UPDATE push_subscriptions SET last_used_at = ?, failed_at = NULL WHERE id = ?').run(now(), s.id); }
      else { db.prepare('UPDATE push_subscriptions SET failed_at = ? WHERE id = ?').run(now(), s.id); log.warn?.(`push to ${new URL(s.endpoint).host} answered ${status}`); }
    } catch (e) {
      db.prepare('UPDATE push_subscriptions SET failed_at = ? WHERE id = ?').run(now(), s.id);
      log.warn?.(`push to ${new URL(s.endpoint).host} failed: ${e.message}`);
    }
  }));
  return { sent };
}
