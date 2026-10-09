// End to end: the CRM asks the calling bot (bot/server.js) to call; the bot asks a stand-in for
// Twilio to dial; the test plays Twilio's webhooks (the customer answering and speaking); the bot
// reports back and the CRM applies the playbook's rules.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { createBotService, toE164, twilioSignature } from '../bot/server.js';

const PASSWORD = 'password123';
const SECRET = 'shared-secret';
const AUTH_TOKEN = 'twilio-auth-token';
let db, crm, crmBase, botService, botBase, twilio;
const dialled = [];
let recordingSid;

const freePort = () => new Promise((r) => { const s = net.createServer().listen(0, () => { const { port } = s.address(); s.close(() => r(port)); }); });

before(async () => {
  // Stand-in for Twilio's REST API: records each call it is asked to place.
  twilio = http.createServer(async (req, res) => {
    let body = '';
    for await (const c of req) body += c;
    // Recordings, behind the account's credentials.
    if (req.method === 'GET') {
      const ok = req.headers.authorization === `Basic ${Buffer.from(`AC123:${AUTH_TOKEN}`).toString('base64')}` && /\/Recordings\/RE[0-9a-f]{32}\.mp3$/.test(req.url);
      res.writeHead(ok ? 200 : 404, { 'content-type': 'audio/mpeg' });
      return res.end(ok ? 'ID3-fake-audio' : '');
    }
    const form = new URLSearchParams(body);
    if (form.get('To').endsWith('0000')) {
      res.writeHead(400, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ message: "The 'To' number is not a valid phone number." }));
    }
    dialled.push({ path: req.url, auth: req.headers.authorization, form });
    res.writeHead(201, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ sid: `CA${dialled.length}` }));
  });
  await new Promise((r) => twilio.listen(0, r));

  const botPort = await freePort();
  botBase = `http://localhost:${botPort}`;
  botService = createBotService({
    secret: SECRET, publicUrl: botBase, accountSid: 'AC123', authToken: AUTH_TOKEN, from: '+97140000000',
    twilioApi: `http://localhost:${twilio.address().port}`, log: { info() {}, warn() {}, error() {} },
    // A stand-in for Claude on live calls: reads one paraphrased employer.
    interpret: async (ctx) => (ctx.heard === 'the steel company in Abu Dhabi' && ctx.check?.label === 'Employer'
      ? { intent: 'answer', yes_no: 'none', matches_file: 'yes', amount: null } : null),
  });
  await new Promise((r) => botService.listen(botPort, r));

  db = openDb(':memory:');
  const lead = createUser(db, { name: 'Lead', email: 'lead@t.local', role: 'team_leader', password: PASSWORD });
  const sm = createUser(db, { name: 'Manager', email: 'sm@t.local', role: 'sales_manager', password: PASSWORD });
  createUser(db, { name: 'Pam', email: 'proc@t.local', role: 'processing', password: PASSWORD });
  createUser(db, { name: 'Vera', email: 'vlead@t.local', role: 'processing_lead', password: PASSWORD });
  createUser(db, { name: 'Boss', email: 'bh@t.local', role: 'business_head', password: PASSWORD, region: 'DXB' });
  createUser(db, { name: 'Gina', email: 'gov@t.local', role: 'governance', password: PASSWORD });
  createUser(db, { name: 'Sally', email: 'sales@t.local', role: 'sales', password: PASSWORD, sales_code: 'S-001', team_leader_id: lead.id, sales_manager_id: sm.id });
  crm = createServer(db, { dispatch: () => {}, callBot: { url: `${botBase}/calls`, secret: SECRET } });
  await new Promise((r) => crm.listen(0, r));
  crmBase = `http://localhost:${crm.address().port}`;
});
after(() => { crm.close(); botService.close(); twilio.close(); });

async function login(email) {
  const res = await fetch(`${crmBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${crmBase}/api${path}`, { method, headers: { cookie, ...(body && { 'content-type': 'application/json' }) }, body: body && JSON.stringify(body) });
    return { status: r.status, data: await r.json() };
  };
}

