import { randomBytes } from 'node:crypto';
import { transaction } from './db.js';
import { CREDIT_CARD_NAMES } from './credit-cards.js';
import { findUser } from './users.js';
import { cycleRange, isCycle, uaeDay } from './cycles.js';

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
// A "call back later" outcome needs the date and time the customer asked for, up to this far ahead.
export const CALLBACK_MAX_DAYS = 30;

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
// How a credit card was sold: first year free, full annual fee, or free for life.
export const CARD_FEE_TYPES = { fyf: 'FYF (first year free)', full_fee: 'Full fee', ffl: 'FFL (free for life)' };
// A personal loan's FPD (first payment date) can be this far after the sourcing date.
export const FPD_MAX_DAYS = 365;

// A completed case is a temp end for credit cards and a disbursal for loans. After a card's temp
// end, MIS maps whether the card was activated.
export const CARD_STATUS = { active: 'Active', inactive: 'Inactive' };
// An inactive card this many days or more after its temp end moves to Out of activation range
// on its own. MIS can still mark it Active if the customer activates later.
export const CARD_RANGE_DAYS = 90;
export const CARD_STATES = { ...CARD_STATUS, out_of_range: 'Out of activation range' };
export const CARD_MAPPERS = ['mis', 'business_head'];
/** The products a case counts for: a bundle counts once for each product in it. */
export const caseProducts = (row) => (row.product === 'bundle' ? String(row.bundle_products || '').split(',').filter(Boolean) : [row.product]);
export const includesCard = (row) => caseProducts(row).includes('credit_card');

// Loans are measured by the amount disbursed. A completed loan case records it; the form's amount
// is the suggestion (the incremental amount for a top-up, which is the new money paid out).
export const DISBURSAL_FIELDS = { personal_loan: 'pl_disbursed_amount', auto_loan: 'al_disbursed_amount' };
export const suggestedDisbursal = (row, product) => (product === 'personal_loan'
  ? (row.personal_loan_type === 'top_up' ? row.incremental_amount : row.loan_amount) ?? null
  : row.amount ?? null);

/** Disbursed amounts for the loans in a case, from the input or the suggestion. */
function disbursals(row, input, { required }) {
  const out = {};
  for (const [product, field] of Object.entries(DISBURSAL_FIELDS)) {
    if (!caseProducts(row).includes(product)) continue;
    const label = `${PRODUCTS[product]} disbursed amount`;
    const given = input[field];
    const value = given === undefined || given === '' || given === null
      ? (required ? suggestedDisbursal(row, product) : row[field])
      : parseNumber(given, label, { positive: true });
    if (value == null && required) throw new WorkflowError(400, `Enter the ${label.toLowerCase()} (AED)`);
    out[field] = value;
  }
  return out;
}
// SQL for "this case includes a credit card" and "completed between UAE dates ? and ?".
export const CARD_SQL = "(c.product = 'credit_card' OR (c.product = 'bundle' AND ',' || c.bundle_products || ',' LIKE '%,credit_card,%'))";
export const COMPLETED_IN_SQL = "c.case_status = 'completed' AND date(c.case_status_at, '+4 hours') BETWEEN ? AND ?";

export const REGIONS = { DXB: 'DXB (Dubai)', AUH: 'AUH (Abu Dhabi)' };
export const CORE_PRODUCTS = {
  credit_card: 'Credit Card',
  personal_loan: 'Personal Loan',
  auto_loan: 'Auto Loan',
  multi_product: 'Multi product',
};

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
// Governance: quality checks, call recordings, complaint numbers and call-quality scores.
const GOVERNANCE_ACTIONS = [
  'mark_qc', 'clear_qc', 'set_complaint', 'score_quality', 'flag_urgent', 'clear_urgent',
  'request_recording', 'approve_recording', 'decline_recording', 'receive_recording',
];

// Call recordings: governance asks, the business head approves, IT is emailed for the file,
// and governance records it once received.
export const RECORDING_STATUS = {
  pending_approval: 'Awaiting business head approval',
  approved: 'Approved, requested from IT',
  declined: 'Declined by business head',
  received: 'Recording received',
};

// Where approved recording requests are emailed. Set by the server from IT_EMAIL.
export const config = { itEmail: null, callBot: false };

// A bot call with no result after this long no longer blocks placing another one.
export const BOT_CALL_TIMEOUT_MINUTES = 30;
const BOT_CALL_OPEN = ['requested', 'in_progress'];
const botCallPending = (row) => BOT_CALL_OPEN.includes(row.bot_call_status)
  && Date.now() - Date.parse(row.bot_call_at) < BOT_CALL_TIMEOUT_MINUTES * 60_000;

export function recordingEmail(row) {
  const lines = [
    'Hello IT team,',
    '',
    `Please share the call recording for the verification call on ${caseRef(row.id)}.`,
    '',
    `Customer: ${row.customer_name}`,
    `Mobile number called: ${row.phone}`,
    `Verified by: ${row.assigned_to_name || '—'}${row.verified_at ? ` on ${row.verified_at.slice(0, 10)}` : ''}`,
    `Requested by: ${row.recording_requested_by_name || '—'} (Governance)`,
    `Reason: ${row.recording_request_note || '—'}`,
    `Approved by: ${row.recording_decided_by_name || '—'} (Business Head)`,
    '',
    'Please reply with the file or a link to it.',
  ];
  return { to: config.itEmail, subject: `Call recording request: ${caseRef(row.id)} (${row.customer_name})`, body: lines.join('\n') };
}

