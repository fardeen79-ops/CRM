import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAYBOOK, amountsIn, buildChecks, callResult, hangUp, hear, hearWithAI, judge, normalizePlaybook, startCall, yesNo } from '../src/bot-engine.js';
import { makeInterpreter } from '../src/bot-ai.js';

const pb = normalizePlaybook(DEFAULT_PLAYBOOK);
const values = { full_name: 'Mohammed Al Mansoori', first_name: 'Mohammed', product: ['Personal Loan', 'Personal Loan (Fresh)'], company_name: 'Abu Dhabi National Oil Company LLC', salary: 25000 };
const talk = (answers, playbook = pb, v = values) => answers.reduce((s, a) => hear(s, playbook, a), startCall(playbook, { values: v }));
const check = (key) => buildChecks(pb, values).find((c) => c.key === key);

test('understands yes and no, first word wins', () => {
  assert.equal(yesNo('Yeah, speaking', pb), 'yes');
  assert.equal(yesNo("No, I'm driving", pb), 'no');
  assert.equal(yesNo('yes it is not a problem', pb), 'yes');
  assert.equal(yesNo('Who is this?', pb), null);
  assert.equal(yesNo('نعم', pb), 'yes');
});

test('matches names, employers and amounts the way people say them', () => {
  assert.equal(judge(check('full_name'), 'Muhammad Almansoori', pb), 'confirmed', 'spelling and a run-together family name');
  assert.equal(judge(check('full_name'), 'Mohammed', pb), 'mismatch', 'the last name must be heard');
  assert.equal(judge(check('full_name'), 'yes', pb), null, 'a bare yes is not an answer');
  assert.equal(judge(check('company_name'), 'I work for ADNOC', pb), 'confirmed', 'initials');
  assert.equal(judge(check('company_name'), 'Abu Dhabi National Oil', pb), 'confirmed');
  assert.equal(judge(check('company_name'), 'Emirates Airline', pb), 'mismatch');
  assert.equal(judge(check('product'), 'a personal loan', pb), 'confirmed');
  assert.equal(judge(check('salary'), 'twenty four thousand', pb), 'confirmed', 'within 10%');
  assert.equal(judge(check('salary'), '18,000 dirhams', pb), 'mismatch');
  assert.deepEqual(amountsIn('25k'), [25000]);
  assert.deepEqual(amountsIn('1.5 million'), [1500000]);
  assert.deepEqual(amountsIn('twenty five thousand five hundred'), [25500]);
});

test('a full call: identity, introduction, each check, closing', () => {
  const s = talk(['yes speaking', 'sure', 'Mohammed Al Mansoori', 'personal loan', 'ADNOC', '25000']);
  assert.equal(s.done, true);
  assert.equal(s.outcome, 'connected');
  assert.match(s.say, /That is everything we needed/);
  const r = callResult(s);
  assert.deepEqual(r.checks.map((c) => c.result), ['confirmed', 'confirmed', 'confirmed', 'confirmed']);
  assert.match(r.transcript, /^Bot: Hello, this is the verification team calling on behalf of the bank\. Am I speaking with Mohammed\?/);
});

