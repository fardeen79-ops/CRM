// "Forgot password" on the sign-in page. The CRM sends no email, so a request tells MIS and the
// business heads, who reset the password from the Staff page and pass it on; the request is cleared
// when they do. The sign-in page never says whether an account exists.
const REPEAT_MINUTES = 10;
export const RESET_HANDLERS = ['mis', 'business_head'];

/** Records a request for the account named, if there is one; returns who to tell, or null. */
export function requestPasswordReset(db, identifier) {
  const id = String(identifier || '').trim();
  if (!id) return null;
  const user = db.prepare("SELECT id, name, hrms_code, role FROM users WHERE active = 1 AND role != 'staff' AND ((hrms_code IS NOT NULL AND hrms_code = ? COLLATE NOCASE) OR ((hrms_code IS NULL OR hrms_code = '') AND email = ? COLLATE NOCASE))").get(id, id);
  if (!user) return null;
  const recent = db.prepare('SELECT id FROM password_resets WHERE user_id = ? AND resolved_at IS NULL AND requested_at > ?').get(user.id, new Date(Date.now() - REPEAT_MINUTES * 60e3).toISOString());
  if (recent) return { user, repeated: true };
  db.prepare('INSERT INTO password_resets (user_id, requested_at) VALUES (?, ?)').run(user.id, new Date().toISOString());
  const handlers = db.prepare(`SELECT id FROM users WHERE active = 1 AND role IN (${RESET_HANDLERS.map(() => '?').join(',')})`).all(...RESET_HANDLERS).map((r) => r.id);
  return { user, repeated: false, handlers };
}

/** Clears the open requests of a user whose password was just reset. */
export function resolvePasswordResets(db, userId, byId) {
  db.prepare('UPDATE password_resets SET resolved_at = ?, resolved_by = ? WHERE user_id = ? AND resolved_at IS NULL').run(new Date().toISOString(), byId, userId);
}

/** Open requests, newest first, for the Staff page. */
export function openPasswordResets(db) {
  return db.prepare('SELECT r.user_id, MAX(r.requested_at) AS requested_at FROM password_resets r WHERE r.resolved_at IS NULL GROUP BY r.user_id').all();
}
