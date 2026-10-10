// A small SIP user agent (RFC 3261) for placing calls over a SIP trunk: it registers with the
// provider when the line needs it, sends INVITEs with digest authentication, follows the call
// through 100/180/200, ACKs, and ends calls with BYE (or CANCEL while still ringing). It
// answers the provider's in-dialog requests (BYE, re-INVITE, OPTIONS). UDP, with the standard
// retransmission timers; every request goes to the configured server, as trunks expect.
import dgram from 'node:dgram';
import dns from 'node:dns/promises';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

const T1 = 500;
const TIMER_B = 64 * T1;
const COMPACT = { v: 'via', f: 'from', t: 'to', i: 'call-id', m: 'contact', l: 'content-length', c: 'content-type', k: 'supported', e: 'content-encoding', s: 'subject' };
const USER_AGENT = 'Sourcing CRM verification bot';
const ALLOW = 'INVITE, ACK, CANCEL, BYE, OPTIONS, INFO, UPDATE, NOTIFY';

export const token = (n = 8) => crypto.randomBytes(n).toString('hex');
export const branch = () => `z9hG4bK${token(8)}`;

// ---- Messages -------------------------------------------------------------------------------
/** Parses one SIP message (request or response) into { method, uri } or { status, reason }, headers [[name, value]], body. */
export function parseMessage(text) {
  const sep = text.indexOf('\r\n\r\n');
  const head = sep === -1 ? text : text.slice(0, sep);
  const body = sep === -1 ? '' : text.slice(sep + 4);
  const lines = head.split('\r\n');
  // Folded header lines continue with whitespace.
  const unfolded = [];
  for (const line of lines) {
    if (/^[ \t]/.test(line) && unfolded.length) unfolded[unfolded.length - 1] += ' ' + line.trim();
    else unfolded.push(line);
  }
  const start = unfolded.shift() || '';
  const msg = { headers: [], body };
  let m;
  if ((m = start.match(/^SIP\/2\.0 (\d{3}) ?(.*)$/))) { msg.status = Number(m[1]); msg.reason = m[2]; }
  else if ((m = start.match(/^([A-Z]+) (\S+) SIP\/2\.0$/))) { msg.method = m[1]; msg.uri = m[2]; }
  else return null;
  for (const line of unfolded) {
    const i = line.indexOf(':');
    if (i === -1) continue;
    let name = line.slice(0, i).trim().toLowerCase();
    name = COMPACT[name] || name;
    const value = line.slice(i + 1).trim();
    // Via, Record-Route and the like may be comma-joined on one line.
    if (['via', 'record-route', 'route', 'contact'].includes(name) && value.includes(',')) for (const v of splitTop(value)) msg.headers.push([name, v.trim()]);
    else msg.headers.push([name, value]);
  }
  const len = Number(header(msg, 'content-length'));
  if (Number.isFinite(len) && len < body.length) msg.body = body.slice(0, len);
  return msg;
}

