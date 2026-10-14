import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as cases from './cases.js';
import * as allocations from './allocations.js';
import * as boosters from './boosters.js';
import { cardFamilies, cardProductSource, loadCardProducts, backfillCardCategories } from './credit-cards.js';
import { cardPitch } from './card-pitch.js';
import * as holidays from './holidays.js';
import { loadPayoutRules, payoutRules, payoutSource, PAYOUT_LABELS, canSeePayout } from './payouts.js';
import { myIncentive, INCENTIVE_RULES, AL_INCENTIVE_RULES } from './incentives.js';
import * as assets from './assets.js';
import * as roles from './roles.js';
import { dashboardFor, CALENDAR_GREEN_PCT, CALENDAR_ORANGE_PCT } from './dashboard.js';
import { PL_MIN_YIELD } from './yield.js';
import { profitAndLoss, profitAndLossTree } from './pnl.js';
import { ceoDashboard } from './ceo.js';
import * as leads from './leads.js';
import { BANKS } from './banks.js';
import { contactDetails, findUser, listUsers, salesProfile, leaderProfile, LEADER_LINE_ROLES, regionOf, sweepLeavers, salaryOf, canSeeSalary, withSalaryFor, STAFF_CORE_PRODUCTS, deleteUsers } from './users.js';
import * as imports from './imports.js';
import * as performance from './performance.js';
import * as reports from './reports.js';
import * as chat from './chat.js';
import { cycleOf, uaeDay } from './cycles.js';
import { canTeachBot, makeCallBot, playbookView, practice, savePlaybook } from './bot.js';
import { aiConfigured, makeInterpreter, makePhraser } from './bot-ai.js';
import { makeRecordingLookup } from './recordings.js';

const PUBLIC_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.gz': 'application/gzip',
};
const MAX_BODY = 1024 * 1024;
const MAX_UPLOAD = 6 * 1024 * 1024; // bulk upload files

// Emirates ID scanner (Tesseract.js). Served from public/vendor/tesseract after `npm run setup:ocr`,
// otherwise from the jsDelivr CDN. Versions are pinned to match setup-ocr.js.
function ocrAssets() {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'vendor', 'tesseract', 'tesseract.min.js'))) {
    return { script: '/vendor/tesseract/tesseract.min.js', workerPath: '/vendor/tesseract/worker.min.js', coreDir: '/vendor/tesseract', langPath: '/vendor/tesseract' };
  }
  const cdn = 'https://cdn.jsdelivr.net/npm';
  return {
    script: `${cdn}/tesseract.js@5.1.1/dist/tesseract.min.js`,
    workerPath: `${cdn}/tesseract.js@5.1.1/dist/worker.min.js`,
    coreDir: `${cdn}/tesseract.js-core@5.1.1`,
    langPath: `${cdn}/@tesseract.js-data/eng@1.0.0/4.0.0_best_int`,
  };
}

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function post(url, payload, label) {
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
    signal: AbortSignal.timeout(5000),
  }).catch((err) => console.error(`[webhook] failed to deliver ${label}: ${err.message}`));
}

/**
 * Sends workflow triggers to external services. Fire-and-forget so a slow endpoint never blocks
 * anyone using the CRM.
 * - case.incomplete -> TL_WEBHOOK_URL (e.g. a Slack/Teams incoming webhook)
 * - callback.due -> PROCESSING_WEBHOOK_URL (the processing team's channel), when a customer's
 *   requested call-back time arrives
 * - recording.it_request -> IT_EMAIL_WEBHOOK_URL, an email relay (Power Automate, Zapier, an SMTP
 *   bridge...) that receives { to, subject, text } and sends the email to IT.
 */
export function makeWebhookDispatcher({
  tlUrl = process.env.TL_WEBHOOK_URL,
  emailUrl = process.env.IT_EMAIL_WEBHOOK_URL,
  processingUrl = process.env.PROCESSING_WEBHOOK_URL,
} = {}) {
  return (triggers) => {
    for (const t of triggers) {
      if (t.event === 'callback.due' && processingUrl) {
        const text = `:telephone_receiver: Call back now: ${t.ref} (${t.customer_name}) asked to be called at ${cases.callbackLabel(t.callback_at)}${t.processor ? ` — ${t.processor}` : ' — unassigned'}`;
        post(processingUrl, { text, ...t }, `${t.event} for ${t.ref}`);
      }
      if (t.event === 'case.incomplete' && tlUrl) {
        const text = `:warning: ${t.ref} (${t.customer_name}) verification PENDING, marked by ${t.marked_by} — ${t.reason.replace(/_/g, ' ')}${t.note ? `: ${t.note}` : ''}. Team leader action required.`;
        post(tlUrl, { text, ...t }, `${t.event} for ${t.ref}`);
      }
      if (t.event === 'recording.it_request') {
        if (emailUrl && t.to) post(emailUrl, { to: t.to, subject: t.subject, text: t.body, ref: t.ref, case_id: t.case_id }, `IT email for ${t.ref}`);
        else console.warn(`[email] IT recording request for ${t.ref} not sent automatically: set IT_EMAIL and IT_EMAIL_WEBHOOK_URL`);
      }
    }
  };
}

function parseCookies(header = '') {
  return Object.fromEntries(
    header
      .split(';')
      .map((p) => p.trim().split('='))
      .filter(([k, v]) => k && v)
      .map(([k, ...v]) => [k, decodeURIComponent(v.join('='))])
  );
}

async function readJson(req, limit = MAX_BODY) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  // Requiring JSON blocks cross-site form posts (CSRF) along with SameSite cookies.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new HttpError(413, limit > MAX_BODY ? 'The file is too large. Split it into smaller files' : 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  // Kept for checking signed webhook bodies (bot call results).
  req.rawBody = Buffer.concat(chunks).toString('utf8');
  try {
    return JSON.parse(req.rawBody);
  } catch {
    throw new HttpError(400, 'Invalid JSON body');
  }
}

