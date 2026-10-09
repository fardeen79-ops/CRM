import crypto from 'node:crypto';
import { transaction } from './db.js';
import { hashPassword } from './auth.js';
import { BOT_EMAIL } from './users.js';
import {
  CALL_OUTCOMES, PRODUCTS, STATUS, WorkflowError, addEvent, applyAction, caseProducts, caseRef, notify, processorsFor, productLabel, timing,
} from './cases.js';
import {
  CHECK_RESULTS, DEFAULT_PLAYBOOK, FIELDS, LANGUAGES, MATCH_TYPES, PLACEHOLDERS, RULE_CHOICES, SCRIPT_LABELS, STRICTNESS,
  buildChecks, callResult, hear, normalizePlaybook, spoken, startCall,
} from './bot-engine.js';

export { CHECK_RESULTS };

/**
 * Verification calls through the calling bot.
 *
 * Teaching: business heads and the verification team leader teach the bot on the Verification bot
 * page: what it says, which details it checks and how strictly, the words it understands as yes and
 * no, and what it may do with a result. They practise with it by typing a customer's answers.
 *
 * Calling: a processor chooses "Call with bot" (or the bot calls new files and retries on its own,
 * if taught to). The CRM POSTs the call to CALL_BOT_URL with the customer's number, the playbook,
 * the checks with the values on file, and a callback URL with a one-time token. The calling service
 * (bot/server.js, or any service speaking the same protocol) phones the customer and POSTs the
 * result back.
 *
 * Results: the call is logged on the case. Depending on the playbook's rules the bot then completes
 * the verification (every detail confirmed), marks it pending for the team leader (a detail did not
 * match, or the customer could not be reached after the set attempts), or leaves it for a processor.
 *
 * With CALL_BOT_SECRET set, both directions are signed: header x-crm-signature: sha256=<hex>, an
 * HMAC-SHA256 of the raw request body. The CRM refuses results without a valid signature.
 */

const FINAL_STATUSES = ['completed', 'failed'];
const PLAYBOOK_KEY = 'bot_playbook';

export function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function signatureValid(secret, body, header) {
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(String(header || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** Who teaches the bot: business heads and the verification team leader. */
export const canTeachBot = (user) => user.role === 'business_head' || (user.role === 'processing' && user.role_key === 'processing_lead');
const requireTeacher = (user) => {
  if (!canTeachBot(user)) throw new WorkflowError(403, 'Only business heads and the verification team leader teach the bot');
};

/** The playbook the bot works from: the taught one, or the defaults. */
export function getPlaybook(db) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(PLAYBOOK_KEY);
  if (!row) return normalizePlaybook(DEFAULT_PLAYBOOK);
  try {
    return normalizePlaybook(JSON.parse(row.value));
  } catch {
    return normalizePlaybook(DEFAULT_PLAYBOOK);
  }
}

/** The teaching page: the playbook, who last changed it, and how the bot has done lately. */
export function playbookView(db, user, { enabled }) {
  requireTeacher(user);
  const saved = db.prepare('SELECT s.updated_at, u.name AS updated_by_name FROM settings s LEFT JOIN users u ON u.id = s.updated_by WHERE s.key = ?').get(PLAYBOOK_KEY);
  const since = new Date(Date.now() - 30 * 864e5).toISOString();
  const bot = db.prepare('SELECT id FROM users WHERE email = ?').get(BOT_EMAIL);
  const stats = db.prepare(`SELECT COUNT(*) AS calls,
      SUM(status = 'completed' AND outcome = 'connected') AS reached,
      SUM(status = 'completed' AND outcome != 'connected') AS not_reached,
      SUM(status = 'failed') AS failed
    FROM bot_calls WHERE requested_at >= ?`).get(since);
  const verdicts = bot ? db.prepare(`SELECT
      SUM(type = 'complete') AS completed, SUM(type = 'mark_incomplete') AS pending
    FROM case_events WHERE user_id = ? AND created_at >= ?`).get(bot.id, since) : {};
  for (const k of ['calls', 'reached', 'not_reached', 'failed']) stats[k] ??= 0;
  return {
    playbook: getPlaybook(db),
    defaults: normalizePlaybook(DEFAULT_PLAYBOOK),
    updated_at: saved?.updated_at ?? null,
    updated_by_name: saved?.updated_by_name ?? null,
    enabled,
    stats: { ...stats, verified: verdicts.completed ?? 0, marked_pending: verdicts.pending ?? 0 },
    meta: {
      fields: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.label])),
      default_match: Object.fromEntries(Object.entries(FIELDS).map(([k, v]) => [k, v.match])),
      match_types: MATCH_TYPES, strictness: STRICTNESS, languages: LANGUAGES, rule_choices: RULE_CHOICES,
      script_labels: SCRIPT_LABELS, placeholders: PLACEHOLDERS,
    },
  };
}

