// Sourcing CRM — single-page frontend (no build step).

const STATUS_LABEL = {
  pending_verification: 'Pending verification',
  in_verification: 'In verification',
  completed: 'Completed',
  incomplete: 'Incomplete — TL action',
  returned_to_sales: 'Returned to sales',
  rejected: 'Rejected',
};
const ROLE_LABEL = { sales: 'Sales', processing: 'Processing', team_leader: 'Team Leader' };
const ACTION_LABEL = {
  created: 'Case created',
  edited: 'Details edited',
  claim: 'Picked up for verification',
  release: 'Released back to queue',
  log_call: 'Call logged',
  complete: 'Marked completed (verified)',
  mark_incomplete: 'Marked incomplete',
  return_to_sales: 'Returned to sales',
  reverify: 'Sent back for re-verification',
  reject: 'Rejected',
  resubmit: 'Resubmitted for verification',
};

const state = { user: null, meta: null, unread: 0, actionRequired: 0 };
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
const fmtDate = (iso) => (iso ? new Date(iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z').toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');
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
    if (state.user.role === 'team_leader') {
      const s = await api('/stats');
      state.actionRequired = s.by_status.incomplete;
    }
    updateBadges();
  } catch { /* ignore polling errors */ }
}

function updateBadges() {
  const dot = document.querySelector('.bell .dot');
  if (dot) { dot.textContent = state.unread; dot.hidden = !state.unread; }
  const ar = document.querySelector('[data-ar-count]');
  if (ar) { ar.textContent = state.actionRequired; ar.hidden = !state.actionRequired; }
}