function send(res, status, body, headers = {}) {
  const payload = body === undefined ? '' : JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

function sessionCookie(token, maxAge) {
  const secure = process.env.COOKIE_SECURE === '1' ? '; Secure' : '';
  return `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${secure}`;
}

function requireRole(user, ...roles) {
  if (!roles.includes(user.role)) throw new HttpError(403, 'You do not have permission to do that');
}

// The CRM's own address as the caller reached it, for callback URLs when PUBLIC_URL is not set.
const originOf = (req) => `${process.env.COOKIE_SECURE === '1' ? 'https' : 'http'}://${req.headers.host}`;

// Who adds and edits staff: MIS and business heads.
const USER_ADMINS = ['mis', 'business_head'];

/** The recording server's calls are opened only once the business head has approved a recording request on the file. */
const RECORDING_UNLOCKED = ['approved', 'received'];
const callsUnlocked = (row) => RECORDING_UNLOCKED.includes(row.recording_status);
/** What the file page says about looking the calls up: who may, whether the server is connected, and whether the approval is in place. */
function callsLookupState(user, row, recordings) {
  if (!cases.canListenToBotCalls(user)) return null;
  return { enabled: recordings.enabled, label: recordings.label, unlocked: callsUnlocked(row), status: row.recording_status || null, can_rate: user.role === 'governance' };
}
/** The file, for someone who may hear its calls, once the approval is in place. */
function unlockedCase(db, user, caseId, { lookup = true } = {}) {
  if (!cases.canListenToBotCalls(user)) throw new HttpError(403, 'Only governance, business heads and the verification team leader can look up calls');
  const row = db.prepare('SELECT id, phone, alt_phone, customer_name, recording_status, recording_requested_by FROM cases WHERE id = ?').get(caseId);
  if (!row) throw new HttpError(404, 'Case not found');
  cases.getCase(db, user, caseId); // may they open the file?
  if (lookup && !callsUnlocked(row)) throw new HttpError(403, row.recording_status === 'pending_approval' ? 'The business head has to approve the recording request before the calls can be looked up' : 'Governance requests the call recording and the business head approves it before the calls can be looked up');
  return row;
}

/** The calls for a file's customer: the recording server's, then the CRM's own bot calls to the same numbers (any file). */
async function customerCalls(db, user, recordings, caseId) {
  const row = unlockedCase(db, user, caseId);
  cases.logAccess(db, user, caseId, 'calls:lookup');
  const numbers = [row.phone, row.alt_phone].filter(Boolean);
  const digits = numbers.map((n) => String(n).replace(/\D/g, '').slice(-9)).filter(Boolean);
  const bots = digits.length ? db.prepare(`SELECT b.id, b.case_id, b.finished_at, b.placed_at, b.requested_at, b.outcome, b.status, b.recording_url IS NOT NULL AS has_recording, u.name AS requested_by_name
      FROM bot_calls b JOIN cases c ON c.id = b.case_id JOIN users u ON u.id = b.requested_by
      WHERE b.status IN ('completed', 'failed') AND (${digits.map(() => "replace(replace(replace(c.phone, ' ', ''), '-', ''), '+', '') LIKE ?").join(' OR ')}${digits.map(() => " OR replace(replace(replace(COALESCE(c.alt_phone, ''), ' ', ''), '-', ''), '+', '') LIKE ?").join('')})
      ORDER BY b.id DESC`).all(...digits.map((d) => `%${d}`), ...digits.map((d) => `%${d}`)) : [];
  const bot = bots.map((b) => ({ id: `bot:${b.id}`, source: 'bot', case_id: b.case_id, ref: cases.caseRef(b.case_id), started_at: b.placed_at || b.finished_at || b.requested_at, duration_s: null, direction: 'outbound',
    extension: null, agent: `Verification bot (asked for by ${b.requested_by_name})`, name: b.outcome ? String(b.outcome).replace(/_/g, ' ') : b.status, playable: Boolean(b.has_recording), play_url: b.has_recording ? `/api/bot/calls/${b.id}/recording` : null }));
  const server = (await recordings.calls(numbers)).map((r) => ({ ...r, play_url: r.playable ? `/api/recordings/${r.id}?case=${caseId}` : null }));
  // Governance's ratings, by call.
  const ratings = new Map(db.prepare('SELECT r.call_key, r.score, r.note, r.rated_at, u.name AS rated_by_name FROM call_ratings r JOIN users u ON u.id = r.rated_by WHERE r.case_id = ?').all(caseId).map((r) => [r.call_key, r]));
  const withRating = (k) => ({ ...k, rating: ratings.get(String(k.id)) || null });
  return { enabled: recordings.enabled, label: recordings.label, unlocked: true, can_rate: user.role === 'governance', numbers: numbers.length, calls: [...server, ...bot].map(withRating).sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || ''))) };
}

/** Governance rates a call it heard: 0 to 10, one decimal, with a note. */
function rateCall(db, user, caseId, key, { score, note, name }) {
  if (user.role !== 'governance') throw new HttpError(403, 'Only governance rates calls');
  const row = unlockedCase(db, user, caseId);
  const n = Number(score);
  if (score === '' || score == null || !Number.isFinite(n) || n < 0 || n > cases.SCORE_MAX || Math.round(n * 10) !== n * 10) throw new HttpError(400, `Score must be from 0 to ${cases.SCORE_MAX}, with at most one decimal place`);
  const k = String(key || '').slice(0, 80);
  if (!/^(bot:\d+|[0-9a-f]{32})$/.test(k)) throw new HttpError(400, 'Which call?');
  const ts = new Date().toISOString();
  const text = note == null ? null : String(note).trim().slice(0, 2000) || null;
  db.prepare('INSERT INTO call_ratings (case_id, call_key, call_name, score, note, rated_by, rated_at) VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(case_id, call_key) DO UPDATE SET call_name = excluded.call_name, score = excluded.score, note = excluded.note, rated_by = excluded.rated_by, rated_at = excluded.rated_at')
    .run(caseId, k, name == null ? null : String(name).slice(0, 200), n, text, user.id, ts);
  cases.addEvent(db, caseId, user.id, 'rate_call', { detail: `${n}/${cases.SCORE_MAX}${name ? ` · ${String(name).slice(0, 120)}` : ''}`, note: text });
  return { rating: { call_key: k, score: n, note: text, rated_at: ts, rated_by_name: user.name } };
}
// What an IT account may call: itself, the asset register, the staff list (read), reports and notifications.
const IT_PATHS = /^\/api\/(me|logout|password|assets|users|reports|notifications|roles|import\/assets)(\/|$)/;

