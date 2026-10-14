import crypto from 'node:crypto';
import { resolveRole, withRole } from './roles.js';
import { contactDetails, findUser, salesProfile, leaderProfile, LEADER_LINE_ROLES, regionOf, salaryOf } from './users.js';

const SESSION_DAYS = 7; // a plain sign-in: the cookie ends with the browser, the session record a week later
const REMEMBER_DAYS = 30; // "Remember me": the device stays signed in across browser restarts
/** Minutes without using the CRM after which a session ends (IDLE_TIMEOUT_MINUTES; 0 turns it off). */
export const IDLE_MINUTES = process.env.IDLE_TIMEOUT_MINUTES === undefined ? 5 : Math.max(0, Number(process.env.IDLE_TIMEOUT_MINUTES) || 0);
export const ROLES = ['sales', 'processing', 'team_leader', 'asm', 'sales_manager', 'mis', 'business_head', 'accounts', 'governance', 'it', 'staff'];

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
  const { password } = input;
  const contact = contactDetails(input, { requireMobile });
  let resolved;
  try { resolved = resolveRole(input.role); } catch (err) { throw new Error(err.message); }
  const role = resolved.base;
  if (!password || String(password).length < 8) throw new Error('Password must be at least 8 characters');
  if (db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(contact.email)) {
    throw new Error(`A user with the email ${contact.email} already exists`);
  }
  if (contact.hrms_code && db.prepare('SELECT 1 FROM users WHERE hrms_code = ? COLLATE NOCASE').get(contact.hrms_code)) {
    throw new Error(`HRMS code ${contact.hrms_code} is already used by another user`);
  }
  // Everyone's monthly salary feeds the profit and loss; sales staff also get their targets from it.
  let profile;
  try {
    const line = LEADER_LINE_ROLES.includes(role) ? leaderProfile(db, role, input) : { sales_manager_id: null, asm_id: null };
    profile = role === 'sales' ? salesProfile(db, input) : { sales_code: null, team_leader_id: null, ...line, salary: salaryOf(input.salary), core_product: null };
  }
  catch (err) { throw new Error(err.message); }
  const region = regionOf(input.region);
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO users (name, email, role, role_key, password_hash, mobile_number, whatsapp_number, sales_code, team_leader_id, sales_manager_id, asm_id, region, salary, hrms_code, doj, dol, core_product)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(contact.name, contact.email, role, resolved.key, hashPassword(String(password)), contact.mobile_number, contact.whatsapp_number,
      profile.sales_code, profile.team_leader_id, profile.sales_manager_id, profile.asm_id, region, profile.salary, contact.hrms_code, contact.doj, contact.dol, profile.core_product);
  return getUser(db, Number(lastInsertRowid));
}

export const getUser = findUser;

/** Signs in with the HRMS code (the username) or the email address. */
/** Staff who are on the books (for the profit and loss) but have no CRM access: settlement officers, bikers and the like. */
export const NO_ACCESS_ROLE = 'staff';
export function login(db, email, password, { remember = false } = {}) {
  const id = String(email || '').trim();
  const user = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR (hrms_code IS NOT NULL AND hrms_code = ? COLLATE NOCASE)').get(id, id);
  if (!user || !user.active || !verifyPassword(String(password || ''), user.password_hash)) return null;
  if (user.role === NO_ACCESS_ROLE) return { no_access: true };
  const token = crypto.randomBytes(32).toString('hex');
  const days = remember ? REMEMBER_DAYS : SESSION_DAYS;
  const expires = new Date(Date.now() + days * 864e5).toISOString();
  db.prepare('INSERT INTO sessions (token, user_id, expires_at, active_at) VALUES (?, ?, ?, ?)').run(token, user.id, expires, new Date().toISOString());
  // Without "Remember me" the cookie has no Max-Age, so it ends when the browser closes.
  return { token, maxAge: remember ? REMEMBER_DAYS * 86400 : null, remember: Boolean(remember), user: getUser(db, user.id) };
}

/**
 * The signed-in user for a session cookie. A session ends after IDLE_MINUTES without the person using
 * the CRM: the browser marks the requests that follow a click or keystroke (`active`), and only those
 * keep the session alive, so background refreshes do not. `info.idle` says the session was ended here.
 */
export function userForToken(db, token, { active = false, info = {} } = {}) {
  if (!token) return null;
  const now = new Date();
  const row = db
    .prepare(
      `SELECT u.id, u.name, u.email, u.role, u.role_key, u.active, u.region, s.active_at FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, now.toISOString());
  if (!row) return null;
  if (IDLE_MINUTES > 0 && row.active_at && now - new Date(row.active_at) > IDLE_MINUTES * 60e3) {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    info.idle = true;
    return null;
  }
  if (active || !row.active_at) db.prepare('UPDATE sessions SET active_at = ? WHERE token = ?').run(now.toISOString(), token);
  const { active_at, ...user } = row;
  return withRole(user);
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
