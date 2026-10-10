// A stand-in for a SIP provider and the customer's phone, for the native calling bot's tests.
// Over real UDP it challenges the INVITE for digest credentials, rings, answers (or is busy,
// unknown, or never picks up), exchanges G.711 RTP, and plays the customer: whenever the bot
// finishes a line it "speaks" (a burst of noise) for a while, so the bot's endpointer hears an
// answer. It can also hang up on the bot, or talk over it like a voicemail greeting.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { decodeG711, encodeG711, rms } from '../../bot/sip/audio.js';
import { parseRtp } from '../../bot/sip/rtp.js';
import { digestAuthorization, header, headersOf, parseChallenge, parseMessage, parseSdp } from '../../bot/sip/sip.js';

const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

export class FakeSipPeer {
  constructor({ behaviour = 'answer', challenge = true, username = 'crmbot', password = 'secret', speakMs = 400, replyAfterMs = 200, greetingMs = 0 } = {}) {
    Object.assign(this, { behaviour, challenge, username, password, speakMs, replyAfterMs, greetingMs });
    this.realm = 'fake.trunk'; this.nonce = crypto.randomBytes(8).toString('hex');
    this.invites = []; this.byes = 0; this.cancels = 0; this.registers = 0; this.authorized = false;
    this.call = null; this.log = [];
  }

  async start() {
    this.sip = dgram.createSocket('udp4');
    this.sip.on('message', (m, r) => this.onSip(m.toString(), r));
    await new Promise((res) => this.sip.bind(0, '127.0.0.1', res));
    this.port = this.sip.address().port;
    return this;
  }

  stop() {
    this.endMedia();
    this.sip.close();
  }

  send(text, rinfo) { this.sip.send(text, rinfo.port, rinfo.address); }

  response(req, status, reason, extra = [], body = '') {
    const to = header(req, 'to');
    const lines = [`SIP/2.0 ${status} ${reason}`, ...headersOf(req, 'via').map((v) => `Via: ${v}`), `From: ${header(req, 'from')}`,
      `To: ${to.includes('tag=') || status === 100 ? to : `${to};tag=${this.toTag ||= crypto.randomBytes(3).toString('hex')}`}`,
      `Call-ID: ${header(req, 'call-id')}`, `CSeq: ${header(req, 'cseq')}`, ...extra, `Content-Length: ${Buffer.byteLength(body)}`, '', body];
    return lines.join('\r\n');
  }

  digestOk(req) {
    const c = parseChallenge(header(req, 'authorization'));
    if (!c || c.username !== this.username || c.realm !== this.realm || c.nonce !== this.nonce) return false;
    const expected = parseChallenge(digestAuthorization({ username: this.username, password: this.password, method: req.method, uri: c.uri, challenge: { realm: this.realm, nonce: this.nonce, qop: 'auth' }, nc: Number.parseInt(c.nc, 16), cnonce: c.cnonce }));
    return expected.response === c.response;
  }

  onSip(text, rinfo) {
    const req = parseMessage(text);
    if (!req || !req.method) return;
    this.log.push(`${req.method} ${header(req, 'cseq')}`);
    if (req.method === 'REGISTER') {
      this.registers++;
      if (this.challenge && !header(req, 'authorization')) return this.send(this.response(req, 401, 'Unauthorized', [`WWW-Authenticate: Digest realm="${this.realm}", nonce="${this.nonce}", qop="auth"`]), rinfo);
      if (this.challenge && !this.digestOk(req)) return this.send(this.response(req, 403, 'Forbidden'), rinfo);
      return this.send(this.response(req, 200, 'OK', [`Contact: ${header(req, 'contact')}`, 'Expires: 120']), rinfo);
    }
    if (req.method === 'INVITE') {
      this.invites.push(req);
      if (this.challenge && !header(req, 'authorization')) return this.send(this.response(req, 401, 'Unauthorized', [`WWW-Authenticate: Digest realm="${this.realm}", nonce="${this.nonce}", qop="auth"`]), rinfo);
      if (this.challenge && !this.digestOk(req)) return this.send(this.response(req, 403, 'Forbidden'), rinfo);
      this.authorized = true;
      this.invite = req; this.inviteFrom = rinfo;
      this.send(this.response(req, 100, 'Trying'), rinfo);
      this.send(this.response(req, 180, 'Ringing'), rinfo);
      if (this.behaviour === 'busy') return this.send(this.response(req, 486, 'Busy Here'), rinfo);
      if (this.behaviour === 'unknown') return this.send(this.response(req, 404, 'Not Found'), rinfo);
      if (this.behaviour === 'ring') return; // never answers
      return this.answer(req, rinfo);
    }
    if (req.method === 'CANCEL') {
      this.cancels++;
      this.send(this.response(req, 200, 'OK'), rinfo);
      if (this.invite) this.send(this.response(this.invite, 487, 'Request Terminated'), rinfo);
      return;
    }
    if (req.method === 'ACK') { this.acked = true; return; }
    if (req.method === 'BYE') {
      this.byes++;
      this.send(this.response(req, 200, 'OK'), rinfo);
      this.endMedia();
      return;
    }
    this.send(this.response(req, 200, 'OK'), rinfo);
  }

