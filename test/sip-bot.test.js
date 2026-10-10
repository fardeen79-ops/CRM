// The native calling bot (bot/sip-server.js): the CRM asks it to call; it dials a stand-in SIP
// provider over real UDP, talks G.711 to the stand-in customer, runs the playbook with stand-in
// speech engines, and reports back the way the CRM expects. Plus the audio, SIP and speech
// building blocks on their own.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { sign } from '../bot/server.js';
import { createSipBotService, audioFromEnv, sipFromEnv } from '../bot/sip-server.js';
import { SipUA, SipError, parseMessage, serialize, digestAuthorization, parseChallenge, parseSdp, buildSdp, tagOf, uriOf } from '../bot/sip/sip.js';
import { Endpointer, alawDecode, alawEncode, decodeG711, encodeG711, resample, ulawDecode, ulawEncode, wavDecode, wavEncode, mix, FRAME_SAMPLES } from '../bot/sip/audio.js';
import { parseRtp } from '../bot/sip/rtp.js';
import { cleanTranscript, langCode, makeStt, makeTts, splitCommand } from '../bot/sip/speech.js';
import { outcomeOf } from '../bot/sip/call.js';
import { FakeSipPeer } from './helpers/fake-sip-peer.js';

const PASSWORD = 'password123';
const SECRET = 'shared-secret';
const QUICK = { ringTimeoutMs: 1500, noSpeechMs: 1500, silenceMs: 300, maxUtteranceMs: 4000, machineMs: 1500, machineWindowMs: 3000, portRange: [40000, 41000] };
const T0 = Date.now();
const trace = (...a) => { if (process.env.TRACE) console.log(String(Date.now() - T0).padStart(6), ...a); };
const quiet = { info: (m) => trace(m), warn: (m) => trace(m), error: (m) => trace(m) };
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-sip-'));

let db, crm, crmBase, peer, bot, botBase;
const answers = [];       // what the stand-in recogniser "hears", in order
const spoken = [];        // the lines the bot asked the voice for
const heardPcm = [];      // the customer audio handed to the recogniser
const hints = [];

/** A tone, so the stand-in customer can hear the bot's line end. */
const tone = (ms) => Int16Array.from({ length: (8000 * ms) / 1000 }, (_, i) => Math.sin((2 * Math.PI * 500 * i) / 8000) * 9000);
const tts = async ({ text }) => { spoken.push(text); trace('tts', text.slice(0, 30)); return tone(300); };
const stt = async ({ pcm, hints: h }) => { heardPcm.push(pcm); hints.push(h); return answers.shift() ?? ''; };

async function startBot(peerOpts = {}, botOpts = {}) {
  peer = await new FakeSipPeer(peerOpts).start();
  const ua = new SipUA({ server: `127.0.0.1:${peer.port}`, username: 'crmbot', password: 'secret', domain: 'fake.trunk', callerId: '97140000000', displayName: 'Verification team', localIp: '127.0.0.1', localPort: 0, register: peerOpts.register ?? true, log: quiet });
  bot = createSipBotService({ secret: SECRET, ua, stt, tts, recordingsDir: tmp, log: quiet, audio: { ...QUICK, ...botOpts.audio }, country: '971', ...botOpts });
  await bot.start();
  await new Promise((r) => bot.listen(0, r));
  botBase = `http://localhost:${bot.address().port}`;
  bot.ua.log = quiet;
  return bot;
}
async function stopBot() {
  if (!bot) return;
  await bot.ua.stop();
  await new Promise((r) => bot.close(r));
  peer.stop(); bot = null; peer = null;
}