/** The build this server runs: the git commit of the checkout (deploy/update.sh) and when it was made. */
export function buildInfo() {
  const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  try {
    const head = fs.readFileSync(path.join(root, '.git', 'HEAD'), 'utf8').trim();
    const ref = head.startsWith('ref: ') ? head.slice(5) : null;
    let commit = ref ? null : head;
    if (ref) {
      try { commit = fs.readFileSync(path.join(root, '.git', ref), 'utf8').trim(); } catch {
        const packed = fs.readFileSync(path.join(root, '.git', 'packed-refs'), 'utf8');
        commit = packed.split('\n').find((l) => l.endsWith(' ' + ref))?.split(' ')[0] || null;
      }
    }
    const at = fs.statSync(path.join(root, '.git', ref ? ref.replace(/^refs\/heads\//, 'refs/heads/') : 'HEAD')).mtime;
    return { commit: commit ? commit.slice(0, 7) : null, branch: ref ? ref.replace(/^refs\/heads\//, '') : null, updated_at: at.toISOString() };
  } catch {
    return { commit: null, branch: null, updated_at: null };
  }
}

function routes(db, dispatch, bot, interpret, phrase, recordings) {
  return [
    // What this server runs, for anyone on the sign-in page: the build and when it was last updated.
    ['GET', /^\/api\/version$/, async () => buildInfo(), { public: true }],

    ['POST', /^\/api\/login$/, async ({ body, res }) => {
      const result = auth.login(db, body.email, body.password);
      if (!result) throw new HttpError(401, 'Invalid email or password');
      if (result.no_access) throw new HttpError(403, 'This account is on the staff list for the profit and loss only; it has no CRM access');
      send(res, 200, { user: result.user }, { 'set-cookie': sessionCookie(result.token, result.maxAge) });
    }, { public: true }],

    // One's own profile: the mobile and WhatsApp numbers can be changed here; everything else is the Staff page's.
    ['PATCH', /^\/api\/me$/, async ({ user, body }) => {
      const allowed = Object.fromEntries(Object.entries(body).filter(([k]) => ['mobile_number', 'whatsapp_number'].includes(k)));
      if (!Object.keys(allowed).length) throw new HttpError(400, 'Only the mobile and WhatsApp numbers can be changed here; ask MIS for anything else');
      let contact;
      try { contact = contactDetails(allowed, { current: auth.getUser(db, user.id) }); } catch (err) { throw new HttpError(400, err.message); }
      for (const [field, value] of Object.entries(contact)) db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, user.id);
      return { user: findUser(db, user.id) };
    }],
    // Anyone changes their own password, with the current one; other sessions of theirs are signed out.
    ['POST', /^\/api\/password$/, async ({ user, body, token }) => {
      const row = db.prepare('SELECT password_hash FROM users WHERE id = ?').get(user.id);
      if (!row || !auth.verifyPassword(String(body.current || ''), row.password_hash)) throw new HttpError(400, 'The current password is not right');
      const next = String(body.password || '');
      if (next.length < 8) throw new HttpError(400, 'The new password must be at least 8 characters');
      if (next === String(body.current)) throw new HttpError(400, 'Choose a password different from the current one');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(next), user.id);
      db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?').run(user.id, token);
      return { ok: true };
    }],
    ['POST', /^\/api\/logout$/, async ({ token, res }) => {
      auth.logout(db, token);
      send(res, 200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
    }],

    ['GET', /^\/api\/me$/, async ({ user }) => ({
      user: findUser(db, user.id),
      meta: {
        statuses: Object.values(cases.STATUS),
        call_outcomes: cases.CALL_OUTCOMES,
        incomplete_reasons: cases.INCOMPLETE_REASONS,
        products: cases.PRODUCTS,
        credit_cards: cardFamilies(),
        card_list_source: cardProductSource(),
        can_see_payout: canSeePayout(user),
        incentive_rules: INCENTIVE_RULES,
        ...(canSeePayout(user) ? { payout_rates: payoutRules(), payout_labels: PAYOUT_LABELS, payout_source: payoutSource() } : {}),
        personal_loan_types: cases.PERSONAL_LOAN_TYPES, personal_loan_kinds: cases.PERSONAL_LOAN_KINDS, personal_loan_options: cases.PERSONAL_LOAN_OPTIONS,
        auto_loan_types: cases.AUTO_LOAN_TYPES,
        lead_status: leads.LEAD_STATUS, timing_flags: cases.TIMING_FLAGS, salutations: cases.SALUTATIONS, customer_types: cases.CUSTOMER_TYPES, sourcing_types: cases.SOURCING_TYPES, journey_types: cases.JOURNEY_TYPES, verify_tat_days: cases.VERIFY_TAT_DAYS, can_use_tat_switch: cases.canUseTatSwitch(user), ...(cases.canUseTatSwitch(user) && { power_button: cases.tatSwitchStatus(db, user) }), can_see_power_log: cases.POWER_LOG_VIEWERS.includes(user.role), fixed_deposit_products: cases.FIXED_DEPOSIT_PRODUCTS, booster_products: boosters.BOOSTER_PRODUCTS, booster_audience: boosters.BOOSTER_AUDIENCE, can_manage_boosters: boosters.canManageBoosters(user), pl_min_yield: PL_MIN_YIELD, calendar_green_pct: CALENDAR_GREEN_PCT, calendar_orange_pct: CALENDAR_ORANGE_PCT, can_allocate: allocations.canAllocate(user), complaint_status: cases.COMPLAINT_STATUS, complaint_remark: cases.COMPLAINT_REMARK,
        asset_status: assets.ASSET_STATUS, networks: assets.NETWORKS, accessories: assets.ACCESSORIES, asset_admins: assets.ASSET_ADMINS,
        auto_loan_classes: cases.AUTO_LOAN_CLASSES,
        al_incentive_rules: AL_INCENTIVE_RULES,
        buyout_kinds: cases.BUYOUT_KINDS,
        secondary_buyout_kinds: cases.SECONDARY_BUYOUT_KINDS,
        tenure_max: { personal_loan: cases.PL_TENURE_MAX, auto_loan: cases.AL_TENURE_MAX },
        card_fee_types: cases.CARD_FEE_TYPES,
        card_exceptions: cases.CARD_EXCEPTIONS,
        masked_fields: cases.MASKED_FIELDS,
        chat_overseers: chat.CHAT_OVERSEERS,
        chat_edit_minutes: chat.EDIT_WINDOW_MINUTES,
        banks: BANKS,
        case_statuses: cases.CASE_STATUS,
        regions: cases.REGIONS,
        roles: auth.ROLES,
        role_labels: roles.roleLabels(), assignable_roles: roles.assignableLabels(), custom_roles: roles.customRoles().map(({ key, label, base, description, status }) => ({ key, label, base, description, status })),
        perms: roles.permissionsOf(user), can_manage_roles: roles.canManageRoles(user), can_approve_roles: roles.canApproveRoles(user), roles_pending: roles.canApproveRoles(user) ? roles.customRoles().filter((r) => r.status === 'pending').length : 0,
        staff_core_products: STAFF_CORE_PRODUCTS,
        manager_roles: cases.MANAGER_ROLES,
        core_products: cases.CORE_PRODUCTS,
        settable_case_statuses: cases.SETTABLE_CASE_STATUSES,
        edit_queues: cases.EDIT_QUEUES,
        recording_statuses: cases.RECORDING_STATUS,
        score_max: cases.SCORE_MAX,
        callback_max_days: cases.CALLBACK_MAX_DAYS,
        it_email: cases.config.itEmail,
        call_bot: cases.config.callBot,
        can_teach_bot: canTeachBot(user),
        ocr: ocrAssets(),
        import_columns: { users: imports.USER_IMPORT_COLUMNS, cases: imports.CASE_IMPORT_COLUMNS, case_status: imports.CASE_STATUS_IMPORT_COLUMNS, cards: imports.CARD_IMPORT_COLUMNS, targets: imports.TARGET_IMPORT_COLUMNS, card_products: imports.CARD_PRODUCT_IMPORT_COLUMNS, target_rules: imports.TARGET_RULE_IMPORT_COLUMNS, payout_rules: imports.PAYOUT_RULE_IMPORT_COLUMNS, assets: imports.ASSET_IMPORT_COLUMNS },
        card_statuses: cases.CARD_STATES,
        card_range_days: cases.CARD_RANGE_DAYS,
        card_mappers: cases.CARD_MAPPERS,
        current_cycle: cycleOf(uaeDay()), idle_minutes: auth.IDLE_MINUTES,
        reports: reports.reportsFor(user),
        hierarchy_levels: performance.LEVEL_LABELS,
        import_max_rows: imports.MAX_ROWS,
      },
    })],

    ['GET', /^\/api\/stats$/, async ({ user, query }) => cases.stats(db, user, { region: query.get('region') })],
    // The signed-in user's own dashboard: this cycle, the last six, and the incentive so far.
    // Pitch for a higher card: its features read from the bank's website now, or the last good reading.
    ['GET', /^\/api\/cards\/pitch$/, async ({ query }) => {
      const pitch = await cardPitch(db, query.get('name') || '');
      if (!pitch) throw new HttpError(404, 'That card is not in the card list');
      return pitch;
    }],
    ['GET', /^\/api\/dashboard$/, async ({ user, query }) => dashboardFor(db, user, { region: query.get('region') })],

    // The sales hierarchy for a cycle, rolled up at every level the viewer may see (?cycle=&region=).
    ['GET', /^\/api\/hierarchy$/, async ({ user, query }) => performance.hierarchy(db, user, { cycle: query.get('cycle'), region: query.get('region') })],

    // Reports: the list for this role, then one report as JSON or CSV (?cycle= or ?from=&to=, ?region=, ?format=csv).
    ['GET', /^\/api\/reports$/, async ({ user }) => ({
      reports: reports.reportsFor(user),
      recent: ['governance', 'business_head', 'mis'].includes(user.role) ? reports.recentRuns(db) : [],
    })],
    ['GET', /^\/api\/reports\/([a-z_]+)$/, async ({ user, params, query, res }) => {
      const report = reports.runReport(db, user, params[0], Object.fromEntries(query));
      if (query.get('format') !== 'csv') return report;
      const name = `${report.key}-${report.from}-to-${report.to}${report.region ? `-${report.region}` : ''}.csv`;
      res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': `attachment; filename="${name}"`, 'cache-control': 'no-store' });
      res.end(reports.toCsv(report));
    }],

    ['GET', /^\/api\/cases$/, async ({ user, query }) => ({
      cases: cases.listCases(db, user, Object.fromEntries(query)),
    })],

    ['POST', /^\/api\/cases$/, async ({ user, body, res }) => {
      // A file created from a lead converts the lead; the lead must be the user's own and still open.
      if (body.lead_id) leads.getLead(db, user, Number(body.lead_id));
      const created = cases.createCase(db, user, body);
      if (body.lead_id) leads.convertLead(db, user, body.lead_id, created.id);
      send(res, 201, { case: created });
    }],

    // Leads: a sales person's prospects before there is a file; their team leader sees them too.
    ['GET', /^\/api\/leads$/, async ({ user, query }) => leads.listLeads(db, user, { status: query.get('status'), q: query.get('q') })],
    ['POST', /^\/api\/leads$/, async ({ user, body, res }) => send(res, 201, { lead: leads.createLead(db, user, body) })],
    ['GET', /^\/api\/leads\/(\d+)$/, async ({ user, params }) => ({ lead: leads.getLead(db, user, Number(params[0])) })],
    ['PATCH', /^\/api\/leads\/(\d+)$/, async ({ user, params, body }) => ({ lead: leads.updateLead(db, user, Number(params[0]), body) })],
    ['POST', /^\/api\/leads\/(\d+)\/follow-up$/, async ({ user, params, body }) => ({ lead: leads.setFollowUp(db, user, Number(params[0]), body) })],
    ['POST', /^\/api\/leads\/(\d+)\/status$/, async ({ user, params, body }) => ({ lead: leads.setLeadStatus(db, user, Number(params[0]), body) })],

    // Files entered by mistake or as tests: MIS and business heads delete them with a reason; governance sees what went.
    ['POST', /^\/api\/cases\/delete$/, async ({ user, body }) => cases.deleteCases(db, user, body.ids, body.reason)],
    ['GET', /^\/api\/deleted-cases$/, async ({ user, query }) => cases.listDeletedCases(db, user, Object.fromEntries(query))],
    ['GET', /^\/api\/cases\/(\d+)$/, async ({ user, params }) => {
      const result = cases.getCase(db, user, Number(params[0]));
      cases.logAccess(db, user, Number(params[0]), 'view');
      // Whether this person may look up the customer's calls on the recording server (the lookup itself is a separate call).
      result.calls_lookup = callsLookupState(user, result, recordings);
      return { case: result };
    }],
    // Every call to or from the customer's numbers: on the recording server, plus the CRM's own bot calls.
    ['GET', /^\/api\/cases\/(\d+)\/calls$/, async ({ user, params }) => customerCalls(db, user, recordings, Number(params[0]))],
    ['POST', /^\/api\/cases\/(\d+)\/calls\/([A-Za-z0-9:]+)\/rating$/, async ({ user, params, body }) => rateCall(db, user, Number(params[0]), params[1], body)],
    ['GET', /^\/api\/recordings\/([0-9a-f]{32})$/, async ({ user, params, query, res }) => {
      const caseId = Number(query.get('case'));
      const row = unlockedCase(db, user, caseId);
      cases.logAccess(db, user, caseId, 'listen:recording');
      // The first listen on an approved request is the recording arriving: the file shows it as received.
      if (row.recording_status === 'approved') {
        const ts = new Date().toISOString();
        db.prepare(`UPDATE cases SET recording_status = 'received', recording_ref = ?, recording_provided_by = ?, recording_provided_at = ?, updated_at = ? WHERE id = ?`).run(`Heard on the recording server${recordings.label ? ` (${recordings.label})` : ''}`, user.id, ts, ts, caseId);
        cases.addEvent(db, caseId, user.id, 'receive_recording', { detail: `Played from ${recordings.label || 'the recording server'}` });
      }
      await recordings.stream(params[0], res);
    }],

    // Full value of a masked personal detail (?fields=phone,eid_number); every reveal is logged.
    ['GET', /^\/api\/cases\/(\d+)\/reveal$/, async ({ user, params, query }) => cases.revealFields(db, user, Number(params[0]), query.get('fields'))],
    // Chat: case discussions, direct messages and groups.
    ['GET', /^\/api\/cases\/(\d+)\/messages$/, async ({ user, params, query }) => chat.listCaseMessages(db, user, Number(params[0]), Object.fromEntries(query))],
    ['POST', /^\/api\/cases\/(\d+)\/messages$/, async ({ user, params, body, res }) => send(res, 201, { message: chat.postCaseMessage(db, user, Number(params[0]), body.body) })],
    ['GET', /^\/api\/conversations$/, async ({ user }) => chat.listConversations(db, user)],
    ['GET', /^\/api\/colleagues$/, async ({ user }) => chat.listColleagues(db, user)],
    ['POST', /^\/api\/conversations\/direct$/, async ({ user, body }) => ({ conversation: chat.openDirect(db, user, body.user_id) })],
    ['GET', /^\/api\/conversations\/(\d+)\/messages$/, async ({ user, params, query }) => chat.listMessages(db, user, Number(params[0]), Object.fromEntries(query))],
    ['POST', /^\/api\/conversations\/(\d+)\/messages$/, async ({ user, params, body, res }) => send(res, 201, { message: chat.postMessage(db, user, Number(params[0]), body.body) })],
    ['POST', /^\/api\/messages\/(\d+)\/edit$/, async ({ user, params, body }) => ({ message: chat.editMessage(db, user, Number(params[0]), body.body) })],
    ['GET', /^\/api\/access-log$/, async ({ user, query }) => cases.listAccessLog(db, user, Object.fromEntries(query))],

    ['PUT', /^\/api\/cases\/(\d+)$/, async ({ user, params, body }) => ({
      case: cases.updateCase(db, user, Number(params[0]), body),
    })],

    ['POST', /^\/api\/cases\/(\d+)\/actions$/, async ({ req, user, params, body }) => {
      // Approving, declining or withdrawing a bot call; a fully approved call is placed.
      if (cases.BOT_DECISIONS.includes(body.action)) return { case: await bot.decide(user, Number(params[0]), body, originOf(req)) };
      const result = cases.applyAction(db, user, Number(params[0]), body);
      dispatch(result.triggers);
      return { case: result.case };
    }],

    // Result of a bot verification call. The token in the URL identifies the call; with
    // CALL_BOT_SECRET set the body must also be signed (x-crm-signature).
    ['POST', /^\/api\/bot\/calls\/([a-f0-9]{48})$/, async ({ req, params, body }) => {
      const { triggers, ...result } = bot.receive(params[0], req.rawBody || '', req.headers['x-crm-signature'], body);
      dispatch(triggers);
      return result;
    }, { public: true }],

    // Teaching the bot: its playbook, and practice calls typed on the teaching page.
    ['GET', /^\/api\/bot\/requests$/, async ({ user }) => bot.requests(user)],
    // Listen to a bot call: the audio is streamed through the CRM and the listen is logged.
    ['GET', /^\/api\/bot\/calls\/(\d+)\/recording$/, async ({ user, params, res }) => { await bot.streamRecording(user, Number(params[0]), res); }],
    ['GET', /^\/api\/bot\/playbook$/, async ({ user }) => playbookView(db, user, { enabled: bot.enabled })],
    ['PUT', /^\/api\/bot\/playbook$/, async ({ user, body }) => savePlaybook(db, user, body)],
    ['POST', /^\/api\/bot\/practice$/, async ({ user, body }) => practice(user, body, { interpret, phrase })],

    ['GET', /^\/api\/notifications$/, async ({ user }) => cases.listNotifications(db, user)],

    ['POST', /^\/api\/notifications\/read$/, async ({ user, body }) => {
      cases.markNotificationsRead(db, user, body.ids);
      return { ok: true };
    }],

    ['GET', /^\/api\/users$/, async ({ user }) => {
      requireRole(user, ...USER_ADMINS, 'it');
      // IT sees who the staff are, to issue tabs, without salaries or contact details.
      if (user.role === 'it') return { users: listUsers(db).map(({ id, name, hrms_code, sales_code, role, region, active, team_leader_name, sales_manager_name }) => ({ id, name, hrms_code, sales_code, role, region, active, team_leader_name, sales_manager_name })) };
      // A business head's salary is for the CEO, accounts and that business head only.
      return { users: listUsers(db).map((u) => withSalaryFor(user, u)) };
    }],

    // Boosters: product campaigns with dates, run by business heads and MIS.
    // The TAT switch: business heads and Dubai MIS hold late files as verified, and put them back.
    ['GET', /^\/api\/tat-switch$/, async ({ user }) => cases.tatSwitchStatus(db, user)],
    ['PUT', /^\/api\/tat-switch$/, async ({ user, body }) => cases.setTatSwitch(db, user, body.on)],
    ['GET', /^\/api\/tat-switch\/log$/, async ({ user }) => ({ log: cases.powerButtonLog(db, user) })],
    // Public holidays: read by everyone signed in, kept by MIS and business heads.
    ['GET', /^\/api\/holidays$/, async ({ user }) => ({ holidays: holidays.listHolidays(db), can_edit: holidays.canEditHolidays(user) })],
    ['POST', /^\/api\/holidays$/, async ({ user, body }) => holidays.addHoliday(db, user, body)],
    ['DELETE', /^\/api\/holidays\/(\d{4}-\d{2}-\d{2})$/, async ({ user, params }) => holidays.removeHoliday(db, user, params[0])],
    ['GET', /^\/api\/boosters$/, async ({ user }) => ({ boosters: boosters.listBoosters(db, user) })],
    ['POST', /^\/api\/boosters$/, async ({ user, body, res }) => send(res, 201, { booster: boosters.createBooster(db, user, body) })],
    ['PUT', /^\/api\/boosters\/(\d+)$/, async ({ user, params, body }) => ({ booster: boosters.updateBooster(db, user, params[0], body) })],
    ['DELETE', /^\/api\/boosters\/(\d+)$/, async ({ user, params }) => boosters.deleteBooster(db, user, params[0])],

    // Processor allocation: which processor verifies each sales team leader's files.
    ['GET', /^\/api\/allocations$/, async ({ user, query }) => allocations.listAllocations(db, user, { region: query.get('region') })],
    ['PUT', /^\/api\/allocations\/(\d+)$/, async ({ user, params, body }) => ({ allocation: allocations.setAllocation(db, user, params[0], { product: body.product, processor_id: body.processor_id }) })],

    // Roles: custom roles defined on top of the built-in ones, by IT, Dubai MIS and business heads.
    ['GET', /^\/api\/roles$/, async ({ user }) => {
      roles.requireRoleManager(user);
      return { builtin: Object.entries(roles.BUILTIN_ROLES).map(([key, r]) => ({ key, ...r, reports: reports.reportKeysForBase(key) })), custom: roles.customRoles(), pages: Object.fromEntries(Object.entries(roles.PAGES).map(([k, p]) => [k, { label: p.label, help: p.help }])), uploads: roles.UPLOAD_KINDS, reports: reports.reportCatalog(), usage: roles.roleUsage(db) };
    }],
    ['POST', /^\/api\/roles$/, async ({ user, body, res }) => send(res, 201, { role: roles.createRole(db, user, body, { reportsForBase: reports.reportKeysForBase }) })],
    ['PATCH', /^\/api\/roles\/([a-z0-9_]+)$/, async ({ user, params, body }) => ({ role: roles.updateRole(db, user, params[0], body, { reportsForBase: reports.reportKeysForBase }) })],
    ['DELETE', /^\/api\/roles\/([a-z0-9_]+)$/, async ({ user, params }) => roles.deleteRole(db, user, params[0])],
    ['POST', /^\/api\/roles\/([a-z0-9_]+)\/approve$/, async ({ user, params, body }) => ({ role: roles.decideRole(db, user, params[0], { approve: true, note: body.note }) })],
    ['POST', /^\/api\/roles\/([a-z0-9_]+)\/reject$/, async ({ user, params, body }) => ({ role: roles.decideRole(db, user, params[0], { approve: false, note: body.note }) })],

    // Assets: the sourcing tabs issued to sales staff. IT keeps the register; MIS and business heads see it too.
    ['GET', /^\/api\/assets$/, async ({ user, query }) => {
      requireRole(user, ...assets.ASSET_VIEWERS);
      return { assets: assets.listAssets(db, { status: query.get('status'), region: query.get('region'), network: query.get('network'), q: query.get('q') }), summary: assets.assetSummary(db) };
    }],
    ['GET', /^\/api\/assets\/mine$/, async ({ user }) => ({ asset: assets.assetOf(db, user.id) })],
    ['POST', /^\/api\/assets$/, async ({ user, body, res }) => send(res, 201, { asset: assets.createAsset(db, user, body) })],
    ['GET', /^\/api\/assets\/(\d+)$/, async ({ user, params }) => {
      const asset = assets.getAsset(db, Number(params[0]));
      if (!assets.ASSET_VIEWERS.includes(user.role) && asset.holder_id !== user.id) throw new HttpError(404, 'Asset not found');
      return { asset, events: assets.assetEvents(db, asset.id) };
    }],
    ['PATCH', /^\/api\/assets\/(\d+)$/, async ({ user, params, body }) => ({ asset: assets.updateAsset(db, user, Number(params[0]), body) })],
    ['POST', /^\/api\/assets\/(\d+)\/assign$/, async ({ user, params, body }) => ({ asset: assets.assignAsset(db, user, Number(params[0]), body) })],
    ['POST', /^\/api\/assets\/(\d+)\/status$/, async ({ user, params, body }) => ({ asset: assets.setAssetStatus(db, user, Number(params[0]), body) })],

    // Sales people in the viewer's own team, for entering a file on their behalf.
    ['GET', /^\/api\/sales-staff$/, async ({ user }) => {
      requireRole(user, 'team_leader', 'sales_manager', 'asm');
      return {
        staff: listUsers(db, { role: 'sales' }).filter((u) => cases.inTeamRow(user, u)).map(({ id, name, sales_code, team_leader_name, sales_manager_name, region, core_product }) =>
          ({ id, name, sales_code, team_leader_name, sales_manager_name, region, core_product })),
      };
    }],

    ['POST', /^\/api\/users$/, async ({ user, body, res }) => {
      requireRole(user, ...USER_ADMINS);
      try {
        send(res, 201, { user: auth.createUser(db, body, { requireMobile: true }) });
      } catch (err) {
        if (/UNIQUE|already exists/.test(err.message)) throw new HttpError(409, 'A user with that email already exists');
        throw new HttpError(400, err.message);
      }
    }],

    // Bulk upload: { csv, dry_run }. A dry run checks every row and saves nothing.
    // Bulk upload is for MIS and business heads only (checked in imports.js).
    ['POST', /^\/api\/import\/users$/, async ({ user, body }) => imports.importUsers(db, user, body.csv, { dryRun: Boolean(body.dry_run), update: Boolean(body.update) }), { maxBody: MAX_UPLOAD }],

    ['POST', /^\/api\/import\/case_status$/, async ({ user, body }) => imports.importCaseStatus(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['POST', /^\/api\/import\/cards$/, async ({ user, body }) => imports.importCards(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['POST', /^\/api\/import\/card_products$/, async ({ user, body }) => imports.importCardProducts(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['POST', /^\/api\/import\/targets$/, async ({ user, body }) => imports.importTargets(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    // Targets and achievement for a sales cycle (?cycle=2026-06, default the current one).
    ['GET', /^\/api\/targets$/, async ({ user, query }) => performance.targetReport(db, user, query.get('cycle'), { region: query.get('region') })],
    ['GET', /^\/api\/incentives\/me$/, async ({ user, query }) => myIncentive(db, user, query.get('cycle'))],
    ['PUT', /^\/api\/targets$/, async ({ user, body }) => performance.saveTargets(db, user, body)],
    // Sets every sales person's targets for a cycle from their salary and the salary-band rules.
    ['POST', /^\/api\/targets\/generate$/, async ({ user, body }) => performance.generateTargets(db, user, body.cycle)],
    ['POST', /^\/api\/import\/target_rules$/, async ({ user, body }) => imports.importTargetRules(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['GET', /^\/api\/ceo$/, async ({ user, query }) => ceoDashboard(db, user, { cycle: query.get('cycle'), region: query.get('region') })],
    ['GET', /^\/api\/pnl$/, async ({ user, query }) => ({ pnl: profitAndLoss(db, user, { cycle: query.get('cycle'), region: query.get('region') }), tree: profitAndLossTree(db, user, { cycle: query.get('cycle'), region: query.get('region') }) })],
    ['POST', /^\/api\/import\/assets$/, async ({ user, body }) => imports.importAssets(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['POST', /^\/api\/import\/payout_rules$/, async ({ user, body }) => imports.importPayoutRules(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    ['POST', /^\/api\/import\/cases$/, async ({ user, body }) => imports.importCases(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    // Removes users added by mistake. Anyone with activity is skipped and named; disable them instead.
    ['POST', /^\/api\/users\/delete$/, async ({ user, body }) => {
      requireRole(user, ...USER_ADMINS);
      try { return deleteUsers(db, user, body.ids); } catch (err) { throw new HttpError(400, err.message); }
    }],
    ['PATCH', /^\/api\/users\/(\d+)$/, async ({ user, params, body }) => {
      requireRole(user, ...USER_ADMINS);
      const id = Number(params[0]);
      const target = auth.getUser(db, id);
      if (!target) throw new HttpError(404, 'User not found');
      let moved = 0;
      if (['name', 'email', 'mobile_number', 'whatsapp_number', 'hrms_code', 'doj', 'dol'].some((f) => f in body)) {
        let contact;
        try {
          contact = contactDetails(body, { current: target });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        if (contact.email && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(contact.email, id)) {
          throw new HttpError(409, 'A user with that email already exists');
        }
        if (contact.hrms_code && db.prepare('SELECT 1 FROM users WHERE hrms_code = ? COLLATE NOCASE AND id != ?').get(contact.hrms_code, id)) {
          throw new HttpError(409, `HRMS code ${contact.hrms_code} is already used by another user`);
        }
        if (contact.dol && id === user.id) throw new HttpError(400, 'You cannot set your own date of leaving');
        for (const [field, value] of Object.entries(contact)) db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, id);
        // A leaving date that has arrived disables the account now; a future one does so on the day.
        sweepLeavers(db);
      }
      if ('role' in body) {
        const r = roles.resolveRole(body.role);
        if (id === user.id) throw new HttpError(400, 'You cannot change your own role');
        if (r.base !== 'sales' && target.role === 'sales') db.prepare('UPDATE users SET sales_code = NULL, team_leader_id = NULL, sales_manager_id = NULL, asm_id = NULL, salary = NULL, core_product = NULL WHERE id = ?').run(id);
        if (r.base === 'sales' && target.role !== 'sales') {
          let profile;
          try { profile = salesProfile(db, body); } catch (err) { throw new HttpError(400, `A sales role needs a sales profile: ${err.message}`); }
          db.prepare('UPDATE users SET sales_code = ?, team_leader_id = ?, sales_manager_id = ?, asm_id = ?, salary = ?, core_product = ? WHERE id = ?').run(profile.sales_code, profile.team_leader_id, profile.sales_manager_id, profile.asm_id, profile.salary, profile.core_product, id);
        }
        // A leader's reporting line comes with the role; any other role has none.
        if (LEADER_LINE_ROLES.includes(r.base)) {
          let line;
          try { line = leaderProfile(db, r.base, body, r.base === target.role ? target : null); } catch (err) { throw new HttpError(400, err.message); }
          db.prepare('UPDATE users SET sales_manager_id = ?, asm_id = ?, team_leader_id = NULL WHERE id = ?').run(line.sales_manager_id, line.asm_id, id);
        } else if (r.base !== 'sales' && LEADER_LINE_ROLES.includes(target.role)) {
          db.prepare('UPDATE users SET sales_manager_id = NULL, asm_id = NULL WHERE id = ?').run(id);
        }
        db.prepare('UPDATE users SET role = ?, role_key = ? WHERE id = ?').run(r.base, r.key, id);
        if (r.base !== target.role) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
        // The profile fields came with the role change and are done with.
        if (r.base !== target.role) body = Object.fromEntries(Object.entries(body).filter(([k]) => !['sales_code', 'team_leader_id', 'sales_manager_id', 'asm_id', 'salary', 'core_product'].includes(k)));
        else if (LEADER_LINE_ROLES.includes(r.base)) body = Object.fromEntries(Object.entries(body).filter(([k]) => !['sales_manager_id', 'asm_id'].includes(k)));
      }
      // A team leader's or ASM's reporting line, edited on its own.
      if (!('role' in body) && LEADER_LINE_ROLES.includes(target.role) && ['sales_manager_id', 'asm_id'].some((f) => f in body)) {
        let line;
        try { line = leaderProfile(db, target.role, body, target); } catch (err) { throw new HttpError(400, err.message); }
        db.prepare('UPDATE users SET sales_manager_id = ?, asm_id = ? WHERE id = ?').run(line.sales_manager_id, line.asm_id, id);
        body = Object.fromEntries(Object.entries(body).filter(([k]) => !['sales_manager_id', 'asm_id'].includes(k)));
      }
      if ('region' in body) {
        try {
          db.prepare('UPDATE users SET region = ? WHERE id = ?').run(regionOf(body.region), id);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
      }
      // Anyone's monthly salary feeds the profit and loss; a business head's is set only by those who may see it.
      if ('salary' in body && !canSeeSalary(user, target)) throw new HttpError(403, "A business head's salary is seen and set only by the CEO, accounts, or that business head");
      if ('salary' in body && target.role !== 'sales') {
        let salary;
        try { salary = salaryOf(body.salary); } catch (err) { throw new HttpError(400, err.message); }
        db.prepare('UPDATE users SET salary = ? WHERE id = ?').run(salary, id);
      }
      if (['sales_code', 'team_leader_id', 'sales_manager_id', 'asm_id', 'core_product'].some((f) => f in body) || (target.role === 'sales' && 'salary' in body)) {
        if (target.role !== 'sales') throw new HttpError(400, 'Only sales staff have a sales code, team leader and sales manager');
        let profile;
        try {
          profile = salesProfile(db, body, target);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        db.prepare('UPDATE users SET sales_code = ?, team_leader_id = ?, sales_manager_id = ?, asm_id = ?, salary = ?, core_product = ? WHERE id = ?')
          .run(profile.sales_code, profile.team_leader_id, profile.sales_manager_id, profile.asm_id, profile.salary, profile.core_product, id);
        if (['team_leader_id', 'sales_manager_id', 'asm_id'].some((f) => (profile[f] ?? null) !== (target[f] ?? null))) moved = cases.moveOpenCases(db, user, id);
      }
      if ('active' in body) {
        if (id === user.id && !body.active) throw new HttpError(400, 'You cannot deactivate your own account');
        if (body.active && target.dol && target.dol <= new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)) throw new HttpError(400, `${target.name} left on ${target.dol}. Clear the date of leaving to re-enable the account`);
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
        if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (body.password) {
        if (String(body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(body.password)), id);
      }
      return { user: auth.getUser(db, id), moved_cases: moved };
    }],
  ];
}

function serveStatic(req, res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(PUBLIC_DIR, rel));
  if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    // SPA fallback
    return serveFile(res, path.join(PUBLIC_DIR, 'index.html'));
  }
  return serveFile(res, file);
}

// The page names its script and stylesheet with the build, so a browser never keeps an old copy
// across an update; the module files the script imports are revalidated on every load.
function serveFile(res, file) {
  const type = MIME[path.extname(file)] || 'application/octet-stream';
  if (path.basename(file) === 'index.html') {
    const v = encodeURIComponent(buildInfo().commit || String(fs.statSync(file).mtimeMs));
    const html = fs.readFileSync(file, 'utf8').replace(/(href|src)="\/(styles\.css|app\.js)"/g, (m, attr, name) => `${attr}="/${name}?v=${v}"`);
    res.writeHead(200, { 'content-type': type, 'x-content-type-options': 'nosniff', 'cache-control': 'no-store' });
    return res.end(html);
  }
  const stat = fs.statSync(file);
  res.writeHead(200, {
    'content-type': type,
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
    'last-modified': stat.mtime.toUTCString(),
    etag: `"${stat.size}-${Math.floor(stat.mtimeMs)}"`,
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer(db, { dispatch = makeWebhookDispatcher(), itEmail = process.env.IT_EMAIL || null, callBot = {}, recordings = makeRecordingLookup(), interpret = aiConfigured() ? makeInterpreter() : null, phrase = aiConfigured() ? makePhraser() : null } = {}) {
  cases.config.itEmail = itEmail;
  loadCardProducts(db);
  holidays.loadHolidays(db);
  loadPayoutRules(db);
  roles.loadRoles(db);
  backfillCardCategories(db);
  sweepLeavers(db);
  const bot = makeCallBot(db, callBot);
  cases.config.callBot = bot.enabled;
  const table = routes(db, dispatch, bot, interpret, phrase, recordings);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (!url.pathname.startsWith('/api/')) {
        if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
        return serveStatic(req, res, url.pathname);
      }
      let matched;
      for (const [method, pattern, handler, opts = {}] of table) {
        const m = url.pathname.match(pattern);
        if (!m) continue;
        if (method !== req.method) {
          matched ??= null;
          continue;
        }
        matched = { handler, opts, params: m.slice(1) };
        break;
      }
      if (matched === undefined) throw new HttpError(404, 'Not found');
      if (matched === null) throw new HttpError(405, 'Method not allowed');

      const token = parseCookies(req.headers.cookie).sid;
      const info = {};
      const user = auth.userForToken(db, token, { active: req.headers['x-active'] === '1', info });
      if (!matched.opts.public && !user) throw new HttpError(401, info.idle ? `You were signed out after ${auth.IDLE_MINUTES} minute${auth.IDLE_MINUTES === 1 ? '' : 's'} without using the CRM. Sign in again.` : 'Please sign in');
      if (user) bot.seen(originOf(req));
      // The IT department works the asset register only: no files, chat, targets or staff changes.
      if (user?.role === 'it' && !IT_PATHS.test(url.pathname)) throw new HttpError(403, 'IT accounts manage assets only');
      // A custom role may have fewer screens, uploads and downloads than the role it is based on.
      if (user) {
        const blocked = roles.blockedPage(user, url.pathname);
        if (blocked) throw new HttpError(403, `Your role does not include ${roles.PAGES[blocked].label}`);
        if (url.searchParams.get('format') === 'csv' && !roles.allowsDownload(user)) throw new HttpError(403, 'Your role cannot download files');
      }
      const body = await readJson(req, matched.opts.maxBody);
      const result = await matched.handler({ req, res, user, token, body, params: matched.params, query: url.searchParams });
      if (!res.headersSent && result !== undefined) send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
  // Fire call-back alerts at the scheduled time, even when nobody is using the CRM.
  const timer = setInterval(() => {
    try { dispatch(cases.triggerDueCallbacks(db)); } catch (err) { console.error('[callbacks]', err); }
    try { sweepLeavers(db); } catch (err) { console.error('[leavers]', err); }
    // Approved bot calls that were waiting for calling hours.
    bot.sweep().catch((err) => console.error('[bot]', err));
  }, 30e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.bot = bot;
  return server;
}