// ---------- shell ----------
function navLinks() {
  const r = state.user.role;
  const links = [['#/', 'Dashboard']];
  if (r === 'sales') links.push(['#/cases', 'My cases'], ['#/cases/new', '+ New case']);
  if (r === 'processing') links.push(['#/queue', 'Verification queue'], ['#/cases?assigned=me', 'My cases'], ['#/cases', 'All cases']);
  if (r === 'team_leader') {
    links.push(['#/action-required', raw(`Action required<span class="count" data-ar-count ${state.actionRequired ? '' : 'hidden'}>${state.actionRequired}</span>`)]);
    links.push(['#/cases', 'All cases'], ['#/cases/new', '+ New case'], ['#/users', 'Users']);
  }
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
      return await viewCases({ title: 'Verification queue', subtitle: 'Call each customer to verify the sourced details, then mark the case completed or incomplete.', params, fixedStatus: 'pending_verification,in_verification' });
    }
    if (path === '/action-required') {
      return await viewCases({ title: 'Action required', subtitle: 'Cases the processing team marked incomplete. Decide whether to return to sales, re-verify, or reject.', params, fixedStatus: 'incomplete' });
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
  const tiles = [];
  if (r === 'team_leader') tiles.push(['Action required', by.incomplete, '#/action-required', by.incomplete > 0]);
  if (r === 'processing') tiles.push(['My open cases', s.my_queue, '#/cases?assigned=me']);
  tiles.push(
    ['Pending verification', by.pending_verification, `#/cases?status=pending_verification`],
    ['In verification', by.in_verification, `#/cases?status=in_verification`],
    ['Completed', by.completed, `#/cases?status=completed`]
  );
  if (r !== 'team_leader') tiles.push(['Incomplete', by.incomplete, `#/cases?status=incomplete`]);
  tiles.push(['Returned to sales', by.returned_to_sales, `#/cases?status=returned_to_sales`], ['Total', s.total, '#/cases']);

  const intro = {
    sales: 'Add the customers you source. The processing team calls each one to verify. Cases returned to you need corrections before resubmitting.',
    processing: 'Work through the verification queue: call the customer, log each attempt, then mark the case completed or incomplete.',
    team_leader: 'Incomplete cases need your decision. Return them to sales, send them back for re-verification, or reject them.',
  }[r];

  let extra = '';
  if (r === 'team_leader') {
    const { cases } = await api('/cases?status=incomplete&limit=10');
    extra = html`
      <div class="grid two-col">
        <div class="card">
          <h2>Waiting on you</h2>
          ${caseTable(cases, { cols: ['ref', 'customer', 'reason', 'by', 'waiting'] })}
        </div>
        <div>
          <div class="card"><h2>Processing team</h2>
            ${miniTable(['Name', 'Calls', 'Done', 'Incompl.'], s.processors.map((p) => [p.name, p.calls, p.completed, p.incomplete]))}
          </div>
          <div class="card"><h2>Sales team</h2>
            ${miniTable(['Name', 'Sourced', 'Verified'], s.sales.map((p) => [p.name, p.sourced, p.completed]))}
          </div>
        </div>
      </div>`;
  } else if (r === 'sales') {
    const { cases } = await api('/cases?status=returned_to_sales');
    if (cases.length) extra = html`<div class="card"><h2>Returned to you — needs correction</h2>${caseTable(cases, { cols: ['ref', 'customer', 'phone', 'tl_note', 'updated'] })}</div>`;
  } else {
    const { cases } = await api('/cases?assigned=me&status=in_verification');
    extra = html`<div class="card"><h2>My cases in progress</h2>${caseTable(cases, { cols: ['ref', 'customer', 'phone', 'calls', 'updated'], empty: 'Nothing in progress. Pick a case from the verification queue.' })}</div>`;
  }

  shell(html`
    <div class="page-head">
      <div><h1>Hello, ${state.user.name.split(' ')[0]}</h1><p class="muted" style="margin:0">${intro}</p></div>
      ${r === 'sales' || r === 'team_leader' ? html`<a class="btn btn-primary" href="#/cases/new">+ New case</a>` : ''}
      ${r === 'processing' ? html`<a class="btn btn-primary" href="#/queue">Open verification queue</a>` : ''}
    </div>
    <div class="grid stats">
      ${tiles.map(([l, v, href, alert]) => html`<a class="card stat ${alert ? 'alert' : ''}" href="${href}"><div class="label">${l}</div><div class="value">${v ?? 0}</div></a>`)}
    </div>
    ${extra}`);
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
  customer: ['Customer', (c) => html`${c.customer_name}<div class="muted small">${[c.product_label, c.city].filter(Boolean).join(' · ')}</div>`],
  phone: ['Phone', (c) => c.phone],
  status: ['Status', (c) => badge(c.status)],
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

async function viewCases({ title, subtitle = '', params, fixedStatus }) {
  const status = fixedStatus || params.get('status') || '';
  const q = params.get('q') || '';
  const query = new URLSearchParams({ ...(status && { status }), ...(q && { q }), ...(params.get('assigned') && { assigned: params.get('assigned') }) });
  const { cases } = await api(`/cases?${query}`);

  const r = state.user.role;
  let cols = ['ref', 'customer', 'phone', 'status', 'source_by', 'assigned', 'calls', 'updated'];
  if (r === 'sales') cols = ['ref', 'customer', 'phone', 'status', 'assigned', 'updated'];
  if (fixedStatus === 'incomplete') cols = ['ref', 'customer', 'phone', 'reason', 'by', 'source_by', 'waiting'];

  const base = location.hash.split('?')[0];
  const tabs = fixedStatus ? '' : html`<div class="tabs">
      ${[['', 'All'], ...Object.entries(STATUS_LABEL)].map(([s, l]) => html`<button data-status="${s}" class="${s === status ? 'active' : ''}">${l}</button>`)}
    </div>`;

  shell(html`
    <div class="page-head">
      <div><h1>${title}</h1>${subtitle ? html`<p class="muted" style="margin:0">${subtitle}</p>` : ''}</div>
      ${r !== 'processing' ? html`<a class="btn btn-primary" href="#/cases/new">+ New case</a>` : ''}
    </div>
    <div class="card">
      <div class="toolbar">
        <form id="search-form" style="display:flex;gap:8px;flex:1;min-width:240px">
          <input type="search" name="q" placeholder="Search name, phone, email, city or ref…" value="${q}">
          <button>Search</button>
        </form>
        ${tabs}
      </div>
      ${caseTable(cases, { cols, empty: fixedStatus === 'incomplete' ? 'Nothing needs your attention right now 🎉' : 'No cases found' })}
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
}

// ---------- case form ----------
async function viewCaseForm(id) {
  const c = id ? (await api(`/cases/${id}`)).case : {};
  const products = state.meta.products;
  const bundled = new Set(String(c.bundle_products || '').split(',').filter(Boolean));
  const field = (name, text, { type = 'text', required = false, full = false, placeholder = '' } = {}) => html`
    <div class="${full ? 'full' : ''}">
      <label for="f-${name}">${text}${required ? raw(' <span class="req">*</span>') : ''}</label>
      ${type === 'textarea'
        ? html`<textarea id="f-${name}" name="${name}" placeholder="${placeholder}">${c[name] ?? ''}</textarea>`
        : html`<input id="f-${name}" name="${name}" type="${type}" value="${c[name] ?? ''}" placeholder="${placeholder}" ${required ? raw('required') : ''}>`}
    </div>`;

  shell(html`
    <div class="page-head"><div>
      <h1>${id ? `Edit ${c.ref}` : 'New sourcing case'}</h1>
      <p class="muted" style="margin:0">${id ? 'Update the customer details, then save.' : 'Enter the customer you sourced. It goes straight to the processing team for a verification call.'}</p>
    </div></div>
    <form class="card" id="case-form">
      ${c.status === 'returned_to_sales' ? html`<div class="callout info"><strong>Returned by team leader</strong>${c.tl_note}</div>` : ''}
      <div class="form-grid">
        ${field('customer_name', 'Customer name', { required: true })}
        ${field('phone', 'Phone', { type: 'tel', required: true, placeholder: '+91 98765 43210' })}
        ${field('alt_phone', 'Alternate phone', { type: 'tel' })}
        ${field('email', 'Email', { type: 'email' })}
        ${field('address', 'Address', { full: true })}
        ${field('city', 'City')}
        ${field('source', 'Lead source', { placeholder: 'e.g. Referral, Walk-in, Field visit' })}
        <div>
          <label for="f-product">Product <span class="req">*</span></label>
          <select id="f-product" name="product" required>
            <option value="">Choose a product…</option>
            ${[...Object.entries(products), ['bundle', 'Bundle (multiple products)']].map(([k, l]) => html`<option value="${k}" ${c.product === k ? raw('selected') : ''}>${l}</option>`)}
          </select>
        </div>
        ${field('amount', 'Amount', { type: 'number', placeholder: '0' })}
        <fieldset class="full bundle-picker" id="bundle-picker" ${c.product === 'bundle' ? '' : raw('hidden')}>
          <legend>Products in this bundle <span class="req">*</span> <span class="muted small">Pick at least two</span></legend>
          <div class="checks">
            ${Object.entries(products).map(([k, l]) => html`<label class="check"><input type="checkbox" name="bundle_products" value="${k}" ${bundled.has(k) ? raw('checked') : ''}> ${l}</label>`)}
          </div>
        </fieldset>
        <fieldset class="full loan-type" id="loan-type-field" hidden>
          <legend>Personal loan type <span class="req">*</span></legend>
          <div class="segmented">
            ${Object.entries(state.meta.personal_loan_types).map(([k, l]) => html`<label><input type="radio" name="personal_loan_type" value="${k}" required disabled ${c.personal_loan_type === k ? raw('checked') : ''}><span>${l}</span></label>`)}
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
        ${field('sales_notes', 'Notes for the processing team', { type: 'textarea', full: true, placeholder: 'Best time to call, language preference, anything to verify…' })}
      </div>
      <p class="error" id="form-error" hidden></p>
      <div class="actions" style="margin-top:16px">
        <button class="btn-primary">${id ? 'Save changes' : 'Submit for verification'}</button>
        ${c.status === 'returned_to_sales' ? html`<button type="button" class="btn-success" id="save-resubmit">Save &amp; resubmit</button>` : ''}
        <a class="btn" href="${id ? `#/cases/${id}` : '#/'}">Cancel</a>
      </div>
    </form>`);

  const form = document.getElementById('case-form');
  const productSelect = document.getElementById('f-product');
  const picker = document.getElementById('bundle-picker');
  const boxes = [...picker.querySelectorAll('input[type=checkbox]')];
  const loanField = document.getElementById('loan-type-field');
  const loanRadios = [...loanField.querySelectorAll('input')];
  const cardField = document.getElementById('card-field');
  const cardSelect = document.getElementById('f-credit_card');
  const checkBundle = () => {
    const isBundle = productSelect.value === 'bundle';
    const count = boxes.filter((b) => b.checked).length;
    boxes[0].setCustomValidity(isBundle && count < 2 ? 'Pick at least two products for a bundle' : '');
    // Ask for product details only when that product is chosen or part of the bundle.
    const includes = (p) => productSelect.value === p || (isBundle && boxes.some((b) => b.value === p && b.checked));
    loanField.hidden = !includes('personal_loan');
    loanRadios.forEach((r) => (r.disabled = loanField.hidden));
    cardField.hidden = !includes('credit_card');
    cardSelect.disabled = cardField.hidden;
  };
  productSelect.onchange = () => { picker.hidden = productSelect.value !== 'bundle'; checkBundle(); };
  boxes.forEach((b) => (b.onchange = checkBundle));
  checkBundle();

  const save = async (resubmit) => {
    const err = document.getElementById('form-error');
    err.hidden = true;
    if (!form.reportValidity()) return;
    try {
      const body = formData(form);
      body.bundle_products = body.product === 'bundle' ? new FormData(form).getAll('bundle_products') : [];
      body.credit_card ??= null;
      body.personal_loan_type ??= null;
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
async function viewCase(id) {
  const { case: c } = await api(`/cases/${id}`);
  const a = new Set(c.allowed_actions);
  const meta = state.meta;

  let banner = '';
  if (c.status === 'incomplete') {
    banner = html`<div class="callout danger"><strong>Incomplete — waiting for team leader action (${ago(c.incomplete_at)})</strong>
      ${label(c.incomplete_reason)}${c.incomplete_note ? `: ${c.incomplete_note}` : ''} <span class="muted">— ${c.assigned_to_name}</span></div>`;
  } else if (c.status === 'returned_to_sales') {
    banner = html`<div class="callout info"><strong>Returned to sales by ${c.tl_actioned_by_name}</strong>${c.tl_note}
      ${c.incomplete_reason ? html`<div class="muted small">Original issue: ${label(c.incomplete_reason)}${c.incomplete_note ? ` — ${c.incomplete_note}` : ''}</div>` : ''}</div>`;
  } else if (c.status === 'completed') {
    banner = html`<div class="callout success"><strong>Verified by ${c.verified_by_name} on ${fmtDate(c.verified_at)}</strong></div>`;
  } else if (c.status === 'rejected') {
    banner = html`<div class="callout danger"><strong>Rejected by ${c.tl_actioned_by_name}</strong>${c.tl_note}</div>`;
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
  if (a.has('complete') || a.has('mark_incomplete')) {
    panel.push(html`<hr><h3>Verification result</h3>
      <form data-form="complete">
        <div class="field-row"><textarea name="note" placeholder="Verification notes (optional)"></textarea></div>
        <button class="btn-success">✓ Mark completed</button>
      </form>
      <h3>Can't verify?</h3>
      <form data-form="mark_incomplete">
        <div class="field-row"><select name="reason" required>
          <option value="">Reason…</option>
          ${meta.incomplete_reasons.map((o) => html`<option value="${o}">${label(o)}</option>`)}
        </select></div>
        <div class="field-row"><textarea name="note" required placeholder="Explain what's missing — your team leader will be alerted"></textarea></div>
        <button class="btn-danger">✕ Mark incomplete</button>
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
          <b>Reject</b>: close the case permanently.
        </p>
      </form>`);
  }
  if (a.has('resubmit')) {
    panel.push(html`<h3>Fix &amp; resubmit</h3><p class="muted small">Correct the details the team leader flagged, then resubmit for verification.</p>
      <div class="actions"><a class="btn" href="#/cases/${c.id}/edit">Edit details</a><button class="btn-primary" data-action="resubmit">Resubmit</button></div>`);
  }
  if (c.can_edit && !a.has('resubmit')) {
    panel.push(html`${panel.length ? raw('<hr>') : ''}<a class="btn" href="#/cases/${c.id}/edit">Edit details</a>`);
  }

  shell(html`
    <div class="page-head">
      <div><a href="#/" class="small" id="back-link">← Back</a>
        <h1>${c.customer_name} <span class="muted" style="font-weight:400">${c.ref}</span></h1>
        <div>${badge(c.status)} <span class="muted small">Sourced by ${c.created_by_name} · ${fmtDate(c.created_at)}</span></div>
      </div>
    </div>
    ${banner}
    <div class="grid two-col">
      <div>
        <div class="card">
          <h2>Customer</h2>
          <dl class="details">
            <dt>Phone</dt><dd><a class="phone-link" href="tel:${c.phone.replace(/[^\d+]/g, '')}">${c.phone}</a></dd>
            ${c.alt_phone ? html`<dt>Alternate phone</dt><dd><a href="tel:${c.alt_phone.replace(/[^\d+]/g, '')}">${c.alt_phone}</a></dd>` : ''}
            <dt>Email</dt><dd>${c.email || '—'}</dd>
            <dt>Address</dt><dd>${[c.address, c.city].filter(Boolean).join(', ') || '—'}</dd>
            <dt>Product</dt><dd>${c.product === 'bundle'
              ? html`<strong>Bundle</strong><ul class="bundle-list">${c.bundle_products.split(',').map((p) => html`<li>${state.meta.products[p] || p}</li>`)}</ul>`
              : state.meta.products[c.product] || c.product || '—'}</dd>
            ${c.personal_loan_type ? html`<dt>Personal loan type</dt><dd><strong>${state.meta.personal_loan_types[c.personal_loan_type]}</strong></dd>` : ''}
            ${c.credit_card ? html`<dt>Credit card</dt><dd><strong>${c.credit_card}</strong></dd>` : ''}
            <dt>Amount</dt><dd>${fmtAmount(c.amount)}</dd>
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
              <div><strong>${ACTION_LABEL[e.type] || label(e.type)}</strong>${e.detail ? html` · ${e.type === 'edited' ? `fields: ${e.detail}` : label(e.detail)}` : ''}</div>
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
  app.querySelectorAll('form[data-form]').forEach((f) => {
    const kind = f.dataset.form;
    if (kind === 'tl') {
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
          <option value="sales">Sales</option><option value="processing">Processing</option><option value="team_leader">Team Leader</option>
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