before(async () => {
  db = openDb(':memory:');
  const lead = createUser(db, { name: 'Lead', email: 'lead@t.local', role: 'team_leader', password: PASSWORD });
  const sm = createUser(db, { name: 'Manager', email: 'sm@t.local', role: 'sales_manager', password: PASSWORD });
  createUser(db, { name: 'Pam', email: 'proc@t.local', role: 'processing', password: PASSWORD });
  createUser(db, { name: 'Vera', email: 'vlead@t.local', role: 'processing_lead', password: PASSWORD });
  createUser(db, { name: 'Boss', email: 'bh@t.local', role: 'business_head', password: PASSWORD, region: 'DXB' });
  createUser(db, { name: 'Gina', email: 'gov@t.local', role: 'governance', password: PASSWORD });
  createUser(db, { name: 'Sally', email: 'sales@t.local', role: 'sales', password: PASSWORD, sales_code: 'S-001', team_leader_id: lead.id, sales_manager_id: sm.id });
});
after(async () => { crm?.close(); await stopBot(); fs.rmSync(tmp, { recursive: true, force: true }); });

/** The CRM, pointed at the bot that is up now. */
async function startCrm() {
  crm?.close();
  crm = createServer(db, { dispatch: () => {}, callBot: { url: `${botBase}/calls`, secret: SECRET } });
  await new Promise((r) => crm.listen(0, r));
  crmBase = `http://localhost:${crm.address().port}`;
}