  async answer(req, rinfo) {
    const offer = parseSdp(req.body);
    this.rtp = dgram.createSocket('udp4');
    await new Promise((res) => this.rtp.bind(0, '127.0.0.1', res));
    this.media = { address: offer.address, port: offer.port, pt: offer.types.includes(8) ? 8 : 0 };
    const sdp = ['v=0', 'o=- 1 1 IN IP4 127.0.0.1', 's=peer', 'c=IN IP4 127.0.0.1', 't=0 0', `m=audio ${this.rtp.address().port} RTP/AVP ${this.media.pt} 101`,
      `a=rtpmap:${this.media.pt} ${this.media.pt === 8 ? 'PCMA' : 'PCMU'}/8000`, 'a=rtpmap:101 telephone-event/8000', 'a=sendrecv', ''].join('\r\n');
    this.send(this.response(req, 200, 'OK', [`Contact: <sip:peer@127.0.0.1:${this.port}>`, 'Record-Route: <sip:127.0.0.1:' + this.port + ';lr>', 'Content-Type: application/sdp'], sdp), rinfo);
    this.startMedia();
  }

  // The customer's phone: hears the bot, answers each line with a burst of noise.
  startMedia() {
    this.call = { heardFrames: 0, loud: false, quietSince: null, speakUntil: 0, spokenBursts: 0, linesHeard: 0, lineOpen: false, seq: 1, ts: 0, ssrc: 0x1234 };
    const started = Date.now();
    if (this.greetingMs) this.call.speakUntil = started + this.greetingMs;
    this.rtp.on('message', (buf) => {
      const p = parseRtp(buf);
      if (!p) return;
      this.call.heardFrames++;
      const loud = rms(decodeG711(p.payload, p.payloadType)) > 500;
      const now = Date.now();
      if (loud) { this.call.lineOpen = true; this.call.quietSince = null; }
      else if (this.call.lineOpen) {
        this.call.quietSince ??= now;
        if (now - this.call.quietSince >= this.replyAfterMs) {
          this.call.lineOpen = false; this.call.linesHeard++;
          if (!this.call.silent) { this.call.speakUntil = Math.max(this.call.speakUntil, now + this.speakMs); this.call.spokenBursts++; }
        }
      }
    });
    this.ticker = setInterval(() => {
      const c = this.call; if (!c) return;
      const speaking = Date.now() < c.speakUntil;
      const pcm = new Int16Array(160);
      if (speaking) for (let i = 0; i < 160; i++) pcm[i] = (Math.random() * 2 - 1) * 6000;
      const h = Buffer.alloc(12); h[0] = 0x80; h[1] = this.media.pt; h.writeUInt16BE(c.seq++ & 0xffff, 2); h.writeUInt32BE(c.ts, 4); h.writeUInt32BE(c.ssrc, 8);
      c.ts += 160;
      this.rtp.send(Buffer.concat([h, encodeG711(pcm, this.media.pt)]), this.media.port, this.media.address);
    }, 20);
  }

  endMedia() {
    clearInterval(this.ticker); this.ticker = null;
    try { this.rtp?.close(); } catch { /* closed */ }
    this.rtp = null;
  }

  /** The customer hangs up. */
  hangUp() {
    const inv = this.invite;
    const contact = header(inv, 'contact').match(/<([^>]+)>/)[1];
    const from = header(inv, 'from'); const to = `${header(inv, 'to')};tag=${this.toTag}`;
    const bye = ['BYE ' + contact + ' SIP/2.0', 'Via: SIP/2.0/UDP 127.0.0.1:' + this.port + ';branch=z9hG4bKpeer' + Date.now(), `From: ${to}`, `To: ${from}`,
      `Call-ID: ${header(inv, 'call-id')}`, 'CSeq: 1 BYE', 'Max-Forwards: 70', 'Content-Length: 0', '', ''].join('\r\n');
    this.send(bye, this.inviteFrom);
    this.endMedia();
  }
}

export { md5 };
