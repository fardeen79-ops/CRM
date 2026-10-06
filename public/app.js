// Sourcing CRM — single-page frontend (no build step).
import { openEidScanner } from './eid-scan.js';

// Verification status (the processing team's calls). Case status is separate; see CASE_STATUS_LABEL.
const STATUS_LABEL = {
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
  sales_manager: 'Sales Manager', mis: 'MIS', business_head: 'Business Head', governance: 'Governance',
};
const ACTION_LABEL = {
  created: 'Case created',
  edited: 'Details edited',
  claim: 'Picked up for verification',
  release: 'Released back to queue',
  log_call: 'Call logged',
  complete: 'Verification completed',
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
  mark_qc: 'Marked for quality check',
  clear_qc: 'Removed from quality check',
  request_recording: 'Call recording requested',
  approve_recording: 'Recording request approved',
  decline_recording: 'Recording request declined',
  recording_it_email: 'IT emailed for the recording',
  receive_recording: 'Call recording received',
  set_complaint: 'Complaint number added',
  score_quality: 'Verification call scored',
};

const state = { user: null, meta: null, unread: 0, actionRequired: 0, editRequests: 0, qc: 0, recordings: 0, urgent: 0 };
const app = document.getElementById('app');

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

const label = (s) => String(s || '').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());
const badge = (status) => html`<span class="badge st-${status}">${STATUS_LABEL[status] || status}</span>`;
// Call-quality score bands (out of 10): 8.5+ good, 7–8.4 fair, below 7 needs attention.
const scoreClass = (n) => (n >= 8.5 ? 'good' : n >= 7 ? 'fair' : 'bad');
const RECORDING_CHIP = { pending_approval: ['Recording: awaiting approval', 'warn'], approved: ['Recording: with IT', ''], declined: ['Recording declined', 'bad'], received: ['Recording received', 'good'] };
const recordingChip = (st) => (RECORDING_CHIP[st] ? html`<span class="chip ${RECORDING_CHIP[st][1]}">${RECORDING_CHIP[st][0]}</span>` : '');
const STILL_VERIFYING = ['pending_verification', 'in_verification', 'incomplete', 'returned_to_sales'];
const isUrgent = (c) => c.urgent_flag === 1 && STILL_VERIFYING.includes(c.status);
const caseBadge = (status) => html`<span class="badge cs-${status}">${CASE_STATUS_LABEL[status] || status}</span>`;
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
        <p class="muted">Sign in with your work email. Your role decides what you see.</p>
        <div class="field-row"><label for="email">Email</label><input id="email" name="email" type="email" autocomplete="username" required autofocus></div>
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
    if (['team_leader', 'sales_manager', 'governance', 'business_head', 'processing'].includes(state.user.role)) {
      const s = await api('/stats');
      state.actionRequired = s.by_status.incomplete;
      state.editRequests = s.edit_requests;
      state.qc = s.governance?.qc ?? 0;
      state.urgent = s.governance?.urgent ?? 0;
      // Business heads see requests awaiting approval; governance sees ones waiting on IT.
      state.recordings = state.user.role === 'business_head' ? s.governance?.recordings_pending ?? 0 : s.governance?.recordings_with_it ?? 0;
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
  for (const [sel, n] of [['[data-qc-count]', state.qc], ['[data-rec-count]', state.recordings], ['[data-urgent-count]', state.urgent]]) {
    const el = document.querySelector(sel);
    if (el) { el.textContent = n; el.hidden = !n; }
  }
}

// ---------- shell ----------
function navLinks() {
  const r = state.user.role;
  const links = [['#/', 'Dashboard']];
  if (r === 'sales') links.push(['#/cases', 'My cases'], ['#/cases/new', '+ New case']);
  if (r === 'processing') links.push(['#/queue', 'Verification queue'], ['#/cases?assigned=me', 'My cases'], ['#/cases', 'All cases']);
  const editRequests = ['#/edit-requests', raw(`Edit requests<span class="count" data-er-count ${state.editRequests ? '' : 'hidden'}>${state.editRequests}</span>`)];
  if (r === 'team_leader') {
    links.push(['#/action-required', raw(`Action required<span class="count" data-ar-count ${state.actionRequired ? '' : 'hidden'}>${state.actionRequired}</span>`)]);
    links.push(editRequests, ['#/cases', 'All cases'], ['#/cases/new', '+ New case'], ['#/users', 'Users']);
  }
  if (r === 'sales_manager') links.push(editRequests, ['#/cases', 'All cases'], ['#/cases/new', '+ New case']);
  if (r === 'mis' || r === 'business_head') links.push(['#/cases', 'All cases']);
  const counted = (href, text, attr, n) => [href, raw(`${text}<span class="count" ${attr} ${n ? '' : 'hidden'}>${n}</span>`)];
  if (r === 'governance') {
    links.push(counted('#/urgent', 'Urgent', 'data-urgent-count', state.urgent), counted('#/quality-check', 'Quality check', 'data-qc-count', state.qc), counted('#/recordings', 'Recordings', 'data-rec-count', state.recordings), ['#/cases', 'All cases']);
  }
  if (r === 'processing' || r === 'team_leader') {
    links.splice(r === 'processing' ? 2 : 1, 0, counted('#/urgent', 'Urgent', 'data-urgent-count', state.urgent));
  }
  if (r === 'business_head') links.splice(1, 0, counted('#/recording-approvals', 'Recording approvals', 'data-rec-count', state.recordings));
  return links;
}