// Call-quality scores are out of 10, with at most one decimal place.
export const SCORE_MAX = 10;
const CASE_ACTIONS = ['set_case_status', 'set_disbursal', 'request_edit', 'resolve_edit_request', 'set_card_status', ...GOVERNANCE_ACTIONS];
// Internal quality information that sales staff never see.
const GOVERNANCE_FIELDS = [
  'qc_flag', 'qc_note', 'qc_by', 'qc_at', 'qc_by_name',
  'recording_status', 'recording_request_note', 'recording_requested_by', 'recording_requested_at', 'recording_requested_by_name',
  'recording_ref', 'recording_provided_by', 'recording_provided_at', 'recording_provided_by_name',
  'recording_decided_by', 'recording_decided_at', 'recording_decision_note', 'recording_decided_by_name', 'recording_it_email_at', 'recording_email',
  'complaint_number', 'complaint_by', 'complaint_at', 'complaint_by_name',
  'urgent_flag', 'urgent_note', 'urgent_by', 'urgent_at', 'urgent_by_name',
  'qc_score', 'qc_score_note', 'qc_scored_by', 'qc_scored_at', 'qc_scored_by_name',
];

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
// Verification has a final result only when Completed or Rejected; anything else is still being verified.
const VERIFICATION_FINAL = [STATUS.COMPLETED, STATUS.REJECTED];
const STILL_VERIFYING = [STATUS.PENDING, STATUS.IN_VERIFICATION, STATUS.INCOMPLETE, STATUS.RETURNED];

/**
 * Every state change goes through this table. `to: null` means the action is
 * logged but does not move the case.
 */
export const ACTIONS = {
  claim:           { roles: ['processing'],  from: [STATUS.PENDING],      to: STATUS.IN_VERIFICATION },
  release:         { roles: ['processing'],  from: [STATUS.IN_VERIFICATION], to: STATUS.PENDING },
  log_call:        { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: null },
  // Asks the calling bot to phone the customer; its result is logged like a call (see bot.js).
  bot_call:        { roles: ['processing'],  from: OPEN_FOR_PROCESSING,   to: null },
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
  'product', 'bundle_products', 'credit_card', 'card_fee_type', 'personal_loan_type', 'buyout_bank',
  'loan_amount', 'interest_rate', 'full_loan_amount', 'incremental_amount', 'fpd',
];
// Snapshot of the sales person's profile, copied onto the file when it is sourced.
const SALES_STAFF_FIELDS = ['sales_staff_id', 'sales_staff_name', 'sales_code', 'team_leader_name', 'sales_manager_name'];
// Details the processor confirmed with the customer. Changing any of them after verification is
// completed sends the file back for a fresh verification.
export const VERIFIED_FIELDS = ['product', 'bundle_products', 'credit_card', 'card_fee_type', 'personal_loan_type', 'buyout_bank', 'loan_amount', 'interest_rate', 'full_loan_amount', 'incremental_amount', 'fpd'];
const VERIFIED_FIELD_LABELS = {
  product: 'product', bundle_products: 'bundle products', credit_card: 'credit card', card_fee_type: 'card sourced type', personal_loan_type: 'loan type', buyout_bank: 'buy-out bank',
  loan_amount: 'loan amount', interest_rate: 'interest rate', full_loan_amount: 'full loan amount', incremental_amount: 'incremental amount', fpd: 'FPD',
};
const EDITABLE_FIELDS = [
  ...Object.keys(TEXT_FIELDS), 'customer_name', 'salary', 'amount', 'sourcing_date', 'region', 'core_product',
  ...PRODUCT_FIELDS, ...SALES_STAFF_FIELDS,
];

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
    loan_amount: null, interest_rate: null, full_loan_amount: null, incremental_amount: null, fpd: null,
  });
  if (includes('personal_loan')) {
    const type = clean(pick('personal_loan_type'));
    if (!PERSONAL_LOAN_TYPES[type]) throw new WorkflowError(400, 'Choose the personal loan type: Top Up, Buy Out or Fresh');
    out.personal_loan_type = type;
    // FPD: the first payment date, on or after the sourcing date and within a year of it.
    const fpd = clean(pick('fpd'), 10);
    if (!fpd) throw new WorkflowError(400, 'Enter the FPD (first payment date) for the personal loan');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(fpd) || Number.isNaN(Date.parse(fpd))) throw new WorkflowError(400, 'FPD must be a valid date');
    const sourced = out.sourcing_date ?? current?.sourcing_date ?? null;
    if (sourced && fpd < sourced) throw new WorkflowError(400, 'FPD cannot be before the sourcing date');
    if (sourced && Date.parse(fpd) > Date.parse(sourced) + FPD_MAX_DAYS * 864e5) throw new WorkflowError(400, 'FPD must be within a year of the sourcing date');
    out.fpd = fpd;
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
  out.card_fee_type = null;
  if (includes('credit_card')) {
    const card = clean(pick('credit_card'));
    if (!card) throw new WorkflowError(400, 'Choose which credit card the customer wants');
    if (!CREDIT_CARD_NAMES.has(card)) throw new WorkflowError(400, `Unknown credit card: ${card}`);
    out.credit_card = card;
    const fee = clean(pick('card_fee_type'));
    if (!CARD_FEE_TYPES[fee]) throw new WorkflowError(400, 'Choose the card sourced type: FYF, Full fee or FFL');
    out.card_fee_type = fee;
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

  if (has('region')) {
    const region = clean(input.region)?.toUpperCase() ?? null;
    if (!REGIONS[region]) throw new WorkflowError(400, 'Choose the region: DXB or AUH');
    out.region = region;
  }
  if (has('core_product')) {
    const core = clean(input.core_product);
    if (!CORE_PRODUCTS[core]) throw new WorkflowError(400, 'Choose the core product: Credit Card, Personal Loan, Auto Loan or Multi product');
    out.core_product = core;
  }
  if (!partial || PRODUCT_FIELDS.some((f) => f in input)) validateProduct(input, current, out);
  return out;
}

/** Copies the sales person's name, code, team leader and sales manager onto the file. */
function salesStaffSnapshot(db, staffId) {
  const staff = staffId ? findUser(db, Number(staffId)) : null;
  if (!staff || staff.role !== 'sales' || !staff.active) {
    throw new WorkflowError(400, 'Choose the sales staff member who sourced this file');
  }
  const missing = [!staff.sales_code && 'sales code', !staff.team_leader_name && 'team leader', !staff.sales_manager_name && 'sales manager'].filter(Boolean);
  if (missing.length) {
    throw new WorkflowError(400, `${staff.name}'s profile has no ${missing.join(', ')}. A team leader can add it on the Users page.`);
  }
  return {
    sales_staff_id: staff.id,
    sales_staff_name: staff.name,
    sales_code: staff.sales_code,
    team_leader_name: staff.team_leader_name,
    sales_manager_name: staff.sales_manager_name,
  };
}

