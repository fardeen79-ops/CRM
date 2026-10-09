// The calling bot: places verification calls for the CRM over Twilio and holds the conversation
// the CRM's playbook teaches it (src/bot-engine.js). Run it with `npm run bot` next to the CRM.
//
//   CRM ──POST /calls──► bot ──REST──► Twilio ──rings──► customer
//                         ▲  ◄──webhooks (answered, speech heard, ended)──┘
//   CRM ◄──POST callback_url (signed result)── bot
//
// Twilio turns the bot's lines into speech (<Say>) and the customer's answers into text
// (<Gather input="speech">); the engine decides what to say next. Calls in progress are kept in
// memory, so restarting the service drops them (the CRM stops waiting after 30 minutes).
import http from 'node:http';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { callResult, hangUp, hearWithAI, normalizePlaybook, startCall } from '../src/bot-engine.js';
import { aiConfigured, makeInterpreter } from '../src/bot-ai.js';

const MAX_BODY = 256 * 1024;
const SESSION_TTL = 2 * 3600e3;
const RECORDING_WAIT = 120e3;

export function sign(secret, body) {
  return `sha256=${crypto.createHmac('sha256', secret).update(body).digest('hex')}`;
}

/** Twilio's request signature: HMAC-SHA1 of the full URL plus the sorted form fields, base64. */
export function twilioSignature(authToken, url, params) {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  return crypto.createHmac('sha1', authToken).update(data).digest('base64');
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** A phone number as Twilio dials it (+E.164). UAE numbers written locally (050…) get +971. */
export function toE164(phone, country = '971') {
  const raw = String(phone || '').trim();
  let digits = raw.replace(/\D/g, '');
  if (raw.startsWith('+')) return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) digits = digits.slice(2);
  else if (digits.startsWith('0')) digits = country + digits.slice(1);
  else if (country === '971' && /^5\d{8}$/.test(digits)) digits = country + digits;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

const xml = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

async function readBody(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Request body too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

export function createBotService({
  secret = process.env.CALL_BOT_SECRET,
  publicUrl = process.env.BOT_PUBLIC_URL,
  accountSid = process.env.TWILIO_ACCOUNT_SID,
  authToken = process.env.TWILIO_AUTH_TOKEN,
  from = process.env.TWILIO_FROM,
  twilioApi = process.env.TWILIO_API || 'https://api.twilio.com',
  // Calls are recorded unless BOT_RECORD=0, so the bank can listen to what the bot said.
  record = process.env.BOT_RECORD !== '0',
  country = process.env.BOT_COUNTRY_CODE || '971',
  log = console,
  // Claude reads answers the rules cannot settle, when the playbook switches the AI on.
  interpret = aiConfigured() ? makeInterpreter({ log }) : null,
} = {}) {
  const telephony = Boolean(accountSid && authToken && from && publicUrl);
  const base = String(publicUrl || '').replace(/\/$/, '');
  const sessions = new Map();

  async function report(s, payload, attempt = 1) {
    const body = JSON.stringify(payload);
    try {
      const res = await fetch(s.request.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret && { 'x-crm-signature': sign(secret, body) }) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      // The CRM refusing (a late or repeated result) is final; only network trouble is retried.
      if (!res.ok) log.warn(`[bot] CRM refused the result for ${s.request.ref}: ${res.status}`);
    } catch (err) {
      if (attempt < 3) return setTimeout(() => report(s, payload, attempt + 1), attempt * 5000).unref();
      log.error(`[bot] could not deliver the result for ${s.request.ref}: ${err.message}`);
    }
  }

  // Sends the call's result once, after the recording is ready when calls are recorded.
  function finish(s, result) {
    if (s.result) return;
    s.result = result;
    if (record && s.answered && !s.recording_url) {
      s.wait = setTimeout(() => send(s), RECORDING_WAIT);
      s.wait.unref?.();
    } else send(s);
  }
  function send(s) {
    if (s.sent) return;
    s.sent = true;
    clearTimeout(s.wait);
    report(s, { ...s.result, ...(s.recording_url && { recording_url: s.recording_url }) });
  }

  const gather = (s, text) => {
    const pb = s.playbook;
    const check = s.state.stage === 'check' ? s.state.checks[s.state.index] : null;
    // Hints help speech recognition with the words the bot expects: yes and no, and the answer on file.
    const hints = [...pb.yes_words, ...pb.no_words, ...(check?.expected ? [].concat(check.expected).map(String) : [])].slice(0, 100).join(', ');
    const say = `<Say language="${xml(pb.language)}"${pb.voice ? ` voice="${xml(pb.voice)}"` : ''}>${xml(text)}</Say>`;
    return `<?xml version="1.0" encoding="UTF-8"?><Response><Gather input="speech" action="${xml(`${base}/twilio/gather/${s.id}`)}" method="POST" language="${xml(pb.language)}" speechTimeout="auto"${pb.language.startsWith('en') ? ' speechModel="phone_call" enhanced="true"' : ''} actionOnEmptyResult="true" hints="${xml(hints)}">${say}</Gather></Response>`;
  };
  const goodbye = (s, text) => {
    const pb = s.playbook;
    return `<?xml version="1.0" encoding="UTF-8"?><Response>${text ? `<Say language="${xml(pb.language)}"${pb.voice ? ` voice="${xml(pb.voice)}"` : ''}>${xml(text)}</Say>` : ''}<Hangup/></Response>`;
  };

  async function placeCall(raw, signature) {
    if (secret && !safeEqual(signature, sign(secret, raw))) throw new HttpError(401, 'Invalid signature');
    let request;
    try { request = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
    if (!telephony) throw new HttpError(503, 'Telephony is not set up on the bot service (TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM, BOT_PUBLIC_URL)');
    if (!/^https?:\/\//.test(String(request.callback_url || ''))) throw new HttpError(400, 'callback_url is missing');
    const to = toE164(request.customer?.phone, country);
    if (!to) throw new HttpError(400, `The customer's number (${request.customer?.phone || 'none'}) cannot be dialled`);
    let playbook;
    try { playbook = normalizePlaybook(request.playbook || {}); } catch (err) { throw new HttpError(400, `Playbook: ${err.message}`); }
    if (!Array.isArray(request.checks)) throw new HttpError(400, 'checks are missing');

    const id = crypto.randomBytes(16).toString('hex');
    const s = { id, request, playbook, state: null, answered: false, created: Date.now() };
    sessions.set(id, s);
    const form = new URLSearchParams({
      To: to, From: from, Url: `${base}/twilio/voice/${id}`, Method: 'POST',
      StatusCallback: `${base}/twilio/status/${id}`, StatusCallbackMethod: 'POST', MachineDetection: 'Enable', Timeout: '30',
    });
    form.append('StatusCallbackEvent', 'answered');
    form.append('StatusCallbackEvent', 'completed');
    if (record) {
      form.set('Record', 'true');
      form.set('RecordingStatusCallback', `${base}/twilio/recording/${id}`);
    }
    let res;
    try {
      res = await fetch(`${twilioApi}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Calls.json`, {
        method: 'POST',
        headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}`, 'content-type': 'application/x-www-form-urlencoded' },
        body: form,
        signal: AbortSignal.timeout(10_000),
      });
    } catch (err) {
      sessions.delete(id);
      throw new HttpError(502, `Twilio could not be reached: ${err.message}`);
    }
    const json = await res.json().catch(() => ({}));
    if (!res.ok) {
      sessions.delete(id);
      throw new HttpError(502, `Twilio refused the call: ${json.message || res.status}`);
    }
    s.callSid = json.sid;
    log.info?.(`[bot] calling ${request.ref} (${json.sid})`);
    return { ok: true, session: id };
  }

  // Twilio webhooks. Each must carry Twilio's signature for the URL it was sent to.
  async function twilio(kind, id, params, signature, path) {
    if (!safeEqual(signature, twilioSignature(authToken, base + path, params))) throw new HttpError(403, 'Invalid Twilio signature');
    const s = sessions.get(id);
    if (!s) return kind === 'voice' || kind === 'gather' ? '<?xml version="1.0" encoding="UTF-8"?><Response><Hangup/></Response>' : '';

    if (kind === 'voice') {
      if (/^(machine|fax)/.test(params.AnsweredBy || '')) {
        s.machine = true;
        return goodbye(s, '');
      }
      s.answered = true;
      s.state = startCall(s.playbook, { values: s.request.values || {}, checks: s.request.checks });
      report(s, { status: 'in_progress' });
      return gather(s, s.state.say);
    }
    if (kind === 'gather') {
      if (!s.state) return goodbye(s, '');
      s.state = await hearWithAI(s.state, s.playbook, params.SpeechResult || '', interpret);
      if (s.state.done) {
        finish(s, callResult(s.state));
        return goodbye(s, s.state.say);
      }
      return gather(s, s.state.say);
    }
    if (kind === 'status') {
      const ended = ['completed', 'busy', 'no-answer', 'failed', 'canceled'].includes(params.CallStatus);
      if (!ended || s.result) return '';
      if (s.machine) finish(s, { status: 'completed', outcome: 'no_answer', checks: [], summary: 'A voicemail answered; the bot hung up.' });
      else if (s.state) finish(s, callResult(hangUp(s.state)));
      else {
        const outcome = { busy: 'busy', failed: 'switched_off' }[params.CallStatus] || 'no_answer';
        finish(s, { status: 'completed', outcome, checks: [], summary: `The call was not answered (${params.CallStatus.replace('-', ' ')}).` });
      }
      return '';
    }
    if (kind === 'recording') {
      if (params.RecordingStatus === 'completed' && /^RE[0-9a-f]{32}$/.test(params.RecordingSid || '')) {
        // Twilio's own link needs the account's credentials, so the CRM fetches it through this
        // service (GET /recordings/:sid, signed).
        s.recording_url = `${base}/recordings/${params.RecordingSid}`;
        if (s.result) send(s);
      }
      return '';
    }
    throw new HttpError(404, 'Not found');
  }

  /**
   * A call recording, for the CRM to play to the people allowed to listen. The CRM signs
   * "GET <path>\n<timestamp>" with CALL_BOT_SECRET; requests older than five minutes are refused.
   */
  async function recording(sid, req, res) {
    if (!secret) throw new HttpError(403, 'Recordings are served only when CALL_BOT_SECRET is set');
    const ts = Number(req.headers['x-crm-timestamp']);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300e3) throw new HttpError(401, 'Stale or missing timestamp');
    if (!safeEqual(req.headers['x-crm-signature'], sign(secret, `GET /recordings/${sid}\n${ts}`))) throw new HttpError(401, 'Invalid signature');
    if (!telephony) throw new HttpError(404, 'Not found');
    const up = await fetch(`${twilioApi}/2010-04-01/Accounts/${encodeURIComponent(accountSid)}/Recordings/${sid}.mp3`, {
      headers: { authorization: `Basic ${Buffer.from(`${accountSid}:${authToken}`).toString('base64')}` },
      signal: AbortSignal.timeout(20_000),
    }).catch((err) => { throw new HttpError(502, `Twilio could not be reached: ${err.message}`); });
    if (!up.ok) throw new HttpError(up.status === 404 ? 404 : 502, up.status === 404 ? 'Recording not found' : `Twilio answered ${up.status}`);
    const audio = Buffer.from(await up.arrayBuffer());
    res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store' });
    res.end(audio);
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const reply = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store' });
      res.end(type === 'application/json' ? JSON.stringify(body) : body);
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') return reply(200, { ok: true, telephony, recording: record, calls_in_progress: sessions.size });
      const rec = req.method === 'GET' && url.pathname.match(/^\/recordings\/(RE[0-9a-f]{32})$/);
      if (rec) return await recording(rec[1], req, res);
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const raw = await readBody(req);
      if (url.pathname === '/calls') return reply(202, await placeCall(raw, req.headers['x-crm-signature']));
      const m = url.pathname.match(/^\/twilio\/(voice|gather|status|recording)\/([a-f0-9]{32})$/);
      if (!m || !telephony) throw new HttpError(404, 'Not found');
      const params = Object.fromEntries(new URLSearchParams(raw));
      const out = await twilio(m[1], m[2], params, req.headers['x-twilio-signature'], url.pathname + url.search);
      return out ? reply(200, out, 'text/xml') : reply(204, '', 'text/plain');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log.error(err);
      reply(status, { error: status === 500 ? 'Internal error' : err.message });
    }
  });

  // Forget calls long finished (or never answered back by Twilio).
  const timer = setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.created > SESSION_TTL) sessions.delete(id);
  }, 600e3);
  timer.unref();
  server.on('close', () => clearInterval(timer));
  server.sessions = sessions;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BOT_PORT) || 4000;
  const service = createBotService();
  service.listen(port, () => {
    console.log(`Calling bot listening on http://localhost:${port} (point the CRM's CALL_BOT_URL at http://<this host>:${port}/calls)`);
    if (!process.env.TWILIO_ACCOUNT_SID) console.log('  Telephony is not set up: set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM and BOT_PUBLIC_URL.');
    if (!process.env.CALL_BOT_SECRET) console.log('  CALL_BOT_SECRET is not set: requests and results are not signed.');
    console.log(aiConfigured() ? '  AI: on for playbooks that switch it on.' : '  AI: off (set ANTHROPIC_API_KEY to let the bot use it).');
  });
}
