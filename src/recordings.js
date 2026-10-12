// Call recordings: every call to or from a customer's number, looked up on the recording server
// and played through the CRM to the people allowed to listen (governance, business heads and
// the verification team leader; each listen goes to the access log).
//
// Two kinds of recording server are supported, chosen with RECORDING_SOURCE:
//
//   folder  A directory (or a mounted share) of recordings, as a PBX or call recorder writes them:
//           RECORDING_DIR=/mnt/recordings. A file belongs to a number when its name carries the
//           number's digits (the last nine, so 050 123 4567, +971 50 123 4567 and 971501234567
//           all match). The date comes from the file name (20261012-093011, 2026-10-12_09-30-11
//           or a Unix time) or else the file's time; the direction from in/out, inbound/outbound,
//           incoming/outgoing in the name; the extension from any other 3-5 digit group.
//   http    A JSON API: RECORDING_API_URL=https://pbx.example/api/recordings?number={number}
//           ({number} is the number in digits with the country code, {local} with the leading 0,
//           {e164} with the plus), RECORDING_API_TOKEN sent as a bearer token, and
//           RECORDING_API_MAP, a JSON object naming the fields in the answer:
//           {"list":"data","id":"id","started_at":"start_time","duration":"duration",
//            "direction":"direction","extension":"extension","agent":"agent","url":"recording_url"}
//           (those are the defaults; "list" may be empty when the answer is the array itself).
//
// Either way the server's credentials and the audio stay on the CRM server: the browser only ever
// gets a CRM link, and the number never leaves the server as part of a link.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WorkflowError } from './cases.js';

export const AUDIO_EXTENSIONS = ['.wav', '.mp3', '.ogg', '.m4a', '.gsm', '.opus', '.webm'];
const AUDIO_TYPES = { '.wav': 'audio/wav', '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4', '.gsm': 'audio/x-gsm', '.opus': 'audio/ogg', '.webm': 'audio/webm' };
const DEFAULT_MAP = { list: 'data', id: 'id', started_at: 'start_time', duration: 'duration', direction: 'direction', extension: 'extension', agent: 'agent', url: 'recording_url' };
const MAX_FILES = 50_000;

/** The forms a number takes: digits with the country code, the local form, the last nine digits. */
export function numberForms(raw) {
  let d = String(raw || '').replace(/\D/g, '');
  if (!d) return null;
  if (d.startsWith('00')) d = d.slice(2);
  if (d.length === 10 && d.startsWith('0')) d = `971${d.slice(1)}`;
  else if (d.length === 9 && d.startsWith('5')) d = `971${d}`;
  const last9 = d.slice(-9);
  return { digits: d, e164: `+${d}`, local: d.startsWith('971') ? `0${d.slice(3)}` : d, last9 };
}

const DIRECTIONS = [[/\b(in|inbound|incoming|received)\b/i, 'inbound'], [/\b(out|outbound|outgoing|dialed|dialled)\b/i, 'outbound']];
export function directionOf(text) {
  for (const [re, dir] of DIRECTIONS) if (re.test(String(text || '').replace(/[_\-.]/g, ' '))) return dir;
  return null;
}

/** The call's start time from a recording's file name, if it carries one. */
export function timeFromName(name) {
  const s = String(name);
  let m = s.match(/(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})[T_\- ]?(\d{2})[-_.:]?(\d{2})[-_.:]?(\d{2})?/);
  if (m) {
    const [, y, mo, d, h, mi, sec] = m;
    const t = Date.UTC(+y, +mo - 1, +d, +h, +mi, +(sec || 0)) - 4 * 3600e3; // file names are in UAE time
    if (+mo >= 1 && +mo <= 12 && +d >= 1 && +d <= 31 && +h < 24 && +mi < 60) return new Date(t).toISOString();
  }
  m = s.match(/(?:^|\D)(1[5-9]\d{8})(?:\D|$)/); // a Unix time in seconds
  if (m) return new Date(+m[1] * 1000).toISOString();
  return null;
}

