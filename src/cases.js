import { transaction } from './db.js';

export class WorkflowError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const STATUS = {
  PENDING: 'pending_verification',
  IN_VERIFICATION: 'in_verification',
  COMPLETED: 'completed',
  INCOMPLETE: 'incomplete',
  RETURNED: 'returned_to_sales',
  REJECTED: 'rejected',
};

export const CALL_OUTCOMES = ['connected', 'no_answer', 'busy', 'switched_off', 'wrong_number', 'call_back_later'];

export const INCOMPLETE_REASONS = [
  'customer_unreachable',
  'customer_denied',
  'incorrect_details',
  'documents_pending',
  'not_interested',
  'other',
];

const OPEN_FOR_PROCESSING = [STATUS.PENDING, STATUS.IN_VERIFICATION];

/**
 * Every state change goes through this table. `to: null` means the action is
 * logged but does not move the case.
 */
export const ACTIONS = {
  claim:           { roles: ['processing'],  from: [STATUS.PENDING],      to: STATUS.IN_VERIFICATION },
  release:         { roles: ['processing'],  from: [STATUS.IN_VERIFICATION], to: STATUS.PENDING },
  log_call:        { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: null },
  complete:        { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: STATUS.COMPLETED },
  mark_incomplete: { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: STATUS.INCOMPLETE, noteRequired: true },
  return_to_sales: { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.RETURNED, noteRequired: true },
  reverify:        { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.PENDING },
  reject:          { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.REJECTED, noteRequired: true },
  resubmit:        { roles: ['sales'],       from: [STATUS.RETURNED],     to: STATUS.PENDING },
};

const EDITABLE_FIELDS = ['customer_name', 'phone', 'alt_phone', 'email', 'address', 'city', 'product', 'amount', 'source', 'sales_notes'];

export const caseRef = (id) => `CRM-${String(id).padStart(6, '0')}`;

const now = () => new Date().toISOString();

