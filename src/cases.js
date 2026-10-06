import { transaction } from './db.js';
import { CREDIT_CARD_NAMES } from './credit-cards.js';

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

export const PRODUCTS = {
  personal_loan: 'Personal Loan',
  credit_card: 'Credit Card',
  auto_loan: 'Auto Loan',
  accounts: 'Accounts',
};
export const PRODUCT_TYPES = [...Object.keys(PRODUCTS), 'bundle'];

export const PERSONAL_LOAN_TYPES = { top_up: 'Top Up', buy_out: 'Buy Out', fresh: 'Fresh' };

// Case status is separate from verification: a sourced file starts as "Sent to checker" and only
// these roles can move it on. Sales staff can never change it.
export const CASE_STATUS = {
  sent_to_check: 'Sent to checker',
  applicant_review: 'Applicant review',
  completed: 'Completed',
  rejected: 'Rejected',
};
export const SETTABLE_CASE_STATUSES = ['applicant_review', 'completed', 'rejected'];
// Processors only mark the verification result; they never change the case status.
export const CASE_STATUS_ROLES = ['team_leader', 'mis', 'sales_manager', 'business_head'];
// Where a sales person can send a case in Applicant review to have its details corrected.
export const EDIT_QUEUES = { team_leader: 'Team Leader', sales_manager: 'Sales Manager' };
const EDITOR_ROLES = ['team_leader', 'sales_manager'];
const CASE_ACTIONS = ['set_case_status', 'request_edit', 'resolve_edit_request'];

export function productLabel(product, bundleProducts, creditCard, loanType, buyoutBank) {
  const name = (p) => {
    if (p === 'credit_card' && creditCard) return `Credit Card (${creditCard})`;
    if (p === 'personal_loan' && loanType === 'buy_out' && buyoutBank) return `Personal Loan (Buy Out from ${buyoutBank})`;
    if (p === 'personal_loan' && PERSONAL_LOAN_TYPES[loanType]) return `Personal Loan (${PERSONAL_LOAN_TYPES[loanType]})`;
    return PRODUCTS[p] || p;
  };
  if (product === 'bundle') {
    const items = String(bundleProducts || '').split(',').filter(Boolean).map(name);
    return items.length ? `Bundle: ${items.join(' + ')}` : 'Bundle';
  }
  return product ? name(product) : null;
}

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
  // "Verification pending" in the UI: the processor could not finish and a team leader must decide.
  mark_incomplete: { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: STATUS.INCOMPLETE, noteRequired: true },
  reject_verification: { roles: ['processing'], from: OPEN_FOR_PROCESSING, to: STATUS.REJECTED, noteRequired: true },
  return_to_sales: { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.RETURNED, noteRequired: true },
  reverify:        { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.PENDING },
  reject:          { roles: ['team_leader'], from: [STATUS.INCOMPLETE],   to: STATUS.REJECTED, noteRequired: true },
  resubmit:        { roles: ['sales'],       from: [STATUS.RETURNED],     to: STATUS.PENDING },
};

// Plain text fields and their length limits; name, product and number fields are validated separately.
const TEXT_FIELDS = {
  first_name: 100, middle_name: 100, last_name: 100, company_name: 200,
  phone: 30, alt_phone: 30, email: 200, address: 2000, city: 100, source: 200, sales_notes: 2000,
  eid_number: 30, passport_number: 30, bidaya_id: 50, app_id: 50,
};
const PRODUCT_FIELDS = [
  'product', 'bundle_products', 'credit_card', 'personal_loan_type', 'buyout_bank',
  'loan_amount', 'interest_rate', 'full_loan_amount', 'incremental_amount',
];
const EDITABLE_FIELDS = [...Object.keys(TEXT_FIELDS), 'customer_name', 'salary', 'amount', 'sourcing_date', ...PRODUCT_FIELDS];

export const caseRef = (id) => `CRM-${String(id).padStart(6, '0')}`;

const now = () => new Date().toISOString();

function clean(value, max = 500) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

function parseNumber(value, label, { required = false, min = 0, max = Infinity, positive = false } = {}) {
  const text = value === undefined || value === null ? '' : String(value).replace(/,/g, '').trim();
  if (!text) {
    if (required) throw new WorkflowError(400, `${label} is required`);
    return null;
  }
  const n = Number(text);
  if (!Number.isFinite(n) || n < min || n > max || (positive && n <= 0)) {
    throw new WorkflowError(400, `${label} must be a number${positive ? ' greater than 0' : ''}${max < Infinity ? ` up to ${max}` : ''}`);
  }
  return n;
}

