// User profiles. Sales staff carry a sales code plus their team leader and sales manager,
// which pre-fill the "Sales staff" section of every file they source.

export const USER_COLUMNS = `u.id, u.name, u.email, u.role, u.active, u.created_at,
  u.sales_code, u.team_leader_id, u.sales_manager_id,
  tl.name AS team_leader_name, sm.name AS sales_manager_name`;
export const USER_FROM = `users u
  LEFT JOIN users tl ON tl.id = u.team_leader_id
  LEFT JOIN users sm ON sm.id = u.sales_manager_id`;

export function findUser(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE u.id = ?`).get(id) || null;
}

export function listUsers(db, { role } = {}) {
  const where = role ? 'WHERE u.role = ? AND u.active = 1' : '';
  return db.prepare(`SELECT ${USER_COLUMNS} FROM ${USER_FROM} ${where} ORDER BY u.role, u.name`).all(...(role ? [role] : []));
}

/**
 * Validates the sales code, team leader and sales manager for a sales user. `current` is the
 * existing user when editing, so only the fields being changed need to be sent.
 */
export function salesProfile(db, input, current = null) {
  const pick = (f) => (f in input ? input[f] : current?.[f]);
  const code = String(pick('sales_code') ?? '').trim().toUpperCase();
  if (!code) throw new Error('Sales code is required for sales staff');
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new Error('Sales code should be 2–20 letters, digits or dashes');
  const clash = db.prepare('SELECT id FROM users WHERE sales_code = ? AND id != ?').get(code, current?.id ?? 0);
  if (clash) throw new Error(`Sales code ${code} is already used by another user`);

  const manager = (field, role, label) => {
    const id = Number(pick(field));
    const row = id ? db.prepare('SELECT id FROM users WHERE id = ? AND role = ? AND active = 1').get(id, role) : null;
    if (!row) throw new Error(`Choose the ${label} for this sales staff member`);
    return id;
  };
  return {
    sales_code: code,
    team_leader_id: manager('team_leader_id', 'team_leader', 'team leader'),
    sales_manager_id: manager('sales_manager_id', 'sales_manager', 'sales manager'),
  };
}
