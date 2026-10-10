// RTP for one call: a UDP socket that sends the bot's voice as G.711 in 20 ms packets and
// decodes what the customer says. A ticker runs the whole call at line speed: every 20 ms it
// sends the next frame to play (silence when the bot is quiet, so the trunk never times out),
// hands the frame that arrived to the listener and writes both to the recording.
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { FRAME_MS, FRAME_SAMPLES, PCMA, PCMU, decodeG711, encodeG711, mix, silence } from './audio.js';

const MAX_CATCHUP = 5;

/** Binds a UDP socket on an even port in the range, the way SIP media expects. */
export function bindRtp(localIp, [from, to] = [10000, 20000]) {
  return new Promise((resolve, reject) => {
    let tries = 0;
    const attempt = () => {
      const port = from + 2 * Math.floor(Math.random() * ((to - from) / 2));
      const sock = dgram.createSocket('udp4');
      sock.once('error', (err) => {
        sock.close();
        if (++tries < 20 && err.code === 'EADDRINUSE') attempt();
        else reject(err);
      });
      sock.bind(port, localIp, () => { sock.removeAllListeners('error'); resolve(sock); });
    };
    attempt();
  });
}

export function parseRtp(buf) {
  if (buf.length < 12 || buf[0] >> 6 !== 2) return null;
  const cc = buf[0] & 0x0f;
  const ext = buf[0] & 0x10;
  const padding = buf[0] & 0x20;
  let at = 12 + cc * 4;
  if (ext) { if (buf.length < at + 4) return null; at += 4 + buf.readUInt16BE(at + 2) * 4; }
  let end = buf.length;
  if (padding) end -= buf[buf.length - 1];
  if (at > end) return null;
  return { marker: Boolean(buf[1] & 0x80), payloadType: buf[1] & 0x7f, seq: buf.readUInt16BE(2), timestamp: buf.readUInt32BE(4), ssrc: buf.readUInt32BE(8), payload: buf.subarray(at, end) };
}

export class RtpSession extends EventEmitter {
  /**
   * @param {dgram.Socket} socket  bound media socket
   * @param {{ payloadType?: number, symmetric?: boolean }} opts
   */
  constructor(socket, { payloadType = PCMU, symmetric = true } = {}) {
    super();
    this.socket = socket;
    this.payloadType = payloadType;
    this.symmetric = symmetric;
    this.remote = null;
    this.ssrc = crypto.randomBytes(4).readUInt32BE(0);
    this.seq = crypto.randomBytes(2).readUInt16BE(0);
    this.timestamp = crypto.randomBytes(4).readUInt32BE(0);
    this.first = true;
    this.queue = [];       // frames waiting to be played
    this.inbound = [];     // frames received, waiting for the ticker
    this.recorder = null;  // { write(pcm) }
    this.closed = false;
    this.received = 0;
    socket.on('message', (msg, rinfo) => this.onPacket(msg, rinfo));
  }

  get localPort() { return this.socket.address().port; }

  setRemote(address, port, payloadType) {
    this.remote = { address, port };
    if (payloadType === PCMU || payloadType === PCMA) this.payloadType = payloadType;
  }

  onPacket(msg, rinfo) {
    const p = parseRtp(msg);
    if (!p) return;
    if (p.payloadType !== PCMU && p.payloadType !== PCMA) return; // DTMF events, comfort noise
    this.received++;
    // Many trunks sit behind NAT and send from a different port than their SDP says: answer there.
    if (this.symmetric && this.remote && (rinfo.address !== this.remote.address || rinfo.port !== this.remote.port)) {
      this.remote = { address: rinfo.address, port: rinfo.port };
    }
    const pcm = decodeG711(p.payload, p.payloadType);
    for (let at = 0; at < pcm.length; at += FRAME_SAMPLES) {
      const f = new Int16Array(FRAME_SAMPLES);
      f.set(pcm.subarray(at, Math.min(at + FRAME_SAMPLES, pcm.length)));
      this.inbound.push(f);
    }
    if (this.inbound.length > 50) this.inbound.splice(0, this.inbound.length - 50);
  }

  /** Starts the 20 ms ticker. */
  start() {
    if (this.timer) return;
    this.base = process.hrtime.bigint();
    this.ticks = 0;
    const tick = () => {
      if (this.closed) return;
      const elapsed = Number(process.hrtime.bigint() - this.base) / 1e6;
      let due = Math.floor(elapsed / FRAME_MS) - this.ticks;
      if (due > MAX_CATCHUP) { this.ticks += due - MAX_CATCHUP; due = MAX_CATCHUP; }
      for (let i = 0; i < due; i++) { this.ticks++; this.oneFrame(); }
      const next = (this.ticks + 1) * FRAME_MS - (Number(process.hrtime.bigint() - this.base) / 1e6);
      this.timer = setTimeout(tick, Math.max(1, next));
    };
    this.timer = setTimeout(tick, FRAME_MS);
  }

  oneFrame() {
    const out = this.queue.length ? this.queue.shift() : silence();
    const heard = this.inbound.length ? this.inbound.shift() : silence();
    if (this.remote) this.sendFrame(out);
    if (!this.queue.length && this.playing) { this.playing = false; this.emit('played'); }
    this.recorder?.write(mix(out, heard));
    this.emit('frame', heard, out);
  }

  sendFrame(pcm) {
    const payload = encodeG711(pcm, this.payloadType);
    const h = Buffer.alloc(12);
    h[0] = 0x80;
    h[1] = (this.first ? 0x80 : 0) | this.payloadType;
    h.writeUInt16BE(this.seq, 2);
    h.writeUInt32BE(this.timestamp >>> 0, 4);
    h.writeUInt32BE(this.ssrc, 8);
    this.first = false;
    this.seq = (this.seq + 1) & 0xffff;
    this.timestamp = (this.timestamp + pcm.length) >>> 0;
    try { this.socket.send(Buffer.concat([h, payload]), this.remote.port, this.remote.address); } catch { /* socket closing */ }
  }

  /** Queues audio (8 kHz PCM) to play; resolves when the last frame has gone out. */
  play(pcm) {
    for (let at = 0; at < pcm.length; at += FRAME_SAMPLES) {
      const f = new Int16Array(FRAME_SAMPLES);
      f.set(pcm.subarray(at, Math.min(at + FRAME_SAMPLES, pcm.length)));
      this.queue.push(f);
    }
    if (!this.queue.length) return Promise.resolve();
    this.playing = true;
    return new Promise((resolve) => this.once('played', resolve));
  }

  /** Drops what is left to play (the customer spoke over the bot). */
  stop() {
    this.queue.length = 0;
    if (this.playing) { this.playing = false; this.emit('played'); }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    this.stop();
    try { this.socket.close(); } catch { /* already closed */ }
    this.emit('close');
  }
}