async function login(email) {
  const res = await fetch(`${crmBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${crmBase}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
}

async function pushBotCall(id) {
  for (const [email, body] of [['vlead@t.local', { action: 'bot_call', note: 'Customer did not pick up our calls' }], ['gov@t.local', { action: 'approve_bot_call' }], ['bh@t.local', { action: 'approve_bot_call' }]]) {
    const r = await (await login(email))('POST', `/cases/${id}/actions`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
  }
}

async function until(fn, tries = 600) {
  for (let i = 0; i < tries; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out');
}
const finishedCall = (caseId) => until(() => db.prepare(`SELECT * FROM bot_calls WHERE case_id = ? AND status IN ('completed', 'failed')`).get(caseId));

const newCase = (over = {}) => ({ fpd: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
  first_name: 'Asha', last_name: 'Rao', phone: '050 123 4567', region: 'DXB', core_product: 'personal_loan',
  product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 150000, interest_rate: 6.5, pl_tenure: 48,
  company_name: 'Emirates Steel', salary: 25000, ...over });

async function fileFor(sales, over) {
  const r = await sales('POST', '/cases', newCase(over));
  assert.ok(r.status < 300, JSON.stringify(r.data));
  return r.data.case.id;
}

// ---- Building blocks ------------------------------------------------------------------------
test('G.711: both laws round-trip within the codec\'s step', () => {
  for (const s of [0, 1, -1, 100, -100, 1000, -1000, 8000, -8000, 30000, -30000, 32767, -32768]) {
    assert.ok(Math.abs(ulawDecode(ulawEncode(s)) - s) <= Math.max(8, Math.abs(s) / 16), `µ-law ${s}`);
    assert.ok(Math.abs(alawDecode(alawEncode(s)) - s) <= Math.max(16, Math.abs(s) / 16), `A-law ${s}`);
  }
  const pcm = tone(20);
  assert.equal(decodeG711(encodeG711(pcm, 8), 8).length, pcm.length);
  assert.equal(encodeG711(pcm, 0).length, 160);
});

test('resampling and WAV files', () => {
  assert.equal(resample(new Int16Array(8000), 8000, 16000).length, 16000);
  assert.equal(resample(new Int16Array(22050), 22050, 8000).length, 8000);
  const pcm = tone(100);
  const back = wavDecode(wavEncode(pcm, 8000));
  assert.equal(back.rate, 8000);
  assert.deepEqual([...back.pcm.slice(0, 5)], [...pcm.slice(0, 5)]);
  assert.equal(mix(new Int16Array([30000, -30000]), new Int16Array([30000, -30000]))[0], 32767);
  assert.throws(() => wavDecode(Buffer.from('not a wav')), /Not a WAV/);
});

test('the endpointer hears where an answer starts and stops', () => {
  const ep = new Endpointer({ silenceMs: 300 });
  const quietFrame = () => Int16Array.from({ length: FRAME_SAMPLES }, () => (Math.random() * 2 - 1) * 60);
  const loudFrame = () => Int16Array.from({ length: FRAME_SAMPLES }, () => (Math.random() * 2 - 1) * 5000);
  const events = [];
  for (let i = 0; i < 30; i++) events.push(ep.feed(quietFrame()));
  for (let i = 0; i < 25; i++) events.push(ep.feed(loudFrame()));
  for (let i = 0; i < 30; i++) events.push(ep.feed(quietFrame()));
  assert.equal(events.filter((e) => e === 'start').length, 1);
  assert.equal(events.filter((e) => e === 'end').length, 1);
  const startAt = events.indexOf('start'); const endAt = events.indexOf('end');
  assert.ok(startAt >= 30 && startAt < 40, `started at frame ${startAt}`);
  assert.ok(endAt > 55 && endAt <= 72, `ended at frame ${endAt}`);
  const pcm = ep.take();
  assert.ok(pcm.length >= 25 * FRAME_SAMPLES, 'the whole answer plus pre-roll is kept');
});

test('SIP messages parse and serialise, with folded and comma-joined headers', () => {
  const text = ['SIP/2.0 200 OK', 'Via: SIP/2.0/UDP 10.0.0.2:5060;branch=z9hG4bKabc;rport=5060;received=1.2.3.4', 'f: "Bot" <sip:97140000000@trunk>;tag=aa',
    'To: <sip:971501234567@trunk>;tag=bb', 'Call-ID: x@10.0.0.2', 'CSeq: 2 INVITE', 'Record-Route: <sip:1.1.1.1;lr>, <sip:2.2.2.2;lr>', 'Contact: <sip:971501234567@3.3.3.3:5080>',
    'Subject: a long', ' folded subject', 'Content-Type: application/sdp', 'Content-Length: 5', '', 'v=0\r\nextra'].join('\r\n');
  const m = parseMessage(text);
  assert.equal(m.status, 200);
  assert.equal(m.headers.filter(([n]) => n === 'record-route').length, 2);
  assert.equal(m.headers.find(([n]) => n === 'from')[1], '"Bot" <sip:97140000000@trunk>;tag=aa');
  assert.equal(m.headers.find(([n]) => n === 'subject')[1], 'a long folded subject');
  assert.equal(m.body, 'v=0\r\n');
  assert.equal(tagOf('"Bot" <sip:a@b;tag=inside>;tag=outer'), 'outer');
  assert.equal(uriOf('<sip:971501234567@3.3.3.3:5080>'), 'sip:971501234567@3.3.3.3:5080');
  const req = parseMessage(serialize({ method: 'BYE', uri: 'sip:a@b', headers: [['call-id', 'c1'], ['cseq', '3 BYE']], body: '' }));
  assert.equal(req.method, 'BYE');
  assert.equal(req.headers.find(([n]) => n === 'content-length')[1], '0');
  assert.equal(parseMessage('garbage'), null);
});

test('digest authentication matches the RFC 2617 example', () => {
  const challenge = parseChallenge('Digest realm="testrealm@host.com", qop="auth,auth-int", nonce="dcd98b7102dd2f0e8b11d0f600bfb0c093", opaque="5ccc069c403ebaf9f0171e9517f40e41"');
  const auth = digestAuthorization({ username: 'Mufasa', password: 'Circle Of Life', method: 'GET', uri: '/dir/index.html', challenge, nc: 1, cnonce: '0a4f113b' });
  assert.match(auth, /response="6629fae49393a05397450978507c4ef1"/);
  assert.match(auth, /opaque="5ccc069c403ebaf9f0171e9517f40e41"/);
  assert.match(auth, /qop=auth, nc=00000001/);
});

test('SDP: the offer names G.711 and the answer tells where to send audio', () => {
  const offer = buildSdp({ ip: '10.0.0.2', port: 10002 });
  assert.match(offer, /m=audio 10002 RTP\/AVP 0 8 101/);
  assert.deepEqual(parseSdp('v=0\r\nc=IN IP4 5.5.5.5\r\nm=audio 7000 RTP/AVP 8 101\r\na=rtpmap:8 PCMA/8000\r\n'), { address: '5.5.5.5', port: 7000, payloadType: 8, types: [8, 101] });
  assert.equal(parseSdp('v=0\r\nc=IN IP4 5.5.5.5\r\nm=audio 7000 RTP/AVP 9\r\n').payloadType, null);
  assert.equal(parseSdp('v=0\r\nm=video 1 RTP/AVP 0'), null);
  const rtp = Buffer.concat([Buffer.from([0x80, 0x88, 0, 7, 0, 0, 0, 160, 1, 2, 3, 4]), Buffer.alloc(160)]);
  const p = parseRtp(rtp);
  assert.equal(p.payloadType, 8); assert.equal(p.marker, true); assert.equal(p.seq, 7); assert.equal(p.payload.length, 160);
});

test('SIP failures become the CRM\'s outcomes', () => {
  assert.equal(outcomeOf(new SipError(486, 'Busy Here')).outcome, 'busy');
  assert.equal(outcomeOf(new SipError(404, 'Not Found')).outcome, 'wrong_number');
  assert.equal(outcomeOf(new SipError(480, 'Temporarily Unavailable')).outcome, 'switched_off');
  assert.equal(outcomeOf(new SipError(487, 'Request Terminated')).outcome, 'no_answer');
  assert.match(outcomeOf(new SipError(403, 'Forbidden')).error, /refused the call/);
  assert.match(outcomeOf(new SipError(503, 'Service Unavailable')).error, /could not place the call/);
  assert.match(outcomeOf(new Error('EHOSTUNREACH')).error, /could not be reached/);
});

test('speech commands: templates split, transcripts are cleaned, engines run as programs', async () => {
  assert.deepEqual(splitCommand(`whisper-cli -m "/opt/models/my model.bin" --prompt '{hints}' -f {file}`), ['whisper-cli', '-m', '/opt/models/my model.bin', '--prompt', '{hints}', '-f', '{file}']);
  assert.equal(cleanTranscript(' [BLANK_AUDIO] yes,  it is (laughs) <|en|> '), 'yes, it is');
  assert.equal(langCode('en-IN'), 'en'); assert.equal(langCode('ar-AE'), 'ar');
  const node = process.execPath;
  const stt = makeStt({ command: `"${node}" test/fixtures/fake-stt.js {file} {lang} {hints}`, tmpDir: tmp, log: quiet });
  const text = await stt({ pcm: tone(500), rate: 8000, language: 'en-GB', hints: 'yes, no' });
  assert.equal(text, 'yes please');
  const tts = makeTts({ command: `"${node}" test/fixtures/fake-tts.js --output_file {file}`, tmpDir: tmp, log: quiet });
  const pcm = await tts({ text: 'Hello there', language: 'en-GB' });
  assert.equal(pcm.length, 4000, 'half a second at the line rate');
  assert.ok(Math.max(...pcm) > 5000, 'the tone survived resampling');
  assert.equal(tts.cache.size, 1);
  assert.equal(await tts({ text: 'Hello there', language: 'en-GB' }), pcm, 'the same line is not synthesised twice');
  await assert.rejects(tts({ text: '   ', language: 'en-GB' }), /fake-tts/);
  assert.equal(fs.readdirSync(tmp).filter((f) => f.startsWith('crm-')).length, 0, 'temporary files are removed');
});

test('settings from the environment', () => {
  assert.equal(sipFromEnv({}), null);
  const s = sipFromEnv({ SIP_SERVER: 'sip.example.ae', SIP_USERNAME: 'u', SIP_PASSWORD: 'p', SIP_REGISTER: '0' });
  assert.equal(s.register, false); assert.equal(s.server, 'sip.example.ae');
  const a = audioFromEnv({ RTP_PORT_RANGE: '30000-30100', BOT_BARGE_IN: '1', BOT_MACHINE_DETECTION: '0', BOT_RING_TIMEOUT_MS: '20000' });
  assert.deepEqual(a.portRange, [30000, 30100]); assert.equal(a.bargeIn, true); assert.equal(a.machineDetection, false); assert.equal(a.ringTimeoutMs, 20000);
});

// ---- Calls ----------------------------------------------------------------------------------
test('the bot registers with the line, dials with digest credentials, runs the playbook and reports with a recording', async () => {
  await startBot();
  await startCrm();
  assert.equal(peer.registers, 2, 'REGISTER, then again with credentials');
  assert.equal(bot.ua.registered, true);
  const health = await (await fetch(`${botBase}/health`)).json();
  assert.equal(health.telephony, true); assert.equal(health.line.registered, true); assert.equal(health.ai, false);

  const sales = await login('sales@t.local');
  const id = await fileFor(sales);
  answers.length = 0; spoken.length = 0; heardPcm.length = 0; hints.length = 0;
  answers.push('yes', 'yes', 'Asha Rao', 'personal loan', 'Emirates Steel', 'twenty five thousand');
  trace('push'); await pushBotCall(id); trace('pushed');
  const call = await finishedCall(id); trace('finished');
  assert.equal(call.status, 'completed', call.error);
  assert.equal(call.outcome, 'connected');
  assert.deepEqual(JSON.parse(call.checks).map((c) => c.result), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.match(call.summary, /Confirmed: Full name, Product applied for, Employer, Monthly salary/);
  assert.match(call.transcript, /Customer: Asha Rao/);
  assert.match(spoken[0], /This call is recorded.*Asha/);
  assert.equal(spoken.length, 7, 'greeting, intro, four questions, closing');
  assert.equal(heardPcm.length, 6);
  assert.ok(heardPcm.every((p) => p.length >= 8000 * 0.35 && p.length <= 8000 * 1.2), `answers of ${heardPcm.map((p) => p.length).join(', ')} samples`);
  assert.match(hints[2], /Asha Rao/, 'the value on file is passed as a hint');
  assert.equal(peer.invites.length, 2, 'INVITE, then again with credentials');
  assert.equal(peer.authorized, true);
  assert.equal(peer.byes, 1, 'the bot ended the call');
  assert.equal(peer.call.spokenBursts, 6);
  assert.match(peer.invites[1].headers.find(([n]) => n === 'from')[1], /"Verification team" <sip:97140000000@fake.trunk>/);
  assert.match(peer.invites[1].uri, /^sip:971501234567@fake.trunk$/);
  assert.ok(peer.invites[1].headers.some(([n, v]) => n === 'p-asserted-identity' && v.includes('97140000000')));
  assert.equal(bot.ua.dialogs.size, 0);

  // The recording is a WAV on this server, fetched by the CRM with a signed request.
  assert.match(call.recording_url, new RegExp(`^${botBase}/recordings/[0-9a-f]{32}$`));
  const file = path.join(tmp, `${call.recording_url.split('/').pop()}.wav`);
  const wav = wavDecode(fs.readFileSync(file));
  assert.equal(wav.rate, 8000);
  assert.ok(wav.pcm.length > 8000 * 5, `recording is ${wav.pcm.length / 8000}s`);
  assert.ok(Math.max(...wav.pcm.subarray(0, 8000)) > 5000, 'the bot\'s greeting is in the recording');
  const vera = await login('vlead@t.local');
  const r = await fetch(`${crmBase}/api/bot/calls/${call.id}/recording`, { headers: { cookie: (await fetch(`${crmBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'vlead@t.local', password: PASSWORD }) })).headers.get('set-cookie').split(';')[0] } });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'audio/wav');
  assert.equal((await r.arrayBuffer()).byteLength, fs.statSync(file).size);
  void vera;
  const unsigned = await fetch(call.recording_url);
  assert.equal(unsigned.status, 401);
  const ts = String(Date.now() - 400e3);
  const stale = await fetch(call.recording_url, { headers: { 'x-crm-timestamp': ts, 'x-crm-signature': sign(SECRET, `GET ${new URL(call.recording_url).pathname}\n${ts}`) } });
  assert.equal(stale.status, 401);
  await stopBot();
});

