// Reports for MIS, business heads, governance and managers. Each report is a table with fixed
// columns, filtered by a period (a sales cycle or two dates), a region, and the viewer's own
// scope: a team leader's report covers their team, a regional processor's their region, and MIS,
// business heads and governance see everything. Every run is recorded in report_runs.
import { caseScope, caseProducts, includesCard, REGIONS, STATUS, CASE_STATUS, CARD_STATES, CORE_PRODUCTS, COMPLETED_IN_SQL, present, caseRef, productLabel, sweepCardAgeing, WorkflowError } from './cases.js';
import { cycleOf, cycleRange, isCycle, uaeDay, cycleLabel } from './cycles.js';
import { TARGET_PRODUCTS, TARGET_UNITS, targetReport } from './performance.js';

const ALL = ['mis', 'business_head'];
const MANAGERS = ['team_leader', 'sales_manager', 'asm'];

/** The reports, who may run them, and how the period applies. */
export const REPORTS = {
  sourcing: { name: 'Sourcing by sales staff', roles: [...ALL, ...MANAGERS], period: 'files sourced in the period', description: 'Files sourced per sales person and where each of those files stands now: verification, case status, amounts disbursed.' },
  pipeline: { name: 'Pipeline by region and product', roles: [...ALL, 'governance'], period: 'files sourced in the period', description: 'Where every file sourced in the period stands now, by region and core product.' },
  verification: { name: 'Verification team productivity', roles: [...ALL, 'governance'], period: 'calls and results logged in the period', description: 'Calls logged, results marked and turnaround per processor.' },
  targets: { name: 'Target achievement', roles: [...ALL, ...MANAGERS], period: 'a whole sales cycle', description: 'Target against achievement per sales person for a cycle, by product.' },
  cards: { name: 'Card activation and ageing', roles: ALL, period: 'cards completed (temp end) in the period', description: 'Temp ends, activation status and how long inactive cards have waited, per sales person.' },
  governance: { name: 'Governance summary', roles: ['governance', 'business_head'], period: 'files sourced in the period', description: 'Quality checks, urgent flags, recordings, complaints, call scores, DNCR and re-verifications by region.' },
  access: { name: 'Access and reveals', roles: ['governance', 'business_head'], period: 'activity in the period', description: 'Who opened files, which personal details they revealed and which reports they ran.' },
  register: { name: 'Case register (export)', roles: [...ALL, 'governance', ...MANAGERS], period: 'files sourced in the period', description: 'One row per file with its status, products, amounts and people. Personal details stay masked.' },
};

export const reportsFor = (user) => Object.entries(REPORTS).filter(([, r]) => r.roles.includes(user.role)).map(([key, r]) => ({ key, ...r, roles: undefined }));

/** The period: a sales cycle (default the current one) or from/to dates. */
export function periodOf({ cycle, from, to } = {}) {
  const day = /^\d{4}-\d{2}-\d{2}$/;
  if (from || to) {
    if (!day.test(from || '') || !day.test(to || '')) throw new WorkflowError(400, 'Give both dates as YYYY-MM-DD');
    if (from > to) throw new WorkflowError(400, 'The from date is after the to date');
    if ((Date.parse(to) - Date.parse(from)) / 864e5 > 400) throw new WorkflowError(400, 'A report covers at most 400 days');
    return { from, to, label: `${from} to ${to}`, cycle: null };
  }
  const c = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(c)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const { start, end } = cycleRange(c);
  return { from: start, to: end, label: `${cycleLabel(c)} cycle (${start} to ${end})`, cycle: c };
}

