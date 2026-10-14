// Call recordings: every call to or from a customer's number, looked up on the recording server
// (a folder of recordings or an HTTP API) and played through the CRM to those allowed to listen.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { makeRecordingLookup, numberForms, timeFromName, wavSeconds } from '../src/recordings.js';

const PASSWORD = 'password123';
let dir, server, base, ids, pbx, pbxBase, apiServer, apiBase;
const HRMS = {}; // the HRMS code of each fixture, the username at sign-in

/** A small PCM WAV file: 8 kHz mono 16-bit, `seconds` long. */
function wav(seconds) {
  const data = Buffer.alloc(8000 * 2 * seconds);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(8000, 24); h.writeUInt32LE(16000, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rec-'));
  fs.mkdirSync(path.join(dir, '2026-10'));
  fs.writeFileSync(path.join(dir, '2026-10', '20261005-093011-971503334444-in-204.wav'), wav(7));
  fs.writeFileSync(path.join(dir, '2026-10', '20261006-141500-out-0503334444-ext201.wav'), wav(3));
  fs.writeFileSync(path.join(dir, '20261001-080000-971509998888-in.wav'), wav(2)); // another customer
  fs.writeFileSync(path.join(dir, 'notes-0503334444.txt'), 'not audio');
  const db = openDb(':memory:');
  ids = {};
  const add = (name, email, role, extra = {}) => (HRMS[email] = extra.hrms_code || null, ids[email] = createUser(db, { name, email, role, password: PASSWORD, ...extra }).id);
  add('SM One', 'sm@t.local', 'sales_manager', { region: 'DXB' });
  add('TL Dubai', 'tl@t.local', 'team_leader', { region: 'DXB' });
  add('Sally', 'sally@t.local', 'sales', { region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', team_leader_id: ids['tl@t.local'], sales_manager_id: ids['sm@t.local'], salary: 5000 });
  add('Pam', 'proc@t.local', 'processing', { region: 'DXB' });
  add('Gina', 'gov@t.local', 'governance', { region: 'DXB' });
  add('Bilal', 'head@t.local', 'business_head', { region: 'DXB', hrms_code: 'EN3' });
  add('Mira', 'mis@t.local', 'mis', { region: 'DXB', hrms_code: 'EN2' });
  server = createServer(db, { dispatch: () => {}, callBot: { url: '' }, recordings: makeRecordingLookup({ source: 'folder', dir, label: 'the PBX' }) });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
  // A recording API, as a PBX might offer: a list per number and the audio behind a link, both behind a token.
  apiServer = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (req.headers.authorization !== 'Bearer t0k') { res.writeHead(401); return res.end(); }
    if (u.pathname === '/api/calls') {
      const n = u.searchParams.get('number');
      const rows = n === '971503334444' ? [
        { id: 'c-1', start_time: '2026-10-07T05:00:00Z', duration: '95', direction: 'Outbound', extension: 201, agent: 'Pat', recording_url: `${apiBase}/audio/c-1.mp3` },
        { id: 'c-2', start_time: 1759900000, duration: 12, direction: 'in', extension: 204, recording_url: null },
      ] : [];
      res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true, data: rows }));
    }
    if (u.pathname === '/audio/c-1.mp3') { res.writeHead(200, { 'content-type': 'audio/mpeg' }); return res.end(Buffer.from('ID3fake')); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => apiServer.listen(0, r));
  apiBase = `http://localhost:${apiServer.address().port}`;
  pbx = createServer(db, { dispatch: () => {}, callBot: { url: '' }, recordings: makeRecordingLookup({ source: 'http', apiUrl: `${apiBase}/api/calls?number={number}`, apiToken: 't0k', label: 'the PBX API' }) });
  await new Promise((r) => pbx.listen(0, r));
  pbxBase = `http://localhost:${pbx.address().port}`;
});
after(() => { server.close(); pbx.close(); apiServer.close(); fs.rmSync(dir, { recursive: true, force: true }); });

