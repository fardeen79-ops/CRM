// The native calling bot: places the CRM's verification calls over your own SIP line and keeps
// every part of the call on this server. Run it with `npm run bot:sip` next to the CRM.
//
//   CRM ──POST /calls──► this service ──SIP/RTP──► your SIP trunk ──rings──► customer
//   CRM ◄──POST callback_url (signed result)──┘
//
// Speech is produced and recognised by programs on this machine (bot/sip/speech.js), the
// conversation follows the playbook the CRM sends (src/bot-engine.js) and recordings are WAV
// files in a folder here, served to the CRM only with a signed request. No telephony or speech
// provider is involved, so nobody outside hears or stores the call. The AI (Claude) is off
// unless ANTHROPIC_API_KEY is set; with it on, what the customer says is sent to Anthropic.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { normalizePlaybook } from '../src/bot-engine.js';
import { aiConfigured, makeInterpreter, makePhraser } from '../src/bot-ai.js';
import { sign, toE164 } from './server.js';
import { SipUA } from './sip/sip.js';
import { DEFAULT_AUDIO, recordingFile, runCall } from './sip/call.js';
import { speechFromEnv } from './sip/speech.js';

const MAX_BODY = 256 * 1024;
const SESSION_TTL = 2 * 3600e3;

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a || '')); const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

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

/** The SIP settings from the environment, or null when the line is not set up. */
export function sipFromEnv(env = process.env) {
  if (!env.SIP_SERVER || !env.SIP_USERNAME) return null;
  return {
    server: env.SIP_SERVER, username: env.SIP_USERNAME, password: env.SIP_PASSWORD || '', domain: env.SIP_DOMAIN || undefined,
    callerId: env.SIP_CALLER_ID || undefined, displayName: env.SIP_DISPLAY_NAME || undefined, localIp: env.SIP_LOCAL_IP || undefined,
    localPort: env.SIP_LOCAL_PORT || undefined, register: env.SIP_REGISTER !== '0', expires: env.SIP_EXPIRES || undefined,
    assertIdentity: env.SIP_ASSERT_IDENTITY !== '0',
  };
}

export function audioFromEnv(env = process.env) {
  const n = (k, d) => (env[k] === undefined || env[k] === '' ? d : Number(env[k]));
  const range = String(env.RTP_PORT_RANGE || '').match(/^(\d+)-(\d+)$/);
  return {
    ringTimeoutMs: n('BOT_RING_TIMEOUT_MS', DEFAULT_AUDIO.ringTimeoutMs),
    noSpeechMs: n('BOT_NO_SPEECH_MS', DEFAULT_AUDIO.noSpeechMs),
    silenceMs: n('BOT_SILENCE_MS', DEFAULT_AUDIO.silenceMs),
    maxUtteranceMs: n('BOT_MAX_ANSWER_MS', DEFAULT_AUDIO.maxUtteranceMs),
    bargeIn: env.BOT_BARGE_IN === '1',
    machineDetection: env.BOT_MACHINE_DETECTION !== '0',
    portRange: range ? [Number(range[1]), Number(range[2])] : DEFAULT_AUDIO.portRange,
  };
}