function reportRegion(region) {
  const r = String(region || '').toUpperCase();
  if (!r) return null;
  if (!REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  return r;
}

// Cases the viewer may see, optionally in one region, with an extra period clause.
function caseWhere(user, region, clauses = [], params = []) {
  const where = [...clauses];
  const p = [...params];
  const scope = caseScope(user);
  if (scope) { where.push(scope.sql); p.push(...scope.params); }
  if (region) { where.push('c.region = ?'); p.push(region); }
  return { sql: where.length ? `WHERE ${where.join(' AND ')}` : '', params: p };
}

const col = (key, label, unit = 'count') => ({ key, label, unit });
const sum = (rows, k) => rows.reduce((n, r) => n + (Number(r[k]) || 0), 0);
const hours = (a, b) => (a && b ? (Date.parse(b) - Date.parse(a)) / 36e5 : null);
const avg = (list) => (list.length ? Math.round((list.reduce((a, b) => a + b, 0) / list.length) * 10) / 10 : null);
const pct = (n, of) => (of ? Math.round((n / of) * 1000) / 10 : null);

const STAFF_SQL = `SELECT u.id, u.name, u.sales_code, tl.name AS team_leader_name, sm.name AS sales_manager_name, asm.name AS asm_name
  FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id LEFT JOIN users asm ON asm.id = u.asm_id`;
const staffById = (db) => new Map(db.prepare(STAFF_SQL).all().map((s) => [s.id, s]));

function sourcing(db, user, { period, region }) {
  const { sql, params } = caseWhere(user, region, ['c.sourcing_date BETWEEN ? AND ?'], [period.from, period.to]);
  const rows = db.prepare(`SELECT c.*, asm.name AS asm_name FROM cases c LEFT JOIN users asm ON asm.id = c.asm_id ${sql}`).all(...params);
  const staff = staffById(db);
  const by = new Map();
  for (const c of rows) {
    // One row per sales person per team they filed under, so a team change keeps old files with the old team.
    const id = `${c.sales_staff_id ?? c.created_by}|${c.team_leader_id ?? 0}|${c.sales_manager_id ?? 0}`;
    const s = staff.get(c.sales_staff_id ?? c.created_by) || { name: c.sales_staff_name || 'Unknown' };
    if (!by.has(id)) by.set(id, { staff: s.name, sales_code: s.sales_code || c.sales_code || '', team_leader: c.team_leader_name || '', sales_manager: c.sales_manager_name || '', asm: c.asm_name || '', sourced: 0, approval: 0, awaiting: 0, verified: 0, verification_pending: 0, verification_rejected: 0, returned: 0, sent_to_check: 0, applicant_review: 0, completed: 0, rejected: 0, disbursed_aed: 0, temp_ends: 0, cards_active: 0, loans: 0 });
    const r = by.get(id);
    r.sourced++;
    if ([STATUS.PENDING, STATUS.IN_VERIFICATION].includes(c.status)) r.awaiting++;
    if (c.status === STATUS.APPROVAL) r.approval++;
    if (c.status === STATUS.COMPLETED) r.verified++;
    if (c.status === STATUS.INCOMPLETE) r.verification_pending++;
    if (c.status === STATUS.REJECTED) r.verification_rejected++;
    if (c.status === STATUS.RETURNED) r.returned++;
    r[c.case_status] = (r[c.case_status] || 0) + 1;
    if (c.case_status === 'completed') {
      r.disbursed_aed += (c.pl_disbursed_amount || 0) + (c.al_disbursed_amount || 0);
      if (includesCard(c)) { r.temp_ends++; if (c.card_status === 'active') r.cards_active++; }
    }
    if (caseProducts(c).some((p) => p === 'personal_loan' || p === 'auto_loan')) r.loans++;
  }
  const out = [...by.values()].sort((a, b) => b.sourced - a.sourced || a.staff.localeCompare(b.staff));
  return {
    columns: [col('staff', 'Sales staff', 'text'), col('sales_code', 'Code', 'text'), col('team_leader', 'Team leader', 'text'), col('sales_manager', 'Sales manager', 'text'), col('asm', 'ASM', 'text'),
      col('sourced', 'Sourced'), col('approval', 'Awaiting TL/SM approval'), col('awaiting', 'Awaiting verification'), col('verified', 'Verified'), col('verification_pending', 'Verification pending'), col('verification_rejected', 'Verification rejected'), col('returned', 'Returned to sales'),
      col('applicant_review', 'Applicant review'), col('completed', 'Completed'), col('rejected', 'Rejected'), col('disbursed_aed', 'Disbursed (AED)', 'aed'), col('temp_ends', 'Temp ends'), col('cards_active', 'Cards active')],
    rows: out,
    totals: Object.fromEntries(['sourced', 'approval', 'awaiting', 'verified', 'verification_pending', 'verification_rejected', 'returned', 'applicant_review', 'completed', 'rejected', 'disbursed_aed', 'temp_ends', 'cards_active'].map((k) => [k, sum(out, k)])),
  };
}

function pipeline(db, user, { period, region }) {
  const { sql, params } = caseWhere(user, region, ['c.sourcing_date BETWEEN ? AND ?'], [period.from, period.to]);
  const rows = db.prepare(`SELECT c.region, c.core_product, c.status, c.case_status, COUNT(*) AS n FROM cases c ${sql} GROUP BY c.region, c.core_product, c.status, c.case_status`).all(...params);
  const by = new Map();
  for (const r of rows) {
    const key = `${r.region || ''}|${r.core_product || ''}`;
    if (!by.has(key)) by.set(key, { region: r.region || 'Not set', product: CORE_PRODUCTS[r.core_product] || r.core_product || 'Not set', files: 0, ...Object.fromEntries(Object.keys(CASE_STATUS).map((k) => [k, 0])), approval: 0, awaiting: 0, in_verification: 0, verified: 0, verification_pending: 0, verification_rejected: 0, returned: 0 });
    const t = by.get(key);
    t.files += r.n;
    t[r.case_status] += r.n;
    t[{ awaiting_approval: 'approval', pending_verification: 'awaiting', in_verification: 'in_verification', completed: 'verified', incomplete: 'verification_pending', rejected: 'verification_rejected', returned_to_sales: 'returned' }[r.status]] += r.n;
  }
  const out = [...by.values()].sort((a, b) => a.region.localeCompare(b.region) || a.product.localeCompare(b.product));
  const keys = ['files', 'sent_to_check', 'applicant_review', 'completed', 'rejected', 'approval', 'awaiting', 'in_verification', 'verified', 'verification_pending', 'verification_rejected', 'returned'];
  return {
    columns: [col('region', 'Region', 'text'), col('product', 'Core product', 'text'), col('files', 'Files'), col('sent_to_check', 'Sent to checker'), col('applicant_review', 'Applicant review'), col('completed', 'Completed'), col('rejected', 'Rejected'),
      col('approval', 'Awaiting TL/SM approval'), col('awaiting', 'Awaiting verification'), col('in_verification', 'In verification'), col('verified', 'Verified'), col('verification_pending', 'Verification pending'), col('verification_rejected', 'Verification rejected'), col('returned', 'Returned to sales')],
    rows: out,
    totals: Object.fromEntries(keys.map((k) => [k, sum(out, k)])),
  };
}

function verification(db, user, { period, region }) {
  // Events logged in the period (UAE days), on files the viewer may see.
  const { sql, params } = caseWhere(user, region, ["date(e.created_at, '+4 hours') BETWEEN ? AND ?", "e.type IN ('log_call', 'complete', 'mark_incomplete', 'reject_verification')"], [period.from, period.to]);
  const events = db.prepare(`SELECT e.user_id, e.type, e.detail, e.case_id, e.created_at, c.created_at AS sourced_at, c.assigned_to FROM case_events e JOIN cases c ON c.id = e.case_id ${sql}`).all(...params);
  const procs = new Map(db.prepare("SELECT id, name, region FROM users WHERE role = 'processing'").all().map((p) => [p.id, p]));
  const by = new Map();
  const row = (id) => {
    if (!by.has(id)) {
      const p = procs.get(id) || { name: 'Unknown', region: '' };
      by.set(id, { processor: p.name, region: p.region || '', calls: 0, connected: 0, no_answer: 0, callbacks: 0, verified: 0, verification_pending: 0, verification_rejected: 0, cases: new Set(), tat: [], qc_avg: null, qc_scored: 0 });
    }
    return by.get(id);
  };
  for (const e of events) {
    const r = row(e.user_id);
    r.cases.add(e.case_id);
    if (e.type === 'log_call') { r.calls++; if (e.detail === 'connected') r.connected++; else if (e.detail === 'call_back_later') r.callbacks++; else r.no_answer++; }
    if (e.type === 'complete') { r.verified++; const h = hours(e.sourced_at, e.created_at); if (h != null) r.tat.push(h); }
    if (e.type === 'mark_incomplete') r.verification_pending++;
    if (e.type === 'reject_verification') r.verification_rejected++;
  }
  for (const q of db.prepare('SELECT assigned_to AS id, ROUND(AVG(qc_score), 1) AS qc_avg, COUNT(qc_score) AS n FROM cases WHERE qc_score IS NOT NULL GROUP BY assigned_to').all()) {
    if (by.has(q.id)) { by.get(q.id).qc_avg = q.qc_avg; by.get(q.id).qc_scored = q.n; }
  }
  const out = [...by.values()].map((r) => ({ ...r, cases: r.cases.size, avg_hours_to_verify: avg(r.tat), tat: undefined, results: r.verified + r.verification_pending + r.verification_rejected, connect_rate: pct(r.connected, r.calls) }))
    .sort((a, b) => b.calls - a.calls || a.processor.localeCompare(b.processor));
  return {
    columns: [col('processor', 'Processor', 'text'), col('region', 'Region', 'text'), col('cases', 'Files worked'), col('calls', 'Calls logged'), col('connected', 'Connected'), col('no_answer', 'Not reached'), col('callbacks', 'Call-backs set'), col('connect_rate', 'Connect rate %', 'pct'),
      col('results', 'Results marked'), col('verified', 'Verified'), col('verification_pending', 'Verification pending'), col('verification_rejected', 'Rejected'), col('avg_hours_to_verify', 'Avg hours sourcing to verified', 'hours'), col('qc_avg', 'QC average (all time)', 'score'), col('qc_scored', 'Calls scored')],
    rows: out,
    totals: Object.fromEntries(['cases', 'calls', 'connected', 'no_answer', 'callbacks', 'results', 'verified', 'verification_pending', 'verification_rejected'].map((k) => [k, sum(out, k)])),
  };
}

function targets(db, user, { period, region }) {
  if (!period.cycle) throw new WorkflowError(400, 'The target report runs for a sales cycle, not between dates');
  const rep = targetReport(db, user, period.cycle, { region });
  const products = Object.entries(TARGET_PRODUCTS);
  const rows = rep.staff.map((s) => {
    const r = { staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader_name || '', sales_manager: s.sales_manager_name || '' };
    for (const [k] of products) {
      r[`${k}_target`] = s.target[k] ?? null;
      r[`${k}_achieved`] = s.achieved[k];
      r[`${k}_pct`] = s.target[k] ? pct(s.achieved[k], s.target[k]) : null;
    }
    r.temp_ends = s.cards.temp_end; r.cards_active = s.cards.active;
    return r;
  });
  const columns = [col('staff', 'Sales staff', 'text'), col('sales_code', 'Code', 'text'), col('team_leader', 'Team leader', 'text'), col('sales_manager', 'Sales manager', 'text')];
  for (const [k, name] of products) {
    const unit = TARGET_UNITS[k];
    columns.push(col(`${k}_target`, `${name} target${unit === 'aed' ? ' (AED)' : ''}`, unit), col(`${k}_achieved`, `${name} achieved${unit === 'aed' ? ' (AED)' : ''}`, unit), col(`${k}_pct`, `${name} %`, 'pct'));
  }
  columns.push(col('temp_ends', 'Temp ends'), col('cards_active', 'Cards active'));
  const totals = {};
  for (const [k] of products) {
    totals[`${k}_target`] = sum(rows, `${k}_target`); totals[`${k}_achieved`] = sum(rows, `${k}_achieved`);
    totals[`${k}_pct`] = totals[`${k}_target`] ? pct(totals[`${k}_achieved`], totals[`${k}_target`]) : null;
  }
  totals.temp_ends = sum(rows, 'temp_ends'); totals.cards_active = sum(rows, 'cards_active');
  return { columns, rows, totals };
}

function cards(db, user, { period, region }) {
  sweepCardAgeing(db);
  const { sql, params } = caseWhere(user, region, [COMPLETED_IN_SQL, "(c.product = 'credit_card' OR (c.product = 'bundle' AND ',' || c.bundle_products || ',' LIKE '%,credit_card,%'))"], [period.from, period.to]);
  const rows = db.prepare(`SELECT c.sales_staff_id, c.created_by, c.sales_staff_name, c.team_leader_name, c.card_status, c.card_activation_date, c.case_status_at FROM cases c ${sql}`).all(...params);
  const staff = staffById(db);
  const today = Date.parse(uaeDay());
  const by = new Map();
  for (const c of rows) {
    const id = c.sales_staff_id ?? c.created_by;
    const s = staff.get(id) || { name: c.sales_staff_name || 'Unknown' };
    if (!by.has(id)) by.set(id, { staff: s.name, sales_code: s.sales_code || '', team_leader: c.team_leader_name || s.team_leader_name || '', temp_ends: 0, active: 0, inactive: 0, out_of_range: 0, unmapped: 0, inactive_0_30: 0, inactive_31_60: 0, inactive_61_90: 0, inactive_90_plus: 0, ages: [] });
    const r = by.get(id);
    r.temp_ends++;
    r[CARD_STATES[c.card_status] ? c.card_status : 'unmapped']++;
    if (c.card_status === 'inactive' || c.card_status === 'out_of_range') {
      const since = c.card_activation_date || String(c.case_status_at || '').slice(0, 10);
      const days = since ? Math.max(0, Math.round((today - Date.parse(since)) / 864e5)) : 0;
      r.ages.push(days);
      r[days > 90 ? 'inactive_90_plus' : days > 60 ? 'inactive_61_90' : days > 30 ? 'inactive_31_60' : 'inactive_0_30']++;
    }
  }
  const out = [...by.values()].map((r) => ({ ...r, activation_pct: pct(r.active, r.temp_ends), avg_days_inactive: avg(r.ages), ages: undefined })).sort((a, b) => b.temp_ends - a.temp_ends || a.staff.localeCompare(b.staff));
  const keys = ['temp_ends', 'active', 'inactive', 'out_of_range', 'unmapped', 'inactive_0_30', 'inactive_31_60', 'inactive_61_90', 'inactive_90_plus'];
  const totals = Object.fromEntries(keys.map((k) => [k, sum(out, k)]));
  totals.activation_pct = pct(totals.active, totals.temp_ends);
  return {
    columns: [col('staff', 'Sales staff', 'text'), col('sales_code', 'Code', 'text'), col('team_leader', 'Team leader', 'text'), col('temp_ends', 'Temp ends'), col('active', 'Active'), col('inactive', 'Inactive'), col('out_of_range', 'Out of activation range'), col('unmapped', 'Not mapped'),
      col('activation_pct', 'Activation %', 'pct'), col('avg_days_inactive', 'Avg days inactive', 'days'), col('inactive_0_30', 'Inactive 0–30 days'), col('inactive_31_60', '31–60 days'), col('inactive_61_90', '61–90 days'), col('inactive_90_plus', 'Over 90 days')],
    rows: out,
    totals,
  };
}

function governance(db, user, { period, region }) {
  const { sql, params } = caseWhere(user, region, ['c.sourcing_date BETWEEN ? AND ?'], [period.from, period.to]);
  const rows = db.prepare(`SELECT c.id, c.region, c.qc_flag, c.urgent_flag, c.recording_status, c.complaint_number, c.qc_score, c.incomplete_reason, c.status FROM cases c ${sql}`).all(...params);
  const ids = new Set(rows.map((r) => r.id));
  const extra = db.prepare(`SELECT e.case_id, e.type FROM case_events e WHERE e.type IN ('re_verification', 'read_back', 'eid_scan')`).all().filter((e) => ids.has(e.case_id));
  const by = new Map();
  const row = (region) => {
    if (!by.has(region)) by.set(region, { region, files: 0, qc_flagged: 0, urgent: 0, recordings_requested: 0, recordings_approved: 0, recordings_received: 0, recordings_declined: 0, complaints: 0, scored: 0, scores: [], dncr: 0, re_verifications: 0, read_backs: 0, eid_scans: 0 });
    return by.get(region);
  };
  const regionOfCase = new Map();
  for (const c of rows) {
    const r = row(c.region || 'Not set');
    regionOfCase.set(c.id, c.region || 'Not set');
    r.files++;
    if (c.qc_flag) r.qc_flagged++;
    if (c.urgent_flag) r.urgent++;
    if (c.recording_status) r.recordings_requested++;
    if (c.recording_status === 'approved') r.recordings_approved++;
    if (c.recording_status === 'received') r.recordings_received++;
    if (c.recording_status === 'declined') r.recordings_declined++;
    if (c.complaint_number) r.complaints++;
    if (c.qc_score != null) { r.scored++; r.scores.push(c.qc_score); }
    if (c.incomplete_reason === 'customer_in_dncr') r.dncr++;
  }
  for (const e of extra) {
    const r = row(regionOfCase.get(e.case_id));
    if (e.type === 're_verification') r.re_verifications++;
    if (e.type === 'read_back') r.read_backs++;
    if (e.type === 'eid_scan') r.eid_scans++;
  }
  const out = [...by.values()].map((r) => ({ ...r, avg_score: avg(r.scores), scores: undefined })).sort((a, b) => a.region.localeCompare(b.region));
  const keys = ['files', 'qc_flagged', 'urgent', 'recordings_requested', 'recordings_approved', 'recordings_received', 'recordings_declined', 'complaints', 'scored', 'dncr', 're_verifications', 'read_backs', 'eid_scans'];
  const totals = Object.fromEntries(keys.map((k) => [k, sum(out, k)]));
  totals.avg_score = avg(rows.filter((r) => r.qc_score != null).map((r) => r.qc_score));
  return {
    columns: [col('region', 'Region', 'text'), col('files', 'Files'), col('qc_flagged', 'Marked for QC'), col('urgent', 'Urgent'), col('recordings_requested', 'Recordings requested'), col('recordings_approved', 'With IT'), col('recordings_received', 'Received'), col('recordings_declined', 'Declined'),
      col('complaints', 'Complaints'), col('scored', 'Calls scored'), col('avg_score', 'Average score', 'score'), col('dncr', 'Customer in DNCR'), col('re_verifications', 'Re-verifications'), col('read_backs', 'ID read back by voice'), col('eid_scans', 'Emirates ID scans')],
    rows: out,
    totals,
  };
}

function access(db, user, { period, region }) {
  const regionSql = region ? ' AND c.region = ?' : '';
  const params = [period.from, period.to, ...(region ? [region] : [])];
  const log = db.prepare(`SELECT a.user_id, a.what, a.case_id, u.name, u.role FROM access_log a JOIN users u ON u.id = a.user_id JOIN cases c ON c.id = a.case_id
    WHERE date(a.at, '+4 hours') BETWEEN ? AND ?${regionSql}`).all(...params);
  const runs = db.prepare("SELECT user_id, COUNT(*) AS n FROM report_runs WHERE date(at, '+4 hours') BETWEEN ? AND ? GROUP BY user_id").all(period.from, period.to);
  const by = new Map();
  const row = (id, name, role) => {
    if (!by.has(id)) by.set(id, { user: name, role, views: 0, reveals: 0, reveals_phone: 0, reveals_eid: 0, reveals_passport: 0, reveals_salary: 0, cases: new Set(), reports_run: 0 });
    return by.get(id);
  };
  for (const a of log) {
    const r = row(a.user_id, a.name, a.role);
    r.cases.add(a.case_id);
    if (a.what === 'view') r.views++;
    if (a.what.startsWith('reveal:')) {
      r.reveals++;
      const f = a.what.slice(7);
      if (f === 'phone' || f === 'alt_phone') r.reveals_phone++;
      if (f === 'eid_number') r.reveals_eid++;
      if (f === 'passport_number') r.reveals_passport++;
      if (f === 'salary') r.reveals_salary++;
    }
  }
  for (const ru of runs) {
    const u = db.prepare('SELECT name, role FROM users WHERE id = ?').get(ru.user_id);
    if (u) row(ru.user_id, u.name, u.role).reports_run = ru.n;
  }
  const out = [...by.values()].map((r) => ({ ...r, cases: r.cases.size })).sort((a, b) => b.reveals - a.reveals || b.views - a.views || a.user.localeCompare(b.user));
  const keys = ['views', 'cases', 'reveals', 'reveals_phone', 'reveals_eid', 'reveals_passport', 'reveals_salary', 'reports_run'];
  return {
    columns: [col('user', 'User', 'text'), col('role', 'Role', 'role'), col('views', 'Files opened'), col('cases', 'Distinct files'), col('reveals', 'Reveals'), col('reveals_phone', 'Phone numbers'), col('reveals_eid', 'Emirates IDs'), col('reveals_passport', 'Passports'), col('reveals_salary', 'Salaries'), col('reports_run', 'Reports run')],
    rows: out,
    totals: Object.fromEntries(keys.map((k) => [k, sum(out, k)])),
  };
}

const VERIFICATION_LABELS = { awaiting_approval: 'Awaiting TL/SM approval', pending_verification: 'Awaiting verification', in_verification: 'In verification', completed: 'Verified', incomplete: 'Verification pending', returned_to_sales: 'Returned to sales', rejected: 'Verification rejected' };
const REGISTER_LIMIT = 5000;
function register(db, user, { period, region }) {
  sweepCardAgeing(db);
  const { sql, params } = caseWhere(user, region, ['c.sourcing_date BETWEEN ? AND ?'], [period.from, period.to]);
  const rows = db.prepare(`SELECT c.*, at.name AS assigned_to_name FROM cases c LEFT JOIN users at ON at.id = c.assigned_to ${sql} ORDER BY c.id DESC LIMIT ?`).all(...params, REGISTER_LIMIT + 1);
  const truncated = rows.length > REGISTER_LIMIT;
  const out = rows.slice(0, REGISTER_LIMIT).map((raw) => {
    const c = present(user, raw); // hides and masks personal details exactly as on screen
    return {
      ref: caseRef(c.id), sourcing_date: c.sourcing_date, region: c.region || '', customer: c.customer_name, phone: c.phone || '', city: c.city || '',
      product: productLabel(c.product, c.bundle_products, c.credit_card, c.personal_loan_type, c.buyout_bank), core_product: CORE_PRODUCTS[c.core_product] || c.core_product || '',
      card_fee_type: c.card_fee_type || '', loan_amount: c.loan_amount ?? c.amount ?? null, interest_rate: c.interest_rate ?? c.al_interest_rate ?? null, tenure: c.pl_tenure ?? c.al_tenure ?? null, fpd: c.fpd || '',
      auto_loan_type: c.auto_loan_type ? (c.auto_loan_type === 'new' ? 'New' : 'Used') : '', car: [c.car_make, c.car_model, c.car_year].filter(Boolean).join(' '), dealer: c.dealer_details || '',
      sales_staff: c.sales_staff_name || '', sales_code: c.sales_code || '', team_leader: c.team_leader_name || '', sales_manager: c.sales_manager_name || '',
      verification: VERIFICATION_LABELS[c.status] || c.status, verification_reason: c.incomplete_reason || '', processor: c.assigned_to_name || '', verified_at: c.verified_at || '',
      case_status: CASE_STATUS[c.case_status] || c.case_status, case_status_at: c.case_status_at || '', disbursed_aed: (c.pl_disbursed_amount || 0) + (c.al_disbursed_amount || 0) || null,
      card_status: c.card_status ? CARD_STATES[c.card_status] : (c.case_status === 'completed' && includesCard(c) ? 'Not mapped' : ''), card_date: c.card_activation_date || '',
      qc_score: c.qc_score ?? null, complaint: c.complaint_number || '', source: c.source || '',
    };
  });
  return {
    columns: [col('ref', 'Ref', 'text'), col('sourcing_date', 'Sourced', 'date'), col('region', 'Region', 'text'), col('customer', 'Customer', 'text'), col('phone', 'Phone', 'text'), col('city', 'City', 'text'), col('product', 'Product', 'text'), col('core_product', 'Core product', 'text'),
      col('card_fee_type', 'Card sourced type', 'text'), col('loan_amount', 'Loan / amount (AED)', 'aed'), col('interest_rate', 'Interest / ROI %', 'rate'), col('tenure', 'Tenure (months)'), col('fpd', 'FPD', 'date'), col('auto_loan_type', 'Auto loan type', 'text'), col('car', 'Car', 'text'), col('dealer', 'Dealer', 'text'), col('sales_staff', 'Sales staff', 'text'), col('sales_code', 'Code', 'text'), col('team_leader', 'Team leader', 'text'), col('sales_manager', 'Sales manager', 'text'),
      col('verification', 'Verification', 'text'), col('verification_reason', 'Reason', 'text'), col('processor', 'Processor', 'text'), col('verified_at', 'Verified at', 'datetime'), col('case_status', 'Case status', 'text'), col('case_status_at', 'Case status at', 'datetime'), col('disbursed_aed', 'Disbursed (AED)', 'aed'),
      col('card_status', 'Card status', 'text'), col('card_date', 'Card status date', 'date'), col('qc_score', 'QC score', 'score'), col('complaint', 'Complaint no.', 'text'), col('source', 'Source', 'text')],
    rows: out,
    totals: { ref: `${out.length} files`, disbursed_aed: sum(out, 'disbursed_aed') },
    truncated,
  };
}

const RUNNERS = { sourcing, pipeline, verification, targets, cards, governance, access, register };

/** Runs one report for the viewer. `filters`: { cycle, from, to, region }. */
export function runReport(db, user, key, filters = {}) {
  const def = REPORTS[key];
  if (!def || !def.roles.includes(user.role)) throw new WorkflowError(404, 'Report not found');
  const period = periodOf(filters);
  const region = reportRegion(filters.region);
  const result = RUNNERS[key](db, user, { period, region });
  db.prepare('INSERT INTO report_runs (user_id, report, filters, at) VALUES (?, ?, ?, ?)').run(user.id, key, JSON.stringify({ period: period.label, region }), new Date().toISOString());
  return { key, name: def.name, description: def.description, period: period.label, cycle: period.cycle, from: period.from, to: period.to, region, scope: scopeLabel(user), ...result };
}

function scopeLabel(user) {
  return { sales: 'your own files', team_leader: 'your team', sales_manager: 'your teams', asm: 'your teams', processing: user.region ? `${user.region} files` : 'all files' }[user.role] || 'all files';
}

/** The last runs, newest first, for governance and business heads. */
export function recentRuns(db, limit = 50) {
  return db.prepare('SELECT r.id, r.report, r.filters, r.at, u.name AS user_name, u.role AS user_role FROM report_runs r JOIN users u ON u.id = r.user_id ORDER BY r.id DESC LIMIT ?').all(limit)
    .map((r) => ({ ...r, name: REPORTS[r.report]?.name || r.report, filters: JSON.parse(r.filters || '{}') }));
}

/** CSV for Excel: a BOM, quoted cells, totals as the last row. */
export function toCsv(report) {
  const q = (v) => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [report.columns.map((c) => q(c.label)).join(',')];
  for (const r of report.rows) lines.push(report.columns.map((c) => q(r[c.key])).join(','));
  if (report.totals && report.rows.length) lines.push(report.columns.map((c, i) => q(i === 0 && report.totals[c.key] === undefined ? 'Total' : report.totals[c.key])).join(','));
  return `﻿${lines.join('\r\n')}\r\n`;
}
