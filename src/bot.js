import crypto from 'node:crypto';
import { transaction } from './db.js';
import { CALL_OUTCOMES, STATUS, addEvent, caseRef, notify, productLabel } from './cases.js';

/**
 * Verification calls through a calling bot (a voice AI or IVR provider, or your own service).
 *
 * 1. A processor chooses "Call with bot". The CRM POSTs the call request to CALL_BOT_URL:
 *    the customer's number, a callback URL and the checks to make, each with the value on file.
 * 2. The bot calls the customer, asks them to confirm each detail and POSTs the result to the
 *    callback URL. The URL carries a one-time token for that call.
 * 3. The result is logged on the case like a call, and the processor is told. The processor still
 *    sets the verification result; the bot never completes, holds or rejects a verification.
 *
 * With CALL_BOT_SECRET set, both directions are signed: header x-crm-signature: sha256=<hex>, an
 * HMAC-SHA256 of the raw request body. The CRM refuses results without a valid signature.
 */

export const CHECK_RESULTS = ['confirmed', 'mismatch', 'not_answered'];
const FINAL_STATUSES = ['completed', 'failed'];

export function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

function signatureValid(secret, body, header) {
  const expected = Buffer.from(sign(secret, body));
  const actual = Buffer.from(String(header || ''));
  return actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}

/** The details the bot asks the customer to confirm, with the values on file to compare against. */
export function verificationChecks(row) {
  const checks = [];
  const name = [row.first_name, row.middle_name, row.last_name].filter(Boolean).join(' ') || row.customer_name;
  checks.push({ key: 'full_name', label: 'Full name', question: 'Please confirm your full name.', expected: name });
  const product = productLabel(row.product, row.bundle_products, row.credit_card, row.personal_loan_type, row.buyout_bank);
  if (product) checks.push({ key: 'product', label: 'Product applied for', question: 'Which product did you apply for?', expected: product });
  if (row.company_name) checks.push({ key: 'company_name', label: 'Employer', question: 'What is the name of the company you work for?', expected: row.company_name });
  if (row.salary != null) checks.push({ key: 'salary', label: 'Monthly salary', question: 'What is your monthly salary in AED?', expected: String(row.salary) });
  const eid = String(row.eid_number || '').replace(/\D/g, '');
  if (eid) checks.push({ key: 'eid_last4', label: 'Emirates ID (last 4 digits)', question: 'What are the last four digits of your Emirates ID?', expected: eid.slice(-4) });
  return checks;
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

export function makeCallBot(db, { url = process.env.CALL_BOT_URL, secret = process.env.CALL_BOT_SECRET, publicUrl = process.env.PUBLIC_URL } = {}) {
  const enabled = Boolean(url);

  const fail = (callId, error) => {
    const ts = new Date().toISOString();
    transaction(db, () => {
      const call = db.prepare('SELECT * FROM bot_calls WHERE id = ?').get(callId);
      if (!call || !['requested', 'in_progress'].includes(call.status)) return;
      db.prepare("UPDATE bot_calls SET status = 'failed', finished_at = ?, error = ? WHERE id = ?").run(ts, error, callId);
      db.prepare("UPDATE cases SET bot_call_status = 'failed' WHERE id = ? AND bot_call_at = ?").run(call.case_id, call.requested_at);
      addEvent(db, call.case_id, null, 'bot_call_failed', { note: error });
      notify(db, [call.requested_by], call.case_id, `${caseRef(call.case_id)}: the bot could not place the call (${error}). Call the customer yourself or try again.`);
    });
  };

  /** Sends bot_call.request triggers from a workflow action. `origin` is the CRM's own address. */
  async function deliver(triggers, origin) {
    for (const t of triggers.filter((x) => x.event === 'bot_call.request')) {
      const row = db.prepare('SELECT * FROM cases WHERE id = ?').get(t.case_id);
      const body = JSON.stringify({
        event: 'verification_call.request',
        call_id: t.call_id,
        case_id: t.case_id,
        ref: t.ref,
        callback_url: `${(publicUrl || origin).replace(/\/$/, '')}/api/bot/calls/${t.token}`,
        customer: { name: row.customer_name, phone: row.phone, alt_phone: row.alt_phone || null },
        checks: verificationChecks(row),
        check_results: CHECK_RESULTS,
        call_outcomes: CALL_OUTCOMES,
      });
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(secret && { 'x-crm-signature': sign(secret, body) }) },
          body,
          signal: AbortSignal.timeout(10_000),
        });
        if (!res.ok) throw new Error(`bot service answered ${res.status}`);
      } catch (err) {
        console.error(`[bot] call request for ${t.ref} failed: ${err.message}`);
        fail(t.call_id, err.name === 'TimeoutError' ? 'bot service did not answer' : err.message);
      }
    }
  }

  /**
   * Result from the bot: { status: 'in_progress' | 'completed' | 'failed', outcome, checks:
   * [{ key, result }], summary, transcript, recording_url, error }.
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
      return { ok: true };
    }
    if (status === 'failed') {
      fail(call.id, clean(input.error, 500) || 'the bot reported a failure');
      return { ok: true };
    }

    if (!CALL_OUTCOMES.includes(input.outcome)) throw new BotError(400, `outcome must be one of: ${CALL_OUTCOMES.join(', ')}`);
    const asked = verificationChecks(row);
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
    let headline;
    if (input.outcome !== 'connected') headline = `the customer was not reached (${input.outcome.replace(/_/g, ' ')})`;
    else if (mismatched.length) headline = `${mismatched.length} detail${mismatched.length > 1 ? 's' : ''} did not match: ${mismatched.map((c) => c.label).join(', ')}`;
    else if (confirmed.length === checks.length) headline = `all ${checks.length} details confirmed`;
    else headline = `${confirmed.length} of ${checks.length} details confirmed`;

    transaction(db, () => {
      db.prepare(`UPDATE bot_calls SET status = 'completed', finished_at = ?, outcome = ?, checks = ?, summary = ?, transcript = ?, recording_url = ? WHERE id = ?`)
        .run(ts, input.outcome, JSON.stringify(checks), summary, clean(input.transcript, 50_000), recordingUrl, call.id);
      db.prepare("UPDATE cases SET bot_call_status = 'completed', call_attempts = call_attempts + 1, updated_at = ? WHERE id = ?").run(ts, call.case_id);
      addEvent(db, call.case_id, null, 'bot_call_result', { detail: input.outcome, note: [`Bot call: ${headline}.`, summary].filter(Boolean).join(' ') });
      const stillOpen = [STATUS.PENDING, STATUS.IN_VERIFICATION].includes(row.status);
      notify(db, [row.assigned_to ?? call.requested_by], call.case_id,
        `${ref} (${row.customer_name}) bot call: ${headline}.${stillOpen ? ' Review it and save the verification result.' : ''}`);
    });
    return { ok: true };
  }

  return { enabled, deliver, receive };
}
