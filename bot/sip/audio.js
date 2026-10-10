// Telephone audio for the native calling service: G.711 (what SIP trunks speak), resampling
// between the line's 8 kHz and the speech engines' rates, WAV files for the engines and the
// recording, and an endpointer that tells where the customer starts and stops speaking.
// Everything is 16-bit signed PCM in Int16Arrays; the line runs at 8 kHz in 20 ms frames.
import fs from 'node:fs';

export const LINE_RATE = 8000;
export const FRAME_MS = 20;
export const FRAME_SAMPLES = (LINE_RATE * FRAME_MS) / 1000; // 160

// ---- G.711 ----------------------------------------------------------------------------------
const BIAS = 0x84;
const CLIP = 32635;
const SEG_END = [0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff, 0x1fff, 0x3fff, 0x7fff];

function segment(v) {
  for (let i = 0; i < 8; i++) if (v <= SEG_END[i]) return i;
  return 8;
}

export function ulawEncode(sample) {
  let s = sample;
  const sign = s < 0 ? 0x80 : 0;
  if (sign) s = -s;
  if (s > CLIP) s = CLIP;
  s += BIAS;
  const seg = segment(s);
  if (seg >= 8) return 0x7f ^ sign;
  const mant = (s >> (seg + 3)) & 0x0f;
  return ~(sign | (seg << 4) | mant) & 0xff;
}

export function ulawDecode(byte) {
  const u = ~byte & 0xff;
  let t = ((u & 0x0f) << 3) + BIAS;
  t <<= (u & 0x70) >> 4;
  return u & 0x80 ? BIAS - t : t - BIAS;
}

const ALAW_SEG_END = [0x1f, 0x3f, 0x7f, 0xff, 0x1ff, 0x3ff, 0x7ff, 0xfff];

export function alawEncode(sample) {
  let s = sample >> 3; // A-law works on 13-bit samples
  let mask;
  if (s >= 0) mask = 0xd5;
  else { mask = 0x55; s = -s - 1; }
  let seg = 0;
  while (seg < 8 && s > ALAW_SEG_END[seg]) seg++;
  if (seg >= 8) return 0x7f ^ mask;
  let aval = seg << 4;
  aval |= seg < 2 ? (s >> 1) & 0x0f : (s >> seg) & 0x0f;
  return aval ^ mask;
}

export function alawDecode(byte) {
  const a = byte ^ 0x55;
  let t = (a & 0x0f) << 4;
  const seg = (a & 0x70) >> 4;
  if (seg === 0) t += 8;
  else if (seg === 1) t += 0x108;
  else t = (t + 0x108) << (seg - 1);
  return a & 0x80 ? t : -t;
}

const ULAW_TABLE = new Int16Array(256).map((_, i) => ulawDecode(i));
const ALAW_TABLE = new Int16Array(256).map((_, i) => alawDecode(i));

export const PCMU = 0;
export const PCMA = 8;

export function encodeG711(pcm, payloadType = PCMU) {
  const enc = payloadType === PCMA ? alawEncode : ulawEncode;
  const out = Buffer.allocUnsafe(pcm.length);
  for (let i = 0; i < pcm.length; i++) out[i] = enc(pcm[i]);
  return out;
}

export function decodeG711(buf, payloadType = PCMU) {
  const table = payloadType === PCMA ? ALAW_TABLE : ULAW_TABLE;
  const out = new Int16Array(buf.length);
  for (let i = 0; i < buf.length; i++) out[i] = table[buf[i]];
  return out;
}

// ---- PCM helpers ----------------------------------------------------------------------------
export const silence = (samples = FRAME_SAMPLES) => new Int16Array(samples);

