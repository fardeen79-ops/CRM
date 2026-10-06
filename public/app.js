// Sourcing CRM — single-page frontend (no build step).

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
  sent_to_check: 'Sent to check',
  applicant_review: 'Applicant review',
  completed: 'Completed',
  rejected: 'Rejected',
};
const OTHER_BANK = '__other';
const ROLE_LABEL = {
  sales: 'Sales', processing: 'Processing', team_leader: 'Team Leader',
  sales_manager: 'Sales Manager', mis: 'MIS', business_head: 'Business Head',
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
};

const state = { user: null, meta: null, unread: 0, actionRequired: 0, editRequests: 0 };
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
        <p class="muted">Sales, processing and team leaders sign in here.</p>
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
    if (['team_leader', 'sales_manager'].includes(state.user.role)) {
      const s = await api('/stats');
      state.actionRequired = s.by_status.incomplete;
      state.editRequests = s.edit_requests;
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
  return links;
}

function shell(content) {
  const current = location.hash || '#/';
  app.innerHTML = html`
    <header class="topbar">
      <a class="brand" href="#/"><span class="logo">✓</span> Sourcing CRM</a>
      <nav class="nav">${navLinks().map(([href, text]) => html`<a href="${href}" class="${current === href ? 'active' : ''}">${text}</a>`)}</nav>
      <div class="user-box">
        <button class="bell btn-link" id="bell" aria-label="Notifications">🔔<span class="dot" ${state.unread ? '' : 'hidden'}>${state.unread}</span></button>
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
    if (path === '/users') return await viewUsers();
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
  const oversight = ['team_leader', 'sales_manager', 'mis', 'business_head'].includes(r);

  const caseTiles = Object.entries(CASE_STATUS_LABEL).map(([k, l]) => [l, cs[k], `#/cases?case_status=${k}`, k === 'applicant_review' && cs[k] > 0]);
  caseTiles.push(['Total files', s.total, '#/cases']);
  const verifyTiles = [];
  if (r === 'team_leader') verifyTiles.push(['Action required', by.incomplete, '#/action-required', by.incomplete > 0]);
  if (['team_leader', 'sales_manager'].includes(r)) verifyTiles.push(['Edit requests', s.edit_requests, '#/edit-requests', s.edit_requests > 0]);
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
    sales: 'Add the customers you source; each file goes in as Sent to check. If a file moves to Applicant review, send an edit request to your team leader or sales manager.',
    processing: 'Work through the verification queue: call the customer, log each attempt, and mark the verification completed, pending or rejected. Completing the verification does not complete the case; mark the case completed separately.',
    team_leader: 'Pending verifications and edit requests need you. You can also set any case status.',
    sales_manager: 'Make the changes sales ask for in edit requests, and keep case statuses up to date.',
    mis: 'Track every sourced file and update its case status: Applicant review, Completed or Rejected.',
    business_head: 'Sourcing, verification and case outcomes across the team. You can update any case status.',
  }[r];

  const teamTables = oversight ? html`
    <div class="card"><h2>Processing team</h2>
      ${miniTable(['Name', 'Calls', 'Verified', 'Pending', 'Rejected'], s.processors.map((p) => [p.name, p.calls, p.completed, p.incomplete, p.rejected]))}
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
  } else if (r === 'mis' || r === 'business_head') {
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

  const tileGrid = (tiles) => html`<div class="grid stats">
    ${tiles.map(([l, v, href, alert]) => html`<a class="card stat ${alert ? 'alert' : ''}" href="${href}"><div class="label">${l}</div><div class="value">${v ?? 0}</div></a>`)}
  </div>`;

  shell(html`
    <div class="page-head">
      <div><h1>Hello, ${state.user.name.split(' ')[0]}</h1><p class="muted" style="margin:0">${intro}</p></div>
      ${['sales', 'team_leader', 'sales_manager'].includes(r) ? html`<a class="btn btn-primary" href="#/cases/new">+ New case</a>` : ''}
      ${r === 'processing' ? html`<a class="btn btn-primary" href="#/queue">Open verification queue</a>` : ''}
    </div>
    <h2 class="tiles-head">Case status</h2>
    ${tileGrid(caseTiles)}
    <h2 class="tiles-head">Verification</h2>
    ${tileGrid(verifyTiles)}
    ${oversight ? html`<div class="grid two-col"><div>${main}</div><div>${teamTables}</div></div>` : main}`);
  bindRows();
}

function miniTable(head, rows) {
  if (!rows.length) return html`<p class="muted">No users yet.</p>`;
  return html`<table><thead><tr>${head.map((h) => html`<th>${h}</th>`)}</tr></thead>
    <tbody>${rows.map((r) => html`<tr style="cursor:default">${r.map((c) => html`<td>${c ?? 0}</td>`)}</tr>`)}</tbody></table>`;
}

// ---------- case list ----------
const COLS = {
  ref: ['Ref', (c) => html`<strong>${c.ref}</strong>`],
  customer: ['Customer', (c) => html`${c.customer_name}<div class="muted small">${[c.product_label, c.company_name || c.city].filter(Boolean).join(' · ')}</div>`],
  phone: ['Phone', (c) => c.phone],
  status: ['Verification', (c) => badge(c.status)],
  case_status: ['Case status', (c) => caseBadge(c.case_status)],
  sourced: ['Sourced', (c) => html`<span class="small nowrap">${fmtDay(c.sourcing_date)}</span>`],
  cs_note: ['Status note', (c) => html`${c.case_status_note || ''}<div class="muted small">${c.case_status_by_name || ''}</div>`],
  request: ['Edit request', (c) => (c.edit_request_to
    ? html`${c.edit_request_note}<div class="muted small">${c.edit_request_by_name} → ${state.meta.edit_queues[c.edit_request_to]} queue</div>`
    : html`<span class="muted">—</span>`)],
  req_waiting: ['Waiting', (c) => ago(c.edit_request_at)],
  source_by: ['Sourced by', (c) => c.created_by_name],
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
  let cols = fixedCols || ['ref', 'customer', 'sourced', 'case_status', 'status', 'source_by', 'assigned', 'updated'];
  if (!fixedCols && r === 'sales') cols = ['ref', 'customer', 'sourced', 'case_status', 'status', 'updated'];
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
    </div>
    <div class="card">
      <div class="toolbar">
        <form id="search-form" style="display:flex;gap:8px;flex:1;min-width:240px">
          <input type="search" name="q" placeholder="Search name, mobile, Emirates ID, passport, Bidaya / App ID or ref…" value="${q}">
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
  const bundled = new Set(String(c.bundle_products || '').split(',').filter(Boolean));
  const listedBanks = state.meta.banks.flatMap((g) => g.banks);
  const otherBank = Boolean(c.buyout_bank) && !listedBanks.includes(c.buyout_bank);
  const field = (name, text, { type = 'text', required = false, full = false, placeholder = '', attrs = '', hint = '' } = {}) => html`
    <div class="${full ? 'full' : ''}">
      <label for="f-${name}">${text}${required ? raw(' <span class="req">*</span>') : ''}</label>
      ${type === 'textarea'
        ? html`<textarea id="f-${name}" name="${name}" placeholder="${placeholder}">${c[name] ?? ''}</textarea>`
        : html`<input id="f-${name}" name="${name}" type="${type}" value="${c[name] ?? ''}" placeholder="${placeholder}" ${required ? raw('required') : ''} ${raw(attrs)}>`}
      ${hint ? html`<div class="muted small">${hint}</div>` : ''}
    </div>`;
  const money = 'inputmode="decimal" min="0" step="any"';

  shell(html`
    <div class="page-head"><div>
      <h1>${id ? `Edit ${c.ref}` : 'New sourcing case'}</h1>
      <p class="muted" style="margin:0">${id ? 'Update the customer details, then save.' : 'Enter the customer you sourced. The file is saved with case status Sent to check and goes to the processing team for a verification call.'}</p>
    </div>${id ? html`<div>${caseBadge(c.case_status)}</div>` : ''}</div>
    <form class="card case-form" id="case-form" novalidate>
      ${c.status === 'returned_to_sales' ? html`<div class="callout info"><strong>Returned by team leader</strong>${c.tl_note}</div>` : ''}

      <section>
        <h2>Customer</h2>
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
        <div class="form-grid three">
          ${field('sourcing_date', 'Sourcing date', { type: 'date', required: true, attrs: `max="${todayLocal()}"` })}
          ${field('bidaya_id', 'Bidaya ID')}
          ${field('app_id', 'App ID')}
        </div>
      </section>

      <section>
        <h2>Product</h2>
        <div class="form-grid">
          <div class="full">
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
  productSelect.onchange = updateProductFields;
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
      body.buyout_bank = body.buyout_bank === OTHER_BANK ? body.buyout_bank_other?.trim() : body.buyout_bank ?? null;
      delete body.buyout_bank_other;
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
  return label(e.detail);
}

