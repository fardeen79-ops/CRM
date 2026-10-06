import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as auth from './auth.js';
import * as cases from './cases.js';
import { CREDIT_CARDS } from './credit-cards.js';
import { BANKS } from './banks.js';
import { findUser, listUsers, salesProfile } from './users.js';

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

// Emirates ID scanner (Tesseract.js). Served from public/vendor/tesseract after `npm run setup:ocr`,
// otherwise from the jsDelivr CDN. Versions are pinned to match setup-ocr.js.
function ocrAssets() {
  if (fs.existsSync(path.join(PUBLIC_DIR, 'vendor', 'tesseract', 'tesseract.min.js'))) {
    return { script: '/vendor/tesseract/tesseract.min.js', workerPath: '/vendor/tesseract/worker.min.js', corePath: '/vendor/tesseract', langPath: '/vendor/tesseract', workerBlobURL: false };
  }
  const cdn = 'https://cdn.jsdelivr.net/npm';
  return {
    script: `${cdn}/tesseract.js@5.1.1/dist/tesseract.min.js`,
    workerPath: `${cdn}/tesseract.js@5.1.1/dist/worker.min.js`,
    corePath: `${cdn}/tesseract.js-core@5.1.1`,
    langPath: `${cdn}/@tesseract.js-data/eng@1.0.0/4.0.0_best_int`,
    workerBlobURL: true,
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
 * - recording.it_request -> IT_EMAIL_WEBHOOK_URL, an email relay (Power Automate, Zapier, an SMTP
 *   bridge...) that receives { to, subject, text } and sends the email to IT.
 */
export function makeWebhookDispatcher({
  tlUrl = process.env.TL_WEBHOOK_URL,
  emailUrl = process.env.IT_EMAIL_WEBHOOK_URL,
} = {}) {
  return (triggers) => {
    for (const t of triggers) {
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

async function readJson(req) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return {};
  // Requiring JSON blocks cross-site form posts (CSRF) along with SameSite cookies.
  if (!String(req.headers['content-type'] || '').includes('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  if (!size) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
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

function routes(db, dispatch) {
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
        banks: BANKS,
        case_statuses: cases.CASE_STATUS,
        regions: cases.REGIONS,
        core_products: cases.CORE_PRODUCTS,
        settable_case_statuses: cases.SETTABLE_CASE_STATUSES,
        edit_queues: cases.EDIT_QUEUES,
        recording_statuses: cases.RECORDING_STATUS,
        score_max: cases.SCORE_MAX,
        it_email: cases.config.itEmail,
        ocr: ocrAssets(),
      },
    })],

    ['GET', /^\/api\/stats$/, async ({ user }) => cases.stats(db, user)],

    ['GET', /^\/api\/cases$/, async ({ user, query }) => ({
      cases: cases.listCases(db, user, Object.fromEntries(query)),
    })],

    ['POST', /^\/api\/cases$/, async ({ user, body, res }) => {
      send(res, 201, { case: cases.createCase(db, user, body) });
    }],

    ['GET', /^\/api\/cases\/(\d+)$/, async ({ user, params }) => ({ case: cases.getCase(db, user, Number(params[0])) })],

    ['PUT', /^\/api\/cases\/(\d+)$/, async ({ user, params, body }) => ({
      case: cases.updateCase(db, user, Number(params[0]), body),
    })],

    ['POST', /^\/api\/cases\/(\d+)\/actions$/, async ({ user, params, body }) => {
      const result = cases.applyAction(db, user, Number(params[0]), body);
      dispatch(result.triggers);
      return { case: result.case };
    }],

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
        send(res, 201, { user: auth.createUser(db, body) });
      } catch (err) {
        if (/UNIQUE/.test(err.message)) throw new HttpError(409, 'A user with that email already exists');
        throw new HttpError(400, err.message);
      }
    }],

    ['PATCH', /^\/api\/users\/(\d+)$/, async ({ user, params, body }) => {
      requireRole(user, 'team_leader');
      const id = Number(params[0]);
      const target = auth.getUser(db, id);
      if (!target) throw new HttpError(404, 'User not found');
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

export function createServer(db, { dispatch = makeWebhookDispatcher(), itEmail = process.env.IT_EMAIL || null } = {}) {
  cases.config.itEmail = itEmail;
  const table = routes(db, dispatch);

  return http.createServer(async (req, res) => {
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
      const body = await readJson(req);
      const result = await matched.handler({ req, res, user, token, body, params: matched.params, query: url.searchParams });
      if (!res.headersSent && result !== undefined) send(res, 200, result);
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: status === 500 ? 'Internal server error' : err.message });
    }
  });
}