/** Splits on commas outside <>, "" and (). */
function splitTop(value) {
  const out = []; let depth = 0; let quoted = false; let cur = '';
  for (const ch of value) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === '<' || ch === '(')) depth++;
    else if (!quoted && (ch === '>' || ch === ')')) depth--;
    if (ch === ',' && !quoted && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

export const header = (msg, name) => msg.headers.find(([n]) => n === name)?.[1];
export const headersOf = (msg, name) => msg.headers.filter(([n]) => n === name).map(([, v]) => v);

const CANON = { 'call-id': 'Call-ID', cseq: 'CSeq', 'www-authenticate': 'WWW-Authenticate', 'content-type': 'Content-Type', 'content-length': 'Content-Length', 'max-forwards': 'Max-Forwards', 'user-agent': 'User-Agent', 'record-route': 'Record-Route', 'proxy-authenticate': 'Proxy-Authenticate', 'proxy-authorization': 'Proxy-Authorization', 'p-asserted-identity': 'P-Asserted-Identity' };
const canon = (name) => CANON[name] || name.replace(/(^|-)([a-z])/g, (_, d, c) => d + c.toUpperCase());

export function serialize(msg) {
  const start = msg.method ? `${msg.method} ${msg.uri} SIP/2.0` : `SIP/2.0 ${msg.status} ${msg.reason || ''}`;
  const body = msg.body || '';
  const headers = msg.headers.filter(([n]) => n !== 'content-length').map(([n, v]) => `${canon(n)}: ${v}`);
  headers.push(`Content-Length: ${Buffer.byteLength(body)}`);
  return `${start}\r\n${headers.join('\r\n')}\r\n\r\n${body}`;
}

export const param = (value, name) => value?.match(new RegExp(`[;?]${name}=([^;>\\s]+)`, 'i'))?.[1] ?? null;
export const tagOf = (value) => param(String(value || '').replace(/<[^>]*>/, ''), 'tag');
export const uriOf = (value) => value?.match(/<([^>]+)>/)?.[1] || value?.split(';')[0].trim();
const cseqOf = (msg) => { const [n, m] = (header(msg, 'cseq') || '').split(/\s+/); return { number: Number(n), method: m }; };
const topBranch = (msg) => param(headersOf(msg, 'via')[0], 'branch');

// ---- Digest authentication (RFC 2617 / 3261) -------------------------------------------------
export function parseChallenge(value) {
  const m = String(value || '').match(/^(\w+)\s+(.*)$/s);
  if (!m) return null;
  const out = { scheme: m[1] };
  for (const kv of m[2].matchAll(/(\w+)=(?:"([^"]*)"|([^,\s]+))/g)) out[kv[1].toLowerCase()] = kv[2] ?? kv[3];
  return out;
}

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

/** The Authorization header value for a challenge. */
export function digestAuthorization({ username, password, method, uri, challenge, nc = 1, cnonce = token(4) }) {
  const { realm, nonce, opaque, algorithm = 'MD5' } = challenge;
  const qop = (challenge.qop || '').split(',').map((s) => s.trim()).includes('auth') ? 'auth' : null;
  let ha1 = md5(`${username}:${realm}:${password}`);
  if (/^MD5-sess$/i.test(algorithm)) ha1 = md5(`${ha1}:${nonce}:${cnonce}`);
  const ha2 = md5(`${method}:${uri}`);
  const ncs = nc.toString(16).padStart(8, '0');
  const response = qop ? md5(`${ha1}:${nonce}:${ncs}:${cnonce}:${qop}:${ha2}`) : md5(`${ha1}:${nonce}:${ha2}`);
  const parts = [`username="${username}"`, `realm="${realm}"`, `nonce="${nonce}"`, `uri="${uri}"`, `response="${response}"`, `algorithm=${algorithm}`];
  if (qop) parts.push(`qop=${qop}`, `nc=${ncs}`, `cnonce="${cnonce}"`);
  if (opaque) parts.push(`opaque="${opaque}"`);
  return `Digest ${parts.join(', ')}`;
}

// ---- SDP ------------------------------------------------------------------------------------
export function buildSdp({ ip, port, sessionId = Date.now() }) {
  return ['v=0', `o=- ${sessionId} ${sessionId} IN IP4 ${ip}`, 's=Sourcing CRM bot', `c=IN IP4 ${ip}`, 't=0 0',
    `m=audio ${port} RTP/AVP 0 8 101`, 'a=rtpmap:0 PCMU/8000', 'a=rtpmap:8 PCMA/8000', 'a=rtpmap:101 telephone-event/8000', 'a=fmtp:101 0-16', 'a=ptime:20', 'a=sendrecv', ''].join('\r\n');
}

/** The audio address and codec the other side chose. */
export function parseSdp(text) {
  const lines = String(text || '').split(/\r?\n/);
  let address = null; let port = null; let inAudio = false; let types = [];
  const names = {};
  for (const line of lines) {
    const [k, v] = [line[0], line.slice(2)];
    if (k === 'c' && (inAudio || !address)) address = v.split(' ')[2];
    else if (k === 'm') {
      const [media, p, , ...pts] = v.split(' ');
      inAudio = media === 'audio';
      if (inAudio) { port = Number(p); types = pts.map(Number); }
    } else if (k === 'a' && inAudio) {
      const r = v.match(/^rtpmap:(\d+) (\w+)\//i);
      if (r) names[Number(r[1])] = r[2].toUpperCase();
    }
  }
  if (!address || !port) return null;
  const codec = types.find((t) => t === 0 || t === 8 || names[t] === 'PCMU' || names[t] === 'PCMA');
  const payloadType = codec === undefined ? null : names[codec] === 'PCMA' || codec === 8 ? 8 : 0;
  return { address, port, payloadType, types };
}

// ---- The user agent -------------------------------------------------------------------------
export class SipError extends Error {
  constructor(status, reason) {
    super(`${status} ${reason || ''}`.trim());
    this.status = status;
    this.reason = reason || '';
  }
}

export class SipUA extends EventEmitter {
  /**
   * @param {object} o
   * @param {string} o.server          provider host[:port] (registrar and outbound proxy)
   * @param {string} o.username        auth user
   * @param {string} o.password
   * @param {string} [o.domain]        SIP domain for the From/To and REGISTER URIs (default: server host)
   * @param {string} [o.callerId]      number shown to the customer (default: username)
   * @param {string} [o.displayName]
   * @param {string} [o.localIp]       IP to put in Via/Contact/SDP (default: detected towards the server)
   * @param {number} [o.localPort]
   * @param {boolean} [o.register]     register before calling (default true)
   * @param {number} [o.expires]
   * @param {boolean} [o.assertIdentity]  add P-Asserted-Identity with the caller ID
   */
  constructor(o) {
    super();
    const [host, port] = String(o.server || '').split(':');
    this.server = { host, port: Number(port) || 5060 };
    this.username = o.username; this.password = o.password;
    this.domain = o.domain || host;
    this.callerId = o.callerId || o.username;
    this.displayName = o.displayName || '';
    this.localIp = o.localIp || null;
    this.localPort = Number(o.localPort) || 5060;
    this.shouldRegister = o.register !== false;
    this.expires = Number(o.expires) || 300;
    this.assertIdentity = o.assertIdentity !== false;
    this.log = o.log || console;
    this.transactions = new Map(); // branch -> client transaction
    this.dialogs = new Map();      // call-id -> dialog
    this.registered = false;
    this.nc = new Map();           // nonce -> count
  }

  async start() {
    this.serverIp = (await dns.lookup(this.server.host, { family: 4 })).address;
    if (!this.localIp) {
      const probe = dgram.createSocket('udp4');
      await new Promise((resolve, reject) => probe.connect(this.server.port, this.serverIp, (err) => (err ? reject(err) : resolve())));
      this.localIp = probe.address().address;
      probe.close();
    }
    this.socket = dgram.createSocket('udp4');
    this.socket.on('message', (msg, rinfo) => this.onDatagram(msg, rinfo));
    this.socket.on('error', (err) => this.log.error?.(`[sip] socket error: ${err.message}`));
    await new Promise((resolve, reject) => {
      this.socket.once('error', reject);
      this.socket.bind(this.localPort, this.localIp, () => { this.socket.removeListener('error', reject); resolve(); });
    });
    this.localPort = this.socket.address().port;
    if (this.shouldRegister) await this.register().catch((err) => this.log.warn?.(`[sip] registration failed: ${err.message}`));
    return this;
  }

  async stop() {
    clearTimeout(this.registerTimer);
    for (const d of [...this.dialogs.values()]) await d.bye().catch(() => {});
    if (this.registered) await this.register(0, { timeout: 3000 }).catch(() => {});
    for (const t of this.transactions.values()) t.cancel();
    this.socket?.close();
    this.socket = null;
  }

  get contact() { return `<sip:${this.username}@${this.localIp}:${this.localPort}>`; }
  get fromHeader() { return `${this.displayName ? `"${this.displayName.replace(/"/g, '')}" ` : ''}<sip:${this.callerId}@${this.domain}>`; }

  send(msg, rinfo = { address: this.serverIp, port: this.server.port }) {
    const text = serialize(msg);
    this.emit('trace', 'out', text);
    this.socket.send(text, rinfo.port, rinfo.address);
  }

  // Requests (with retransmissions): resolves with the final response, rejects on transport timeout.
  request(msg, { onProvisional, timeout = TIMER_B } = {}) {
    const key = topBranch(msg);
    return new Promise((resolve, reject) => {
      let interval = T1; let done = false;
      const t = {
        method: msg.method, msg,
        onResponse: (res) => {
          if (res.status < 200) { clearTimeout(t.retransmit); onProvisional?.(res); return; }
          if (done) return;
          done = true; t.cancel();
          if (msg.method === 'INVITE' && res.status >= 300) this.ackNon2xx(msg, res);
          resolve(res);
        },
        cancel: () => { clearTimeout(t.retransmit); clearTimeout(t.timeout); this.transactions.delete(key); },
      };
      const resend = () => { this.send(msg); interval = Math.min(interval * 2, 4000); t.retransmit = setTimeout(resend, interval); t.retransmit.unref?.(); };
      this.transactions.set(key, t);
      this.send(msg);
      t.retransmit = setTimeout(resend, interval);
      t.retransmit.unref?.();
      t.timeout = setTimeout(() => { if (done) return; done = true; t.cancel(); reject(new SipError(408, 'No answer from the SIP server')); }, timeout);
      t.timeout.unref?.();
    });
  }

  /** Sends a request, answering one authentication challenge. */
  async requestWithAuth(msg, opts = {}) {
    opts.onRequest?.(msg);
    const res = await this.request(msg, opts);
    if (res.status !== 401 && res.status !== 407) return res;
    const challenge = parseChallenge(header(res, res.status === 401 ? 'www-authenticate' : 'proxy-authenticate'));
    if (!challenge || !/^Digest$/i.test(challenge.scheme) || !this.password) return res;
    const nc = (this.nc.get(challenge.nonce) || 0) + 1;
    this.nc.set(challenge.nonce, nc);
    const auth = digestAuthorization({ username: this.username, password: this.password, method: msg.method, uri: msg.uri, challenge, nc });
    const cseq = cseqOf(msg);
    const retry = {
      ...msg,
      headers: msg.headers.filter(([n]) => !['via', 'cseq', 'authorization', 'proxy-authorization'].includes(n)),
    };
    retry.headers.unshift(['via', this.via()]);
    retry.headers.push(['cseq', `${cseq.number + 1} ${msg.method}`], [res.status === 401 ? 'authorization' : 'proxy-authorization', auth]);
    opts.onRequest?.(retry);
    return this.request(retry, opts);
  }

  via() { return `SIP/2.0/UDP ${this.localIp}:${this.localPort};branch=${branch()};rport`; }

  baseHeaders(method, { callId, from, to, cseq }) {
    return [
      ['via', this.via()], ['max-forwards', '70'], ['from', from], ['to', to], ['call-id', callId], ['cseq', `${cseq} ${method}`],
      ['user-agent', USER_AGENT], ['allow', ALLOW],
    ];
  }

  // ---- REGISTER ----
  async register(expires = this.expires, { timeout } = {}) {
    const aor = `sip:${this.username}@${this.domain}`;
    const callId = this.registerCallId ||= `${token()}@${this.localIp}`;
    this.registerSeq = (this.registerSeq || 0) + 2; // leaves room for the authenticated retry's +1
    const msg = {
      method: 'REGISTER', uri: `sip:${this.domain}`,
      headers: [...this.baseHeaders('REGISTER', { callId, from: `<${aor}>;tag=${this.registerTag ||= token(4)}`, to: `<${aor}>`, cseq: this.registerSeq }),
        ['contact', `${this.contact};expires=${expires}`], ['expires', String(expires)]],
      body: '',
    };
    let res;
    try { res = await this.requestWithAuth(msg, { timeout }); } catch (err) { this.scheduleRegister(60e3); throw err; }
    if (res.status >= 300) {
      this.registered = false;
      this.scheduleRegister(60e3);
      throw new SipError(res.status, res.reason);
    }
    this.registered = expires > 0;
    if (expires > 0) {
      const granted = Number(param(headersOf(res, 'contact').find((c) => c.includes(this.localIp)) || '', 'expires') || header(res, 'expires') || expires);
      this.scheduleRegister(Math.max(30, granted * 0.8) * 1000);
      this.emit('registered', granted);
    }
    return res;
  }

  scheduleRegister(ms) {
    clearTimeout(this.registerTimer);
    if (!this.shouldRegister || !this.socket) return;
    this.registerTimer = setTimeout(() => this.register().catch((err) => this.log.warn?.(`[sip] re-registration failed: ${err.message}`)), ms);
    this.registerTimer.unref?.();
  }

  // ---- Calls ----
  /**
   * Places a call. Resolves with { dialog, sdp } once answered; rejects with a SipError (486 busy,
   * 487 cancelled on ring timeout, 404…) or a transport error.
   */
  async call({ number, sdp, ringTimeout = 45000, onProgress }) {
    const callId = `${token()}@${this.localIp}`;
    const localTag = token(4);
    const to = `<sip:${number}@${this.domain}>`;
    const from = `${this.fromHeader};tag=${localTag}`;
    const invite = {
      method: 'INVITE', uri: `sip:${number}@${this.domain}`,
      headers: [...this.baseHeaders('INVITE', { callId, from, to, cseq: 1 }), ['contact', this.contact], ['content-type', 'application/sdp'],
        ...(this.assertIdentity ? [['p-asserted-identity', `<sip:${this.callerId}@${this.domain}>`]] : []), ['supported', 'replaces']],
      body: sdp,
    };
    const dialog = new Dialog(this, { callId, localTag, localUri: from, remoteUri: to, requestUri: invite.uri });
    let sent = invite;
    let ringTimer;
    const onProvisional = (res) => {
      dialog.remoteTag ||= tagOf(header(res, 'to'));
      if (res.status >= 180) onProgress?.(res.status);
      if (!ringTimer) {
        ringTimer = setTimeout(() => this.cancel(sent, dialog), ringTimeout);
        ringTimer.unref?.();
      }
    };
    let res;
    try {
      // The authenticated retry is the request a CANCEL must match.
      res = await this.requestWithAuth(invite, { onProvisional, timeout: ringTimeout + TIMER_B, onRequest: (m) => { sent = m; } });
    } finally {
      clearTimeout(ringTimer);
    }
    if (res.status >= 300) throw new SipError(res.status, res.reason);
    dialog.confirm(res, sent);
    this.dialogs.set(callId, dialog);
    return { dialog, sdp: parseSdp(res.body), response: res };
  }

  cancel(invite, dialog) {
    const msg = {
      method: 'CANCEL', uri: invite.uri,
      headers: [...invite.headers.filter(([n]) => ['via', 'from', 'to', 'call-id', 'max-forwards'].includes(n)), ['cseq', `${cseqOf(invite).number} CANCEL`]],
      body: '',
    };
    // CANCEL reuses the INVITE's branch; it's its own transaction, sent once with its own timer.
    const t = { method: 'CANCEL', onResponse() {}, cancel() {} };
    this.transactions.set(`${topBranch(invite)}-cancel`, t);
    this.send(msg);
    dialog.cancelled = true;
  }

  ackNon2xx(invite, res) {
    const ack = {
      method: 'ACK', uri: invite.uri,
      headers: [...invite.headers.filter(([n]) => ['via', 'from', 'call-id', 'max-forwards'].includes(n)), ['to', header(res, 'to')], ['cseq', `${cseqOf(invite).number} ACK`]],
      body: '',
    };
    this.send(ack);
  }

  // ---- Incoming ----
  onDatagram(buf, rinfo) {
    const text = buf.toString('utf8');
    if (!text.trim()) return; // keep-alive CRLF
    this.emit('trace', 'in', text);
    const msg = parseMessage(text);
    if (!msg) return;
    if (msg.status) return this.onResponse(msg);
    this.onRequest(msg, rinfo);
  }

  onResponse(res) {
    const key = topBranch(res);
    const { method } = cseqOf(res);
    const t = this.transactions.get(method === 'CANCEL' ? `${key}-cancel` : key);
    if (t) return t.onResponse(res);
    // A retransmitted 200 to our INVITE: the ACK was lost, send it again.
    if (method === 'INVITE' && res.status < 300 && res.status >= 200) this.dialogs.get(header(res, 'call-id'))?.resendAck();
  }

  reply(req, status, reason, extra = [], body = '', rinfo) {
    const res = {
      status, reason,
      headers: [...req.headers.filter(([n]) => ['via', 'from', 'to', 'call-id', 'cseq', 'record-route'].includes(n)), ...extra],
      body,
    };
    const to = res.headers.find(([n]) => n === 'to');
    if (to && !tagOf(to[1])) to[1] = `${to[1]};tag=${token(4)}`;
    this.send(res, rinfo);
  }

  onRequest(req, rinfo) {
    const callId = header(req, 'call-id');
    const dialog = this.dialogs.get(callId);
    switch (req.method) {
      case 'OPTIONS':
        return this.reply(req, 200, 'OK', [['allow', ALLOW], ['accept', 'application/sdp']], '', rinfo);
      case 'ACK':
        return;
      case 'BYE':
        if (!dialog) return this.reply(req, 481, 'Call/Transaction Does Not Exist', [], '', rinfo);
        this.reply(req, 200, 'OK', [], '', rinfo);
        this.dialogs.delete(callId);
        dialog.ended = true;
        return dialog.emit('bye');
      case 'INVITE':
        if (!dialog) return this.reply(req, 403, 'Forbidden', [], '', rinfo); // this agent only places calls
        // A re-INVITE (hold, codec change): answer with the same media, follow a new address.
        if (req.body) { const sdp = parseSdp(req.body); if (sdp) dialog.emit('media', sdp); }
        return this.reply(req, 200, 'OK', [['contact', this.contact], ['content-type', 'application/sdp']], dialog.localSdp, rinfo);
      case 'CANCEL':
        return this.reply(req, 481, 'Call/Transaction Does Not Exist', [], '', rinfo);
      default:
        return this.reply(req, dialog ? 200 : 481, dialog ? 'OK' : 'Call/Transaction Does Not Exist', [], '', rinfo);
    }
  }
}

/** One confirmed call. */
export class Dialog extends EventEmitter {
  constructor(ua, { callId, localTag, localUri, remoteUri, requestUri }) {
    super();
    this.ua = ua; this.callId = callId; this.localTag = localTag; this.localUri = localUri; this.remoteUri = remoteUri;
    this.requestUri = requestUri; this.remoteTag = null; this.remoteTarget = null; this.routeSet = []; this.seq = 1; this.ended = false;
  }

  confirm(res, invite) {
    this.remoteTag = tagOf(header(res, 'to'));
    this.remoteTo = header(res, 'to');
    this.remoteTarget = uriOf(header(res, 'contact')) || this.requestUri;
    this.routeSet = headersOf(res, 'record-route');
    this.localSdp = invite.body;
    this.seq = cseqOf(invite).number;
    this.ack = {
      method: 'ACK', uri: this.target(),
      headers: [['via', this.ua.via()], ['max-forwards', '70'], ['from', this.localUri], ['to', this.remoteTo], ['call-id', this.callId], ['cseq', `${this.seq} ACK`],
        ...this.routeSet.map((r) => ['route', r]), ['contact', this.ua.contact]],
      body: '',
    };
    this.ua.send(this.ack);
  }

  target() {
    // Loose routing: the request goes to the remote target with the route set as Route headers.
    return this.remoteTarget;
  }

  resendAck() { if (this.ack) this.ua.send(this.ack); }

  /** Ends the call. Resolves whatever the server answers; the dialog is gone either way. */
  async bye() {
    if (this.ended) return null;
    this.ended = true;
    this.ua.dialogs.delete(this.callId);
    this.seq++;
    const msg = {
      method: 'BYE', uri: this.target(),
      headers: [['via', this.ua.via()], ['max-forwards', '70'], ['from', this.localUri], ['to', this.remoteTo], ['call-id', this.callId], ['cseq', `${this.seq} BYE`],
        ...this.routeSet.map((r) => ['route', r]), ['user-agent', USER_AGENT]],
      body: '',
    };
    try { return await this.ua.requestWithAuth(msg, { timeout: 8000 }); } catch (err) { this.ua.log.warn?.(`[sip] BYE unanswered for ${this.callId}: ${err.message}`); return null; }
  }
}