// The sales person a file belongs to: the one named on it, or whoever entered it before that existed.
const ownerId = (row) => row.sales_staff_id ?? row.created_by;
const isOwner = (user, row) => row.created_by === user.id || row.sales_staff_id === user.id;

export function addEvent(db, caseId, userId, type, { from = null, to = null, detail = null, note = null } = {}) {
  db.prepare(
    'INSERT INTO case_events (case_id, user_id, type, from_status, to_status, detail, note, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  ).run(caseId, userId, type, from, to, detail, note, now());
}

export function notify(db, userIds, caseId, message) {
  const stmt = db.prepare('INSERT INTO notifications (user_id, case_id, message, created_at) VALUES (?, ?, ?, ?)');
  for (const id of new Set(userIds.filter(Boolean))) stmt.run(id, caseId, message, now());
}

const activeUserIds = (db, role) =>
  db.prepare('SELECT id FROM users WHERE role = ? AND active = 1').all(role).map((r) => r.id);

const CASE_SELECT = `
  SELECT c.*, cb.name AS created_by_name, at.name AS assigned_to_name,
         vb.name AS verified_by_name, tb.name AS tl_actioned_by_name,
         sb.name AS case_status_by_name, rb.name AS edit_request_by_name,
         qb.name AS qc_by_name, rqb.name AS recording_requested_by_name, rpb.name AS recording_provided_by_name, rdb.name AS recording_decided_by_name, ub.name AS urgent_by_name,
         cpb.name AS complaint_by_name, scb.name AS qc_scored_by_name, csb.name AS card_status_by_name, cbb.name AS callback_by_name
  FROM cases c
  JOIN users cb ON cb.id = c.created_by
  LEFT JOIN users at ON at.id = c.assigned_to
  LEFT JOIN users vb ON vb.id = c.verified_by
  LEFT JOIN users tb ON tb.id = c.tl_actioned_by
  LEFT JOIN users sb ON sb.id = c.case_status_by
  LEFT JOIN users rb ON rb.id = c.edit_request_by
  LEFT JOIN users qb ON qb.id = c.qc_by
  LEFT JOIN users rqb ON rqb.id = c.recording_requested_by
  LEFT JOIN users rpb ON rpb.id = c.recording_provided_by
  LEFT JOIN users rdb ON rdb.id = c.recording_decided_by
  LEFT JOIN users ub ON ub.id = c.urgent_by
  LEFT JOIN users cpb ON cpb.id = c.complaint_by
  LEFT JOIN users scb ON scb.id = c.qc_scored_by
  LEFT JOIN users csb ON csb.id = c.card_status_by
  LEFT JOIN users cbb ON cbb.id = c.callback_by`;

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
  if (out && user.role === 'sales') for (const f of GOVERNANCE_FIELDS) delete out[f];
  if (!out || canViewSensitive(user, row)) return out ? { ...out, hidden_fields: [] } : out;
  for (const f of SENSITIVE_FIELDS) out[f] = null;
  out.hidden_fields = SENSITIVE_FIELDS;
  return out;
}

function canView(user, row) {
  return user.role !== 'sales' || isOwner(user, row);
}

function latestBotCall(db, caseId) {
  const call = db.prepare(
    `SELECT b.id, b.status, b.requested_at, b.finished_at, b.outcome, b.checks, b.summary, b.transcript, b.recording_url, b.error,
            u.name AS requested_by_name
     FROM bot_calls b JOIN users u ON u.id = b.requested_by WHERE b.case_id = ? ORDER BY b.id DESC LIMIT 1`
  ).get(caseId);
  return call && { ...call, checks: call.checks ? JSON.parse(call.checks) : [] };
}

export function getCase(db, user, id) {
  sweepCardAgeing(db);
  triggerDueCallbacks(db);
  const row = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  const events = db
    .prepare(
      `SELECT e.*, u.name AS user_name, u.role AS user_role FROM case_events e
       LEFT JOIN users u ON u.id = e.user_id WHERE e.case_id = ? ORDER BY e.id DESC`
    )
    .all(id);
  const out = { ...present(user, row), events, allowed_actions: allowedActions(user, row), can_edit: canEdit(user, row) };
  if (user.role !== 'sales' && row.bot_call_status) out.bot_call = latestBotCall(db, id);
  if (['governance', 'business_head'].includes(user.role) && ['approved', 'received'].includes(row.recording_status)) {
    out.recording_email = recordingEmail(row);
  }
  return out;
}