// A webhook from "Twilio" to the bot, signed the way Twilio signs it.
async function hook(path, params) {
  const r = await fetch(`${botBase}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-twilio-signature': twilioSignature(AUTH_TOKEN, botBase + path, params) },
    body: new URLSearchParams(params),
  });
  return { status: r.status, text: await r.text() };
}
const pathOf = (url) => new URL(url).pathname;
const said = (twiml) => [...twiml.matchAll(/<Say[^>]*>([^<]*)<\/Say>/g)].map((m) => m[1]).join(' ');

/** Plays a whole call: the customer picks up and gives these answers. Returns the bot's lines. */
async function converse(call, answers) {
  const lines = [];
  let r = await hook(pathOf(call.form.get('Url')), { CallSid: 'CA', AnsweredBy: 'human' });
  lines.push(said(r.text));
  for (const a of answers) {
    const action = r.text.match(/action="([^"]+)"/)?.[1];
    if (!action) break;
    r = await hook(pathOf(action.replace(/&amp;/g, '&')), { CallSid: 'CA', SpeechResult: a });
    lines.push(said(r.text));
  }
  // Calls are recorded: Twilio says the recording is ready, then that the call ended.
  recordingSid = `RE${crypto.randomBytes(16).toString('hex')}`;
  await hook(pathOf(call.form.get('RecordingStatusCallback')), { CallSid: 'CA', RecordingStatus: 'completed', RecordingSid: recordingSid, RecordingUrl: `https://api.twilio.com/2010-04-01/Accounts/AC123/Recordings/${recordingSid}` });
  await hook(pathOf(call.form.get('StatusCallback')), { CallSid: 'CA', CallStatus: 'completed' });
  return { lines, last: r.text };
}

// The verification team leader asks; governance and a business head approve; then the bot calls.
async function pushBotCall(id) {
  for (const [email, body] of [['vlead@t.local', { action: 'bot_call', note: 'Customer did not pick up our calls' }], ['gov@t.local', { action: 'approve_bot_call' }], ['bh@t.local', { action: 'approve_bot_call' }]]) {
    const r = await (await login(email))('POST', `/cases/${id}/actions`, body);
    assert.equal(r.status, 200, JSON.stringify(r.data));
    if (email === 'bh@t.local') return r;
  }
}

async function until(fn) {
  for (let i = 0; i < 100; i++) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('timed out');
}

const newCase = (over = {}) => ({ fpd: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
  first_name: 'Asha', last_name: 'Rao', phone: '050 123 4567', region: 'DXB', core_product: 'personal_loan',
  product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 150000, interest_rate: 6.5, pl_tenure: 48,
  company_name: 'Emirates Steel', salary: 25000, ...over });

test('phone numbers are dialled in international format', () => {
  assert.equal(toE164('050 123 4567'), '+971501234567');
  assert.equal(toE164('+91 98765 43210'), '+919876543210');
  assert.equal(toE164('00971501234567'), '+971501234567');
  assert.equal(toE164('501234567'), '+971501234567');
  assert.equal(toE164('123'), null);
});

test('teaching: only business heads and the verification team leader; practice with a made-up customer', async () => {
  const boss = await login('bh@t.local');
  const vera = await login('vlead@t.local');
  const pam = await login('proc@t.local');
  assert.equal((await pam('GET', '/bot/playbook')).status, 403);
  assert.equal((await vera('GET', '/me')).data.meta.can_teach_bot, true);

  let r = await boss('GET', '/bot/playbook');
  assert.equal(r.status, 200);
  const playbook = r.data.playbook;
  assert.equal(r.data.enabled, true);

  r = await boss('PUT', '/bot/playbook', { playbook: { ...playbook, greeting: 'Hi {first_nam}' } });
  assert.equal(r.status, 400);
  assert.match(r.data.error, /\{first_nam\} is not a detail the bot knows/);

  const taught = { ...playbook, bank_name: 'Emirates NBD', yes_words: [...playbook.yes_words, 'tamam'],
    rules: { ...playbook.rules, all_confirmed: 'complete', mismatch: 'pending', not_reached: 'pending', max_attempts: 2 } };
  r = await vera('POST', '/bot/practice', { playbook: taught, sample: { full_name: 'Omar Haddad', product: 'Credit Card', company_name: 'Etisalat', salary: '30,000' },
    answers: ['tamam', 'yes', 'Omar Hadad', 'a credit card', 'Etisalat', '15000', '15000'] });
  assert.equal(r.status, 200);
  assert.match(r.data.turns[0].text, /on behalf of Emirates NBD\. Am I speaking with Omar\?/);
  assert.equal(r.data.turns[1].understood, 'yes', 'a newly taught word');
  assert.equal(r.data.done, true);
  assert.deepEqual(r.data.checks.map((c) => c.result), ['confirmed', 'confirmed', 'confirmed', 'mismatch']);
  assert.equal(r.data.checks[3].heard, '15000');

  r = await vera('PUT', '/bot/playbook', { playbook: taught });
  assert.equal(r.status, 200);
  r = await boss('GET', '/bot/playbook');
  assert.equal(r.data.playbook.bank_name, 'Emirates NBD');
  assert.equal(r.data.updated_by_name, 'Vera');
});

test('the bot calls, holds the conversation and completes the verification', async () => {
  const sales = await login('sales@t.local');
  const pam = await login('proc@t.local');
  const id = (await sales('POST', '/cases', newCase())).data.case.id;

  const r = await pushBotCall(id);
  assert.equal(r.data.case.bot_call_status, 'requested');
  const call = dialled.at(-1);
  assert.equal(call.path, '/2010-04-01/Accounts/AC123/Calls.json');
  assert.equal(call.auth, `Basic ${Buffer.from(`AC123:${AUTH_TOKEN}`).toString('base64')}`);
  assert.equal(call.form.get('To'), '+971501234567');
  assert.equal(call.form.get('MachineDetection'), 'Enable');

  // A forged webhook is refused.
  const forged = await fetch(`${botBase}${pathOf(call.form.get('Url'))}`, { method: 'POST', headers: { 'x-twilio-signature': 'nope' }, body: 'AnsweredBy=human' });
  assert.equal(forged.status, 403);

  const { lines, last } = await converse(call, ['tamam, speaking', 'yes go ahead', 'Asha Rao', 'personal loan', 'Emirates Steel', 'twenty five thousand']);
  assert.match(lines[0], /Am I speaking with Asha\?/);
  assert.match(lines[1], /verify your application for Personal Loan/);
  assert.match(lines.at(-1), /That is everything we needed/);
  assert.match(last, /<Hangup\/>/);

  const c = await until(async () => { const x = (await pam('GET', `/cases/${id}`)).data.case; return x.status === 'completed' && x; });
  assert.equal(c.verified_by_name, 'Verification Bot');
  assert.equal(c.bot_call.status, 'completed');
  assert.deepEqual(c.bot_call.checks.map((x) => x.result), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.match(c.bot_call.transcript, /^Bot: This call is recorded for verification and quality purposes\. Hello/);
  assert.match(c.bot_call.transcript, /Customer: Emirates Steel/);
  assert.equal(c.bot_call.has_recording, true);
  assert.equal(c.bot_call.can_listen, false, 'processors do not listen to bot calls');

  // Governance listens through the CRM; the listen is logged. Processors cannot.
  const gina = await login('gov@t.local');
  assert.equal((await gina('GET', `/cases/${id}`)).data.case.bot_call.can_listen, true);
  const cookieFor = async (email) => (await fetch(`${crmBase}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password: PASSWORD }) })).headers.get('set-cookie').split(';')[0];
  let audio = await fetch(`${crmBase}/api/bot/calls/${c.bot_call.id}/recording`, { headers: { cookie: await cookieFor('gov@t.local') } });
  assert.equal(audio.status, 200);
  assert.equal(audio.headers.get('content-type'), 'audio/mpeg');
  assert.equal(await audio.text(), 'ID3-fake-audio');
  audio = await fetch(`${crmBase}/api/bot/calls/${c.bot_call.id}/recording`, { headers: { cookie: await cookieFor('proc@t.local') } });
  assert.equal(audio.status, 403);
  const log = (await gina('GET', `/access-log?case=${id}`)).data.items;
  assert.ok(log.some((e) => e.what === 'listen:bot_call' && e.user_name === 'Gina'));
  // The calling service only hands recordings to signed requests from the CRM.
  assert.equal((await fetch(`${botBase}/recordings/${recordingSid}`)).status, 401);
  assert.ok(c.events.some((e) => e.type === 'complete' && /Verified by the calling bot: all 4 details confirmed/.test(e.note)));
  // The verification team leader who asked for the call hears the result.
  const notes = (await (await login('vlead@t.local'))('GET', '/notifications')).data.items;
  assert.ok(notes.some((n) => /verified by the calling bot/.test(n.message)));
});

test('a detail that does not match goes to the team leader', async () => {
  const sales = await login('sales@t.local');
  const pam = await login('proc@t.local');
  const lead = await login('lead@t.local');
  const id = (await sales('POST', '/cases', newCase({ first_name: 'Ravi', last_name: 'Menon' }))).data.case.id;
  await pushBotCall(id);
  await converse(dialled.at(-1), ['yes', 'yes', 'Ravi Menon', 'personal loan', 'Emirates Steel', '12000', '12000']);
  const c = await until(async () => { const x = (await pam('GET', `/cases/${id}`)).data.case; return x.status === 'incomplete' && x; });
  assert.equal(c.incomplete_reason, 'incorrect_details');
  assert.match(c.incomplete_note, /1 detail did not match: Monthly salary/);
  assert.ok((await lead('GET', '/notifications')).data.items.some((n) => /Action required/.test(n.message)));
});

test('after the set number of unanswered bot calls the file goes to the team leader', async () => {
  const sales = await login('sales@t.local');
  const pam = await login('proc@t.local');
  const id = (await sales('POST', '/cases', newCase({ first_name: 'Lina', last_name: 'Saeed', phone: '0559876543' }))).data.case.id;

  // Nobody answers the first call.
  await pushBotCall(id);
  await hook(pathOf(dialled.at(-1).form.get('StatusCallback')), { CallSid: 'CA', CallStatus: 'no-answer' });
  let c = await until(async () => { const x = (await pam('GET', `/cases/${id}`)).data.case; return x.bot_call?.status === 'completed' && x; });
  assert.equal(c.bot_call.outcome, 'no_answer');
  assert.equal(c.status, 'pending_verification', 'one more attempt allowed');
  assert.equal((await crm.bot.sweep()).length, 0, 'the bot never tries again on its own');

  // A second call, approved again, reaches a voicemail.
  await pushBotCall(id);
  const call = dialled.at(-1);
  const r = await hook(pathOf(call.form.get('Url')), { CallSid: 'CA', AnsweredBy: 'machine_end_beep' });
  assert.match(r.text, /<Hangup\/>/);
  await hook(pathOf(call.form.get('StatusCallback')), { CallSid: 'CA', CallStatus: 'completed' });
  c = await until(async () => { const x = (await pam('GET', `/cases/${id}`)).data.case; return x.status === 'incomplete' && x; });
  assert.equal(c.incomplete_reason, 'customer_unreachable');
  assert.match(c.incomplete_note, /could not reach the customer in 2 attempts/);
});

test('the bot service explains why it cannot call', async () => {
  const sales = await login('sales@t.local');
  const id = (await sales('POST', '/cases', newCase({ first_name: 'Tom', last_name: 'Lee', phone: '0500000000' }))).data.case.id;
  const r = await pushBotCall(id);
  assert.equal(r.data.case.bot_call_status, 'failed');
  assert.equal(r.data.case.bot_call.error, "Twilio refused the call: The 'To' number is not a valid phone number.");
});

test('with the AI on, a paraphrased answer is understood; AI-confirmed details complete only when allowed', async () => {
  const sales = await login('sales@t.local');
  const boss = await login('bh@t.local');
  const vera = await login('vlead@t.local');
  const { playbook } = (await boss('GET', '/bot/playbook')).data;
  await boss('PUT', '/bot/playbook', { playbook: { ...playbook, ai: true } });

  const call = async (first) => {
    const id = (await sales('POST', '/cases', newCase({ first_name: first, last_name: 'Karim' }))).data.case.id;
    await pushBotCall(id);
    await converse(dialled.at(-1), ['yes', 'yes', `${first} Karim`, 'personal loan', 'the steel company in Abu Dhabi', '25000']);
    return until(async () => { const x = (await vera('GET', `/cases/${id}`)).data.case; return x.bot_call?.status === 'completed' && x; });
  };
  let c = await call('Nadia');
  assert.deepEqual(c.bot_call.checks.find((x) => x.key === 'company_name'), { key: 'company_name', label: 'Employer', result: 'confirmed', by: 'ai' });
  assert.match(c.bot_call.summary, /Understood by the AI: Employer/);
  assert.equal(c.status, 'pending_verification', 'an AI-confirmed detail does not complete the verification by default');

  await boss('PUT', '/bot/playbook', { playbook: { ...playbook, ai: true, rules: { ...playbook.rules, ai_confirms_count: true } } });
  c = await call('Hana');
  assert.equal(c.status, 'completed');
  assert.equal(c.verified_by_name, 'Verification Bot');
});
