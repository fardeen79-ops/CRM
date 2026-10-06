import crypto from 'node:crypto';

const SESSION_DAYS = 7;
export const ROLES = ['sales', 'processing', 'team_leader', 'sales_manager', 'mis', 'business_head'];

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

export function createUser(db, { name, email, role, password }) {
  if (!name?.trim() || !email?.trim()) throw new Error('Name and email are required');
  if (!ROLES.includes(role)) throw new Error(`Role must be one of: ${ROLES.join(', ')}`);
  if (!password || password.length < 8) throw new Error('Password must be at least 8 characters');
  const { lastInsertRowid } = db
    .prepare('INSERT INTO users (name, email, role, password_hash) VALUES (?, ?, ?, ?)')
    .run(name.trim(), email.trim().toLowerCase(), role, hashPassword(password));
  return getUser(db, Number(lastInsertRowid));
}

export function getUser(db, id) {
  return db.prepare('SELECT id, name, email, role, active, created_at FROM users WHERE id = ?').get(id);
}

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
      `SELECT u.id, u.name, u.email, u.role, u.active FROM sessions s
       JOIN users u ON u.id = s.user_id
       WHERE s.token = ? AND s.expires_at > ? AND u.active = 1`
    )
    .get(token, new Date().toISOString());
  return row || null;
}

export function logout(db, token) {
  db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}