export function concat(chunks) {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Int16Array(n);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

/** Sums two frames (what the bot said and what the customer said) for the recording. */
export function mix(a, b) {
  const out = new Int16Array(Math.max(a.length, b.length));
  for (let i = 0; i < out.length; i++) {
    const v = (a[i] || 0) + (b[i] || 0);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

export function rms(pcm) {
  if (!pcm.length) return 0;
  let sum = 0;
  for (let i = 0; i < pcm.length; i++) sum += pcm[i] * pcm[i];
  return Math.sqrt(sum / pcm.length);
}

/** Linear resampling, with a box low-pass when going down so the line's hiss doesn't alias. */
export function resample(pcm, from, to) {
  if (from === to) return pcm;
  let src = pcm;
  if (to < from) {
    const span = Math.max(1, Math.round(from / to));
    if (span > 1) {
      src = new Int16Array(pcm.length);
      for (let i = 0; i < pcm.length; i++) {
        let sum = 0; let n = 0;
        for (let j = i - (span >> 1); j <= i + (span >> 1); j++) if (j >= 0 && j < pcm.length) { sum += pcm[j]; n++; }
        src[i] = sum / n;
      }
    }
  }
  const outLen = Math.round((src.length * to) / from);
  const out = new Int16Array(outLen);
  const step = from / to;
  for (let i = 0; i < outLen; i++) {
    const pos = i * step;
    const i0 = Math.floor(pos);
    const i1 = Math.min(i0 + 1, src.length - 1);
    const frac = pos - i0;
    out[i] = src[i0] + (src[i1] - src[i0]) * frac;
  }
  return out;
}

/** Splits PCM into 20 ms frames, padding the last with silence. */
export function frames(pcm, size = FRAME_SAMPLES) {
  const out = [];
  for (let at = 0; at < pcm.length; at += size) {
    const f = new Int16Array(size);
    f.set(pcm.subarray(at, Math.min(at + size, pcm.length)));
    out.push(f);
  }
  return out;
}

// ---- WAV ------------------------------------------------------------------------------------
export function wavHeader(dataBytes, rate, channels = 1) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + dataBytes, 4); h.write('WAVE', 8);
  h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(channels, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * channels * 2, 28); h.writeUInt16LE(channels * 2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(dataBytes, 40);
  return h;
}

export function wavEncode(pcm, rate = LINE_RATE) {
  const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
  return Buffer.concat([wavHeader(data.length, rate), data]);
}

/** Reads a 16-bit PCM WAV (mono, or stereo mixed to mono). Speech engines write these. */
export function wavDecode(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') throw new Error('Not a WAV file');
  let at = 12; let fmt = null; let data = null;
  while (at + 8 <= buf.length) {
    const id = buf.toString('ascii', at, at + 4);
    const size = buf.readUInt32LE(at + 4);
    const body = buf.subarray(at + 8, Math.min(at + 8 + size, buf.length));
    if (id === 'fmt ') fmt = { format: body.readUInt16LE(0), channels: body.readUInt16LE(2), rate: body.readUInt32LE(4), bits: body.readUInt16LE(14) };
    else if (id === 'data') data = body;
    at += 8 + size + (size % 2);
  }
  if (!fmt || !data) throw new Error('WAV file has no audio');
  if (fmt.format !== 1 || fmt.bits !== 16) throw new Error(`Only 16-bit PCM WAV is supported (got format ${fmt.format}, ${fmt.bits} bits)`);
  const total = Math.floor(data.length / 2);
  const samples = Math.floor(total / fmt.channels);
  const pcm = new Int16Array(samples);
  for (let i = 0; i < samples; i++) {
    let v = 0;
    for (let c = 0; c < fmt.channels; c++) v += data.readInt16LE((i * fmt.channels + c) * 2);
    pcm[i] = v / fmt.channels;
  }
  return { rate: fmt.rate, pcm };
}

/** Writes a WAV file frame by frame; the header is completed when the recording ends. */
export class WavWriter {
  constructor(path, rate = LINE_RATE) {
    this.path = path; this.rate = rate; this.bytes = 0;
    this.fd = fs.openSync(path, 'w');
    fs.writeSync(this.fd, wavHeader(0, rate));
  }
  write(pcm) {
    if (this.fd === null) return;
    const data = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.length * 2);
    fs.writeSync(this.fd, data);
    this.bytes += data.length;
  }
  close() {
    if (this.fd === null) return;
    fs.writeSync(this.fd, wavHeader(this.bytes, this.rate), 0, 44, 0);
    fs.closeSync(this.fd);
    this.fd = null;
  }
}

// ---- Endpointer -----------------------------------------------------------------------------
/**
 * Decides, frame by frame, when the customer starts and stops speaking, the way a speech
 * service's "speech timeout" does. Energy-based: the noise floor is learned from the quiet
 * frames and speech is what rises well above it. Events: 'start' (with the pre-roll frames
 * kept from just before), 'frame' while speaking, 'end' (silence long enough after speech).
 */
export class Endpointer {
  constructor({ silenceMs = 800, minSpeechMs = 120, preRollMs = 300, floor = 250, ratio = 3 } = {}) {
    this.silenceFrames = Math.ceil(silenceMs / FRAME_MS);
    this.minSpeechFrames = Math.ceil(minSpeechMs / FRAME_MS);
    this.preRollFrames = Math.ceil(preRollMs / FRAME_MS);
    this.floorMin = floor; this.ratio = ratio;
    this.reset();
  }
  reset() {
    this.noise = this.floorMin; this.speaking = false; this.loud = 0; this.quiet = 0; this.preRoll = [];
    this.speech = []; this.candidate = [];
  }
  threshold() { return Math.max(this.floorMin, this.noise * this.ratio); }
  /** Feeds one frame; returns 'start', 'end', 'frame' or null. */
  feed(frame) {
    const level = rms(frame);
    const loud = level > this.threshold();
    if (!loud) this.noise = this.noise * 0.95 + Math.min(level, this.threshold()) * 0.05;
    if (!this.speaking) {
      if (loud) {
        this.candidate.push(frame); this.loud++;
        if (this.loud >= this.minSpeechFrames) {
          this.speaking = true; this.quiet = 0;
          this.speech = [...this.preRoll, ...this.candidate];
          this.candidate = []; this.loud = 0;
          return 'start';
        }
      } else {
        this.loud = 0;
        this.preRoll.push(...this.candidate, frame); this.candidate = [];
        while (this.preRoll.length > this.preRollFrames) this.preRoll.shift();
      }
      return null;
    }
    this.speech.push(frame);
    if (loud) { this.quiet = 0; return 'frame'; }
    if (++this.quiet >= this.silenceFrames) {
      this.speaking = false; this.quiet = 0;
      this.preRoll = [];
      return 'end';
    }
    return 'frame';
  }
  /** The speech heard since 'start', trailing silence trimmed to half the silence span. */
  take() {
    const keep = Math.max(0, this.speech.length - Math.floor(this.silenceFrames / 2));
    const pcm = concat(this.speech.slice(0, Math.max(keep, 1)));
    this.speech = [];
    return pcm;
  }
}
