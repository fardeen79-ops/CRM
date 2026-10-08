import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as cases from './cases.js';
import { CREDIT_CARDS } from './credit-cards.js';
import { BANKS } from './banks.js';
import { contactDetails, findUser, listUsers, salesProfile } from './users.js';
import * as imports from './imports.js';
import * as performance from './performance.js';
import { cycleOf, uaeDay } from './cycles.js';
import { makeCallBot } from './bot.js';

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

function routes(db, dispatch, bot) {
  return [
    ['POST', /^\/api\/login$/, async ({ body, res }) => {
      const result = auth.login(db, body.email, body.password);
      if (!result) throw new HttpError(401, 'Invalid email or password');
      send(res, 200, { user: result.user }, { 'set-cookie': sessionCookie(result.token, result.maxAge) });
    }, { public: true }],

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
        credit_cards: CREDIT_CARDS,
        personal_loan_types: cases.PERSONAL_LOAN_TYPES,
        card_fee_types: cases.CARD_FEE_TYPES,
        masked_fields: cases.MASKED_FIELDS,
        banks: BANKS,
        case_statuses: cases.CASE_STATUS,
        regions: cases.REGIONS,
        core_products: cases.CORE_PRODUCTS,
        settable_case_statuses: cases.SETTABLE_CASE_STATUSES,
        edit_queues: cases.EDIT_QUEUES,
        recording_statuses: cases.RECORDING_STATUS,
        score_max: cases.SCORE_MAX,
        callback_max_days: cases.CALLBACK_MAX_DAYS,
        it_email: cases.config.itEmail,
        call_bot: cases.config.callBot,
        ocr: ocrAssets(),
        import_columns: { users: imports.USER_IMPORT_COLUMNS, cases: imports.CASE_IMPORT_COLUMNS, cards: imports.CARD_IMPORT_COLUMNS, targets: imports.TARGET_IMPORT_COLUMNS },
        card_statuses: cases.CARD_STATES,
        card_range_days: cases.CARD_RANGE_DAYS,
        card_mappers: cases.CARD_MAPPERS,
        current_cycle: cycleOf(uaeDay()),
        import_max_rows: imports.MAX_ROWS,
      },
    })],

    ['GET', /^\/api\/stats$/, async ({ user }) => cases.stats(db, user)],

    ['GET', /^\/api\/cases$/, async ({ user, query }) => ({
      cases: cases.listCases(db, user, Object.fromEntries(query)),
    })],

    ['POST', /^\/api\/cases$/, async ({ user, body, res }) => {
      send(res, 201, { case: cases.createCase(db, user, body) });
    }],

    ['GET', /^\/api\/cases\/(\d+)$/, async ({ user, params }) => {
      const result = cases.getCase(db, user, Number(params[0]));
      cases.logAccess(db, user, Number(params[0]), 'view');
      return { case: result };
    }],

    // Full value of a masked personal detail (?fields=phone,eid_number); every reveal is logged.
    ['GET', /^\/api\/cases\/(\d+)\/reveal$/, async ({ user, params, query }) => cases.revealFields(db, user, Number(params[0]), query.get('fields'))],
    ['GET', /^\/api\/access-log$/, async ({ user, query }) => cases.listAccessLog(db, user, Object.fromEntries(query))],

    ['PUT', /^\/api\/cases\/(\d+)$/, async ({ user, params, body }) => ({
      case: cases.updateCase(db, user, Number(params[0]), body),
    })],

    ['POST', /^\/api\/cases\/(\d+)\/actions$/, async ({ req, user, params, body }) => {
      const result = cases.applyAction(db, user, Number(params[0]), body);
      dispatch(result.triggers);
      // Wait for the bot service to accept the call, so a refusal shows on the case straight away.
      if (result.triggers.some((t) => t.event === 'bot_call.request')) {
        await bot.deliver(result.triggers, originOf(req));
        return { case: cases.getCase(db, user, Number(params[0])) };
      }
      return { case: result.case };
    }],

    // Result of a bot verification call. The token in the URL identifies the call; with
    // CALL_BOT_SECRET set the body must also be signed (x-crm-signature).
    ['POST', /^\/api\/bot\/calls\/([a-f0-9]{48})$/, async ({ req, params, body }) =>
      bot.receive(params[0], req.rawBody || '', req.headers['x-crm-signature'], body), { public: true }],

    ['GET', /^\/api\/notifications$/, async ({ user }) => cases.listNotifications(db, user)],

    ['POST', /^\/api\/notifications\/read$/, async ({ user, body }) => {
      cases.markNotificationsRead(db, user, body.ids);
      return { ok: true };
    }],

    ['GET', /^\/api\/users$/, async ({ user }) => {
      requireRole(user, 'team_leader');
      return { users: listUsers(db) };
    }],

    // Sales people a team leader or sales manager can enter a file for, with their profile.
    ['GET', /^\/api\/sales-staff$/, async ({ user }) => {
      requireRole(user, 'team_leader', 'sales_manager');
      return {
        staff: listUsers(db, { role: 'sales' }).map(({ id, name, sales_code, team_leader_name, sales_manager_name }) =>
          ({ id, name, sales_code, team_leader_name, sales_manager_name })),
      };
    }],

    ['POST', /^\/api\/users$/, async ({ user, body, res }) => {
      requireRole(user, 'team_leader');
      try {
        send(res, 201, { user: auth.createUser(db, body, { requireMobile: true }) });
      } catch (err) {
        if (/UNIQUE|already exists/.test(err.message)) throw new HttpError(409, 'A user with that email already exists');
        throw new HttpError(400, err.message);
      }
    }],

    // Bulk upload: { csv, dry_run }. A dry run checks every row and saves nothing.
    // Bulk upload is for MIS and business heads only (checked in imports.js).
    ['POST', /^\/api\/import\/users$/, async ({ user, body }) => imports.importUsers(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    ['POST', /^\/api\/import\/cards$/, async ({ user, body }) => imports.importCards(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],
    ['POST', /^\/api\/import\/targets$/, async ({ user, body }) => imports.importTargets(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    // Targets and achievement for a sales cycle (?cycle=2026-06, default the current one).
    ['GET', /^\/api\/targets$/, async ({ user, query }) => performance.targetReport(db, user, query.get('cycle'))],
    ['PUT', /^\/api\/targets$/, async ({ user, body }) => performance.saveTargets(db, user, body)],

    ['POST', /^\/api\/import\/cases$/, async ({ user, body }) => imports.importCases(db, user, body.csv, { dryRun: Boolean(body.dry_run) }), { maxBody: MAX_UPLOAD }],

    ['PATCH', /^\/api\/users\/(\d+)$/, async ({ user, params, body }) => {
      requireRole(user, 'team_leader');
      const id = Number(params[0]);
      const target = auth.getUser(db, id);
      if (!target) throw new HttpError(404, 'User not found');
      if (['name', 'email', 'mobile_number', 'whatsapp_number'].some((f) => f in body)) {
        let contact;
        try {
          contact = contactDetails(body, { current: target });
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        if (contact.email && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(contact.email, id)) {
          throw new HttpError(409, 'A user with that email already exists');
        }
        for (const [field, value] of Object.entries(contact)) db.prepare(`UPDATE users SET ${field} = ? WHERE id = ?`).run(value, id);
      }
      if (['sales_code', 'team_leader_id', 'sales_manager_id'].some((f) => f in body)) {
        if (target.role !== 'sales') throw new HttpError(400, 'Only sales staff have a sales code, team leader and sales manager');
        let profile;
        try {
          profile = salesProfile(db, body, target);
        } catch (err) {
          throw new HttpError(400, err.message);
        }
        db.prepare('UPDATE users SET sales_code = ?, team_leader_id = ?, sales_manager_id = ? WHERE id = ?')
          .run(profile.sales_code, profile.team_leader_id, profile.sales_manager_id, id);
      }
      if ('active' in body) {
        if (id === user.id && !body.active) throw new HttpError(400, 'You cannot deactivate your own account');
        db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
        if (!body.active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      }
      if (body.password) {
        if (String(body.password).length < 8) throw new HttpError(400, 'Password must be at least 8 characters');
        db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(auth.hashPassword(String(body.password)), id);
      }
      return { user: auth.getUser(db, id) };
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

function serveFile(res, file) {
  res.writeHead(200, {
    'content-type': MIME[path.extname(file)] || 'application/octet-stream',
    'x-content-type-options': 'nosniff',
    'cache-control': 'no-cache',
  });
  fs.createReadStream(file).pipe(res);
}

export function createServer(db, { dispatch = makeWebhookDispatcher(), itEmail = process.env.IT_EMAIL || null, callBot = {} } = {}) {
  cases.config.itEmail = itEmail;
  const bot = makeCallBot(db, callBot);
  cases.config.callBot = bot.enabled;
  const table = routes(db, dispatch, bot);

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
      const user = auth.userForToken(db, token);
      if (!matched.opts.public && !user) throw new HttpError(401, 'Please sign in');
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
  }, 30e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  return server;
}
