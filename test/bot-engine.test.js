import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_PLAYBOOK, amountsIn, buildChecks, callResult, hangUp, hear, judge, normalizePlaybook, startCall, yesNo } from '../src/bot-engine.js';

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
