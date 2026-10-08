import crypto from 'node:crypto';
import { contactDetails, findUser, salesProfile, regionOf } from './users.js';

const SESSION_DAYS = 7;
export const ROLES = ['sales', 'processing', 'team_leader', 'asm', 'sales_manager', 'mis', 'business_head', 'governance'];

export function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export function verifyPassword(password, stored) {
  const [scheme, saltHex, hashHex] = String(stored).split('$');
  if (scheme !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = crypto.scryptSync(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

/** A readable temporary password, e.g. for users added by bulk upload without one. */
export function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.randomBytes(10), (b) => chars[b % chars.length]).join('');
}

/** `requireMobile` is set for users added from the Users page or a bulk upload. */
export function createUser(db, input, { requireMobile = false } = {}) {
  const { role, password } = input;
  const contact = contactDetails(input, { requireMobile });
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(contact.email)) {
    throw new Error(`A user with the email ${contact.email} already exists`);
  }
  const profile = role === 'sales' ? salesProfile(db, input) : { sales_code: null, team_leader_id: null, sales_manager_id: null, asm_id: null };
  const region = regionOf(input.region);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO users (name, email, role, password_hash, mobile_number, whatsapp_number, sales_code, team_leader_id, sales_manager_id, asm_id, region)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(contact.name, contact.email, role, hashPassword(String(password)), contact.mobile_number, contact.whatsapp_number,
      profile.sales_code, profile.team_leader_id, profile.sales_manager_id, profile.asm_id, region);
  return getUser(db, Number(lastInsertRowid));
}

export const getUser = findUser;

export function login(db, email, password) {
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE').get(String(email || '').trim());
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const expires = new Date(Date.now() + SESSION_DAYS * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').run(token, user.id, expires);
  return { token, maxAge: SESSION_DAYS * 86400, user: getUser(db, user.id) };
}

export function userForToken(db, token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.active, u.region FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, new Date().toISOString());
  return row || null;
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