test('a wrong answer is asked again; the customer hanging up ends the call as such', async () => {
  await startBot();
  await startCrm();
  const sales = await login('sales@t.local');
  const id = await fileFor(sales, { phone: '050 222 3333' });
  answers.length = 0; spoken.length = 0;
  answers.push('yes', 'yes', 'Asha Rao', 'credit card', 'credit card');
  await pushBotCall(id);
  await until(() => spoken.length >= 6 && answers.length === 0);
  await until(() => peer.call?.spokenBursts >= 5);
  peer.hangUp();
  const call = await finishedCall(id);
  assert.equal(call.outcome, 'connected');
  assert.match(call.summary, /The call ended before the bot finished/);
  assert.match(call.summary, /Did not match: Product applied for/);
  assert.equal(peer.byes, 0, 'the customer hung up, not the bot');
  assert.equal(bot.ua.dialogs.size, 0);
  await stopBot();
});

test('busy, unknown numbers and no answer: the line\'s answers become outcomes; ringing is cancelled', async () => {
  for (const [behaviour, outcome, extra] of [['busy', 'busy'], ['unknown', 'wrong_number'], ['ring', 'no_answer', (p) => assert.equal(p.cancels, 1, 'CANCEL sent when nobody picks up')]]) {
    await startBot({ behaviour, challenge: false, register: false });
    await startCrm();
    const sales = await login('sales@t.local');
    const id = await fileFor(sales, { phone: `050 777 ${behaviour.length}000` });
    await pushBotCall(id);
    const call = await finishedCall(id);
    assert.equal(call.status, 'completed');
    assert.equal(call.outcome, outcome, `${behaviour}: ${call.summary}`);
    assert.equal(peer.byes, 0);
    extra?.(peer);
    assert.equal(bot.ua.dialogs.size, 0);
    await stopBot();
  }
});

