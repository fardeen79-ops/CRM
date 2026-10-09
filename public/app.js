// Sourcing CRM — single-page frontend (no build step).
import { openEidScanner } from './eid-scan.js';
import { openLeadScanner } from './lead-scan.js';
import { speechSupported, listen, readBackMatches } from './speech.js';

// Verification status (the processing team's calls). Case status is separate; see CASE_STATUS_LABEL.
const STATUS_LABEL = {
  awaiting_approval: 'Awaiting TL/SM approval',
  pending_verification: 'Awaiting verification',
  in_verification: 'In verification',
  completed: 'Verification completed',
  incomplete: 'Verification pending — TL action',
  returned_to_sales: 'Returned to sales',
  rejected: 'Verification rejected',
};
const CASE_STATUS_LABEL = {
  sent_to_check: 'Sent to checker',
  applicant_review: 'Applicant review',
  completed: 'Completed',
  rejected: 'Rejected',
};
const OTHER_BANK = '__other';
const ROLE_LABEL = {
  sales: 'Sales', processing: 'Processing', team_leader: 'Team Leader',
  asm: 'Assistant Sales Manager', sales_manager: 'Sales Manager', mis: 'MIS', business_head: 'Business Head', governance: 'Governance', it: 'IT',
};
// Assistant sales managers use the same screens as sales managers, over their own teams.
const effRole = () => (state.user.role === 'asm' ? 'sales_manager' : state.user.role);
const ACTION_LABEL = {
  created: 'Case created',
  edited: 'Details edited',
  re_verification: 'Sent back for re-verification',
  claim: 'Picked up for verification',
  release: 'Released back to queue',
  log_call: 'Call logged',
  bot_call: 'Bot call requested',
  bot_call_result: 'Bot call finished',
  bot_call_failed: 'Bot call failed',
  complete: 'Verification completed',
  complete_deviation: 'Verification completed on deviation',
  mark_incomplete: 'Verification pending',
  reject_verification: 'Verification rejected',
  return_to_sales: 'Returned to sales',
  reverify: 'Sent back for re-verification',
  reject: 'Verification rejected by team leader',
  resubmit: 'Resubmitted for verification',
  case_status: 'Case status changed',
  set_case_status: 'Case status updated',
  request_edit: 'Edit request sent',
  resolve_edit_request: 'Requested changes made',
  flag_urgent: 'Flagged for urgent verification',
  clear_urgent: 'Urgent flag removed',
  eid_scan: 'Details filled from Emirates ID scan',
  read_back: 'Number checked by read-back',
  mark_qc: 'Marked for quality check',
  clear_qc: 'Removed from quality check',
  request_recording: 'Call recording requested',
  approve_recording: 'Recording request approved',
  decline_recording: 'Recording request declined',
  recording_it_email: 'IT emailed for the recording',
  receive_recording: 'Call recording received',
  set_complaint: 'Complaint number added',
  complaint_decision: 'Complaint decided',
  score_quality: 'Verification call scored',
  set_card_status: 'Card activation saved',
  callback_due: 'Call-back due',
  disbursal: 'Disbursed amount recorded',
  set_disbursal: 'Disbursed amount updated',
  card_status: 'Card activation mapped',
  bulk_upload: 'Added by bulk upload',
};

const state = { user: null, meta: null, region: '', unread: 0, unreadMessages: 0, actionRequired: 0, editRequests: 0, cardApprovals: 0, qc: 0, recordings: 0, urgent: 0, callbacksDue: 0 };
const app = document.getElementById('app');

// Roles that see every file can narrow the whole app to one region (DXB or AUH).
const REGION_ROLES = ['business_head', 'mis', 'governance'];
const canPickRegion = () => Boolean(state.user) && REGION_ROLES.includes(state.user.role);
const loadRegion = () => { try { state.region = localStorage.getItem('crm-region') || ''; } catch { state.region = ''; } };
const saveRegion = (r) => { state.region = r; try { r ? localStorage.setItem('crm-region', r) : localStorage.removeItem('crm-region'); } catch { /* storage blocked */ } };
// Reads that follow the region view when one is chosen.
const REGION_PATHS = /^\/(cases|stats|dashboard|pnl|targets|hierarchy|reports\/)/;

// ---------- helpers ----------
const esc = (v) =>
  String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

/** Tagged template that escapes interpolations unless wrapped with raw(). */
class Raw { constructor(s) { this.s = s; } toString() { return this.s; } }
const raw = (s) => new Raw(s);
const html = (strings, ...vals) =>
  raw(strings.reduce((out, str, i) => {
    const v = vals[i - 1];
    const s = v instanceof Raw ? v.s : Array.isArray(v) ? v.map((x) => (x instanceof Raw ? x.s : esc(x))).join('') : esc(v);
    return out + s + str;
  }));

// Labels for codes whose plain spelling would be wrong (abbreviations).
const SPECIAL_LABEL = { customer_in_dncr: 'Customer in DNCR (Do Not Call Register)' };
const label = (s) => SPECIAL_LABEL[s] || String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const isDncr = (c) => c.incomplete_reason === 'customer_in_dncr' && ['incomplete', 'rejected', 'returned_to_sales'].includes(c.status);
/** Buyout entries on the case page: cards numbered, loans with their bank and amount. */
const buyoutList = (list) => html`<ul class="bundle-list">${list.map((b, i) => html`<li><strong>${state.meta.buyout_kinds[b.kind] || b.kind}</strong>${b.kind === 'credit_card' ? ` ${list.filter((x) => x.kind === 'credit_card').indexOf(b) + 1}` : ''} · ${b.bank} · AED ${fmtAmount(b.amount)}${b.kind === 'credit_card' ? ' limit' : ''}</li>`)}<li class="muted small">Total AED ${fmtAmount(list.reduce((n, b) => n + Number(b.amount || 0), 0))}</li></ul>`;
const badge = (status) => html`<span class="badge st-${status}">${STATUS_LABEL[status] || status}</span>`;
// Call-quality score bands (out of 10): 8.5+ good, 7–8.4 fair, below 7 needs attention.
const scoreClass = (n) => (n >= 8.5 ? 'good' : n >= 7 ? 'fair' : 'bad');
const RECORDING_CHIP = { pending_approval: ['Recording: awaiting approval', 'warn'], approved: ['Recording: with IT', ''], declined: ['Recording declined', 'bad'], received: ['Recording received', 'good'] };
const recordingChip = (st) => (RECORDING_CHIP[st] ? html`<span class="chip ${RECORDING_CHIP[st][1]}">${RECORDING_CHIP[st][0]}</span>` : '');
const STILL_VERIFYING = ['pending_verification', 'in_verification', 'incomplete', 'returned_to_sales'];
const isUrgent = (c) => c.urgent_flag === 1 && STILL_VERIFYING.includes(c.status);
const caseBadge = (status) => html`<span class="badge cs-${status}">${CASE_STATUS_LABEL[status] || status}</span>`;
// A completed case is a temp end for credit cards and a disbursal for loans; both count towards targets.
const caseProducts = (c) => (c.product === 'bundle' ? String(c.bundle_products || '').split(',').filter(Boolean) : [c.product]);
const hasCard = (c) => caseProducts(c).includes('credit_card');
const completionLabel = (c) => [
  hasCard(c) && 'Temp end',
  caseProducts(c).some((p) => p === 'personal_loan' || p === 'auto_loan') && 'Disbursed',
].filter(Boolean).join(' / ');
const cardChip = (st) => (st === 'active' ? html`<span class="chip good">Card active</span>`
  : st === 'inactive' ? html`<span class="chip bad">Card inactive</span>`
    : st === 'out_of_range' ? html`<span class="chip out-range">Out of activation range</span>` : html`<span class="chip">Not mapped</span>`);
// Loans are measured by the AED amount disbursed; the file's amount is the suggestion.
const LOAN_DISBURSAL = { personal_loan: ['pl_disbursed_amount', 'Personal loan'], auto_loan: ['al_disbursed_amount', 'Auto loan'] };
const loansIn = (c) => Object.keys(LOAN_DISBURSAL).filter((p) => caseProducts(c).includes(p));
const suggestedDisbursal = (c, p) => (p === 'personal_loan' ? (c.personal_loan_type === 'top_up' ? c.incremental_amount : c.loan_amount) : c.amount) ?? '';
const fmtAed = (n) => `AED ${Number(n).toLocaleString(undefined, { maximumFractionDigits: 0 })}`;
// Compact for meters and tables: AED 1.25M, AED 480K.
const fmtAedShort = (n) => `AED ${new Intl.NumberFormat('en', { notation: 'compact', maximumFractionDigits: 2 }).format(n)}`;
// The bank's payout class on an auto loan, set or corrected when the loan is disbursed.
const payoutClassField = (c, id) => (loansIn(c).includes('auto_loan') && state.meta.auto_loan_classes ? html`<div class="field-row"><label for="${id}-al-class">Auto loan payout class</label>
  <select id="${id}-al-class" name="al_payout_class">${Object.entries(state.meta.auto_loan_classes).map(([k, l]) => html`<option value="${k}" ${(c.al_payout_class || 'full') === k ? raw('selected') : ''}>${l}</option>`)}</select></div>` : '');
const disbursedText = (c) => loansIn(c).filter((p) => c[LOAN_DISBURSAL[p][0]] != null).map((p) => `${LOAN_DISBURSAL[p][1]} ${fmtAed(c[LOAN_DISBURSAL[p][0]])}`).join(' · ');
// The date that goes with a card status: when it was activated, or since when it is inactive.
const cardDateText = (c) => (c.card_activation_date
  ? `${c.card_status === 'active' ? 'Activated on' : 'Inactive since'} ${fmtDay(c.card_activation_date)}${c.card_status === 'inactive' && !c.card_status_by ? ' · by default' : ''}` : '');
// Ageing of an inactive card: whole days since the case was completed (the temp end), in UAE dates.
const uaeDayOf = (ms) => new Date(ms + 4 * 3600e3).toISOString().slice(0, 10);
const cardAgeDays = (c) => (['inactive', 'out_of_range'].includes(c.card_status) && c.case_status_at
  ? Math.round((Date.parse(uaeDayOf(Date.now())) - Date.parse(uaeDayOf(Date.parse(c.case_status_at)))) / 864e5) : null);
// Inactive cards by days since the temp end. At 90 days a card moves to Out of activation range.
const AGE_BANDS = [[30, '0–30 days', ''], [60, '31–60 days', 'fair'], [89, '61–89 days', 'bad']];
const ageBand = (d) => AGE_BANDS.find(([max]) => d <= max);
const ageChip = (c) => {
  const d = cardAgeDays(c);
  if (d == null) return '';
  const cls = c.card_status === 'out_of_range' ? 'out-range' : (ageBand(d) || AGE_BANDS[AGE_BANDS.length - 1])[2];
  return html`<span class="chip ${cls}" title="Days since the temp end on ${fmtIsoDay(c.case_status_at)}">${d} ${d === 1 ? 'day' : 'days'}</span>`;
};
// Scheduled call-backs: the customer's requested time, how far away it is, and whether it is due.
const fmtWhen = (iso) => new Date(iso).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const callbackDue = (c) => Boolean(c.callback_at) && Date.parse(c.callback_at) <= Date.now();
const untilText = (iso) => {
  const mins = Math.round((Date.parse(iso) - Date.now()) / 60000);
  const abs = Math.abs(mins);
  const span = abs < 60 ? `${abs} min` : abs < 48 * 60 ? `${Math.round(abs / 60)} h` : `${Math.round(abs / 1440)} days`;
  return mins < -1 ? `${span} overdue` : mins <= 1 ? 'now' : `in ${span}`;
};
const callbackChip = (c) => (c.callback_at
  ? html`<span class="chip ${callbackDue(c) ? 'bad' : 'warn'}">${callbackDue(c) ? 'Call back now' : 'Call back'} · ${fmtWhen(c.callback_at)}</span>`
  : '');
// datetime-local works in the browser's local time; the server stores UTC.
const toLocalInput = (ms) => new Date(ms - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 16);
const fmtIsoDay = (iso) => (iso ? new Date(iso).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const fmtDate = (iso) => (iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
const fmtDay = (ymd) => (ymd ? new Date(`${ymd}T00:00:00`).toLocaleDateString(undefined, { dateStyle: 'medium' }) : '—');
const todayLocal = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const fmtAmount = (n) => (n == null ? '—' : Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 }));
function ago(iso) {
  if (!iso) return '';
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  return hrs < 48 ? `${hrs}h ago` : `${Math.round(hrs / 24)}d ago`;
}

async function api(path, { method = 'GET', body } = {}) {
  if (method !== 'GET') body ??= {};
  if (method === 'GET' && state.region && canPickRegion() && REGION_PATHS.test(path) && !/[?&]region=/.test(path)) path += `${path.includes('?') ? '&' : '?'}region=${state.region}`;
  const res = await fetch(`/api${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
    credentials: 'same-origin',
  });
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/login') {
    state.user = null;
    renderLogin();
    throw new Error(data.error || 'Please sign in');
  }
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

let toastTimer;
function toast(msg, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = `show${isError ? ' error' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.className = ''), 3500);
}

// Each sign-in starts on the dashboard, not on the page the previous user left open.
const resetRoute = () => history.replaceState(null, '', location.pathname + location.search);
const formData = (form) => Object.fromEntries(new FormData(form).entries());
const go = (hash) => { location.hash = hash; };

// ---------- auth ----------
function renderLogin() {
  app.innerHTML = html`
    <div class="login-wrap">
      <form class="card" id="login-form">
        <div class="brand" style="margin-bottom:16px"><span class="logo">✓</span> Sourcing CRM</div>
        <h1>Sign in</h1>
        <p class="muted">Sign in with your HRMS code (or work email). Your role decides what you see.</p>
        <div class="field-row"><label for="email">HRMS code or email</label><input id="email" name="email" autocomplete="username" autocapitalize="characters" required autofocus></div>
        <div class="field-row"><label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password" required></div>
        <button class="btn-primary" style="width:100%;justify-content:center">Sign in</button>
        <p class="error" id="login-error" hidden></p>
      </form>
    </div>`.s;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const err = document.getElementById('login-error');
    try {
      await api('/login', { method: 'POST', body: formData(e.target) });
      resetRoute();
      await boot();
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  });
}

async function boot() {
  try {
    const me = await api('/me');
    state.user = me.user;
    state.meta = me.meta;
    Object.assign(ROLE_LABEL, me.meta.role_labels || {});
    loadRegion();
  } catch {
    return;
  }
  await refreshCounters();
  route();
}

async function refreshCounters() {
  if (!state.user) return;
  try {
    const n = await api('/notifications');
    state.unread = n.unread;
    state.unreadMessages = n.unread_messages ?? 0;
    if (['team_leader', 'sales_manager', 'asm', 'governance', 'business_head', 'processing'].includes(state.user.role)) {
      const s = await api('/stats');
      state.actionRequired = s.by_status.incomplete;
      state.editRequests = s.edit_requests;
      state.cardApprovals = s.card_approvals ?? 0;
      state.qc = s.governance?.qc ?? 0;
      state.urgent = s.governance?.urgent ?? 0;
      // Business heads see requests awaiting approval; governance sees ones waiting on IT.
      state.recordings = state.user.role === 'business_head' ? s.governance?.recordings_pending ?? 0 : s.governance?.recordings_with_it ?? 0;
      state.callbacksDue = s.callbacks?.due ?? 0;
    }
    updateBadges();
  } catch { /* ignore polling errors */ }
}

function updateBadges() {
  const dot = document.querySelector('.bell .dot');
  if (dot) { dot.textContent = state.unread; dot.hidden = !state.unread; }
  const ar = document.querySelector('[data-ar-count]');
  if (ar) { ar.textContent = state.actionRequired; ar.hidden = !state.actionRequired; }
  const er = document.querySelector('[data-er-count]');
  if (er) { er.textContent = state.editRequests; er.hidden = !state.editRequests; }
  for (const [sel, n] of [['[data-qc-count]', state.qc], ['[data-rec-count]', state.recordings], ['[data-urgent-count]', state.urgent], ['[data-cb-count]', state.callbacksDue], ['[data-msg-count]', state.unreadMessages]]) {
    const el = document.querySelector(sel);
    if (el) { el.textContent = n; el.hidden = !n; }
  }
}

// ---------- shell ----------
// Sidebar icons (24px stroke icons, drawn with currentColor).
const ICON_PATHS = {
  tree: '<rect x="9" y="3" width="6" height="4" rx="1"/><rect x="3" y="15" width="6" height="4" rx="1"/><rect x="15" y="15" width="6" height="4" rx="1"/><path d="M12 7v4M6 15v-4h12v4"/>',
  report: '<path d="M6 3h9l4 4v14H6z"/><path d="M14 3v5h5"/><path d="M9 17v-4M12 17v-7M15 17v-2"/>',
  home: '<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>',
  queue: '<path d="M4 4h16v6H4z"/><path d="M4 14h16v6H4z"/><path d="M8 7h4M8 17h4"/>',
  urgent: '<path d="M12 3 2 20h20L12 3z"/><path d="M12 10v4M12 17.5v.5"/>',
  flag: '<path d="M5 21V4"/><path d="M5 4h11l-2 4 2 4H5"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="m13.5 6.5 4 4"/>',
  cases: '<path d="M4 6h16M4 12h16M4 18h10"/>',
  mine: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-6 8-6s8 2 8 6"/>',
  plus: '<circle cx="12" cy="12" r="9"/><path d="M12 8v8M8 12h8"/>',
  target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/>',
  card: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18M7 15h4"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5"/><path d="M4 16v4h16v-4"/>',
  tablet: '<rect x="4" y="2.5" width="16" height="19" rx="2"/><path d="M10 18.5h4"/>',
  users: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20c0-3.5 3-5.5 6.5-5.5s6.5 2 6.5 5.5"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14.5c2 .6 3.5 2.4 3.5 5.5"/>',
  check: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  mic: '<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/>',
  phone: '<path d="M5 4h4l2 5-2.5 1.5a11 11 0 0 0 5 5L15 13l5 2v4a2 2 0 0 1-2 2A16 16 0 0 1 3 6a2 2 0 0 1 2-2z"/>',
  stamp: '<path d="M9 3h6v6l3 3v3H6v-3l3-3z"/><path d="M5 21h14"/>',
  eye: '<path d="M2 12s3.5-6 10-6 10 6 10 6-3.5 6-10 6-10-6-10-6z"/><circle cx="12" cy="12" r="3"/>',
  chat: '<path d="M4 5h16v11H9l-5 4V5z"/>',
};
const icon = (name) => raw(`<svg class="ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON_PATHS[name] || ''}</svg>`);

/** The sidebar for the signed-in role: groups of [href, label, icon, count attribute, count]. */
function navGroups() {
  const r = effRole();
  const urgent = ['#/urgent', 'Urgent', 'urgent', 'data-urgent-count', state.urgent];
  const editRequests = ['#/edit-requests', 'Edit requests', 'edit', 'data-er-count', state.editRequests];
  const cardApprovals = ['#/card-approvals', 'Approvals', 'stamp', 'data-ca-count', state.cardApprovals];
  const groups = [];
  if (r === 'it') return filterNav([['', [['#/assets', 'Tab register', 'tablet'], ['#/import/assets', 'Bulk upload', 'upload'], ['#/reports?report=assets&run=1', 'Inventory report', 'report'], ...(state.meta.can_manage_roles ? [['#/roles', 'Roles', 'users']] : [])]]]);
  const work = [['#/', 'Dashboard', 'home']];
  if (r === 'processing') work.push(['#/queue', 'Verification queue', 'queue'], ['#/callbacks', 'Call-backs', 'phone', 'data-cb-count', state.callbacksDue], urgent);
  if (r === 'team_leader') work.push(urgent, ['#/action-required', 'Action required', 'flag', 'data-ar-count', state.actionRequired], editRequests, cardApprovals);
  if (r === 'sales_manager') work.push(editRequests, cardApprovals);
  if (r === 'business_head') work.push(['#/recording-approvals', 'Recording approvals', 'stamp', 'data-rec-count', state.recordings]);
  if (r === 'governance') {
    work.push(urgent, ['#/quality-check', 'Quality check', 'check', 'data-qc-count', state.qc], ['#/recordings', 'Recordings', 'mic', 'data-rec-count', state.recordings]);
  }
  work.push(['#/messages', 'Messages', 'chat', 'data-msg-count', state.unreadMessages]);
  groups.push(['', work]);

  const cases = [];
  if (r === 'sales') cases.push(['#/cases', 'My cases', 'mine']);
  if (r === 'processing') cases.push(['#/cases?assigned=me', 'My cases', 'mine']);
  if (r !== 'sales') cases.push(['#/cases', 'All cases', 'cases']);
  if (['sales', 'team_leader', 'sales_manager'].includes(r)) cases.push(['#/cases/new', 'New case', 'plus']);
  if (r === 'sales') cases.push(['#/leads', 'My leads', 'flag']);
  else if (['team_leader', 'sales_manager'].includes(r)) cases.push(['#/leads', 'Team leads', 'flag']);
  groups.push(['Cases', cases]);

  const perf = [];
  if (['sales', 'team_leader', 'sales_manager', 'mis', 'business_head'].includes(r)) perf.push(['#/targets', r === 'sales' ? 'My targets' : 'Targets', 'target']);
  if (r === 'sales') perf.push(['#/my-tab', 'My tab', 'tablet']);
  if (['team_leader', 'sales_manager', 'mis', 'business_head', 'governance'].includes(r)) perf.push(['#/team', 'Team view', 'tree']);
  if (r === 'mis' || r === 'business_head') perf.push(['#/cards', 'Card activation', 'card']);
  if (r === 'business_head') perf.push(['#/pnl', 'Profit & loss', 'report']);
  if (state.meta.reports?.length) perf.push(['#/reports', 'Reports', 'report']);
  if (perf.length) groups.push(['Performance', perf]);

  const admin = [];
  if (r === 'mis' || r === 'business_head') admin.push(['#/import/cases', 'Bulk upload', 'upload']);
  if (['mis', 'business_head'].includes(r)) admin.push(['#/users', 'Staff', 'users']);
  if (['governance', 'mis', 'business_head'].includes(r)) admin.push(['#/access-log', 'Access log', 'eye']);
  if (['mis', 'business_head'].includes(r)) admin.push(['#/assets', 'Tab register', 'tablet']);
  if (state.meta.can_manage_roles) admin.push(['#/roles', 'Roles', 'users', 'data-roles-count', state.meta.roles_pending || 0]);
  if (state.meta.can_allocate) admin.push(['#/allocation', 'Processor allocation', 'users']);
  if (admin.length) groups.push(['Admin', admin]);
  return filterNav(groups);
}
// A custom role sees only the screens it was given.
const filterNav = (groups) => groups.map(([title, items]) => [title, items.filter((i) => allowedPage(NAV_PAGE(i[0])))]).filter(([, items]) => items.length);

/** Which sidebar link is current: an exact match, else the one for the same page (e.g. a filtered list). */
function activeHref(hrefs) {
  const current = location.hash || '#/';
  if (hrefs.includes(current)) return current;
  const path = current.split('?')[0];
  if (path.startsWith('#/import/')) return hrefs.find((h) => h.startsWith('#/import/'));
  if (path.startsWith('#/messages')) return '#/messages';
  return hrefs.find((h) => h === path) || (path.startsWith('#/cases/') && !path.endsWith('/new') ? hrefs.find((h) => h === '#/cases') : null);
}

function shell(content) {
  const groups = navGroups();
  const active = activeHref(groups.flatMap(([, links]) => links.map(([h]) => h)));
  const initials = state.user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  app.innerHTML = html`
    <div class="app-shell">
      <aside class="sidebar" id="sidebar" aria-label="Main navigation">
        <a class="brand" href="#/"><span class="logo">✓</span> Sourcing CRM</a>
        <nav class="nav">
          ${groups.map(([title, links]) => html`<div class="nav-group">
            ${title ? html`<div class="nav-title">${title}</div>` : ''}
            ${links.map(([href, text, ic, attr, n]) => html`<a href="${href}" class="${href === active ? 'active' : ''}" ${href === active ? raw('aria-current="page"') : ''}>
              ${icon(ic)}<span class="nav-text">${text}</span>${attr ? raw(`<span class="count" ${attr} ${n ? '' : 'hidden'}>${n}</span>`) : ''}</a>`)}
          </div>`)}
        </nav>
        <div class="side-user">
          <span class="avatar" aria-hidden="true">${initials}</span>
          <div class="who"><div class="name">${state.user.name}</div><div class="role-tag">${ROLE_LABEL[state.user.role_key || state.user.role]}</div></div>
          <button id="logout" class="btn-link" title="Sign out">Sign out</button>
        </div>
      </aside>
      <div class="scrim" id="scrim" hidden></div>
      <div class="content">
        <header class="topbar">
          <button class="menu-btn" id="menu-btn" aria-label="Open menu" aria-controls="sidebar" aria-expanded="false"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button>
          <a class="brand mobile-brand" href="#/"><span class="logo">✓</span> Sourcing CRM</a>
          <div class="topbar-title">${ROLE_LABEL[state.user.role_key || state.user.role]} workspace</div>
          ${canPickRegion() ? html`<div class="segmented region-switch" role="radiogroup" aria-label="Region view">
            ${[['', 'All regions'], ...Object.keys(state.meta.regions).map((k) => [k, k])].map(([k, l]) => html`<label><input type="radio" name="region-view" value="${k}" ${state.region === k ? raw('checked') : ''}><span>${l}</span></label>`)}
          </div>` : ''}
          <button class="bell" id="bell" aria-label="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="dot" ${state.unread ? '' : 'hidden'}>${state.unread}</span></button>
        </header>
        <div id="notif-panel"></div>
        <main>${content}<div class="watermark" aria-hidden="true"></div></main>
      </div>
    </div>`.s;
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    resetRoute();
    renderLogin();
  };
  document.getElementById('bell').onclick = toggleNotifications;
  app.querySelectorAll('[name=region-view]').forEach((i) => (i.onchange = () => { saveRegion(i.value); route(); }));
  paintWatermark();
  // Phones and narrow windows: the sidebar slides in over the page.
  const sidebar = document.getElementById('sidebar');
  const scrim = document.getElementById('scrim');
  const menuBtn = document.getElementById('menu-btn');
  const setOpen = (open) => {
    sidebar.classList.toggle('open', open);
    scrim.hidden = !open;
    menuBtn.setAttribute('aria-expanded', String(open));
  };
  menuBtn.onclick = () => setOpen(!sidebar.classList.contains('open'));
  scrim.onclick = () => setOpen(false);
  sidebar.querySelectorAll('.nav a').forEach((a) => a.addEventListener('click', () => setOpen(false)));
}

async function toggleNotifications() {
  const panel = document.getElementById('notif-panel');
  if (panel.innerHTML) { panel.innerHTML = ''; return; }
  const { items } = await api('/notifications');
  panel.innerHTML = html`
    <div class="dropdown">
      <div class="head"><strong>Notifications</strong><button class="btn-link" id="mark-all">Mark all read</button></div>
      ${items.length ? items.map((n) => html`
        <a class="item ${n.is_read ? '' : 'unread'}" href="${n.case_id ? `#/cases/${n.case_id}` : n.link || '#/'}" data-id="${n.id}">
          <div>${n.message}</div><div class="muted small">${fmtDate(n.created_at)}</div>
        </a>`) : html`<div class="empty">No notifications yet</div>`}
    </div>`.s;
  document.getElementById('mark-all').onclick = async () => {
    await api('/notifications/read', { method: 'POST', body: {} });
    panel.innerHTML = '';
    refreshCounters();
  };
  panel.querySelectorAll('a.item').forEach((a) => a.addEventListener('click', async () => {
    panel.innerHTML = '';
    await api('/notifications/read', { method: 'POST', body: { ids: [Number(a.dataset.id)] } }).catch(() => {});
    refreshCounters();
  }));
}

// ---------- router ----------
async function route() {
  if (!state.user) return renderLogin();
  const [path, qs] = (location.hash.slice(1) || '/').split('?');
  const params = new URLSearchParams(qs || '');
  try {
    let m;
    if (path === '/' || path === '') return state.user.role === 'it' ? await viewAssets(params) : await viewDashboard();
    if (path === '/assets') return await viewAssets(params);
    if (path === '/roles') return await viewRoles();
    if (path === '/allocation') return await viewAllocation();
    if (path === '/pnl') return await viewPnl(params);
    if (path === '/my-tab') return await viewMyTab();
    if (!allowedPage(NAV_PAGE(`#${path}`))) throw new Error('Your role does not include this screen');
    if (path === '/cases/new') return viewCaseForm(undefined, params.get('lead'));
    if (path === '/leads') return await viewLeads(params);
    if ((m = path.match(/^\/cases\/(\d+)\/edit$/))) return await viewCaseForm(Number(m[1]));
    if ((m = path.match(/^\/cases\/(\d+)$/))) return await viewCase(Number(m[1]));
    if (path === '/cases') return await viewCases({ title: state.user.role === 'sales' ? 'My cases' : params.get('assigned') === 'me' ? 'My cases' : 'All cases', params });
    if (path === '/callbacks') {
      return await viewCases({
        title: 'Scheduled call-backs', subtitle: 'Customers who asked to be called back at a set time. You are alerted when each one is due; due call-backs also rise to the top of the verification queue.',
        params, fixed: { callbacks: 'all' }, cols: ['ref', 'customer', 'phone', 'callback', 'assigned'], empty: 'No call-backs scheduled',
      });
    }
    if (path === '/queue') {
      return await viewCases({ title: 'Verification queue', subtitle: 'Call each customer to verify the sourced details, then mark the verification completed, pending or rejected.', params, fixedStatus: 'pending_verification,in_verification' });
    }
    if (path === '/action-required') {
      return await viewCases({ title: 'Action required', subtitle: 'Files the processing team marked Verification pending. Decide whether to return to sales, re-verify, or reject.', params, fixedStatus: 'incomplete' });
    }
    if (path === '/card-approvals') {
      return await viewCases({ title: 'Approvals', subtitle: 'Files waiting for the team before verification: credit cards sold below the salary requirement with no reason chosen, and files sourced on a Sunday or entered after 6 pm. Open a file to approve it for verification, or return it to sales.', params, fixedStatus: 'awaiting_approval', cols: ['ref', 'customer', 'source_by', 'sourced', 'why_waiting', 'updated'], empty: 'Nothing waiting for your approval' });
    }
    if (path === '/edit-requests') {
      return await viewCases({
        title: 'Edit requests',
        subtitle: 'Sales asked for these cases in Applicant review to be corrected. Edit the details, then mark the request done.',
        params, fixed: { edit_requests: 'mine' }, cols: ['ref', 'customer', 'request', 'source_by', 'req_waiting'],
        empty: 'No edit requests waiting for you',
      });
    }
    if (path === '/urgent') {
      return await viewCases({
        title: 'Urgent verification', subtitle: 'Files governance flagged for urgent verification. They stay here until the verification is completed or rejected.',
        params, fixed: { urgent: '1' }, cols: ['ref', 'customer', 'status', 'urgent', 'assigned', 'updated'], empty: 'No files flagged as urgent',
      });
    }
    if (path === '/quality-check') {
      return await viewCases({
        title: 'Quality check', subtitle: 'Files you marked for a quality check. Request the call recording, score the verification call and add complaint numbers from each file.',
        params, fixed: { qc: '1' }, cols: ['ref', 'customer', 'status', 'quality', 'assigned', 'updated'], empty: 'No files are marked for a quality check',
      });
    }
    if (path === '/recordings') {
      return await viewCases({
        title: 'Call recordings', subtitle: 'Recording requests you raised after verification: awaiting business head approval, requested from IT, received or declined.',
        params, fixed: { recording: Object.keys(state.meta.recording_statuses).join(',') }, cols: ['ref', 'customer', 'recording', 'assigned', 'updated'], empty: 'No recordings requested yet',
      });
    }
    if (path === '/recording-approvals') {
      return await viewCases({
        title: 'Recording approvals', subtitle: 'Governance asked for these verification call recordings. Approve to email IT for the file, or decline with a reason.',
        params, fixed: { recording: 'pending_approval' }, cols: ['ref', 'customer', 'recording', 'assigned', 'updated'], empty: 'No recording requests waiting for approval',
      });
    }
    if (path === '/users') return await viewUsers();
    if ((m = path.match(/^\/import\/(users|cases|cards|targets|card_products|target_rules|payout_rules|assets|payroll)$/))) return viewBulkUpload(m[1]);
    if (path === '/access-log') return await viewAccessLog(params);
    if ((m = path.match(/^\/messages(?:\/(\d+))?$/))) return await viewMessages(m[1] ? Number(m[1]) : null, params);
    if (path === '/targets') return await viewTargets(params.get('cycle'));
    if (path === '/team') return await viewTeam(params);
    if (path === '/reports') return await viewReports(params);
    if (path === '/cards') return await viewCards(params);
    shell(html`<div class="card empty">Page not found</div>`);
  } catch (err) {
    if (state.user) shell(html`<div class="card"><p class="error">${err.message}</p></div>`);
  }
}

// ---------- dashboard ----------
// Lead follow-ups as tasks: tomorrow's (shown a day ahead), today's and anything overdue.
function followUpCard(fu, r) {
  const list = (items, cls) => html`<ul class="task-list">${items.map((l) => html`<li class="${cls}">
    <span class="task-when mono">${l.follow_up_time || '—'}</span>
    <span class="task-what"><strong>${l.customer_name}</strong>${r !== 'sales' ? html` <span class="muted small">· ${l.owner_name}</span>` : ''}${l.product ? html` <span class="muted small">· ${state.meta.products[l.product]}</span>` : ''}${l.company_name ? html` <span class="muted small">· ${l.company_name}</span>` : ''}${l.notes ? html`<div class="muted small">${l.notes}</div>` : ''}</span>
    <span class="task-act">${r === 'sales' ? html`<a class="call-link mono" href="tel:${telHref(l.phone)}" data-call="${l.phone}" data-call-name="${l.customer_name}">📞 ${l.phone}</a> · <a href="#/cases/new?lead=${l.id}">Convert</a>` : html`<span class="mono">${l.phone}</span>`}</span></li>`)}</ul>`;
  return html`<div class="card follow-ups"><div class="card-head"><h2>${r === 'sales' ? 'My follow-ups' : 'Team follow-ups'}</h2><a class="tiles-link" href="#/leads?status=open">${r === 'sales' ? 'My leads' : 'Team leads'} →</a></div>
    ${fu.due_tomorrow.length ? html`<h3 class="task-head">Tasks for tomorrow · ${fmtDay(fu.tomorrow)}</h3>${list(fu.due_tomorrow, 'tomorrow')}` : ''}
    ${fu.due_today.length ? html`<h3 class="task-head">Today · ${fmtDay(fu.today)}</h3>${list(fu.due_today, 'today')}` : ''}
    ${fu.overdue.length ? html`<h3 class="task-head overdue">Overdue</h3>${list(fu.overdue, 'overdue')}` : ''}
  </div>`;
}

// An email drafted by the system: shown with Copy and Open in email; the text is kept for the copy handler.
const EMAIL_DRAFTS = {};
function emailDraft(key, em, title, { missingTo = 'No email address on the file.' } = {}) {
  EMAIL_DRAFTS[key] = em;
  return html`<div class="email-draft">
    <div class="email-head"><strong>${title}</strong>
      <span class="actions">
        <button type="button" class="btn-link" data-copy-email="${key}">Copy email</button>
        ${em.to ? html`<a href="mailto:${em.to}?subject=${encodeURIComponent(em.subject)}&body=${encodeURIComponent(em.body)}">Open in email</a>` : ''}
      </span>
    </div>
    <div class="small"><span class="muted">To:</span> ${em.to || html`<span class="error">${missingTo}</span>`}</div>
    <div class="small"><span class="muted">Subject:</span> ${em.subject}</div>
    <pre data-email-body="${key}">${em.body}</pre>
  </div>`;
}
function bindEmailCopies() {
  document.querySelectorAll('[data-copy-email]').forEach((b) => (b.onclick = async () => {
    const em = EMAIL_DRAFTS[b.dataset.copyEmail];
    const text = `To: ${em.to || ''}\nSubject: ${em.subject}\n\n${em.body}`;
    try { await navigator.clipboard.writeText(text); toast('Email copied'); } catch {
      const range = document.createRange(); range.selectNodeContents(document.querySelector(`[data-email-body="${b.dataset.copyEmail}"]`));
      const sel = window.getSelection(); sel.removeAllRanges(); sel.addRange(range); toast('Select-all is done; press Ctrl+C / Cmd+C to copy');
    }
  }));
}

// What the open files could add, and what it takes to start earning: shown on each sales scheme card.
function potentialBlock(p, { unit, scheme }) {
  if (!p) return '';
  const u = (v) => (unit === 'aed' ? `AED ${fmtAmount(v)}` : `${fmtAmount(v)} points`);
  const nothingOpen = !p.open_files;
  const earningAfter = (p.incentive_aed ?? 0) > 0;
  const needed = p.needed_after ?? null;
  return html`<div class="callout ${earningAfter ? 'success' : 'info'} incentive-potential">
    <strong>${nothingOpen ? 'No open files in the system yet.' : `${p.open_files} open ${p.open_files === 1 ? 'file' : 'files'} in the system.`}</strong>
    ${nothingOpen ? '' : html` If ${p.open_files === 1 ? 'it completes' : 'they all complete'} this cycle: ${scheme === 'pl' ? `${u(p.pl_counted)} counted, ${p.band}` : `${u(scheme === 'cc' ? p.total_points : p.points)}`} → <strong>AED ${fmtAmount(p.incentive_aed ?? 0)}</strong>${p.extra_aed ? ` (AED ${fmtAmount(p.extra_aed)} more than today)` : ''}.`}
    ${needed == null ? html` <span class="muted">No target set, so there is no threshold to measure against.</span>`
      : needed > 0 ? html` To start earning you need <strong>${u(needed)} more</strong>${nothingOpen ? '' : ' after those files'}${!nothingOpen && p.needed_now > needed ? html` (${u(p.needed_now)} from today's completed files)` : ''}.`
      : scheme === 'pl' && p.next_band ? html` ${nothingOpen ? 'You are earning: the' : 'The'} next band, ${p.next_band.label} at ${p.next_band.rate.toFixed(2)}%, is ${u(p.next_band.short_by)} away.`
      : html` ${nothingOpen ? 'You are past the target: every' : 'Every'} further ${unit === 'aed' ? 'dirham' : 'point'} ${nothingOpen ? '' : 'beyond that '}is paid.`}
    ${scheme === 'pl' && p.cards_needed_after > 0 && p.open_cards + (p.cards_sold || 0) ? html` <span class="muted">Cards cross-sold pay once production reaches the threshold: ${u(p.cards_needed_after)} to go.</span>` : ''}
    ${pushLine(p, { unit, scheme, needed })}
  </div>`;
}

// The push: what the next step is worth in dirhams, so the gap reads as money within reach.
function pushLine(p, { unit, scheme, needed }) {
  if (scheme === 'pl' && p.next_band) {
    const nb = p.next_band;
    const atBand = Math.round((nb.from * nb.rate) / 100);
    if (needed > 0) {
      return html`<div class="push"><strong>Worth it:</strong> reach AED ${fmtAmount(nb.from)} and the whole production pays ${nb.rate.toFixed(2)}%, that is <strong>AED ${fmtAmount(atBand)}</strong> in hand, and every extra AED 100,000 adds AED ${fmtAmount(Math.round(100000 * nb.rate / 100))}.</div>`;
    }
    const nowAed = p.incentive_aed ?? 0;
    return html`<div class="push"><strong>Worth it:</strong> AED ${fmtAmount(nb.short_by)} more lifts the whole production to ${nb.rate.toFixed(2)}%: about <strong>AED ${fmtAmount(atBand)}</strong> instead of AED ${fmtAmount(nowAed)}.</div>`;
  }
  if (scheme === 'cc' && p.rate != null) {
    const per100 = Math.round(100 * p.rate);
    return needed > 0
      ? html`<div class="push"><strong>Worth it:</strong> every point past the target pays AED ${p.rate.toFixed(2)}; the first 1,000 points beyond it are <strong>AED ${fmtAmount(per100 * 10)}</strong>. One more Premium card is usually several hundred points.</div>`
      : html`<div class="push"><strong>Keep going:</strong> every 100 points you add now is another <strong>AED ${fmtAmount(per100)}</strong>.</div>`;
  }
  if (scheme === 'al' && p.multiplier != null) {
    const perLoan = Math.round(100000 * 0.8 / 100 * p.multiplier); // a AED 100,000 new or used car loan
    return needed > 0
      ? html`<div class="push"><strong>Worth it:</strong> past the target, every point pays AED ${p.multiplier.toFixed(2)}; a AED 100,000 car loan is 800 points, about <strong>AED ${fmtAmount(perLoan)}</strong>.${p.full_payout_met ? '' : ' Reaching AED 250,000 of new and used car disbursal lifts the rate to AED 1.10 a point.'}</div>`
      : html`<div class="push"><strong>Keep going:</strong> each further AED 100,000 car loan is about <strong>AED ${fmtAmount(perLoan)}</strong> more.</div>`;
  }
  return '';
}

// Staff with nothing to show this cycle: zero ends or disbursals, and zero submissions, with the names.
function zeroCard(z, r) {
  if (!z) return '';
  const pct = (v) => (v == null ? '—' : `${v}%`);
  const LIMIT = 40;
  const chip = (s) => html`<a class="chip bad" href="#/cases?staff=${s.id}&cycle=${z.cycle}" title="${s.sales_code || ''}${s.team_leader ? ` · ${s.team_leader}` : ''} · ${s.sourced} sourced, ${s.completed} completed this cycle">${s.name}</a>`;
  // Long lists (a business head over the whole agency) show the first names and fold the rest.
  const who = (list) => (list.length
    ? html`<div class="chips zero-names">${list.slice(0, LIMIT).map(chip)}</div>${list.length > LIMIT ? html`<details class="small zero-more"><summary class="muted">${list.length - LIMIT} more</summary><div class="chips zero-names">${list.slice(LIMIT).map(chip)}</div></details>` : ''}`
    : html`<div class="muted small">Nobody: everyone on the team has something this cycle.</div>`);
  return html`<h2 class="tiles-head">Staff on zero · ${cycleName(z.cycle)} cycle${['team_leader', 'sales_manager'].includes(r) ? html` <a class="tiles-link" href="#/team">Team view →</a>` : ''}</h2>
    <div class="kpis">
      <div class="kpi ${z.zero_ends.count ? 'kpi-alert' : ''}"><span class="kpi-label">Zero ends or disbursals</span><span class="kpi-value">${z.zero_ends.count} <span class="kpi-pct">${pct(z.zero_ends.pct)}</span></span><span class="kpi-sub">of ${z.team} active sales staff with no file completed this cycle</span></div>
      <div class="kpi ${z.zero_submissions.count ? 'kpi-alert' : ''}"><span class="kpi-label">Zero submissions</span><span class="kpi-value">${z.zero_submissions.count} <span class="kpi-pct">${pct(z.zero_submissions.pct)}</span></span><span class="kpi-sub">of ${z.team} active sales staff with no file sourced this cycle</span></div>
    </div>
    ${z.team ? html`<div class="card zero-card">
      <div class="zero-block"><strong>No ends or disbursals yet</strong>${who(z.zero_ends.staff)}</div>
      <div class="zero-block"><strong>No submissions yet</strong>${who(z.zero_submissions.staff)}</div>
    </div>` : html`<p class="muted small dash-quiet">No active sales staff in your scope yet.</p>`}`;
}

// The submission calendar: one cell per day of the cycle. Sales: green with a submission, red without.
// Leaders: green when 70%+ of the team submitted, orange from 50%, red below. Weekends with nothing are days off.
function calendarCard(cal, r) {
  if (!cal?.days?.length) return '';
  const leader = r !== 'sales';
  const first = cal.days[0];
  const lead = (first.dow + 6) % 7; // Monday first
  const title = (d) => {
    const day = new Date(d.date + 'T00:00:00Z').toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'UTC' });
    if (d.status === 'future') return `${day}: still to come`;
    if (leader) return `${day}: ${d.staff} of ${d.team} team members submitted (${d.pct ?? 0}%) · ${d.files} ${d.files === 1 ? 'file' : 'files'}`;
    return `${day}: ${d.files ? `${d.files} ${d.files === 1 ? 'file' : 'files'} submitted` : d.status === 'off' ? 'day off, nothing submitted' : 'no submission'}`;
  };
  const s = cal.summary;
  return html`<div class="card dash-calendar">
    <div class="card-head"><h2>${leader ? 'Team submissions' : 'My submissions'} · ${cycleName(cal.cycle)} cycle</h2>
      <div class="legend small">${leader
        ? html`<span class="swatch green"></span> ${state.meta.calendar_green_pct ?? 70}%+ of the team <span class="swatch orange"></span> ${state.meta.calendar_orange_pct ?? 50}% to ${(state.meta.calendar_green_pct ?? 70) - 0.01}% <span class="swatch red"></span> below`
        : html`<span class="swatch green"></span> Submitted <span class="swatch red"></span> No submission`}</div></div>
    <div class="cal-grid" role="img" aria-label="${leader ? 'Team submissions by day' : 'My submissions by day'}: ${s.green} green, ${s.orange ? `${s.orange} orange, ` : ''}${s.red} red of ${s.days} working days so far">
      ${['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'].map((d) => html`<div class="cal-dow">${d}</div>`)}
      ${Array.from({ length: lead }, () => html`<div class="cal-cell blank"></div>`)}
      ${cal.days.map((d) => html`<div class="cal-cell ${d.status} ${d.date === cal.today ? 'today' : ''}" title="${title(d)}"><span class="cal-date">${Number(d.date.slice(8))}</span>${d.status !== 'future' && (leader ? d.team : d.files) ? html`<span class="cal-n">${leader ? `${d.pct ?? 0}%` : d.files}</span>` : ''}</div>`)}
    </div>
    <p class="muted small">${s.green} ${leader ? 'green' : 'submission'} ${s.green === 1 ? 'day' : 'days'}${s.orange ? `, ${s.orange} orange` : ''} and ${s.red} red of ${s.days} working ${s.days === 1 ? 'day' : 'days'} so far this cycle. Saturday is a working day; a Sunday with nothing submitted is shown as the day off.${leader && !cal.team ? ' No active sales staff are on your team yet.' : ''}</p>
  </div>`;
}

// The incentive so far this cycle, for the people who earn one.
const INCENTIVE_TYPE = { credit_card: 'credit cards', personal_loan: 'personal loans', auto_loan: 'auto loans', cc_team_leader: 'card team', pl_team_leader: 'loan team', cc_sales_manager: 'card teams', pl_sales_manager: 'loan teams' };
function incentiveTile(inc) {
  return html`<a class="card dash-incentive" href="#/targets">
    <div class="kpi-label">Incentive so far</div>
    <div class="kpi-value">AED ${fmtAmount(inc.total)}</div>
    <div class="muted small">${inc.parts.map((p) => `${INCENTIVE_TYPE[p.type] || p.type} AED ${fmtAmount(p.amount)}`).join(' · ')}</div>
    ${inc.potential != null && inc.open_files ? html`<div class="small potential-line">Could reach <strong>AED ${fmtAmount(inc.potential)}</strong> if your ${inc.open_files} open ${inc.open_files === 1 ? 'file completes' : 'files complete'}.</div>` : ''}
    <div class="muted small">Subject to the conditions on My targets.</div>
  </a>`;
}

// Files sourced and completed over the last six cycles: two thin bars per cycle, a legend, direct
// labels on the current cycle, a tooltip on hover and the numbers as a table underneath.
function trendCard(trend, r) {
  if (!trend?.length) return '';
  const W = 600; const H = 190; const padL = 8; const padB = 34; const padT = 26;
  const max = Math.max(1, ...trend.flatMap((t) => [t.sourced, t.completed]));
  const slot = (W - padL * 2) / trend.length;
  const bw = Math.min(26, slot * 0.3);
  const y = (v) => padT + (H - padT - padB) * (1 - v / max);
  const bar = (x, v, cls, label) => html`<g class="tbar ${cls}"><title>${label}: ${v}</title><rect x="${x}" y="${y(v)}" width="${bw}" height="${Math.max(0, H - padB - y(v))}" rx="4" ry="4"></rect></g>`;
  const last = trend.length - 1;
  return html`<div class="card dash-trend">
    <div class="card-head"><h2>${r === 'sales' ? 'My last six cycles' : 'Last six cycles'}</h2>
      <div class="legend small"><span class="swatch sourced"></span> Sourced <span class="swatch completed"></span> Completed</div></div>
    <svg viewBox="0 0 ${W} ${H}" class="trend" role="img" aria-label="Files sourced and completed per cycle">
      ${[0.5, 1].map((f) => html`<line x1="${padL}" x2="${W - padL}" y1="${y(max * f)}" y2="${y(max * f)}" class="grid"></line>`)}
      ${trend.map((t, i) => { const cx = padL + slot * i + slot / 2; return html`
        ${bar(cx - bw - 1, t.sourced, 'sourced', `${t.label} sourced`)}
        ${bar(cx + 1, t.completed, 'completed', `${t.label} completed`)}
        ${i === last ? html`<text x="${cx - bw / 2 - 1}" y="${y(t.sourced) - 6}" class="val" text-anchor="middle">${t.sourced}</text><text x="${cx + bw / 2 + 1}" y="${y(t.completed) - 6}" class="val" text-anchor="middle">${t.completed}</text>` : ''}
        <text x="${cx}" y="${H - 12}" class="axis ${i === last ? 'now' : ''}" text-anchor="middle">${t.label.replace(/ 20\d\d$/, '')}</text>`; })}
    </svg>
    <details class="small"><summary class="muted">Numbers</summary>${miniTable(['Cycle', 'Sourced', 'Completed'], trend.map((t) => [t.label, t.sourced, t.completed]))}</details>
  </div>`;
}

// Core team vs cross-sell contribution per product: one stacked bar each, with the numbers and shares.
function contributionCard(rows, cycleLabel) {
  if (!rows?.length) return '';
  const fmtAmt = (x, v) => (x.unit === 'aed' ? `AED ${fmtAmount(v)}` : `${fmtAmount(v)} pts`);
  const pctOf = (v) => (v == null ? '—' : `${v}%`);
  // Cards: how many Mass, Premium and Super Premium (noon and uncategorised shown only when present).
  const mix = (side) => (side.cards ? [['Mass', side.cards.Mass], ['Premium', side.cards.Premium], ['Super Premium', side.cards['Super Premium']], ['noon', side.cards.noon], ['other', side.cards.other]].filter(([k, n]) => n || ['Mass', 'Premium', 'Super Premium'].includes(k)).map(([k, n]) => `${k} ${n}`).join(' · ') : '');
  return html`<div class="card dash-contribution">
    <div class="card-head"><h2>Core team vs cross-sell · ${cycleLabel} cycle</h2>
      <div class="legend small"><span class="swatch core"></span> Core team <span class="swatch cross"></span> Cross-sold by other teams</div></div>
    <div class="contrib-rows">
      ${rows.map((x) => {
        const total = x.total.amount; const corePct = total ? (x.core.amount / total) * 100 : 0; const crossPct = total ? 100 - corePct : 0;
        return html`<div class="contrib-row">
          <div class="contrib-label"><strong>${x.label}</strong><span class="muted small">${fmtAmt(x, total)} on ${x.total.files} ${x.total.files === 1 ? 'file' : 'files'}</span></div>
          <div class="contrib-bar" role="img" aria-label="${x.label}: core team ${fmtAmt(x, x.core.amount)} (${pctOf(x.core.pct)}), cross-sold ${fmtAmt(x, x.cross.amount)} (${pctOf(x.cross.pct)})">
            ${total ? html`<div class="seg core" style="width:${corePct}%" title="Core team: ${fmtAmt(x, x.core.amount)} · ${x.core.files} files · ${pctOf(x.core.pct)}">${corePct >= 18 ? html`<span>${pctOf(x.core.pct)}</span>` : ''}</div>
            <div class="seg cross" style="width:${crossPct}%" title="Cross-sold: ${fmtAmt(x, x.cross.amount)} · ${x.cross.files} files · ${pctOf(x.cross.pct)}">${crossPct >= 18 ? html`<span>${pctOf(x.cross.pct)}</span>` : ''}</div>` : html`<div class="seg none"><span class="muted small">Nothing completed yet</span></div>`}
          </div>
          <div class="contrib-nums small"><span><i class="swatch core"></i> ${fmtAmt(x, x.core.amount)} · ${x.core.files} ${x.core.files === 1 ? 'file' : 'files'} · ${pctOf(x.core.pct)}${x.core.cards ? html`<span class="contrib-mix">${mix(x.core)}</span>` : ''}</span><span><i class="swatch cross"></i> ${fmtAmt(x, x.cross.amount)} · ${x.cross.files} ${x.cross.files === 1 ? 'file' : 'files'} · ${pctOf(x.cross.pct)}${x.cross.cards ? html`<span class="contrib-mix">${mix(x.cross)}</span>` : ''}</span></div>
        </div>`; })}
    </div>
    <details class="small"><summary class="muted">Numbers</summary>${miniTable(['Product', 'Core team', 'Core files', 'Core %', 'Core cards', 'Cross-sold', 'Cross files', 'Cross %', 'Cross cards', 'Total'], rows.map((x) => [x.label, fmtAmt(x, x.core.amount), x.core.files, pctOf(x.core.pct), mix(x.core) || '—', fmtAmt(x, x.cross.amount), x.cross.files, pctOf(x.cross.pct), mix(x.cross) || '—', fmtAmt(x, x.total.amount)]))}</details>
    <p class="muted small">Completed files in the cycle within your scope. Cards count card points, loans the AED disbursed. Multi product staff count as core for every product.</p>
  </div>`;
}

async function viewDashboard() {
  const r = effRole();
  // Targets for the current sales cycle, for the people who have them.
  const hasTargets = ['sales', 'team_leader', 'sales_manager', 'mis', 'business_head'].includes(r);
  const hasTeam = ['team_leader', 'sales_manager', 'mis', 'business_head', 'governance'].includes(r);
  const [s, cyc, team, dash] = await Promise.all([api('/stats'), hasTargets ? api('/targets') : null, hasTeam ? api('/hierarchy').catch(() => null) : null, api('/dashboard').catch(() => null)]);
  const by = s.by_status;
  const cs = s.by_case_status;
  const oversight = ['team_leader', 'sales_manager', 'mis', 'business_head', 'governance'].includes(r);

  const verifyTiles = [];
  if (r === 'team_leader') verifyTiles.push(['Action required', by.incomplete, '#/action-required', by.incomplete > 0]);
  if (['team_leader', 'sales_manager'].includes(r)) verifyTiles.push(['Edit requests', s.edit_requests, '#/edit-requests', s.edit_requests > 0], ['Approvals', s.card_approvals, '#/card-approvals', s.card_approvals > 0]);
  else if (r !== 'sales' && r !== 'processing') verifyTiles.push(['Awaiting TL/SM approval', by.awaiting_approval, '#/cases?status=awaiting_approval']);
  if (['processing', 'team_leader'].includes(r)) verifyTiles.unshift(['Urgent verification', s.governance.urgent, '#/urgent', s.governance.urgent > 0]);
  if (r === 'processing') {
    verifyTiles.unshift(['Call-backs due', s.callbacks.due, '#/callbacks', s.callbacks.due > 0, `${s.callbacks.upcoming} upcoming`]);
    verifyTiles.push(['My open cases', s.my_queue, '#/cases?assigned=me']);
  }
  verifyTiles.push(
    ['Awaiting verification', by.pending_verification, '#/cases?status=pending_verification'],
    ['In verification', by.in_verification, '#/cases?status=in_verification'],
    ['Verification completed', by.completed, '#/cases?status=completed']
  );
  if (r !== 'team_leader') verifyTiles.push(['Verification pending', by.incomplete, '#/cases?status=incomplete']);
  verifyTiles.push(['Verification rejected', by.rejected, '#/cases?status=rejected']);
  verifyTiles.push(['Returned to sales', by.returned_to_sales, '#/cases?status=returned_to_sales']);

  const intro = {
    sales: 'Add the customers you source; each file goes in as Sent to checker. If a file moves to Applicant review, send an edit request to your team leader or sales manager.',
    processing: 'Work through the verification queue: call the customer, log each attempt, and mark the verification completed, pending or rejected. The case status is set separately by team leaders, MIS, sales managers and business heads.',
    team_leader: 'Pending verifications and edit requests need you. You can also set any case status.',
    sales_manager: 'Make the changes sales ask for in edit requests, and keep case statuses up to date.',
    mis: 'Track every sourced file and update its case status: Applicant review, Completed or Rejected.',
    business_head: 'Sourcing, verification and case outcomes across the team. You can update any case status.',
    governance: 'Mark files for a quality check, request call recordings after verification, add complaint numbers and score verification calls.',
  }[r];

  const teamTables = oversight ? html`
    <div class="card"><h2>Processing team <span class="muted small">all time</span></h2>
      ${miniTable(['Name', 'Calls', 'Verified', 'Pending', 'Rejected', 'QC avg'], s.processors.map((p) => [p.name, p.calls, p.completed, p.incomplete, p.rejected, p.qc_avg != null ? raw(`<span class="chip ${scoreClass(p.qc_avg)}">${p.qc_avg}</span>`) : '—']))}
    </div>
    <div class="card"><h2>Sales team <span class="muted small">all time</span></h2>
      ${miniTable(['Name', 'Sourced', 'Verified'], s.sales.map((p) => [p.name, p.sourced, p.completed]))}
    </div>` : '';

  let main = '';
  if (r === 'team_leader') {
    const [{ cases: incomplete }, { cases: requests }] = await Promise.all([
      api('/cases?status=incomplete&limit=10'), api('/cases?edit_requests=mine&limit=10'),
    ]);
    main = html`
      <div class="card"><h2>Verification pending — waiting on you</h2>${caseTable(incomplete, { cols: ['ref', 'customer', 'reason', 'by', 'waiting'], empty: 'Nothing waiting' })}</div>
      ${requests.length ? html`<div class="card"><h2>Edit requests</h2>${caseTable(requests, { cols: ['ref', 'customer', 'request', 'req_waiting'] })}</div>` : ''}`;
  } else if (r === 'sales_manager') {
    const { cases } = await api('/cases?edit_requests=mine&limit=10');
    main = html`<div class="card"><h2>Edit requests waiting on you</h2>${caseTable(cases, { cols: ['ref', 'customer', 'request', 'req_waiting'], empty: 'No edit requests right now' })}</div>`;
  } else if (r === 'governance') {
    const [{ cases: qc }, { cases: recs }] = await Promise.all([api('/cases?qc=1&limit=10'), api('/cases?recording=received&limit=5')]);
    main = html`
      <div class="card"><h2>Marked for quality check</h2>${caseTable(qc, { cols: ['ref', 'customer', 'status', 'quality', 'assigned'], empty: 'Nothing marked for a quality check' })}</div>
      ${recs.length ? html`<div class="card"><h2>Recordings ready to review</h2>${caseTable(recs, { cols: ['ref', 'customer', 'quality', 'assigned', 'updated'] })}</div>` : ''}`;
  } else if (r === 'business_head') {
    const [{ cases: approvals }, { cases: review }] = await Promise.all([api('/cases?recording=pending_approval&limit=10'), api('/cases?case_status=applicant_review&limit=10')]);
    main = html`
      <div class="card"><h2>Recording requests to approve</h2>${caseTable(approvals, { cols: ['ref', 'customer', 'recording', 'assigned'], empty: 'Nothing waiting for your approval' })}</div>
      <div class="card"><h2>In applicant review</h2>${caseTable(review, { cols: ['ref', 'customer', 'cs_note', 'source_by', 'updated'], empty: 'No files in applicant review' })}</div>`;
  } else if (r === 'mis') {
    const { cases } = await api('/cases?case_status=applicant_review&limit=10');
    main = html`<div class="card"><h2>In applicant review</h2>${caseTable(cases, { cols: ['ref', 'customer', 'cs_note', 'source_by', 'updated'], empty: 'No files in applicant review' })}</div>`;
  } else if (r === 'sales') {
    const [{ cases: returned }, { cases: review }] = await Promise.all([api('/cases?status=returned_to_sales'), api('/cases?case_status=applicant_review')]);
    main = html`
      ${returned.length ? html`<div class="card"><h2>Returned to you — needs correction</h2>${caseTable(returned, { cols: ['ref', 'customer', 'phone', 'tl_note', 'updated'] })}</div>` : ''}
      ${review.length ? html`<div class="card"><h2>In applicant review</h2><p class="muted small">Open a file to send an edit request to your team leader or sales manager.</p>${caseTable(review, { cols: ['ref', 'customer', 'cs_note', 'request', 'updated'] })}</div>` : ''}`;
  } else {
    const { cases } = await api('/cases?assigned=me&status=in_verification');
    main = html`<div class="card"><h2>My cases in progress</h2>${caseTable(cases, { cols: ['ref', 'customer', 'phone', 'calls', 'updated'], empty: 'Nothing in progress. Pick a case from the verification queue.' })}</div>`;
  }

  // A KPI tile: label, headline number and a share-of-files line. Alerts get a red accent.
  const tileGrid = (tiles) => html`<div class="kpis">
    ${tiles.map(([l, v, href, alert, sub]) => html`<a class="kpi ${alert ? 'kpi-alert' : ''}" href="${href}">
      <span class="kpi-label">${l}</span>
      <span class="kpi-value">${v ?? 0}</span>
      <span class="kpi-sub">${sub ?? (typeof v === 'number' && s.total ? `${Math.round((v / s.total) * 100)}% of files` : ' ')}</span>
    </a>`)}
  </div>`;

  const d = dash || { files: {}, trend: [], incentive: null };
  const fu = d.follow_ups;
  if (fu) {
    if (fu.overdue.length) verifyTiles.unshift(['Follow-ups overdue', fu.overdue.length, '#/leads?status=open', true, 'leads not followed up']);
    if (fu.due_today.length) verifyTiles.unshift(['Follow-ups today', fu.due_today.length, '#/leads?status=open', true, 'leads to call today']);
    if (fu.due_tomorrow.length) verifyTiles.unshift([`Tasks for tomorrow`, fu.due_tomorrow.length, '#/leads?status=open', true, 'lead follow-ups due tomorrow']);
  }
  const attention = r === 'processing' ? verifyTiles : verifyTiles.filter((t) => t[3]);
  const fileTiles = [
    ['Sourced', d.files.sourced, `#/cases?cycle=${d.cycle}`, false, 'this cycle'],
    ['Completed', d.files.completed, `#/cases?cycle=${d.cycle}&case_status=completed`, false, 'this cycle'],
    ['In verification', d.files.in_verification, '#/cases?status=in_verification', false, 'awaiting or in progress'],
    ['Returned to sales', d.files.returned, '#/cases?status=returned_to_sales', d.files.returned > 0, 'need correction'],
    ['Applicant review', d.files.applicant_review, '#/cases?case_status=applicant_review', false, 'open'],
    ['Rejected', d.files.rejected, `#/cases?cycle=${d.cycle}&case_status=rejected`, false, 'this cycle'],
  ];
  shell(html`
    <div class="page-head dash-head">
      <div>
        <div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${ROLE_LABEL[state.user.role_key || state.user.role]}${state.region ? ` · ${state.meta.regions[state.region]}` : ''}</div>
        <h1>Hello, ${state.user.name.split(' ')[0]}</h1>
        <p class="muted lede">${intro}</p>
      </div>
      ${['sales', 'team_leader', 'sales_manager'].includes(r) ? html`<a class="btn btn-primary" href="#/cases/new">+ New case</a>` : ''}
      ${BULK_ROLES.includes(r) ? html`<a class="btn btn-primary" href="#/import/cases">Bulk upload</a>` : ''}
      ${r === 'processing' ? html`<a class="btn btn-primary" href="#/queue">Open verification queue</a>` : ''}
      ${r === 'governance' ? html`<a class="btn btn-primary" href="#/quality-check">Open quality check</a>` : ''}
    </div>
    ${r === 'governance' ? html`<h2 class="tiles-head">Quality</h2>${tileGrid([
      ['Urgent verification', s.governance.urgent, '#/urgent', s.governance.urgent > 0],
      ['Marked for QC', s.governance.qc, '#/quality-check', s.governance.qc > 0],
      ['Awaiting approval', s.governance.recordings_pending, '#/recordings'],
      ['Requested from IT', s.governance.recordings_with_it, '#/recordings'],
      ['Recordings received', s.governance.recordings_received, '#/recordings'],
      ['Calls scored', s.governance.scored, '#/cases'],
      ['Average score', s.governance.avg_score ?? '—', '#/cases', false, 'out of 10'],
      ['Complaints', s.governance.complaints, '#/cases'],
    ])}` : ''}
    <h2 class="tiles-head">${d.label} cycle · day ${d.day} of ${d.days} · ${d.days_left} ${d.days_left === 1 ? 'day' : 'days'} left ${cyc ? html`<a class="tiles-link" href="#/targets">${r === 'sales' ? 'My targets' : 'Targets'} →</a>` : ''}</h2>
    ${cyc ? targetTiles(cyc, cyc.total) : ''}
    <div class="grid two-col dash-row">
      ${d.incentive ? incentiveTile(d.incentive) : ''}
      ${trendCard(d.trend, r)}
    </div>
    ${s.revenue ? html`<h2 class="tiles-head">Payout from the bank · ${cycleName(s.revenue.cycle)} cycle</h2>${tileGrid([
      ['Earned', `AED ${fmtAmount(s.revenue.completed_aed)}`, '#/reports?report=sourcing&run=1', false, `${s.revenue.completed_files} ${s.revenue.completed_files === 1 ? 'file' : 'files'} completed this cycle`],
      ['In the pipeline', `AED ${fmtAmount(s.revenue.pipeline_aed)}`, '#/cases', false, `${s.revenue.pipeline_files} open ${s.revenue.pipeline_files === 1 ? 'file' : 'files'}, if all complete`],
    ])}` : ''}
    ${d.contribution ? contributionCard(d.contribution, d.label) : ''}
    ${d.cross_sell ? html`<h2 class="tiles-head">Cross-sell · ${d.label} cycle <a class="tiles-link" href="#/cases?cycle=${d.cycle}&case_status=completed">Completed files →</a></h2>
      ${d.cross_sell.length ? tileGrid(d.cross_sell.flatMap((t) => t.products.map((p) => [
        `${t.core_label} team → ${p.label}`,
        p.files,
        `#/cases?cycle=${d.cycle}&case_status=completed`,
        false,
        p.amount ? `AED ${fmtAmount(p.amount)} disbursed · cross-sold on completed files` : `${p.product === 'credit_card' ? 'cards' : 'files'} cross-sold on completed files`,
      ]))) : html`<p class="muted small dash-quiet">No cross-sell on the files completed so far this cycle.</p>`}` : ''}
    <h2 class="tiles-head">${r === 'processing' ? 'Your queue' : 'Needs your attention'}</h2>
    ${attention.length ? tileGrid(attention) : html`<p class="muted small dash-quiet">Nothing is waiting on you right now.</p>`}
    ${fu && (fu.overdue.length || fu.due_today.length || fu.due_tomorrow.length) ? followUpCard(fu, r) : ''}
    ${d.zero ? zeroCard(d.zero, r) : ''}
    ${d.calendar ? calendarCard(d.calendar, r) : ''}
    ${main}
    <h2 class="tiles-head">${r === 'sales' ? 'My files' : r === 'processing' ? 'Files' : 'Files in your scope'} <a class="tiles-link" href="#/cases">All cases →</a></h2>
    ${tileGrid(fileTiles)}
    ${team && team.nodes.length ? html`<div class="card team-card"><div class="card-head"><h2>${team.levels[0] === 'staff' ? 'My team' : `By ${team.level_labels[team.levels[0]].toLowerCase()}`} · ${cycleName(team.cycle)} cycle</h2><a class="tiles-link" href="#/team">Team view →</a></div>
      ${teamTable({ ...team, nodes: team.nodes.map((n) => ({ ...n, children: [] })) })}</div>` : ''}`);
  document.querySelectorAll('.follow-ups [data-call]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); confirmCall(a.dataset.call, a.dataset.callName); }));
  bindRows();
}

// Case status mix. Order and colours are validated for colour-blind separation (see styles.css).
const MIX = ['completed', 'sent_to_check', 'applicant_review', 'rejected'];
function statusOverview(cs, total) {
  const pct = (n) => (total ? Math.round((n / total) * 100) : 0);
  return html`<section class="card overview">
    <div class="overview-head">
      <div><h2>Case status</h2><p class="muted small">Every sourced file by its current case status</p></div>
      <a class="overview-total" href="#/cases"><span class="kpi-value">${total}</span><span class="kpi-label">Total files</span></a>
    </div>
    ${total
      ? html`<div class="mix" role="img" aria-label="${MIX.map((k) => `${CASE_STATUS_LABEL[k]} ${cs[k]}`).join(', ')}">
          ${MIX.filter((k) => cs[k] > 0).map((k) => html`<a class="mix-seg mix-${k}" href="#/cases?case_status=${k}" style="flex-grow:${cs[k]}"
              data-tip="${CASE_STATUS_LABEL[k]}: ${cs[k]} (${pct(cs[k])}%)" aria-label="${CASE_STATUS_LABEL[k]}: ${cs[k]} files"></a>`)}
        </div>`
      : html`<p class="muted small">No files yet. They appear here as sales staff submit them.</p>`}
    <div class="mix-legend">
      ${MIX.map((k) => html`<a class="mix-item" href="#/cases?case_status=${k}">
        <span class="mix-swatch mix-${k}"></span>
        <span class="mix-label">${CASE_STATUS_LABEL[k]}</span>
        <span class="mix-count">${cs[k]}</span>
        <span class="mix-pct">${pct(cs[k])}%</span>
      </a>`)}
    </div>
  </section>`;
}

function miniTable(head, rows) {
  if (!rows.length) return html`<p class="muted">No users yet.</p>`;
  return html`<div class="table-wrap"><table><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr style="cursor:default">${r.map((c) => html`<td>${c ?? 0}</td>`)}</tr>`)}</tbody></table></div>`;
}

// ---------- case list ----------
const COLS = {
  ref: ['Ref', (c) => html`<strong>${c.ref}</strong>${timingChips(c)}`],
  why_waiting: ['Waiting for', (c) => html`<div class="chips">
    ${c.status === 'awaiting_approval' && c.credit_card && c.card_min_salary != null && !c.card_salary_exception && (c.salary != null ? c.salary < c.card_min_salary : !(c.timing_flag && !c.timing_approved_at)) ? html`<span class="chip bad">Card below salary</span>` : ''}
    ${timingChips(c, true)}
  </div>`],
  customer: ['Customer', (c) => html`${c.customer_name}<div class="muted small">${[c.product_label, c.company_name || c.city].filter(Boolean).join(' · ')}</div>`],
  phone: ['Phone', (c) => (c.phone == null && c.hidden_fields?.includes('phone') ? html`<span class="lock">Hidden</span>` : c.phone)],
  status: ['Verification', (c) => html`${badge(c.status)}${c.verified_basis === 'deviation' ? html` <span class="chip warn" title="Completed based on deviation, without a verification call">Deviation</span>` : ''}${isUrgent(c) ? html` <span class="chip bad">Urgent</span>` : ''}${isDncr(c) ? html` <span class="chip bad" title="Customer is on the Do Not Call Register">DNCR</span>` : ''}${c.callback_at && state.user.role === 'processing' ? html` ${callbackChip(c)}` : ''}`],
  case_status: ['Case status', (c) => html`${caseBadge(c.case_status)}${c.case_status === 'completed' && completionLabel(c) ? html`<div class="muted small">${completionLabel(c)}</div>` : ''}`],
  sourced: ['Sourced', (c) => html`<span class="small nowrap">${fmtDay(c.sourcing_date)}</span>`],
  cs_note: ['Status note', (c) => html`${c.case_status_note || ''}<div class="muted small">${c.case_status_by_name || ''}</div>`],
  request: ['Edit request', (c) => (c.edit_request_to
    ? html`${c.edit_request_note}<div class="muted small">${c.edit_request_by_name} → ${state.meta.edit_queues[c.edit_request_to]} queue</div>`
    : html`<span class="muted">—</span>`)],
  req_waiting: ['Waiting', (c) => ago(c.edit_request_at)],
  urgent: ['Why urgent', (c) => html`${c.urgent_note || ''}<div class="muted small">${c.urgent_by_name || ''} · ${ago(c.urgent_at)}</div>`],
  recording: ['Recording', (c) => html`${recordingChip(c.recording_status)}<div class="muted small">${c.recording_request_note || ''}</div>
    <div class="muted small">${c.recording_requested_by_name ? `Requested by ${c.recording_requested_by_name} ${ago(c.recording_requested_at)}` : ''}</div>`],
  quality: ['Quality', (c) => html`<div class="chips">
    ${c.qc_flag ? html`<span class="chip warn">QC</span>` : ''}
    ${c.qc_score != null ? html`<span class="chip ${scoreClass(c.qc_score)}">${c.qc_score}/10</span>` : ''}
    ${c.recording_status ? recordingChip(c.recording_status) : ''}
    ${c.complaint_number ? html`<span class="chip bad">Complaint ${c.complaint_number}${c.complaint_status ? ` · ${c.complaint_status === 'valid' ? 'valid' : 'invalid'}` : ''}</span>` : ''}
    ${c.complaint_status === 'valid' ? html`<span class="chip warn" title="${state.meta.complaint_remark || ''}">No incentive</span>` : ''}
    ${!c.qc_flag && c.qc_score == null && !c.recording_status && !c.complaint_number ? html`<span class="muted">—</span>` : ''}
  </div>`],
  source_by: ['Sourced by', (c) => html`${c.sales_staff_name || c.created_by_name}${c.sales_code ? html`<div class="muted small mono">${c.sales_code}</div>` : ''}`],
  region: ['Region', (c) => c.region || html`<span class="muted">—</span>`],
  assigned: ['Processor', (c) => c.assigned_to_name || html`<span class="muted">—</span>`],
  calls: ['Calls', (c) => c.call_attempts],
  reason: ['Reason', (c) => html`${label(c.incomplete_reason)}<div class="muted small">${c.incomplete_note || ''}</div>`],
  by: ['Marked by', (c) => c.assigned_to_name],
  waiting: ['Waiting', (c) => ago(c.incomplete_at)],
  tl_note: ['Team leader note', (c) => c.tl_note],
  updated: ['Updated', (c) => html`<span class="small">${fmtDate(c.updated_at)}</span>`],
  callback: ['Call-back', (c) => html`${callbackChip(c)}<div class="muted small">${c.callback_at ? `${untilText(c.callback_at)} · asked by ${c.callback_by_name || '—'}` : ''}</div>`],
  completed_on: ['Completed', (c) => html`<span class="small nowrap">${fmtIsoDay(c.case_status_at)}</span><div class="muted small">${completionLabel(c)}</div>${disbursedText(c) ? html`<div class="small">${disbursedText(c)}</div>` : ''}`],
  card: ['Card activation', (c) => html`${cardChip(c.card_status)}${c.card_activation_date ? html`<div class="muted small">${cardDateText(c)}</div>` : ''}${cardAgeDays(c) != null ? html`<div class="small">Ageing ${ageChip(c)}</div>` : ''}`],
};

// Sunday and after-6-pm flags on a file, as small chips; grey once the team has approved them.
function timingChips(c, pendingOnly = false) {
  const flags = String(c.timing_flag || '').split(',').filter(Boolean);
  if (!flags.length || (pendingOnly && c.timing_approved_at)) return '';
  const cls = c.timing_approved_at ? 'chip' : 'chip warn';
  return html`${flags.map((f) => html` <span class="${cls}" title="${state.meta.timing_flags?.[f] || f}${c.timing_approved_at ? `, approved by ${c.timing_approved_by_name}` : ''}">${f === 'sunday' ? 'Sunday' : 'After 6 pm'}</span>`)}`;
}

function caseTable(cases, { cols, empty = 'No cases found' }) {
  if (!cases.length) return html`<div class="empty">${empty}</div>`;
  return html`<div class="table-wrap"><table>
    <thead><tr>${cols.map((k) => html`<th>${COLS[k][0]}</th>`)}</tr></thead>
    <tbody>${cases.map((c) => html`<tr data-href="#/cases/${c.id}">${cols.map((k) => html`<td>${COLS[k][1](c)}</td>`)}</tr>`)}</tbody>
  </table></div>`;
}

function bindRows() {
  app.querySelectorAll('tr[data-href]').forEach((tr) => (tr.onclick = () => go(tr.dataset.href)));
}

async function viewCases({ title, subtitle = '', params, fixedStatus, fixed = {}, cols: fixedCols, empty }) {
  const status = fixedStatus || params.get('status') || '';
  const caseStatus = params.get('case_status') || '';
  const q = params.get('q') || '';
  const query = new URLSearchParams({
    ...fixed,
    ...(status && { status }), ...(caseStatus && { case_status: caseStatus }), ...(q && { q }),
    ...(params.get('assigned') && { assigned: params.get('assigned') }),
    ...(params.get('cycle') && { cycle: params.get('cycle') }),
    ...(params.get('staff') && { staff: params.get('staff') }),
  });
  const { cases } = await api(`/cases?${query}`);
  // Drill-down from the Targets page: cases completed in one cycle, optionally for one sales person.
  const cycleFilter = params.get('cycle');
  if (cycleFilter) {
    const who = params.get('staff') && cases[0] ? ` by ${cases[0].sales_staff_name}` : '';
    subtitle = html`Completed in the ${cycleName(cycleFilter)} cycle (${cycleSpan(cycleFilter)})${who}. <a href="#/targets?cycle=${cycleFilter}">Back to targets</a>`;
    fixedCols ||= ['ref', 'customer', 'source_by', 'completed_on', 'card'];
  }

  const r = effRole();
  let cols = fixedCols || ['ref', 'customer', 'sourced', 'region', 'case_status', 'status', 'source_by', 'assigned', 'updated'];
  if (!fixedCols && r === 'sales') cols = ['ref', 'customer', 'sourced', 'region', 'case_status', 'status', 'updated'];
  if (fixedStatus === 'incomplete') cols = ['ref', 'customer', 'phone', 'reason', 'by', 'source_by', 'waiting'];

  const base = location.hash.split('?')[0];
  const filters = fixedStatus || fixedCols ? '' : html`
    <label class="inline-filter" for="case-status-filter">Case status
      <select id="case-status-filter">
        <option value="">All</option>
        ${Object.entries(CASE_STATUS_LABEL).map(([k, l]) => html`<option value="${k}" ${k === caseStatus ? raw('selected') : ''}>${l}</option>`)}
      </select>
    </label>
    <div class="tabs" aria-label="Verification status">
      ${[['', 'All verification'], ...Object.entries(STATUS_LABEL)].map(([s, l]) => html`<button data-status="${s}" class="${s === status ? 'active' : ''}">${l}</button>`)}
    </div>`;

  shell(html`
    <div class="page-head">
      <div><h1>${title}</h1>${subtitle ? html`<p class="muted" style="margin:0">${subtitle}</p>` : ''}</div>
      ${['sales', 'team_leader', 'sales_manager'].includes(r) ? html`<a class="btn btn-primary" href="#/cases/new">+ New case</a>` : ''}
      ${BULK_ROLES.includes(r) ? html`<a class="btn btn-primary" href="#/import/cases">Bulk upload</a>` : ''}
    </div>
    <div class="card">
      <div class="toolbar">
        <form id="search-form" style="display:flex;gap:8px;flex:1;min-width:240px">
          <input type="search" name="q" placeholder="Search name, mobile, Emirates ID, passport, Bidaya / App ID, sales code or ref…" value="${q}">
          <button>Search</button>
        </form>
        ${filters}
      </div>
      ${caseTable(cases, { cols, empty: empty || (fixedStatus === 'incomplete' ? 'Nothing needs your attention right now 🎉' : 'No cases found') })}
    </div>`);
  bindRows();

  const setParam = (key, val) => {
    const p = new URLSearchParams(params);
    val ? p.set(key, val) : p.delete(key);
    const s = p.toString();
    go(`${base}${s ? `?${s}` : ''}`);
  };
  document.getElementById('search-form').onsubmit = (e) => { e.preventDefault(); setParam('q', formData(e.target).q.trim()); };
  app.querySelectorAll('.tabs button').forEach((b) => (b.onclick = () => setParam('status', b.dataset.status)));
  const csFilter = document.getElementById('case-status-filter');
  if (csFilter) csFilter.onchange = () => setParam('case_status', csFilter.value);
}

// ---------- case form ----------
async function viewCaseForm(id, leadId = null) {
  const c = id ? { ...(await api(`/cases/${id}`)).case } : { sourcing_date: todayLocal() };
  // A file started from a lead: the lead's details fill the form, and submitting converts the lead.
  let lead = null;
  if (!id && leadId) {
    lead = (await api(`/leads/${leadId}`)).lead;
    if (lead.status !== 'open') throw new Error(`This lead is ${(state.meta.lead_status[lead.status] || lead.status).toLowerCase()} and cannot be converted`);
    Object.assign(c, { first_name: lead.first_name, middle_name: lead.middle_name, last_name: lead.last_name, customer_name: lead.customer_name, phone: lead.phone, email: lead.email, company_name: lead.company_name, salary: lead.salary, product: lead.product, source: lead.source, city: lead.city, sales_notes: lead.notes });
  }
  if (id && !c.first_name && c.customer_name) {
    // Cases created before names were split: prefill first / middle / last from the full name.
    const parts = c.customer_name.split(/\s+/);
    c.first_name = parts.shift();
    c.last_name = parts.pop() ?? '';
    c.middle_name = parts.join(' ');
  }
  const products = state.meta.products;
  const r = effRole();
  // Sales staff file as themselves; team leaders and sales managers pick who sourced the file.
  const pickStaff = r === 'team_leader' || r === 'sales_manager';
  const staffList = pickStaff ? (await api('/sales-staff')).staff : [];
  const me = state.user;
  const staffNow = id
    ? { id: c.sales_staff_id, name: c.sales_staff_name, sales_code: c.sales_code, team_leader_name: c.team_leader_name, sales_manager_name: c.sales_manager_name }
    : r === 'sales' ? me : null;
  const profileGap = r === 'sales' && !id && (!me.sales_code || !me.team_leader_name || !me.sales_manager_name);
  const bundled = new Set(String(c.bundle_products || '').split(',').filter(Boolean));
  const listedBanks = state.meta.banks.flatMap((g) => g.banks);
  // Fields this viewer may not read; they can still type a replacement without seeing the old value.
  const hiddenFields = new Set(c.hidden_fields || []);
  const maskedFields = new Set(id ? c.masked_fields || [] : []);
  const canSpeak = speechSupported();
  const micIcon = raw('<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3"/></svg>');
  // `dictate` adds a microphone to type by voice; `readBack` adds a check where the number is read aloud.
  const field = (name, text, { type = 'text', required = false, full = false, placeholder = '', attrs = '', hint = '', dictate = false, readBack = false } = {}) => {
    const masked = hiddenFields.has(name) || maskedFields.has(name);
    const mic = canSpeak && dictate ? html`<button type="button" class="mic" data-dictate="${name}" title="Type by voice" aria-label="Dictate ${text}">${micIcon}</button>` : '';
    const check = canSpeak && readBack ? html`<div class="readback" data-readback="${name}"><button type="button" class="btn-link" data-readback-btn="${name}">${micIcon} Read it back to check</button><span class="readback-status" aria-live="polite"></span></div>` : '';
    return html`
    <div class="${full ? 'full' : ''}">
      <label for="f-${name}">${text}${required ? raw(' <span class="req">*</span>') : ''}${masked ? raw(' <span class="lock">Hidden</span>') : ''}</label>
      <div class="${mic ? 'with-mic' : ''}">${type === 'textarea'
        ? html`<textarea id="f-${name}" name="${name}" placeholder="${placeholder}">${c[name] ?? ''}</textarea>`
        : html`<input id="f-${name}" name="${name}" type="${type}" value="${masked ? '' : c[name] ?? ''}" placeholder="${hiddenFields.has(name) ? 'Hidden. Type a new value only to replace it' : masked ? `${c[name]} — type a new value only to replace it` : placeholder}" ${required && !masked ? raw('required') : ''} ${raw(attrs)} ${masked ? raw('data-masked') : ''}>`}${mic}</div>
      ${check}
      ${hint ? html`<div class="muted small">${hint}</div>` : ''}
    </div>`;
  };
  const money = 'inputmode="decimal" min="0" step="any"';

  shell(html`
    <div class="page-head"><div>
      <h1>${id ? `Edit ${c.ref}` : 'New sourcing case'}</h1>
      <p class="muted" style="margin:0">${id ? 'Update the customer details, then save.' : 'Enter the customer you sourced. The file is saved with case status Sent to checker and goes to the processing team for a verification call.'}</p>
    </div>${id ? html`<div>${caseBadge(c.case_status)}</div>` : ''}</div>
    <form class="card case-form" id="case-form" novalidate>
      ${lead ? html`<input type="hidden" name="lead_id" value="${lead.id}"><div class="callout info"><strong>From your lead ${lead.customer_name}.</strong> The details below came across from the lead; check them and complete the file. Submitting marks the lead converted.</div>` : ''}
      ${c.status === 'returned_to_sales' ? html`<div class="callout info"><strong>Returned by team leader</strong>${c.tl_note}</div>` : ''}

      <section>
        <h2>Sales staff</h2>
        ${profileGap ? html`<div class="callout warn"><strong>Your sales profile is incomplete.</strong>Ask a team leader to add your sales code, team leader and sales manager on the Users page before you submit files.</div>` : ''}
        <div class="form-grid four">
          <div>
            <label for="f-sales_staff_id">Sales staff full name ${pickStaff ? raw('<span class="req">*</span>') : ''}</label>
            ${pickStaff
              ? html`<select id="f-sales_staff_id" name="sales_staff_id" required>
                  <option value="">Choose the sales person…</option>
                  ${staffList.map((st) => html`<option value="${st.id}" ${st.id === staffNow?.id ? raw('selected') : ''}>${st.name}${st.sales_code ? ` (${st.sales_code})` : ''}</option>`)}
                </select>`
              : html`<input id="f-sales_staff_id" value="${staffNow?.name || ''}" readonly>`}
          </div>
          <div><label for="f-sales_code">Sales code</label><input id="f-sales_code" value="${staffNow?.sales_code || ''}" readonly placeholder="From the user profile"></div>
          <div><label for="f-team_leader_name">Team leader</label><input id="f-team_leader_name" value="${staffNow?.team_leader_name || ''}" readonly placeholder="From the user profile"></div>
          <div><label for="f-sales_manager_name">Sales manager</label><input id="f-sales_manager_name" value="${staffNow?.sales_manager_name || ''}" readonly placeholder="From the user profile"></div>
        </div>
      </section>

      <section>
        <div class="section-head">
          <h2>Customer</h2>
          <button type="button" class="btn scan-btn" id="scan-eid">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 7V5a2 2 0 0 1 2-2h2M17 3h2a2 2 0 0 1 2 2v2M21 17v2a2 2 0 0 1-2 2h-2M7 21H5a2 2 0 0 1-2-2v-2"/><path d="M7 15h10M7 12h10M7 9h4"/></svg>
            Scan Emirates ID
          </button>
        </div>
        ${canSpeak ? html`<p class="muted small voice-hint">Tap a microphone to type by voice.</p>` : ''}
        <div id="scan-result"></div>
        <div class="form-grid three">
          <div class="field-row"><label for="f-salutation">Salutation</label><select id="f-salutation" name="salutation"><option value="">—</option>${state.meta.salutations.map((o) => html`<option value="${o}" ${c.salutation === o ? raw('selected') : ''}>${o}</option>`)}</select></div>
          ${field('first_name', 'First name', { required: true, attrs: 'autocomplete="off"', dictate: true })}
          ${field('middle_name', 'Middle name', { attrs: 'autocomplete="off"', dictate: true })}
          ${field('last_name', 'Last name', { required: true, attrs: 'autocomplete="off"', dictate: true })}
          ${field('phone', 'Mobile number', { type: 'tel', required: true, placeholder: '+971 50 123 4567' })}
          ${field('email', 'Email address', { type: 'email', placeholder: 'name@example.com', attrs: 'autocomplete="off"' })}
        </div>
      </section>

      <section>
        <h2>Employment</h2>
        <div class="form-grid">
          ${field('company_name', 'Company name', { placeholder: 'Employer', dictate: true })}
          ${field('salary', 'Monthly salary (AED)', { type: 'number', attrs: money })}
          <div>
            <label for="f-salary_bank">Salary transferred to <span class="req">*</span></label>
            <select id="f-salary_bank" name="salary_bank" required>
              <option value="">Choose the customer's salary bank…</option>
              ${state.meta.banks.map((g) => html`<optgroup label="${g.group}">${g.banks.map((b) => html`<option value="${b}" ${c.salary_bank === b ? raw('selected') : ''}>${b}</option>`)}</optgroup>`)}
              <option value="${OTHER_BANK}" ${c.salary_bank && !listedBanks.includes(c.salary_bank) ? raw('selected') : ''}>Other bank (type the name)</option>
            </select>
            <input id="f-salary_bank_other" name="salary_bank_other" placeholder="Bank name" aria-label="Other salary bank" value="${c.salary_bank && !listedBanks.includes(c.salary_bank) ? c.salary_bank : ''}" ${c.salary_bank && !listedBanks.includes(c.salary_bank) ? '' : raw('hidden disabled')} style="margin-top:6px">
          </div>
        </div>
      </section>

      <section>
        <h2>Application</h2>
        <div class="form-grid four">
          ${field('sourcing_date', 'Sourcing date', { type: 'date', required: true, attrs: `max="${todayLocal()}"` })}
          <div>
            <label for="f-region">Region <span class="req">*</span></label>
            <select id="f-region" name="region" required>
              <option value="">Choose…</option>
              ${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${(c.region || (!id && staffNow?.region)) === k ? raw('selected') : ''}>${l}</option>`)}
            </select>
          </div>
          ${field('bidaya_id', 'Bidaya ID')}
          ${field('app_id', 'App ID')}
        </div>
      </section>

      <section>
        <h2>Product</h2>
        <div class="form-grid">
          <div>
            <label for="f-core_product">Core product <span class="req">*</span></label>
            <select id="f-core_product" name="core_product" required>
              <option value="">Choose…</option>
              ${Object.entries(state.meta.core_products).map(([k, l]) => html`<option value="${k}" ${(c.core_product || (!id && staffNow?.core_product)) === k ? raw('selected') : ''}>${l}</option>`)}
            </select>
          </div>
          <div>
            <label for="f-product">Product <span class="req">*</span></label>
            <select id="f-product" name="product" required>
              <option value="">Choose a product…</option>
              ${[...Object.entries(products), ['bundle', 'Bundle (multiple products)']].map(([k, l]) => html`<option value="${k}" ${c.product === k ? raw('selected') : ''}>${l}</option>`)}
            </select>
          </div>
          <fieldset class="full bundle-picker" id="bundle-picker" ${c.product === 'bundle' ? '' : raw('hidden')}>
            <legend>Products in this bundle <span class="req">*</span> <span class="muted small">Pick at least two</span></legend>
            <div class="checks">
              ${Object.entries(products).map(([k, l]) => html`<label class="check"><input type="checkbox" name="bundle_products" value="${k}" ${bundled.has(k) ? raw('checked') : ''}> ${l}</label>`)}
            </div>
          </fieldset>
          <fieldset class="full product-detail" id="loan-type-field" hidden>
            <legend>Personal loan</legend>
            <div class="sub-label">Loan type <span class="req">*</span></div>
            <div class="segmented">
              ${Object.entries(state.meta.personal_loan_types).map(([k, l]) => html`<label><input type="radio" name="personal_loan_type" value="${k}" required disabled ${c.personal_loan_type === k ? raw('checked') : ''}><span>${l}</span></label>`)}
            </div>
            <div class="form-grid three">
              ${field('loan_amount', 'Loan amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-pl' })}
              ${field('interest_rate', 'Interest rate (%)', { type: 'number', required: true, placeholder: 'e.g. 5.99', attrs: 'inputmode="decimal" min="0" max="100" step="0.01" disabled data-pl' })}
              ${field('fpd', 'FPD (first payment date)', { type: 'date', required: true, attrs: 'disabled data-pl', hint: 'When the first instalment is due' })}
              ${field('pl_tenure', 'Tenure (months)', { type: 'number', required: true, placeholder: `up to ${state.meta.tenure_max.personal_loan}`, attrs: `inputmode="numeric" min="1" max="${state.meta.tenure_max.personal_loan}" step="1" disabled data-pl` })}
            </div>
            <div class="form-grid" id="topup-fields" hidden>
              ${field('full_loan_amount', 'Full loan amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-topup', hint: 'Total loan after the top up' })}
              ${field('incremental_amount', 'Incremental amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-topup', hint: 'New money added by the top up' })}
            </div>
            <div id="primary-buyout" class="buyout-block" hidden>
              <div class="sub-label">Primary buyout <span class="req">*</span></div>
              <p class="muted small" style="margin:0 0 8px">The personal loan being bought out, its bank and the outstanding amount. Add any other liabilities this loan also clears.</p>
              <div data-builder="primary"></div>
            </div>
            <div id="secondary-buyout" class="buyout-block" hidden>
              <div class="sub-label">Any secondary buyouts? <span class="req">*</span></div>
              <div class="segmented two-up" role="radiogroup" aria-label="Secondary buyouts">
                <label><input type="radio" name="secondary_buyout" value="yes" required disabled ${c.secondary_buyout === 'yes' ? raw('checked') : ''}><span>Yes</span></label>
                <label><input type="radio" name="secondary_buyout" value="no" required disabled ${c.secondary_buyout === 'no' ? raw('checked') : ''}><span>No</span></label>
              </div>
              <div data-builder="secondary" style="margin-top:10px" hidden></div>
            </div>
            <input type="hidden" name="pl_buyouts" id="f-pl_buyouts">
          </fieldset>
          <fieldset class="full product-detail" id="auto-field" hidden>
            <legend>Auto loan</legend>
            <div class="sub-label">Auto loan type <span class="req">*</span></div>
            <div class="segmented two-up">
              ${Object.entries(state.meta.auto_loan_types).map(([k, l]) => html`<label><input type="radio" name="auto_loan_type" value="${k}" required disabled ${c.auto_loan_type === k ? raw('checked') : ''}><span>${l}</span></label>`)}
            </div>
            <div class="sub-label" style="margin-top:12px">Payout class <span class="muted">(the bank's classification; it sets the loan's points)</span></div>
            <div class="segmented three-up">
              ${Object.entries(state.meta.auto_loan_classes || {}).map(([k, l]) => html`<label><input type="radio" name="al_payout_class" value="${k}" disabled ${(c.al_payout_class || 'full') === k ? raw('checked') : ''}><span>${l}</span></label>`)}
            </div>
            <div class="form-grid three" style="margin-top:12px">
              ${field('car_make', 'Car make', { required: true, placeholder: 'e.g. Toyota', attrs: 'disabled data-al', dictate: true })}
              ${field('car_model', 'Car model', { required: true, placeholder: 'e.g. Land Cruiser', attrs: 'disabled data-al', dictate: true })}
              ${field('car_year', 'Car year', { type: 'number', required: true, placeholder: String(new Date().getFullYear()), attrs: `inputmode="numeric" min="1990" max="${new Date().getFullYear() + 1}" step="1" disabled data-al` })}
              ${field('amount', 'Loan amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-al' })}
              ${field('al_interest_rate', 'ROI (%)', { type: 'number', required: true, placeholder: 'e.g. 3.25', attrs: 'inputmode="decimal" min="0" max="100" step="0.01" disabled data-al' })}
              ${field('al_tenure', 'Tenure (months)', { type: 'number', required: true, placeholder: `up to ${state.meta.tenure_max.auto_loan}`, attrs: `inputmode="numeric" min="1" max="${state.meta.tenure_max.auto_loan}" step="1" disabled data-al` })}
              ${field('dealer_details', 'Dealer details', { placeholder: 'Dealer name, branch, contact', attrs: 'disabled data-al', dictate: true })}
              ${field('al_lead_source', 'Lead source', { required: true, placeholder: 'e.g. Dealer referral, Walk-in', attrs: 'disabled data-al', dictate: true })}
            </div>
          </fieldset>
          <fieldset class="full product-detail" id="card-field" hidden>
            <legend>Credit card</legend>
            <label for="f-credit_card">Credit card <span class="req">*</span></label>
            <select id="f-credit_card" name="credit_card" required disabled>
              <option value="">Choose a card…</option>
              ${state.meta.credit_cards.map((f) => html`<optgroup label="${f.family}">
                ${f.cards.map((card) => html`<option value="${card.name}" data-category="${card.category}" data-points="${card.points ?? ''}" data-min-salary="${card.min_salary ?? ''}" ${c.credit_card === card.name ? raw('selected') : ''}>${card.name}</option>`)}
              </optgroup>`)}
              ${c.credit_card && !state.meta.credit_cards.some((f) => f.cards.some((card) => card.name === c.credit_card)) ? html`<option value="${c.credit_card}" data-category="${c.card_category || ''}" selected>${c.credit_card} (retired)</option>` : ''}
            </select>
            <div class="form-grid two" style="margin-top:12px">
              <div><label for="f-card_category">Card category</label><input id="f-card_category" value="${c.card_category || ''}" readonly placeholder="From the card chosen" tabindex="-1"></div>
              <div><label for="f-card_points">Points</label><input id="f-card_points" value="${c.card_points ?? ''}" readonly placeholder="Not set yet" tabindex="-1"></div>
            </div>
            <div id="card-salary-check" data-exception="${c.card_salary_exception || ''}" data-note="${c.card_exception_note || ''}" data-known-below="${c.status === 'awaiting_approval' || c.card_salary_exception ? '1' : ''}"></div>
            <div class="sub-label" style="margin-top:12px">Card sourced type <span class="req">*</span></div>
            <div class="segmented three-up">
              ${Object.entries(state.meta.card_fee_types).map(([k, l]) => html`<label><input type="radio" name="card_fee_type" value="${k}" required disabled ${c.card_fee_type === k ? raw('checked') : ''}><span>${l}</span></label>`)}
            </div>
          </fieldset>
        </div>
      </section>

      <details class="more" ${[c.alt_phone, c.address, c.city, c.source, c.sales_notes].some(Boolean) ? raw('open') : ''}>
        <summary>More details (optional)</summary>
        <div class="form-grid">
          ${field('alt_phone', 'Alternate phone', { type: 'tel' })}
          ${field('address', 'Address', { full: true, dictate: true })}
          ${field('city', 'City', { dictate: true })}
          ${field('source', 'Lead source', { placeholder: 'e.g. Referral, Walk-in, Field visit', dictate: true })}
          ${field('sales_notes', 'Notes for the processing team', { type: 'textarea', full: true, placeholder: 'Best time to call, language preference, anything to verify…', dictate: true })}
        </div>
      </details>

      ${id && c.status === 'completed' ? html`<div class="callout warn" style="margin-top:16px"><strong>Verification is already completed on this file.</strong>Changing the product, card or card sourced type, loan amount, interest rate, tenure, top-up amounts, FPD or the car and auto loan details sends it back to the processing team for a fresh verification. Other details can be changed freely.</div>` : ''}
      <p class="error" id="form-error" hidden></p>
      <div class="actions" style="margin-top:16px">
        <button class="btn-primary">${id ? 'Save changes' : 'Submit for verification'}</button>
        ${c.status === 'returned_to_sales' ? html`<button type="button" class="btn-success" id="save-resubmit">Save &amp; resubmit</button>` : ''}
        <a class="btn" href="${id ? `#/cases/${id}` : '#/'}">Cancel</a>
      </div>
    </form>`);

  const form = document.getElementById('case-form');
  const $ = (sel) => form.querySelector(sel);
  const productSelect = $('#f-product');
  const picker = $('#bundle-picker');
  const boxes = [...picker.querySelectorAll('input[type=checkbox]')];
  const loanField = $('#loan-type-field');
  const loanRadios = [...loanField.querySelectorAll('input[type=radio]')];
  const topupFields = $('#topup-fields');
  const bankField = $('#bank-field');
  const primaryBlock = $('#primary-buyout');
  const secondaryBlock = $('#secondary-buyout');
  const secondaryRadios = [...form.querySelectorAll('input[name=secondary_buyout]')];
  const cardField = $('#card-field');
  const autoField = $('#auto-field');
  const cardSelect = $('#f-credit_card');
  // The category and points come from the product list for the card chosen; staff do not type them.
  const syncCard = () => {
    const opt = cardSelect.selectedOptions[0];
    $('#f-card_category').value = opt?.dataset.category || '';
    $('#f-card_points').value = opt?.dataset.points || '';
    checkCardSalary();
  };
  // The salary check: a card the customer earns too little for needs a reason or team approval; a
  // salary that qualifies for a higher card prompts the sales person to offer one.
  const salaryInput = $('#f-salary');
  const checkBox = $('#card-salary-check');
  const allCards = state.meta.credit_cards.flatMap((f) => f.cards);
  const checkCardSalary = () => {
    const opt = cardSelect.selectedOptions[0];
    const min = opt?.dataset.minSalary ? Number(opt.dataset.minSalary) : null;
    const typed = salaryInput.value.replace(/,/g, '').trim();
    // On an edit form the salary is masked; the server's own verdict stands until a new salary is typed.
    const masked = salaryInput.hasAttribute('data-masked') && typed === '';
    const salary = typed === '' ? NaN : Number(typed);
    if (cardField.hidden || !opt?.value || min == null) { checkBox.innerHTML = ''; checkBox.dataset.state = ''; return; }
    if (Number.isNaN(salary) && !masked) {
      checkBox.dataset.state = 'no-salary';
      checkBox.innerHTML = html`<div class="callout warn small"><strong>Enter the customer's monthly salary.</strong> ${opt.value} needs AED ${min.toLocaleString()}; the salary decides whether this card can go ahead.</div>`.s;
      return;
    }
    const below = masked ? (checkBox.dataset.knownBelow === '1' && opt.value === c.credit_card) : salary < min;
    if (below) {
      const chosen = checkBox.dataset.exception || '';
      checkBox.dataset.state = 'below';
      checkBox.innerHTML = html`<div class="callout danger card-check">
        <strong>Salary below the card requirement.</strong> ${opt.value} needs AED ${min.toLocaleString()} a month${masked ? '' : `; the customer earns AED ${salary.toLocaleString()}`}.
        <div class="sub-label" style="margin-top:10px">Why is this card being sold?</div>
        <div class="segmented two-up" role="radiogroup" aria-label="Reason">
          ${Object.entries(state.meta.card_exceptions).map(([k, l]) => html`<label><input type="radio" name="card_salary_exception" value="${k}" ${chosen === k ? raw('checked') : ''}><span>${l}</span></label>`)}
        </div>
        <input name="card_exception_note" placeholder="Reference or note (optional)" value="${checkBox.dataset.note || ''}" style="margin-top:8px">
        <p class="muted small" style="margin:8px 0 0">Pick one to send the file straight for verification. Without a reason, the file first goes to your team leader or sales manager for approval.</p>
      </div>`.s;
      checkBox.querySelectorAll('[name=card_salary_exception]').forEach((i) => (i.onchange = () => { checkBox.dataset.exception = i.value; }));
      return;
    }
    if (masked) { checkBox.innerHTML = ''; checkBox.dataset.state = 'ok'; return; }
    const higher = allCards.filter((k) => k.min_salary != null && k.min_salary > min && k.min_salary <= salary).sort((a, b) => b.min_salary - a.min_salary);
    checkBox.dataset.state = higher.length ? 'higher' : 'ok';
    checkBox.innerHTML = higher.length ? html`<div class="callout info card-check">
      <strong>The customer qualifies for a higher card.</strong> A salary of AED ${salary.toLocaleString()} meets the requirement for ${higher.length} ${higher.length === 1 ? 'card' : 'cards'} above ${opt.dataset.category || 'this one'}. Consider offering one:
      <div class="chips" style="margin-top:8px">${higher.slice(0, 6).map((k) => html`<button type="button" class="chip" data-pick-card="${k.name}" title="Needs AED ${k.min_salary.toLocaleString()}">${k.name} · ${k.category}</button>`)}${higher.length > 6 ? html`<span class="muted small" style="align-self:center">and ${higher.length - 6} more in the card list</span>` : ''}</div>
    </div>`.s : html`<p class="muted small" style="margin:8px 0 0">Salary meets the AED ${min.toLocaleString()} requirement for this card.</p>`.s;
    checkBox.querySelectorAll('[data-pick-card]').forEach((b) => (b.onclick = () => { cardSelect.value = b.dataset.pickCard; syncCard(); }));
  };
  salaryInput.addEventListener('input', checkCardSalary);
  cardSelect.onchange = syncCard;
  syncCard();
  const fullAmount = $('#f-full_loan_amount');
  const increment = $('#f-incremental_amount');

  const updateProductFields = () => {
    const isBundle = productSelect.value === 'bundle';
    picker.hidden = !isBundle;
    const count = boxes.filter((b) => b.checked).length;
    boxes[0].setCustomValidity(isBundle && count < 2 ? 'Pick at least two products for a bundle' : '');
    // Ask for product details only when that product is chosen or part of the bundle.
    const includes = (p) => productSelect.value === p || (isBundle && boxes.some((b) => b.value === p && b.checked));
    const loanType = loanRadios.find((r) => r.checked)?.value;
    loanField.hidden = !includes('personal_loan');
    loanRadios.forEach((r) => (r.disabled = loanField.hidden));
    form.querySelectorAll('[data-pl]').forEach((i) => (i.disabled = loanField.hidden));
    topupFields.hidden = loanField.hidden || loanType !== 'top_up';
    form.querySelectorAll('[data-topup]').forEach((i) => (i.disabled = topupFields.hidden));
    primaryBlock.hidden = loanField.hidden || loanType !== 'buy_out';
    secondaryBlock.hidden = loanField.hidden || !['fresh', 'buy_out', 'top_up'].includes(loanType);
    secondaryRadios.forEach((r) => (r.disabled = secondaryBlock.hidden));
    secondaryBlock.querySelector('[data-builder]').hidden = secondaryBlock.hidden || !secondaryRadios.some((r) => r.checked && r.value === 'yes');
    autoField.hidden = !includes('auto_loan');
    autoField.querySelectorAll('input[name=auto_loan_type], input[name=al_payout_class]').forEach((r) => (r.disabled = autoField.hidden));
    form.querySelectorAll('[data-al]').forEach((i) => (i.disabled = autoField.hidden));
    cardField.hidden = !includes('credit_card');
    cardSelect.disabled = cardField.hidden;
    cardField.querySelectorAll('input[name=card_fee_type]').forEach((r) => (r.disabled = cardField.hidden));
    checkIncrement();
  };
  const checkIncrement = () => {
    const over = !increment.disabled && fullAmount.value && increment.value && Number(increment.value) > Number(fullAmount.value);
    increment.setCustomValidity(over ? 'Incremental amount cannot be more than the full loan amount' : '');
  };
  // Suggest the core product from the product until the user picks one themselves.
  const coreSelect = $('#f-core_product');
  let coreTouched = Boolean(c.core_product || (!id && staffNow?.core_product));
  coreSelect.onchange = () => { coreTouched = true; };
  const suggestCore = () => {
    if (coreTouched) return;
    const map = { personal_loan: 'personal_loan', credit_card: 'credit_card', auto_loan: 'auto_loan', bundle: 'multi_product' };
    coreSelect.value = map[productSelect.value] || '';
  };
  productSelect.onchange = () => { updateProductFields(); suggestCore(); };
  const staffSelect = pickStaff ? $('#f-sales_staff_id') : null;
  if (staffSelect) {
    staffSelect.onchange = () => {
      const st = staffList.find((x) => x.id === Number(staffSelect.value)) || {};
      $('#f-sales_code').value = st.sales_code || '';
      $('#f-team_leader_name').value = st.team_leader_name || '';
      $('#f-sales_manager_name').value = st.sales_manager_name || '';
      if (!id && st.region) $('#f-region').value = st.region;
      if (!id && st.core_product) { coreSelect.value = st.core_product; coreTouched = true; }
    };
  }
  boxes.forEach((b) => (b.onchange = updateProductFields));
  loanRadios.forEach((r) => (r.onchange = updateProductFields));
  secondaryRadios.forEach((r) => (r.onchange = updateProductFields));
  const salaryBank = $('#f-salary_bank');
  const salaryBankOther = $('#f-salary_bank_other');
  salaryBank.onchange = () => { const other = salaryBank.value === OTHER_BANK; salaryBankOther.hidden = !other; salaryBankOther.disabled = !other; salaryBankOther.required = other; if (other) salaryBankOther.focus(); };
  // Buyout builders: what the loan buys out, as rows of kind, bank and amount; cards ask how many.
  const bankOptions = (chosen) => html`<option value="">Bank…</option>${state.meta.banks.map((g) => html`<optgroup label="${g.group}">${g.banks.map((b) => html`<option value="${b}" ${chosen === b ? raw('selected') : ''}>${b}</option>`)}</optgroup>`)}<option value="${OTHER_BANK}" ${chosen && !listedBanks.includes(chosen) ? raw('selected') : ''}>Other bank (type the name)</option>`;
  const builders = {};
  for (const role of ['primary', 'secondary']) {
    const host = form.querySelector(`[data-builder="${role}"]`);
    // Existing entries: cards of the same role group into one card entry, the rest one entry each.
    const existing = (c.pl_buyouts || []).filter((b) => b.role === role);
    const entries = [];
    const cards = existing.filter((b) => b.kind === 'credit_card');
    if (cards.length) entries.push({ kind: 'credit_card', cards: cards.map((b) => ({ bank: b.bank, amount: b.amount })) });
    for (const b of existing.filter((b) => b.kind !== 'credit_card')) entries.push({ kind: b.kind, bank: b.bank, amount: b.amount });
    if (role === 'primary' && !entries.some((e) => e.kind === 'personal_loan')) entries.unshift({ kind: 'personal_loan', bank: c.buyout_bank || '', amount: '' });
    const kinds = role === 'primary' ? state.meta.buyout_kinds : Object.fromEntries(state.meta.secondary_buyout_kinds.map((k) => [k, state.meta.buyout_kinds[k]]));
    builders[role] = entries;
    const render = () => {
      const rows = entries.map((e, i) => html`<div class="buyout-row" data-i="${i}">
        <div class="buyout-head">
          ${role === 'primary' && e.kind === 'personal_loan' ? html`<strong class="small" style="flex:1">Personal loan being bought out <span class="req">*</span></strong>` : html`<select data-kind aria-label="What is being bought out"><option value="">What is bought out…</option>${Object.entries(kinds).map(([k, l]) => html`<option value="${k}" ${e.kind === k ? raw('selected') : ''}>${l}</option>`)}</select>`}
          ${e.kind === 'credit_card' ? html`<label class="small">How many cards? <input type="number" min="1" max="10" step="1" data-count value="${e.cards?.length || 1}" style="width:70px"></label>` : ''}
          ${role === 'primary' && e.kind === 'personal_loan' ? '' : html`<button type="button" class="btn-link" data-remove title="Remove">Remove</button>`}
        </div>
        ${e.kind === 'credit_card'
          ? html`${(e.cards || [{}]).map((card, j) => html`<div class="buyout-line" data-j="${j}"><span class="muted small">Card ${j + 1}</span><select data-bank aria-label="Card ${j + 1} bank">${bankOptions(card.bank)}</select><input data-bank-other placeholder="Bank name" value="${card.bank && !listedBanks.includes(card.bank) ? card.bank : ''}" ${card.bank && !listedBanks.includes(card.bank) ? '' : raw('hidden')}><input type="number" data-amount inputmode="decimal" min="0" step="any" placeholder="Card limit (AED)" value="${card.amount ?? ''}" aria-label="Card ${j + 1} limit"></div>`)}`
          : e.kind ? html`<div class="buyout-line"><select data-bank aria-label="Bank">${bankOptions(e.bank)}</select><input data-bank-other placeholder="Bank name" value="${e.bank && !listedBanks.includes(e.bank) ? e.bank : ''}" ${e.bank && !listedBanks.includes(e.bank) ? '' : raw('hidden')}><input type="number" data-amount inputmode="decimal" min="0" step="any" placeholder="${e.kind === 'mortgage' ? 'Outstanding (AED)' : 'Loan amount (AED)'}" value="${e.amount ?? ''}" aria-label="Amount"></div>` : ''}
      </div>`);
      host.innerHTML = html`${rows}<button type="button" class="btn" data-add>${role === 'primary' ? '+ Add another liability bought out' : `+ Add ${entries.length ? 'another' : 'a'} secondary buyout`}</button>`.s;
      host.querySelector('[data-add]').onclick = () => { entries.push({ kind: '' }); render(); };
      host.querySelectorAll('.buyout-row').forEach((rowEl) => {
        const e = entries[Number(rowEl.dataset.i)];
        rowEl.querySelector('[data-remove]')?.addEventListener('click', () => { entries.splice(Number(rowEl.dataset.i), 1); render(); });
        rowEl.querySelector('[data-kind]')?.addEventListener('change', (ev) => { e.kind = ev.target.value; if (e.kind === 'credit_card' && !e.cards) e.cards = [{}]; render(); });
        rowEl.querySelector('[data-count]')?.addEventListener('change', (ev) => { const n = Math.max(1, Math.min(10, Number(ev.target.value) || 1)); e.cards = Array.from({ length: n }, (_, j) => e.cards?.[j] || {}); render(); });
        rowEl.querySelectorAll('.buyout-line').forEach((line) => {
          const target = e.kind === 'credit_card' ? e.cards[Number(line.dataset.j)] : e;
          const sel = line.querySelector('[data-bank]'); const other = line.querySelector('[data-bank-other]'); const amt = line.querySelector('[data-amount]');
          sel.onchange = () => { other.hidden = sel.value !== OTHER_BANK; target.bank = sel.value === OTHER_BANK ? other.value.trim() : sel.value; if (!other.hidden) other.focus(); };
          other.oninput = () => { target.bank = other.value.trim(); };
          amt.oninput = () => { target.amount = amt.value; };
        });
      });
    };
    render();
  }
  // Flattens the builders into the list the server stores: one entry per card, one per loan.
  const collectBuyouts = () => {
    const out = [];
    for (const role of ['primary', 'secondary']) {
      if (role === 'primary' && primaryBlock.hidden) continue;
      if (role === 'secondary' && (secondaryBlock.hidden || !secondaryRadios.some((r) => r.checked && r.value === 'yes'))) continue;
      for (const e of builders[role]) {
        if (!e.kind) continue;
        if (e.kind === 'credit_card') for (const card of e.cards || []) out.push({ role, kind: 'credit_card', bank: card.bank || '', amount: card.amount ?? '' });
        else out.push({ role, kind: e.kind, bank: e.bank || '', amount: e.amount ?? '' });
      }
    }
    return out;
  };
  fullAmount.oninput = increment.oninput = checkIncrement;
  // Show the Emirates ID in its usual 784-YYYY-NNNNNNN-C layout once typed.
  const eid = $('#f-eid_number');
  if (eid) eid.onblur = () => {
    const d = eid.value.replace(/\D/g, '');
    if (/^784\d{12}$/.test(d)) eid.value = `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}`;
  };
  updateProductFields();

  // Emirates ID scan: fills the name and ID number for the sales person to check.
  // Voice: dictation into a box, and reading an ID number back to check it.
  const readBackOk = new Set();
  let stopListening = null;
  const stopAll = () => { if (stopListening) { stopListening(); stopListening = null; } form.querySelectorAll('.mic.listening').forEach((b) => b.classList.remove('listening')); };
  form.querySelectorAll('[data-dictate]').forEach((btn) => (btn.onclick = () => {
    const input = $(`#f-${btn.dataset.dictate}`);
    if (btn.classList.contains('listening')) return stopAll();
    stopAll();
    btn.classList.add('listening');
    const before = input.value;
    const isNote = input.tagName === 'TEXTAREA';
    stopListening = listen({
      onResult: (text, { final }) => {
        // Names and places are typed in Title Case; notes keep the sentence as spoken.
        const spoken = isNote ? text : text.replace(/\b([a-z])/g, (m) => m.toUpperCase());
        input.value = isNote && before ? `${before.replace(/\s+$/, '')} ${spoken}` : spoken;
        if (final) { input.dispatchEvent(new Event('input', { bubbles: true })); }
      },
      onError: (msg) => toast(msg, true),
      onEnd: () => { btn.classList.remove('listening'); stopListening = null; },
    });
  }));
  form.querySelectorAll('[data-readback-btn]').forEach((btn) => (btn.onclick = () => {
    const name = btn.dataset.readbackBtn;
    const input = $(`#f-${name}`);
    const status = btn.parentElement.querySelector('.readback-status');
    const value = input.value.trim();
    if (!value) { status.textContent = 'Type or scan the number first.'; status.className = 'readback-status muted'; return; }
    stopAll();
    btn.classList.add('listening');
    status.textContent = 'Listening… read the number aloud, digit by digit.';
    status.className = 'readback-status muted';
    let heardText = '';
    stopListening = listen({
      onResult: (text, { final }) => {
        heardText = text;
        const r = readBackMatches(value, text);
        if (final || r.match) {
          if (r.match) {
            readBackOk.add(name);
            status.textContent = '✓ Matches what you read';
            status.className = 'readback-status ok';
            input.classList.add('verified');
            if (stopListening) stopAll();
          } else if (final) {
            readBackOk.delete(name);
            status.textContent = `✗ Doesn't match. Heard "${r.heard || text}", box has ${r.want}`;
            status.className = 'readback-status bad';
            input.classList.remove('verified');
          }
        }
      },
      onError: (msg) => { status.textContent = msg; status.className = 'readback-status bad'; },
      onEnd: () => { btn.classList.remove('listening'); stopListening = null; if (!heardText && status.textContent.startsWith('Listening')) { status.textContent = 'Nothing heard. Try again.'; status.className = 'readback-status muted'; } },
    });
    // Any change to the number cancels its check.
    input.addEventListener('input', () => { readBackOk.delete(name); input.classList.remove('verified'); status.textContent = ''; }, { once: true });
  }));
  window.addEventListener('hashchange', stopAll, { once: true });

  // Emirates ID: dashes appear as the digits are typed (784-YYYY-NNNNNNN-C), and pasted numbers
  // with or without dashes are tidied the same way.
  const eidInput = $('#f-eid_number') || document.createElement('input');
  const formatEid = () => {
    const digits = eidInput.value.replace(/\D/g, '').slice(0, 15);
    const groups = [digits.slice(0, 3), digits.slice(3, 7), digits.slice(7, 14), digits.slice(14, 15)].filter(Boolean);
    const pretty = groups.join('-');
    if (eidInput.value !== pretty) {
      // Keep the cursor at the end when typing forward; browsers move it after a value change.
      const atEnd = eidInput.selectionStart === eidInput.value.length;
      eidInput.value = pretty;
      if (!atEnd) eidInput.setSelectionRange(pretty.length, pretty.length);
    }
  };
  eidInput.addEventListener('input', formatEid);
  if (eidInput.value) formatEid();

  let scanned = false;
  $('#scan-eid').onclick = async () => {
    const result = await openEidScanner(state.meta.ocr);
    if (!result) return;
    for (const [name, value] of Object.entries(result.fields)) {
      const input = $(`#f-${name}`);
      if (!input || !value) continue;
      input.value = value;
      input.classList.add('scanned');
      input.addEventListener('input', () => input.classList.remove('scanned'), { once: true });
    }
    scanned = result.side;
    const warnings = [...result.notes];
    const expired = result.expiryDate && result.expiryDate < todayLocal();
    if (expired) warnings.unshift(`This Emirates ID expired on ${fmtDay(result.expiryDate)}.`);
    $('#scan-result').innerHTML = html`<div class="callout ${expired || result.side === 'back' && warnings.length ? 'warn' : 'success'} scan-callout">
      <strong>Filled from the ${result.side} of the Emirates ID: the customer's name.</strong>
      Check them against the card before submitting.${result.expiryDate && !expired ? html` <span class="muted">Card valid until ${fmtDay(result.expiryDate)}.</span>` : ''}
      ${warnings.map((w) => html`<div class="scan-warning">${w}</div>`)}
    </div>`.s;
    toast(`Details filled from the ${result.side} of the Emirates ID`);
  };

  const save = async (resubmit) => {
    const err = document.getElementById('form-error');
    err.hidden = true;
    if (!form.checkValidity()) {
      // Open the optional section if the problem is in there, then point at the first invalid field.
      const bad = form.querySelector(':invalid:not(fieldset)');
      bad?.closest('details')?.setAttribute('open', '');
      form.reportValidity();
      return;
    }
    const check = document.getElementById('card-salary-check');
    if (check?.dataset.state === 'below' && !form.querySelector('[name=card_salary_exception]:checked')) {
      if (!confirm('No reason chosen for selling this card below its salary requirement. Send the file to your team leader / sales manager for approval before verification?')) return;
    }
    try {
      const body = formData(form);
      if (check?.dataset.state === 'below' && !('card_salary_exception' in body)) body.card_salary_exception = '';
      body.bundle_products = body.product === 'bundle' ? new FormData(form).getAll('bundle_products') : [];
      for (const f of ['credit_card', 'card_fee_type', 'personal_loan_type', 'loan_amount', 'interest_rate', 'full_loan_amount', 'incremental_amount', 'fpd', 'pl_tenure', 'auto_loan_type', 'al_payout_class', 'car_make', 'car_model', 'car_year', 'dealer_details', 'al_lead_source', 'al_interest_rate', 'al_tenure', 'amount']) body[f] ??= null;
      // Leave hidden values untouched unless a replacement was typed.
      form.querySelectorAll('[data-masked]').forEach((i) => { if (!i.value.trim()) delete body[i.name]; });
      body.pl_buyouts = collectBuyouts();
      body.salary_bank = body.salary_bank === OTHER_BANK ? body.salary_bank_other?.trim() : body.salary_bank ?? null;
      delete body.salary_bank_other;
      if (scanned) body.eid_scanned = scanned;
      if (readBackOk.size) body.read_back = [...readBackOk];
      const res = id ? await api(`/cases/${id}`, { method: 'PUT', body }) : await api('/cases', { method: 'POST', body });
      if (resubmit) await api(`/cases/${id}/actions`, { method: 'POST', body: { action: 'resubmit' } });
      const reverified = id && c.status === 'completed' && res.case.status === 'pending_verification';
      toast(id ? (resubmit ? 'Saved and resubmitted for verification' : reverified ? 'Changes saved — sent back for re-verification' : 'Changes saved') : `${res.case.ref} submitted for verification`);
      go(`#/cases/${res.case.id}`);
    } catch (ex) {
      err.textContent = ex.message;
      err.hidden = false;
    }
  };
  form.onsubmit = (e) => { e.preventDefault(); save(false); };
  document.getElementById('save-resubmit')?.addEventListener('click', () => save(true));
}

// ---------- case detail ----------
function eventDetail(e) {
  if (e.type === 'edited') return `fields: ${e.detail}`;
  if (e.type === 're_verification') return `${e.detail} changed after verification was completed`;
  if (e.type === 'log_call' && e.detail?.startsWith('call_back_later ')) return `Call back later · ${fmtWhen(e.detail.slice(16))}`;
  if (e.type === 'callback_due') return `customer asked for ${e.detail}`;
  if (e.type === 'created' || e.type === 'case_status') return CASE_STATUS_LABEL[e.detail] || label(e.detail);
  if (e.type === 'request_edit' || e.type === 'resolve_edit_request') return `${state.meta.edit_queues[e.detail] || label(e.detail)} queue`;
  if (e.type === 'score_quality') return `${e.detail}/10`;
  if (e.type === 'complaint_decision') return e.detail === 'valid' ? 'Valid · removed from incentive' : 'Invalid · counts for incentive';
  if (['set_complaint', 'receive_recording', 'recording_it_email', 'card_status', 'bulk_upload', 'disbursal'].includes(e.type)) return e.detail;
  return label(e.detail);
}

const BOT_CALL_STATUS = { requested: 'Waiting for the bot', in_progress: 'On the call', completed: 'Finished', failed: 'Failed', expired: 'No result' };
const CHECK_RESULT = { confirmed: ['Confirmed', 'good'], mismatch: ['Did not match', 'bad'], not_answered: ['Not answered', ''] };

// The latest bot verification call: what the customer confirmed, the summary and the transcript.
function botCallCard(b) {
  return html`<div class="card">
    <h2>Bot call</h2>
    <p class="muted small">${BOT_CALL_STATUS[b.status] || label(b.status)} · requested by ${b.requested_by_name} ${ago(b.requested_at)}${b.outcome ? ` · ${label(b.outcome)}` : ''}</p>
    ${b.error ? html`<div class="callout danger"><strong>The bot could not place the call</strong>${b.error}</div>` : ''}
    ${b.checks.length ? html`<dl class="details">${b.checks.map((ch) => html`<dt>${ch.label}</dt><dd><span class="chip ${CHECK_RESULT[ch.result][1]}">${CHECK_RESULT[ch.result][0]}</span></dd>`)}</dl>` : ''}
    ${b.summary ? html`<div class="note">${b.summary}</div>` : ''}
    ${b.recording_url ? html`<p class="small"><a href="${b.recording_url}" target="_blank" rel="noopener noreferrer">Listen to the recording</a></p>` : ''}
    ${b.transcript ? html`<details><summary class="small">Transcript</summary><pre class="transcript">${b.transcript}</pre></details>` : ''}
  </div>`;
}

async function viewCase(id) {
  const { case: c } = await api(`/cases/${id}`);
  // A detail row; ID-style values use a monospace face so digits are easy to read back on a call.
  const hiddenFields = new Set(c.hidden_fields || []);
  const maskedFields = new Set(c.masked_fields || []);
  // Sales staff see the masks but get no Reveal button: the server refuses their reveals too.
  const canReveal = c.can_reveal !== false;
  const revealBtn = (field, label) => (canReveal ? html` <button type="button" class="btn-link reveal" data-reveal="${field}">${label}</button>` : '');
  const row = (dt, value, mono = false, field = null) => (field && hiddenFields.has(field)
    ? html`<dt>${dt}</dt><dd><span class="lock">Hidden</span></dd>`
    : field && maskedFields.has(field)
      ? html`<dt>${dt}</dt><dd class="${mono ? 'mono' : ''}"><span data-masked-value="${field}">${value}</span>${revealBtn(field, 'Reveal')}</dd>`
      : html`<dt>${dt}</dt><dd class="${mono && value ? 'mono' : ''}">${value || '—'}</dd>`);
  const phoneRow = (dt, field) => (hiddenFields.has(field)
    ? html`<dt>${dt}</dt><dd><span class="lock">Hidden</span></dd>`
    : maskedFields.has(field)
    ? html`<dt>${dt}</dt><dd><span class="phone-link" data-masked-value="${field}">${c[field]}</span>${revealBtn(field, 'Reveal to call')}</dd>`
    : html`<dt>${dt}</dt><dd><a class="phone-link" href="tel:${String(c[field]).replace(/[^\d+]/g, '')}">${c[field]}</a></dd>`);
  const a = new Set(c.allowed_actions);
  const meta = state.meta;

  let banner = '';
  if (c.status === 'incomplete') {
    banner = html`<div class="callout danger"><strong>Verification pending — waiting for team leader action (${ago(c.incomplete_at)})</strong>
      ${label(c.incomplete_reason)}${c.incomplete_note ? `: ${c.incomplete_note}` : ''} <span class="muted">— ${c.assigned_to_name}</span></div>`;
  } else if (c.status === 'awaiting_approval') {
    const reasons = [];
    if (a.has('approve_card') || (c.credit_card && c.card_min_salary != null && !c.card_salary_exception && (c.salary == null || c.salary < c.card_min_salary))) reasons.push(html`<div>${c.credit_card} needs a monthly salary of AED ${fmtAmount(c.card_min_salary)} and the customer's salary is below it. No product deviation or promotion was chosen.</div>`);
    if (c.timing_flag && !c.timing_approved_at) reasons.push(html`<div>${String(c.timing_flag).split(',').map((f) => state.meta.timing_flags?.[f] || f).join(' and ')}: files sourced on a Sunday or entered after 6 pm need the team's approval.</div>`);
    banner = html`<div class="callout warn"><strong>Awaiting team leader / sales manager approval</strong>${reasons}<div class="muted small">The file waits for the team's decision before verification.</div></div>`;
  } else if (c.status === 'returned_to_sales') {
    banner = html`<div class="callout info"><strong>Returned to sales by ${c.tl_actioned_by_name}</strong>${c.tl_note}
      ${c.incomplete_reason ? html`<div class="muted small">Original issue: ${label(c.incomplete_reason)}${c.incomplete_note ? ` — ${c.incomplete_note}` : ''}</div>` : ''}</div>`;
  } else if (c.status === 'completed') {
    banner = html`<div class="callout ${c.verified_basis === 'deviation' ? 'warn' : 'success'}"><strong>Verification completed by ${c.verified_by_name} on ${fmtDate(c.verified_at)}${c.verified_basis === 'deviation' ? ' · based on deviation' : ''}</strong>
      ${c.verified_basis === 'deviation' ? html`<div class="small">Completed without a verification call. ${(c.events || []).filter((e) => e.type === 'complete_deviation').map((e) => e.note).filter(Boolean).slice(-1).map((n) => html`Reason: ${n}`)}</div>` : ''}
      ${c.case_status !== 'completed' ? html`<span class="small">The case itself is still ${CASE_STATUS_LABEL[c.case_status]}.</span>` : ''}</div>`;
  } else if (c.status === 'rejected') {
    banner = c.tl_action === 'reject'
      ? html`<div class="callout danger"><strong>Verification rejected by team leader ${c.tl_actioned_by_name}</strong>${c.tl_note}</div>`
      : html`<div class="callout danger"><strong>Verification rejected by ${c.assigned_to_name} (${ago(c.incomplete_at)})</strong>
          ${c.incomplete_reason ? `${label(c.incomplete_reason)}: ` : ''}${c.incomplete_note || ''}</div>`;
  }

  const panel = [];
  if (a.has('claim')) {
    panel.push(html`<h3>Start verification</h3><p class="muted small">Assign this case to yourself so no one else calls the customer.</p>
      <button class="btn-primary" data-action="claim">Pick up case</button>`);
  }
  if (a.has('log_call')) {
    panel.push(html`<h3>Log a call</h3>
      <form data-form="log_call" id="log-call-form">
        <div class="field-row"><select name="outcome" required>
          <option value="">Call outcome…</option>
          ${meta.call_outcomes.map((o) => html`<option value="${o}">${label(o)}</option>`)}
        </select></div>
        <div class="field-row callback-row" id="callback-row" hidden>
          <label for="callback-at">Call back on <span class="req">*</span></label>
          <input id="callback-at" type="datetime-local" name="callback_at" min="${toLocalInput(Date.now())}" max="${toLocalInput(Date.now() + meta.callback_max_days * 864e5)}">
          <div class="chips quick-picks">
            ${[['In 1 hour', 60], ['In 2 hours', 120], ['Tomorrow 10:00', 'tomorrow-10'], ['Tomorrow 15:00', 'tomorrow-15']].map(([l, v]) => html`<button type="button" class="chip" data-quick="${v}">${l}</button>`)}
          </div>
          <p class="muted small">You'll get an alert at this time and the case moves to the top of your queue.</p>
        </div>
        <div class="field-row"><textarea name="note" placeholder="What did the customer say?"></textarea></div>
        <button>Log call</button>
      </form>`);
  }
  if (a.has('bot_call')) {
    panel.push(html`<h3>Call with bot</h3><p class="muted small">The bot calls the customer and asks them to confirm their details. You still save the verification result.</p>
      <button data-action="bot_call">🤖 Call with bot</button>`);
  } else if (meta.call_bot && ['requested', 'in_progress'].includes(c.bot_call_status) && a.has('log_call')) {
    panel.push(html`<h3>Call with bot</h3><p class="muted small">${c.bot_call_status === 'in_progress' ? 'The bot is on the call now.' : 'Waiting for the bot to call the customer.'}
      Refresh the page for the result.</p>`);
  }
  if (a.has('complete') || a.has('mark_incomplete') || a.has('reject_verification')) {
    panel.push(html`<hr><h3>Verification result</h3>
      <form data-form="verification" id="verification-form">
        <div class="field-row"><label for="vr-result">Result</label><select id="vr-result" name="result" required>
          <option value="">Choose the result…</option>
          <option value="complete">Completed</option>
          <option value="complete_deviation">Completed based on deviation</option>
          <option value="mark_incomplete">Pending</option>
          <option value="reject_verification">Rejected</option>
        </select></div>
        <p class="muted small" id="vr-hint">Choose the outcome of your verification call, or complete on a deviation when the customer could not be called.</p>
        <div class="field-row" id="vr-reason" hidden><select name="reason" disabled>
          <option value="">Reason…</option>
          ${meta.incomplete_reasons.map((o) => html`<option value="${o}">${label(o)}</option>`)}
        </select></div>
        <div class="field-row"><textarea name="note" placeholder="Verification notes"></textarea></div>
        <button class="btn-primary">Save verification result</button>
      </form>`);
  }
  if (a.has('release')) panel.push(html`<hr><button data-action="release">Release back to queue</button>`);
  if (a.has('approve_card')) {
    panel.push(html`<h3>Card below salary requirement</h3>
      <p class="muted small">${c.credit_card} needs AED ${fmtAmount(c.card_min_salary)} a month. Record why it is being sold and send the file for verification, or return it to ${c.sales_staff_name || 'sales'}.</p>
      <form data-form="card_approval">
        <div class="segmented two-up" role="radiogroup" aria-label="Reason">
          ${Object.entries(state.meta.card_exceptions).map(([k, l]) => html`<label><input type="radio" name="exception" value="${k}"><span>${l}</span></label>`)}
        </div>
        <div class="field-row" style="margin-top:10px"><textarea name="note" placeholder="Reference or note (required when returning to sales)"></textarea></div>
        <div class="actions">
          <button data-card="approve_card" class="btn-primary">Approve &amp; send for verification</button>
          <button data-card="decline_card">↩ Return to sales</button>
        </div>
      </form>`);
  }
  if (a.has('approve_timing')) {
    panel.push(html`<h3>${String(c.timing_flag).split(',').map((f) => state.meta.timing_flags?.[f] || f).join(' and ')}</h3>
      <p class="muted small">Approve the file for verification, or return it to ${c.sales_staff_name || 'sales'} with a note.</p>
      <form data-form="timing_approval">
        <div class="field-row"><textarea name="note" placeholder="Note (required when returning to sales)"></textarea></div>
        <div class="actions">
          <button data-timing="approve_timing" class="btn-primary">Approve &amp; send for verification</button>
          <button data-timing="decline_timing">↩ Return to sales</button>
        </div>
      </form>`);
  }
  if (a.has('return_to_sales')) {
    panel.push(html`<h3>Team leader decision</h3>
      <form data-form="tl">
        <div class="field-row"><label for="tl-note">Instructions / note</label>
          <textarea id="tl-note" name="note" placeholder="Required when returning to sales or rejecting"></textarea></div>
        <div class="actions">
          <button data-tl="return_to_sales" class="btn-primary">↩ Return to sales</button>
          <button data-tl="reverify">↻ Re-verify</button>
          <button data-tl="reject" class="btn-danger">Reject</button>
        </div>
        <p class="muted small" style="margin-top:8px">
          <b>Return to sales</b>: the sales person fixes the details and resubmits.<br>
          <b>Re-verify</b>: back to the processing queue for another call.<br>
          <b>Reject</b>: verification fails and the file is closed for editing.
        </p>
      </form>`);
  }
  if (a.has('resubmit')) {
    panel.push(html`<h3>Fix &amp; resubmit</h3><p class="muted small">Correct the details the team leader flagged, then resubmit for verification.</p>
      <div class="actions"><a class="btn" href="#/cases/${c.id}/edit">Edit details</a><button class="btn-primary" data-action="resubmit">Resubmit</button></div>`);
  }
  if (a.has('resolve_edit_request')) {
    panel.push(html`${panel.length ? raw('<hr>') : ''}<h3>Edit request from ${c.edit_request_by_name}</h3>
      <div class="note-box">${c.edit_request_note}</div>
      <p class="muted small">Make the changes with <b>Edit details</b>, then mark the request done so ${c.edit_request_by_name} is told.</p>
      <form data-form="resolve_edit_request">
        <div class="field-row"><textarea name="note" placeholder="What you changed (optional)"></textarea></div>
        <div class="actions">${c.can_edit ? html`<a class="btn" href="#/cases/${c.id}/edit">Edit details</a>` : ''}<button class="btn-primary">Mark changes done</button></div>
      </form>`);
  } else if (c.can_edit && !a.has('resubmit')) {
    panel.push(html`${panel.length ? raw('<hr>') : ''}<a class="btn" href="#/cases/${c.id}/edit">Edit details</a>`);
  }
  if (a.has('request_edit')) {
    panel.push(html`${panel.length ? raw('<hr>') : ''}<h3>Need changes to this file?</h3>
      <p class="muted small">The file is in applicant review, so you can't edit it yourself. Tell your team leader or sales manager what to change.</p>
      ${c.edit_request_to ? html`<p class="small"><b>Already sent to the ${state.meta.edit_queues[c.edit_request_to]} queue.</b> Sending again replaces that request.</p>` : ''}
      <form data-form="request_edit">
        <div class="field-row"><div class="sub-label" style="margin-bottom:6px">Send to which queue? <span class="req">*</span></div>
          <div class="segmented two-up">
            ${Object.entries(state.meta.edit_queues).map(([k, l]) => html`<label><input type="radio" name="to" value="${k}" required><span>${l}</span></label>`)}
          </div>
        </div>
        <div class="field-row"><textarea name="note" required placeholder="What needs to change?"></textarea></div>
        <p class="muted small">Team leaders can't see company, salary, Emirates ID or passport details. Send changes to those to the Sales Manager queue.</p>
        <button class="btn-primary">Send edit request</button>
      </form>`);
  }
  const sep = () => (panel.length ? raw('<hr>') : '');
  if (a.has('approve_recording')) {
    const canRetrieve = ['completed', 'rejected'].includes(c.status);
    panel.push(html`${sep()}<h3>Call recording request</h3>
      <div class="note-box">${c.recording_request_note}</div>
      <p class="muted small">Requested by ${c.recording_requested_by_name} ${ago(c.recording_requested_at)}. Approving emails IT to share the file.</p>
      ${canRetrieve ? '' : html`<p class="small error">Verification is not complete, so the recording can't be retrieved yet. Decline the request; governance can flag the file for urgent verification.</p>`}
      <form data-form="recording_decision">
        <div class="field-row"><textarea name="note" placeholder="Note (required to decline)"></textarea></div>
        <div class="actions">
          ${canRetrieve ? html`<button class="btn-success" data-decision="approve_recording">Approve and email IT</button>` : ''}
          <button class="btn-danger" data-decision="decline_recording">Decline</button>
        </div>
      </form>`);
  }
  if (a.has('receive_recording')) {
    panel.push(html`${sep()}<h3>Recording from IT</h3>
      <p class="muted small">IT was emailed for this recording. When they share it, add the link or file reference here.</p>
      <form data-form="receive_recording">
        <div class="field-row"><input name="recording_ref" required placeholder="Link or file reference, e.g. \\\\share\\rec\\88231.wav"></div>
        <button class="btn-primary">Mark recording received</button>
      </form>`);
  }
  if (a.has('score_quality')) {
    panel.push(html`${sep()}<h3>Score the verification call</h3>
      <form data-form="score_quality">
        <div class="field-row score-row">
          <input name="score" type="number" min="0" max="${state.meta.score_max}" step="0.1" required inputmode="decimal" aria-label="Score out of 10" value="${c.qc_score ?? ''}">
          <span class="muted">/ ${state.meta.score_max}</span>
        </div>
        <div class="field-row"><textarea name="note" placeholder="What went well, what was missed">${c.qc_score_note || ''}</textarea></div>
        <button class="btn-primary">${c.qc_score != null ? 'Update score' : 'Save score'}</button>
      </form>`);
  }
  if (a.has('flag_urgent') || a.has('clear_urgent')) {
    const on = a.has('clear_urgent');
    panel.push(html`${sep()}<h3>Urgent verification</h3>
      <p class="muted small">Verification is not complete, so the call recording can't be requested yet. ${on ? 'This file is flagged as urgent.' : 'Flag it so the processor and team leaders prioritise it.'}</p>
      <form data-form="${on ? 'clear_urgent' : 'flag_urgent'}">
        ${on ? '' : html`<div class="field-row"><textarea name="note" required placeholder="Why verification is urgent"></textarea></div>`}
        <button class="${on ? '' : 'btn-danger'}">${on ? 'Remove urgent flag' : 'Flag for urgent verification'}</button>
      </form>`);
  }
  if (a.has('request_recording')) {
    panel.push(html`${sep()}<h3>Request the call recording</h3>
      <p class="muted small">Goes to the business head for approval. Once approved, IT is emailed for the file.</p>
      <form data-form="request_recording">
        <div class="field-row"><textarea name="note" required placeholder="Why the recording is needed"></textarea></div>
        <button class="btn-primary">Send for approval</button>
      </form>`);
  }
  if (a.has('mark_qc') || a.has('clear_qc')) {
    const on = a.has('clear_qc');
    panel.push(html`${sep()}<h3>Quality check</h3>
      <form data-form="${on ? 'clear_qc' : 'mark_qc'}">
        ${on ? html`<p class="small">Marked for QC by ${c.qc_by_name}${c.qc_note ? `: ${c.qc_note}` : ''}</p>` : ''}
        <div class="field-row"><textarea name="note" placeholder="${on ? 'Note (optional)' : 'Why this file is being checked (optional)'}"></textarea></div>
        <button class="${on ? '' : 'btn-primary'}">${on ? 'Remove from quality check' : 'Mark for quality check'}</button>
      </form>`);
  }
  if (a.has('set_complaint')) {
    panel.push(html`${sep()}<h3>Complaint number</h3>
      <form data-form="set_complaint">
        <div class="field-row"><input name="complaint_number" required maxlength="50" placeholder="e.g. CMP-2026-0091" value="${c.complaint_number || ''}" aria-label="Complaint number"></div>
        <button class="btn-primary">${c.complaint_number ? 'Update complaint number' : 'Add complaint number'}</button>
      </form>
      ${a.has('decide_complaint') ? html`<form data-form="decide_complaint" class="complaint-decision">
        <p class="muted small">Is complaint ${c.complaint_number} valid? A valid complaint removes the file from ${c.sales_staff_name || 'the sales person'}'s incentive for the cycle.</p>
        <div class="segmented two-up" role="radiogroup" aria-label="Complaint decision">
          <label><input type="radio" name="complaint_status" value="valid" ${c.complaint_status === 'valid' ? raw('checked') : ''}><span>Valid</span></label>
          <label><input type="radio" name="complaint_status" value="invalid" ${c.complaint_status === 'invalid' ? raw('checked') : ''}><span>Invalid</span></label>
        </div>
        <div class="field-row" style="margin-top:10px"><textarea name="note" placeholder="Finding or reference (optional)">${c.complaint_decision_note || ''}</textarea></div>
        <button class="btn-primary">Save decision</button>
      </form>` : ''}`);
  }
  if (a.has('set_case_status')) {
    const choices = state.meta.settable_case_statuses.filter((k) => k !== c.case_status);
    panel.push(html`${panel.length ? raw('<hr>') : ''}<h3>Case status</h3>
      <p class="small">Now: ${caseBadge(c.case_status)}</p>
      <form data-form="set_case_status">
        <div class="field-row"><label for="cs-select" class="sr-only">New case status</label>
          <select id="cs-select" name="case_status" required>
            <option value="">Change status to…</option>
            ${choices.map((k) => html`<option value="${k}">${k === 'completed' && completionLabel(c) ? `Completed (${completionLabel(c)})` : CASE_STATUS_LABEL[k]}</option>`)}
          </select></div>
        ${c.case_status !== 'completed' && loansIn(c).length ? html`<fieldset class="disbursal-fields" id="cs-disbursal">
          <legend>Disbursed amount <span class="muted">(when completing)</span></legend>
          ${loansIn(c).map((p) => html`<div class="field-row"><label for="cs-${p}">${LOAN_DISBURSAL[p][1]} (AED) <span class="req">*</span></label>
            <input id="cs-${p}" name="${LOAN_DISBURSAL[p][0]}" inputmode="decimal" value="${suggestedDisbursal(c, p)}" placeholder="Amount paid out"></div>`)}
          ${payoutClassField(c, 'cs')}
          <p class="muted small">Prefilled from the file${c.personal_loan_type === 'top_up' ? ' (the incremental amount for a top up)' : ''}. Change it if a different amount was disbursed. It counts towards the loan target.</p>
        </fieldset>` : ''}
        <div class="field-row"><textarea name="note" id="cs-note" placeholder="Note (required for Applicant review and Rejected)"></textarea></div>
        <div class="actions">
          <button class="btn-primary">Update status</button>
          ${c.case_status !== 'completed' ? html`<button type="button" class="btn-success" data-case-complete>✓ Mark completed${completionLabel(c) ? ` · ${completionLabel(c)}` : ''}</button>` : ''}
        </div>
      </form>
      ${c.status === 'completed' && c.case_status !== 'completed' ? html`<p class="muted small">Verification is completed, but the case is not. Mark the case completed when it is done.</p>` : ''}
      <p class="muted small">A completed case counts towards the sales person's target in the cycle it is completed in.</p>`);
  }
  if (a.has('set_disbursal')) {
    panel.push(html`${sep()}<h3>Disbursed amount</h3>
      <p class="muted small">Counts towards ${c.sales_staff_name || 'the sales person'}'s loan target for the ${cycleName(cycleOfIso(c.case_status_at))} cycle.</p>
      <form data-form="set_disbursal">
        ${loansIn(c).map((p) => html`<div class="field-row"><label for="ds-${p}">${LOAN_DISBURSAL[p][1]} (AED)</label>
          <input id="ds-${p}" name="${LOAN_DISBURSAL[p][0]}" inputmode="decimal" required value="${c[LOAN_DISBURSAL[p][0]] ?? suggestedDisbursal(c, p)}"></div>`)}
        ${payoutClassField(c, 'ds')}
        <button>Update disbursed amount</button>
      </form>`);
  }
  if (a.has('set_card_status')) {
    panel.push(html`${sep()}<h3>Card activation</h3>
      <p class="muted small">The card is Inactive from the temp end until you mark it Active. It counts for ${c.sales_staff_name || 'the sales person'}.</p>
      <form data-form="set_card_status" id="card-form">
        <div class="segmented two-up card-pick" role="radiogroup" aria-label="Card status">
          <label><input type="radio" name="card_status" value="active" required ${c.card_status === 'active' ? raw('checked') : ''}><span>Active</span></label>
          <label><input type="radio" name="card_status" value="inactive" ${c.card_status === 'inactive' ? raw('checked') : ''}><span>Inactive</span></label>
        </div>
        <div class="field-row" id="card-date"><label for="card-date-input" id="card-date-label">${c.card_status === 'inactive' ? 'Inactive since' : 'Activated on'}</label>
          <input id="card-date-input" type="date" name="activation_date" value="${c.card_activation_date || todayLocal()}" max="${todayLocal()}" required></div>
        <div class="actions"><button class="btn-primary">Save card status</button></div>
      </form>`);
  }

  shell(html`
    <div class="page-head">
      <div><a href="#/" class="small" id="back-link">← Back</a>
        <h1>${c.salutation ? `${c.salutation} ` : ''}${c.customer_name} <span class="muted" style="font-weight:400">${c.ref}</span></h1>
        <div class="badges">${caseBadge(c.case_status)} ${badge(c.status)} ${isDncr(c) ? html`<span class="chip bad" title="Customer is on the Do Not Call Register">DNCR</span>` : ''} <span class="muted small">Sourced by ${c.sales_staff_name || c.created_by_name}${c.region ? ` · ${c.region}` : ''} on ${fmtDay(c.sourcing_date)}</span></div>
      </div>
    </div>
    ${c.dncr_email ? html`<div class="callout warn dncr-draft"><strong>Customer on the Do Not Call Register.</strong> The customer cannot be phoned until they give permission. Send them this email from your mailbox, signed in your name, and log their reply on the file; once they agree, the file can go back for verification.
      ${emailDraft('dncr', c.dncr_email, 'Email to the customer', { missingTo: 'No email address on the file. Add the customer\'s email under Edit details, or copy the text and send it another way.' })}</div>` : ''}
    ${c.callback_at && ['pending_verification', 'in_verification'].includes(c.status) ? html`<div class="callout ${callbackDue(c) ? 'danger' : 'warn'}">
      <strong>${callbackDue(c) ? 'Call back now' : 'Call-back scheduled'} — ${fmtWhen(c.callback_at)} (${untilText(c.callback_at)})</strong>
      The customer asked to be called at this time${c.callback_by_name ? `, noted by ${c.callback_by_name}` : ''}. Log the call when you make it; any outcome other than "call back later" closes this reminder.</div>` : ''}
    ${isUrgent(c) ? html`<div class="callout danger"><strong>Urgent verification — flagged by ${c.urgent_by_name} ${ago(c.urgent_at)}</strong>${c.urgent_note}</div>` : ''}
    ${c.case_status === 'applicant_review' ? html`<div class="callout warn"><strong>Applicant review${c.case_status_by_name ? ` — set by ${c.case_status_by_name} ${ago(c.case_status_at)}` : ''}</strong>${c.case_status_note || ''}</div>` : ''}
    ${c.edit_request_to ? html`<div class="callout info"><strong>Edit request in the ${state.meta.edit_queues[c.edit_request_to]} queue — from ${c.edit_request_by_name} ${ago(c.edit_request_at)}</strong>${c.edit_request_note}</div>` : ''}
    ${banner}
    <div class="grid two-col">
      <div>
        <div class="card">
          <h2>Customer</h2>
          ${hiddenFields.size && state.user.role !== 'sales' ? html`<p class="muted small">Company, salary, Emirates ID and passport details are hidden for your role${state.user.role === 'processing' ? ' once verification is completed or rejected' : ''}.</p>` : ''}
          ${state.user.role === 'sales' ? html`<p class="muted small privacy-note">Once a file is submitted the customer's phone numbers are hidden from sales staff and the other identifiers stay masked; nothing can be revealed. To correct a value, edit the file and type the new one.</p>` : ''}
          ${maskedFields.size && canReveal ? html`<p class="muted small privacy-note">Personal identifiers are masked. Reveal only what you need; each reveal is recorded against your name, and revealed values hide again after ${Math.round((window.__crmRehideMs || 180000) / 60000)} minutes or when you leave the page. <button type="button" class="btn-link" id="reveal-all">Reveal all</button></p>` : ''}
          <dl class="details">
            ${phoneRow('Mobile', 'phone')}
            ${c.alt_phone || hiddenFields.has('alt_phone') ? phoneRow('Alternate phone', 'alt_phone') : ''}
            ${c.eid_number || hiddenFields.has('eid_number') && c.eid_number !== null ? row('Emirates ID', c.eid_number, true, 'eid_number') : ''}
            ${c.passport_number ? row('Passport number', c.passport_number, true, 'passport_number') : ''}
            ${row('Company', c.company_name, false, 'company_name')}
            ${row('Monthly salary', c.salary != null && !maskedFields.has('salary') ? `AED ${fmtAmount(c.salary)}` : c.salary, false, 'salary')}
            ${c.salary_bank ? html`<dt>Salary transferred to</dt><dd><strong>${c.salary_bank}</strong></dd>` : ''}
            ${row('Bidaya ID', c.bidaya_id, true)}
            ${row('App ID', c.app_id, true)}
            ${row('Email', c.email)}
            ${row('Address', [c.address, c.city].filter(Boolean).join(', '))}
          </dl>
          <h2 class="sub">Product</h2>
          <dl class="details">
            ${row('Core product', state.meta.core_products[c.core_product])}
            ${c.payout ? html`<dt>Agency payout</dt><dd><strong>AED ${fmtAmount(c.payout.total)}</strong>${c.payout.parts.length ? html`<div class="muted small">${c.payout.parts.map((p) => `${p.basis}${p.rate != null ? ` · ${p.rate}% of AED ${fmtAmount(p.amount)}` : ''}: AED ${fmtAmount(p.payout)}`).join(' · ')}</div>` : html`<div class="muted small">No payable product on this file yet</div>`}</dd>` : ''}
            <dt>Product</dt><dd>${c.product === 'bundle'
              ? html`<strong>Bundle</strong><ul class="bundle-list">${c.bundle_products.split(',').map((p) => html`<li>${state.meta.products[p] || p}</li>`)}</ul>`
              : state.meta.products[c.product] || c.product || '—'}</dd>
            ${c.personal_loan_type ? html`<dt>Personal loan type</dt><dd><strong>${state.meta.personal_loan_types[c.personal_loan_type]}</strong></dd>` : ''}
            ${c.fpd ? html`<dt>FPD</dt><dd><strong>${fmtDay(c.fpd)}</strong><div class="muted small">First payment date</div></dd>` : ''}
            ${c.loan_amount != null ? html`<dt>Loan amount</dt><dd><strong>AED ${fmtAmount(c.loan_amount)}</strong></dd>` : ''}
            ${c.interest_rate != null ? html`<dt>Interest rate</dt><dd><strong>${c.interest_rate}%</strong></dd>` : ''}
            ${c.pl_tenure != null ? html`<dt>PL tenure</dt><dd><strong>${c.pl_tenure} months</strong></dd>` : ''}
            ${c.full_loan_amount != null ? html`<dt>Full loan amount</dt><dd>AED ${fmtAmount(c.full_loan_amount)}</dd>` : ''}
            ${c.incremental_amount != null ? html`<dt>Incremental amount</dt><dd>AED ${fmtAmount(c.incremental_amount)}</dd>` : ''}
            ${c.pl_buyouts?.some((b) => b.role === 'primary') ? html`<dt>Primary buyout</dt><dd>${buyoutList(c.pl_buyouts.filter((b) => b.role === 'primary'))}</dd>` : c.buyout_bank ? html`<dt>Buy-out from</dt><dd><strong>${c.buyout_bank}</strong></dd>` : ''}
            ${c.secondary_buyout ? html`<dt>Secondary buyouts</dt><dd>${c.secondary_buyout === 'yes' ? buyoutList(c.pl_buyouts.filter((b) => b.role === 'secondary')) : html`<span class="muted">None, confirmed by sales</span>`}</dd>` : ''}
            ${c.credit_card ? html`<dt>Credit card</dt><dd><strong>${c.credit_card}</strong></dd>` : ''}
            ${c.card_category ? html`<dt>Card category</dt><dd><strong>${c.card_category}</strong>${c.card_points != null ? html` <span class="muted">· ${c.card_points} points</span>` : ''}</dd>` : ''}
            ${c.timing_flag ? html`<dt>Sourcing timing</dt><dd>${String(c.timing_flag).split(',').map((f) => state.meta.timing_flags?.[f] || f).join(' and ')} · ${c.timing_approved_at ? html`<span class="chip good">Approved by ${c.timing_approved_by_name} · ${fmtDate(c.timing_approved_at)}</span>${c.timing_note ? html`<div class="muted small">${c.timing_note}</div>` : ''}` : html`<span class="chip warn">Awaiting team approval</span>`}</dd>` : ''}
            ${c.credit_card && c.card_min_salary != null ? html`<dt>Salary check</dt><dd>Card needs AED ${fmtAmount(c.card_min_salary)} a month · ${c.card_salary_exception || c.status === 'awaiting_approval' ? html`<span class="chip bad">Customer below requirement</span>` : html`<span class="chip good">Customer meets requirement</span>`}</dd>` : ''}
            ${c.card_salary_exception ? html`<dt>Sold as</dt><dd><strong>${state.meta.card_exceptions[c.card_salary_exception] || c.card_salary_exception}</strong><div class="muted small">by ${c.card_exception_by_name || '—'} on ${fmtDate(c.card_exception_at)}${c.card_exception_note ? ` · ${c.card_exception_note}` : ''}</div></dd>` : ''}
            ${c.card_fee_type ? html`<dt>Card sourced type</dt><dd><strong>${state.meta.card_fee_types[c.card_fee_type] || c.card_fee_type}</strong></dd>` : ''}
            ${c.auto_loan_type ? html`<dt>Auto loan</dt><dd><strong>${state.meta.auto_loan_types[c.auto_loan_type] || c.auto_loan_type} car</strong>${c.al_payout_class && c.al_payout_class !== 'full' ? html` · <span class="chip warn">${(state.meta.auto_loan_classes || {})[c.al_payout_class] || c.al_payout_class}</span>` : ''} · ${[c.car_make, c.car_model, c.car_year].filter(Boolean).join(' ')}${c.dealer_details ? html`<div class="muted small">Dealer: ${c.dealer_details}</div>` : ''}${c.al_lead_source ? html`<div class="muted small">Lead source: ${c.al_lead_source}</div>` : ''}</dd>` : ''}
            ${c.amount != null ? html`<dt>Auto loan amount</dt><dd><strong>AED ${fmtAmount(c.amount)}</strong>${c.al_interest_rate != null ? html` · ROI ${c.al_interest_rate}%` : ''}${c.al_tenure != null ? html` · ${c.al_tenure} months` : ''}</dd>` : ''}
          </dl>
          <h2 class="sub">Sales staff</h2>
          <dl class="details">
            ${row('Sales staff', c.sales_staff_name || c.created_by_name)}
            ${row('Sales code', c.sales_code, true)}
            ${row('Team leader', c.team_leader_name)}
            ${row('Sales manager', c.sales_manager_name)}
          </dl>
          <h2 class="sub">Case</h2>
          <dl class="details">
            <dt>Case status</dt><dd>${caseBadge(c.case_status)}${c.case_status_by_name ? html`<div class="muted small">${c.case_status_by_name} · ${fmtDate(c.case_status_at)}</div>` : ''}${c.case_status_note ? html`<div>${c.case_status_note}</div>` : ''}</dd>
            ${c.case_status === 'completed' ? html`<dt>Completed as</dt><dd><strong>${completionLabel(c) || 'Completed'}</strong>${disbursedText(c) ? html`<div>${disbursedText(c)}</div>` : ''}<div class="muted small">${fmtIsoDay(c.case_status_at)} · ${cycleName(cycleOfIso(c.case_status_at))} cycle</div></dd>` : ''}
            ${c.case_status === 'completed' && hasCard(c) ? html`<dt>Card activation</dt><dd>${cardChip(c.card_status)}${c.card_status ? html`<div class="small">${cardDateText(c)}</div>${cardAgeDays(c) != null ? html`<div class="age-line">Ageing ${ageChip(c)} <span class="muted small">since the temp end on ${fmtIsoDay(c.case_status_at)}</span></div>` : ''}<div class="muted small">${c.card_status_by_name ? `Mapped by ${c.card_status_by_name}` : (c.card_status === 'inactive' ? 'Inactive by default until activation is confirmed' : `Moved automatically after ${state.meta.card_range_days} days`)} · ${fmtDate(c.card_status_at)}</div>` : ''}</dd>` : ''}
            <dt>Sourcing date</dt><dd>${fmtDay(c.sourcing_date)}</dd>
            ${row('Region', state.meta.regions[c.region])}
            <dt>Lead source</dt><dd>${c.source || '—'}</dd>
            <dt>Sales notes</dt><dd style="white-space:pre-wrap">${c.sales_notes || '—'}</dd>
            <dt>Processor</dt><dd>${c.assigned_to_name || '—'}</dd>
            <dt>Call attempts</dt><dd>${c.call_attempts}</dd>
          </dl>
        </div>
        ${'qc_flag' in c ? html`<div class="card">
          <h2>Quality &amp; governance</h2>
          <dl class="details">
            <dt>Quality check</dt><dd>${c.qc_flag ? html`<span class="chip warn">Marked for QC</span><div class="muted small">${c.qc_by_name} · ${fmtDate(c.qc_at)}</div>${c.qc_note ? html`<div>${c.qc_note}</div>` : ''}` : html`<span class="muted">Not marked</span>`}</dd>
            <dt>Complaint number</dt><dd>${c.complaint_number ? html`<strong class="mono">${c.complaint_number}</strong><div class="muted small">${c.complaint_by_name} · ${fmtDate(c.complaint_at)}</div>
              ${c.complaint_status ? html`<div><span class="chip ${c.complaint_status === 'valid' ? 'bad' : 'good'}">${c.complaint_status === 'valid' ? 'Valid complaint' : 'Invalid complaint'}</span> <span class="muted small">${c.complaint_decided_by_name} · ${fmtDate(c.complaint_decided_at)}</span></div>${c.complaint_status === 'valid' ? html`<div class="small">${state.meta.complaint_remark}.</div>` : ''}${c.complaint_decision_note ? html`<div class="muted small">${c.complaint_decision_note}</div>` : ''}` : html`<div class="muted small">Not yet marked valid or invalid</div>`}` : '—'}</dd>
            <dt>Call score</dt><dd>${c.qc_score != null ? html`<span class="chip ${scoreClass(c.qc_score)}">${c.qc_score} / 10</span><div class="muted small">${c.qc_scored_by_name} · ${fmtDate(c.qc_scored_at)}</div>${c.qc_score_note ? html`<div>${c.qc_score_note}</div>` : ''}` : html`<span class="muted">Not scored</span>`}</dd>
            <dt>Call recording</dt><dd>${c.recording_status ? html`
              ${recordingChip(c.recording_status)}
              <ol class="steps">
                <li>Requested by ${c.recording_requested_by_name} · ${fmtDate(c.recording_requested_at)}${c.recording_request_note ? html`<div class="muted small">${c.recording_request_note}</div>` : ''}</li>
                ${c.recording_decided_by_name ? html`<li>${c.recording_status === 'declined' ? 'Declined' : 'Approved'} by ${c.recording_decided_by_name} · ${fmtDate(c.recording_decided_at)}${c.recording_decision_note ? html`<div class="muted small">${c.recording_decision_note}</div>` : ''}</li>` : ''}
                ${c.recording_it_email_at ? html`<li>IT emailed for the file · ${fmtDate(c.recording_it_email_at)}</li>` : ''}
                ${c.recording_ref ? html`<li>Received · ${fmtDate(c.recording_provided_at)}<div>${/^https?:\/\//.test(c.recording_ref) ? html`<a href="${c.recording_ref}" target="_blank" rel="noopener">${c.recording_ref}</a>` : html`<span class="mono">${c.recording_ref}</span>`}</div></li>` : ''}
              </ol>` : html`<span class="muted">Not requested</span>`}</dd>
          </dl>
          ${c.recording_email ? html`<div class="email-draft">
            <div class="email-head"><strong>Email to IT</strong>
              <span class="actions">
                <button type="button" class="btn-link" id="copy-email">Copy email</button>
                ${c.recording_email.to ? html`<a href="mailto:${c.recording_email.to}?subject=${encodeURIComponent(c.recording_email.subject)}&body=${encodeURIComponent(c.recording_email.body)}">Open in email</a>` : ''}
              </span>
            </div>
            <div class="small"><span class="muted">To:</span> ${c.recording_email.to || html`<span class="error">IT email address not set up. Ask an administrator to set IT_EMAIL.</span>`}</div>
            <div class="small"><span class="muted">Subject:</span> ${c.recording_email.subject}</div>
            <pre id="email-body">${c.recording_email.body}</pre>
            <p class="muted small">Sent automatically when the email relay is set up; otherwise copy it into your email.</p>
          </div>` : ''}
        </div>` : ''}
        ${c.bot_call ? botCallCard(c.bot_call) : ''}
        <div class="card" id="discussion">
          <h2>Discussion</h2>
          <p class="muted small">Talk about this file with everyone who can see it. Type @ and a colleague's name to alert them. Keep customers' ID and phone numbers out of messages; they are on the file.</p>
          ${audienceList(c.audience)}
          <div class="thread" id="case-thread"><div class="muted small">Loading…</div></div>
          ${composer('case-composer', 'Write a message about this file…')}
        </div>
        <div class="card">
          <h2>Activity</h2>
          <ul class="timeline">
            ${c.events.map((e) => html`<li>
              <div><strong>${ACTION_LABEL[e.type] || label(e.type)}</strong>${e.detail ? html` · ${eventDetail(e)}` : ''}</div>
              <div class="muted small">${e.user_name || 'System'}${e.user_role ? ` (${ROLE_LABEL[e.user_role]})` : ''} · ${fmtDate(e.created_at)}</div>
              ${e.note ? html`<div class="note">${e.note}</div>` : ''}
            </li>`)}
          </ul>
        </div>
      </div>
      <div class="card action-panel">
        ${panel.length ? panel : html`<p class="muted">No actions available for you on this case.</p>`}
      </div>
    </div>`);

  const run = async (body, btn) => {
    if (btn) btn.disabled = true;
    try {
      await api(`/cases/${id}/actions`, { method: 'POST', body });
      toast(`${ACTION_LABEL[body.action] || 'Done'} ✓`);
      await refreshCounters();
      await viewCase(id);
    } catch (ex) {
      toast(ex.message, true);
      if (btn) btn.disabled = false;
    }
  };
  // Reveal masked values one at a time or all at once; the server logs each reveal.
  // Revealed values hide again after a few minutes, or as soon as the tab is hidden or the page
  // is left, so a screen left unattended does not keep showing them.
  const REHIDE_MS = window.__crmRehideMs || 3 * 60e3;
  const revealed = new Map(); // field -> { el, original, timer }
  const rehide = (f) => {
    const r = revealed.get(f);
    if (!r) return;
    clearTimeout(r.timer);
    revealed.delete(f);
    if (!r.el.isConnected) return;
    r.el.replaceWith(r.original);
    r.original.insertAdjacentHTML('afterend', ` <button type="button" class="btn-link reveal" data-reveal="${f}">${f === 'phone' || f === 'alt_phone' ? 'Reveal to call' : 'Reveal'}</button>`);
    r.original.nextElementSibling.onclick = () => reveal([f]);
    const all = document.getElementById('reveal-all');
    if (all) all.hidden = false;
  };
  const rehideAll = () => [...revealed.keys()].forEach(rehide);
  const reveal = async (fields) => {
    const wanted = fields.filter((f) => app.querySelector(`[data-masked-value="${f}"]`));
    if (!wanted.length) return;
    try {
      const { values } = await api(`/cases/${id}/reveal?fields=${wanted.join(',')}`);
      for (const [f, v] of Object.entries(values)) {
        const el = app.querySelector(`[data-masked-value="${f}"]`);
        if (!el) continue;
        let shown;
        if (el.classList.contains('phone-link')) {
          shown = document.createElement('a'); shown.className = 'phone-link'; shown.href = `tel:${String(v).replace(/[^\d+]/g, '')}`; shown.textContent = v;
        } else {
          shown = document.createElement('span'); shown.className = 'revealed'; shown.textContent = f === 'salary' ? `AED ${fmtAmount(v)}` : v;
        }
        el.replaceWith(shown);
        app.querySelector(`[data-reveal="${f}"]`)?.remove();
        revealed.set(f, { el: shown, original: el, timer: setTimeout(() => rehide(f), REHIDE_MS) });
      }
      if (!app.querySelector('[data-masked-value]')) { const all = document.getElementById('reveal-all'); if (all) all.hidden = true; }
    } catch (ex) { toast(ex.message, true); }
  };
  app.querySelectorAll('[data-reveal]').forEach((b) => (b.onclick = () => reveal([b.dataset.reveal])));
  document.getElementById('reveal-all')?.addEventListener('click', () => reveal(state.meta.masked_fields));
  const onHide = () => { if (document.visibilityState === 'hidden') rehideAll(); };
  document.addEventListener('visibilitychange', onHide);
  window.addEventListener('hashchange', () => document.removeEventListener('visibilitychange', onHide), { once: true });
  mountThread({ list: document.getElementById('case-thread'), form: document.getElementById('case-composer'), url: `/cases/${id}/messages` });
  document.getElementById('back-link').onclick = (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  };
  app.querySelectorAll('[data-action]').forEach((b) => (b.onclick = () => run({ action: b.dataset.action }, b)));
  bindEmailCopies();
  document.getElementById('copy-email')?.addEventListener('click', async () => {
    const em = c.recording_email;
    const text = `To: ${em.to || ''}\nSubject: ${em.subject}\n\n${em.body}`;
    try {
      await navigator.clipboard.writeText(text);
      toast('Email copied');
    } catch {
      // Clipboard blocked: select the body so it can be copied by hand.
      const range = document.createRange();
      range.selectNodeContents(document.getElementById('email-body'));
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      toast('Press Ctrl+C (or ⌘C) to copy the selected email');
    }
  });
  const disbursalInputs = () => Object.fromEntries([...app.querySelectorAll('#cs-disbursal input')].map((i) => [i.name, i.value]));
  app.querySelectorAll('[data-case-complete]').forEach((b) => (b.onclick = () => run({ action: 'set_case_status', case_status: 'completed', ...disbursalInputs() }, b)));
  const cardForm = document.getElementById('card-form');
  if (cardForm) {
    const dateLabel = cardForm.querySelector('#card-date-label');
    cardForm.querySelectorAll('input[name=card_status]').forEach((r) => (r.onchange = () => { dateLabel.textContent = r.value === 'inactive' ? 'Inactive since' : 'Activated on'; }));
  }
  app.querySelectorAll('form[data-form]').forEach((f) => {
    const kind = f.dataset.form;
    if (kind === 'recording_decision') {
      f.onsubmit = (e) => e.preventDefault();
      f.querySelectorAll('[data-decision]').forEach((b) => (b.onclick = (e) => {
        e.preventDefault();
        run({ action: b.dataset.decision, note: formData(f).note }, b);
      }));
    } else if (kind === 'verification') {
      const reasonRow = f.querySelector('#vr-reason');
      const reason = reasonRow.querySelector('select');
      const note = f.querySelector('textarea');
      const hint = f.querySelector('#vr-hint');
      const hints = {
        complete: 'Details confirmed with the customer. This does not complete the case; the case status is set separately.',
        complete_deviation: 'Completed without a verification call. Give the reason for the deviation; it is recorded on the file and the sales person and team leader are told.',
        mark_incomplete: 'You could not finish. Your team leader is alerted to return it to sales, re-verify or reject.',
        reject_verification: 'The customer or details failed verification. Sales and team leaders are told.',
      };
      const resultSelect = f.querySelector('#vr-result');
      resultSelect.onchange = () => {
        const v = resultSelect.value;
        reasonRow.hidden = reason.disabled = !['mark_incomplete', 'reject_verification'].includes(v);
        reason.required = v === 'mark_incomplete';
        note.required = v !== 'complete' && v !== '';
        note.placeholder = v === 'complete' ? 'Verification notes (optional)' : v === 'complete_deviation' ? 'Reason for the deviation (required)' : 'Explain why (required)';
        hint.textContent = hints[v] || 'Choose the outcome of your verification call, or complete on a deviation when the customer could not be called.';
      };
      f.onsubmit = (e) => {
        e.preventDefault();
        const { result, ...rest } = formData(f);
        run({ action: result, ...rest }, f.querySelector('button.btn-primary'));
      };
    } else if (kind === 'card_approval') {
      f.onsubmit = (e) => e.preventDefault();
      f.querySelectorAll('[data-card]').forEach((b) => (b.onclick = (e) => {
        e.preventDefault();
        const { exception, note } = formData(f);
        if (b.dataset.card === 'approve_card' && !exception) { toast('Choose Product deviation or New promotion first', true); return; }
        if (b.dataset.card === 'decline_card' && !note?.trim()) { toast('Tell the sales person why the file is coming back', true); return; }
        run({ action: b.dataset.card, exception, note }, b);
      }));
    } else if (kind === 'timing_approval') {
      f.onsubmit = (e) => e.preventDefault();
      f.querySelectorAll('[data-timing]').forEach((b) => (b.onclick = (e) => {
        e.preventDefault();
        const { note } = formData(f);
        if (b.dataset.timing === 'decline_timing' && !note?.trim()) { toast('Tell the sales person why the file is coming back', true); return; }
        run({ action: b.dataset.timing, note }, b);
      }));
    } else if (kind === 'tl') {
      f.onsubmit = (e) => e.preventDefault();
      f.querySelectorAll('[data-tl]').forEach((b) => (b.onclick = (e) => {
        e.preventDefault();
        const action = b.dataset.tl;
        // Reject is permanent, so it takes a second click to confirm.
        if (action === 'reject' && !b.dataset.armed) {
          b.dataset.armed = '1';
          b.textContent = 'Click again to reject';
          setTimeout(() => { delete b.dataset.armed; b.textContent = 'Reject'; }, 4000);
          return;
        }
        run({ action, note: formData(f).note }, b);
      }));
    } else if (kind === 'log_call') {
      const outcome = f.querySelector('[name=outcome]');
      const row = f.querySelector('#callback-row');
      const at = f.querySelector('#callback-at');
      outcome.onchange = () => {
        row.hidden = outcome.value !== 'call_back_later';
        at.required = !row.hidden;
        if (!row.hidden && !at.value) at.value = toLocalInput(Math.ceil((Date.now() + 3600e3) / 900e3) * 900e3);
      };
      f.querySelectorAll('[data-quick]').forEach((b) => (b.onclick = () => {
        const v = b.dataset.quick;
        let ms;
        if (v.startsWith('tomorrow-')) {
          const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(Number(v.split('-')[1]), 0, 0, 0); ms = d.getTime();
        } else ms = Math.ceil((Date.now() + Number(v) * 60000) / 300e3) * 300e3;
        at.value = toLocalInput(ms);
      }));
      f.onsubmit = (e) => {
        e.preventDefault();
        const data = formData(f);
        // Send the chosen local time as an instant so the server stores it correctly in any timezone.
        if (data.outcome === 'call_back_later') data.callback_at = data.callback_at ? new Date(data.callback_at).toISOString() : '';
        else delete data.callback_at;
        run({ action: kind, ...data }, f.querySelector('button:not([type=button])'));
      };
    } else {
      f.onsubmit = (e) => { e.preventDefault(); run({ action: kind, ...formData(f) }, f.querySelector('button')); };
    }
  });
}

// ---------- contact helpers ----------
/** 0501234567 -> 050 123 4567 */
const fmtMobile = (m) => (m && /^05\d{8}$/.test(m) ? `${m.slice(0, 3)} ${m.slice(3, 6)} ${m.slice(6)}` : m || '');

/** "Same as local mobile" copies the mobile number into WhatsApp (with +971) and keeps it in step. */
function wireWhatsappSame(form) {
  const box = form.querySelector('[data-wa-same]');
  const mobile = form.querySelector('[name=mobile_number]');
  const wa = form.querySelector('[name=whatsapp_number]');
  const toIntl = (v) => {
    const d = v.replace(/\D/g, '').replace(/^(00)?971/, '').replace(/^0/, '');
    return d ? `+971 ${d.slice(0, 2)} ${d.slice(2, 5)} ${d.slice(5)}`.trim() : '';
  };
  const sync = () => { if (box.checked) wa.value = toIntl(mobile.value); wa.readOnly = box.checked; };
  box.onchange = sync;
  mobile.addEventListener('input', sync);
}

// ---------- files ----------
/** Offers a generated file to the user. The demo page replaces this with its own save. */
function saveFile(filename, text, type = 'text/csv') {
  if (window.__saveFile) return window.__saveFile(filename, text, type);
  const url = URL.createObjectURL(new Blob([text], { type: `${type};charset=utf-8` }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const csvCell = (v) => (/[",\r\n;]/.test(String(v ?? '')) ? `"${String(v).replace(/"/g, '""')}"` : String(v ?? ''));
// The byte-order mark makes Excel open the file as UTF-8 (names with accents or Arabic stay intact).
const toCsv = (rows) => '﻿' + rows.map((r) => r.map(csvCell).join(',')).join('\r\n') + '\r\n';

/** Reads an uploaded CSV as UTF-8, falling back to Excel's Windows-1252 for older "CSV" saves. */
async function readCsvFile(file) {
  const bytes = await file.arrayBuffer();
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder('windows-1252').decode(bytes);
  }
}

// ---------- sales cycles ----------
// A cycle runs from the 21st to the 20th and is named after the month it ends in, in UAE time:
// 21 May – 20 June is the June cycle ('2026-06').
const shiftCycle = (cycle, by) => {
  const [y, m] = cycle.split('-').map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${String((i % 12) + 1).padStart(2, '0')}`;
};
const cycleName = (cycle) => {
  const [y, m] = cycle.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 1)).toLocaleDateString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' });
};
const cycleSpan = (cycle) => {
  const day = (ymd) => new Date(`${ymd}T00:00:00Z`).toLocaleDateString(undefined, { day: 'numeric', month: 'short', timeZone: 'UTC' });
  return `${day(`${shiftCycle(cycle, -1)}-21`)} – ${day(`${cycle}-20`)}`;
};
const cycleOfIso = (iso) => {
  const [y, m, d] = new Date(Date.parse(iso) + 4 * 3600e3).toISOString().slice(0, 10).split('-').map(Number);
  return d >= 21 ? shiftCycle(`${y}-${String(m).padStart(2, '0')}`, 1) : `${y}-${String(m).padStart(2, '0')}`;
};

const pct = (a, t) => (t ? Math.round((a / t) * 100) : null);
/** Achieved against target: a thin meter plus "7 / 20". Over target turns green. */
function meter(achieved, target, { compact = false, unit = 'count' } = {}) {
  const f = unit === 'aed' ? fmtAedShort : (n) => Number(n).toLocaleString();
  if (target == null) {
    return html`<div class="meter-text${compact ? ' compact' : ''}"><strong>${f(achieved)}</strong> <span class="muted small">no target</span></div>`;
  }
  const p = pct(achieved, target) ?? (achieved ? 100 : 0);
  return html`<div class="meter-text${compact ? ' compact' : ''}"><strong>${f(achieved)}</strong><span class="muted"> / ${unit === 'aed' ? fmtAedShort(target).replace('AED ', '') : target}</span>${compact ? '' : html` <span class="muted small">${target ? `${p}%` : ''}</span>`}</div>
    <div class="meter ${p >= 100 ? 'done' : ''}" role="meter" aria-valuemin="0" aria-valuemax="${target}" aria-valuenow="${achieved}" aria-label="${achieved} of ${target}"><span style="width:${Math.min(p, 100)}%"></span></div>`;
}

const setupReady = (s) => Object.keys(s.salary_bands).length > 0 && s.staff_with_salary === s.staff;
function setupSummary(s) {
  const bands = Object.entries(s.salary_bands).map(([p, n]) => `${state.meta.products[p]} ${n}`).join(', ');
  return [
    Object.keys(s.salary_bands).length ? `Salary bands loaded: ${bands}.` : 'No salary bands yet: upload them from Bulk upload → Salary targets.',
    `${s.staff_with_salary} of ${s.staff} sales staff have a salary on their profile.`,
    s.card_points_set ? 'Card points come from the product list.' : 'Card points not loaded yet: each card counts 1 point until the product list has points.',
    `Auto loan points: the amount disbursed at the scheme's rate for its class (new and used ${s.auto_loan_rates.new.toFixed(2)}%, algo ${s.auto_loan_rates.algo.toFixed(2)}%, low-payout non-algo nil).`,
  ].join(' ');
}

const activationRate = (cards) => (cards.temp_end ? Math.round((cards.active / cards.temp_end) * 100) : null);

const unitSuffix = (unit) => (unit === 'aed' ? ' (AED)' : unit === 'points' ? ' (points)' : '');

/** Product tiles and the card activation tile for one person or a whole team. */
// A personal loan sales person's incentive for the cycle: production, its band and the rate.
function plIncentiveCard({ incentive: i, rules, conditions = [], pl_bands = [], pl_cross_sell: x }) {
  const cardBits = [['Mass', i.cards.Mass], ['Premium', i.cards.Premium], ['Super Premium', i.cards['Super Premium']], ['noon', i.cards.noon]].filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(', ');
  return html`<div class="card incentive">
    <div class="card-head"><h2>My incentive · ${i.band}</h2>
      <span class="chip ${i.rate_pct ? 'good' : ''}">${i.rate_pct.toFixed(2)}% of production</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Production this cycle</span><span class="kpi-value">AED ${fmtAmount(i.pl_counted)}</span><span class="kpi-sub">${i.loans} ${i.loans === 1 ? 'loan' : 'loans'} disbursed, AED ${fmtAmount(i.pl_disbursed)}${i.eib_loans ? ` · ${i.eib_loans} Emirates Islamic buy-out${i.eib_loans === 1 ? '' : 's'} at ${rules.eib_buyout_share}%` : ''}${i.top_ups ? ` · ${i.top_ups} top-up${i.top_ups === 1 ? '' : 's'} at ${i.topup_share}% of the increment` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Against target</span><span class="kpi-value">${i.achievement_pct == null ? '—' : `${i.achievement_pct}%`}</span><span class="kpi-sub">${i.target == null ? 'no personal loan target set for this cycle' : `target AED ${fmtAmount(i.target)}`}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">AED ${fmtAmount(i.incentive_aed)}</span><span class="kpi-sub">${i.cards_incentive_aed ? `AED ${fmtAmount(i.core_aed)} production + AED ${fmtAmount(i.cards_incentive_aed)} cards · ` : ''}${i.rate_pct ? `${i.rate_pct.toFixed(2)}% of AED ${fmtAmount(i.pl_counted)}` : i.next_band ? `AED ${fmtAmount(i.next_band.short_by)} more reaches ${i.next_band.label} at ${i.next_band.rate.toFixed(2)}%` : ''}</span></div>
    </div>
    ${i.rate_pct && i.next_band ? html`<p class="muted small">AED ${fmtAmount(i.next_band.short_by)} more production reaches ${i.next_band.label}, paid at ${i.next_band.rate.toFixed(2)}% on the whole.</p>` : ''}
    <ul class="checklist">
      <li>${i.cards_excluded ? html`○ Cards: paid under your card scheme, so nothing here.` : html`${i.cards_qualified ? '✓' : '○'} Cards cross-sold: ${i.cards_sold ? `${cardBits} (AED ${fmtAmount(i.cards_aed)})` : 'none yet'}${i.cards_threshold == null ? ' · needs a personal loan target' : i.cards_qualified ? '' : ` · paid once production reaches AED ${fmtAmount(i.cards_threshold)} (target less AED ${fmtAmount(x.threshold_below_target_aed)})`}. Mass AED ${x.card_aed.Mass}, Premium AED ${x.card_aed.Premium}, Super Premium AED ${x.card_aed['Super Premium']}, noon nil.</li>`}</li>
    </ul>
    <table class="bands"><thead><tr><th>Production in the cycle</th><th>Rate on the whole production</th></tr></thead>
      <tbody>${pl_bands.map((b) => html`<tr class="${b.label === i.band ? 'on' : ''}"><td>${b.label}</td><td>${b.rate.toFixed(2)}%</td></tr>`)}</tbody></table>
    ${i.remark ? html`<div class="callout danger incentive-remark"><strong>${i.remark}.</strong> ${i.excluded_files === 1 ? 'That file is' : 'Those files are'} left out of the production above.</div>` : ''}
    ${potentialBlock(i.potential, { unit: 'aed', scheme: 'pl' })}
    <p class="muted small">Only loans disbursed on files completed in the cycle count. An Emirates Islamic buy-out counts at ${rules.eib_buyout_share}% of its disbursed amount; a top-up at ${i.topup_share}% of its incremental amount${i.topup_share < 100 ? '' : ' (70% from the October 2026 cycle)'}.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// A credit card sales manager's or ASM's incentive: a flat amount per card the core card team sold, by the team's achievement.
function smIncentiveCard({ incentive: i, cc_sm_slabs = [], sm_rules: r, conditions = [] }) {
  return html`<div class="card incentive">
    <div class="card-head"><h2>My team incentive · credit cards · ${i.slab}</h2>
      <span class="chip ${i.aed_per_card ? 'good' : ''}">AED ${i.aed_per_card} per card</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Team card points</span><span class="kpi-value">${fmtAmount(i.points)}</span><span class="kpi-sub">${i.cards_sold} cards by ${i.team_size} core card staff${i.cross_sell_cards ? ` (${i.cross_sell_cards} cross-sold by the rest of the team)` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Against team target</span><span class="kpi-value">${i.achievement_pct == null ? '—' : `${i.achievement_pct}%`}</span><span class="kpi-sub">combined targets ${fmtAmount(i.combined_target)} points${i.staff_without_target ? ` · ${i.staff_without_target} without a target` : ''}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">AED ${fmtAmount(i.incentive_aed)}</span><span class="kpi-sub">${i.cards_sold} cards × AED ${i.aed_per_card}</span></div>
    </div>
    <table class="bands"><thead><tr><th>Team achievement</th><th>Per card</th></tr></thead>
      <tbody>${cc_sm_slabs.map((b) => html`<tr class="${b.label === i.slab ? 'on' : ''}"><td>${b.label}</td><td>AED ${b.aed}</td></tr>`)}</tbody></table>
    <p class="muted small">Every card sold by your team on files completed in the cycle pays the slab amount, cards cross-sold by loan staff included; nothing below ${r.cc_qualify_pct}% of the team's combined card targets.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// A sales manager's or ASM's personal loan incentive: a banded percentage of the team's whole loan production, cross-sell included.
function plSmIncentiveCard({ incentive: i, pl_sm_bands = [], sm_rules: r, conditions = [] }) {
  return html`<div class="card incentive">
    <div class="card-head"><h2>My team incentive · personal loans · ${i.band}</h2>
      <span class="chip ${i.rate_pct ? 'good' : ''}">${i.rate_pct.toFixed(4)}% of production</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Team loan production</span><span class="kpi-value">AED ${fmtAmount(i.pl_counted)}</span><span class="kpi-sub">AED ${fmtAmount(i.core_counted)} by ${i.core_staff} core loan staff + AED ${fmtAmount(i.cross_sell_counted)} cross-sold by the rest</span></div>
      <div class="kpi"><span class="kpi-label">Against team target</span><span class="kpi-value">${i.achievement_pct == null ? '—' : `${i.achievement_pct}%`}</span><span class="kpi-sub">combined targets AED ${fmtAmount(i.combined_target)}${i.staff_without_target ? ` · ${i.staff_without_target} without a target` : ''}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">AED ${fmtAmount(i.incentive_aed)}</span><span class="kpi-sub">${i.rate_pct ? `${i.rate_pct.toFixed(4)}% of AED ${fmtAmount(i.pl_counted)}` : `nothing below ${r.pl_qualify_pct}%`}</span></div>
    </div>
    <table class="bands"><thead><tr><th>Team achievement</th><th>Rate on the whole production</th></tr></thead>
      <tbody>${pl_sm_bands.map((b) => html`<tr class="${b.label === i.band ? 'on' : ''}"><td>${b.label}</td><td>${b.rate.toFixed(4)}%</td></tr>`)}</tbody></table>
    <p class="muted small">Production counts loans on files completed in the cycle by everyone in your team, top-ups and Emirates Islamic buy-outs as for the staff; the target is the core loan staff's combined targets.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// A personal loan team leader's incentive for the cycle: a banded percentage of the team's whole production, plus cards cross-sold.
function plTlIncentiveCard({ incentive: i, pl_tl_rules: r, pl_tl_bands = [], conditions = [] }) {
  const cardBits = [['Mass', i.cards.Mass], ['Premium', i.cards.Premium], ['Super Premium', i.cards['Super Premium']], ['noon', i.cards.noon]].filter(([, n]) => n).map(([l, n]) => `${n} ${l}`).join(', ');
  return html`<div class="card incentive">
    <div class="card-head"><h2>My team incentive · personal loans · ${i.band}</h2>
      <span class="chip ${i.rate_pct ? 'good' : ''}">${i.rate_pct.toFixed(2)}% of team production</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Team production</span><span class="kpi-value">AED ${fmtAmount(i.pl_counted)}</span><span class="kpi-sub">${i.loans} loans by ${i.team_size} core loan staff, AED ${fmtAmount(i.pl_disbursed)} disbursed</span></div>
      <div class="kpi"><span class="kpi-label">Against team target</span><span class="kpi-value">${i.achievement_pct == null ? '—' : `${i.achievement_pct}%`}</span><span class="kpi-sub">combined targets AED ${fmtAmount(i.combined_target)}${i.staff_without_target ? ` · ${i.staff_without_target} without a target` : ''}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">AED ${fmtAmount(i.incentive_aed)}</span><span class="kpi-sub">AED ${fmtAmount(i.core_aed)} core (${i.rate_pct.toFixed(2)}% of AED ${fmtAmount(i.pl_counted)}) + AED ${fmtAmount(i.cards_incentive_aed)} cards</span></div>
    </div>
    <ul class="checklist">
      <li>${i.qualified ? '✓' : '○'} Cards cross-sold: ${i.cards_sold ? `${cardBits} (AED ${fmtAmount(i.cards_aed)})` : 'none yet'}${i.qualified ? '' : ` · paid once the team reaches ${r.qualify_pct}% of target`}</li>
    </ul>
    <table class="bands"><thead><tr><th>Team achievement</th><th>Rate on the whole production</th></tr></thead>
      <tbody>${pl_tl_bands.map((b) => html`<tr class="${b.label === i.band ? 'on' : ''}"><td>${b.label}</td><td>${b.rate.toFixed(2)}%</td></tr>`)}</tbody></table>
    <p class="muted small">Production counts your core personal loan staff's loans on files completed in the cycle: regular loans in full, top-ups and Emirates Islamic buy-outs as for the staff themselves. Cards the team cross-sells pay AED ${r.card_aed.Mass} (Mass), AED ${r.card_aed.Premium} (Premium) or AED ${r.card_aed['Super Premium']} (Super Premium) each, nothing for noon.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// A credit card team leader's incentive for the cycle: the team's card points beyond 75% of its combined targets, plus the cross-sell line.
function tlIncentiveCard({ incentive: i, tl_rules: r, conditions = [] }) {
  const met = i.criterion !== 'none';
  return html`<div class="card incentive">
    <div class="card-head"><h2>My team incentive · ${met ? 'higher rate' : 'standard rate'}</h2>
      <span class="chip ${met ? 'good' : ''}">AED ${i.rate.toFixed(2)} per excess point</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Team card points</span><span class="kpi-value">${fmtAmount(i.points)}</span><span class="kpi-sub">${i.cards_sold} cards by ${i.team_size} core card staff</span></div>
      <div class="kpi"><span class="kpi-label">Excess over team threshold</span><span class="kpi-value">${fmtAmount(i.excess_points)}</span><span class="kpi-sub">threshold ${fmtAmount(i.threshold)} points (${r.threshold_share}% of ${fmtAmount(i.combined_target)} combined targets)${i.staff_without_target ? ` · ${i.staff_without_target} without a target` : ''}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">AED ${fmtAmount(i.incentive_aed)}</span><span class="kpi-sub">AED ${fmtAmount(i.core_aed)} core (${fmtAmount(i.excess_points)} × AED ${i.rate.toFixed(2)}) + AED ${fmtAmount(i.cross_sell_incentive_aed)} cross-sell</span></div>
    </div>
    <ul class="checklist">
      <li>${i.criterion === 'mix' ? '✓' : '○'} Premium mix: ${i.premium_cards} of ${i.cards_sold} team cards Premium or above (${i.mix_pct}% · must exceed ${r.mix_share}%)</li>
      <li>${i.cross_sell_aed >= r.cross_sell_aed ? '✓' : '○'} Cross-sell: AED ${fmtAmount(i.cross_sell_aed)} of personal loans disbursed by the team (needs AED ${fmtAmount(r.cross_sell_aed)})</li>
    </ul>
    <p class="muted small">Team points are card points only, from your core credit card staff's files completed in the cycle. Meet either criterion and excess points pay AED ${r.rate_high.toFixed(2)} each, otherwise AED ${r.rate_low.toFixed(2)}. The team's personal loan cross-sell earns ${r.cross_sell_pct.toFixed(2)}% of the gross amount disbursed on top.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// An auto loan sales person's incentive for the cycle: points from disbursal, excess over target and the multiplier.
function alIncentiveCard({ incentive: i, al_rules: r, conditions = [] }) {
  const kinds = [['new_loans', 'new'], ['used_loans', 'used'], ['algo_loans', 'algo'], ['low_loans', 'low-payout']].filter(([k]) => i[k]).map(([k, l]) => `${i[k]} ${l}`).join(', ');
  return html`<div class="card incentive">
    <div class="card-head"><h2>My incentive · ${i.full_payout_met ? 'higher multiplier' : 'standard multiplier'}</h2>
      <span class="chip ${i.full_payout_met ? 'good' : ''}">AED ${i.multiplier.toFixed(2)} per excess point</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Production points</span><span class="kpi-value">${fmtAmount(i.points)}</span><span class="kpi-sub">AED ${fmtAmount(i.disbursed)} disbursed on ${i.loans} ${i.loans === 1 ? 'loan' : 'loans'}${kinds ? ` (${kinds})` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Excess over target</span><span class="kpi-value">${i.excess_points == null ? '—' : fmtAmount(i.excess_points)}</span><span class="kpi-sub">${i.target == null ? 'no auto loan target set for this cycle' : `target ${fmtAmount(i.target)} points · ${i.achievement_pct}% achieved`}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">${i.incentive_aed == null ? '—' : `AED ${fmtAmount(i.incentive_aed)}`}</span><span class="kpi-sub">${i.excess_points ? `${fmtAmount(i.excess_points)} × AED ${i.multiplier.toFixed(2)}` : 'no excess points yet'}</span></div>
    </div>
    <ul class="checklist">
      <li>${i.full_payout_met ? '✓' : '○'} New and used car disbursal: AED ${fmtAmount(i.full_payout_aed)} of AED ${fmtAmount(r.full_payout_aed)}${i.full_payout_met ? '' : ` (AED ${fmtAmount(i.short_by)} more for AED ${r.multiplier_high.toFixed(2)} a point)`}${i.algo_aed ? ` · algo loans (AED ${fmtAmount(i.algo_aed)}) earn points but do not count here` : ''}</li>
    </ul>
    ${i.remark ? html`<div class="callout danger incentive-remark"><strong>${i.remark}.</strong> ${i.excluded_files === 1 ? 'That file is' : 'Those files are'} left out of the points above.</div>` : ''}
    ${potentialBlock(i.potential, { unit: 'points', scheme: 'al' })}
    <p class="muted small">A loan's points are its disbursed amount at the scheme's rate for its class: new and used car loans ${r.rates_pct.new.toFixed(2)}%, algo loans ${r.rates_pct.algo.toFixed(2)}%, low-payout non-algo loans nil. Points beyond target pay AED ${r.multiplier_high.toFixed(2)} each once new and used disbursal reaches AED ${fmtAmount(r.full_payout_aed)} in the cycle, otherwise AED ${r.multiplier_low.toFixed(2)}. Only loans on files completed in the cycle count.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

// A credit card sales person's incentive for the cycle: points beyond target, the rate earned and why.
function incentiveCard({ incentive: i, rules, conditions = [] }) {
  const met = i.criterion !== 'none';
  return html`<div class="card incentive">
    <div class="card-head"><h2>My incentive · ${i.criterion_label === 'Neither' ? 'standard rate' : 'higher rate'}</h2>
      <span class="chip ${met ? 'good' : ''}">AED ${i.rate.toFixed(2)} per excess point</span></div>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Points this cycle</span><span class="kpi-value">${fmtAmount(i.total_points)}</span><span class="kpi-sub">${fmtAmount(i.card_points)} from cards · ${fmtAmount(i.pl_points)} from personal loans</span></div>
      <div class="kpi"><span class="kpi-label">Excess over target</span><span class="kpi-value">${i.excess_points == null ? '—' : fmtAmount(i.excess_points)}</span><span class="kpi-sub">${i.target == null ? 'no card target set for this cycle' : `target ${fmtAmount(i.target)} points`}</span></div>
      <div class="kpi ${i.incentive_aed ? 'kpi-good' : ''}"><span class="kpi-label">Incentive so far</span><span class="kpi-value">${i.incentive_aed == null ? '—' : `AED ${fmtAmount(i.incentive_aed)}`}</span><span class="kpi-sub">${i.excess_points ? `${fmtAmount(i.excess_points)} × AED ${i.rate.toFixed(2)}` : 'earned once points pass the target'}</span></div>
    </div>
    <ul class="checklist">
      <li>${i.criterion === 'mix' ? '✓' : '○'} Premium mix: ${i.premium_cards} of ${i.cards_sold} cards Premium or above (${i.mix_pct}% · needs ${rules.mix_share}%)</li>
      <li>${i.pl_excluded ? html`○ Cross-sell: personal loans are paid under your loan scheme, so they add no points or criterion here.` : html`${i.criterion === 'cross_sell' || i.pl_counted >= rules.cross_sell_aed ? '✓' : '○'} Cross-sell: AED ${fmtAmount(i.pl_counted)} of personal loans counted (needs AED ${fmtAmount(rules.cross_sell_aed)}${i.eib_loans ? `; Emirates Islamic buy-outs count at ${rules.eib_buyout_share}%` : ''})</li>`}</li>
    </ul>
    ${i.remark ? html`<div class="callout danger incentive-remark"><strong>${i.remark}.</strong> ${i.excluded_files === 1 ? 'That file is' : 'Those files are'} left out of the points above.</div>` : ''}
    ${potentialBlock(i.potential, { unit: 'points', scheme: 'cc' })}
    <p class="muted small">Meet either and excess points pay AED ${rules.rate_high.toFixed(2)} each, otherwise AED ${rules.rate_low.toFixed(2)}. Personal loans count AED ${rules.pl_aed_per_point} per point (Emirates Islamic buy-outs at ${rules.eib_buyout_share}%, top-ups at ${i.topup_share}% of the incremental amount). Only completed files in the cycle count.</p>
    ${conditions.length ? html`<div class="callout warn incentive-conditions"><strong>Conditions.</strong> ${conditions.join(' ')}</div>` : ''}
  </div>`;
}

function targetTiles(rep, block) {
  const products = Object.entries(rep.products);
  const cards = block.cards;
  return html`<div class="target-tiles">
    ${products.map(([k, name]) => {
      const unit = rep.units[k];
      const aed = unit === 'aed';
      const points = unit === 'points';
      const n = block.cases[k];
      const what = aed ? `${n} ${n === 1 ? 'disbursal' : 'disbursals'}` : k === 'credit_card' ? `${n} ${n === 1 ? 'temp end' : 'temp ends'}` : points ? `${n} ${n === 1 ? 'disbursal' : 'disbursals'}` : `${n} completed`;
      const left = block.target[k] - block.achieved[k];
      return html`<div class="target-tile">
        <div class="kpi-label">${name}${aed ? ' disbursed' : points ? ' points' : ''}</div>
        ${meter(block.achieved[k], block.target[k] ?? null, { unit })}
        <div class="muted small">${aed || points ? `${what} · ` : ''}${block.target[k] == null ? 'no target' : left > 0 ? `${aed ? fmtAedShort(left) : left.toLocaleString()} to go` : 'Target met'}</div>
      </div>`;
    })}
    <a class="target-tile card-tile" href="#/cards?cycle=${rep.cycle}">
      <div class="kpi-label">Card activation</div>
      <div class="meter-text"><strong>${cards.active}</strong><span class="muted"> active of ${cards.temp_end} temp ends</span></div>
      <div class="meter"><span style="width:${activationRate(cards) ?? 0}%"></span></div>
      <div class="muted small">${cards.temp_end ? `${activationRate(cards)}% activated · ${cards.inactive} inactive${cards.out_of_range ? ` · ${cards.out_of_range} out of range` : ''}` : 'No temp ends yet'}</div>
    </a>
  </div>`;
}

async function viewTargets(cycleParam) {
  const cycle = cycleParam || state.meta.current_cycle;
  const rep = await api(`/targets?cycle=${encodeURIComponent(cycle)}`);
  const r = effRole();
  const mine = ['sales', 'team_leader', 'sales_manager', 'asm'].includes(r) ? await api(`/incentives/me?cycle=${encodeURIComponent(cycle)}`).catch(() => null) : null;
  const products = Object.entries(rep.products);
  const scopeTitle = { sales: 'My targets', team_leader: 'My team', sales_manager: 'My team' }[r] || 'All sales staff';
  const casesLink = (staffId) => `#/cases?cycle=${rep.cycle}${staffId ? `&staff=${staffId}` : ''}`;

  const groupTable = (title, groups) => (groups?.length > 1 || (groups?.length && r !== 'sales_manager') ? html`
    <div class="card">
      <h2>${title}</h2>
      <div class="table-wrap"><table class="target-table">
        <thead><tr><th>${title.replace('By ', '')}</th><th>Staff</th>${products.map(([k, n]) => html`<th>${n}${unitSuffix(rep.units[k])}</th>`)}<th>Cards active</th></tr></thead>
        <tbody>${groups.map((g) => html`<tr>
          <td><strong>${g.name}</strong></td><td>${g.staff_count}</td>
          ${products.map(([k]) => html`<td>${meter(g.achieved[k], g.target[k] ?? null, { compact: true, unit: rep.units[k] })}</td>`)}
          <td class="small">${g.cards.active}/${g.cards.temp_end}${g.cards.temp_end ? html` <span class="muted">(${activationRate(g.cards)}%)</span>` : ''}</td>
        </tr>`)}</tbody>
      </table></div>
    </div>` : '');

  // Staff table; MIS and business heads can switch it to an editable grid of targets.
  const staffTable = (editing) => html`
    <div class="table-wrap"><table class="target-table${editing ? ' editing' : ''}">
      <thead><tr><th>Sales staff</th>${products.map(([k, n]) => html`<th>${n}${unitSuffix(rep.units[k])}</th>`)}${editing ? '' : html`<th>Cards active</th>`}</tr></thead>
      <tbody>${rep.staff.map((p) => html`<tr ${editing ? '' : raw(`data-href="${casesLink(p.id)}"`)} data-staff="${p.id}">
        <td><strong>${p.name}</strong>${p.active ? '' : html` <span class="chip">Disabled</span>`}<div class="muted small"><span class="mono">${p.sales_code || '—'}</span>${r !== 'team_leader' && p.team_leader_name ? ` · TL ${p.team_leader_name}` : ''}${p.salary != null ? ` · salary AED ${p.salary.toLocaleString('en-US')}` : rep.can_set ? ' · no salary' : ''}</div></td>
        ${products.map(([k, n]) => (editing
          ? (rep.units[k] === 'aed'
            ? html`<td><input class="target-input aed" inputmode="numeric" name="${k}" value="${p.target[k] != null ? p.target[k].toLocaleString('en-US') : ''}" aria-label="${n} disbursal target in AED for ${p.name}" placeholder="AED"></td>`
            : html`<td><input class="target-input" type="number" min="0" step="1" inputmode="numeric" name="${k}" value="${p.target[k] ?? ''}" aria-label="${n} target for ${p.name}" placeholder="${rep.units[k] === 'points' ? 'points' : '—'}"></td>`)
          : html`<td>${meter(p.achieved[k], p.target[k] ?? null, { compact: true, unit: rep.units[k] })}</td>`))}
        ${editing ? '' : html`<td class="small">${p.cards.active}/${p.cards.temp_end}${p.cards.inactive + p.cards.out_of_range ? html`<div class="muted">${p.cards.inactive} inactive${p.cards.out_of_range ? ` · ${p.cards.out_of_range} out of range` : ''}</div>` : ''}</td>`}
      </tr>`)}</tbody>
    </table></div>`;

  shell(html`
    <div class="page-head">
      <div>
        <div class="eyebrow">Sales cycle · ${cycleSpan(rep.cycle)}${rep.is_current ? ` · ${rep.days_left} ${rep.days_left === 1 ? 'day' : 'days'} left` : ''}</div>
        <h1>${scopeTitle} — ${cycleName(rep.cycle)}</h1>
        <p class="muted lede">The ${cycleName(rep.cycle).split(' ')[0]} cycle runs from ${cycleSpan(rep.cycle).replace(' – ', ' to ')}. Credit cards and auto loans count points (each card's points from the product list, an auto loan's from its amount band), personal loans count the AED disbursed and accounts count cases. A case counts when its case status is set to Completed in the cycle, and a bundle counts for each product in it. Targets come from each person's salary through the salary bands.</p>
      </div>
      <div class="cycle-nav">
        <a class="btn" href="#/targets?cycle=${shiftCycle(rep.cycle, -1)}" aria-label="Previous cycle">‹ ${cycleName(shiftCycle(rep.cycle, -1)).split(' ')[0]}</a>
        ${rep.is_current ? '' : html`<a class="btn" href="#/targets">Current cycle</a>`}
        <a class="btn" href="#/targets?cycle=${shiftCycle(rep.cycle, 1)}" aria-label="Next cycle">${cycleName(shiftCycle(rep.cycle, 1)).split(' ')[0]} ›</a>
      </div>
    </div>
    ${r === 'sales' && !rep.staff.length ? html`<div class="callout warn"><strong>No sales profile.</strong>Ask a team leader to complete your profile.</div>` : ''}
    <h2 class="tiles-head">${r === 'sales' ? 'Achieved against target' : `${scopeTitle} · ${rep.staff.length} sales staff`}</h2>
    ${targetTiles(rep, rep.total)}
    ${r === 'sales' ? html`<p><a href="${casesLink()}">View my completed cases in this cycle →</a></p>` : ''}
    ${mine?.incentive ? (mine.type === 'personal_loan' ? plIncentiveCard(mine) : mine.type === 'auto_loan' ? alIncentiveCard(mine) : incentiveCard(mine)) : ''}
    ${(mine?.products || []).length ? html`<div class="callout info"><strong>Multi product.</strong> You are paid under each product scheme you hold a target for, with nothing counted twice: loans are left out of the card scheme and cards out of the loan scheme.</div>${mine.products.map((t) => ({ credit_card: incentiveCard, personal_loan: plIncentiveCard, auto_loan: alIncentiveCard }[t.type])({ ...mine, incentive: t.incentive }))}` : ''}
    ${mine && r === 'sales' && !mine.incentive && !(mine.products || []).length ? html`<div class="callout info"><strong>No incentive scheme applies to you yet.</strong> ${state.user.core_product === 'multi_product' ? 'Multi product staff are paid under each product scheme they hold a target for; no target is set for you this cycle.' : 'Your core product is not set on your profile. Ask MIS to set it to Credit Cards, Personal Loans or Auto Loans and the matching scheme will show here.'}</div>` : ''}
    ${mine && r !== 'sales' && !(mine.teams || []).length ? html`<div class="callout info"><strong>No incentive scheme applies to your team yet.</strong> Leaders and managers earn on core credit card and core personal loan staff; there is no scheme for auto loan or multi product teams.</div>` : ''}
      ${(mine?.teams || []).map((t) => ({ pl_team_leader: plTlIncentiveCard, cc_team_leader: tlIncentiveCard, cc_sales_manager: smIncentiveCard, pl_sales_manager: plSmIncentiveCard }[t.type])({ ...mine, incentive: t.incentive }))}
    ${groupTable('By team leader', rep.by_team_leader)}
    ${groupTable('By sales manager', rep.by_sales_manager)}
    ${r !== 'sales' ? html`<div class="card" id="staff-card">
      <div class="card-head">
        <h2>Sales staff</h2>
        ${rep.can_set ? html`<div class="actions" id="target-actions">
          <a class="btn" href="#/import/targets">Upload targets</a>
          <button id="generate-targets" title="Set every sales person's targets from their salary and the salary bands">Generate from salaries</button>
          <button class="btn-primary" id="edit-targets">Set targets</button>
        </div>` : ''}
      </div>
      <p class="muted small" id="staff-hint">${rep.can_set ? 'Select a row to see the cases completed in this cycle. Team leaders and sales managers see their team with these targets added up.' : 'Select a row to see the cases completed in this cycle.'}</p>
      ${rep.setup ? html`<div class="callout ${setupReady(rep.setup) ? 'info' : 'warn'} small"><strong>Salary-based targets.</strong> ${setupSummary(rep.setup)}</div>` : ''}
      <div id="staff-table">${rep.staff.length ? staffTable(false) : html`<div class="empty">No sales staff ${r === 'sales_manager' || r === 'team_leader' ? 'report to you yet' : 'yet'}</div>`}</div>
    </div>` : ''}`);
  bindRows();

  const gen = document.getElementById('generate-targets');
  if (gen) gen.onclick = async () => {
    if (!confirm(`Set targets for the ${cycleName(rep.cycle)} cycle from each sales person's salary? Targets already set for products that have a salary band will be replaced.`)) return;
    gen.disabled = true;
    try {
      const res = await api('/targets/generate', { method: 'POST', body: { cycle: rep.cycle } });
      toast(`Targets set for ${res.set.length} sales staff${res.skipped.length ? `; ${res.skipped.length} skipped: ${res.skipped.map((s) => `${s.name} (${s.reason})`).join(', ')}` : ''}`);
      viewTargets(rep.cycle);
    } catch (ex) { toast(ex.message, true); gen.disabled = false; }
  };
  const edit = document.getElementById('edit-targets');
  if (!edit || !rep.staff.length) return;
  edit.onclick = () => {
    const actions = document.getElementById('target-actions');
    document.getElementById('staff-table').innerHTML = staffTable(true).s;
    document.getElementById('staff-hint').textContent = `Targets for the ${cycleName(rep.cycle)} cycle: credit cards and accounts in completed cases, personal and auto loans in AED disbursed. Leave a box empty for no target.`;
    actions.innerHTML = html`<button id="copy-prev">Copy ${cycleName(shiftCycle(rep.cycle, -1)).split(' ')[0]} targets</button>
      <button id="cancel-targets">Cancel</button><button class="btn-primary" id="save-targets">Save targets</button>`.s;
    document.getElementById('cancel-targets').onclick = () => viewTargets(rep.cycle);
    document.getElementById('copy-prev').onclick = async (e) => {
      e.target.disabled = true;
      try {
        const prev = await api(`/targets?cycle=${shiftCycle(rep.cycle, -1)}`);
        let filled = 0;
        for (const p of prev.staff) {
          for (const [k, v] of Object.entries(p.target)) {
            const input = app.querySelector(`tr[data-staff="${p.id}"] input[name="${k}"]`);
            if (input && input.value === '') { input.value = input.classList.contains('aed') ? v.toLocaleString('en-US') : v; filled++; }
          }
        }
        toast(filled ? `Copied ${filled} targets into empty boxes. Save to keep them.` : 'Nothing to copy: last cycle had no targets for these staff');
      } catch (ex) { toast(ex.message, true); }
      e.target.disabled = false;
    };
    document.getElementById('save-targets').onclick = async (e) => {
      e.target.disabled = true;
      const targets = [...app.querySelectorAll('tr[data-staff]')].map((tr) => ({
        user_id: Number(tr.dataset.staff),
        ...Object.fromEntries([...tr.querySelectorAll('input')].map((i) => [i.name, i.value])),
      }));
      try {
        await api('/targets', { method: 'PUT', body: { cycle: rep.cycle, targets } });
        toast(`Targets saved for the ${cycleName(rep.cycle)} cycle`);
        viewTargets(rep.cycle);
      } catch (ex) { toast(ex.message, true); e.target.disabled = false; }
    };
  };
}

// ---------- card activation ----------
const CARD_FILTERS = [['all', 'All temp ends'], ['active', 'Active'], ['inactive', 'Inactive'], ['out_of_range', 'Out of range']];

async function viewCards(params) {
  const card = CARD_FILTERS.some(([k]) => k === params.get('card')) ? params.get('card') : 'all';
  const cycle = params.get('cycle') || '';
  const { cases } = await api(`/cases?${new URLSearchParams({ card: 'all', limit: '1000', ...(cycle && { cycle }) })}`);
  const counts = { all: cases.length, active: 0, inactive: 0, out_of_range: 0 };
  for (const c of cases) if (c.card_status in counts) counts[c.card_status]++;
  const shown = card === 'all' ? cases : cases.filter((c) => c.card_status === card);
  // Inactive cards, oldest first, so the longest-inactive ones get followed up first.
  if (card === 'inactive' || card === 'out_of_range') shown.sort((a, b) => cardAgeDays(b) - cardAgeDays(a));
  const inactive = cases.filter((c) => c.card_status === 'inactive');
  const bands = AGE_BANDS.map(([max, label, cls], i) => ({
    label, cls, n: inactive.filter((c) => { const d = cardAgeDays(c); return d <= max && (i === 0 || d > AGE_BANDS[i - 1][0]); }).length,
  }));
  const canMap = state.meta.card_mappers.includes(state.user.role);
  const cycles = Array.from({ length: 12 }, (_, i) => shiftCycle(state.meta.current_cycle, -i));
  const href = (changes) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(changes)) (v && v !== 'all' ? p.set(k, v) : p.delete(k));
    return `#/cards${p.toString() ? `?${p}` : ''}`;
  };

  shell(html`
    <div class="page-head">
      <div><h1>Card activation</h1>
        <p class="muted lede">Every completed credit card case (temp end), mapped to the sales person who sourced it. A card is Inactive from its temp end until it is marked Active; one still inactive 90 days after its temp end moves to Out of activation range on its own. ${canMap ? 'To change a card, set the date in its row, then choose Active or Inactive. Or upload the bank\'s activation report.' : 'MIS records whether each card was activated, and when.'}</p></div>
      ${canMap ? html`<a class="btn" href="#/import/cards">Upload activation report</a>` : ''}
    </div>
    <div class="kpis card-kpis">
      ${[['all', 'Temp ends'], ['active', 'Active'], ['inactive', 'Inactive'], ['out_of_range', 'Out of activation range']].map(([k, l]) => html`<a class="kpi ${k === card ? 'kpi-on' : ''}" href="${href({ card: k })}">
        <span class="kpi-label">${l}</span><span class="kpi-value">${counts[k]}</span>
        <span class="kpi-sub">${k === 'all' ? (cycle ? `${cycleName(cycle)} cycle` : 'All cycles') : counts.all ? `${Math.round((counts[k] / counts.all) * 100)}% of temp ends` : ' '}</span>
      </a>`)}
    </div>
    <div class="card">
      <div class="toolbar">
        <label class="inline-filter" for="card-cycle">Completed in
          <select id="card-cycle"><option value="">All cycles</option>
            ${cycles.map((c) => html`<option value="${c}" ${c === cycle ? raw('selected') : ''}>${cycleName(c)} cycle (${cycleSpan(c)})</option>`)}
          </select></label>
        <div class="tabs" aria-label="Card status">${CARD_FILTERS.map(([k, l]) => html`<a class="${k === card ? 'active' : ''}" href="${href({ card: k })}">${l} <span class="muted">${counts[k]}</span></a>`)}</div>
      </div>
      ${(inactive.length || counts.out_of_range) && ['inactive', 'all', 'out_of_range'].includes(card) ? html`<div class="ageing-strip" aria-label="Inactive card ageing">
        <span class="small"><strong>Inactive ageing</strong> <span class="muted">days since temp end</span></span>
        ${bands.map((b) => html`<span class="chip ${b.n ? b.cls : ''}">${b.label}: <strong>${b.n}</strong></span>`)}
        <a class="chip ${counts.out_of_range ? 'out-range' : ''}" href="${href({ card: 'out_of_range' })}">90+ days, out of range: <strong>${counts.out_of_range}</strong></a>
        ${card === 'all' ? html`<a class="small" href="${href({ card: 'inactive' })}">View inactive, oldest first →</a>` : html`<span class="muted small">Oldest first</span>`}
      </div>` : ''}
      ${shown.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>Ref</th><th>Customer</th><th>Sales staff</th><th>Temp end</th><th>Card status</th><th>Ageing <span class="muted">(days since temp end)</span></th>${canMap ? html`<th>Change status <span class="muted">(date, then status)</span></th>` : ''}</tr></thead>
        <tbody>${shown.map((c) => html`<tr data-href="#/cases/${c.id}" data-case="${c.id}">
          <td><strong>${c.ref}</strong>${c.app_id ? html`<div class="muted small mono">${c.app_id}</div>` : ''}</td>
          <td>${c.customer_name}<div class="muted small">${c.credit_card || ''}</div></td>
          <td>${c.sales_staff_name || '—'}<div class="muted small"><span class="mono">${c.sales_code || ''}</span>${c.team_leader_name ? ` · TL ${c.team_leader_name}` : ''}</div></td>
          <td class="small nowrap">${fmtIsoDay(c.case_status_at)}<div class="muted">${cycleName(cycleOfIso(c.case_status_at))} cycle</div></td>
          <td>${cardChip(c.card_status)}${c.card_activation_date ? html`<div class="muted small">${cardDateText(c)}</div>` : ''}</td>
          <td>${cardAgeDays(c) != null ? ageChip(c) : html`<span class="muted">—</span>`}</td>
          ${canMap ? html`<td class="map-cell"><div class="map-row">
            <input type="date" class="map-date" value="${c.card_activation_date || todayLocal()}" max="${todayLocal()}" aria-label="Status date for ${c.ref}">
            <div class="segmented map-toggle" role="group" aria-label="Card status for ${c.ref}">
              <button type="button" data-map="active" class="${c.card_status === 'active' ? 'on' : ''}">Active</button><button type="button" data-map="inactive" class="${c.card_status === 'inactive' ? 'on' : ''}">Inactive</button>
            </div></div></td>` : ''}
        </tr>`)}</tbody>
      </table></div>` : html`<div class="empty">${counts.all ? 'No cards in this view' : 'No completed credit card cases yet'}</div>`}
    </div>`);
  bindRows();
  document.getElementById('card-cycle').onchange = (e) => go(href({ cycle: e.target.value }));
  // Pick the date, then Active or Inactive. Choosing the same status again saves the new date.
  app.querySelectorAll('.map-cell').forEach((cell) => cell.addEventListener('click', (e) => e.stopPropagation()));
  app.querySelectorAll('[data-map]').forEach((b) => (b.onclick = async () => {
    const tr = b.closest('tr');
    const date = tr.querySelector('.map-date').value;
    if (!date) { toast('Choose the date first', true); return; }
    b.disabled = true;
    try {
      await api(`/cases/${Number(tr.dataset.case)}/actions`, { method: 'POST', body: { action: 'set_card_status', card_status: b.dataset.map, activation_date: date } });
      toast(`Card marked ${b.dataset.map} ${b.dataset.map === 'active' ? 'on' : 'since'} ${fmtDay(date)}`);
      viewCards(params);
    } catch (ex) { toast(ex.message, true); b.disabled = false; }
  }));
}

// ---------- chat: case discussions, direct messages and groups ----------
const composer = (formId, placeholder) => html`<form class="composer" id="${formId}">
  <textarea name="body" rows="2" placeholder="${placeholder}" maxlength="4000" required></textarea>
  <button class="btn-primary">Send</button>
</form>`;

// Message text with @mentions and CRM references turned into links; everything else escaped.
function messageHtml(text) {
  const parts = [];
  const re = /(CRM-\d{6})|(@[A-Za-z][A-Za-z' -]{0,40}?)(?=[\s,.!?:;)]|$)/g;
  let last = 0; let m;
  while ((m = re.exec(text))) {
    parts.push(esc(text.slice(last, m.index)));
    if (m[1]) parts.push(`<a href="#/cases/${Number(m[1].slice(4))}" class="mono">${m[1]}</a>`);
    else parts.push(`<span class="mention">${esc(m[2])}</span>`);
    last = m.index + m[0].length;
  }
  parts.push(esc(text.slice(last)));
  return raw(parts.join(''));
}

const messageRow = (m) => {
  const mine = m.user_id === state.user.id;
  const editable = mine && Date.now() - Date.parse(m.created_at) < state.meta.chat_edit_minutes * 60e3;
  return html`<div class="msg ${mine ? 'mine' : ''}" data-msg="${m.id}">
    <div class="msg-head"><strong>${mine ? 'You' : m.user_name}</strong> <span class="muted small">${ROLE_LABEL[m.user_role] || ''} · ${ago(m.created_at)}${m.edited_at ? ' · edited' : ''}</span>
      ${m.flagged ? html` <span class="chip bad" title="Looks like an ID or phone number. Personal data belongs on the file, not in chat.">Personal data</span>` : ''}
      ${editable ? html` <button type="button" class="btn-link small" data-edit="${m.id}">Edit</button>` : ''}</div>
    <div class="msg-body">${messageHtml(m.body)}</div>
  </div>`;
};

/**
 * Renders a thread into `list`, posts from `form`, and polls for new messages while the page is
 * open. Works for a case discussion and a conversation alike.
 */
// Who can read a case discussion: everyone the file is visible to, grouped by role.
const AUDIENCE_ORDER = ['sales', 'team_leader', 'asm', 'sales_manager', 'processing', 'mis', 'business_head', 'governance'];
function audienceList(audience) {
  if (!audience?.length) return '';
  const byRole = new Map();
  for (const u of audience) { if (!byRole.has(u.role)) byRole.set(u.role, []); byRole.get(u.role).push(u); }
  const roles = [...byRole.keys()].sort((a, b) => (AUDIENCE_ORDER.indexOf(a) + 100) % 100 - (AUDIENCE_ORDER.indexOf(b) + 100) % 100);
  const me = state.user.id;
  return html`<details class="audience">
    <summary><strong>Visible to ${audience.length} ${audience.length === 1 ? 'person' : 'people'}</strong> <span class="muted small">· who can read and post here</span></summary>
    <dl class="audience-list">
      ${roles.map((r) => html`<dt>${ROLE_LABEL[r] || label(r)}</dt><dd>${byRole.get(r).map((u) => html`<span class="chip ${u.id === me ? 'good' : ''}">${u.name}${u.id === me ? ' (you)' : ''}${u.role === 'processing' && u.region ? ` · ${u.region}` : ''}</span>`)}</dd>`)}
    </dl>
  </details>`;
}

function mountThread({ list, form, url, onPosted }) {
  let lastId = 0;
  let timer;
  const append = (items, { scroll = true } = {}) => {
    if (!items.length) return;
    if (lastId === 0) list.innerHTML = '';
    for (const m of items) { list.insertAdjacentHTML('beforeend', messageRow(m).s); lastId = Math.max(lastId, m.id); }
    wireEdits();
    if (scroll) list.scrollTop = list.scrollHeight;
  };
  const load = async () => {
    try {
      const { items } = await api(`${url}?after=${lastId}`);
      if (lastId === 0 && !items.length) list.innerHTML = '<div class="muted small empty-thread">No messages yet.</div>';
      append(items);
    } catch (ex) { if (lastId === 0) list.innerHTML = `<div class="error">${esc(ex.message)}</div>`; }
  };
  const wireEdits = () => list.querySelectorAll('[data-edit]').forEach((b) => (b.onclick = () => {
    const row = b.closest('.msg');
    const body = row.querySelector('.msg-body');
    const current = body.textContent;
    body.innerHTML = html`<form class="composer inline"><textarea rows="2" maxlength="4000" required>${current}</textarea><button class="btn-primary">Save</button><button type="button" data-cancel>Cancel</button></form>`.s;
    const f = body.querySelector('form');
    f.querySelector('[data-cancel]').onclick = () => { body.innerHTML = messageHtml(current).s; };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const { message } = await api(`/messages/${b.dataset.edit}/edit`, { method: 'POST', body: { body: f.querySelector('textarea').value } });
        row.outerHTML = messageRow(message).s;
        wireEdits();
      } catch (ex) { toast(ex.message, true); }
    };
  }));
  // Read-only viewers (governance reading a conversation they are not in) have no composer.
  const ta0 = form?.querySelector('textarea');
  if (ta0) form.onsubmit = async (e) => {
    e.preventDefault();
    const ta = form.querySelector('textarea');
    const text = ta.value.trim();
    if (!text) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      const { message } = await api(url, { method: 'POST', body: { body: text } });
      ta.value = '';
      if (list.querySelector('.empty-thread')) list.innerHTML = '';
      append([message]);
      onPosted?.(message);
    } catch (ex) { toast(ex.message, true); }
    btn.disabled = false;
  };
  // Enter sends; Shift+Enter makes a new line.
  ta0?.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); form.requestSubmit(); } });
  load();
  timer = setInterval(() => { if (!list.isConnected) return clearInterval(timer); if (document.visibilityState === 'visible') load(); }, 5000);
  window.addEventListener('hashchange', () => clearInterval(timer), { once: true });
}

async function viewMessages(conversationId, params) {
  const { items, overseer } = await api('/conversations');
  const current = conversationId ? items.find((c) => c.id === conversationId) : null;
  const initials = (name) => name.split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();
  const groups = items.filter((c) => c.kind === 'group');
  const dms = items.filter((c) => c.kind === 'dm');
  const convRow = (c) => html`<a class="conv ${c.id === conversationId ? 'active' : ''}" href="#/messages/${c.id}">
    <span class="avatar ${c.kind}">${c.kind === 'group' ? '#' : initials(c.name)}</span>
    <span class="conv-main"><span class="conv-name">${c.name}${c.member ? '' : html` <span class="muted small">(read only)</span>`}</span>
      <span class="conv-last muted small">${c.last_message ? `${c.last_message.user_name.split(' ')[0]}: ${c.last_message.body.slice(0, 60)}` : c.kind === 'group' ? `${c.members.length} members` : 'No messages yet'}</span></span>
    ${c.unread ? html`<span class="count">${c.unread}</span>` : ''}
  </a>`;

  shell(html`
    <div class="page-head">
      <div><h1>Messages</h1><p class="muted lede">Direct messages with colleagues and your team groups. ${overseer ? 'As governance or business head you can read every conversation; you can post only in your own.' : 'Governance and the business head can read all conversations, so keep them about work.'} Customers' ID and phone numbers belong on the file, not in chat.</p></div>
      <button class="btn-primary" id="new-dm">New message</button>
    </div>
    <div class="chat-layout ${current ? 'has-thread' : ''}">
      <aside class="card conv-list">
        <div id="dm-picker" hidden><label for="dm-user" class="small">Message a colleague</label><select id="dm-user"><option value="">Choose…</option></select></div>
        ${groups.length ? html`<div class="nav-title">Groups</div>${groups.map(convRow)}` : ''}
        <div class="nav-title">Direct messages</div>
        ${dms.length ? dms.map(convRow) : html`<p class="muted small" style="padding:4px 10px">No direct messages yet. Use <b>New message</b>.</p>`}
      </aside>
      <section class="card thread-pane">
        ${current ? html`
          <div class="thread-head">
            <a class="small back-to-list" href="#/messages">← All conversations</a>
            <h2>${current.name}</h2>
            <div class="muted small">${current.kind === 'group' ? `${current.members.length} members: ${current.members.map((m) => m.name).join(', ')}` : `${ROLE_LABEL[current.other_user?.role] || ''}`}</div>
          </div>
          <div class="thread" id="conv-thread"><div class="muted small">Loading…</div></div>
          ${current.member ? composer('conv-composer', `Message ${current.name}…`) : html`<p class="muted small">You can read this conversation but only its members can post in it.</p>`}`
          : html`<div class="empty">Choose a conversation, or start a new message.</div>`}
      </section>
    </div>`);

  const picker = document.getElementById('dm-picker');
  const select = document.getElementById('dm-user');
  document.getElementById('new-dm').onclick = async () => {
    picker.hidden = !picker.hidden;
    if (select.options.length === 1) {
      const { users } = await api('/colleagues');
      for (const u of users) select.insertAdjacentHTML('beforeend', html`<option value="${u.id}">${u.name} · ${ROLE_LABEL[u.role_key || u.role] || u.role}</option>`.s);
    }
    select.focus();
  };
  select.onchange = async () => {
    if (!select.value) return;
    try {
      const { conversation } = await api('/conversations/direct', { method: 'POST', body: { user_id: Number(select.value) } });
      go(`#/messages/${conversation.id}`);
    } catch (ex) { toast(ex.message, true); }
  };
  if (current) {
    const form = document.getElementById('conv-composer');
    mountThread({ list: document.getElementById('conv-thread'), form, url: `/conversations/${current.id}/messages`, onPosted: refreshCounters });
    setTimeout(refreshCounters, 600);
  }
}

// ---------- privacy: watermark and access log ----------
// A faint, repeating stamp of who is signed in and when, so a photo or screenshot of the screen can
// be traced to the person whose session it came from.
let watermarkTimer;
function paintWatermark() {
  const el = document.querySelector('.watermark');
  if (!el || !state.user) return;
  const stamp = () => {
    const when = new Date().toLocaleString(undefined, { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const text = `${state.user.name} · ${state.user.sales_code || ROLE_LABEL[state.user.role_key || state.user.role]} · ${when}`;
    // A background image cannot read currentColor, so the page's text colour is written into it
    // (light ink on dark mode, dark ink on light); otherwise the stamp is black and invisible on dark.
    const ink = getComputedStyle(el).color || '#000';
    const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'><text x='0' y='120' transform='rotate(-24 210 110)' font-family='IBM Plex Sans, system-ui, sans-serif' font-size='15' fill='${ink}'>${text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/'/g, '&#39;')}</text></svg>`;
    el.style.backgroundImage = `url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}")`;
  };
  stamp();
  clearInterval(watermarkTimer);
  watermarkTimer = setInterval(stamp, 60000);
  // Repaint when the colour scheme flips, so the stamp keeps the right ink.
  if (!paintWatermark.bound) {
    paintWatermark.bound = true;
    window.matchMedia?.('(prefers-color-scheme: dark)').addEventListener?.('change', () => paintWatermark());
    new MutationObserver(() => paintWatermark()).observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  }
}

const ACCESS_LABEL = { view: 'Opened the case', 'reveal:phone': 'Revealed mobile number', 'reveal:alt_phone': 'Revealed alternate phone', 'reveal:eid_number': 'Revealed Emirates ID', 'reveal:passport_number': 'Revealed passport number', 'reveal:salary': 'Revealed salary' };

async function viewAccessLog(params) {
  const caseId = params.get('case') || '';
  const q = (params.get('q') || '').trim().toLowerCase();
  const { items } = await api(`/access-log?limit=1000${caseId ? `&case=${encodeURIComponent(caseId)}` : ''}`);
  const shown = q ? items.filter((e) => [e.user_name, e.customer_name, e.ref, e.sales_staff_name].some((v) => String(v || '').toLowerCase().includes(q))) : items;
  const reveals = items.filter((e) => e.what.startsWith('reveal:')).length;
  shell(html`
    <div class="page-head">
      <div><h1>Access log</h1><p class="muted lede">Who opened each customer's file and which personal details they revealed. Emirates ID, passport and phone numbers are masked on every screen until someone chooses to reveal them, and every reveal is recorded here. Each screen also carries a faint watermark of the signed-in user, so a photo or screenshot can be traced.</p></div>
    </div>
    <div class="kpis card-kpis" style="grid-template-columns: repeat(3, 1fr)">
      <div class="kpi"><span class="kpi-label">Entries</span><span class="kpi-value">${items.length}</span><span class="kpi-sub">most recent 1,000</span></div>
      <div class="kpi"><span class="kpi-label">Reveals</span><span class="kpi-value">${reveals}</span><span class="kpi-sub">of masked personal data</span></div>
      <div class="kpi"><span class="kpi-label">People</span><span class="kpi-value">${new Set(items.map((e) => e.user_name)).size}</span><span class="kpi-sub">who looked at files</span></div>
    </div>
    <div class="card">
      <div class="toolbar">
        <form id="log-search" style="display:flex;gap:8px;flex:1;min-width:240px"><input type="search" name="q" placeholder="Filter by staff, customer or CRM ref…" value="${params.get('q') || ''}"><button>Filter</button></form>
        ${caseId ? html`<a class="btn" href="#/access-log">All cases</a>` : ''}
      </div>
      ${shown.length ? html`<div class="table-wrap"><table>
        <thead><tr><th>When</th><th>Who</th><th>Did what</th><th>Customer</th><th>Sourced by</th></tr></thead>
        <tbody>${shown.map((e) => html`<tr data-href="#/cases/${e.case_id}">
          <td class="small nowrap">${fmtDate(e.at)}</td>
          <td>${e.user_name}<div class="muted small">${ROLE_LABEL[e.user_role] || e.user_role}</div></td>
          <td>${e.what.startsWith('reveal:') ? html`<span class="chip warn">${ACCESS_LABEL[e.what] || e.what}</span>` : ACCESS_LABEL[e.what] || e.what}</td>
          <td><strong class="mono">${e.ref}</strong> ${e.customer_name}</td>
          <td class="small">${e.sales_staff_name || '—'}</td>
        </tr>`)}</tbody>
      </table></div>` : html`<div class="empty">No access recorded yet</div>`}
    </div>`);
  bindRows();
  document.getElementById('log-search').onsubmit = (e) => {
    e.preventDefault();
    const p = new URLSearchParams(params); const v = formData(e.target).q.trim(); v ? p.set('q', v) : p.delete('q');
    go(`#/access-log${p.toString() ? `?${p}` : ''}`);
  };
}

// ---------- bulk upload (MIS and business head) ----------
const BULK_ROLES = ['mis', 'business_head'];
const BULK = {
  cases: {
    tab: 'Cases',
    title: 'Bulk upload cases',
    lede: 'Add many sourced files at once from a spreadsheet, each naming the sales person by sales code. Every row is checked with the same rules as the New case form and starts as Sent to checker, awaiting verification.',
    template: 'cases-upload-template.csv',
    done: ['#/cases', 'View cases'],
  },
  users: {
    tab: 'Users',
    title: 'Bulk upload users',
    lede: 'Add many users at once from a spreadsheet. Team leaders and sales managers in the file are added first, so sales staff in the same file can name them.',
    template: 'users-upload-template.csv',
  },
  cards: {
    tab: 'Card activation',
    title: 'Upload card activation',
    lede: 'Map card activation from the bank\'s report. Each row names a completed credit card case by CRM reference, App ID or Emirates ID, and the result is counted for the sales person who sourced it.',
    template: 'card-activation-template.csv',
    done: ['#/cards', 'View card activation'],
  },
  card_products: {
    tab: 'Card products',
    title: 'Upload the credit card product list',
    lede: 'Replace the list of credit cards offered on the New case form with the bank\'s product list: one row per card with its family, card category and, when known, points. Cards left out of the file are retired: they stay on existing files but are no longer offered. The category fills in on the form when a card is chosen and is saved on each file.',
    template: 'card-products-template.csv',
    done: ['#/cases/new', 'Open the New case form'],
  },
  target_rules: {
    tab: 'Salary targets',
    title: 'Upload salary-band targets',
    lede: 'The target each product gives a sales person by their monthly salary: one row per product and salary band, bands must not overlap. Credit card and auto loan targets are points, personal loan targets are AED to disburse, account targets are a count. Then press Generate from salaries on the Targets page for each cycle.',
    template: 'salary-targets-template.csv',
    done: ['#/targets', 'Open targets'],
  },
  assets: {
    tab: 'Tab register',
    title: 'Upload the tab register',
    lede: 'One row per sourcing tab: tab and serial numbers, accessories, network and SIM, Microsoft Entra ID and the registered mobile, and who it is issued to (HRMS or sales code). A serial already registered updates that tab; a status column moves it to IT custody or handed over.',
    template: 'tab-register-template.csv',
    done: ['#/assets', 'Open the tab register'],
  },
  payroll: {
    tab: 'Salaries paid',
    title: 'Upload salaries paid',
    lede: 'The salary actually paid to each person for a sales cycle, any role, by HRMS code. Add an incentive amount only where the actual differs from what the scheme computes. This feeds the profit and loss. Uploading the same person and cycle again replaces the earlier figure.',
    template: 'salaries-paid-template.csv',
    done: ['#/pnl', 'Open the profit and loss'],
  },
  payout_rules: {
    tab: 'Payout rules',
    title: 'Upload the bank\'s payout rates',
    lede: 'What the bank pays the agency per product: a flat amount per card by category (Mass, Premium, Super Premium, and noon One on its own rate), a percentage of the loan amount for personal loans (lower when buying out an Emirates Islamic loan) and for auto loans by new or used car. One row per rule you want to change; the others keep their current value. Payouts show on each file for managers and above, on the dashboard and in the sourcing, register and card reports.',
    template: 'payout-rules-template.csv',
    done: ['#/reports?report=sourcing&run=1', 'Open the sourcing report'],
  },
  targets: {
    tab: 'Targets',
    title: 'Upload targets',
    lede: 'Set targets for many sales staff at once. One row per sales person and cycle; a cycle runs from the 21st to the 20th and is named after the month it ends in.',
    template: 'targets-template.csv',
    done: ['#/targets', 'View targets'],
  },
};

// Wording per upload: what a row is, the result verb, and which columns name a failed row.
const BULK_WORDS = {
  cases: { one: 'file', many: 'files', verb: 'Added', who: 'Customer', names: ['firstname', 'middlename', 'lastname'], sep: ' ', after: 'They are in the verification queue as Sent to checker.', excel: 'phone, Emirates ID and App ID' },
  users: { one: 'user', many: 'users', verb: 'Added', who: 'User', names: ['fullname', 'email'], sep: ' · ', after: 'They can sign in now.', excel: 'phone' },
  cards: { one: 'card', many: 'cards', verb: 'Mapped', who: 'Case', names: ['reference'], sep: ' ', after: 'Activation now shows on each case and in the sales staff\'s numbers.', excel: 'Reference (App ID and Emirates ID)' },
  targets: { one: 'target row', many: 'target rows', verb: 'Saved', who: 'Sales staff', names: ['salescode', 'cycle'], sep: ' · ', after: 'Staff see them on their Targets page.', excel: '' },
  card_products: { one: 'card', many: 'cards', verb: 'Listed', who: 'Card', names: ['cardname'], sep: ' ', after: 'The New case form now offers exactly these cards.', excel: '' },
  target_rules: { one: 'band', many: 'bands', verb: 'Saved', who: 'Band', names: ['product', 'salaryfromaed'], sep: ' · ', after: 'Press Generate from salaries on the Targets page to apply them.', excel: '' },
  payout_rules: { one: 'rule', many: 'rules', verb: 'Saved', who: 'Rule', names: ['rule'], sep: ' ', after: 'Payouts on files, the dashboard and reports now use these rates.', excel: '' },
  payroll: { one: 'person', many: 'people', verb: 'Saved', who: 'Person', names: ['hrmscode', 'cycle'], sep: ' · ', after: 'The profit and loss uses these figures now.', excel: 'HRMS code' },
  assets: { one: 'tab', many: 'tabs', verb: 'Saved', who: 'Tab', names: ['tabno', 'serialno'], sep: ' · ', after: 'They are in the tab register now.', excel: 'SIM card number and Mobile number registered' },
};

function viewBulkUpload(kind) {
  const cfg = BULK[kind];
  const words = BULK_WORDS[kind];
  if (state.user.role === 'it' && kind !== 'assets') throw new Error('IT accounts upload the tab register only');
  if (!BULK_ROLES.includes(state.user.role) && state.user.role !== 'it') throw new Error('Only MIS and business heads can bulk upload');
  if (['payout_rules', 'payroll'].includes(kind) && !state.meta.can_see_payout) { shell(html`<div class="card empty">Payout rates are for the business head and DXB MIS only</div>`); return; }
  const columns = state.meta.import_columns[kind];
  const required = (c) => c.required;
  let file = null;

  shell(html`
    <div class="page-head">
      <div><h1>${cfg.title}</h1><p class="muted lede">${cfg.lede}</p></div>
      <div class="segmented bulk-tabs" role="tablist">${Object.entries(BULK).filter(([k]) => (!['payout_rules', 'payroll'].includes(k) || state.meta.can_see_payout) && (state.user.role !== 'it' || k === 'assets') && (!state.meta.perms?.custom || state.meta.perms.uploads.includes(k))).map(([k, b]) => html`<a role="tab" href="#/import/${k}" aria-selected="${k === kind}" class="${k === kind ? 'on' : ''}">${b.tab}</a>`)}</div>
    </div>
    <div class="bulk-steps">
      <section class="card">
        <div class="step-head"><span class="step-no">1</span><div><h2>Download the template</h2>
          <p class="muted small">One row per ${words.one}, up to ${state.meta.import_max_rows} rows. Keep the header row as it is.</p></div></div>
        <div class="actions"><button class="btn-primary" id="dl-template">Download template (.csv)</button><button id="dl-example">Download with example row</button></div>
        <div class="callout info small bulk-tip"><strong>Using Excel?</strong>${words.excel ? html`Before typing, select the ${words.excel} column${words.excel.includes(' and ') ? 's' : ''} and set ${words.excel.includes(' and ') ? 'them' : 'it'} to <em>Text</em> (Format Cells → Text) so Excel keeps leading zeros and long numbers. ` : ''}Save with <em>File → Save As → CSV UTF-8</em>.</div>
        <details class="col-guide"><summary>Column guide (${columns.length} columns)</summary>
          <div class="table-wrap"><table>
            <thead><tr><th>Column</th><th>Required</th><th>What to enter</th><th>Example</th></tr></thead>
            <tbody>${columns.map((c) => html`<tr>
              <td><strong>${c.header}</strong></td>
              <td>${required(c) ? html`<span class="chip bad">Required</span>` : html`<span class="muted small">Optional</span>`}</td>
              <td class="small">${c.allowed ? html`One of: ${c.allowed.join(', ')}` : ''}${c.allowed && c.help ? html`<br>` : ''}${c.help || ''}</td>
              <td class="small mono">${c.example || '—'}</td></tr>`)}</tbody>
          </table></div>
        </details>
      </section>
      <section class="card">
        <div class="step-head"><span class="step-no">2</span><div><h2>Upload your file</h2>
          <p class="muted small">Check the file first: nothing is saved until you confirm. Rows with errors are skipped and can be downloaded, fixed and uploaded again.</p></div></div>
        <label class="dropzone" id="dropzone">
          <input type="file" id="bulk-file" accept=".csv,text/csv">
          <span class="dz-main" id="dz-main">Choose a CSV file or drop it here</span>
          <span class="muted small">.csv, saved from Excel or Google Sheets</span>
        </label>
        <div class="actions" style="margin-top:12px"><button class="btn-primary" id="bulk-check" disabled>Check file</button></div>
        <div id="bulk-result"></div>
      </section>
    </div>`);

  const header = columns.map((c) => c.header);
  document.getElementById('dl-template').onclick = () => saveFile(cfg.template, toCsv([header]));
  document.getElementById('dl-example').onclick = () => saveFile(cfg.template.replace('template', 'example'), toCsv([header, columns.map((c) => c.example || '')]));

  const input = document.getElementById('bulk-file');
  const zone = document.getElementById('dropzone');
  const checkBtn = document.getElementById('bulk-check');
  const result = document.getElementById('bulk-result');
  const pick = (f) => {
    result.innerHTML = '';
    if (f && !/\.csv$/i.test(f.name) && f.type !== 'text/csv') {
      file = null;
      checkBtn.disabled = true;
      document.getElementById('dz-main').textContent = 'Choose a CSV file or drop it here';
      result.innerHTML = html`<div class="callout danger"><strong>${f.name} is not a CSV file.</strong>${/\.xlsx?$/i.test(f.name) ? 'In Excel, use File → Save As and choose “CSV UTF-8 (Comma delimited)”, then upload that file.' : 'Save the sheet as CSV and upload that file.'}</div>`.s;
      return;
    }
    file = f || null;
    checkBtn.disabled = !file;
    document.getElementById('dz-main').textContent = file ? `${file.name} · ${(file.size / 1024).toFixed(1)} KB` : 'Choose a CSV file or drop it here';
  };
  input.onchange = () => pick(input.files[0]);
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('over'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('over'));
  zone.addEventListener('drop', (e) => { e.preventDefault(); zone.classList.remove('over'); pick(e.dataTransfer.files[0]); });

  let csv = '';
  const send = (dryRun) => api(`/import/${kind}`, { method: 'POST', body: { csv, dry_run: dryRun } });

  // Who an error row is about, from the name columns of the uploaded file.
  let rowLabel = () => '';
  const render = (r) => {
    const at = (h) => r.header.findIndex((x) => x.toLowerCase().replace(/[^a-z]/g, '') === h);
    const nameCols = words.names.map(at).filter((i) => i >= 0);
    rowLabel = (cells = []) => nameCols.map((i) => cells[i]).filter(Boolean).join(words.sep) || '—';
    const failed = r.rows.filter((x) => !x.ok);
    const passwords = r.rows.filter((x) => x.temp_password);
    const summary = r.dry_run
      ? (r.failed
        ? html`<div class="callout warn"><strong>${r.ok} of ${r.total} rows are ready. ${r.failed} ${r.failed === 1 ? 'has' : 'have'} errors.</strong>Fix them and check again, or upload the ${r.ok} good rows now and the rest later.</div>`
        : html`<div class="callout success"><strong>All ${r.total} rows are ready to upload.</strong>Nothing has been saved yet.</div>`)
      : html`<div class="callout ${r.failed ? 'warn' : 'success'}"><strong>${words.verb} ${r.ok} ${r.ok === 1 ? words.one : words.many}.${r.failed ? ` ${r.failed} ${r.failed === 1 ? 'row was' : 'rows were'} skipped.` : ''}</strong>${r.failed ? 'Download the skipped rows, fix them and upload that file.' : words.after}</div>`;
    result.innerHTML = html`
      <div class="bulk-summary">
        <div class="kpi-mini"><span>${r.total}</span>rows</div>
        <div class="kpi-mini good"><span>${r.ok}</span>${r.dry_run ? 'ready' : words.verb.toLowerCase()}</div>
        <div class="kpi-mini ${r.failed ? 'bad' : ''}"><span>${r.failed}</span>${r.dry_run ? 'with errors' : 'skipped'}</div>
      </div>
      ${summary}
      ${r.ignored_columns?.length ? html`<p class="small muted">Ignored columns not in the template: ${r.ignored_columns.join(', ')}</p>` : ''}
      ${passwords.length ? html`<div class="callout info"><strong>Temporary passwords were generated for ${passwords.length} ${passwords.length === 1 ? 'user' : 'users'}.</strong>Download the sign-in details now; they are not shown again.</div>` : ''}
      <div class="actions" style="margin-bottom:12px">
        ${r.dry_run && r.ok ? html`<button class="btn-primary" id="bulk-go">Upload ${r.ok} ${r.ok === 1 ? 'row' : 'rows'}${r.failed ? ' and skip the rest' : ''}</button>` : ''}
        ${failed.length ? html`<button id="bulk-errors">Download rows with errors</button>` : ''}
        ${passwords.length ? html`<button class="btn-primary" id="bulk-passwords">Download sign-in details</button>` : ''}
        ${!r.dry_run && cfg.done ? html`<a class="btn" href="${cfg.done[0]}">${cfg.done[1]}</a>` : ''}
      </div>
      <div class="table-wrap bulk-rows"><table>
        <thead><tr><th>Line</th><th>Result</th><th>${words.who}</th><th>Details</th></tr></thead>
        <tbody>${[...failed, ...r.rows.filter((x) => x.ok)].map((x) => html`<tr>
          <td class="mono">${x.line}</td>
          <td>${x.ok ? html`<span class="chip good">${r.dry_run ? 'Ready' : words.verb}</span>` : html`<span class="chip bad">Error</span>`}</td>
          <td>${x.ok ? (x.ref ? html`<a href="#/cases/${x.id}"><strong class="mono">${x.ref}</strong></a> ` : '') : ''}${x.ok ? x.label : rowLabel(x.cells)}</td>
          <td class="small">${x.ok ? (x.temp_password ? html`${x.hrms_code ? html`Username <code>${x.hrms_code}</code> · ` : ''}Temporary password <code>${x.temp_password}</code>` : x.email || '') : html`<span class="error">${x.error}</span>`}</td>
        </tr>`)}</tbody>
      </table></div>`.s;
    const go = document.getElementById('bulk-go');
    if (go) go.onclick = async () => {
      go.disabled = true;
      go.textContent = 'Uploading…';
      try {
        render(await send(false));
        toast('Upload finished');
        refreshCounters();
      } catch (ex) { toast(ex.message, true); go.disabled = false; }
    };
    const errs = document.getElementById('bulk-errors');
    if (errs) errs.onclick = () => saveFile(`${kind}-upload-errors.csv`, toCsv([[...r.header, 'Error'], ...failed.map((x) => [...r.header.map((_, i) => x.cells[i] ?? ''), x.error])]));
    const pw = document.getElementById('bulk-passwords');
    if (pw) pw.onclick = () => saveFile('new-user-sign-in-details.csv', toCsv([['Name and role', 'Username (HRMS code)', 'Email', 'Temporary password'], ...passwords.map((x) => [x.label, x.hrms_code || '', x.email, x.temp_password])]));
  };

  checkBtn.onclick = async () => {
    if (!file) return;
    checkBtn.disabled = true;
    checkBtn.textContent = 'Checking…';
    try {
      csv = await readCsvFile(file);
      render(await send(true));
    } catch (ex) {
      result.innerHTML = html`<div class="callout danger"><strong>The file could not be read.</strong>${ex.message}</div>`.s;
    } finally {
      checkBtn.disabled = false;
      checkBtn.textContent = 'Check file';
    }
  };
}

// ---------- team view: the sales hierarchy rolled up at every level ----------
const KPI_COLS = [['sourced', 'Sourced'], ['awaiting', 'Awaiting verification'], ['verification_pending', 'Verification pending'], ['verified', 'Verified'], ['completed', 'Completed'], ['disbursed_aed', 'Disbursed (AED)']];
const regionLabel = () => (state.region ? ` · ${state.region}` : '');

/** The tree as table rows: each level indented, groups expandable, staff rows linking to their cases. */
function teamRows(nodes, rep, depth = 0, parent = '') {
  return nodes.map((n, i) => {
    const id = `${parent}${i}`;
    const k = n.kpis;
    const group = n.level !== 'staff';
    const row = html`<tr class="team-row level-${n.level}" data-node="${id}" data-parent="${parent}" ${group ? raw('data-open="1"') : raw(`data-href="#/cases?cycle=${rep.cycle}&staff=${n.id}"`)} style="--depth:${depth}">
      <td><div class="team-name">${group ? html`<button class="tree-toggle" type="button" aria-expanded="true" aria-label="Collapse ${n.name}">▾</button>` : html`<span class="tree-leaf"></span>`}
        <div><strong>${n.name}</strong>${n.previous_team ? html` <span class="chip" title="Files sourced under this team before the sales person moved">Previous team</span>` : ''}<div class="muted small">${rep.level_labels[n.level]}${n.sales_code ? html` · <span class="mono">${n.sales_code}</span>` : ''}${n.level === 'staff' && n.region && rep.levels[0] !== 'region' ? ` · ${n.region}` : ''}${n.active === 0 ? ' · disabled' : ''}</div></div></div></td>
      <td>${k.staff}</td>
      ${KPI_COLS.map(([key]) => html`<td>${key === 'disbursed_aed' ? (k[key] ? fmtAedShort(k[key]) : '—') : k[key]}</td>`)}
      <td>${meter(k.achieved.credit_card || 0, k.target.credit_card ?? null, { compact: true, unit: 'points' })}</td>
      <td>${meter(k.achieved.personal_loan || 0, k.target.personal_loan ?? null, { compact: true, unit: 'aed' })}</td>
      <td>${meter(k.achieved.auto_loan || 0, k.target.auto_loan ?? null, { compact: true, unit: 'points' })}</td>
      <td class="small">${k.cards.active}/${k.cards.temp_end}${k.cards.temp_end ? html` <span class="muted">(${activationRate(k.cards)}%)</span>` : ''}</td>
    </tr>`;
    return html`${row}${group ? teamRows(n.children, rep, depth + 1, `${id}.`) : ''}`;
  });
}

function teamTable(rep) {
  return html`<div class="table-wrap"><table class="team-table">
    <thead><tr><th>${rep.level_labels[rep.levels[0]]}</th><th>Staff</th>${KPI_COLS.map(([, l]) => html`<th>${l}</th>`)}<th>Card points vs target</th><th>Personal loan vs target (AED)</th><th>Auto loan points vs target</th><th>Cards active</th></tr></thead>
    <tbody>${teamRows(rep.nodes, rep)}</tbody>
    ${rep.nodes.length > 1 ? html`<tfoot><tr><td><strong>Total</strong></td><td>${rep.total.staff}</td>${KPI_COLS.map(([key]) => html`<td>${key === 'disbursed_aed' ? (rep.total[key] ? fmtAedShort(rep.total[key]) : '—') : rep.total[key]}</td>`)}
      <td>${meter(rep.total.achieved.credit_card || 0, rep.total.target.credit_card ?? null, { compact: true, unit: 'points' })}</td><td>${meter(rep.total.achieved.personal_loan || 0, rep.total.target.personal_loan ?? null, { compact: true, unit: 'aed' })}</td><td>${meter(rep.total.achieved.auto_loan || 0, rep.total.target.auto_loan ?? null, { compact: true, unit: 'points' })}</td><td class="small">${rep.total.cards.active}/${rep.total.cards.temp_end}</td></tr></tfoot>` : ''}
  </table></div>`;
}

function wireTree(root) {
  root.querySelectorAll('.tree-toggle').forEach((btn) => (btn.onclick = (e) => {
    e.stopPropagation();
    const tr = btn.closest('tr');
    const open = tr.dataset.open !== '1';
    tr.dataset.open = open ? '1' : '0';
    btn.textContent = open ? '▾' : '▸';
    btn.setAttribute('aria-expanded', String(open));
    const prefix = `${tr.dataset.node}.`;
    root.querySelectorAll('tr[data-node]').forEach((row) => {
      if (!row.dataset.node.startsWith(prefix)) return;
      // A row shows when every group above it is open.
      let show = open;
      let p = row.dataset.parent;
      while (show && p) { const parent = root.querySelector(`tr[data-node="${p.slice(0, -1)}"]`); show = parent?.dataset.open === '1'; p = parent?.dataset.parent; }
      row.hidden = !show;
    });
  }));
}

async function viewTeam(params) {
  const cycle = params.get('cycle') || state.meta.current_cycle;
  const rep = await api(`/hierarchy?cycle=${encodeURIComponent(cycle)}`);
  const r = effRole();
  const top = rep.level_labels[rep.levels[0]];
  const t = rep.total;
  shell(html`
    <div class="page-head">
      <div>
        <div class="eyebrow">Sales cycle · ${cycleSpan(rep.cycle)}${rep.is_current ? ` · ${rep.days_left} ${rep.days_left === 1 ? 'day' : 'days'} left` : ''}${regionLabel()}</div>
        <h1>Team view — ${cycleName(rep.cycle)}</h1>
        <p class="muted lede">Every level of the hierarchy you oversee, ${rep.levels.map((l) => rep.level_labels[l].toLowerCase()).join(' → ')}, with the numbers added up at each level. Sourced counts files entered in the cycle; completed and disbursed count case status set to Completed in the cycle; awaiting and pending are open right now. Region is each sales person's own region. Files count under the team they were sourced in, so a sales person who changed team keeps a Previous team row for the old one. Select a sales person to see their completed cases.</p>
      </div>
      <div class="cycle-nav">
        <a class="btn" href="#/team?cycle=${shiftCycle(rep.cycle, -1)}" aria-label="Previous cycle">‹ ${cycleName(shiftCycle(rep.cycle, -1)).split(' ')[0]}</a>
        ${rep.is_current ? '' : html`<a class="btn" href="#/team">Current cycle</a>`}
        <a class="btn" href="#/team?cycle=${shiftCycle(rep.cycle, 1)}" aria-label="Next cycle">${cycleName(shiftCycle(rep.cycle, 1)).split(' ')[0]} ›</a>
      </div>
    </div>
    <div class="kpis team-kpis">
      ${[['Sales staff', t.staff, ''], ['Sourced', t.sourced, 'in this cycle'], ['Awaiting verification', t.awaiting, 'open now'], ['Verification pending', t.verification_pending, 'open now', t.verification_pending > 0], ['Verified', t.verified, 'in this cycle'], ['Completed', t.completed, 'case status, this cycle'], ['Disbursed', t.disbursed_aed ? fmtAedShort(t.disbursed_aed) : 'AED 0', 'loans, this cycle'], ['Cards active', `${t.cards.active}/${t.cards.temp_end}`, t.cards.temp_end ? `${activationRate(t.cards)}% of temp ends` : 'no temp ends']]
        .map(([l, v, sub, alert]) => html`<div class="kpi ${alert ? 'kpi-alert' : ''}"><span class="kpi-label">${l}</span><span class="kpi-value">${v}</span><span class="kpi-sub">${sub}</span></div>`)}
    </div>
    <div class="card">
      <div class="card-head"><h2>By ${top.toLowerCase()}</h2><div class="actions"><a class="btn" href="#/targets?cycle=${rep.cycle}">Targets</a>${state.meta.reports?.length ? html`<a class="btn" href="#/reports?report=sourcing&cycle=${rep.cycle}">Run a report</a>` : ''}</div></div>
      ${rep.nodes.length ? teamTable(rep) : html`<div class="empty">No sales staff ${['team_leader', 'sales_manager'].includes(r) ? 'report to you yet' : 'yet'}${state.region ? ` in ${state.region}` : ''}</div>`}
    </div>`);
  bindRows();
  wireTree(app);
}

// ---------- reports ----------
const fmtCell = (v, unit) => {
  if (v == null || v === '') return html`<span class="muted">—</span>`;
  if (unit === 'aed') return fmtAed(v);
  if (unit === 'pct') return `${v}%`;
  if (unit === 'hours') return `${v} h`;
  if (unit === 'days') return `${v} d`;
  if (unit === 'date') return fmtDay(v);
  if (unit === 'datetime') return fmtDate(v);
  if (unit === 'role') return ROLE_LABEL[v] || v;
  if (unit === 'count' || unit === 'points') return Number(v).toLocaleString();
  return v;
};

async function viewReports(params) {
  const list = state.meta.reports || [];
  if (!list.length) { shell(html`<div class="card empty">Reports are not available for your role</div>`); return; }
  const key = list.some((r) => r.key === params.get('report')) ? params.get('report') : list[0].key;
  const def = list.find((r) => r.key === key);
  const period = params.get('from') ? 'dates' : 'cycle';
  const cycle = params.get('cycle') || state.meta.current_cycle;
  const region = params.get('region') ?? state.region ?? '';
  const cycles = Array.from({ length: 12 }, (_, i) => shiftCycle(state.meta.current_cycle, -i));
  const run = params.get('run') === '1';
  const query = new URLSearchParams(period === 'dates' ? { from: params.get('from'), to: params.get('to') } : { cycle });
  if (canPickRegion() && region) query.set('region', region);
  let rep = null;
  let error = '';
  if (run) {
    try { rep = await api(`/reports/${key}?${query}`); } catch (ex) { error = ex.message; }
  }
  const table = rep && html`<div class="table-wrap"><table class="report-table">
    <thead><tr>${rep.columns.map((c) => html`<th class="${['text', 'role', 'date', 'datetime'].includes(c.unit) ? '' : 'num'}">${c.label}</th>`)}</tr></thead>
    <tbody>${rep.rows.map((row) => html`<tr>${rep.columns.map((c) => html`<td class="${['text', 'role', 'date', 'datetime'].includes(c.unit) ? '' : 'num'}">${fmtCell(row[c.key], c.unit)}</td>`)}</tr>`)}</tbody>
    ${rep.totals && rep.rows.length ? html`<tfoot><tr>${rep.columns.map((c, i) => html`<td class="${['text', 'role', 'date', 'datetime'].includes(c.unit) ? '' : 'num'}">${i === 0 && rep.totals[c.key] === undefined ? 'Total' : rep.totals[c.key] === undefined ? '' : fmtCell(rep.totals[c.key], c.unit)}</td>`)}</tr></tfoot>` : ''}
  </table>
    ${rep.note ? html`<p class="callout warn report-note"><strong>Conditions.</strong> ${rep.note}</p>` : ''}</div>`;

  shell(html`
    <div class="page-head"><div><h1>Reports</h1><p class="muted lede">Pick a report and a period, run it on screen, then download it as a spreadsheet. Reports cover ${{ team_leader: 'your team', sales_manager: 'your teams' }[effRole()] || (state.region ? `the ${state.region} region` : 'all regions')}; personal details stay masked.</p></div></div>
    <div class="grid report-grid">
      <form class="card report-form" id="report-form">
        <div class="field-row"><label for="rp-report">Report</label>
          <select id="rp-report" name="report">${list.map((r) => html`<option value="${r.key}" ${r.key === key ? raw('selected') : ''}>${r.name}</option>`)}</select>
          <div class="muted small" id="rp-desc">${def.description} Period: ${def.period}.</div></div>
        <div class="field-row"><label>Period</label>
          <div class="segmented two-up"><label><input type="radio" name="period" value="cycle" ${period === 'cycle' ? raw('checked') : ''}><span>Sales cycle</span></label><label><input type="radio" name="period" value="dates" ${period === 'dates' ? raw('checked') : ''}><span>Dates</span></label></div></div>
        <div class="field-row" id="rp-cycle-row" ${period === 'dates' ? raw('hidden') : ''}><label for="rp-cycle">Cycle</label>
          <select id="rp-cycle" name="cycle">${cycles.map((c) => html`<option value="${c}" ${c === cycle ? raw('selected') : ''}>${cycleName(c)} (${cycleSpan(c)})</option>`)}</select></div>
        <div class="form-grid two" id="rp-dates-row" ${period === 'dates' ? '' : raw('hidden')}>
          <div><label for="rp-from">From</label><input id="rp-from" name="from" type="date" value="${params.get('from') || ''}"></div>
          <div><label for="rp-to">To</label><input id="rp-to" name="to" type="date" value="${params.get('to') || todayLocal()}"></div>
        </div>
        ${canPickRegion() ? html`<div class="field-row"><label for="rp-region">Region</label>
          <select id="rp-region" name="region"><option value="">All regions</option>${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${k === region ? raw('selected') : ''}>${l}</option>`)}</select></div>` : ''}
        <div class="actions"><button class="btn-primary">Run report</button>${rep && canDownload() ? html`<a class="btn" id="rp-csv" href="/api/reports/${key}?${query}&format=csv" download>Download CSV</a>` : ''}</div>
      </form>
      <div class="card report-result">
        ${error ? html`<p class="error">${error}</p>` : ''}
        ${rep ? html`<div class="card-head"><div><h2>${rep.name}</h2><p class="muted small" style="margin:0">${rep.period}${rep.region ? ` · ${rep.region}` : ''} · ${rep.rows.length} ${rep.rows.length === 1 ? 'row' : 'rows'}${rep.truncated ? ' (first 5,000 shown)' : ''} · ${rep.scope}</p></div></div>
          ${rep.rows.length ? table : html`<div class="empty">Nothing in this period</div>`}` : html`<div class="empty">Choose a report and press Run</div>`}
      </div>
    </div>
    ${(await recentRuns())}`);
  const form = document.getElementById('report-form');
  const sync = () => {
    const d = list.find((r) => r.key === form.report.value);
    document.getElementById('rp-desc').textContent = `${d.description} Period: ${d.period}.`;
    const dates = form.period.value === 'dates';
    document.getElementById('rp-cycle-row').hidden = dates;
    document.getElementById('rp-dates-row').hidden = !dates;
  };
  form.report.onchange = sync;
  form.querySelectorAll('[name=period]').forEach((i) => (i.onchange = sync));
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = formData(form);
    const p = new URLSearchParams({ report: v.report, run: '1' });
    if (v.period === 'dates') { p.set('from', v.from); p.set('to', v.to); } else p.set('cycle', v.cycle);
    if (canPickRegion()) { p.set('region', v.region || ''); if (!v.region) p.delete('region'); }
    go(`#/reports?${p}`);
  };
  // The CSV link needs the session cookie, which a plain download carries; the demo intercepts it.
  const csv = document.getElementById('rp-csv');
  if (csv && window.__crmDownloadCsv) csv.onclick = (e) => { e.preventDefault(); window.__crmDownloadCsv(csv.getAttribute('href')); };

  async function recentRuns() {
    if (!['governance', 'business_head', 'mis'].includes(state.user.role)) return '';
    const { recent } = await api('/reports');
    if (!recent.length) return '';
    return html`<div class="card"><h2>Recent report runs</h2><p class="muted small">Who ran which report; also in the Access and reveals report.</p>
      ${miniTable(['When', 'Who', 'Report', 'Period'], recent.slice(0, 15).map((r) => [fmtDate(r.at), `${r.user_name} (${ROLE_LABEL[r.user_role] || r.user_role})`, r.name, `${r.filters.period || ''}${r.filters.region ? ` · ${r.filters.region}` : ''}`]))}</div>`;
  }
}

// ---------- staff (MIS and business heads) ----------




// ---------- leads: a sales person's prospects before there is a file ----------
// A mobile number on a lead dials from the phone, after the person confirms.
const telHref = (phone) => String(phone || '').replace(/[^\d+]/g, '');
function confirmCall(phone, name) {
  const modal = document.createElement('div');
  modal.className = 'scan-modal call-modal';
  modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'call-title');
  modal.innerHTML = html`<div class="scan-sheet call-sheet">
    <h2 id="call-title">Call ${name}?</h2>
    <p class="call-number mono">${phone}</p>
    <p class="muted small">Your phone's dialler will open with this number. The call is made from your own phone.</p>
    <div class="actions"><a class="btn btn-primary" href="tel:${telHref(phone)}" data-call-go>📞 Call</a><button type="button" class="btn" data-call-cancel>Cancel</button></div>
  </div>`.s;
  document.body.append(modal);
  const close = () => { modal.remove(); document.removeEventListener('keydown', onKey); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);
  modal.querySelector('[data-call-cancel]').onclick = close;
  modal.querySelector('[data-call-go]').onclick = () => setTimeout(close, 300);
  modal.onclick = (e) => { if (e.target === modal) close(); };
  modal.querySelector('[data-call-go]').focus();
}
const LEAD_CHIP = { open: 'warn', converted: 'good', not_interested: '', not_eligible: 'bad' };
async function viewLeads(params = new URLSearchParams()) {
  const r = effRole();
  const mine = state.user.role === 'sales';
  const filters = new URLSearchParams(); for (const k of ['status', 'q']) if (params.get(k)) filters.set(k, params.get(k));
  const [{ leads, counts }, staff] = await Promise.all([api(`/leads${filters.size ? `?${filters}` : ''}`), mine ? [] : api('/sales-staff').then((x) => x.staff).catch(() => [])]);
  const today = todayLocal();
  const sel = (k) => params.get(k) || '';
  const leadForm = (l = {}, p = 'nl') => html`
    ${!mine ? html`<div class="field-row"><label for="${p}-owner">Sales staff <span class="req">*</span></label><select id="${p}-owner" name="owner_id" required><option value="">Choose…</option>${staff.map((s) => html`<option value="${s.id}" ${l.owner_id === s.id ? raw('selected') : ''}>${s.name}${s.sales_code ? ` · ${s.sales_code}` : ''}</option>`)}</select></div>` : ''}
    <div class="form-grid three">
      <div class="field-row"><label for="${p}-first">First name <span class="req">*</span></label><input id="${p}-first" name="first_name" value="${l.first_name || ''}" required></div>
      <div class="field-row"><label for="${p}-middle">Middle name</label><input id="${p}-middle" name="middle_name" value="${l.middle_name || ''}"></div>
      <div class="field-row"><label for="${p}-last">Last name <span class="req">*</span></label><input id="${p}-last" name="last_name" value="${l.last_name || ''}" required></div>
    </div>
    <div class="form-grid two">
      <div class="field-row"><label for="${p}-phone">Mobile number <span class="req">*</span></label><input id="${p}-phone" name="phone" type="tel" value="${l.phone || ''}" required placeholder="+971 50 123 4567"></div>
      <div class="field-row"><label for="${p}-email">Email</label><input id="${p}-email" name="email" type="email" value="${l.email || ''}"></div>
      <div class="field-row"><label for="${p}-company">Company</label><input id="${p}-company" name="company_name" value="${l.company_name || ''}"></div>
      <div class="field-row"><label for="${p}-salary">Monthly salary (AED)</label><input id="${p}-salary" name="salary" inputmode="numeric" value="${l.salary != null ? l.salary : ''}"></div>
      <div class="field-row"><label for="${p}-product">Interested in</label><select id="${p}-product" name="product"><option value="">Not sure yet</option>${Object.entries(state.meta.products).map(([k, v]) => html`<option value="${k}" ${l.product === k ? raw('selected') : ''}>${v}</option>`)}</select></div>
      <div class="field-row"><label for="${p}-source">Lead source</label><input id="${p}-source" name="source" value="${l.source || ''}" placeholder="Referral, walk-in, field visit…"></div>
      <div class="field-row"><label for="${p}-city">City</label><input id="${p}-city" name="city" value="${l.city || ''}"></div>
      <div class="field-row"><label for="${p}-follow">Follow up on</label><div class="field-pair"><input id="${p}-follow" name="follow_up_at" type="date" value="${l.follow_up_at || ''}"><input name="follow_up_time" type="time" value="${l.follow_up_time || ''}" aria-label="Follow-up time"></div><div class="muted small">It appears on your dashboard the day before, as a task for the next day.</div></div>
    </div>
    <div class="field-row"><label for="${p}-notes">Notes</label><textarea id="${p}-notes" name="notes" placeholder="What the customer said, best time to call…">${l.notes || ''}</textarea></div>`;
  shell(html`
    <div class="page-head"><div><h1>${mine ? 'My leads' : 'Team leads'}</h1><p class="muted lede">${mine ? 'Customers you are working on before there is a file. Convert a lead into a new case when they are ready; the details carry across. Only you and your team leader see your leads.' : 'The leads your sales staff are working on. Only the sales person and you see them.'}</p></div></div>
    <div class="kpis staff-kpis">
      ${[['Open', counts.open, 'being worked'], ['Follow-ups due', counts.due, 'open leads due today or earlier'], ['Converted', counts.converted, 'became files'], ['Not interested', counts.not_interested, ''], ['Not eligible', counts.not_eligible, '']].map(([l, v, sub]) => html`<div class="kpi ${l === 'Follow-ups due' && v ? 'kpi-alert' : ''}"><span class="kpi-label">${l}</span><span class="kpi-value">${v || 0}</span><span class="kpi-sub">${sub || ' '}</span></div>`)}
    </div>
    <form class="toolbar" id="lead-filters">
      <input type="search" name="q" value="${sel('q')}" placeholder="Search name, mobile, company${mine ? '' : ' or staff'}…" aria-label="Search leads">
      <select name="status" aria-label="Status"><option value="">All statuses</option>${Object.entries(state.meta.lead_status).map(([k, l]) => html`<option value="${k}" ${sel('status') === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <button class="btn">Filter</button><span class="muted small">${leads.length} ${leads.length === 1 ? 'lead' : 'leads'}</span>
    </form>
    <div class="grid two-col">
      <div class="card"><div class="table-wrap"><table class="users-table leads-table">
        <thead><tr>${mine ? '' : html`<th>Staff</th>`}<th>Customer</th><th>Interested in</th><th>Follow up</th><th>Status</th><th></th></tr></thead>
        <tbody>${leads.length ? leads.map((l) => html`<tr data-lead-row="${l.id}">
          ${mine ? '' : html`<td>${l.owner_name}<div class="muted small">${l.owner_sales_code || ''}</div></td>`}
          <td><strong>${l.customer_name}</strong><div class="muted small"><a class="mono call-link" href="tel:${telHref(l.phone)}" data-call="${l.phone}" data-call-name="${l.customer_name}" title="Call ${l.customer_name}">📞 ${l.phone}</a>${l.company_name ? ` · ${l.company_name}` : ''}${l.salary != null ? ` · AED ${fmtAmount(l.salary)}` : ''}</div>${l.notes ? html`<div class="small">${l.notes}</div>` : ''}</td>
          <td class="small">${l.product ? state.meta.products[l.product] : html`<span class="muted">—</span>`}${l.source ? html`<div class="muted">${l.source}</div>` : ''}</td>
          <td class="small">${l.follow_up_at ? html`<span class="${l.status === 'open' && l.follow_up_at <= today ? 'lock' : ''}">${l.follow_up_at}${l.follow_up_time ? html`<br>${l.follow_up_time}` : ''}</span>` : html`<span class="muted">—</span>`}${mine && l.status === 'open' ? html`<form class="follow-form" data-follow="${l.id}"><input name="follow_up_at" type="date" value="${l.follow_up_at || ''}" aria-label="Follow-up date"><input name="follow_up_time" type="time" value="${l.follow_up_time || ''}" aria-label="Follow-up time"><button class="btn-link">Set</button></form>` : ''}</td>
          <td><span class="chip ${LEAD_CHIP[l.status] || ''}">${state.meta.lead_status[l.status]}</span>${l.case_id ? html`<div class="small"><a href="#/cases/${l.case_id}">Open the file →</a></div>` : ''}${l.status_note ? html`<div class="muted small">${l.status_note}</div>` : ''}<div class="muted small">${fmtDate(l.status_at || l.created_at)}</div></td>
          <td>${mine ? html`<div class="actions">
            ${l.status === 'open' ? html`<a class="btn-link" href="#/cases/new?lead=${l.id}">Convert to case</a><button class="btn-link" data-lead-edit="${l.id}">Edit</button><button class="btn-link" data-lead-status="${l.id}" data-status="not_interested">Not interested</button><button class="btn-link" data-lead-status="${l.id}" data-status="not_eligible">Not eligible</button>` : l.status === 'converted' ? '' : html`<button class="btn-link" data-lead-status="${l.id}" data-status="open">Reopen</button>`}
          </div>` : ''}</td></tr>
          ${mine && l.status === 'open' ? html`<tr hidden data-lead-editor="${l.id}"><td colspan="6"><form data-lead-form="${l.id}">${leadForm(l, `l${l.id}`)}<div class="actions"><button class="btn-primary">Save</button><button type="button" class="btn" data-lead-cancel="${l.id}">Cancel</button></div></form></td></tr>` : ''}`) : html`<tr><td colspan="6" class="muted">No leads${sel('status') || sel('q') ? ' match' : ' yet'}.</td></tr>`}</tbody>
      </table></div></div>
      <form class="card" id="lead-new"><div class="card-head"><h2>${mine ? 'Add a lead' : 'Add a lead for a staff member'}</h2><button type="button" class="btn" id="lead-scan">📷 Scan a lead sheet</button></div><div id="lead-scan-result"></div>${leadForm({}, 'nl')}<button class="btn-primary">Add lead</button></form>
    </div>`);
  const app = document.getElementById('app');
  const reload = () => viewLeads(params);
  document.getElementById('lead-filters').onsubmit = (e) => { e.preventDefault(); const q = new URLSearchParams(); for (const [k, v] of new FormData(e.target).entries()) if (v) q.set(k, v); location.hash = `#/leads${q.size ? `?${q}` : ''}`; };
  // A photo of a lead sheet, read on the phone: the recognised details fill the form for checking.
  document.getElementById('lead-scan').onclick = async () => {
    const result = await openLeadScanner(state.meta.ocr);
    if (!result) return;
    const form = document.getElementById('lead-new');
    const labels = { first_name: 'first name', middle_name: 'middle name', last_name: 'last name', phone: 'mobile', email: 'email', company_name: 'company', salary: 'salary', product: 'product', source: 'source', city: 'city', follow_up_at: 'follow-up date', notes: 'notes' };
    const filled = [];
    for (const [name, value] of Object.entries(result.fields)) {
      const input = form.querySelector(`[name=${name}]`);
      if (!input || value == null || value === '') continue;
      input.value = value; input.classList.add('scanned'); input.addEventListener('input', () => input.classList.remove('scanned'), { once: true });
      filled.push(labels[name] || name);
    }
    const missing = ['first_name', 'phone'].filter((k) => !result.fields[k]).map((k) => labels[k]);
    document.getElementById('lead-scan-result').innerHTML = html`<div class="callout ${missing.length ? 'warn' : 'success'} scan-callout"><strong>Filled from the sheet: ${filled.join(', ')}.</strong> Check every field against the sheet before adding the lead.${missing.length ? html` <span>Not found: ${missing.join(' and ')}; type ${missing.length === 1 ? 'it' : 'them'} in.</span>` : ''}</div>`.s;
    toast('Lead details filled from the sheet');
  };
  document.getElementById('lead-new').onsubmit = async (e) => { e.preventDefault(); try { await api('/leads', { method: 'POST', body: formData(e.target) }); toast('Lead added'); reload(); } catch (err) { toast(err.message, true); } };
  app.querySelectorAll('[data-call]').forEach((a) => (a.onclick = (e) => { e.preventDefault(); confirmCall(a.dataset.call, a.dataset.callName); }));
  app.querySelectorAll('[data-follow]').forEach((f) => (f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/leads/${f.dataset.follow}/follow-up`, { method: 'POST', body: formData(f) }); toast(f.follow_up_at.value ? 'Follow-up set' : 'Follow-up cleared'); reload(); } catch (err) { toast(err.message, true); } }));
  app.querySelectorAll('[data-lead-edit]').forEach((b) => (b.onclick = () => { const row = app.querySelector(`[data-lead-editor="${b.dataset.leadEdit}"]`); row.hidden = !row.hidden; }));
  app.querySelectorAll('[data-lead-cancel]').forEach((b) => (b.onclick = () => { app.querySelector(`[data-lead-editor="${b.dataset.leadCancel}"]`).hidden = true; }));
  app.querySelectorAll('[data-lead-form]').forEach((f) => (f.onsubmit = async (e) => { e.preventDefault(); try { await api(`/leads/${f.dataset.leadForm}`, { method: 'PATCH', body: formData(f) }); toast('Lead saved'); reload(); } catch (err) { toast(err.message, true); } }));
  app.querySelectorAll('[data-lead-status]').forEach((b) => (b.onclick = async () => {
    const status = b.dataset.status;
    const note = status === 'open' ? '' : prompt(`${state.meta.lead_status[status]}: add a note (optional)`) ?? null;
    if (note === null) return;
    try { await api(`/leads/${b.dataset.leadStatus}/status`, { method: 'POST', body: { status, note } }); toast(`Lead marked ${state.meta.lead_status[status].toLowerCase()}`); reload(); } catch (err) { toast(err.message, true); }
  }));
}

// ---------- profit and loss: revenue less salaries and incentives, per cycle ----------
// The hierarchy as table rows: regions open, everything below closed until clicked.
function pnlTreeRows(nodes, depth = 0) {
  const aed = (n) => `AED ${fmtAmount(n)}`;
  return nodes.map((n) => html`<tr data-node="${n.key}" data-depth="${depth}" data-open="${depth === 0 ? '1' : '0'}" class="lvl-${depth} ${n.kind}" ${depth > 1 ? raw('hidden') : ''}>
      <td><span class="indent" style="--d:${depth}"></span>${n.children.length ? html`<span class="caret">${depth === 0 ? '▾' : '▸'}</span>` : html`<span class="caret none"></span>`}${n.label}${n.kind === 'staff' && n.person?.sales_code ? html` <span class="muted small mono">${n.person.sales_code}</span>` : ''}${n.left ? html` <span class="chip">left</span>` : ''}${n.without_upload && n.kind !== 'staff' ? html` <span class="muted small">(${n.without_upload} estimated)</span>` : n.without_upload ? html` <span class="muted small">(estimated)</span>` : ''}</td>
      <td class="num">${n.headcount || '—'}</td><td class="num">${n.files || '—'}</td><td class="num">${aed(n.revenue)}</td><td class="num">${n.salary_paid + n.salary_estimated ? `− ${aed(n.salary_paid + n.salary_estimated)}` : '—'}</td><td class="num">${n.incentives ? `− ${aed(n.incentives)}` : '—'}</td>
      <td class="num ${n.net < 0 ? 'loss' : 'gain'}">${n.net < 0 ? '− ' : ''}${aed(Math.abs(n.net))}</td><td class="num">${n.margin_pct == null ? '—' : `${n.margin_pct}%`}</td></tr>${pnlTreeRows(n.children, depth + 1)}`);
}
async function viewPnl(params = new URLSearchParams()) {
  if (state.user.role !== 'business_head') throw new Error('The profit and loss is for the business head');
  const cycle = params.get('cycle') || state.meta.current_cycle;
  const region = params.get('region') || '';
  const q = new URLSearchParams({ cycle }); if (region) q.set('region', region);
  const { pnl: p, payroll, tree } = await api(`/pnl?${q}`);
  const cycles = Array.from({ length: 12 }, (_, i) => shiftCycle(state.meta.current_cycle, -i));
  const aed = (n) => `AED ${fmtAmount(n)}`;
  const neg = (n) => (n ? html`<span class="neg">− ${aed(n)}</span>` : aed(0));
  shell(html`
    <div class="page-head"><div><h1>Profit and loss</h1><p class="muted lede">The bank's payout on files completed in the cycle, less the salaries actually paid and the incentives earned, by role. Salaries come from the <a href="#/import/payroll">Salaries paid</a> upload; anyone without one is estimated from their profile salary and flagged.</p></div>
      <div class="actions"><a class="btn" href="#/import/payroll">Upload salaries paid</a><a class="btn" href="#/reports?report=pnl&run=1&cycle=${cycle}${region ? `&region=${region}` : ''}">Download as report</a></div></div>
    <form class="toolbar" id="pnl-filters">
      <select name="cycle" aria-label="Cycle">${cycles.map((c) => html`<option value="${c}" ${c === cycle ? raw('selected') : ''}>${cycleName(c)} (${cycleSpan(c)})</option>`)}</select>
      <select name="region" aria-label="Region"><option value="">All regions</option>${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${region === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <button class="btn">Show</button>
    </form>
    <div class="kpis">
      <div class="kpi"><span class="kpi-label">Revenue</span><span class="kpi-value">${aed(p.revenue.total)}</span><span class="kpi-sub">${p.revenue.files} files completed · cards ${fmtAedShort(p.revenue.by_product.credit_card)} · loans ${fmtAedShort(p.revenue.by_product.personal_loan)} · auto ${fmtAedShort(p.revenue.by_product.auto_loan)}</span></div>
      <div class="kpi"><span class="kpi-label">Salaries</span><span class="kpi-value">${aed(p.salaries + p.salaries_estimated)}</span><span class="kpi-sub">${aed(p.salaries)} uploaded for ${p.uploaded_people} people${p.without_upload ? ` · ${aed(p.salaries_estimated)} estimated for ${p.without_upload}` : ''}</span></div>
      <div class="kpi"><span class="kpi-label">Incentives</span><span class="kpi-value">${aed(p.incentives)}</span><span class="kpi-sub">under the schemes, or the actual where uploaded</span></div>
      <div class="kpi ${p.net >= 0 ? 'kpi-good' : 'kpi-alert'}"><span class="kpi-label">Net</span><span class="kpi-value">${p.net < 0 ? '− ' : ''}${aed(Math.abs(p.net))}</span><span class="kpi-sub">${p.margin_pct == null ? 'no revenue in the cycle' : `${p.margin_pct}% of revenue`}</span></div>
    </div>
    ${p.without_upload ? html`<div class="callout warn"><strong>${p.without_upload} active staff have no salary uploaded for ${p.label}.</strong> Their profile salary is used as an estimate until the actual is uploaded.</div>` : ''}
    <div class="card"><h2>Statement · ${p.label}${p.region ? ` · ${state.meta.regions[p.region]}` : ''}</h2>
      <div class="table-wrap"><table class="pnl">
        <thead><tr><th>Line</th><th>Staff</th><th class="num">Salary paid</th><th class="num">Estimated</th><th class="num">Incentives</th><th class="num">Cost</th></tr></thead>
        <tbody>
          <tr class="total"><td>Revenue</td><td></td><td></td><td></td><td></td><td class="num">${aed(p.revenue.total)}</td></tr>
          ${p.rows.map((l) => html`<tr><td>${l.label}</td><td>${l.staff}${l.without_upload ? html` <span class="muted small">(${l.without_upload} estimated)</span>` : ''}</td><td class="num">${neg(l.salary_paid)}</td><td class="num">${l.salary_estimated ? neg(l.salary_estimated) : '—'}</td><td class="num">${l.incentive_paid ? neg(l.incentive_paid) : '—'}${l.incentive_override ? html`<div class="muted small">${l.incentive_override} actual</div>` : ''}</td><td class="num">${neg(l.cost)}</td></tr>`)}
          <tr class="total"><td>Total costs</td><td></td><td class="num">${neg(p.salaries)}</td><td class="num">${neg(p.salaries_estimated)}</td><td class="num">${neg(p.incentives)}</td><td class="num">${neg(p.costs)}</td></tr>
          <tr class="total net"><td>Net</td><td></td><td></td><td></td><td></td><td class="num">${p.net < 0 ? '− ' : ''}${aed(Math.abs(p.net))}</td></tr>
        </tbody></table></div>
      <p class="muted small">Revenue is what the bank pays on files completed in the cycle, at the payout rates. Incentives are the amounts the schemes work out for the cycle; where an actual incentive was uploaded with the salary it is used instead. Both are before the 60% next-cycle condition and the bank's data cut.</p>
    </div>
    <div class="card"><div class="card-head"><h2>By region and team · ${p.label}</h2><a class="tiles-link" href="#/reports?report=pnl_hierarchy&run=1&cycle=${cycle}${region ? `&region=${region}` : ''}">Download →</a></div>
      <p class="muted small">Revenue follows the team on each completed file. Salaries and incentives follow the people: a team leader's at the team leader line, a sales manager's at the manager line, business heads, processing, MIS, governance and IT as the region's overheads. Click a row to open or close it.</p>
      <div class="table-wrap"><table class="pnl tree">
        <thead><tr><th>Region · manager · team · staff</th><th class="num">People</th><th class="num">Files</th><th class="num">Revenue</th><th class="num">Salaries</th><th class="num">Incentives</th><th class="num">Net</th><th class="num">Margin</th></tr></thead>
        <tbody>${pnlTreeRows(tree.tree)}
          <tr class="total net"><td>All</td><td class="num">${tree.total.headcount}</td><td class="num">${tree.total.files}</td><td class="num">${aed(tree.total.revenue)}</td><td class="num">${neg(tree.total.salary_paid + tree.total.salary_estimated)}</td><td class="num">${neg(tree.total.incentives)}</td><td class="num ${tree.total.net < 0 ? 'loss' : ''}">${tree.total.net < 0 ? '− ' : ''}${aed(Math.abs(tree.total.net))}</td><td class="num">${tree.total.margin_pct == null ? '—' : `${tree.total.margin_pct}%`}</td></tr>
        </tbody></table></div></div>
    <details class="card"><summary><strong>Salaries uploaded for ${p.label}</strong> <span class="muted small">${payroll.length} people</span></summary>
      ${payroll.length ? miniTable(['Name', 'HRMS code', 'Role', 'Region', 'Salary paid', 'Incentive paid', 'Notes'], payroll.map((x) => [x.name, x.hrms_code || '', ROLE_LABEL[x.role] || x.role, x.region || '', aed(x.salary_paid), x.incentive_paid != null ? aed(x.incentive_paid) : '—', x.notes || ''])) : html`<p class="muted small">Nothing uploaded yet for this cycle. <a href="#/import/payroll">Upload salaries paid</a>.</p>`}
    </details>`);
  document.querySelectorAll('tr[data-node]').forEach((tr) => { tr.onclick = (e) => { if (e.target.closest('a')) return; const open = tr.dataset.open === '1'; tr.dataset.open = open ? '0' : '1'; const caret = tr.querySelector('.caret'); if (caret && !caret.classList.contains('none')) caret.textContent = open ? '▸' : '▾'; const depth = Number(tr.dataset.depth); let n = tr.nextElementSibling; while (n && Number(n.dataset.depth) > depth) { if (open) { n.hidden = true; n.dataset.open = '0'; } else if (Number(n.dataset.depth) === depth + 1) n.hidden = false; n = n.nextElementSibling; } }; });
  document.getElementById('pnl-filters').onsubmit = (e) => { e.preventDefault(); const f = new FormData(e.target); const qs = new URLSearchParams({ cycle: f.get('cycle') }); if (f.get('region')) qs.set('region', f.get('region')); location.hash = `#/pnl?${qs}`; };
}

// ---------- roles: custom roles on top of the built-in ones ----------
const NAV_PAGE = (href) => {
  if (/^#\/(cases|queue|callbacks|urgent|action-required|card-approvals|edit-requests|quality-check|recordings|recording-approvals)/.test(href)) return 'cases';
  if (href.startsWith('#/leads')) return 'leads';
  if (href.startsWith('#/targets')) return 'targets';
  if (href.startsWith('#/my-tab')) return 'my_tab';
  if (href.startsWith('#/team')) return 'team';
  if (href.startsWith('#/cards')) return 'cards';
  if (href.startsWith('#/reports')) return 'reports';
  if (href.startsWith('#/import')) return 'uploads';
  if (href.startsWith('#/users')) return 'staff';
  if (href.startsWith('#/access-log')) return 'access_log';
  if (href.startsWith('#/assets')) return 'assets';
  if (href.startsWith('#/messages')) return 'chat';
  if (href.startsWith('#/roles')) return 'roles';
  if (href.startsWith('#/allocation')) return 'allocation';
  if (href.startsWith('#/pnl')) return 'pnl';
  return null;
};
const allowedPage = (page) => !page || !state.meta.perms?.custom || state.meta.perms.pages.includes(page);
const canDownload = () => state.meta.perms?.downloads !== false;

// Processor allocation: the verification team leader maps each sales team leader's products to processors.
async function viewAllocation() {
  const { team_leaders, processors, products } = await api('/allocations');
  const prodKeys = Object.keys(products);
  const options = (selected) => html`<option value="">Shared queue</option>
    ${processors.map((p) => html`<option value="${p.id}" ${selected === p.id ? raw('selected') : ''}>${p.name}${p.role_key === 'processing_lead' ? ' (verification TL)' : ''}${p.region ? ` · ${p.region}` : ''}</option>`)}`;
  shell(html`
    <div class="page-head"><div><h1>Processor allocation</h1>
      <p class="muted">Choose which processor verifies each sales team leader's files, product by product: credit cards, personal loans and auto loans can go to one processor or to different ones, and "All products" sets the three at once. A file reaches only the processors allocated for its products; a product left on the shared queue goes to every processor. The verification team leader sees every file.</p></div></div>
    <div class="card"><h2>Sales team leaders</h2>
      ${team_leaders.length ? html`<div class="table-wrap"><table class="allocation-table">
        <thead><tr><th>Team leader</th><th>Region</th><th>Staff</th><th>All products</th>${prodKeys.map((k) => html`<th>${products[k]}</th>`)}</tr></thead>
        <tbody>${team_leaders.map((t) => {
          const ids = prodKeys.map((k) => t.products[k]?.processor_id ?? null);
          const same = ids.every((v) => v === ids[0]) ? ids[0] : undefined;
          return html`<tr>
            <td><strong>${t.name}</strong></td><td>${t.region || html`<span class="muted">—</span>`}</td><td>${t.staff}</td>
            <td><select data-tl="${t.id}" data-product="all" aria-label="All products for ${t.name}">
              ${same === undefined ? html`<option value="__mixed" selected>Mixed (see products)</option>` : ''}${options(same ?? null)}
            </select></td>
            ${prodKeys.map((k) => html`<td><select data-tl="${t.id}" data-product="${k}" aria-label="${products[k]} for ${t.name}" title="${t.products[k] ? `${t.products[k].set_by_name || ''} · ${fmtDate(t.products[k].set_at)}` : ''}">${options(t.products[k]?.processor_id ?? null)}</select></td>`)}
          </tr>`;
        })}</tbody></table></div>` : html`<p class="muted">No active sales team leaders yet.</p>`}
    </div>
    <div class="card"><h2>Processors</h2>
      ${processors.length ? html`<ul class="plain-list">${processors.map((p) => html`<li><strong>${p.name}</strong>${p.role_key === 'processing_lead' ? html` <span class="chip">Verification team leader</span>` : ''}${p.region ? html` <span class="muted small">${p.region}</span>` : ''}<div class="muted small">${p.allocations ? `${p.allocations} product ${p.allocations === 1 ? 'allocation' : 'allocations'} across ${p.team_leaders} team ${p.team_leaders === 1 ? 'leader' : 'leaders'}` : 'shared queue only'}</div></li>`)}</ul>` : html`<p class="muted">No active processors yet.</p>`}
    </div>`);
  document.querySelectorAll('select[data-tl]').forEach((sel) => (sel.onchange = async () => {
    if (sel.value === '__mixed') return;
    sel.disabled = true;
    try {
      await api(`/allocations/${sel.dataset.tl}`, { method: 'PUT', body: { product: sel.dataset.product, processor_id: sel.value || null } });
      toast(sel.value ? 'Processor allocated' : 'Back to the shared queue');
      await viewAllocation();
    } catch (err) { toast(err.message, true); sel.disabled = false; }
  }));
}

async function viewRoles() {
  if (!state.meta.can_manage_roles) throw new Error('Only IT, Dubai MIS and business heads define roles');
  const cat = await api('/roles');
  const baseOf = (key) => cat.builtin.find((b) => b.key === key);
  const chips = (list, labels) => (list.length ? list.map((k) => html`<span class="chip">${labels[k] || k}</span>`) : html`<span class="muted small">none</span>`);
  const draft = state.roleDraft; state.roleDraft = null;
  const roleForm = (r = null) => {
    const d = draft && (draft.key || null) === (r?.key || null) ? draft : null;
    const b = baseOf(d?.base || r?.base || 'mis');
    const p = d ? b.pages : r ? r.pages : b.pages; const u = d ? b.uploads : r ? r.uploads : b.uploads; const rep = d ? null : r ? r.reports : null;
    if (d) r = { ...(r || {}), label: d.label, description: d.description, base: b.key, downloads: r ? r.downloads : true, payout: r ? r.payout : true };
    return html`<form class="role-form" data-role-form="${r?.key || ''}" data-role-new="${r?.key ? '' : '1'}">
      <div class="form-grid two">
        <div class="field-row"><label>Role name <span class="req">*</span></label><input name="label" value="${r?.label || ''}" required placeholder="e.g. Reporting Analyst" maxlength="60"></div>
        <div class="field-row"><label>Based on <span class="req">*</span></label><select name="base" ${r && cat.usage[r.key] ? raw('disabled') : ''}>${cat.builtin.map((x) => html`<option value="${x.key}" ${x.key === b.key ? raw('selected') : ''}>${x.label}</option>`)}</select>
          <div class="muted small">Sets which files it can see and what it can do on them. A role can only have less than its base, never more.</div></div>
      </div>
      <div class="field-row"><label>Description</label><input name="description" value="${r?.description || ''}" maxlength="300" placeholder="Who this role is for"></div>
      <div class="sub-label">Screens</div>
      <div class="check-grid" data-pages>${b.pages.map((k) => html`<label class="check small"><input type="checkbox" name="pages" value="${k}" ${p.includes(k) ? raw('checked') : ''}> ${cat.pages[k].label}<div class="muted">${cat.pages[k].help}</div></label>`)}</div>
      <div class="sub-label">Reports <span class="muted">(needs the Reports screen)</span></div>
      <label class="check small"><input type="checkbox" name="all_reports" ${rep == null ? raw('checked') : ''}> Every report the base role can run</label>
      <div class="check-grid" data-reports ${rep == null ? raw('hidden') : ''}>${b.reports.map((k) => html`<label class="check small"><input type="checkbox" name="reports" value="${k}" ${rep?.includes(k) ? raw('checked') : ''}> ${cat.reports[k]?.name || k}</label>`)}</div>
      <div class="sub-label">Uploads <span class="muted">(needs the Bulk upload screen)</span></div>
      <div class="check-grid" data-uploads>${b.uploads.length ? b.uploads.map((k) => html`<label class="check small"><input type="checkbox" name="uploads" value="${k}" ${u.includes(k) ? raw('checked') : ''}> ${cat.uploads[k]}</label>`) : html`<span class="muted small">The base role has no uploads.</span>`}</div>
      <div class="check-row">
        <label class="check small"><input type="checkbox" name="downloads" ${r ? (r.downloads ? raw('checked') : '') : raw('checked')}> Can download files (report spreadsheets, staff list)</label>
        <label class="check small" ${['mis', 'business_head'].includes(b.key) ? '' : raw('hidden')}><input type="checkbox" name="payout" ${r ? (r.payout ? raw('checked') : '') : raw('checked')}> Can see pricing (payouts and incentives, where the base role can)</label>
      </div>
      <div class="actions"><button class="btn-primary">${r?.key ? 'Save role' : 'Create role'}</button>${r?.key ? html`<button type="button" class="btn" data-role-delete="${r.key}" ${cat.usage[r.key] ? raw('disabled') : ''}>Delete</button>` : ''}${r?.key && cat.usage[r.key] ? html`<span class="muted small">${cat.usage[r.key]} ${cat.usage[r.key] === 1 ? 'user has' : 'users have'} this role</span>` : ''}</div>
    </form>`;
  };
  shell(html`
    <div class="page-head"><div><h1>Roles</h1><p class="muted lede">Define roles for the agency on top of the built-in ones. A role behaves like the role it is based on (the same files, the same actions) with only the screens, reports, uploads, downloads and pricing you tick. Every new role needs the Dubai business head's approval before anyone is put on it; then assign it on the Staff page.</p></div></div>
    <div class="grid two-col">
      <div>
        <div class="card"><h2>Built-in roles</h2>
          <div class="table-wrap"><table><thead><tr><th>Role</th><th>Screens</th><th>Reports</th><th>Uploads</th></tr></thead>
            <tbody>${cat.builtin.map((b) => html`<tr><td><strong>${b.label}</strong></td><td class="small">${b.pages.map((k) => cat.pages[k].label).join(', ')}</td><td class="small">${b.reports.length ? `${b.reports.length} reports` : '—'}</td><td class="small">${b.uploads.length ? b.uploads.map((k) => cat.uploads[k]).join(', ') : '—'}</td></tr>`)}</tbody></table></div>
          <p class="muted small">Built-in roles cannot be changed; base a new role on one of them to narrow it.</p></div>
        <div class="card"><h2>Custom roles · ${cat.custom.length}</h2>
          ${cat.custom.length ? cat.custom.map((r) => html`<details class="role-item" ${state.roleOpen === r.key || (r.status === 'pending' && state.meta.can_approve_roles) ? raw('open') : ''}><summary><strong>${r.label}</strong> <span class="chip ${{ approved: 'good', pending: 'warn', rejected: 'bad' }[r.status]}">${{ approved: 'Approved', pending: 'Awaiting approval', rejected: 'Rejected' }[r.status]}</span> <span class="muted small">based on ${baseOf(r.base)?.label || r.base} · ${cat.usage[r.key] || 0} users · by ${r.created_by_name || '—'}${r.decided_by_name ? ` · ${r.status} by ${r.decided_by_name} ${fmtDate(r.decided_at)}` : ''}</span>${r.decision_note ? html`<div class="small"><em>${r.decision_note}</em></div>` : ''}
              <div class="small">${chips(r.pages, Object.fromEntries(Object.entries(cat.pages).map(([k, v]) => [k, v.label])))} ${r.reports == null ? html`<span class="chip good">all base reports</span>` : chips(r.reports, Object.fromEntries(Object.entries(cat.reports).map(([k, v]) => [k, v.name])))} ${r.downloads ? '' : html`<span class="chip warn">no downloads</span>`} ${r.payout ? '' : html`<span class="chip warn">no pricing</span>`}</div></summary>
              ${state.meta.can_approve_roles && r.status !== 'approved' ? html`<form class="actions" data-role-decide="${r.key}" style="margin-top:10px"><input name="note" placeholder="Note (required to reject)" style="min-width:260px"><button class="btn-success" data-decision="approve">Approve</button><button type="button" class="btn" data-decision="reject">Reject</button></form>` : ''}
              ${roleForm(r)}</details>`) : html`<p class="muted">No custom roles yet. Create one on the right.</p>`}</div>
      </div>
      <div class="card"><h2>New role</h2>${roleForm(null)}</div>
    </div>`);
  const app = document.getElementById('app');
  const read = (f) => {
    const list = (name) => [...f.querySelectorAll(`input[name=${name}]:checked`)].map((i) => i.value);
    return { label: f.label.value, base: f.base.value, description: f.description.value, pages: list('pages'), reports: f.all_reports.checked ? null : list('reports'), uploads: list('uploads'), downloads: f.downloads.checked, payout: f.payout.checked };
  };
  app.querySelectorAll('[data-role-decide]').forEach((f) => {
    const decide = async (approve) => { try { await api(`/roles/${f.dataset.roleDecide}/${approve ? 'approve' : 'reject'}`, { method: 'POST', body: { note: f.note.value } }); toast(approve ? 'Role approved' : 'Role rejected'); state.roleOpen = f.dataset.roleDecide; await refreshCounters?.(); viewRoles(); } catch (err) { toast(err.message, true); } };
    f.onsubmit = (e) => { e.preventDefault(); decide(true); };
    f.querySelector('[data-decision=reject]').onclick = () => decide(false);
  });
  app.querySelectorAll('[data-role-form]').forEach((f) => {
    f.all_reports.onchange = () => { f.querySelector('[data-reports]').hidden = f.all_reports.checked; };
    // A different base: redraw the form with that base's screens, reports and uploads.
    f.base.onchange = () => { state.roleDraft = { key: f.dataset.roleForm || null, label: f.label.value, description: f.description.value, base: f.base.value }; state.roleOpen = f.dataset.roleForm || null; viewRoles(); };
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const key = f.dataset.roleForm;
        await api(key ? `/roles/${key}` : '/roles', { method: key ? 'PATCH' : 'POST', body: read(f) });
        toast(key ? 'Role saved' : (state.meta.can_approve_roles ? 'Role created' : 'Role created and sent to the Dubai business head for approval')); state.roleOpen = key || null; viewRoles();
      } catch (err) { toast(err.message, true); }
    };
    const del = f.querySelector('[data-role-delete]');
    if (del) del.onclick = async () => { if (!confirm(`Delete the role ${f.label.value}?`)) return; try { await api(`/roles/${del.dataset.roleDelete}`, { method: 'DELETE' }); toast('Role deleted'); viewRoles(); } catch (err) { toast(err.message, true); } };
  });
}

// ---------- asset register: the sourcing tabs issued to sales staff ----------
const ASSET_CHIP = { in_use: 'good', it_custody: 'warn', handed_over: '', returned_to_bank: 'bad' };
const assetStatusChip = (a) => html`<span class="chip ${ASSET_CHIP[a.status] || ''}">${state.meta.asset_status[a.status] || a.status}</span>`;
const accessoriesText = (a) => Object.entries(state.meta.accessories).filter(([k]) => a[k]).map(([, l]) => l).join(', ') || 'None';

// A sales person's own tab, on their dashboard.
function myTabCard(a) {
  if (!a) return html`<div class="card"><h2>No tab recorded</h2><p class="muted small">No sourcing tab is recorded against you. Ask the IT department if you have one.</p></div>`;
  return html`<div class="card">
    <div class="card-head"><h2>Tab ${a.tab_no}</h2>${assetStatusChip(a)}</div>
    <dl class="details">
      <dt>Serial no.</dt><dd class="mono">${a.serial_no}</dd>
      <dt>Accessories</dt><dd>${accessoriesText(a)}</dd>
      <dt>Network</dt><dd>${state.meta.networks[a.network] || '—'}${a.sim_number ? html` · SIM <span class="mono">${a.sim_number}</span>` : ''}</dd>
      <dt>Microsoft Entra ID</dt><dd>${a.entra_id || '—'}</dd>
      <dt>Registered mobile</dt><dd>${a.mobile_number ? html`<span class="mono">${a.mobile_number}</span>` : '—'}</dd>
      <dt>Issued on</dt><dd>${fmtDate(a.assigned_at)}</dd>
    </dl>
  </div>`;
}

// A sales person's own tab, as a page of its own.
async function viewMyTab() {
  const { asset } = await api('/assets/mine');
  let events = [];
  if (asset) events = (await api(`/assets/${asset.id}`).catch(() => ({ events: [] }))).events;
  shell(html`
    <div class="page-head"><div><h1>My tab</h1><p class="muted lede">The sourcing tab issued to you, with its accessories, SIM and sign-in details. The IT department keeps this register; report damage or loss to them.</p></div></div>
    <div class="grid two-col">
      ${myTabCard(asset)}
      ${asset ? html`<div class="card"><h2>History</h2><ul class="timeline small">${events.map((ev) => html`<li><strong>${ev.detail}</strong>${ev.note ? html` · ${ev.note}` : ''}<div class="muted">${ev.user_name || 'System'} · ${fmtDate(ev.created_at)}</div></li>`)}</ul></div>` : ''}
    </div>`);
}

async function viewAssets(params = new URLSearchParams()) {
  const r = state.user.role;
  if (!state.meta.asset_admins.includes(r)) throw new Error('Only IT, MIS and business heads see the asset register');
  const filters = new URLSearchParams();
  for (const k of ['status', 'network', 'region', 'q']) if (params.get(k)) filters.set(k, params.get(k));
  const [{ assets, summary }, { users }] = await Promise.all([api(`/assets${filters.size ? `?${filters}` : ''}`), api('/users')]);
  const staff = users.filter((u) => u.active && ['sales', 'team_leader', 'sales_manager', 'asm'].includes(u.role)).sort((a, b) => a.name.localeCompare(b.name));
  const staffOptions = (selected) => staff.map((u) => html`<option value="${u.id}" ${u.id === selected ? raw('selected') : ''}>${u.name}${u.sales_code ? ` · ${u.sales_code}` : ''}${u.region ? ` · ${u.region}` : ''}</option>`);
  const detailFields = (a = {}, p = 'na') => html`
    <div class="form-grid two">
      <div class="field-row"><label for="${p}-tab">Tab no. <span class="req">*</span></label><input id="${p}-tab" name="tab_no" value="${a.tab_no || ''}" required placeholder="e.g. TAB-0142"></div>
      <div class="field-row"><label for="${p}-serial">Serial no. <span class="req">*</span></label><input id="${p}-serial" name="serial_no" value="${a.serial_no || ''}" required placeholder="On the back of the tab"></div>
    </div>
    <div class="sub-label">Accessories assigned</div>
    <div class="check-row">${Object.entries(state.meta.accessories).map(([k, l]) => html`<label class="check small"><input type="checkbox" name="${k}" value="1" ${a[k] ? raw('checked') : ''}> ${l}</label>`)}</div>
    <div class="form-grid two">
      <div class="field-row"><label for="${p}-net">Network</label><select id="${p}-net" name="network"><option value="">Not set</option>${Object.entries(state.meta.networks).map(([k, l]) => html`<option value="${k}" ${a.network === k ? raw('selected') : ''}>${l}</option>`)}</select></div>
      <div class="field-row"><label for="${p}-sim">SIM card number</label><input id="${p}-sim" name="sim_number" inputmode="numeric" value="${a.sim_number || ''}" placeholder="e.g. 8997 1012 3456 7890"></div>
      <div class="field-row"><label for="${p}-entra">Microsoft Entra ID</label><input id="${p}-entra" name="entra_id" value="${a.entra_id || ''}" placeholder="name@company.ae"></div>
      <div class="field-row"><label for="${p}-mob">Mobile number registered</label><input id="${p}-mob" name="mobile_number" type="tel" inputmode="tel" value="${a.mobile_number || ''}" placeholder="050 123 4567"></div>
    </div>
    <div class="field-row"><label for="${p}-notes">Notes</label><input id="${p}-notes" name="notes" value="${a.notes || ''}" placeholder="Condition, case, anything IT should know"></div>`;
  const formBody = (form) => {
    const body = Object.fromEntries(new FormData(form).entries());
    for (const k of Object.keys(state.meta.accessories)) body[k] = form.querySelector(`[name=${k}]`)?.checked ? 1 : 0;
    return body;
  };
  const sel = (k) => params.get(k) || '';
  shell(html`
    <div class="page-head"><div><h1>Tab register</h1><p class="muted lede">Every sourcing tab issued to sales staff: its number and serial, accessories, SIM and sign-in details, and who holds it. ${r === 'it' ? 'You keep this register.' : 'The IT department keeps this register.'} Download the full inventory from Reports.</p></div>
      <div class="actions"><a class="btn" href="#/import/assets">Bulk upload</a><a class="btn" href="#/reports?report=assets&run=1">Inventory report</a></div></div>
    <div class="kpis staff-kpis">
      ${[['Tabs registered', summary.total, 'all statuses'], ...Object.entries(state.meta.asset_status).map(([k, l]) => [l, summary[k], { in_use: 'with sales staff', it_custody: 'spare, in repair or returned', handed_over: 'returned by leavers', returned_to_bank: 'no longer with the agency' }[k]]), ['Sales staff without a tab', summary.staff_without_tab, 'active accounts']]
        .map(([l, v, sub]) => html`<div class="kpi"><span class="kpi-label">${l}</span><span class="kpi-value">${v ?? 0}</span><span class="kpi-sub">${sub}</span></div>`)}
    </div>
    <form class="toolbar" id="asset-filters">
      <input type="search" name="q" value="${sel('q')}" placeholder="Search tab, serial, SIM, mobile, Entra ID or holder…" aria-label="Search tabs">
      <select name="status" aria-label="Status"><option value="">All statuses</option>${Object.entries(state.meta.asset_status).map(([k, l]) => html`<option value="${k}" ${sel('status') === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <select name="network" aria-label="Network"><option value="">Any network</option>${Object.entries(state.meta.networks).map(([k, l]) => html`<option value="${k}" ${sel('network') === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <select name="region" aria-label="Region"><option value="">All regions</option>${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${sel('region') === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <button class="btn">Filter</button><span class="muted small">${assets.length} ${assets.length === 1 ? 'tab' : 'tabs'}</span>
    </form>
    <div class="grid two-col">
      <div class="card"><div class="table-wrap"><table class="users-table assets-table">
        <thead><tr><th>Tab</th><th>Held by</th><th>Accessories · network</th><th>Sign-in · mobile</th><th>Status</th><th></th></tr></thead>
        <tbody>${assets.length ? assets.map((a) => html`<tr data-asset-row="${a.id}">
          <td><strong class="mono">${a.tab_no}</strong><div class="muted small mono">${a.serial_no}</div></td>
          <td>${a.holder_name ? html`${a.holder_name}<div class="muted small">${[a.holder_sales_code, a.holder_region, a.holder_team_leader ? `TL ${a.holder_team_leader}` : ''].filter(Boolean).join(' · ')}</div>` : html`<span class="muted">—</span>${a.previous_holder_name ? html`<div class="muted small">last ${a.previous_holder_name}</div>` : ''}`}</td>
          <td class="small">${accessoriesText(a)}<div class="muted">${state.meta.networks[a.network] || 'No network'}${a.sim_number ? html` · <span class="mono">${a.sim_number}</span>` : ''}</div></td>
          <td class="small">${a.entra_id || html`<span class="muted">No Entra ID</span>`}<div class="muted">${a.mobile_number ? html`<span class="mono">${a.mobile_number}</span>` : 'No mobile registered'}</div></td>
          <td>${assetStatusChip(a)}<div class="muted small">${a.status === 'in_use' ? `since ${fmtDate(a.assigned_at)}` : a.status === 'returned_to_bank' && a.returned_on ? `on ${a.returned_on}` : a.status_at ? `since ${fmtDate(a.status_at)}` : ''}${a.status_note ? html`<br>${a.status_note}` : ''}</div></td>
          <td><div class="actions"><button class="btn-link" data-asset-open="${a.id}">Open</button></div></td></tr>
          <tr hidden data-asset-panel="${a.id}"><td colspan="6">
            <div class="grid two-col asset-panel">
              <form class="asset-edit" data-asset-edit="${a.id}"><h3>Tab details</h3>${detailFields(a, `a${a.id}`)}<button class="btn">Save details</button></form>
              <div>
                <form data-asset-assign="${a.id}"><h3>${a.status === 'in_use' ? 'Move to another person' : 'Assign to staff'}</h3>
                  <div class="field-row"><label for="as-${a.id}">Staff member</label><select id="as-${a.id}" name="holder_id" required><option value="">Choose…</option>${staffOptions(a.holder_id)}</select></div>
                  <div class="field-row"><input name="note" placeholder="Note (optional)"></div>
                  <button class="btn-primary">Assign · Active, in use</button></form>
                <form data-asset-status="${a.id}" style="margin-top:14px"><h3>Change status</h3>
                  <div class="segmented three-up">
                    <label><input type="radio" name="status" value="it_custody" ${a.status !== 'it_custody' ? raw('checked') : raw('disabled')}><span>With IT custody</span></label>
                    <label><input type="radio" name="status" value="handed_over" ${a.status === 'handed_over' ? raw('disabled') : ''}><span>Handed over on exit</span></label>
                    <label><input type="radio" name="status" value="returned_to_bank"><span>Returned to bank</span></label>
                  </div>
                  <div class="field-row" data-returned-row hidden><label for="rd-${a.id}">Date returned to the bank <span class="req">*</span></label><input id="rd-${a.id}" name="returned_on" type="date" value="${a.returned_on || todayLocal()}" max="${todayLocal()}"></div>
                  <div class="field-row" style="margin-top:8px"><input name="note" placeholder="Reason (repair, spare, resignation date…)"></div>
                  <button class="btn">Update status</button></form>
                <div class="asset-history" data-asset-history="${a.id}"><p class="muted small">Loading history…</p></div>
              </div>
            </div></td></tr>`) : html`<tr><td colspan="6" class="muted">No tabs match.</td></tr>`}</tbody>
      </table></div></div>
      <form class="card" id="asset-new">
        <h2>Register a tab</h2>
        ${detailFields({}, 'na')}
        <div class="field-row"><label for="na-holder">Issue straight to</label><select id="na-holder" name="holder_id"><option value="">Nobody yet (stays with IT)</option>${staffOptions(null)}</select></div>
        <button class="btn-primary">Register tab</button>
      </form>
    </div>`);
  const app = document.getElementById('app');
  const reload = () => viewAssets(params);
  const run = async (fn, form) => { try { await fn(); await reload(); } catch (err) { toast(err.message, 'error'); form?.querySelector('button')?.removeAttribute('disabled'); } };
  document.getElementById('asset-filters').onsubmit = (e) => { e.preventDefault(); const q = new URLSearchParams(); for (const [k, v] of new FormData(e.target).entries()) if (v) q.set(k, v); location.hash = `#/assets${q.size ? `?${q}` : ''}`; };
  document.getElementById('asset-new').onsubmit = (e) => { e.preventDefault(); const body = formBody(e.target); if (!body.holder_id) delete body.holder_id; run(() => api('/assets', { method: 'POST', body }).then(() => toast('Tab registered')), e.target); };
  app.querySelectorAll('[data-asset-open]').forEach((b) => (b.onclick = async () => {
    const id = b.dataset.assetOpen; const panel = app.querySelector(`[data-asset-panel="${id}"]`);
    panel.hidden = !panel.hidden; b.textContent = panel.hidden ? 'Open' : 'Close';
    if (!panel.hidden) {
      const { events } = await api(`/assets/${id}`).catch(() => ({ events: [] }));
      panel.querySelector('[data-asset-history]').innerHTML = html`<h3>History</h3><ul class="timeline small">${events.map((ev) => html`<li><strong>${ev.detail}</strong>${ev.note ? html` · ${ev.note}` : ''}<div class="muted">${ev.user_name || 'System'} · ${fmtDate(ev.created_at)}</div></li>`)}</ul>`;
    }
  }));
  app.querySelectorAll('[data-asset-edit]').forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); run(() => api(`/assets/${f.dataset.assetEdit}`, { method: 'PATCH', body: formBody(f) }).then(() => toast('Tab details saved')), f); }));
  app.querySelectorAll('[data-asset-assign]').forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); run(() => api(`/assets/${f.dataset.assetAssign}/assign`, { method: 'POST', body: Object.fromEntries(new FormData(f).entries()) }).then(() => toast('Tab assigned')), f); }));
  app.querySelectorAll('[data-asset-status]').forEach((f) => { const row = f.querySelector('[data-returned-row]'); const sync = () => { row.hidden = f.querySelector('input[name=status]:checked')?.value !== 'returned_to_bank'; }; f.querySelectorAll('input[name=status]').forEach((i) => (i.onchange = sync)); sync(); });
  app.querySelectorAll('[data-asset-status]').forEach((f) => (f.onsubmit = (e) => { e.preventDefault(); const body = Object.fromEntries(new FormData(f).entries()); if (!body.status) return toast('Choose a status', 'error'); run(() => api(`/assets/${f.dataset.assetStatus}/status`, { method: 'POST', body }).then(() => toast('Status updated')), f); }));
}

async function viewUsers() {
  if (!BULK_ROLES.includes(state.user.role)) throw new Error('Only MIS and business heads manage staff');
  const { users } = await api('/users');
  const { assets: tabs } = await api('/assets').catch(() => ({ assets: [] }));
  const tabOf = (id) => tabs.find((a) => a.holder_id === id && a.status === 'in_use');
  const leaders = users.filter((u) => ['team_leader', 'sales_manager', 'asm'].includes(u.role) && u.active).sort((a, b) => (a.role === 'team_leader' ? 0 : 1) - (b.role === 'team_leader' ? 0 : 1) || a.name.localeCompare(b.name));
  const managers = users.filter((u) => u.role === 'sales_manager' && u.active);
  const asms = users.filter((u) => u.role === 'asm' && u.active);
  const options = (list, selected) => list.map((u) => html`<option value="${u.id}" ${u.id === selected ? raw('selected') : ''}>${u.name}</option>`);
  // Sales code, team leader and sales manager; these pre-fill the Sales staff section of every file.
  const profileFields = (u = {}, prefix = 'n') => html`
    <div class="field-row"><label for="${prefix}-code">Sales code <span class="req">*</span></label>
      <input id="${prefix}-code" name="sales_code" value="${u.sales_code || ''}" placeholder="e.g. DXB-S-014" required></div>
    <div class="field-row"><label for="${prefix}-tl">Team leader <span class="req">*</span></label>
      <select id="${prefix}-tl" name="team_leader_id" required><option value="">Choose…</option>${options(leaders, u.team_leader_id)}</select></div>
    <div class="field-row"><label for="${prefix}-sm">Sales manager</label>
      <select id="${prefix}-sm" name="sales_manager_id"><option value="">None (reports to the business head)</option>${options(managers, u.sales_manager_id)}</select></div>
    <div class="field-row"><label for="${prefix}-asm">Assistant sales manager</label>
      <select id="${prefix}-asm" name="asm_id"><option value="">None</option>${options(asms, u.asm_id)}</select></div>
    <div class="field-row"><label for="${prefix}-core">Core product</label>
      <select id="${prefix}-core" name="core_product"><option value="">Not set</option>${Object.entries(state.meta.staff_core_products).map(([k, l]) => html`<option value="${k}" ${u.core_product === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <div class="muted small">The product line this person mainly sells. Pre-fills the core product on their new files.</div></div>
    <div class="field-row"><label for="${prefix}-salary">Monthly salary (AED)</label>
      <input id="${prefix}-salary" name="salary" inputmode="numeric" value="${u.salary != null ? u.salary.toLocaleString('en-US') : ''}" placeholder="e.g. 5,000">
      <div class="muted small">Sets this person's targets through the salary bands. Seen by MIS and business heads only.</div></div>`;

  // Email, local mobile and WhatsApp for any user.
  const contactFields = (u = {}, prefix = 'n') => html`
    <div class="field-row"><label for="${prefix}-name">Full name <span class="req">*</span></label>
      <input id="${prefix}-name" name="name" value="${u.name || ''}" autocomplete="off" required></div>
    <div class="field-row"><label for="${prefix}-hrms">HRMS code <span class="req">*</span></label>
      <input id="${prefix}-hrms" name="hrms_code" value="${u.hrms_code || ''}" autocomplete="off" autocapitalize="characters" placeholder="e.g. EN10234" required>
      <div class="muted small">The bank's staff code. It is this person's username at sign-in.</div></div>
    <div class="field-row"><label for="${prefix}-email">Email address <span class="req">*</span></label>
      <input id="${prefix}-email" name="email" type="email" value="${u.email || ''}" autocomplete="off" required>
      ${prefix === 'nu' ? html`<div class="muted small" id="nu-email-hint" hidden>Suggested from the name. Change it if their address is different.</div>` : ''}</div>
    <div class="field-row"><label for="${prefix}-mobile">Local mobile <span class="req">*</span></label>
      <input id="${prefix}-mobile" name="mobile_number" type="tel" inputmode="tel" value="${fmtMobile(u.mobile_number)}" placeholder="050 123 4567" required></div>
    <div class="field-row"><label for="${prefix}-wa">WhatsApp number</label>
      <input id="${prefix}-wa" name="whatsapp_number" type="tel" inputmode="tel" value="${u.whatsapp_number || ''}" placeholder="+971 50 123 4567">
      <label class="check small wa-same"><input type="checkbox" data-wa-same> Same as local mobile</label></div>
    <div class="form-grid two">
      <div class="field-row"><label for="${prefix}-doj">Date of joining</label>
        <input id="${prefix}-doj" name="doj" type="date" value="${u.doj || ''}" max="${todayLocal()}"></div>
      ${prefix === 'nu' ? '' : html`<div class="field-row"><label for="${prefix}-dol">Date of leaving</label>
        <input id="${prefix}-dol" name="dol" type="date" value="${u.dol || ''}">
        <div class="muted small">Set when the person resigns. Their account is disabled from that day; clear it to re-enable.</div></div>`}
    </div>
`;
  // Every staff member has a region. A processor's region limits the files they verify; a sales
  // person's pre-fills their new files, which can still name any region.
  const regionField = (u = {}, prefix = 'n') => html`
    <div class="field-row" id="${prefix}-region-row"><label for="${prefix}-region">Region</label>
      <select id="${prefix}-region" name="region"><option value="">Not set</option>${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${u.region === k ? raw('selected') : ''}>${l}</option>`)}</select>
      <div class="muted small">Processors verify only their region's files. Sales staff's new files start in their region.</div></div>`;
  const contactCell = (u) => html`${u.mobile_number ? html`<div class="mono">${fmtMobile(u.mobile_number)}</div>` : html`<span class="muted">—</span>`}
    ${u.whatsapp_number ? html`<a class="wa" href="https://wa.me/${u.whatsapp_number.slice(1)}" target="_blank" rel="noopener" title="Open a WhatsApp chat">WhatsApp ${u.whatsapp_number}</a>` : ''}`;

  shell(html`
    <div class="page-head"><div><h1>Staff</h1><p class="muted" style="margin:0">Every user of the CRM: sales staff, processors, team leaders, assistant sales managers, sales managers, MIS, business heads and governance. Each sales person's code, team leader and sales manager fill in automatically on the files they source.</p></div>
      <div class="actions">${BULK_ROLES.includes(state.user.role) ? html`<a class="btn" href="#/import/users">Bulk upload</a>` : ''}${canDownload() ? html`<button class="btn" id="staff-csv">Download staff list</button>` : ''}</div>
    </div>
    <div class="kpis staff-kpis">
      ${[['Total staff', users.length, `${users.filter((u) => u.active).length} active`], ['Sales staff', users.filter((u) => u.role === 'sales' && u.active).length, 'active'], ['Processors', users.filter((u) => u.role === 'processing' && u.active).length, 'active'], ['Managers', users.filter((u) => ['team_leader', 'asm', 'sales_manager'].includes(u.role) && u.active).length, 'TL, ASM and SM'], ['Left or disabled', users.filter((u) => !u.active).length, users.filter((u) => u.dol && u.dol > todayLocal()).length ? `${users.filter((u) => u.dol && u.dol > todayLocal()).length} leaving soon` : ' ']]
        .map(([l, v, sub]) => html`<div class="kpi"><span class="kpi-label">${l}</span><span class="kpi-value">${v}</span><span class="kpi-sub">${sub}</span></div>`)}
    </div>
    <div class="toolbar">
      <input type="search" id="staff-q" placeholder="Search name, HRMS code, email or sales code…" aria-label="Search staff">
      <select id="staff-role" aria-label="Role"><option value="">All roles</option>${Object.entries(ROLE_LABEL).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <select id="staff-region" aria-label="Region"><option value="">All regions</option>${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}">${l}</option>`)}</select>
      <select id="staff-status" aria-label="Status"><option value="">Active and disabled</option><option value="active">Active only</option><option value="inactive">Disabled or left</option></select>
      <span class="muted small" id="staff-count"></span>
    </div>
    <div class="grid two-col">
      <div class="card"><div class="table-wrap"><table class="users-table">
        <thead><tr><th>Name</th><th>Contact</th><th>Role</th><th>Sales profile</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr style="cursor:default" data-user-row="${u.id}">
          <td>${u.name}${u.active ? '' : html` <span class="chip">Disabled</span>`}<div class="muted small">${u.hrms_code ? html`<span class="mono">${u.hrms_code}</span> · ` : html`<span class="lock">No HRMS code</span> · `}<a href="mailto:${u.email}">${u.email}</a></div></td><td class="small">${contactCell(u)}</td><td>${ROLE_LABEL[u.role_key || u.role]}${u.region ? html`<div class="muted small">${u.region}</div>` : ''}${u.doj ? html`<div class="muted small">Joined ${fmtDay(u.doj)}</div>` : ''}${u.dol ? html`<div class="small ${u.dol <= todayLocal() ? 'lock' : 'muted'}">${u.dol <= todayLocal() ? 'Left' : 'Leaving'} ${fmtDay(u.dol)}</div>` : ''}</td>
          <td class="small">${u.role === 'sales'
            ? (u.sales_code
              ? html`<strong class="mono">${u.sales_code}</strong><div class="muted">TL: ${u.team_leader_name || '—'}<br>SM: ${u.sales_manager_name || '—'}${u.asm_name ? html`<br>ASM: ${u.asm_name}` : ''}${u.core_product ? html`<br>${state.meta.staff_core_products[u.core_product]}` : ''}</div>`
              : html`<span class="lock">Incomplete</span>`)
            : html`<span class="muted">—</span>`}${u.role === 'sales' && u.active ? (tabOf(u.id) ? html`<div class="muted">Tab <a href="#/assets?q=${encodeURIComponent(tabOf(u.id).tab_no)}" class="mono">${tabOf(u.id).tab_no}</a></div>` : html`<div class="lock">No tab issued</div>`) : ''}</td>
          <td><div class="actions">
            <button class="btn-link" data-profile="${u.id}">Edit</button>
            <button class="btn-link" data-reset="${u.id}">Reset password</button>
            ${u.id !== state.user.id ? html`<button class="btn-link" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}
          </div></td></tr>`)}</tbody>
      </table></div></div>
      <form class="card" id="user-form">
        <h2>Add user</h2>
        ${contactFields({}, 'nu')}
        <div class="field-row"><label for="nu-role">Role</label><select id="nu-role" name="role" required>
          ${Object.entries(state.meta.assignable_roles || ROLE_LABEL).map(([k, l]) => html`<option value="${k}">${l}</option>`)}
        </select></div>
        ${regionField({}, 'nu')}
        <fieldset class="product-detail" id="nu-profile">
          <legend>Sales profile</legend>
          ${!leaders.length || !managers.length ? html`<p class="small error">Add at least one team leader and one sales manager first.</p>` : ''}
          ${profileFields({}, 'nu')}
        </fieldset>
        <div class="field-row"><label for="nu-password">Temporary password</label><input id="nu-password" name="password" type="text" minlength="8" required></div>
        <button class="btn-primary">Add user</button>
      </form>
    </div>`);

  // Filters narrow the list without reloading it.
  const rows = [...app.querySelectorAll('tr[data-user-row]')];
  const byId = new Map(users.map((u) => [u.id, u]));
  const applyFilters = () => {
    const q = document.getElementById('staff-q').value.trim().toLowerCase();
    const roleF = document.getElementById('staff-role').value;
    const regionF = document.getElementById('staff-region').value;
    const statusF = document.getElementById('staff-status').value;
    let shown = 0;
    for (const tr of rows) {
      const u = byId.get(Number(tr.dataset.userRow));
      const hay = [u.name, u.hrms_code, u.email, u.sales_code, u.team_leader_name, u.sales_manager_name].join(' ').toLowerCase();
      const ok = (!q || hay.includes(q)) && (!roleF || (u.role_key || u.role) === roleF) && (!regionF || u.region === regionF) && (!statusF || (statusF === 'active' ? u.active : !u.active));
      tr.hidden = !ok;
      if (tr.nextElementSibling?.dataset.profileEditor) tr.nextElementSibling.hidden = !ok;
      if (ok) shown++;
    }
    document.getElementById('staff-count').textContent = shown === users.length ? `${users.length} staff` : `${shown} of ${users.length} staff`;
  };
  ['staff-q', 'staff-role', 'staff-region', 'staff-status'].forEach((id) => (document.getElementById(id).oninput = applyFilters));
  applyFilters();
  if (document.getElementById('staff-csv')) document.getElementById('staff-csv').onclick = () => saveFile('staff-list.csv', toCsv([
    ['Name', 'HRMS code', 'Email', 'Role', 'Region', 'Local mobile', 'WhatsApp', 'Sales code', 'Team leader', 'Sales manager', 'ASM', 'Date of joining', 'Date of leaving', 'Status'],
    ...users.map((u) => [u.name, u.hrms_code || '', u.email, ROLE_LABEL[u.role_key || u.role] || u.role, u.region || '', u.mobile_number || '', u.whatsapp_number || '', u.sales_code || '', u.team_leader_name || '', u.sales_manager_name || '', u.asm_name || '', u.doj || '', u.dol || '', u.active ? 'Active' : 'Disabled']),
  ]));
  const form = document.getElementById('user-form');
  const role = document.getElementById('nu-role');
  const profile = document.getElementById('nu-profile');
  const baseRole = (k) => (state.meta.custom_roles || []).find((c) => c.key === k)?.base || k;
  const syncRole = () => {
    profile.hidden = baseRole(role.value) !== 'sales';
    profile.querySelectorAll('input, select').forEach((i) => (i.disabled = profile.hidden));
  };
  role.onchange = syncRole;
  syncRole();
  // Suggest first.last@<your domain> until the email is typed by hand.
  const nameInput = document.getElementById('nu-name');
  const emailInput = document.getElementById('nu-email');
  const domain = state.user.email.split('@')[1];
  let emailTouched = false;
  emailInput.addEventListener('input', () => { emailTouched = true; document.getElementById('nu-email-hint').hidden = true; });
  nameInput.addEventListener('input', () => {
    if (emailTouched || !domain) return;
    const parts = nameInput.value.toLowerCase().normalize('NFD').replace(/[^a-z\s'-]/g, '').replace(/['-]/g, '').trim().split(/\s+/).filter(Boolean);
    const local = parts.length > 1 ? `${parts[0]}.${parts[parts.length - 1]}` : parts[0] || '';
    emailInput.value = local ? `${local}@${domain}` : '';
    document.getElementById('nu-email-hint').hidden = !local;
  });
  wireWhatsappSame(form);
  form.onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: formData(form) });
      toast('User added');
      viewUsers();
    } catch (ex) { toast(ex.message, true); }
  };
  app.querySelectorAll('[data-profile]').forEach((b) => (b.onclick = () => {
    const u = users.find((x) => x.id === Number(b.dataset.profile));
    const row = app.querySelector(`[data-user-row="${u.id}"]`);
    if (row.nextElementSibling?.dataset.profileEditor) return;
    const tr = document.createElement('tr');
    tr.dataset.profileEditor = '1';
    tr.innerHTML = html`<td colspan="5"><form class="profile-editor">
      <strong>Edit ${u.name}</strong>
      <div class="form-grid two">${contactFields(u, `e${u.id}`)}${regionField(u, `e${u.id}`)}${u.id !== state.user.id ? html`<div class="field-row"><label for="e${u.id}-role">Role</label><select id="e${u.id}-role" name="role">${Object.entries({ ...(state.meta.assignable_roles || ROLE_LABEL), ...(u.role_key && !(state.meta.assignable_roles || {})[u.role_key] ? { [u.role_key]: ROLE_LABEL[u.role_key] } : {}) }).map(([k, l]) => html`<option value="${k}" ${(u.role_key || u.role) === k ? raw('selected') : ''}>${l}</option>`)}</select><div class="muted small">Moving to or from a sales role clears or needs the sales profile.</div></div>` : ''}</div>
      ${u.role === 'sales' ? html`<strong class="small">Sales profile</strong><div class="form-grid three">${profileFields(u, `e${u.id}`)}</div><p class="muted small">Changing the team leader, sales manager or ASM moves this person's open files to the new team. Completed and rejected files stay with the old team.</p>` : ''}
      <div class="actions"><button class="btn-primary">Save changes</button><button type="button" data-cancel>Cancel</button></div>
    </form></td>`.s;
    row.after(tr);
    const f = tr.querySelector('form');
    wireWhatsappSame(f);
    f.querySelector('[data-cancel]').onclick = () => tr.remove();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        const saved = await api(`/users/${u.id}`, { method: 'PATCH', body: formData(f) });
        toast(saved.moved_cases ? `User updated. ${saved.moved_cases} open ${saved.moved_cases === 1 ? 'file' : 'files'} moved to the new team.` : 'User updated');
        viewUsers();
      } catch (ex) { toast(ex.message, true); }
    };
  }));
  app.querySelectorAll('[data-toggle]').forEach((b) => (b.onclick = async () => {
    try {
      await api(`/users/${b.dataset.toggle}`, { method: 'PATCH', body: { active: b.dataset.active !== '1' } });
      viewUsers();
    } catch (ex) { toast(ex.message, true); }
  }));
  app.querySelectorAll('[data-reset]').forEach((b) => (b.onclick = () => {
    const form = document.createElement('form');
    form.className = 'actions';
    form.innerHTML = html`<input name="password" type="text" minlength="8" required placeholder="New password" aria-label="New password" style="width:160px">
      <button class="btn-primary">Save</button><button type="button" data-cancel>Cancel</button>`.s;
    const cell = b.closest('td');
    const original = [...cell.childNodes];
    cell.replaceChildren(form);
    form.querySelector('input').focus();
    form.querySelector('[data-cancel]').onclick = () => cell.replaceChildren(...original);
    form.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/users/${b.dataset.reset}`, { method: 'PATCH', body: formData(form) });
        toast('Password updated');
        cell.replaceChildren(...original);
      } catch (ex) { toast(ex.message, true); }
    };
  }));
}

window.addEventListener('hashchange', route);
setInterval(refreshCounters, 30000);
boot().then(() => { if (!state.user) renderLogin(); });