function validateProduct(input, current, out) {
  const pick = (f) => (f in input ? input[f] : current?.[f]);
  const product = 'product' in input ? clean(input.product) : current?.product;
  if (!PRODUCT_TYPES.includes(product)) {
    throw new WorkflowError(400, 'Choose a product: Personal Loan, Credit Card, Auto Loan, Accounts or Bundle');
  }
  out.product = product;
  out.bundle_products = null;
  if (product === 'bundle') {
    const raw = pick('bundle_products');
    const picked = new Set((Array.isArray(raw) ? raw : String(raw ?? '').split(',')).map((p) => String(p).trim()).filter(Boolean));
    for (const p of picked) if (!PRODUCTS[p]) throw new WorkflowError(400, `Unknown bundle product: ${p}`);
    if (picked.size < 2) throw new WorkflowError(400, 'A bundle needs at least two products');
    // Stored in a fixed order so the same bundle always reads the same way.
    out.bundle_products = Object.keys(PRODUCTS).filter((p) => picked.has(p)).join(',');
  }

  const includes = (p) => product === p || String(out.bundle_products).split(',').includes(p);

  Object.assign(out, {
    personal_loan_type: null, buyout_bank: null,
    loan_amount: null, interest_rate: null, full_loan_amount: null, incremental_amount: null,
  });
  if (includes('personal_loan')) {
    const type = clean(pick('personal_loan_type'));
    if (!PERSONAL_LOAN_TYPES[type]) throw new WorkflowError(400, 'Choose the personal loan type: Top Up, Buy Out or Fresh');
    out.personal_loan_type = type;
    out.loan_amount = parseNumber(pick('loan_amount'), 'Loan amount', { required: true, positive: true });
    out.interest_rate = parseNumber(pick('interest_rate'), 'Interest rate', { required: true, max: 100 });
    if (type === 'buy_out') {
      // Any bank name is accepted so a lender missing from the list never blocks a case.
      const bank = clean(pick('buyout_bank'), 200);
      if (!bank) throw new WorkflowError(400, 'Choose which bank the loan is being bought out from');
      out.buyout_bank = bank;
    }
    if (type === 'top_up') {
      out.full_loan_amount = parseNumber(pick('full_loan_amount'), 'Full loan amount', { required: true, positive: true });
      out.incremental_amount = parseNumber(pick('incremental_amount'), 'Incremental amount', { required: true, positive: true });
      if (out.incremental_amount > out.full_loan_amount) {
        throw new WorkflowError(400, 'Incremental amount cannot be more than the full loan amount');
      }
    }
  }

  out.credit_card = null;
  if (includes('credit_card')) {
    const card = clean(pick('credit_card'));
    if (!card) throw new WorkflowError(400, 'Choose which credit card the customer wants');
    if (!CREDIT_CARD_NAMES.has(card)) throw new WorkflowError(400, `Unknown credit card: ${card}`);
    out.credit_card = card;
  }
}