async function viewCase(id) {
  const { case: c } = await api(`/cases/${id}`);
  // A detail row; ID-style values use a monospace face so digits are easy to read back on a call.
  const row = (dt, value, mono = false) => html`<dt>${dt}</dt><dd class="${mono && value ? 'mono' : ''}">${value || '—'}</dd>`;
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
        <div class="field-row"><textarea name="note" required placeholder="What needs to change? e.g. correct Emirates ID is 784-…"></textarea></div>
        <button class="btn-primary">Send edit request</button>
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
        <div class="badges">${caseBadge(c.case_status)} ${badge(c.status)} <span class="muted small">Sourced by ${c.created_by_name} on ${fmtDay(c.sourcing_date)}</span></div>
      </div>
    </div>
    ${c.case_status === 'applicant_review' ? html`<div class="callout warn"><strong>Applicant review${c.case_status_by_name ? ` — set by ${c.case_status_by_name} ${ago(c.case_status_at)}` : ''}</strong>${c.case_status_note || ''}</div>` : ''}
    ${c.edit_request_to ? html`<div class="callout info"><strong>Edit request in the ${state.meta.edit_queues[c.edit_request_to]} queue — from ${c.edit_request_by_name} ${ago(c.edit_request_at)}</strong>${c.edit_request_note}</div>` : ''}
    ${banner}
    <div class="grid two-col">
      <div>
        <div class="card">
          <h2>Customer</h2>
          <dl class="details">
            <dt>Mobile</dt><dd><a class="phone-link" href="tel:${c.phone.replace(/[^\d+]/g, '')}">${c.phone}</a></dd>
            ${c.alt_phone ? html`<dt>Alternate phone</dt><dd><a href="tel:${c.alt_phone.replace(/[^\d+]/g, '')}">${c.alt_phone}</a></dd>` : ''}
            ${row('Emirates ID', c.eid_number, true)}
            ${row('Passport number', c.passport_number, true)}
            ${row('Company', c.company_name)}
            ${row('Monthly salary', c.salary != null ? `AED ${fmtAmount(c.salary)}` : null)}
            ${row('Bidaya ID', c.bidaya_id, true)}
            ${row('App ID', c.app_id, true)}
            ${row('Email', c.email)}
            ${row('Address', [c.address, c.city].filter(Boolean).join(', '))}
          </dl>
          <h2 class="sub">Product</h2>
          <dl class="details">
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
          <h2 class="sub">Case</h2>
          <dl class="details">
            <dt>Case status</dt><dd>${caseBadge(c.case_status)}${c.case_status_by_name ? html`<div class="muted small">${c.case_status_by_name} · ${fmtDate(c.case_status_at)}</div>` : ''}${c.case_status_note ? html`<div>${c.case_status_note}</div>` : ''}</dd>
            <dt>Sourcing date</dt><dd>${fmtDay(c.sourcing_date)}</dd>
            <dt>Lead source</dt><dd>${c.source || '—'}</dd>
            <dt>Sales notes</dt><dd style="white-space:pre-wrap">${c.sales_notes || '—'}</dd>
            <dt>Processor</dt><dd>${c.assigned_to_name || '—'}</dd>
            <dt>Call attempts</dt><dd>${c.call_attempts}</dd>
          </dl>
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
  document.getElementById('back-link').onclick = (e) => {
    if (history.length > 1) { e.preventDefault(); history.back(); }
  };
  app.querySelectorAll('[data-action]').forEach((b) => (b.onclick = () => run({ action: b.dataset.action }, b)));
  app.querySelectorAll('[data-case-complete]').forEach((b) => (b.onclick = () => run({ action: 'set_case_status', case_status: 'completed' }, b)));
  app.querySelectorAll('form[data-form]').forEach((f) => {
    const kind = f.dataset.form;
    if (kind === 'verification') {
      const reasonRow = f.querySelector('#vr-reason');
      const reason = reasonRow.querySelector('select');
      const note = f.querySelector('textarea');
      const hint = f.querySelector('#vr-hint');
      const hints = {
        complete: 'Details confirmed with the customer. This does not complete the case; set the case status below.',
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

// ---------- users (team leader) ----------
async function viewUsers() {
  const { users } = await api('/users');
  shell(html`
    <div class="page-head"><div><h1>Users</h1><p class="muted" style="margin:0">Add sales staff, processing team members and team leaders.</p></div></div>
    <div class="grid two-col">
      <div class="card"><div class="table-wrap"><table>
        <thead><tr><th>Name</th><th>Email</th><th>Role</th><th>Status</th><th></th></tr></thead>
        <tbody>${users.map((u) => html`<tr style="cursor:default">
          <td>${u.name}</td><td>${u.email}</td><td>${ROLE_LABEL[u.role]}</td>
          <td>${u.active ? 'Active' : html`<span class="muted">Disabled</span>`}</td>
          <td class="actions">
            <button class="btn-link" data-reset="${u.id}">Reset password</button>
            ${u.id !== state.user.id ? html`<button class="btn-link" data-toggle="${u.id}" data-active="${u.active}">${u.active ? 'Disable' : 'Enable'}</button>` : ''}
          </td></tr>`)}</tbody>
      </table></div></div>
      <form class="card" id="user-form">
        <h2>Add user</h2>
        <div class="field-row"><label>Name</label><input name="name" required></div>
        <div class="field-row"><label>Email</label><input name="email" type="email" required></div>
        <div class="field-row"><label>Role</label><select name="role" required>
          ${Object.entries(ROLE_LABEL).map(([k, l]) => html`<option value="${k}">${l}</option>`)}
        </select></div>
        <div class="field-row"><label>Temporary password</label><input name="password" type="text" minlength="8" required></div>
        <button class="btn-primary">Add user</button>
      </form>
    </div>`);
  document.getElementById('user-form').onsubmit = async (e) => {
    e.preventDefault();
    try {
      await api('/users', { method: 'POST', body: formData(e.target) });
      toast('User added');
      viewUsers();
    } catch (ex) { toast(ex.message, true); }
  };
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