test('asks once more on a mismatch, re-asks when it hears nothing, then moves on', () => {
  let s = talk(['yes', 'yes', 'Mohammed Al Mansoori', 'personal loan', 'Emirates Airline']);
  assert.match(s.say, /^Sorry, could you say that once more\? What is the name of the company/);
  s = hear(s, pb, 'Emirates Airline');
  assert.equal(s.checks.find((c) => c.key === 'company_name').result, 'mismatch');
  s = hear(s, pb, '');
  assert.match(s.say, /^Sorry, I didn't catch that\. What is your monthly salary/);
  s = hear(hear(s, pb, ''), pb, '');
  assert.equal(s.checks.find((c) => c.key === 'salary').result, 'not_answered', 'gives up after two re-asks');
  assert.equal(s.done, true);
});

test('someone else answers, or it is not a good time', () => {
  let s = talk(['No, this is his brother']);
  assert.equal(s.outcome, 'call_back_later');
  assert.match(callResult(s).summary, /Someone other than the customer answered/);
  s = talk(['yes', 'no I am driving']);
  assert.equal(s.outcome, 'call_back_later');
  assert.match(callResult(s).summary, /asked to be called back later/);
  s = hangUp(talk(['yes', 'yes', 'Mohammed Al Mansoori']));
  assert.equal(s.outcome, 'connected');
  assert.match(callResult(s).summary, /Confirmed: Full name\. Not answered: Product applied for, Employer, Monthly salary/);
});

test('teaching: new words, custom questions and skipped checks', () => {
  const taught = normalizePlaybook({ ...DEFAULT_PLAYBOOK, yes_words: [...DEFAULT_PLAYBOOK.yes_words, 'tamam'],
    checks: [...DEFAULT_PLAYBOOK.checks, { label: 'Consent', field: 'none', question: 'Do you agree to a credit check with {bank}?' }] });
  assert.equal(yesNo('tamam', taught), 'yes');
  const checks = buildChecks(taught, { ...values, company_name: null });
  assert.deepEqual(checks.map((c) => c.key), ['full_name', 'product', 'salary', 'custom_5'], 'no employer on file: that question is skipped');
  assert.equal(checks.at(-1).question, 'Do you agree to a credit check with the bank?');
  const s = talk(['yes', 'yes', 'Mohammed Al Mansoori', 'personal loan', '25000', 'tamam'], taught, { ...values, company_name: null });
  assert.equal(s.checks.at(-1).result, 'confirmed');

  assert.throws(() => normalizePlaybook({ greeting: 'Hello {firstname}' }), /\{firstname\} is not a detail the bot knows/);
  assert.throws(() => normalizePlaybook({ yes_words: ['yes', 'no'] }), /cannot mean both yes and no/);
  assert.throws(() => normalizePlaybook({ checks: [{ label: 'X', field: 'none', match: 'name', question: 'Q?' }] }), /must be a yes \/ no question/);
  assert.throws(() => normalizePlaybook({ rules: { call_from: '20:00', call_to: '09:00' } }), /end after they start/);
});

test('with the AI switched on, it settles what the rules cannot, using only taught lines', async () => {
  const withAI = normalizePlaybook({ ...DEFAULT_PLAYBOOK, ai: true });
  const seen = [];
  // A stand-in for Claude: reads a few known phrases.
  const interpret = async (ctx) => {
    seen.push(ctx);
    const read = {
      'hang on, who is this?': { intent: 'asks_who', yes_no: 'none', matches_file: 'unsure', amount: null },
      'mm-hmm': { intent: 'answer', yes_no: 'yes', matches_file: 'unsure', amount: null },
      'the national oil company': { intent: 'answer', yes_no: 'none', matches_file: 'yes', amount: null },
      'a quarter of a lakh, more or less': { intent: 'answer', yes_no: 'none', matches_file: 'unsure', amount: 25000 },
      "I'd rather not say": { intent: 'refuses', yes_no: 'none', matches_file: 'unsure', amount: null },
    }[ctx.heard];
    return read ?? null;
  };
  let s = startCall(withAI, { values });
  for (const a of ['hang on, who is this?', 'mm-hmm', 'yes', 'Mohammed Al Mansoori', 'personal loan', 'the national oil company', 'a quarter of a lakh, more or less']) {
    s = await hearWithAI(s, withAI, a, interpret);
  }
  assert.match(s.turns[2].text, /^I am the automated verification assistant calling on behalf of the bank about your recent application\. Hello, this is the verification team/);
  assert.equal(s.turns[3].by_ai, true);
  assert.equal(s.done, true);
  const r = callResult(s);
  assert.deepEqual(r.checks, [
    { key: 'full_name', result: 'confirmed' }, { key: 'product', result: 'confirmed' },
    { key: 'company_name', result: 'confirmed', by: 'ai' }, { key: 'salary', result: 'confirmed', by: 'ai' },
  ]);
  assert.match(r.summary, /Understood by the AI: Employer, Monthly salary\./);
  assert.ok(!seen.some((c) => c.heard === 'Mohammed Al Mansoori'), 'answers the rules settle never go to the AI');
  assert.equal(seen.find((c) => c.heard === 'the national oil company').check.expected, 'Abu Dhabi National Oil Company LLC');

  // Refusing a question skips it; the AI being unavailable leaves the rules in charge.
  s = startCall(withAI, { values });
  for (const a of ['yes', 'yes', "I'd rather not say"]) s = await hearWithAI(s, withAI, a, interpret);
  assert.equal(s.checks[0].result, 'not_answered');
  assert.match(s.say, /Which product did you apply for\?/);
  s = await hearWithAI(s, withAI, 'something odd', async () => { throw new Error('timeout'); });
  assert.match(s.say, /^Sorry, could you say that once more\?/, 'the rules heard a different product and ask once more');

  // Switched off in the playbook: never asked.
  seen.length = 0;
  s = startCall(pb, { values });
  await hearWithAI(s, pb, 'hang on, who is this?', interpret);
  assert.equal(seen.length, 0);
});

test('the AI request: structured output, low effort, refusal fallbacks; failures leave the rules in charge', async () => {
  const sent = [];
  let reply = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"intent":"answer","yes_no":"yes","matches_file":"unsure","amount":null}' }] };
  const client = { beta: { messages: { create: async (body, opts) => { sent.push({ body, opts }); if (reply instanceof Error) throw reply; return reply; } } } };
  const interpret = makeInterpreter({ client, log: {} });
  const ctx = { language: 'en-GB', stage: 'identity', question: 'Am I speaking with Asha?', heard: 'mm-hmm', check: null };
  assert.deepEqual(await interpret(ctx), { intent: 'answer', yes_no: 'yes', matches_file: 'unsure', amount: null });
  const { body, opts } = sent[0];
  assert.equal(body.model, 'claude-opus-5-5');
  assert.deepEqual(body.betas, ['server-side-fallback-2026-07-01']);
  assert.equal(body.fallbacks, 'default');
  assert.equal(body.output_config.effort, 'low');
  assert.equal(body.output_config.format.type, 'json_schema');
  assert.match(body.messages[0].content, /Speech recognition heard: <customer>mm-hmm<\/customer>/);
  assert.equal(opts.timeout, 6000);

  await interpret(ctx);
  assert.equal(sent.length, 1, 'the same answer is not asked twice');
  reply = { stop_reason: 'refusal', content: [] };
  assert.equal(await interpret({ ...ctx, heard: 'something else' }), null);
  reply = new Error('Request timed out');
  assert.equal(await interpret({ ...ctx, heard: 'a third thing' }), null);
});