export function createSipBotService({
  log = console,
  secret = process.env.CALL_BOT_SECRET,
  // The address the CRM reaches this service at (for recording links). Nothing else needs it;
  // unset, the links use this host's listening port.
  publicUrl = process.env.BOT_PUBLIC_URL,
  sip = sipFromEnv(),
  ua = sip ? new SipUA({ ...sip, log }) : null,
  mediaIp = process.env.SIP_MEDIA_IP,
  speech = speechFromEnv(process.env, { log }),
  stt = speech.stt,
  tts = speech.tts,
  record = process.env.BOT_RECORD !== '0',
  recordingsDir = process.env.BOT_RECORDINGS_DIR || path.join(process.cwd(), 'data', 'recordings'),
  recordingDays = Number(process.env.BOT_RECORDING_DAYS) || 0,
  country = process.env.BOT_COUNTRY_CODE || '971',
  maxCalls = Number(process.env.BOT_MAX_CALLS) || 4,
  audio = audioFromEnv(),
  interpret = aiConfigured() ? makeInterpreter({ log }) : null,
  phrase = aiConfigured() ? makePhraser({ log }) : null,
} = {}) {
  const telephony = Boolean(ua && stt && tts);
  const base = () => (publicUrl ? String(publicUrl).replace(/\/$/, '') : `http://localhost:${server.address()?.port || Number(process.env.BOT_PORT) || 4000}`);
  const sessions = new Map();
  if (record) fs.mkdirSync(recordingsDir, { recursive: true });

  async function report(s, payload, attempt = 1) {
    const body = JSON.stringify(payload);
    try {
      const res = await fetch(s.request.callback_url, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...(secret && { 'x-crm-signature': sign(secret, body) }) },
        body,
        signal: AbortSignal.timeout(10_000),
      });
      if (!res.ok) log.warn(`[bot] CRM refused the result for ${s.request.ref}: ${res.status}`);
    } catch (err) {
      if (attempt < 3) return setTimeout(() => report(s, payload, attempt + 1), attempt * 5000).unref();
      log.error(`[bot] could not deliver the result for ${s.request.ref}: ${err.message}`);
    }
  }

  const inProgress = () => [...sessions.values()].filter((s) => !s.result).length;

  async function placeCall(raw, signature) {
    if (secret && !safeEqual(signature, sign(secret, raw))) throw new HttpError(401, 'Invalid signature');
    let request;
    try { request = JSON.parse(raw); } catch { throw new HttpError(400, 'Invalid JSON body'); }
    if (!ua) throw new HttpError(503, 'The SIP line is not set up on the bot service (SIP_SERVER, SIP_USERNAME, SIP_PASSWORD)');
    if (!stt || !tts) throw new HttpError(503, 'Speech is not set up on the bot service (STT_MODEL/STT_COMMAND and TTS_MODEL/TTS_COMMAND)');
    if (!/^https?:\/\//.test(String(request.callback_url || ''))) throw new HttpError(400, 'callback_url is missing');
    const to = toE164(request.customer?.phone, country);
    if (!to) throw new HttpError(400, `The customer's number (${request.customer?.phone || 'none'}) cannot be dialled`);
    let playbook;
    try { playbook = normalizePlaybook(request.playbook || {}); } catch (err) { throw new HttpError(400, `Playbook: ${err.message}`); }
    if (!Array.isArray(request.checks)) throw new HttpError(400, 'checks are missing');
    if (ua.shouldRegister && !ua.registered) throw new HttpError(503, 'The SIP line is not registered with the provider yet');
    if (inProgress() >= maxCalls) throw new HttpError(503, `The bot is already on ${maxCalls} calls; try again shortly`);

    const id = crypto.randomBytes(16).toString('hex');
    const s = { id, request, playbook, created: Date.now(), result: null };
    sessions.set(id, s);
    log.info?.(`[bot] calling ${request.ref} on ${to.replace(/\d(?=\d{3})/g, '•')}`);
    // The call runs on its own; the CRM has already been told the request was accepted.
    runCall({
      ua, request, playbook, number: to.replace(/^\+/, ''), stt, tts, interpret, phrase, log, mediaIp, audio,
      recordingPath: record ? recordingFile(recordingsDir, id) : null,
      onAnswered: () => report(s, { status: 'in_progress' }),
    }).then(({ result, recordingPath }) => {
      s.result = result;
      report(s, { ...result, ...(recordingPath && fs.existsSync(recordingPath) && { recording_url: `${base()}/recordings/${id}` }) });
    }).catch((err) => {
      log.error(`[bot] call ${request.ref} crashed: ${err.stack || err.message}`);
      s.result = { status: 'failed', error: 'The calling service hit an internal error' };
      report(s, s.result);
    });
    return { ok: true, session: id };
  }

  /** A recording, for the CRM to play to the people allowed to listen (signed, five-minute window). */
  function recording(id, req, res) {
    if (!secret) throw new HttpError(403, 'Recordings are served only when CALL_BOT_SECRET is set');
    const ts = Number(req.headers['x-crm-timestamp']);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > 300e3) throw new HttpError(401, 'Stale or missing timestamp');
    if (!safeEqual(req.headers['x-crm-signature'], sign(secret, `GET /recordings/${id}\n${ts}`))) throw new HttpError(401, 'Invalid signature');
    const file = recordingFile(recordingsDir, id);
    let stat;
    try { stat = fs.statSync(file); } catch { throw new HttpError(404, 'Recording not found'); }
    res.writeHead(200, { 'content-type': 'audio/wav', 'content-length': stat.size, 'cache-control': 'no-store' });
    fs.createReadStream(file).pipe(res);
  }

  function prune() {
    if (!record || !recordingDays) return;
    const cutoff = Date.now() - recordingDays * 864e5;
    for (const f of fs.readdirSync(recordingsDir)) {
      const p = path.join(recordingsDir, f);
      try { if (f.endsWith('.wav') && fs.statSync(p).mtimeMs < cutoff) fs.unlinkSync(p); } catch { /* gone already */ }
    }
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const reply = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    try {
      if (req.method === 'GET' && url.pathname === '/health') {
        return reply(200, { ok: true, telephony, line: ua ? { server: ua.server.host, registered: ua.shouldRegister ? ua.registered : 'not required' } : null, speech: { stt: Boolean(stt), tts: Boolean(tts) }, recording: record, ai: Boolean(interpret), calls_in_progress: inProgress() });
      }
      const rec = req.method === 'GET' && url.pathname.match(/^\/recordings\/([0-9a-f]{32})$/);
      if (rec) return recording(rec[1], req, res);
      if (req.method !== 'POST') throw new HttpError(405, 'Method not allowed');
      const raw = await readBody(req);
      if (url.pathname === '/calls') return reply(202, await placeCall(raw, req.headers['x-crm-signature']));
      throw new HttpError(404, 'Not found');
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) log.error(err);
      reply(status, { error: status === 500 ? 'Internal error' : err.message });
    }
  });

  const timer = setInterval(() => {
    for (const [id, s] of sessions) if (Date.now() - s.created > SESSION_TTL) sessions.delete(id);
    prune();
  }, 600e3);
  timer.unref();
  server.on('close', () => { clearInterval(timer); ua?.stop().catch(() => {}); });
  server.sessions = sessions;
  server.ua = ua;
  /** Brings the SIP line up (binds the port, registers). Call before listening. */
  server.start = async () => { if (ua && !ua.socket) await ua.start(); prune(); return server; };
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.env.BOT_PORT) || 4000;
  const service = createSipBotService();
  service.start().then(() => {
    service.listen(port, () => {
      console.log(`Native calling bot listening on http://localhost:${port} (point the CRM's CALL_BOT_URL at http://<this host>:${port}/calls)`);
      const ua = service.ua;
      if (!ua) console.log('  SIP line is not set up: set SIP_SERVER, SIP_USERNAME and SIP_PASSWORD.');
      else console.log(`  SIP: ${ua.username}@${ua.server.host} from ${ua.localIp}:${ua.localPort}${ua.shouldRegister ? (ua.registered ? ', registered' : ', NOT registered yet') : ' (no registration)'}`);
      const sp = speechFromEnv().describe;
      console.log(`  Speech: ${sp.stt ? `recognition "${sp.stt}"` : 'recognition NOT set up (STT_MODEL or STT_COMMAND)'}; ${sp.tts ? `voice "${sp.tts}"` : 'voice NOT set up (TTS_MODEL or TTS_COMMAND)'}`);
      if (!process.env.CALL_BOT_SECRET) console.log('  CALL_BOT_SECRET is not set: requests and results are not signed, and recordings cannot be served.');
      console.log(aiConfigured() ? '  AI: on for playbooks that switch it on (what customers say is sent to Anthropic).' : '  AI: off; the call stays on this server.');
    });
  }).catch((err) => {
    console.error(`The SIP line could not be started: ${err.message}`);
    process.exit(1);
  });
}