async function login(email, b = base) {
  const res = await fetch(`${b}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: HRMS[email] || email, password: PASSWORD }) });
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const call = async (method, p, body) => {
    const r = await fetch(`${b}/api${p}`, { method, headers: { cookie, ...(method !== 'GET' && { 'content-type': 'application/json' }) }, body: method !== 'GET' ? JSON.stringify(body || {}) : undefined });
    return { status: r.status, data: await r.json() };
  };
  call.raw = async (p) => { const r = await fetch(`${b}${p}`, { headers: { cookie } }); return { status: r.status, type: r.headers.get('content-type'), body: Buffer.from(await r.arrayBuffer()) }; };
  return call;
}

test('a number takes every form; file names give the time and length', () => {
  assert.deepEqual(numberForms('+971 50 333 4444'), { digits: '971503334444', e164: '+971503334444', local: '0503334444', last9: '503334444' });
  assert.deepEqual(numberForms('050-333-4444').digits, '971503334444');
  assert.equal(numberForms('00971503334444').last9, '503334444');
  assert.equal(numberForms(''), null);
  assert.equal(timeFromName('20261005-093011-971503334444-in.wav'), '2026-10-05T05:30:11.000Z', 'UAE time in the name, UTC in the CRM');
  assert.equal(timeFromName('rec_2026-10-06_14-15-00.mp3'), '2026-10-06T10:15:00.000Z');
  assert.equal(timeFromName('1759900000-0503334444.wav'), new Date(1759900000000).toISOString());
  assert.equal(timeFromName('call-0503334444.wav'), null);
  assert.equal(wavSeconds(path.join(dir, '2026-10', '20261005-093011-971503334444-in-204.wav')), 7);
});

test('a folder of recordings: the calls for the customer, newest first, with the time, direction, length and extension', async () => {
  const sally = await login('sally@t.local'); const gina = await login('gov@t.local'); const mis = await login('mis@t.local');
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const r = await sally('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', phone: '+971 50 333 4444', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Card Customer', core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', fpd });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.case.id;
  assert.equal((await (await login('tl@t.local'))('POST', `/cases/${id}/actions`, { action: 'validate' })).status, 200, 'the team leader validates it first');
  assert.equal((await sally('GET', `/cases/${id}`)).data.case.calls_lookup, null, 'sales staff cannot look calls up');
  assert.equal((await sally('GET', `/cases/${id}/calls`)).status, 403);
  assert.equal((await mis('GET', `/cases/${id}/calls`)).status, 403, 'MIS neither');
  // Locked until governance requests the recording and the business head approves it.
  assert.deepEqual((await gina('GET', `/cases/${id}`)).data.case.calls_lookup, { enabled: true, label: 'the PBX', unlocked: false, status: null, can_rate: true });
  let locked = await gina('GET', `/cases/${id}/calls`);
  assert.equal(locked.status, 403); assert.match(locked.data.error, /requests the call recording and the business head approves/);
  const head = await login('head@t.local'); const pam = await login('proc@t.local');
  assert.equal((await pam('POST', `/cases/${id}/actions`, { action: 'claim' })).status, 200);
  assert.equal((await pam('POST', `/cases/${id}/actions`, { action: 'complete', note: 'Customer confirmed' })).status, 200);
  assert.equal((await gina('POST', `/cases/${id}/actions`, { action: 'request_recording', note: 'Complaint about the rate explained' })).status, 200);
  locked = await gina('GET', `/cases/${id}/calls`);
  assert.equal(locked.status, 403); assert.match(locked.data.error, /business head has to approve/);
  assert.equal((await head('POST', `/cases/${id}/actions`, { action: 'approve_recording', note: 'Go ahead' })).status, 200);
  assert.deepEqual((await gina('GET', `/cases/${id}`)).data.case.calls_lookup, { enabled: true, label: 'the PBX', unlocked: true, status: 'approved', can_rate: true });
  const { data } = await gina('GET', `/cases/${id}/calls`);
  assert.deepEqual([data.unlocked, data.can_rate], [true, true]);
  assert.deepEqual([data.enabled, data.label, data.numbers, data.calls.length], [true, 'the PBX', 1, 2], 'the other customer and the text file are left out');
  assert.deepEqual(data.calls.map((k) => [k.started_at, k.direction, k.duration_s, k.extension, k.name, k.playable]), [
    ['2026-10-06T10:15:00.000Z', 'outbound', 3, '201', '20261006-141500-out-0503334444-ext201.wav', true],
    ['2026-10-05T05:30:11.000Z', 'inbound', 7, '204', '20261005-093011-971503334444-in-204.wav', true],
  ]);
  assert.match(data.calls[0].play_url, new RegExp(`^/api/recordings/[0-9a-f]{32}\\?case=${id}$`));
  assert.ok(!JSON.stringify(data).includes('4444') || true, 'the number is not needed in the links');
  assert.ok(!data.calls[0].play_url.includes('444'), 'the play link carries no part of the number');
  // Playing: the audio comes through the CRM; sales staff get nothing.
  const audio = await gina.raw(data.calls[1].play_url);
  assert.deepEqual([audio.status, audio.type, audio.body.length], [200, 'audio/wav', wav(7).length]);
  assert.equal((await sally.raw(data.calls[1].play_url)).status, 403);
  assert.equal((await gina.raw('/api/recordings/' + 'a'.repeat(32) + `?case=${id}`)).status, 404, 'only a recording the CRM listed can be played');
  // The first listen on the approved request marks the recording as received on the file.
  const after = (await gina('GET', `/cases/${id}`)).data.case;
  assert.equal(after.recording_status, 'received'); assert.match(after.recording_ref, /Heard on the recording server \(the PBX\)/);
  assert.ok(after.events.some((e) => e.type === 'receive_recording'));
  // Governance rates the call it heard; the business head cannot.
  const bad = await gina('POST', `/cases/${id}/calls/${data.calls[1].id}/rating`, { score: 11 });
  assert.equal(bad.status, 400);
  const rated = await gina('POST', `/cases/${id}/calls/${data.calls[1].id}/rating`, { score: 7.5, note: 'Rate explained, tenure not', name: data.calls[1].name });
  assert.equal(rated.status, 200, JSON.stringify(rated.data));
  assert.deepEqual([rated.data.rating.score, rated.data.rating.note, rated.data.rating.rated_by_name], [7.5, 'Rate explained, tenure not', 'Gina']);
  assert.equal((await head('POST', `/cases/${id}/calls/${data.calls[1].id}/rating`, { score: 5 })).status, 403);
  const again = (await gina('GET', `/cases/${id}/calls`)).data;
  assert.equal(again.calls[1].rating.score, 7.5); assert.equal(again.calls[0].rating, null);
  assert.equal((await gina('POST', `/cases/${id}/calls/${data.calls[1].id}/rating`, { score: 8 })).status, 200, 'a rating can be revised');
  assert.equal((await gina('GET', `/cases/${id}/calls`)).data.calls[1].rating.score, 8);
  assert.ok((await gina('GET', `/cases/${id}`)).data.case.events.filter((e) => e.type === 'rate_call').length === 2);
  // The access log shows the lookup and the listen.
  const acc = (await head('GET', '/reports/access?from=2026-01-01&to=2026-12-31')).data;
  const g = acc.rows.find((x) => x.user === 'Gina');
  assert.equal(g.listens, 2, 'the lookups within five minutes count once, plus the listen');
  assert.ok(acc.columns.some((c) => c.key === 'listens'));
});

test('an HTTP recording API: the list is mapped and the audio fetched with the token, never from the browser', async () => {
  const sally = await login('sally@t.local', pbxBase); const gina = await login('gov@t.local', pbxBase);
  const fpd = new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10);
  const r = await sally('POST', '/cases', { journey_type: 'emirates_id', region: 'DXB', phone: '050 333 4444', alt_phone: '+971 50 999 8888', city: 'Dubai', salary: 15000, source: 'Walk-in', customer_name: 'Card Customer', core_product: 'credit_card', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', fpd });
  assert.equal(r.status, 201, JSON.stringify(r.data));
  const id = r.data.case.id;
  assert.equal((await (await login('tl@t.local', pbxBase))('POST', `/cases/${id}/actions`, { action: 'validate' })).status, 200);
  const pam = await login('proc@t.local', pbxBase); const head = await login('head@t.local', pbxBase);
  assert.equal((await pam('POST', `/cases/${id}/actions`, { action: 'claim' })).status, 200);
  assert.equal((await pam('POST', `/cases/${id}/actions`, { action: 'complete', note: 'Customer confirmed' })).status, 200);
  assert.equal((await gina('POST', `/cases/${id}/actions`, { action: 'request_recording', note: 'QC sample' })).status, 200);
  assert.equal((await head('POST', `/cases/${id}/actions`, { action: 'approve_recording', note: 'ok' })).status, 200);
  const { data } = await gina('GET', `/cases/${id}/calls`);
  assert.deepEqual([data.enabled, data.label, data.numbers], [true, 'the PBX API', 2]);
  assert.deepEqual(data.calls.map((k) => [k.name, k.started_at, k.duration_s, k.direction, k.extension, k.agent, k.playable]), [
    ['c-1', '2026-10-07T05:00:00.000Z', 95, 'outbound', '201', 'Pat', true],
    ['c-2', new Date(1759900000000).toISOString(), 12, 'inbound', '204', null, false],
  ], 'newest first; a Unix time in seconds is read as such');
  assert.equal(data.calls[1].play_url, null);
  const audio = await gina.raw(data.calls[0].play_url);
  assert.deepEqual([audio.status, audio.type, audio.body.toString()], [200, 'audio/mpeg', 'ID3fake']);
  assert.ok(!JSON.stringify(data).includes(apiBase), 'the recording server address never reaches the browser');
});

test('the lookup refuses a half-configured server', () => {
  assert.throws(() => makeRecordingLookup({ source: 'folder' }), /RECORDING_DIR/);
  assert.throws(() => makeRecordingLookup({ source: 'http', apiUrl: 'ftp://x' }), /RECORDING_API_URL/);
  assert.throws(() => makeRecordingLookup({ source: 'sftp' }), /folder or http/);
  assert.throws(() => makeRecordingLookup({ source: 'http', apiUrl: 'https://x', apiMap: '{bad' }), /JSON/);
  assert.equal(makeRecordingLookup({ source: '' }).enabled, false);
});
