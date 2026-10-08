import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { openDb } from '../src/db.js';
import { createServer } from '../src/server.js';
import { createUser } from '../src/auth.js';
import { sign } from '../src/bot.js';

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
  company_name: 'Emirates Steel', salary: 25000, eid_number: '784-1990-1234567-1',
};

test('bot call: request, signed result, logged on the case; the processor sets the result', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;

  let r = await proc('GET', `/cases/${id}`);
  assert.ok(r.data.case.allowed_actions.includes('bot_call'));
  assert.equal((await sales('GET', '/me')).data.meta.call_bot, true);

  r = await proc('POST', `/cases/${id}/actions`, { action: 'bot_call' });
  assert.equal(r.status, 200);
  assert.equal(r.data.case.status, 'in_verification', 'requesting a bot call picks the case up');
  assert.equal(r.data.case.bot_call_status, 'requested');
  assert.ok(!r.data.case.allowed_actions.includes('bot_call'), 'one bot call at a time');
  assert.ok(r.data.case.allowed_actions.includes('complete'), 'the processor can still finish by hand');

  assert.equal(botRequests.length, 1);
  const sent = botRequests[0];
  assert.equal(sent.signature, sign(SECRET, sent.body), 'the request to the bot is signed');
  assert.equal(sent.json.customer.phone, '0501234567');
  assert.deepEqual(sent.json.checks.map((c) => c.key), ['full_name', 'product', 'company_name', 'salary', 'eid_last4']);
  assert.equal(sent.json.checks.find((c) => c.key === 'eid_last4').expected, '5671');
  const callback = sent.json.callback_url;
  assert.match(callback, /\/api\/bot\/calls\/[a-f0-9]{48}$/);

  // Unsigned or tampered results are refused.
  assert.equal((await botResult(callback, { status: 'completed', outcome: 'connected' }, { signature: 'sha256=00' })).status, 401);
  assert.equal((await botResult(callback.replace(/.{4}$/, '0000'), { status: 'completed', outcome: 'connected' })).status, 404);
  assert.equal((await botResult(callback, { status: 'completed', outcome: 'maybe' })).status, 400);

  assert.equal((await botResult(callback, { status: 'in_progress' })).status, 200);
  assert.equal((await proc('GET', `/cases/${id}`)).data.case.bot_call_status, 'in_progress');

  r = await botResult(callback, {
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
  assert.equal(c.status, 'in_verification', 'the bot never sets the verification result');
  assert.equal(c.call_attempts, 1);
  assert.equal(c.bot_call.status, 'completed');
  assert.deepEqual(c.bot_call.checks.map((x) => x.result), ['confirmed', 'confirmed', 'mismatch', 'confirmed', 'not_answered']);
  assert.equal(c.bot_call.recording_url, 'https://bot.example/rec/1.mp3');
  const event = c.events.find((e) => e.type === 'bot_call_result');
  assert.match(event.note, /1 detail did not match: Employer/);
  assert.ok(c.allowed_actions.includes('bot_call'), 'another bot call can be placed');

  const notes = (await proc('GET', '/notifications')).data.items;
  assert.ok(notes.some((n) => /bot call: 1 detail did not match: Employer\. Review it/.test(n.message)));

  // Sales staff do not see bot call details.
  assert.equal((await sales('GET', `/cases/${id}`)).data.case.bot_call, undefined);

  r = await proc('POST', `/cases/${id}/actions`, { action: 'mark_incomplete', reason: 'incorrect_details', note: 'Employer changed' });
  assert.equal(r.data.case.status, 'incomplete');
});

test('bot call: a refused request fails the call and tells the processor', async () => {
  const sales = await login('sales@t.local');
  const proc = await login('proc@t.local');
  const id = (await sales('POST', '/cases', newCase)).data.case.id;
  botAnswer = 503;
  try {
    const r = await proc('POST', `/cases/${id}/actions`, { action: 'bot_call' });
    assert.equal(r.status, 200);
    assert.equal(r.data.case.bot_call_status, 'failed');
    assert.equal(r.data.case.bot_call.error, 'bot service answered 503');
    assert.ok(r.data.case.allowed_actions.includes('bot_call'), 'it can be tried again');
    assert.ok(r.data.case.events.some((e) => e.type === 'bot_call_failed'));
  } finally {
    botAnswer = 200;
  }
  // A failure reported by the bot itself is recorded the same way, and a newer call expires the old one.
  await proc('POST', `/cases/${id}/actions`, { action: 'bot_call' });
  const first = botRequests.at(-1).json.callback_url;
  await proc('POST', `/cases/${id}/actions`, { action: 'release' });
  // Releasing leaves the pending bot call in place, so the processor can't place another yet.
  let r = await proc('GET', `/cases/${id}`);
  assert.ok(!r.data.case.allowed_actions.includes('bot_call'));
  assert.equal((await botResult(first, { status: 'failed', error: 'number not in service' })).status, 200);
  r = await proc('GET', `/cases/${id}`);
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