function validateCaseInput(input, { partial = false, current = null } = {}) {
  input = { ...input };
  // Older API clients send one customer_name; split it into first / middle / last.
  if (!partial && !input.first_name && !input.last_name && input.customer_name) {
    const parts = String(input.customer_name).trim().split(/\s+/);
    input.first_name = parts.shift();
    input.last_name = parts.pop() ?? '';
    input.middle_name = parts.join(' ');
  }

  const out = {};
  const has = (f) => !partial || f in input;
  for (const [field, max] of Object.entries(TEXT_FIELDS)) if (has(field)) out[field] = clean(input[field], max);

  if (['first_name', 'middle_name', 'last_name'].some(has)) {
    const name = (f) => (f in out ? out[f] : current?.[f] ?? null);
    if (!name('first_name')) throw new WorkflowError(400, 'Customer first name is required');
    if (!name('last_name')) throw new WorkflowError(400, 'Customer last name is required');
    out.customer_name = [name('first_name'), name('middle_name'), name('last_name')].filter(Boolean).join(' ');
  }

  for (const field of ['phone', 'alt_phone']) {
    if (!has(field)) continue;
    if (field === 'phone' && !out.phone) throw new WorkflowError(400, 'Mobile number is required');
    if (out[field]) {
      const digits = out[field].replace(/\D/g, '');
      if (!/^[+\d][\d\s\-()]*$/.test(out[field]) || digits.length < 7 || digits.length > 15) {
        throw new WorkflowError(400, `Invalid ${field === 'phone' ? 'mobile' : 'alternate phone'} number`);
      }
    }
  }

  if (out.eid_number) {
    // Emirates ID: 15 digits starting 784, stored as 784-YYYY-NNNNNNN-C.
    const d = out.eid_number.replace(/[\s-]/g, '');
    if (!/^784\d{12}$/.test(d)) throw new WorkflowError(400, 'Emirates ID must be 15 digits starting with 784 (784-YYYY-NNNNNNN-C)');
    out.eid_number = `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}`;
  }
  if (out.passport_number) {
    out.passport_number = out.passport_number.replace(/\s/g, '').toUpperCase();
    if (!/^[A-Z0-9]{5,20}$/.test(out.passport_number)) throw new WorkflowError(400, 'Passport number should be 5–20 letters and digits');
  }
  if (out.email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out.email)) throw new WorkflowError(400, 'Invalid email address');
  if (has('salary')) out.salary = parseNumber(input.salary, 'Salary');
  if (has('sourcing_date')) {
    const date = clean(input.sourcing_date) ?? (partial ? null : now().slice(0, 10));
    if (!date) throw new WorkflowError(400, 'Sourcing date is required');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new WorkflowError(400, 'Sourcing date must be a valid date');
    // One day of slack so a file sourced late in the evening in the UAE is not "in the future" in UTC.
    if (Date.parse(date) > Date.now() + 864e5) throw new WorkflowError(400, 'Sourcing date cannot be in the future');
    out.sourcing_date = date;
  }
  if (partial ? 'amount' in input : input.amount !== undefined) out.amount = parseNumber(input.amount, 'Amount');

  if (!partial || PRODUCT_FIELDS.some((f) => f in input)) validateProduct(input, current, out);
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
         vb.name AS verified_by_name, tb.name AS tl_actioned_by_name,
         sb.name AS case_status_by_name, rb.name AS edit_request_by_name
  FROM cases c
  JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users at ON at.id = c.assigned_to
  LEFT JOIN users vb ON vb.id = c.verified_by
  LEFT JOIN users tb ON tb.id = c.tl_actioned_by
  LEFT JOIN users sb ON sb.id = c.case_status_by
  LEFT JOIN users rb ON rb.id = c.edit_request_by`;

const withRef = (row) => row && { ...row, ref: caseRef(row.id), product_label: productLabel(row.product, row.bundle_products, row.credit_card, row.personal_loan_type, row.buyout_bank) };

// Personal details that only some people may see once a file is submitted.
export const SENSITIVE_FIELDS = ['company_name', 'salary', 'eid_number', 'passport_number'];

// Verification states in which processors still need the personal details: before and during the
// call, and while verification is Pending (it may come back to them).
const PROCESSOR_SENSITIVE_STATUSES = [...OPEN_FOR_PROCESSING, STATUS.INCOMPLETE];

/**
 * Team leaders never see these on a submitted file. Processors see them until verification is
 * Completed or Rejected (or the file has been returned to sales).
 */
export function canViewSensitive(user, row) {
  if (user.role === 'team_leader') return false;
  if (user.role === 'processing') return PROCESSOR_SENSITIVE_STATUSES.includes(row.status);
  return true;
}

// Strips sensitive fields the viewer may not see, before anything leaves the server.
function present(user, row) {
  const out = withRef(row);
  if (!out || canViewSensitive(user, row)) return out ? { ...out, hidden_fields: [] } : out;
  for (const f of SENSITIVE_FIELDS) out[f] = null;
  out.hidden_fields = SENSITIVE_FIELDS;
  return out;
}

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
  return { ...present(user, row), events, allowed_actions: allowedActions(user, row), can_edit: canEdit(user, row) };
}

export function listCases(db, user, { status, case_status, edit_requests, q, assigned, limit = 200 } = {}) {
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
  if (case_status) {
    const statuses = String(case_status).split(',').filter((s) => CASE_STATUS[s]);
    if (statuses.length) {
      where.push(`c.case_status IN (${statuses.map(() => '?').join(',')})`);
      params.push(...statuses);
    }
  }
  if (edit_requests === 'mine') {
    // Team leaders and sales managers each work the edit requests addressed to their queue.
    where.push('c.edit_request_to = ?');
    params.push(user.role);
  }
  if (assigned === 'me') {
    where.push('c.assigned_to = ?');
    params.push(user.id);
  }
  if (q) {
    const term = `%${String(q).trim()}%`;
    const idMatch = String(q).match(/^(?:crm-)?0*(\d+)$/i);
    // Searching sensitive fields is limited to files where the viewer may see them, so a match
    // cannot reveal a hidden Emirates ID, passport number or employer.
    const sensitive = '(c.company_name LIKE ? OR c.eid_number LIKE ? OR REPLACE(c.eid_number, \'-\', \'\') LIKE ? OR c.passport_number LIKE ?)';
    let sensitiveClause = '';
    if (user.role === 'processing') {
      sensitiveClause = ` OR (c.status IN (${PROCESSOR_SENSITIVE_STATUSES.map(() => '?').join(',')}) AND ${sensitive})`;
    } else if (user.role !== 'team_leader') {
      sensitiveClause = ` OR ${sensitive}`;
    }
    where.push(`(c.customer_name LIKE ? OR c.phone LIKE ? OR c.email LIKE ? OR c.city LIKE ? OR c.credit_card LIKE ? OR c.buyout_bank LIKE ?
      OR c.bidaya_id LIKE ? OR c.app_id LIKE ?${sensitiveClause}${idMatch ? ' OR c.id = ?' : ''})`);
    params.push(...Array(8).fill(term));
    if (user.role === 'processing') params.push(...PROCESSOR_SENSITIVE_STATUSES);
    if (sensitiveClause) params.push(...Array(4).fill(term));
    if (idMatch) params.push(Number(idMatch[1]));
  }
  const sql = `${CASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY c.updated_at DESC LIMIT ?`;
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map((row) => present(user, row));
}

export function createCase(db, user, input) {
  if (!['sales', 'team_leader', 'sales_manager'].includes(user.role)) {
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
    addEvent(db, id, user.id, 'created', { to: STATUS.PENDING, detail: 'sent_to_check' });
    return getCase(db, user, id);
  });
}

function canEdit(user, row) {
  const closed = ['completed', 'rejected'].includes(row.case_status) || row.status === STATUS.REJECTED;
  if (EDITOR_ROLES.includes(user.role)) return !closed;
  if (user.role === 'sales') {
    // Once the file is under review, sales must ask a team leader or sales manager to make changes.
    return row.created_by === user.id && row.case_status === 'sent_to_check' && [STATUS.PENDING, STATUS.RETURNED].includes(row.status);
  }
  return false;
}

export function updateCase(db, user, id, input) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!canEdit(user, row)) throw new WorkflowError(403, 'This case can no longer be edited');
  const data = validateCaseInput(input, { partial: true, current: row });
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

function allowedCaseActions(user, row) {
  const out = [];
  if (CASE_STATUS_ROLES.includes(user.role)) out.push('set_case_status');
  if (user.role === 'sales' && row.created_by === user.id && row.case_status === 'applicant_review') out.push('request_edit');
  if (row.edit_request_to && (user.role === row.edit_request_to || user.role === 'team_leader')) out.push('resolve_edit_request');
  return out;
}

export function allowedActions(user, row) {
  return [...verificationActions(user, row), ...allowedCaseActions(user, row)];
}

function verificationActions(user, row) {
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
export function applyAction(db, user, id, { action, note, outcome, reason, case_status, to } = {}) {
  if (CASE_ACTIONS.includes(action)) return applyCaseAction(db, user, id, { action, note, case_status, to });
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
  if (action === 'reject_verification' && reason && !INCOMPLETE_REASONS.includes(reason)) {
    throw new WorkflowError(400, `Reason must be one of: ${INCOMPLETE_REASONS.join(', ')}`);
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
        notify(db, [row.created_by], id, `${ref} (${row.customer_name}) verification completed by ${user.name}`);
        break;
      case 'reject_verification':
        // Verification failing does not change the case status; that stays a separate decision.
        Object.assign(set, { assigned_to: row.assigned_to ?? user.id, incomplete_reason: reason || null, incomplete_note: note, incomplete_at: ts });
        detail = reason || null;
        notify(db, [row.created_by, ...activeUserIds(db, 'team_leader')], id,
          `${ref} (${row.customer_name}) verification rejected by ${user.name}: ${note}`);
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
          `Action required: ${ref} (${row.customer_name}) verification pending, marked by ${user.name} — ${reason.replace(/_/g, ' ')}`
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

function applyCaseAction(db, user, id, { action, note, case_status, to }) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!allowedCaseActions(user, row).includes(action)) throw new WorkflowError(403, 'Your role cannot do that on this case');
  note = clean(note, 2000);
  const ref = caseRef(id);
  const ts = now();
  const who = `${user.name}`;

  transaction(db, () => {
    if (action === 'set_case_status') {
      if (!SETTABLE_CASE_STATUSES.includes(case_status)) {
        throw new WorkflowError(400, 'Choose a case status: Applicant review, Completed or Rejected');
      }
      if (case_status === row.case_status) throw new WorkflowError(409, `The case is already ${CASE_STATUS[case_status]}`);
      if (case_status !== 'completed' && !note) throw new WorkflowError(400, `Add a note explaining why the case is ${CASE_STATUS[case_status]}`);
      db.prepare('UPDATE cases SET case_status = ?, case_status_note = ?, case_status_by = ?, case_status_at = ?, updated_at = ? WHERE id = ?')
        .run(case_status, note, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'case_status', { detail: case_status, note });
      const label = CASE_STATUS[case_status];
      notify(db, [row.created_by], id, `${ref} (${row.customer_name}) case status changed to ${label} by ${who}${note ? `: ${note}` : ''}`);
      if (case_status === 'applicant_review') {
        notify(db, activeUserIds(db, 'team_leader').filter((u) => u !== user.id), id,
          `Applicant review: ${ref} (${row.customer_name}) set by ${who}${note ? ` — ${note}` : ''}`);
      }
    } else if (action === 'request_edit') {
      if (!EDIT_QUEUES[to]) throw new WorkflowError(400, 'Send the request to the Team Leader or Sales Manager queue');
      if (!note) throw new WorkflowError(400, 'Describe the changes that are needed');
      db.prepare('UPDATE cases SET edit_request_to = ?, edit_request_note = ?, edit_request_by = ?, edit_request_at = ?, updated_at = ? WHERE id = ?')
        .run(to, note, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'request_edit', { detail: to, note });
      notify(db, activeUserIds(db, to), id, `Edit request: ${ref} (${row.customer_name}) from ${who} — ${note}`);
    } else if (action === 'resolve_edit_request') {
      db.prepare('UPDATE cases SET edit_request_to = NULL, edit_request_note = NULL, edit_request_by = NULL, edit_request_at = NULL, updated_at = ? WHERE id = ?')
        .run(ts, id);
      addEvent(db, id, user.id, 'resolve_edit_request', { detail: row.edit_request_to, note });
      notify(db, [row.edit_request_by], id, `${ref} (${row.customer_name}): your requested changes were made by ${who}${note ? ` — ${note}` : ''}`);
    }
  });
  return { case: getCase(db, user, id), triggers: [] };
}

export function stats(db, user) {
  const scope = user.role === 'sales' ? 'WHERE created_by = ?' : '';
  const params = user.role === 'sales' ? [user.id] : [];
  const byStatus = Object.fromEntries(Object.values(STATUS).map((s) => [s, 0]));
  for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM cases ${scope} GROUP BY status`).all(...params)) {
    byStatus[r.status] = r.n;
  }
  const byCaseStatus = Object.fromEntries(Object.keys(CASE_STATUS).map((s) => [s, 0]));
  for (const r of db.prepare(`SELECT case_status, COUNT(*) AS n FROM cases ${scope} GROUP BY case_status`).all(...params)) {
    byCaseStatus[r.case_status] = r.n;
  }
  const result = { by_status: byStatus, by_case_status: byCaseStatus, total: Object.values(byStatus).reduce((a, b) => a + b, 0) };
  if (EDITOR_ROLES.includes(user.role)) {
    result.edit_requests = db.prepare('SELECT COUNT(*) AS n FROM cases WHERE edit_request_to = ?').get(user.role).n;
  }
  if (user.role === 'processing') {
    result.my_queue = db
      .prepare('SELECT COUNT(*) AS n FROM cases WHERE assigned_to = ? AND status = ?')
      .get(user.id, STATUS.IN_VERIFICATION).n;
  }
  if (['team_leader', 'sales_manager', 'mis', 'business_head'].includes(user.role)) {
    result.processors = db
      .prepare(
        `SELECT u.name,
           SUM(CASE WHEN e.type = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN e.type = 'mark_incomplete' THEN 1 ELSE 0 END) AS incomplete,
           SUM(CASE WHEN e.type = 'reject_verification' THEN 1 ELSE 0 END) AS rejected,
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