/** A WAV file's length in seconds from its header, or null for other formats. */
export function wavSeconds(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const head = Buffer.alloc(64);
    const n = fs.readSync(fd, head, 0, 64, 0);
    if (n < 44 || head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
    let off = 12; let byteRate = 0;
    while (off + 8 <= n) {
      const id = head.toString('ascii', off, off + 4); const size = head.readUInt32LE(off + 4);
      if (id === 'fmt ') byteRate = head.readUInt32LE(off + 16);
      if (id === 'data') return byteRate ? Math.round(Math.min(size, fs.fstatSync(fd).size - off - 8) / byteRate) : null;
      off += 8 + size + (size % 2);
    }
    return null;
  } catch { return null; } finally { if (fd != null) fs.closeSync(fd); }
}

/** Walks the recordings folder (three levels deep) and lists the audio files. */
function audioFiles(dir) {
  const out = [];
  const walk = (d, depth) => {
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (out.length >= MAX_FILES) return;
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (depth < 3) walk(p, depth + 1); continue; }
      if (e.isFile() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase())) out.push(p);
    }
  };
  walk(dir, 0);
  return out;
}

const idOf = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 32);

/**
 * The lookup service. `calls(numbers)` lists the recordings for a customer's numbers, newest
 * first; `stream(id, res)` plays one that a lookup listed. Playable ids are remembered from the
 * lookups, so a link can only reach a recording the CRM itself listed.
 */