export function listCases(db, user, { status, case_status, edit_requests, qc, recording, urgent, q, assigned, card, cycle, staff, callbacks, limit = 200 } = {}) {
  sweepCardAgeing(db);
  triggerDueCallbacks(db);
  const where = [];
  const params = [];
  // Completed in a sales cycle (21st to 20th), e.g. a target's achievement.
  if (isCycle(cycle)) {
    const { start, end } = cycleRange(cycle);
    where.push(COMPLETED_IN_SQL);
    params.push(start, end);
  }
  // Card activation: completed credit card cases, optionally by mapping.
  if (card) {
    where.push(`c.case_status = 'completed' AND ${CARD_SQL}`);
    if (CARD_STATES[card]) {
      where.push('c.card_status = ?');
      params.push(card);
    } else if (card === 'unmapped') where.push('c.card_status IS NULL');
  }
  if (staff && Number(staff)) {
    where.push('c.sales_staff_id = ?');
    params.push(Number(staff));
  }
  if (user.role === 'sales') {
    where.push('(c.created_by = ? OR c.sales_staff_id = ?)');
    params.push(user.id, user.id);
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
  if (user.role !== 'sales') {
    if (qc === '1') where.push('c.qc_flag = 1');
    if (urgent === '1') {
      where.push(`c.urgent_flag = 1 AND c.status IN (${STILL_VERIFYING.map(() => '?').join(',')})`);
      params.push(...STILL_VERIFYING);
    }
    const rec = String(recording || '').split(',').filter((r) => RECORDING_STATUS[r]);
    if (rec.length) {
      where.push(`c.recording_status IN (${rec.map(() => '?').join(',')})`);
      params.push(...rec);
    }
  }
  if (assigned === 'me') {
    where.push('c.assigned_to = ?');
    params.push(user.id);
  }
  // Scheduled call-backs: all of them, only the ones already due, or only the upcoming ones.
  if (callbacks) {
    where.push(`c.callback_at IS NOT NULL AND c.status IN (${OPEN_FOR_PROCESSING.map(() => '?').join(',')})`);
    params.push(...OPEN_FOR_PROCESSING);
    if (callbacks === 'due') { where.push('c.callback_at <= ?'); params.push(now()); }
    if (callbacks === 'upcoming') { where.push('c.callback_at > ?'); params.push(now()); }
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
      OR c.bidaya_id LIKE ? OR c.app_id LIKE ? OR c.sales_code LIKE ? OR c.sales_staff_name LIKE ?${user.role === 'sales' ? '' : ' OR c.complaint_number LIKE ?'}${sensitiveClause}${idMatch ? ' OR c.id = ?' : ''})`);
    params.push(...Array(user.role === 'sales' ? 10 : 11).fill(term));
    if (user.role === 'processing') params.push(...PROCESSOR_SENSITIVE_STATUSES);
    if (sensitiveClause) params.push(...Array(4).fill(term));
    if (idMatch) params.push(Number(idMatch[1]));
  }
  const sql = `${CASE_SELECT} ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY ${callbacks ? 'c.callback_at ASC, ' : ''}${user.role === 'sales' ? '' : `(c.urgent_flag = 1 AND c.status IN (${STILL_VERIFYING.map((st) => `'${st}'`).join(',')})) DESC, `}${user.role === 'processing' && !callbacks ? `(c.callback_at IS NOT NULL AND c.callback_at <= '${now()}') DESC, ` : ''}c.updated_at DESC LIMIT ?`;
  params.push(Math.min(Number(limit) || 200, 1000));
  return db.prepare(sql).all(...params).map((row) => present(user, row));
}

export function createCase(db, user, input) {
  return transaction(db, () => getCase(db, user, insertCase(db, user, input)));
}

/** Validates and inserts a new file, returning its id. The caller runs it inside a transaction. */
export function insertCase(db, user, input, { bulk = false } = {}) {
  // MIS and business heads add files only by bulk upload (see imports.js), naming the sales person.
  const canAdd = ['sales', 'team_leader', 'sales_manager'].includes(user.role) || (bulk && ['mis', 'business_head'].includes(user.role));
  if (!canAdd) throw new WorkflowError(403, 'Only sales staff can add sourcing data');
  const data = validateCaseInput(input);
  // Sales staff source files as themselves; everyone else names the sales person.
  Object.assign(data, salesStaffSnapshot(db, user.role === 'sales' ? user.id : input.sales_staff_id));
  const ts = now();
  const cols = [...EDITABLE_FIELDS, 'status', 'created_by', 'created_at', 'updated_at'];
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO cases (${cols.join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`)
    .run(...EDITABLE_FIELDS.map((f) => data[f] ?? null), STATUS.PENDING, user.id, ts, ts);
  const id = Number(lastInsertRowid);
  addEvent(db, id, user.id, 'created', { to: STATUS.PENDING, detail: 'sent_to_check' });
  if (bulk) addEvent(db, id, user.id, 'bulk_upload', { detail: 'Added from a bulk upload file' });
  if (input.eid_scanned) addEvent(db, id, user.id, 'eid_scan', { detail: `${input.eid_scanned === 'back' ? 'back' : 'front'} of the card: name, Emirates ID number` });
  return id;
}

function canEdit(user, row) {
  const closed = ['completed', 'rejected'].includes(row.case_status) || row.status === STATUS.REJECTED;
  if (EDITOR_ROLES.includes(user.role)) return !closed;
  if (user.role === 'sales') {
    // Once the file is under review, sales must ask a team leader or sales manager to make changes.
    return isOwner(user, row) && row.case_status === 'sent_to_check' && [STATUS.PENDING, STATUS.RETURNED].includes(row.status);
  }
  return false;
}

export function updateCase(db, user, id, input) {
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!canEdit(user, row)) throw new WorkflowError(403, 'This case can no longer be edited');
  const data = validateCaseInput(input, { partial: true, current: row });
  if ('sales_staff_id' in input && Number(input.sales_staff_id) !== row.sales_staff_id) {
    if (!EDITOR_ROLES.includes(user.role)) throw new WorkflowError(403, 'Only a team leader or sales manager can change the sales staff on a file');
    Object.assign(data, salesStaffSnapshot(db, input.sales_staff_id));
  }
  const changed = Object.keys(data).filter((f) => (data[f] ?? null) !== (row[f] ?? null));
  if (!changed.length) return getCase(db, user, id);
  return transaction(db, () => {
    db.prepare(`UPDATE cases SET ${changed.map((f) => `${f} = ?`).join(', ')}, updated_at = ? WHERE id = ?`).run(
      ...changed.map((f) => data[f]),
      now(),
      id
    );
    addEvent(db, id, user.id, 'edited', { detail: changed.join(', ') });
    if (input.eid_scanned) addEvent(db, id, user.id, 'eid_scan', { detail: `${input.eid_scanned === 'back' ? 'back' : 'front'} of the card: name, Emirates ID number` });
    // Verified details changed after verification was completed: the customer must be called again.
    const reverify = row.status === STATUS.COMPLETED ? changed.filter((f) => VERIFIED_FIELDS.includes(f)) : [];
    if (reverify.length) {
      const what = reverify.map((f) => VERIFIED_FIELD_LABELS[f] || f).join(', ');
      const ts = now();
      db.prepare(`UPDATE cases SET status = ?, assigned_to = NULL, verified_by = NULL, verified_at = NULL, call_attempts = 0,
          callback_at = NULL, callback_notified_at = NULL, updated_at = ? WHERE id = ?`).run(STATUS.PENDING, ts, id);
      addEvent(db, id, user.id, 're_verification', { from: STATUS.COMPLETED, to: STATUS.PENDING, detail: what });
      const ref = caseRef(id);
      notify(db, [row.verified_by, ...activeUserIds(db, 'processing')], id,
        `Re-verification needed: ${ref} (${row.customer_name}) — ${what} changed by ${user.name} after verification`);
      notify(db, [ownerId(row), ...activeUserIds(db, 'team_leader')].filter((u) => u !== user.id), id,
        `${ref} (${row.customer_name}) goes back for verification: ${what} changed by ${user.name}`);
    }
    return getCase(db, user, id);
  });
}

