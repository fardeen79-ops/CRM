import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { sign } from '../src/bot.js';
import { timing } from '../src/cases.js';

const PASSWORD = 'password123';
const SECRET = 'bot-shared-secret';
let server, base, botServer;
const botRequests = [];
let botAnswer = 200;

before(async () => {
  // Stand-in for the calling bot service: records each call request it receives.
  botServer = http.createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    botRequests.push({ body, signature: req.headers['x-crm-signature'], json: JSON.parse(body) });
    res.writeHead(botAnswer, { 'content-type': 'application/json' });
    res.end('{}');
  });
  await new Promise((r) => botServer.listen(0, r));

  const db = openDb(':memory:');
  const lead = createUser(db, { name: 'Lead', email: 'lead@t.local', role: 'team_leader', password: PASSWORD });
  const sm = createUser(db, { name: 'Manager', email: 'sm@t.local', role: 'sales_manager', password: PASSWORD });
  createUser(db, { name: 'Pam', email: 'proc@t.local', role: 'processing', password: PASSWORD });
  createUser(db, { name: 'Vera', email: 'vlead@t.local', role: 'processing_lead', password: PASSWORD });
  createUser(db, { name: 'Gina', email: 'gov@t.local', role: 'governance', password: PASSWORD });
  createUser(db, { name: 'Boss', email: 'bh@t.local', role: 'business_head', password: PASSWORD, region: 'DXB' });
  createUser(db, { name: 'Sally', email: 'sales@t.local', role: 'sales', password: PASSWORD, sales_code: 'S-001', team_leader_id: lead.id, sales_manager_id: sm.id });
  server = createServer(db, {
    dispatch: () => {},
    callBot: { url: `http://localhost:${botServer.address().port}/calls`, secret: SECRET },
  });
  await new Promise((r) => server.listen(0, r));
  base = `http://localhost:${server.address().port}`;
});
after(() => {
  server.close();
  botServer.close();
});