export function makeRecordingLookup({
  source = process.env.RECORDING_SOURCE || '', dir = process.env.RECORDING_DIR || '', apiUrl = process.env.RECORDING_API_URL || '',
  apiToken = process.env.RECORDING_API_TOKEN || '', apiMap = process.env.RECORDING_API_MAP || '', fetchImpl = fetch, label = process.env.RECORDING_LABEL || '',
} = {}) {
  source = String(source || '').toLowerCase();
  if (source === 'folder' && !dir) throw new Error('RECORDING_SOURCE=folder needs RECORDING_DIR');
  if (source === 'http' && !/^https?:\/\//i.test(apiUrl)) throw new Error('RECORDING_SOURCE=http needs RECORDING_API_URL (http or https)');
  if (source && !['folder', 'http'].includes(source)) throw new Error('RECORDING_SOURCE must be folder or http');
  let map = { ...DEFAULT_MAP };
  if (apiMap) { try { map = { ...map, ...JSON.parse(apiMap) }; } catch { throw new Error('RECORDING_API_MAP must be JSON'); } }
  const known = new Map(); // id -> { kind, file | url }
  const remember = (kind, ref) => { const id = idOf(`${kind}:${ref}`); known.set(id, { kind, ref }); return id; };
  const enabled = Boolean(source);
  const sourceLabel = label || (source === 'folder' ? 'the recordings folder' : source === 'http' ? new URL(apiUrl).host : '');

  function fromFolder(forms) {
    const out = [];
    for (const file of audioFiles(dir)) {
      const name = path.basename(file);
      const digits = name.replace(/\D/g, '');
      if (!forms.some((f) => digits.includes(f.last9))) continue;
      let st; try { st = fs.statSync(file); } catch { continue; }
      const rest = name.replace(/\.[^.]+$/, '');
      const others = (rest.match(/\d+/g) || []).filter((g) => !forms.some((f) => g.includes(f.last9)) && g.length >= 3 && g.length <= 5);
      out.push({
        id: remember('file', path.relative(dir, file)), source: 'server', started_at: timeFromName(name) || st.mtime.toISOString(),
        duration_s: path.extname(file).toLowerCase() === '.wav' ? wavSeconds(file) : null, direction: directionOf(rest), extension: others[0] || null, agent: null,
        name, size: st.size, playable: true,
      });
    }
    return out;
  }

  async function fromApi(forms) {
    const f = forms[0];
    const url = apiUrl.replace(/\{number\}/g, encodeURIComponent(f.digits)).replace(/\{local\}/g, encodeURIComponent(f.local)).replace(/\{e164\}/g, encodeURIComponent(f.e164));
    let res;
    try { res = await fetchImpl(url, { headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {}, signal: AbortSignal.timeout(15_000) }); }
    catch (err) { throw new WorkflowError(502, `The recording server could not be reached: ${err.message}`); }
    if (!res.ok) throw new WorkflowError(502, `The recording server answered ${res.status}`);
    let body;
    try { body = await res.json(); } catch { throw new WorkflowError(502, 'The recording server did not answer with JSON'); }
    const list = map.list ? map.list.split('.').reduce((o, k) => (o == null ? o : o[k]), body) : body;
    if (!Array.isArray(list)) throw new WorkflowError(502, `The recording server's answer has no "${map.list || ''}" list`);
    return list.map((r) => {
      const get = (k) => (map[k] ? map[k].split('.').reduce((o, kk) => (o == null ? o : o[kk]), r) : undefined);
      const u = get('url');
      const started = get('started_at');
      const dur = get('duration');
      return {
        id: u ? remember('url', String(u)) : null, source: 'server', started_at: started ? new Date(/^\d+$/.test(String(started)) ? +started * (String(started).length > 10 ? 1 : 1000) : started).toISOString() : null,
        duration_s: dur == null || dur === '' ? null : Math.round(Number(dur)) || null, direction: directionOf(get('direction')) || (get('direction') ? String(get('direction')) : null),
        extension: get('extension') != null ? String(get('extension')) : null, agent: get('agent') != null ? String(get('agent')) : null, name: get('id') != null ? String(get('id')) : null, playable: Boolean(u),
      };
    });
  }

  /** The recordings for the numbers (phone and alternative phone), newest first, de-duplicated across the numbers. */
  async function calls(numbers) {
    const forms = numbers.map(numberForms).filter(Boolean).filter((f, i, a) => a.findIndex((x) => x.last9 === f.last9) === i);
    if (!enabled || !forms.length) return [];
    let rows = [];
    if (source === 'folder') rows = fromFolder(forms);
    else for (const f of forms) rows.push(...await fromApi([f]));
    const seen = new Set();
    return rows.filter((r) => { const k = r.id || `${r.name}|${r.started_at}`; if (seen.has(k)) return false; seen.add(k); return true; })
      .sort((a, b) => String(b.started_at || '').localeCompare(String(a.started_at || '')));
  }

  /** Streams one listed recording to the browser. */
  async function stream(id, res) {
    const rec = known.get(String(id));
    if (!rec) throw new WorkflowError(404, 'Recording not found: open the file and look the calls up again');
    if (rec.kind === 'file') {
      const file = path.resolve(dir, rec.ref);
      if (!file.startsWith(path.resolve(dir) + path.sep) || !fs.existsSync(file)) throw new WorkflowError(404, 'The recording is no longer on the server');
      const st = fs.statSync(file);
      res.writeHead(200, { 'content-type': AUDIO_TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream', 'content-length': st.size, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
      await new Promise((resolve, reject) => fs.createReadStream(file).on('error', reject).on('end', resolve).pipe(res));
      return;
    }
    let up;
    try { up = await fetchImpl(rec.ref, { headers: apiToken ? { authorization: `Bearer ${apiToken}` } : {}, signal: AbortSignal.timeout(60_000) }); }
    catch (err) { throw new WorkflowError(502, `The recording could not be fetched: ${err.message}`); }
    if (!up.ok) throw new WorkflowError(up.status === 404 ? 404 : 502, up.status === 404 ? 'The recording is no longer on the server' : `The recording server answered ${up.status}`);
    const audio = Buffer.from(await up.arrayBuffer());
    res.writeHead(200, { 'content-type': up.headers.get('content-type') || 'audio/mpeg', 'content-length': audio.length, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
    res.end(audio);
  }

  return { enabled, source, label: sourceLabel, calls, stream };
}