export function savePlaybook(db, user, input) {
  requireTeacher(user);
  const playbook = normalizePlaybook(input?.playbook ?? input);
  db.prepare(`INSERT INTO settings (key, value, updated_by, updated_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
    .run(PLAYBOOK_KEY, JSON.stringify(playbook), user.id, new Date().toISOString());
  return { playbook };
}

/**
 * A practice call on the teaching page, replayed from the start with the answers typed so far.
 * Uses a made-up customer, so nothing from a real file is shown to the person teaching.
 */
export function practice(user, { playbook, sample = {}, answers = [] } = {}) {
  requireTeacher(user);
  const pb = normalizePlaybook(playbook);
  if (!Array.isArray(answers) || answers.length > 60) throw new WorkflowError(400, 'Too many answers for one practice call');
  const values = {};
  for (const k of Object.keys(FIELDS)) {
    const v = String(sample[k] ?? '').trim().slice(0, 200);
    if (v) values[k] = ['salary', 'loan_amount'].includes(k) ? Number(v.replace(/[^\d.]/g, '')) || null : v;
  }
  values.full_name ||= [values.first_name, values.last_name].filter(Boolean).join(' ') || null;
  values.first_name ||= values.full_name?.split(' ')[0] || null;
  let state = startCall(pb, { values });
  for (const a of answers) state = hear(state, pb, String(a ?? '').slice(0, 500));
  const result = state.done ? callResult(state) : null;
  return {
    turns: state.turns,
    done: state.done,
    outcome: state.outcome,
    checks: state.checks.map(({ key, label, result: r, heard }) => ({ key, label, result: r, heard })),
    summary: result?.summary ?? null,
    stage: state.stage,
  };
}

/** The file's details by FIELDS key; the product lists the ways a customer may name it. */
export function fieldValues(row) {
  const full = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ') || row.customer_name;
  const label = productLabel(row.product, row.bundle_products, row.credit_card, row.personal_loan_type, row.buyout_bank);
  const names = caseProducts(row).map((p) => PRODUCTS[p] || p).filter(Boolean);
  const product = label ? [names.join(' and '), label, ...(row.credit_card ? [row.credit_card] : [])].filter(Boolean) : null;
  return {
    full_name: full,
    first_name: row.first_name || String(row.customer_name || '').split(' ')[0],
    last_name: row.last_name || String(row.customer_name || '').split(' ').slice(1).join(' ') || null,
    product,
    credit_card: row.credit_card || null,
    company_name: row.company_name || null,
    salary: row.salary ?? null,
    loan_amount: row.loan_amount ?? null,
    city: row.city || null,
  };
}

/** The details the bot asks the customer to confirm, with the values on file to compare against. */
export function verificationChecks(row, playbook) {
  return buildChecks(playbook, fieldValues(row)).map(({ key, label, question, match, strictness, expected }) => ({ key, label, question, match, strictness, expected }));
}

/** The bot's own account, which its verification results are recorded under. It cannot sign in. */
export function botUser(db) {
  let row = db.prepare('SELECT id, name FROM users WHERE email = ?').get(BOT_EMAIL);
  if (!row) {
    const r = db.prepare('INSERT INTO users (name, email, role, password_hash, active) VALUES (?, ?, ?, ?, 0)')
      .run('Verification Bot', BOT_EMAIL, 'processing', hashPassword(crypto.randomBytes(24).toString('hex')));
    row = { id: Number(r.lastInsertRowid), name: 'Verification Bot' };
  }
  // Works every file, like the verification team leader, regardless of region or allocation.
  return { id: row.id, name: row.name, email: BOT_EMAIL, role: 'processing', role_key: 'processing_lead', region: null, active: 1, is_bot: true };
}

class BotError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function clean(value, max) {
  if (value === undefined || value === null) return null;
  const s = String(value).trim();
  return s ? s.slice(0, max) : null;
}

const OPEN = [STATUS.PENDING, STATUS.IN_VERIFICATION];

/** Time of day and weekday in the UAE, for calling hours. */
function uaeClock(ms) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Dubai', hour: '2-digit', minute: '2-digit', weekday: 'short', hourCycle: 'h23' })
    .formatToParts(new Date(ms)).map((p) => [p.type, p.value]));
  return { time: `${parts.hour}:${parts.minute}`, sunday: parts.weekday === 'Sun' };
}
export function withinCallingHours(rules, ms = timing.now()) {
  const { time, sunday } = uaeClock(ms);
  return (!sunday || rules.call_sunday) && time >= rules.call_from && time < rules.call_to;
}

export function makeCallBot(db, { url = process.env.CALL_BOT_URL, secret = process.env.CALL_BOT_SECRET, publicUrl = process.env.PUBLIC_URL } = {}) {
  const enabled = Boolean(url);
  let lastOrigin = null;
  let sweeping = false;

  const fail = (callId, error) => {
    const ts = new Date().toISOString();
    transaction(db, () => {
      const call = db.prepare('SELECT * FROM bot_calls WHERE id = ?').get(callId);
      if (!call || !['requested', 'in_progress'].includes(call.status)) return;
      db.prepare("UPDATE bot_calls SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(ts, error, callId);
      db.prepare("UPDATE cases SET bot_call_status = 'failed' WHERE id = ? AND bot_call_at = ?").run(call.case_id, call.requested_at);
      addEvent(db, call.case_id, null, 'bot_call_failed', { note: error });
      const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(call.case_id);
      notify(db, humanFor(row, call), call.case_id, `${caseRef(call.case_id)}: the bot could not place the call (${error}). Call the customer yourself or try again.`);
    });
  };

  // Who hears about a bot call: the processor on the file, else whoever asked for it, else (for the
  // bot's own calls) the processors the file is routed to.
  const humanFor = (row, call) => {
    const bot = db.prepare('SELECT id FROM users WHERE email = ?').get(BOT_EMAIL)?.id;
    if (row.assigned_to && row.assigned_to !== bot) return [row.assigned_to];
    if (call.requested_by !== bot) return [call.requested_by];
    return processorsFor(db, row);
  };

  /** Sends bot_call.request triggers from a workflow action. `origin` is the CRM's own address. */
  async function deliver(triggers, origin) {
    const playbook = getPlaybook(db);
    for (const t of triggers.filter((x) => x.event === 'bot_call.request')) {
      const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(t.case_id);
      const values = fieldValues(row);
      const checks = verificationChecks(row, playbook);
      db.prepare('UPDATE bot_calls SET asked = ? WHERE id = ?').run(JSON.stringify(checks.map(({ key, label }) => ({ key, label }))), t.call_id);
      const { rules, ...script } = playbook;
      const body = JSON.stringify({
        event: 'verification_call.request',
        call_id: t.call_id,
        case_id: t.case_id,
        ref: t.ref,
        callback_url: `${(publicUrl || origin || lastOrigin || '').replace(/\/$/, '')}/api/bot/calls/${t.token}`,
        customer: { name: row.customer_name, phone: row.phone, alt_phone: row.alt_phone || null },
        checks,
        values: spoken(playbook, values),
        playbook: script,
        check_results: CHECK_RESULTS,
        call_outcomes: CALL_OUTCOMES,
      });
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(secret && { 'x-crm-signature': sign(secret, body) }) },
          body,
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const reason = await res.json().then((j) => j?.error).catch(() => null);
          throw new Error(reason ? String(reason).slice(0, 300) : `bot service answered ${res.status}`);
        }
      } catch (err) {
        console.error(`[bot] call request for ${t.ref} failed: ${err.message}`);
        fail(t.call_id, err.name === 'TimeoutError' ? 'bot service did not answer' : err.message);
      }
    }
  }

  // Bot calls since the file last went back into the queue that did not reach the customer.
  const missedAttempts = (caseId) => db.prepare(`SELECT COUNT(*) AS n FROM bot_calls WHERE case_id = ? AND status = 'completed' AND outcome != 'connected'
    AND requested_at > COALESCE((SELECT MAX(created_at) FROM case_events WHERE case_id = ? AND type IN ('reverify', 'resubmit')), '')`).get(caseId, caseId).n;

  /**
   * Result from the bot: { status: 'in_progress' | 'completed' | 'failed', outcome, checks:
   * [{ key, result }], summary, transcript, recording_url, error }. Returns triggers to dispatch.
   */
  function receive(token, raw, signature, input) {
    if (!enabled) throw new BotError(404, 'Not found');
    if (secret && !signatureValid(secret, raw, signature)) throw new BotError(401, 'Invalid signature');
    const call = db.prepare('SELECT * FROM bot_calls WHERE token = ?').get(String(token));
    if (!call) throw new BotError(404, 'Unknown call');
    if (!['requested', 'in_progress'].includes(call.status)) throw new BotError(409, `This call is already ${call.status}`);

    const status = input.status;
    if (status !== 'in_progress' && !FINAL_STATUSES.includes(status)) {
      throw new BotError(400, 'status must be one of: in_progress, completed, failed');
    }
    const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(call.case_id);
    const ref = caseRef(call.case_id);
    const ts = new Date().toISOString();

    if (status === 'in_progress') {
      db.prepare("UPDATE bot_calls SET status = 'in_progress' WHERE id = ?").run(call.id);
      db.prepare("UPDATE cases SET bot_call_status = 'in_progress' WHERE id = ? AND bot_call_at = ?").run(call.case_id, call.requested_at);
      return { ok: true, triggers: [] };
    }
    if (status === 'failed') {
      fail(call.id, clean(input.error, 500) || 'the bot reported a failure');
      return { ok: true, triggers: [] };
    }

    if (!CALL_OUTCOMES.includes(input.outcome)) throw new BotError(400, `outcome must be one of: ${CALL_OUTCOMES.join(', ')}`);
    const asked = call.asked ? JSON.parse(call.asked) : verificationChecks(row, getPlaybook(db));
    const given = Array.isArray(input.checks) ? input.checks : [];
    for (const c of given) {
      if (!asked.some((a) => a.key === c?.key)) throw new BotError(400, `Unknown check: ${c?.key}`);
      if (!CHECK_RESULTS.includes(c.result)) throw new BotError(400, `Check result must be one of: ${CHECK_RESULTS.join(', ')}`);
    }
    // Only the outcome of each check is kept; what the customer said stays in the transcript.
    const checks = asked.map(({ key, label }) => ({ key, label, result: given.find((c) => c.key === key)?.result || 'not_answered' }));
    const recordingUrl = clean(input.recording_url, 1000);
    if (recordingUrl && !/^https?:\/\//i.test(recordingUrl)) throw new BotError(400, 'recording_url must be an http(s) link');
    const summary = clean(input.summary, 2000);

    const mismatched = checks.filter((c) => c.result === 'mismatch');
    const confirmed = checks.filter((c) => c.result === 'confirmed');
    const reached = input.outcome === 'connected';
    let headline;
    if (!reached) headline = `the customer was not reached (${input.outcome.replace(/_/g, ' ')})`;
    else if (mismatched.length) headline = `${mismatched.length} detail${mismatched.length > 1 ? 's' : ''} did not match: ${mismatched.map((c) => c.label).join(', ')}`;
    else if (checks.length && confirmed.length === checks.length) headline = `all ${checks.length} details confirmed`;
    else headline = `${confirmed.length} of ${checks.length} details confirmed`;

    transaction(db, () => {
      db.prepare(`UPDATE bot_calls SET status = 'completed', finished_at = ?, outcome = ?, checks = ?, summary = ?, transcript = ?, recording_url = ? WHERE id = ?`)
        .run(ts, input.outcome, JSON.stringify(checks), summary, clean(input.transcript, 50_000), recordingUrl, call.id);
      db.prepare("UPDATE cases SET bot_call_status = 'completed', call_attempts = call_attempts + 1, updated_at = ? WHERE id = ?").run(ts, call.case_id);
      addEvent(db, call.case_id, null, 'bot_call_result', { detail: input.outcome, note: [`Bot call: ${headline}.`, summary].filter(Boolean).join(' ') });
    });

    // What the playbook lets the bot do with this result.
    const { rules } = getPlaybook(db);
    const open = OPEN.includes(row.status);
    const missed = reached ? 0 : missedAttempts(call.case_id);
    let verdict = null;
    if (open && reached && checks.length && confirmed.length === checks.length && rules.all_confirmed === 'complete') {
      verdict = { action: 'complete', note: `Verified by the calling bot: ${headline}.` };
    } else if (open && reached && mismatched.length && rules.mismatch === 'pending') {
      verdict = { action: 'mark_incomplete', reason: 'incorrect_details', note: `Calling bot: ${headline}.${summary ? ` ${summary}` : ''}` };
    } else if (open && !reached && missed >= rules.max_attempts && rules.not_reached === 'pending') {
      verdict = { action: 'mark_incomplete', reason: 'customer_unreachable', note: `The calling bot could not reach the customer in ${missed} ${missed === 1 ? 'attempt' : 'attempts'}.` };
    }
    let triggers = [];
    if (verdict) {
      try {
        triggers = applyAction(db, botUser(db), call.case_id, verdict).triggers;
      } catch (err) {
        console.error(`[bot] could not apply the bot's result to ${ref}: ${err.message}`);
        verdict = null;
      }
    }
    const retrying = open && !reached && !verdict && missed < rules.max_attempts;
    let message;
    if (verdict?.action === 'complete') message = `${ref} (${row.customer_name}) verified by the calling bot: ${headline}.`;
    else if (verdict) message = `${ref} (${row.customer_name}) bot call: ${headline}. Verification marked pending for the team leader.`;
    else if (retrying) message = null; // The bot tries again later; nobody needs to act yet.
    else message = `${ref} (${row.customer_name}) bot call: ${headline}.${open ? ' Review it and save the verification result.' : ''}`;
    if (message) notify(db, humanFor(row, call), call.case_id, message);
    return { ok: true, triggers };
  }

  /**
   * The bot's own calls, run on the server's timer: new files (when taught to call them) and
   * another attempt at customers it could not reach, within the playbook's calling hours.
   */
  async function sweep() {
    if (!enabled || sweeping) return [];
    const origin = publicUrl || lastOrigin;
    if (!origin) return [];
    const { rules } = getPlaybook(db);
    if (!withinCallingHours(rules)) return [];
    sweeping = true;
    const placed = [];
    try {
      const due = [];
      if (rules.auto_call_new) {
        due.push(...db.prepare(`SELECT id FROM cases WHERE status = ? AND assigned_to IS NULL AND bot_call_status IS NULL ORDER BY created_at LIMIT 5`).all(STATUS.PENDING).map((r) => r.id));
      }
      const missed = db.prepare(`SELECT c.id, b.finished_at FROM cases c JOIN bot_calls b ON b.id = (SELECT MAX(id) FROM bot_calls WHERE case_id = c.id)
        WHERE c.status IN (?, ?) AND c.bot_call_status = 'completed' AND b.outcome != 'connected' ORDER BY b.finished_at LIMIT 20`).all(...OPEN);
      for (const m of missed) {
        if (Date.now() - Date.parse(m.finished_at) < rules.retry_minutes * 60e3) continue;
        if (missedAttempts(m.id) >= rules.max_attempts) continue;
        // A processor has called the customer since: leave the file to them.
        if (db.prepare("SELECT 1 FROM case_events WHERE case_id = ? AND type = 'log_call' AND created_at > ?").get(m.id, m.finished_at)) continue;
        due.push(m.id);
      }
      const bot = botUser(db);
      for (const id of [...new Set(due)].slice(0, 10)) {
        try {
          const { triggers } = applyAction(db, bot, id, { action: 'bot_call' });
          await deliver(triggers, origin);
          placed.push(id);
        } catch (err) {
          if (!(err instanceof WorkflowError)) console.error(`[bot] automatic call for ${caseRef(id)} failed: ${err.message}`);
        }
      }
    } finally {
      sweeping = false;
    }
    return placed;
  }

  return {
    enabled, deliver, receive, sweep,
    /** Remembers the CRM's address from requests, for callback URLs when PUBLIC_URL is not set. */
    seen(origin) { lastOrigin = origin; },
  };
}