test('a voicemail greeting is hung up on', async () => {
  await startBot({ greetingMs: 2500 });
  await startCrm();
  const sales = await login('sales@t.local');
  const id = await fileFor(sales, { phone: '050 888 1000' });
  answers.length = 0;
  await pushBotCall(id);
  const call = await finishedCall(id);
  assert.equal(call.outcome, 'no_answer');
  assert.match(call.summary, /voicemail/);
  assert.equal(peer.byes, 1);
  await stopBot();
});

test('the service refuses what it cannot do', async () => {
  await startBot({ challenge: false, register: false }, { stt: null });
  const body = JSON.stringify({ callback_url: 'http://localhost:1/x', customer: { phone: '0501234567' }, checks: [], playbook: {} });
  const post = (b, sig) => fetch(`${botBase}/calls`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-crm-signature': sig }, body: b }).then(async (r) => ({ status: r.status, data: await r.json() }));
  assert.equal((await post(body, 'sha256=bad')).status, 401);
  const r = await post(body, sign(SECRET, body));
  assert.equal(r.status, 503);
  assert.match(r.data.error, /Speech is not set up/);
  const health = await (await fetch(`${botBase}/health`)).json();
  assert.equal(health.telephony, false); assert.equal(health.speech.stt, false);
  assert.equal((await fetch(`${botBase}/recordings/${crypto.randomBytes(16).toString('hex')}`)).status, 401);
  await stopBot();
});