async function login(email) {
  const res = await fetch(`${base}/api/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  return async (method, path, body) => {
    const r = await fetch(`${base}/api${path}`, {
      method,
      headers: { cookie, ...(body && { 'content-type': 'application/json' }) },
      body: body && JSON.stringify(body),
    });
    return { status: r.status, data: await r.json() };
  };
}

// Posts a result to the callback URL the way the bot would, signed unless told otherwise.
async function botResult(url, payload, { signature } = {}) {
  const body = JSON.stringify(payload);
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-crm-signature': signature ?? sign(SECRET, body) },
    body,
  });
  return { status: r.status, data: await r.json() };
}

const newCase = { fpd: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10),
  first_name: 'Asha', last_name: 'Rao', phone: '0501234567', region: 'DXB', core_product: 'personal_loan',
  product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: 150000, interest_rate: 6.5, pl_tenure: 48,
  company_name: 'Emirates Steel', salary: 25000,
};

// The verification team leader asks; governance and a business head approve; then the bot calls.
async function pushBotCall(id, note = 'Customer hard to reach in office hours') {
  const vera = await login('vlead@t.local');
  const gina = await login('gov@t.local');
  const boss = await login('bh@t.local');
  let r = await vera('POST', `/cases/${id}/actions`, { action: 'bot_call', note });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  r = await gina('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' });
  assert.equal(r.status, 200, JSON.stringify(r.data));
  return boss('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' });
}

test('bot call: only the verification team leader asks, and governance and a business head both approve', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const vera = await login('vlead@t.local');
  const gina = await login('gov@t.local');
  const boss = await login('bh@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  const before = botRequests.length;

  let r = await proc('GET', `/cases/${id}`);
  assert.ok(!r.data.case.allowed_actions.includes('bot_call'), 'processors cannot push a bot call');
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'bot_call', note: 'x' })).status, 409);
  assert.equal((await vera('POST', `/cases/${id}/actions`, { action: 'bot_call' })).status, 400, 'a reason is required');

  r = await vera('POST', `/cases/${id}/actions`, { action: 'bot_call', note: 'Three missed calls' });
  assert.equal(r.data.case.bot_call_status, 'awaiting_approval');
  assert.equal(r.data.case.status, 'pending_verification', 'asking does not pick the file up');
  assert.ok(r.data.case.allowed_actions.includes('withdraw_bot_call'));
  assert.equal(botRequests.length, before, 'nothing is dialled yet');
  assert.ok((await gina('GET', '/notifications')).data.items.some((n) => /Bot call approval needed: .* asked for by Vera — Three missed calls/.test(n.message)));
  assert.equal((await gina('GET', '/stats')).data.bot_approvals, 1);

  // Sales staff, processors and team leaders cannot approve.
  assert.equal((await proc('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' })).status, 409);

  r = await gina('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' });
  assert.equal(r.data.case.bot_call_status, 'awaiting_approval', 'governance alone is not enough');
  assert.ok(!r.data.case.allowed_actions.includes('approve_bot_call'), 'governance approves once');
  assert.equal(botRequests.length, before);

  r = await boss('GET', '/bot/requests');
  const listed = r.data.calls.find((c) => c.case_id === id);
  assert.equal(listed.can_decide, true);
  assert.equal(listed.gov_by_name, 'Gina');
  assert.equal(listed.request_note, 'Three missed calls');

  r = await boss('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' });
  assert.equal(r.status, 200);
  assert.equal(r.data.case.bot_call_status, 'requested', 'both approvals: the bot calls');
  assert.equal(botRequests.length, before + 1);
  assert.ok(r.data.case.events.some((e) => e.type === 'bot_call_placed'));
  assert.ok((await vera('GET', '/notifications')).data.items.some((n) => /bot call approved by governance and the business head/.test(n.message)));
});

test('bot call: declined or withdrawn requests are never dialled; approved calls wait for calling hours', async () => {
  const sales = await login('sales@t.local');
  const vera = await login('vlead@t.local');
  const gina = await login('gov@t.local');
  const boss = await login('bh@t.local');
  const before = botRequests.length;

  let id = (await sales('POST', '/cases', newCase)).data.case.id;
  await vera('POST', `/cases/${id}/actions`, { action: 'bot_call', note: 'Try the bot' });
  assert.equal((await boss('POST', `/cases/${id}/actions`, { action: 'decline_bot_call' })).status, 400, 'declining needs a reason');
  let r = await boss('POST', `/cases/${id}/actions`, { action: 'decline_bot_call', note: 'VIP customer: call personally' });
  assert.equal(r.data.case.bot_call_status, 'declined');
  assert.equal(r.data.case.bot_call.decision_note, 'VIP customer: call personally');
  assert.equal((await gina('POST', `/cases/${id}/actions`, { action: 'approve_bot_call' })).status, 409);
  assert.ok((await vera('GET', `/cases/${id}`)).data.case.allowed_actions.includes('bot_call'), 'can be asked for again');

  id = (await sales('POST', '/cases', newCase)).data.case.id;
  await vera('POST', `/cases/${id}/actions`, { action: 'bot_call', note: 'Try the bot' });
  r = await vera('POST', `/cases/${id}/actions`, { action: 'withdraw_bot_call' });
  assert.equal(r.data.case.bot_call_status, 'withdrawn');
  assert.equal(botRequests.length, before);

  // Approved at 22:00 UAE time: held until the calling window opens.
  id = (await sales('POST', '/cases', newCase)).data.case.id;
  const realNow = timing.now;
  timing.now = () => Date.parse('2026-10-05T18:00:00Z');
  try {
    r = await pushBotCall(id);
    assert.equal(r.data.case.bot_call_status, 'approved');
    assert.equal(botRequests.length, before);
    assert.deepEqual(await server.bot.sweep(), []);
  } finally {
    timing.now = realNow;
  }
  assert.deepEqual(await server.bot.sweep(), [id]);
  assert.equal((await vera('GET', `/cases/${id}`)).data.case.bot_call_status, 'requested');
  assert.equal(botRequests.length, before + 1);
});

test('bot call: signed result, logged on the case; with default rules the processor decides', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  await proc('POST', `/cases/${id}/actions`, { action: 'claim' });
  const r0 = await pushBotCall(id);
  assert.equal(r0.data.case.bot_call_status, 'requested');

  const sent = botRequests.at(-1);
  assert.equal(sent.signature, sign(SECRET, sent.body), 'the request to the bot is signed');
  assert.equal(sent.json.customer.phone, '0501234567');
  assert.deepEqual(sent.json.checks.map((c) => c.key), ['full_name', 'product', 'company_name', 'salary']);
  const callback = sent.json.callback_url;
  assert.match(callback, /\/api\/bot\/calls\/[a-f0-9]{48}$/);

  // Unsigned or tampered results are refused.
  assert.equal((await botResult(callback, { status: 'completed', outcome: 'connected' }, { signature: 'sha256=00' })).status, 401);
  assert.equal((await botResult(callback.replace(/.{4}$/, '0000'), { status: 'completed', outcome: 'connected' })).status, 404);
  assert.equal((await botResult(callback, { status: 'completed', outcome: 'maybe' })).status, 400);

  assert.equal((await botResult(callback, { status: 'in_progress' })).status, 200);
  assert.equal((await proc('GET', `/cases/${id}`)).data.case.bot_call_status, 'in_progress');

  let r = await botResult(callback, {
    status: 'completed',
    outcome: 'connected',
    checks: [
      { key: 'full_name', result: 'confirmed' },
      { key: 'product', result: 'confirmed' },
      { key: 'company_name', result: 'mismatch' },
      { key: 'salary', result: 'confirmed' },
    ],
    summary: 'Customer says they moved to ADNOC last month.',
    transcript: 'Bot: Please confirm your full name.\nCustomer: Asha Rao.',
    recording_url: 'https://bot.example/rec/1.mp3',
  });
  assert.equal(r.status, 200);
  assert.equal((await botResult(callback, { status: 'completed', outcome: 'connected' })).status, 409, 'a result is taken once');

  r = await proc('GET', `/cases/${id}`);
  const c = r.data.case;
  assert.equal(c.status, 'in_verification', 'default rules: the bot does not set the verification result');
  assert.equal(c.call_attempts, 1);
  assert.equal(c.bot_call.status, 'completed');
  assert.deepEqual(c.bot_call.checks.map((x) => x.result), ['confirmed', 'confirmed', 'mismatch', 'confirmed']);
  assert.equal(c.bot_call.has_recording, true);
  assert.equal(c.bot_call.recording_url, undefined, 'the recording is played through the CRM, never linked directly');
  const event = c.events.find((e) => e.type === 'bot_call_result');
  assert.match(event.note, /1 detail did not match: Employer/);

  const notes = (await proc('GET', '/notifications')).data.items;
  assert.ok(notes.some((n) => /bot call: 1 detail did not match: Employer\. Review it/.test(n.message)));

  // Sales staff do not see bot call details.
  assert.equal((await sales('GET', `/cases/${id}`)).data.case.bot_call, undefined);
});

test('bot call: a refused request fails the call and tells the verification team leader', async () => {
  const sales = await login('sales@t.local');
  const vera = await login('vlead@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  botAnswer = 503;
  try {
    const r = await pushBotCall(id);
    assert.equal(r.status, 200);
    assert.equal(r.data.case.bot_call_status, 'failed');
    assert.equal(r.data.case.bot_call.error, 'bot service answered 503');
    assert.ok(r.data.case.events.some((e) => e.type === 'bot_call_failed'));
  } finally {
    botAnswer = 200;
  }
  assert.ok((await vera('GET', '/notifications')).data.items.some((n) => /the bot could not place the call/.test(n.message)));
  // A failure reported by the bot itself is recorded the same way.
  await pushBotCall(id);
  const first = botRequests.at(-1).json.callback_url;
  assert.equal((await botResult(first, { status: 'failed', error: 'number not in service' })).status, 200);
  const r = await vera('GET', `/cases/${id}`);
  assert.equal(r.data.case.bot_call.error, 'number not in service');
});

test('bot call is unavailable when no bot is set up', async () => {
  const db = openDb(':memory:');
  const plain = createServer(db, { dispatch: () => {}, callBot: { url: '' } });
  await new Promise((r) => plain.listen(0, r));
  try {
    const url = `http://localhost:${plain.address().port}/api/bot/calls/${'a'.repeat(48)}`;
    const r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"status":"completed"}' });
    assert.equal(r.status, 404);
  } finally {
    plain.close();
  }
});