function allowedCaseActions(user, row) {
  const out = [];
  if (CASE_STATUS_ROLES.includes(user.role)) out.push('set_case_status');
  const hasLoan = Object.keys(DISBURSAL_FIELDS).some((p) => caseProducts(row).includes(p));
  if (CASE_STATUS_ROLES.includes(user.role) && row.case_status === 'completed' && hasLoan) out.push('set_disbursal');
  if (user.role === 'sales' && isOwner(user, row) && row.case_status === 'applicant_review') out.push('request_edit');
  if (row.edit_request_to && (user.role === row.edit_request_to || user.role === 'team_leader')) out.push('resolve_edit_request');
  // Recordings and scores only make sense once the processor has recorded a verification result.
  const verified = !OPEN_FOR_PROCESSING.includes(row.status);
  // A recording can only be retrieved once verification has a final result. While it is still
  // awaiting, in progress or Pending, governance flags the file for urgent verification instead.
  const finalResult = VERIFICATION_FINAL.includes(row.status);
  if (user.role === 'governance') {
    out.push(row.qc_flag ? 'clear_qc' : 'mark_qc', 'set_complaint');
    if (finalResult && !['pending_approval', 'approved'].includes(row.recording_status)) out.push('request_recording');
    if (verified) out.push('score_quality');
    if (STILL_VERIFYING.includes(row.status)) out.push(row.urgent_flag ? 'clear_urgent' : 'flag_urgent');
  }
  if (CARD_MAPPERS.includes(user.role) && row.case_status === 'completed' && includesCard(row)) out.push('set_card_status');
  if (user.role === 'business_head' && row.recording_status === 'pending_approval') out.push('approve_recording', 'decline_recording');
  if (row.recording_status === 'approved' && ['governance', 'business_head'].includes(user.role)) out.push('receive_recording');
  return out;
}

export function allowedActions(user, row) {
  return [...verificationActions(user, row), ...allowedCaseActions(user, row)];
}

function verificationActions(user, row) {
  return Object.entries(ACTIONS)
    .filter(([name, rule]) => {
      if (!rule.roles.includes(user.role) || !rule.from.includes(row.status)) return false;
      if (user.role === 'sales') return isOwner(user, row);
      if (user.role === 'processing' && row.status === STATUS.IN_VERIFICATION && row.assigned_to !== user.id) return false;
      if (name === 'bot_call') return config.callBot && !botCallPending(row);
      return name !== 'claim' || !row.assigned_to;
    })
    .map(([name]) => name);
}

/**
 * Applies a workflow action. Returns `{ case, triggers }` where triggers are
 * outbound events (e.g. team-leader alerts) for the caller to dispatch.
 */
/** The call-back time the customer asked for, as an ISO instant; must be ahead, within the window. */
function parseCallback(value) {
  const text = clean(value, 40);
  if (!text) throw new WorkflowError(400, 'Enter the date and time the customer asked to be called back');
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new WorkflowError(400, 'Call-back date and time is not valid');
  if (ms < Date.now() - 60e3) throw new WorkflowError(400, 'Call-back time must be in the future');
  if (ms > Date.now() + CALLBACK_MAX_DAYS * 864e5) throw new WorkflowError(400, `Call-back must be within the next ${CALLBACK_MAX_DAYS} days`);
  return new Date(ms).toISOString();
}

/**
 * Alerts processors whose scheduled call-backs are due: the processor on the file, or every
 * processor when nobody has it. Each call-back is alerted once. Runs on a timer in the server
 * and before cases are read, so the alert goes out at the set time even on a quiet system.
 * Returns the triggers for external alerts (webhooks).
 */
export function triggerDueCallbacks(db) {
  const ts = now();
  const due = db.prepare(`${CASE_SELECT} WHERE c.callback_at IS NOT NULL AND c.callback_at <= ? AND c.callback_notified_at IS NULL
    AND c.status IN (${OPEN_FOR_PROCESSING.map(() => '?').join(',')})`).all(ts, ...OPEN_FOR_PROCESSING);
  const triggers = [];
  for (const row of due) {
    const ref = caseRef(row.id);
    const to = row.assigned_to ? [row.assigned_to] : activeUserIds(db, 'processing');
    notify(db, to, row.id, `Call back now: ${ref} (${row.customer_name}) asked to be called at ${callbackLabel(row.callback_at)}`);
    db.prepare('UPDATE cases SET callback_notified_at = ? WHERE id = ?').run(ts, row.id);
    addEvent(db, row.id, null, 'callback_due', { detail: callbackLabel(row.callback_at) });
    triggers.push({ event: 'callback.due', case_id: row.id, ref, customer_name: row.customer_name, phone: row.phone, callback_at: row.callback_at, processor: row.assigned_to_name || null });
  }
  return triggers;
}

// "Tue 7 Oct, 10:30" in UAE time, for notifications and the timeline.
export const callbackLabel = (iso) => new Date(iso).toLocaleString('en-GB', {
  weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Dubai',
});