function shell(content) {
  const current = location.hash || '#/';
  app.innerHTML = html`
    <header class="topbar">
      <a class="brand" href="#/"><span class="logo">✓</span> Sourcing CRM</a>
      <nav class="nav">${navLinks().map(([href, text]) => html`<a href="${href}" class="${current === href ? 'active' : ''}">${text}</a>`)}</nav>
      <div class="user-box">
        <button class="bell btn-link" id="bell" aria-label="Notifications"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg><span class="dot" ${state.unread ? '' : 'hidden'}>${state.unread}</span></button>
        <div><div>${state.user.name}</div><div class="role-tag">${ROLE_LABEL[state.user.role]}</div></div>
        <button id="logout">Sign out</button>
      </div>
    </header>
    <div id="notif-panel"></div>
    <main>${content}</main>`.s;
  document.getElementById('logout').onclick = async () => {
    await api('/logout', { method: 'POST' }).catch(() => {});
    state.user = null;
    resetRoute();
    renderLogin();
  };
  document.getElementById('bell').onclick = toggleNotifications;
}

async function toggleNotifications() {
  const panel = document.getElementById('notif-panel');
  if (panel.innerHTML) { panel.innerHTML = ''; return; }
  const { items } = await api('/notifications');
  panel.innerHTML = html`
    <div class="dropdown">
      <div class="head"><strong>Notifications</strong><button class="btn-link" id="mark-all">Mark all read</button></div>
      ${items.length ? items.map((n) => html`
        <a class="item ${n.is_read ? '' : 'unread'}" href="${n.case_id ? `#/cases/${n.case_id}` : '#/'}" data-id="${n.id}">
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
    if (path === '/' || path === '') return await viewDashboard();
    if (path === '/cases/new') return viewCaseForm();
    if ((m = path.match(/^\/cases\/(\d+)\/edit$/))) return await viewCaseForm(Number(m[1]));
    if ((m = path.match(/^\/cases\/(\d+)$/))) return await viewCase(Number(m[1]));
    if (path === '/cases') return await viewCases({ title: state.user.role === 'sales' ? 'My cases' : params.get('assigned') === 'me' ? 'My cases' : 'All cases', params });
    if (path === '/queue') {
      return await viewCases({ title: 'Verification queue', subtitle: 'Call each customer to verify the sourced details, then mark the verification completed, pending or rejected.', params, fixedStatus: 'pending_verification,in_verification' });
    }
    if (path === '/action-required') {
      return await viewCases({ title: 'Action required', subtitle: 'Files the processing team marked Verification pending. Decide whether to return to sales, re-verify, or reject.', params, fixedStatus: 'incomplete' });
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
    if ((m = path.match(/^\/import\/(users|cases)$/))) return viewBulkUpload(m[1]);
    shell(html`<div class="card empty">Page not found</div>`);
  } catch (err) {
    if (state.user) shell(html`<div class="card"><p class="error">${err.message}</p></div>`);
  }
}