function clean(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function validateCaseInput(input, { partial = false } = {}) {
  const out = {};
  for (const field of EDITABLE_FIELDS) {
    if (partial && !(field in input)) continue;
    out[field] = clean(input[field], field === 'sales_notes' || field === 'address' ? 2000 : 200);
  }
  if (!partial || 'customer_name' in out) {
    if (!out.customer_name) throw new WorkflowError(400, 'Customer name is required');
  }
  for (const field of ['phone', 'alt_phone']) {
    if (!partial || field in out) {
      if (field === 'phone' && !out.phone) throw new WorkflowError(400, 'Phone number is required');
      if (out[field]) {
        const digits = out[field].replace(/\D/g, '');
        if (!/^[+\d][\d\s\-()]*$/.test(out[field]) || digits.length < 7 || digits.length > 15) {
          throw new WorkflowError(400, `Invalid ${field === 'phone' ? 'phone' : 'alternate phone'} number`);
        }
      }
    }
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new WorkflowError(400, 'Invalid email address');
  if ('amount' in out && out.amount !== null) {
    const amount = Number(out.amount.replace(/,/g, ''));
    if (!Number.isFinite(amount) || amount < 0) throw new WorkflowError(400, 'Amount must be a positive number');
    out.amount = amount;
  }
  return out;
}

function addEvent(db, caseId, userId, type, { from = null, to = null, detail = null, note = null } = {}) {
  db.prepare(
    'INSERT INTO case_events (case_id, user_id, type, from_status, to_status, detail, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(caseId, userId, type, from, to, detail, note, now());
}

function notify(db, userIds, caseId, message) {
  const stmt = db.prepare('INSERT INTO notifications (user_id, case_id, message, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set(userIds.filter(Boolean))) stmt.run(id, caseId, message, now());
}

const activeUserIds = (db, role) =>
  db.prepare('SELECT id FROM users WHERE role = ? AND active = 1').all(role).map((r) => r.id);

const CASE_SELECT = `
  SELECT c.*, cb.name AS created_by_name, at.name AS assigned_to_name,
         vb.name AS verified_by_name, tb.name AS tl_actioned_by_name
  FROM cases c
  JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users at ON at.id = c.assigned_to
  LEFT JOIN users vb ON vb.id = c.verified_by
  LEFT JOIN users tb ON tb.id = c.tl_actioned_by`;

const withRef = (row) => row && { ...row, ref: caseRef(row.id) };

function canView(user, row) {
  return user.role !== 'sales' || row.created_by === user.id;
}

export function getCase(db, user, id) {
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  const events = db
    .prepare(
      `SELECT e.*, u.name AS user_name, u.role AS user_role FROM case_events e
       LEFT JOIN users u ON u.id = e.user_id WHERE e.case_id = ? ORDER BY e.id DESC`
    )
    .all(id);
  return { ...withRef(row), events, allowed_actions: allowedActions(user, row), can_edit: canEdit(user, row) };
}

export function listCases(db, user, { status, q, assigned, limit = 200 } = {}) {
  const where = [];
  const params = [];
  if (user.role === 'sales') {
    where.push('c.created_by = ?');
    params.push(user.id);
  }
  if (status) {
    const statuses = String(status).split(',').filter((s) => Object.values(STATUS).includes(s));
    if (statuses.length) {
      where.push(`c.status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (assigned === 'me') {
    where.push('c.assigned_to = ?');
    params.push(user.id);
  }
  if (q) {
    const term = `%${String(q).trim()}%`;
    const idMatch = String(q).match(/^(?:crm-)?0*(\d+)$/i);
    where.push(`(c.customer_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.city LIKE ?${idMatch ? ' OR c.id = ?' : ''})`);
    params.push(term, term, term, term);
    if (idMatch) params.push(Number(idMatch[1]));
  }
  const sql = `${CASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`;
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map(withRef);
}

export function createCase(db, user, input) {
  if (user.role !== 'sales' && user.role !== 'team_leader') {
    throw new WorkflowError(403, 'Only sales staff can add sourcing data');
  }
  const data = validateCaseInput(input);
  return transaction(db, () => {
    const ts = now();
    const cols = [...EDITABLE_FIELDS, 'status', 'created_by', 'created_at', 'updated_at'];
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO cases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
      .run(...EDITABLE_FIELDS.map((f) => data[f] ?? null), STATUS.PENDING, user.id, ts, ts);
    const id = Number(lastInsertRowid);
    addEvent(db, id, user.id, 'created', { to: STATUS.PENDING });
    return getCase(db, user, id);
  });
}

function canEdit(user, row) {
  if (user.role === 'team_leader') return ![STATUS.COMPLETED, STATUS.REJECTED].includes(row.status);
  if (user.role === 'sales') return row.created_by === user.id && [STATUS.PENDING, STATUS.RETURNED].includes(row.status);
  return false;
}

export function updateCase(db, user, id, input) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!canEdit(user, row)) throw new WorkflowError(403, 'This case can no longer be edited');
  const data = validateCaseInput(input, { partial: true });
  const changed = Object.keys(data).filter((f) => (data[f] ?? null) !== (row[f] ?? null));
  if (!changed.length) return getCase(db, user, id);
  return transaction(db, () => {
    db.prepare(`UPDATE cases SET ${changed.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
      ...changed.map((f) => data[f]),
      now(),
      id
    );
    addEvent(db, id, user.id, 'edited', { detail: changed.join(', ') });
    return getCase(db, user, id);
  });
}

export function allowedActions(user, row) {
  return Object.entries(ACTIONS)
    .filter(([name, rule]) => {
      if (!rule.roles.includes(user.role) || !rule.from.includes(row.status)) return false;
      if (user.role === 'sales') return row.created_by === user.id;
      if (user.role === 'processing' && row.status === STATUS.IN_VERIFICATION && row.assigned_to !== user.id) return false;
      return name !== 'claim' || !row.assigned_to;
    })
    .map(([name]) => name);
}

/**
 * Applies a workflow action. Returns `{ case, triggers }` where triggers are
 * outbound events (e.g. team-leader alerts) for the caller to dispatch.
 */
export function applyAction(db, user, id, { action, note, outcome, reason } = {}) {
  const rule = ACTIONS[action];
  if (!rule) throw new WorkflowError(400, `Unknown action: ${action}`);
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!rule.roles.includes(user.role)) throw new WorkflowError(403, 'Your role cannot perform this action');
  if (!allowedActions(user, row).includes(action)) {
    throw new WorkflowError(409, `Action "${action}" is not allowed while the case is ${row.status.replace(/_/g, ' ')}`);
  }

  note = clean(note, 2000);
  if (rule.noteRequired && !note) throw new WorkflowError(400, 'A note is required for this action');
  if (action === 'log_call' && !CALL_OUTCOMES.includes(outcome)) {
    throw new WorkflowError(400, `Call outcome must be one of: ${CALL_OUTCOMES.join(', ')}`);
  }
  if (action === 'mark_incomplete' && !INCOMPLETE_REASONS.includes(reason)) {
    throw new WorkflowError(400, `Reason must be one of: ${INCOMPLETE_REASONS.join(', ')}`);
  }

  const ref = caseRef(id);
  const ts = now();
  const triggers = [];

  transaction(db, () => {
    const set = { updated_at: ts };
    if (rule.to) set.status = rule.to;
    let detail = null;

    switch (action) {
      case 'claim':
        set.assigned_to = user.id;
        break;
      case 'release':
        set.assigned_to = null;
        break;
      case 'log_call':
        set.call_attempts = row.call_attempts + 1;
        set.assigned_to = row.assigned_to ?? user.id;
        if (row.status === STATUS.PENDING) set.status = STATUS.IN_VERIFICATION;
        detail = outcome;
        break;
      case 'complete':
        Object.assign(set, { assigned_to: row.assigned_to ?? user.id, verified_by: user.id, verified_at: ts });
        notify(db, [row.created_by], id, `${ref} (${row.customer_name}) was verified by ${user.name}`);
        break;
      case 'mark_incomplete':
        Object.assign(set, {
          assigned_to: row.assigned_to ?? user.id,
          incomplete_reason: reason,
          incomplete_note: note,
          incomplete_at: ts,
          tl_action: null,
          tl_note: null,
          tl_actioned_by: null,
          tl_actioned_at: null,
        });
        detail = reason;
        notify(
          db,
          activeUserIds(db, 'team_leader'),
          id,
          `Action required: ${ref} (${row.customer_name}) marked incomplete by ${user.name} — ${reason.replace(/_/g, ' ')}`
        );
        triggers.push({
          event: 'case.incomplete',
          case_id: id,
          ref,
          customer_name: row.customer_name,
          reason,
          note,
          marked_by: user.name,
          at: ts,
        });
        break;
      case 'return_to_sales':
      case 'reverify':
      case 'reject':
        Object.assign(set, { tl_action: action, tl_note: note, tl_actioned_by: user.id, tl_actioned_at: ts });
        if (action === 'reverify') {
          set.assigned_to = null;
          notify(db, [row.assigned_to], id, `${ref} was sent back for re-verification by ${user.name}`);
        } else if (action === 'return_to_sales') {
          notify(db, [row.created_by], id, `${ref} (${row.customer_name}) was returned to you: ${note}`);
        } else {
          notify(db, [row.created_by, row.assigned_to], id, `${ref} (${row.customer_name}) was rejected by ${user.name}`);
        }
        break;
      case 'resubmit':
        set.assigned_to = null;
        break;
    }

    const cols = Object.keys(set);
    db.prepare(`UPDATE cases SET ${cols.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(
      ...cols.map((c) => set[c]),
      id
    );
    addEvent(db, id, user.id, action, { from: row.status, to: set.status ?? null, detail, note });
  });

  return { case: getCase(db, user, id), triggers };
}

export function stats(db, user) {
  const scope = user.role === 'sales' ? 'WHERE created_by = ?' : '';
  const params = user.role === 'sales' ? [user.id] : [];
  const byStatus = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM cases ${scope} GROUP BY status`).all(...params)) {
    byStatus[r.status] = r.n;
  }
  const result = { by_status: byStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  if (user.role === 'processing') {
    result.my_queue = db
      .prepare('SELECT COUNT(*) AS n FROM cases WHERE assigned_to = ? AND status = ?')
      .get(user.id, STATUS.IN_VERIFICATION).n;
  }
  if (user.role === 'team_leader') {
    result.processors = db
      .prepare(
        `SELECT u.name,
           SUM(CASE WHEN e.type = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN e.type = 'mark_incomplete' THEN 1 ELSE 0 END) AS incomplete,
           SUM(CASE WHEN e.type = 'log_call' THEN 1 ELSE 0 END) AS calls
         FROM users u LEFT JOIN case_events e ON e.user_id = u.id
         WHERE u.role = 'processing' GROUP BY u.id ORDER BY u.name`
      )
      .all();
    result.sales = db
      .prepare(
        `SELECT u.name, COUNT(c.id) AS sourced,
           SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM users u LEFT JOIN cases c ON c.created_by = u.id
         WHERE u.role = 'sales' GROUP BY u.id ORDER BY u.name`
      )
      .all();
  }
  return result;
}

export function listNotifications(db, user) {
  const items = db
    .prepare('SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50')
    .all(user.id)
    .map((n) => ({ ...n, ref: n.case_id ? caseRef(n.case_id) : null }));
  const unread = db.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND is_read = 0').get(user.id).n;
  return { unread, items };
}

export function markNotificationsRead(db, user, ids) {
  if (Array.isArray(ids) && ids.length) {
    const stmt = db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ? AND id = ?');
    for (const id of ids) stmt.run(user.id, Number(id));
  } else {
    db.prepare('UPDATE notifications SET is_read = 1 WHERE user_id = ?').run(user.id);
  }
}