export function applyAction(db, user, id, { action, note, outcome, reason, case_status, to, ...extra } = {}) {
  if (CASE_ACTIONS.includes(action)) return applyCaseAction(db, user, id, { action, note, case_status, to, ...extra });
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
  const callbackAt = action === 'log_call' && outcome === 'call_back_later' ? parseCallback(extra.callback_at) : null;
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
        // The customer's requested time replaces any earlier call-back; any other outcome means
        // the processor reached (or tried) the customer, so a pending call-back is done.
        Object.assign(set, callbackAt
          ? { callback_at: callbackAt, callback_by: user.id, callback_set_at: ts, callback_notified_at: null }
          : { callback_at: null, callback_by: null, callback_set_at: null, callback_notified_at: null });
        if (callbackAt) detail = `${outcome} ${callbackAt}`;
        break;
      case 'bot_call': {
        set.assigned_to = row.assigned_to ?? user.id;
        if (row.status === STATUS.PENDING) set.status = STATUS.IN_VERIFICATION;
        Object.assign(set, { bot_call_status: 'requested', bot_call_at: ts });
        // A newer call replaces one the bot never reported back on; a late result for it is refused.
        db.prepare(`UPDATE bot_calls SET status = 'expired', finished_at = ? WHERE case_id = ? AND status IN ('requested', 'in_progress')`).run(ts, id);
        const token = randomBytes(24).toString('hex');
        const call = db.prepare('INSERT INTO bot_calls (case_id, token, status, requested_by, requested_at) VALUES (?, ?, ?, ?, ?)')
          .run(id, token, 'requested', user.id, ts);
        triggers.push({ event: 'bot_call.request', case_id: id, call_id: Number(call.lastInsertRowid), token, ref });
        break;
      }
      case 'complete':
        Object.assign(set, { assigned_to: row.assigned_to ?? user.id, verified_by: user.id, verified_at: ts, urgent_flag: 0, callback_at: null, callback_notified_at: null });
        notify(db, [ownerId(row)], id, `${ref} (${row.customer_name}) verification completed by ${user.name}`);
        break;
      case 'reject_verification':
        // Verification failing does not change the case status; that stays a separate decision.
        Object.assign(set, { assigned_to: row.assigned_to ?? user.id, incomplete_reason: reason || null, incomplete_note: note, incomplete_at: ts, urgent_flag: 0, callback_at: null, callback_notified_at: null });
        detail = reason || null;
        notify(db, [ownerId(row), ...activeUserIds(db, 'team_leader')], id,
          `${ref} (${row.customer_name}) verification rejected by ${user.name}: ${note}`);
        break;
      case 'mark_incomplete':
        Object.assign(set, {
          assigned_to: row.assigned_to ?? user.id,
          incomplete_reason: reason,
          incomplete_note: note,
          incomplete_at: ts,
          callback_at: null,
          callback_notified_at: null,
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
          notify(db, [ownerId(row)], id, `${ref} (${row.customer_name}) was returned to you: ${note}`);
        } else {
          notify(db, [ownerId(row), row.assigned_to], id, `${ref} (${row.customer_name}) was rejected by ${user.name}`);
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

/**
 * Records whether a completed (temp end) credit card was activated: 'active', 'inactive', or ''
 * to clear, with the date of that status (activated on / inactive since; today when not given).
 * Used by the case page, the card activation list and bulk upload; runs in the caller's transaction.
 */
/**
 * Keeps card statuses up to date; runs before cases or numbers are read.
 * 1. A completed card case with no result yet is Inactive by default, from its temp end date,
 *    until MIS confirms the card was activated.
 * 2. An inactive card 90+ days after its temp end moves to Out of activation range.
 * Each change is recorded on the case as a system event.
 */
export function sweepCardAgeing(db) {
  const ts = now();
  // No transaction of its own: this can run inside a caller's transaction (e.g. getCase after an action).
  const unmapped = db.prepare(`SELECT c.id, c.case_status_at FROM cases c
    WHERE c.card_status IS NULL AND c.case_status = 'completed' AND ${CARD_SQL}`).all();
  for (const { id, case_status_at: at } of unmapped) {
    const day = uaeDay(Date.parse(at));
    db.prepare("UPDATE cases SET card_status = 'inactive', card_activation_date = ?, card_status_by = NULL, card_status_at = ? WHERE id = ?").run(day, ts, id);
    addEvent(db, id, null, 'card_status', { to: 'inactive', detail: `Inactive by default from the temp end on ${day}, until activation is confirmed` });
  }
  // A default (unconfirmed) Inactive always dates from the temp end, even if the case is completed again later.
  db.prepare(`UPDATE cases SET card_activation_date = date(case_status_at, '+4 hours')
    WHERE card_status = 'inactive' AND card_status_by IS NULL AND case_status = 'completed'
      AND card_activation_date IS NOT date(case_status_at, '+4 hours')`).run();
  const stale = db.prepare(`SELECT c.id FROM cases c WHERE c.card_status = 'inactive' AND c.case_status = 'completed'
    AND julianday(?) - julianday(date(c.case_status_at, '+4 hours')) >= ?`).all(uaeDay(), CARD_RANGE_DAYS);
  for (const { id } of stale) {
    db.prepare("UPDATE cases SET card_status = 'out_of_range', card_status_by = NULL, card_status_at = ?, updated_at = ? WHERE id = ?").run(ts, ts, id);
    addEvent(db, id, null, 'card_status', {
      from: 'inactive', to: 'out_of_range', detail: `Out of activation range: still inactive ${CARD_RANGE_DAYS}+ days after the temp end`,
    });
  }
  return unmapped.length + stale.length;
}

const disbursalText = (amounts) => Object.entries(DISBURSAL_FIELDS)
  .filter(([, f]) => amounts[f] != null)
  .map(([p, f]) => `${PRODUCTS[p]} AED ${amounts[f].toLocaleString('en-US', { maximumFractionDigits: 2 })}`)
  .join(' · ');

export function setCardStatus(db, user, row, { card_status, activation_date } = {}) {
  if (row.case_status !== 'completed' || !includesCard(row)) {
    throw new WorkflowError(409, 'Card activation can only be mapped on a completed credit card case');
  }
  // Every completed card has a status (Inactive by default), so it can only be set, not cleared.
  const status = String(card_status ?? '').trim().toLowerCase();
  if (!CARD_STATUS[status]) throw new WorkflowError(400, 'Card status must be Active or Inactive');
  const label = status === 'inactive' ? 'Inactive since date' : 'Activation date';
  let date = status ? clean(activation_date, 10) || uaeDay() : null;
  if (date) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) throw new WorkflowError(400, `${label} must be a valid date`);
    if (date > uaeDay(Date.now() + 864e5)) throw new WorkflowError(400, `${label} cannot be in the future`);
  }
  const ts = now();
  db.prepare('UPDATE cases SET card_status = ?, card_activation_date = ?, card_status_by = ?, card_status_at = ?, updated_at = ? WHERE id = ?')
    .run(status, date, status ? user.id : null, status ? ts : null, ts, row.id);
  addEvent(db, row.id, user.id, 'card_status', {
    from: row.card_status, to: status, detail: `${CARD_STATUS[status] || 'Mapping cleared'}${date ? `${status === 'active' ? ', activated on' : ' since'} ${date}` : ''}`,
  });
}

function applyCaseAction(db, user, id, { action, note, case_status, to, recording_ref, complaint_number, score, card_status, activation_date, ...extra }) {
  const triggers = [];
  const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(id);
  if (!row || !canView(user, row)) throw new WorkflowError(404, 'Case not found');
  if (!allowedCaseActions(user, row).includes(action)) throw new WorkflowError(403, 'Your role cannot do that on this case');
  note = clean(note, 2000);
  const ref = caseRef(id);
  const ts = now();
  const who = `${user.name}`;

  transaction(db, () => {
    if (action === 'set_disbursal') {
      const amounts = disbursals(row, extra, { required: true });
      db.prepare('UPDATE cases SET pl_disbursed_amount = ?, al_disbursed_amount = ?, updated_at = ? WHERE id = ?')
        .run(amounts.pl_disbursed_amount ?? null, amounts.al_disbursed_amount ?? null, ts, id);
      addEvent(db, id, user.id, 'disbursal', { detail: disbursalText(amounts), note });
    } else if (action === 'set_card_status') {
      setCardStatus(db, user, row, { card_status, activation_date });
    } else if (action === 'set_case_status') {
      if (!SETTABLE_CASE_STATUSES.includes(case_status)) {
        throw new WorkflowError(400, 'Choose a case status: Applicant review, Completed or Rejected');
      }
      if (case_status === row.case_status) throw new WorkflowError(409, `The case is already ${CASE_STATUS[case_status]}`);
      if (case_status !== 'completed' && !note) throw new WorkflowError(400, `Add a note explaining why the case is ${CASE_STATUS[case_status]}`);
      // Completing a loan records how much was disbursed; leaving Completed clears it.
      const amounts = case_status === 'completed' ? disbursals(row, extra, { required: true }) : {};
      db.prepare(`UPDATE cases SET case_status = ?, case_status_note = ?, case_status_by = ?, case_status_at = ?, updated_at = ?,
          pl_disbursed_amount = ?, al_disbursed_amount = ? WHERE id = ?`)
        .run(case_status, note, user.id, ts, ts, amounts.pl_disbursed_amount ?? null, amounts.al_disbursed_amount ?? null, id);
      addEvent(db, id, user.id, 'case_status', { detail: case_status, note });
      if (Object.keys(amounts).length) addEvent(db, id, user.id, 'disbursal', { detail: disbursalText(amounts) });
      const label = CASE_STATUS[case_status];
      notify(db, [ownerId(row)], id, `${ref} (${row.customer_name}) case status changed to ${label} by ${who}${note ? `: ${note}` : ''}`);
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
    } else if (action === 'flag_urgent') {
      if (!note) throw new WorkflowError(400, 'Say why verification is urgent');
      db.prepare('UPDATE cases SET urgent_flag = 1, urgent_note = ?, urgent_by = ?, urgent_at = ?, updated_at = ? WHERE id = ?')
        .run(note, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'flag_urgent', { note });
      // The processor on the file (or every processor if nobody has it), plus team leaders who own Pending files.
      const processors = row.assigned_to ? [row.assigned_to] : activeUserIds(db, 'processing');
      notify(db, [...processors, ...activeUserIds(db, 'team_leader')], id,
        `URGENT verification: ${ref} (${row.customer_name}) flagged by ${who} — ${note}`);
    } else if (action === 'clear_urgent') {
      db.prepare('UPDATE cases SET urgent_flag = 0, updated_at = ? WHERE id = ?').run(ts, id);
      addEvent(db, id, user.id, 'clear_urgent', { note });
    } else if (action === 'mark_qc' || action === 'clear_qc') {
      const on = action === 'mark_qc';
      db.prepare('UPDATE cases SET qc_flag = ?, qc_note = ?, qc_by = ?, qc_at = ?, updated_at = ? WHERE id = ?')
        .run(on ? 1 : 0, note, user.id, ts, ts, id);
      addEvent(db, id, user.id, action, { note });
    } else if (action === 'request_recording') {
      if (!note) throw new WorkflowError(400, 'Give the reason for the recording request; the business head sees it when approving');
      db.prepare(`UPDATE cases SET recording_status = 'pending_approval', recording_request_note = ?, recording_requested_by = ?, recording_requested_at = ?,
          recording_decided_by = NULL, recording_decided_at = NULL, recording_decision_note = NULL, recording_it_email_at = NULL,
          recording_ref = NULL, recording_provided_by = NULL, recording_provided_at = NULL, updated_at = ? WHERE id = ?`)
        .run(note, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'request_recording', { note });
      notify(db, activeUserIds(db, 'business_head'), id, `Recording approval needed: ${ref} (${row.customer_name}) requested by ${who} — ${note}`);
    } else if (action === 'approve_recording' || action === 'decline_recording') {
      const approved = action === 'approve_recording';
      if (approved && !VERIFICATION_FINAL.includes(row.status)) {
        throw new WorkflowError(409, 'Verification is not complete, so the recording cannot be retrieved yet. Governance can flag the file for urgent verification.');
      }
      if (!approved && !note) throw new WorkflowError(400, 'Give a reason for declining');
      db.prepare(`UPDATE cases SET recording_status = ?, recording_decided_by = ?, recording_decided_at = ?, recording_decision_note = ?,
          recording_it_email_at = ?, updated_at = ? WHERE id = ?`)
        .run(approved ? 'approved' : 'declined', user.id, ts, note, approved ? ts : null, ts, id);
      addEvent(db, id, user.id, action, { note });
      notify(db, [row.recording_requested_by], id, approved
        ? `${ref} (${row.customer_name}): recording request approved by ${who}; IT has been asked for the file`
        : `${ref} (${row.customer_name}): recording request declined by ${who} — ${note}`);
      if (approved) {
        // Email IT for the file; the server sends it through the configured relay (see README).
        const full = db.prepare(`${CASE_SELECT} WHERE c.id = ?`).get(id);
        triggers.push({ event: 'recording.it_request', case_id: id, ref, ...recordingEmail(full) });
        addEvent(db, id, null, 'recording_it_email', { detail: config.itEmail || 'IT email not configured' });
      }
    } else if (action === 'receive_recording') {
      const recRef = clean(recording_ref, 500);
      if (!recRef) throw new WorkflowError(400, 'Add the link or reference for the file IT shared');
      db.prepare(`UPDATE cases SET recording_status = 'received', recording_ref = ?, recording_provided_by = ?, recording_provided_at = ?, updated_at = ? WHERE id = ?`)
        .run(recRef, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'receive_recording', { detail: recRef, note });
      if (row.recording_requested_by !== user.id) notify(db, [row.recording_requested_by], id, `${ref} (${row.customer_name}): call recording received`);
    } else if (action === 'set_complaint') {
      const number = clean(complaint_number, 50);
      if (!number) throw new WorkflowError(400, 'Enter the complaint number');
      if (!/^[A-Za-z0-9][A-Za-z0-9\-\/_ ]*$/.test(number)) throw new WorkflowError(400, 'Complaint number can contain letters, digits, spaces, - / and _');
      if (number === row.complaint_number) throw new WorkflowError(409, 'That complaint number is already on the file');
      db.prepare('UPDATE cases SET complaint_number = ?, complaint_by = ?, complaint_at = ?, updated_at = ? WHERE id = ?')
        .run(number, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'set_complaint', { detail: number, note });
    } else if (action === 'score_quality') {
      const n = Number(score);
      if (score === '' || score == null || !Number.isFinite(n) || n < 0 || n > SCORE_MAX || Math.round(n * 10) !== n * 10) {
        throw new WorkflowError(400, `Score must be from 0 to ${SCORE_MAX}, with at most one decimal place`);
      }
      db.prepare('UPDATE cases SET qc_score = ?, qc_score_note = ?, qc_scored_by = ?, qc_scored_at = ?, updated_at = ? WHERE id = ?')
        .run(n, note, user.id, ts, ts, id);
      addEvent(db, id, user.id, 'score_quality', { detail: String(n), note });
      if (row.assigned_to) notify(db, [row.assigned_to], id, `${ref} (${row.customer_name}): verification call scored ${n}/${SCORE_MAX} by ${who}`);
    }
  });
  return { case: getCase(db, user, id), triggers };
}

export function stats(db, user) {
  const scope = user.role === 'sales' ? 'WHERE (created_by = ? OR sales_staff_id = ?)' : '';
  const params = user.role === 'sales' ? [user.id, user.id] : [];
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
    triggerDueCallbacks(db);
    result.my_queue = db
      .prepare('SELECT COUNT(*) AS n FROM cases WHERE assigned_to = ? AND status = ?')
      .get(user.id, STATUS.IN_VERIFICATION).n;
    const cb = db.prepare(`SELECT SUM(callback_at <= ?) AS due, SUM(callback_at > ?) AS upcoming FROM cases
      WHERE callback_at IS NOT NULL AND status IN (${OPEN_FOR_PROCESSING.map(() => '?').join(',')}) AND (assigned_to = ? OR assigned_to IS NULL)`)
      .get(now(), now(), ...OPEN_FOR_PROCESSING, user.id);
    result.callbacks = { due: cb.due ?? 0, upcoming: cb.upcoming ?? 0 };
  }
  if (user.role !== 'sales') {
    result.governance = db.prepare(
      `SELECT SUM(qc_flag = 1) AS qc, SUM(urgent_flag = 1 AND status IN (${STILL_VERIFYING.map((st) => `'${st}'`).join(',')})) AS urgent, SUM(recording_status = 'pending_approval') AS recordings_pending,
         SUM(recording_status = 'approved') AS recordings_with_it, SUM(recording_status = 'received') AS recordings_received,
         COUNT(qc_score) AS scored,
         ROUND(AVG(qc_score), 1) AS avg_score, COUNT(complaint_number) AS complaints FROM cases`
    ).get();
    for (const k of Object.keys(result.governance)) result.governance[k] ??= 0;
  }
  if (['team_leader', 'sales_manager', 'mis', 'business_head', 'governance'].includes(user.role)) {
    result.processors = db
      .prepare(
        `SELECT u.name,
           SUM(CASE WHEN e.type = 'complete' THEN 1 ELSE 0 END) AS completed,
           SUM(CASE WHEN e.type = 'mark_incomplete' THEN 1 ELSE 0 END) AS incomplete,
           SUM(CASE WHEN e.type = 'reject_verification' THEN 1 ELSE 0 END) AS rejected,
           SUM(CASE WHEN e.type = 'log_call' THEN 1 ELSE 0 END) AS calls,
           (SELECT ROUND(AVG(qc_score), 1) FROM cases WHERE assigned_to = u.id) AS qc_avg,
           (SELECT COUNT(qc_score) FROM cases WHERE assigned_to = u.id) AS qc_scored
         FROM users u LEFT JOIN case_events e ON e.user_id = u.id
         WHERE u.role = 'processing' GROUP BY u.id ORDER BY u.name`
      )
      .all();
    result.sales = db
      .prepare(
        `SELECT u.name, COUNT(c.id) AS sourced,
           SUM(CASE WHEN c.status = 'completed' THEN 1 ELSE 0 END) AS completed
         FROM users u LEFT JOIN cases c ON COALESCE(c.sales_staff_id, c.created_by) = u.id
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