// ---------- dashboard ----------
async function viewDashboard() {
  const s = await api('/stats');
  const r = state.user.role;
  const by = s.by_status;
  const cs = s.by_case_status;
  const oversight = ['team_leader', 'sales_manager', 'mis', 'business_head', 'governance'].includes(r);

  const verifyTiles = [];
  if (r === 'team_leader') verifyTiles.push(['Action required', by.incomplete, '#/action-required', by.incomplete > 0]);
  if (['team_leader', 'sales_manager'].includes(r)) verifyTiles.push(['Edit requests', s.edit_requests, '#/edit-requests', s.edit_requests > 0]);
  if (['processing', 'team_leader'].includes(r)) verifyTiles.unshift(['Urgent verification', s.governance.urgent, '#/urgent', s.governance.urgent > 0]);
  if (r === 'processing') verifyTiles.push(['My open cases', s.my_queue, '#/cases?assigned=me']);
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
    <div class="card"><h2>Processing team</h2>
      ${miniTable(['Name', 'Calls', 'Verified', 'Pending', 'Rejected', 'QC avg'], s.processors.map((p) => [p.name, p.calls, p.completed, p.incomplete, p.rejected, p.qc_avg != null ? raw(`<span class="chip ${scoreClass(p.qc_avg)}">${p.qc_avg}</span>`) : '—']))}
    </div>
    <div class="card"><h2>Sales team</h2>
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

  shell(html`
    <div class="page-head dash-head">
      <div>
        <div class="eyebrow">${new Date().toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })} · ${ROLE_LABEL[r]}</div>
        <h1>Hello, ${state.user.name.split(' ')[0]}</h1>
        <p class="muted lede">${intro}</p>
      </div>
      ${['sales', 'team_leader', 'sales_manager'].includes(r) ? html`<div class="actions"><a class="btn" href="#/import/cases">Bulk upload</a><a class="btn btn-primary" href="#/cases/new">+ New case</a></div>` : ''}
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
    ${statusOverview(cs, s.total)}
    <h2 class="tiles-head">Verification</h2>
    ${tileGrid(verifyTiles)}
    ${oversight ? html`<div class="grid two-col"><div>${main}</div><div>${teamTables}</div></div>` : main}`);
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
  ref: ['Ref', (c) => html`<strong>${c.ref}</strong>`],
  customer: ['Customer', (c) => html`${c.customer_name}<div class="muted small">${[c.product_label, c.company_name || c.city].filter(Boolean).join(' · ')}</div>`],
  phone: ['Phone', (c) => c.phone],
  status: ['Verification', (c) => html`${badge(c.status)}${isUrgent(c) ? html` <span class="chip bad">Urgent</span>` : ''}`],
  case_status: ['Case status', (c) => caseBadge(c.case_status)],
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
    ${c.complaint_number ? html`<span class="chip bad">Complaint ${c.complaint_number}</span>` : ''}
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
};

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
  });
  const { cases } = await api(`/cases?${query}`);

  const r = state.user.role;
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
      ${['sales', 'team_leader', 'sales_manager'].includes(r) ? html`<div class="actions"><a class="btn" href="#/import/cases">Bulk upload</a><a class="btn btn-primary" href="#/cases/new">+ New case</a></div>` : ''}
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
async function viewCaseForm(id) {
  const c = id ? { ...(await api(`/cases/${id}`)).case } : { sourcing_date: todayLocal() };
  if (id && !c.first_name && c.customer_name) {
    // Cases created before names were split: prefill first / middle / last from the full name.
    const parts = c.customer_name.split(/\s+/);
    c.first_name = parts.shift();
    c.last_name = parts.pop() ?? '';
    c.middle_name = parts.join(' ');
  }
  const products = state.meta.products;
  const r = state.user.role;
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
  const otherBank = Boolean(c.buyout_bank) && !listedBanks.includes(c.buyout_bank);
  // Fields this viewer may not read; they can still type a replacement without seeing the old value.
  const hiddenFields = new Set(c.hidden_fields || []);
  const field = (name, text, { type = 'text', required = false, full = false, placeholder = '', attrs = '', hint = '' } = {}) => {
    const masked = hiddenFields.has(name);
    return html`
    <div class="${full ? 'full' : ''}">
      <label for="f-${name}">${text}${required ? raw(' <span class="req">*</span>') : ''}${masked ? raw(' <span class="lock">Hidden</span>') : ''}</label>
      ${type === 'textarea'
        ? html`<textarea id="f-${name}" name="${name}" placeholder="${placeholder}">${c[name] ?? ''}</textarea>`
        : html`<input id="f-${name}" name="${name}" type="${type}" value="${c[name] ?? ''}" placeholder="${masked ? 'Hidden. Type a new value only to replace it' : placeholder}" ${required ? raw('required') : ''} ${raw(attrs)} ${masked ? raw('data-masked') : ''}>`}
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
        <div id="scan-result"></div>
        <div class="form-grid three">
          ${field('first_name', 'First name', { required: true, attrs: 'autocomplete="off"' })}
          ${field('middle_name', 'Middle name', { attrs: 'autocomplete="off"' })}
          ${field('last_name', 'Last name', { required: true, attrs: 'autocomplete="off"' })}
          ${field('phone', 'Mobile number', { type: 'tel', required: true, placeholder: '+971 50 123 4567' })}
          ${field('eid_number', 'Emirates ID number', { placeholder: '784-YYYY-NNNNNNN-C', attrs: 'inputmode="numeric" pattern="784-?\\d{4}-?\\d{7}-?\\d" title="15 digits starting with 784, e.g. 784-1990-1234567-1"' })}
          ${field('passport_number', 'Passport number', { attrs: 'pattern="[A-Za-z0-9 ]{5,20}" title="5–20 letters and digits"' })}
          ${field('email', 'Email address', { type: 'email', placeholder: 'name@example.com', attrs: 'autocomplete="off"' })}
        </div>
      </section>

      <section>
        <h2>Employment</h2>
        <div class="form-grid">
          ${field('company_name', 'Company name', { placeholder: 'Employer' })}
          ${field('salary', 'Monthly salary (AED)', { type: 'number', attrs: money })}
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
              ${Object.entries(state.meta.regions).map(([k, l]) => html`<option value="${k}" ${c.region === k ? raw('selected') : ''}>${l}</option>`)}
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
              ${Object.entries(state.meta.core_products).map(([k, l]) => html`<option value="${k}" ${c.core_product === k ? raw('selected') : ''}>${l}</option>`)}
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
            <div class="form-grid">
              ${field('loan_amount', 'Loan amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-pl' })}
              ${field('interest_rate', 'Interest rate (%)', { type: 'number', required: true, placeholder: 'e.g. 5.99', attrs: 'inputmode="decimal" min="0" max="100" step="0.01" disabled data-pl' })}
            </div>
            <div class="form-grid" id="topup-fields" hidden>
              ${field('full_loan_amount', 'Full loan amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-topup', hint: 'Total loan after the top up' })}
              ${field('incremental_amount', 'Incremental amount (AED)', { type: 'number', required: true, attrs: money + ' disabled data-topup', hint: 'New money added by the top up' })}
            </div>
            <div id="bank-field" class="bank-field" hidden>
              <label for="f-buyout_bank">Buying out from which bank? <span class="req">*</span></label>
              <select id="f-buyout_bank" name="buyout_bank" required disabled>
                <option value="">Choose a bank…</option>
                ${state.meta.banks.map((g) => html`<optgroup label="${g.group}">
                  ${g.banks.map((b) => html`<option value="${b}" ${c.buyout_bank === b ? raw('selected') : ''}>${b}</option>`)}
                </optgroup>`)}
                <option value="${OTHER_BANK}" ${otherBank ? raw('selected') : ''}>Other bank (type the name)</option>
              </select>
              <input id="f-buyout_bank_other" name="buyout_bank_other" placeholder="Bank name" aria-label="Other bank name" value="${otherBank ? c.buyout_bank : ''}" required disabled hidden>
            </div>
          </fieldset>
          <div class="full" id="card-field" hidden>
            <label for="f-credit_card">Credit card <span class="req">*</span></label>
            <select id="f-credit_card" name="credit_card" required disabled>
              <option value="">Choose a card…</option>
              ${state.meta.credit_cards.map((f) => html`<optgroup label="${f.family}">
                ${f.cards.map((card) => html`<option value="${card}" ${c.credit_card === card ? raw('selected') : ''}>${card}</option>`)}
              </optgroup>`)}
            </select>
          </div>
        </div>
      </section>

      <details class="more" ${[c.alt_phone, c.address, c.city, c.source, c.sales_notes].some(Boolean) ? raw('open') : ''}>
        <summary>More details (optional)</summary>
        <div class="form-grid">
          ${field('alt_phone', 'Alternate phone', { type: 'tel' })}
          ${field('address', 'Address', { full: true })}
          ${field('city', 'City')}
          ${field('source', 'Lead source', { placeholder: 'e.g. Referral, Walk-in, Field visit' })}
          ${field('sales_notes', 'Notes for the processing team', { type: 'textarea', full: true, placeholder: 'Best time to call, language preference, anything to verify…' })}
        </div>
      </details>

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
  const bankSelect = $('#f-buyout_bank');
  const bankOther = $('#f-buyout_bank_other');
  const cardField = $('#card-field');
  const cardSelect = $('#f-credit_card');
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
    bankField.hidden = loanField.hidden || loanType !== 'buy_out';
    bankSelect.disabled = bankField.hidden;
    bankOther.hidden = bankOther.disabled = bankField.hidden || bankSelect.value !== OTHER_BANK;
    cardField.hidden = !includes('credit_card');
    cardSelect.disabled = cardField.hidden;
    checkIncrement();
  };
  const checkIncrement = () => {
    const over = !increment.disabled && fullAmount.value && increment.value && Number(increment.value) > Number(fullAmount.value);
    increment.setCustomValidity(over ? 'Incremental amount cannot be more than the full loan amount' : '');
  };
  // Suggest the core product from the product until the user picks one themselves.
  const coreSelect = $('#f-core_product');
  let coreTouched = Boolean(c.core_product);
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
    };
  }
  boxes.forEach((b) => (b.onchange = updateProductFields));
  loanRadios.forEach((r) => (r.onchange = updateProductFields));
  bankSelect.onchange = () => { updateProductFields(); if (!bankOther.hidden) bankOther.focus(); };
  fullAmount.oninput = increment.oninput = checkIncrement;
  // Show the Emirates ID in its usual 784-YYYY-NNNNNNN-C layout once typed.
  const eid = $('#f-eid_number');
  eid.onblur = () => {
    const d = eid.value.replace(/\D/g, '');
    if (/^784\d{12}$/.test(d)) eid.value = `${d.slice(0, 3)}-${d.slice(3, 7)}-${d.slice(7, 14)}-${d.slice(14)}`;
  };
  updateProductFields();

  // Emirates ID scan: fills the name and ID number for the sales person to check.
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
      <strong>Filled from the ${result.side} of the Emirates ID: name and Emirates ID number.</strong>
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
    try {
      const body = formData(form);
      body.bundle_products = body.product === 'bundle' ? new FormData(form).getAll('bundle_products') : [];
      for (const f of ['credit_card', 'personal_loan_type', 'loan_amount', 'interest_rate', 'full_loan_amount', 'incremental_amount']) body[f] ??= null;
      // Leave hidden values untouched unless a replacement was typed.
      form.querySelectorAll('[data-masked]').forEach((i) => { if (!i.value.trim()) delete body[i.name]; });
      body.buyout_bank = body.buyout_bank === OTHER_BANK ? body.buyout_bank_other?.trim() : body.buyout_bank ?? null;
      delete body.buyout_bank_other;
      if (scanned) body.eid_scanned = scanned;
      const res = id ? await api(`/cases/${id}`, { method: 'PUT', body }) : await api('/cases', { method: 'POST', body });
      if (resubmit) await api(`/cases/${id}/actions`, { method: 'POST', body: { action: 'resubmit' } });
      toast(id ? (resubmit ? 'Saved and resubmitted for verification' : 'Changes saved') : `${res.case.ref} submitted for verification`);
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
  if (e.type === 'created' || e.type === 'case_status') return CASE_STATUS_LABEL[e.detail] || label(e.detail);
  if (e.type === 'request_edit' || e.type === 'resolve_edit_request') return `${state.meta.edit_queues[e.detail] || label(e.detail)} queue`;
  if (e.type === 'score_quality') return `${e.detail}/10`;
  if (e.type === 'set_complaint' || e.type === 'receive_recording' || e.type === 'recording_it_email') return e.detail;
  return label(e.detail);
}

async function viewCase(id) {
  const { case: c } = await api(`/cases/${id}`);
  // A detail row; ID-style values use a monospace face so digits are easy to read back on a call.
  const hiddenFields = new Set(c.hidden_fields || []);
  const row = (dt, value, mono = false, field = null) => (field && hiddenFields.has(field)
    ? html`<dt>${dt}</dt><dd><span class="lock">Hidden</span></dd>`
    : html`<dt>${dt}</dt><dd class="${mono && value ? 'mono' : ''}">${value || '—'}</dd>`);
  const a = new Set(c.allowed_actions);
  const meta = state.meta;

  let banner = '';
  if (c.status === 'incomplete') {
    banner = html`<div class="callout danger"><strong>Verification pending — waiting for team leader action (${ago(c.incomplete_at)})</strong>
      ${label(c.incomplete_reason)}${c.incomplete_note ? `: ${c.incomplete_note}` : ''} <span class="muted">— ${c.assigned_to_name}</span></div>`;
  } else if (c.status === 'returned_to_sales') {
    banner = html`<div class="callout info"><strong>Returned to sales by ${c.tl_actioned_by_name}</strong>${c.tl_note}
      ${c.incomplete_reason ? html`<div class="muted small">Original issue: ${label(c.incomplete_reason)}${c.incomplete_note ? ` — ${c.incomplete_note}` : ''}</div>` : ''}</div>`;
  } else if (c.status === 'completed') {
    banner = html`<div class="callout success"><strong>Verification completed by ${c.verified_by_name} on ${fmtDate(c.verified_at)}</strong>
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
      <form data-form="log_call">
        <div class="field-row"><select name="outcome" required>
          <option value="">Call outcome…</option>
          ${meta.call_outcomes.map((o) => html`<option value="${o}">${label(o)}</option>`)}
        </select></div>
        <div class="field-row"><textarea name="note" placeholder="What did the customer say?"></textarea></div>
        <button>Log call</button>
      </form>`);
  }
  if (a.has('complete') || a.has('mark_incomplete') || a.has('reject_verification')) {
    panel.push(html`<hr><h3>Verification result</h3>
      <form data-form="verification" id="verification-form">
        <div class="segmented three-up" role="radiogroup" aria-label="Verification result">
          <label><input type="radio" name="result" value="complete" required><span>Completed</span></label>
          <label><input type="radio" name="result" value="mark_incomplete"><span>Pending</span></label>
          <label><input type="radio" name="result" value="reject_verification"><span>Rejected</span></label>
        </div>
        <p class="muted small" id="vr-hint">Choose the outcome of your verification call.</p>
        <div class="field-row" id="vr-reason" hidden><select name="reason" disabled>
          <option value="">Reason…</option>
          ${meta.incomplete_reasons.map((o) => html`<option value="${o}">${label(o)}</option>`)}
        </select></div>
        <div class="field-row"><textarea name="note" placeholder="Verification notes"></textarea></div>
        <button class="btn-primary">Save verification result</button>
      </form>`);
  }
  if (a.has('release')) panel.push(html`<hr><button data-action="release">Release back to queue</button>`);
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
      </form>`);
  }
  if (a.has('set_case_status')) {
    const choices = state.meta.settable_case_statuses.filter((k) => k !== c.case_status);
    panel.push(html`${panel.length ? raw('<hr>') : ''}<h3>Case status</h3>
      <p class="small">Now: ${caseBadge(c.case_status)}</p>
      <form data-form="set_case_status">
        <div class="field-row"><label for="cs-select" class="sr-only">New case status</label>
          <select id="cs-select" name="case_status" required>
            <option value="">Change status to…</option>
            ${choices.map((k) => html`<option value="${k}">${CASE_STATUS_LABEL[k]}</option>`)}
          </select></div>
        <div class="field-row"><textarea name="note" id="cs-note" placeholder="Note (required for Applicant review and Rejected)"></textarea></div>
        <div class="actions">
          <button class="btn-primary">Update status</button>
          ${c.case_status !== 'completed' ? html`<button type="button" class="btn-success" data-case-complete>✓ Mark case completed</button>` : ''}
        </div>
      </form>
      ${c.status === 'completed' && c.case_status !== 'completed' ? html`<p class="muted small">Verification is completed, but the case is not. Mark the case completed when it is done.</p>` : ''}`);
  }

  shell(html`
    <div class="page-head">
      <div><a href="#/" class="small" id="back-link">← Back</a>
        <h1>${c.customer_name} <span class="muted" style="font-weight:400">${c.ref}</span></h1>
        <div class="badges">${caseBadge(c.case_status)} ${badge(c.status)} <span class="muted small">Sourced by ${c.sales_staff_name || c.created_by_name}${c.region ? ` · ${c.region}` : ''} on ${fmtDay(c.sourcing_date)}</span></div>
      </div>
    </div>
    ${isUrgent(c) ? html`<div class="callout danger"><strong>Urgent verification — flagged by ${c.urgent_by_name} ${ago(c.urgent_at)}</strong>${c.urgent_note}</div>` : ''}
    ${c.case_status === 'applicant_review' ? html`<div class="callout warn"><strong>Applicant review${c.case_status_by_name ? ` — set by ${c.case_status_by_name} ${ago(c.case_status_at)}` : ''}</strong>${c.case_status_note || ''}</div>` : ''}
    ${c.edit_request_to ? html`<div class="callout info"><strong>Edit request in the ${state.meta.edit_queues[c.edit_request_to]} queue — from ${c.edit_request_by_name} ${ago(c.edit_request_at)}</strong>${c.edit_request_note}</div>` : ''}
    ${banner}
    <div class="grid two-col">
      <div>
        <div class="card">
          <h2>Customer</h2>
          ${hiddenFields.size ? html`<p class="muted small">Company, salary, Emirates ID and passport details are hidden for your role${state.user.role === 'processing' ? ' once verification is completed or rejected' : ''}.</p>` : ''}
          <dl class="details">
            <dt>Mobile</dt><dd><a class="phone-link" href="tel:${c.phone.replace(/[^\d+]/g, '')}">${c.phone}</a></dd>
            ${c.alt_phone ? html`<dt>Alternate phone</dt><dd><a href="tel:${c.alt_phone.replace(/[^\d+]/g, '')}">${c.alt_phone}</a></dd>` : ''}
            ${row('Emirates ID', c.eid_number, true, 'eid_number')}
            ${row('Passport number', c.passport_number, true, 'passport_number')}
            ${row('Company', c.company_name, false, 'company_name')}
            ${row('Monthly salary', c.salary != null ? `AED ${fmtAmount(c.salary)}` : null, false, 'salary')}
            ${row('Bidaya ID', c.bidaya_id, true)}
            ${row('App ID', c.app_id, true)}
            ${row('Email', c.email)}
            ${row('Address', [c.address, c.city].filter(Boolean).join(', '))}
          </dl>
          <h2 class="sub">Product</h2>
          <dl class="details">
            ${row('Core product', state.meta.core_products[c.core_product])}
            <dt>Product</dt><dd>${c.product === 'bundle'
              ? html`<strong>Bundle</strong><ul class="bundle-list">${c.bundle_products.split(',').map((p) => html`<li>${state.meta.products[p] || p}</li>`)}</ul>`
              : state.meta.products[c.product] || c.product || '—'}</dd>
            ${c.personal_loan_type ? html`<dt>Personal loan type</dt><dd><strong>${state.meta.personal_loan_types[c.personal_loan_type]}</strong></dd>` : ''}
            ${c.loan_amount != null ? html`<dt>Loan amount</dt><dd><strong>AED ${fmtAmount(c.loan_amount)}</strong></dd>` : ''}
            ${c.interest_rate != null ? html`<dt>Interest rate</dt><dd><strong>${c.interest_rate}%</strong></dd>` : ''}
            ${c.full_loan_amount != null ? html`<dt>Full loan amount</dt><dd>AED ${fmtAmount(c.full_loan_amount)}</dd>` : ''}
            ${c.incremental_amount != null ? html`<dt>Incremental amount</dt><dd>AED ${fmtAmount(c.incremental_amount)}</dd>` : ''}
            ${c.buyout_bank ? html`<dt>Buy-out from</dt><dd><strong>${c.buyout_bank}</strong></dd>` : ''}
            ${c.credit_card ? html`<dt>Credit card</dt><dd><strong>${c.credit_card}</strong></dd>` : ''}
            ${c.amount != null ? html`<dt>Amount</dt><dd>${fmtAmount(c.amount)}</dd>` : ''}
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
            <dt>Complaint number</dt><dd>${c.complaint_number ? html`<strong class="mono">${c.complaint_number}</strong><div class="muted small">${c.complaint_by_name} · ${fmtDate(c.complaint_at)}</div>` : '—'}</dd>
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
  document.getElementById('back-link').onclick = (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  };
  app.querySelectorAll('[data-action]').forEach((b) => (b.onclick = () => run({ action: b.dataset.action }, b)));
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
  app.querySelectorAll('[data-case-complete]').forEach((b) => (b.onclick = () => run({ action: 'set_case_status', case_status: 'completed' }, b)));
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
        mark_incomplete: 'You could not finish. Your team leader is alerted to return it to sales, re-verify or reject.',
        reject_verification: 'The customer or details failed verification. Sales and team leaders are told.',
      };
      f.querySelectorAll('input[name=result]').forEach((r) => (r.onchange = () => {
        reasonRow.hidden = reason.disabled = r.value === 'complete';
        reason.required = r.value === 'mark_incomplete';
        note.required = r.value !== 'complete';
        note.placeholder = r.value === 'complete' ? 'Verification notes (optional)' : 'Explain why (required)';
        hint.textContent = hints[r.value];
      }));
      f.onsubmit = (e) => {
        e.preventDefault();
        const { result, ...rest } = formData(f);
        run({ action: result, ...rest }, f.querySelector('button.btn-primary'));
      };
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

// ---------- bulk upload ----------
const BULK = {
  users: {
    title: 'Bulk upload users',
    lede: 'Add many users at once from a spreadsheet. Team leaders and sales managers in the file are added first, so sales staff in the same file can name them.',
    template: 'users-upload-template.csv',
    back: ['#/users', 'Back to users'],
    roles: ['team_leader'],
  },
  cases: {
    title: 'Bulk upload cases',
    lede: 'Add many sourced files at once from a spreadsheet. Every row is checked with the same rules as the New case form and starts as Sent to checker, awaiting verification.',
    template: 'cases-upload-template.csv',
    back: ['#/cases', 'Back to cases'],
    roles: ['sales', 'team_leader', 'sales_manager'],
  },
};

function viewBulkUpload(kind) {
  const cfg = BULK[kind];
  if (!cfg.roles.includes(state.user.role)) throw new Error('You do not have permission to do that');
  const columns = state.meta.import_columns[kind];
  const ownCases = kind === 'cases' && state.user.role === 'sales';
  const required = (c) => c.required && !(ownCases && c.key === 'sales_code');
  let file = null;

  shell(html`
    <div class="page-head">
      <div><a class="small" href="${cfg.back[0]}">← ${cfg.back[1]}</a><h1>${cfg.title}</h1><p class="muted lede">${cfg.lede}</p></div>
    </div>
    <div class="bulk-steps">
      <section class="card">
        <div class="step-head"><span class="step-no">1</span><div><h2>Download the template</h2>
          <p class="muted small">One row per ${kind === 'users' ? 'user' : 'file'}, up to ${state.meta.import_max_rows} rows. Keep the header row as it is.</p></div></div>
        <div class="actions"><button class="btn-primary" id="dl-template">Download template (.csv)</button><button id="dl-example">Download with example row</button></div>
        <div class="callout info small bulk-tip"><strong>Using Excel?</strong>Before typing, select the phone${kind === 'cases' ? ', Emirates ID and App ID' : ''} columns and set them to <em>Text</em> (Format Cells → Text) so Excel keeps leading zeros and long numbers. Save with <em>File → Save As → CSV UTF-8</em>.</div>
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
    const nameCols = (kind === 'users' ? ['fullname', 'email'] : ['firstname', 'middlename', 'lastname']).map(at).filter((i) => i >= 0);
    rowLabel = (cells = []) => nameCols.map((i) => cells[i]).filter(Boolean).join(kind === 'users' ? ' · ' : ' ') || '—';
    const failed = r.rows.filter((x) => !x.ok);
    const passwords = r.rows.filter((x) => x.temp_password);
    const summary = r.dry_run
      ? (r.failed
        ? html`<div class="callout warn"><strong>${r.ok} of ${r.total} rows are ready. ${r.failed} ${r.failed === 1 ? 'has' : 'have'} errors.</strong>Fix them and check again, or upload the ${r.ok} good rows now and the rest later.</div>`
        : html`<div class="callout success"><strong>All ${r.total} rows are ready to upload.</strong>Nothing has been saved yet.</div>`)
      : html`<div class="callout ${r.failed ? 'warn' : 'success'}"><strong>Added ${r.ok} ${kind === 'users' ? (r.ok === 1 ? 'user' : 'users') : (r.ok === 1 ? 'file' : 'files')}.${r.failed ? ` ${r.failed} ${r.failed === 1 ? 'row was' : 'rows were'} skipped.` : ''}</strong>${r.failed ? 'Download the skipped rows, fix them and upload that file.' : kind === 'cases' ? 'They are in the verification queue as Sent to checker.' : 'They can sign in now.'}</div>`;
    result.innerHTML = html`
      <div class="bulk-summary">
        <div class="kpi-mini"><span>${r.total}</span>rows</div>
        <div class="kpi-mini good"><span>${r.ok}</span>${r.dry_run ? 'ready' : 'added'}</div>
        <div class="kpi-mini ${r.failed ? 'bad' : ''}"><span>${r.failed}</span>${r.dry_run ? 'with errors' : 'skipped'}</div>
      </div>
      ${summary}
      ${r.ignored_columns?.length ? html`<p class="small muted">Ignored columns not in the template: ${r.ignored_columns.join(', ')}</p>` : ''}
      ${passwords.length ? html`<div class="callout info"><strong>Temporary passwords were generated for ${passwords.length} ${passwords.length === 1 ? 'user' : 'users'}.</strong>Download the sign-in details now; they are not shown again.</div>` : ''}
      <div class="actions" style="margin-bottom:12px">
        ${r.dry_run && r.ok ? html`<button class="btn-primary" id="bulk-go">Upload ${r.ok} ${r.ok === 1 ? 'row' : 'rows'}${r.failed ? ' and skip the rest' : ''}</button>` : ''}
        ${failed.length ? html`<button id="bulk-errors">Download rows with errors</button>` : ''}
        ${passwords.length ? html`<button class="btn-primary" id="bulk-passwords">Download sign-in details</button>` : ''}
        ${!r.dry_run ? html`<a class="btn" href="${cfg.back[0]}">${kind === 'users' ? 'View users' : 'View cases'}</a>` : ''}
      </div>
      <div class="table-wrap bulk-rows"><table>
        <thead><tr><th>Line</th><th>Result</th><th>${kind === 'users' ? 'User' : 'Customer'}</th><th>Details</th></tr></thead>
        <tbody>${[...failed, ...r.rows.filter((x) => x.ok)].map((x) => html`<tr>
          <td class="mono">${x.line}</td>
          <td>${x.ok ? html`<span class="chip good">${r.dry_run ? 'Ready' : 'Added'}</span>` : html`<span class="chip bad">Error</span>`}</td>
          <td>${x.ok ? (x.ref ? html`<a href="#/cases/${x.id}"><strong class="mono">${x.ref}</strong></a> ` : '') : ''}${x.ok ? x.label : rowLabel(x.cells)}</td>
          <td class="small">${x.ok ? (x.temp_password ? html`Temporary password <code>${x.temp_password}</code>` : x.email || '') : html`<span class="error">${x.error}</span>`}</td>
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
    if (pw) pw.onclick = () => saveFile('new-user-sign-in-details.csv', toCsv([['Name and role', 'Email', 'Temporary password'], ...passwords.map((x) => [x.label, x.email, x.temp_password])]));
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

// ---------- users (team leader) ----------
async function viewUsers() {
  const { users } = await api('/users');
  const leaders = users.filter((u) => u.role === 'team_leader' && u.active);
  const managers = users.filter((u) => u.role === 'sales_manager' && u.active);
  const options = (list, selected) => list.map((u) => html`<option value="${u.id}" ${u.id === selected ? raw('selected') : ''}>${u.name}</option>`);
  // Sales code, team leader and sales manager; these pre-fill the Sales staff section of every file.
  const profileFields = (u = {}, prefix = 'n') => html`
    <div class="field-row"><label for="${prefix}-code">Sales code <span class="req">*</span></label>
      <input id="${prefix}-code" name="sales_code" value="${u.sales_code || ''}" placeholder="e.g. DXB-S-014" required></div>
    <div class="field-row"><label for="${prefix}-tl">Team leader <span class="req">*</span></label>
      <select id="${prefix}-tl" name="team_leader_id" required><option value="">Choose…</option>${options(leaders, u.team_leader_id)}</select></div>
    <div class="field-row"><label for="${prefix}-sm">Sales manager <span class="req">*</span></label>
      <select id="${prefix}-sm" name="sales_manager_id" required><option value="">Choose…</option>${options(managers, u.sales_manager_id)}</select></div>`;

  // Email, local mobile and WhatsApp for any user.
  const contactFields = (u = {}, prefix = 'n') => html`
    <div class="field-row"><label for="${prefix}-name">Full name <span class="req">*</span></label>
      <input id="${prefix}-name" name="name" value="${u.name || ''}" autocomplete="off" required></div>
    <div class="field-row"><label for="${prefix}-email">Email address <span class="req">*</span></label>
      <input id="${prefix}-email" name="email" type="email" value="${u.email || ''}" autocomplete="off" required>
      ${prefix === 'nu' ? html`<div class="muted small" id="nu-email-hint" hidden>Suggested from the name. Change it if their address is different.</div>` : ''}</div>
    <div class="field-row"><label for="${prefix}-mobile">Local mobile <span class="req">*</span></label>
      <input id="${prefix}-mobile" name="mobile_number" type="tel" inputmode="tel" value="${fmtMobile(u.mobile_number)}" placeholder="050 123 4567" required></div>
    <div class="field-row"><label for="${prefix}-wa">WhatsApp number</label>
      <input id="${prefix}-wa" name="whatsapp_number" type="tel" inputmode="tel" value="${u.whatsapp_number || ''}" placeholder="+971 50 123 4567">
      <label class="check small wa-same"><input type="checkbox" data-wa-same> Same as local mobile</label></div>`;
  const contactCell = (u) => html`${u.mobile_number ? html`<div class="mono">${fmtMobile(u.mobile_number)}</div>` : html`<span class="muted">—</span>`}
    ${u.whatsapp_number ? html`<a class="wa" href="https://wa.me/${u.whatsapp_number.slice(1)}" target="_blank" rel="noopener" title="Open a WhatsApp chat">WhatsApp ${u.whatsapp_number}</a>` : ''}`;

  shell(html`
    <div class="page-head"><div><h1>Users</h1><p class="muted" style="margin:0">Add sales staff, processors, team leaders, sales managers, MIS and business heads. Each sales person's code, team leader and sales manager fill in automatically on the files they source.</p></div>
      <a class="btn" href="#/import/users">Bulk upload users</a></div>
    <div class="grid two-col">
      <div class="card"><div class="table-wrap"><table class="users-table">
        <thead><tr><th>Name</th><th>Contact</th><th>Role</th><th>Sales profile</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr style="cursor:default" data-user-row="${u.id}">
          <td>${u.name}${u.active ? '' : html` <span class="chip">Disabled</span>`}<div class="muted small"><a href="mailto:${u.email}">${u.email}</a></div></td><td class="small">${contactCell(u)}</td><td>${ROLE_LABEL[u.role]}</td>
          <td class="small">${u.role === 'sales'
            ? (u.sales_code
              ? html`<strong class="mono">${u.sales_code}</strong><div class="muted">TL: ${u.team_leader_name || '—'}<br>SM: ${u.sales_manager_name || '—'}</div>`
              : html`<span class="lock">Incomplete</span>`)
            : html`<span class="muted">—</span>`}</td>
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
          ${Object.entries(ROLE_LABEL).map(([k, l]) => html`<option value="${k}">${l}</option>`)}
        </select></div>
        <fieldset class="product-detail" id="nu-profile">
          <legend>Sales profile</legend>
          ${!leaders.length || !managers.length ? html`<p class="small error">Add at least one team leader and one sales manager first.</p>` : ''}
          ${profileFields({}, 'nu')}
        </fieldset>
        <div class="field-row"><label for="nu-password">Temporary password</label><input id="nu-password" name="password" type="text" minlength="8" required></div>
        <button class="btn-primary">Add user</button>
      </form>
    </div>`);

  const form = document.getElementById('user-form');
  const role = document.getElementById('nu-role');
  const profile = document.getElementById('nu-profile');
  const syncRole = () => {
    profile.hidden = role.value !== 'sales';
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
      <div class="form-grid two">${contactFields(u, `e${u.id}`)}</div>
      ${u.role === 'sales' ? html`<strong class="small">Sales profile</strong><div class="form-grid three">${profileFields(u, `e${u.id}`)}</div>` : ''}
      <div class="actions"><button class="btn-primary">Save changes</button><button type="button" data-cancel>Cancel</button></div>
    </form></td>`.s;
    row.after(tr);
    const f = tr.querySelector('form');
    wireWhatsappSame(f);
    f.querySelector('[data-cancel]').onclick = () => tr.remove();
    f.onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api(`/users/${u.id}`, { method: 'PATCH', body: formData(f) });
        toast('User updated');
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
