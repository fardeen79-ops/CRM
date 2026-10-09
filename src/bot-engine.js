// The verification bot's brain: the playbook it is taught, how it understands answers, and the
// conversation it holds on a call. Shared by the CRM (teaching, practice, checks) and the calling
// service in bot/ (live phone calls), so it has no other imports.
//
// A call goes: greeting and identity ("Am I speaking with Asha?") → a short introduction asking if
// now is a good time → one question per check → closing. The bot re-asks when it hears nothing it
// understands, asks once more when an answer does not match, and records every check as confirmed,
// mismatch or not_answered. Its rules are deterministic, so the same answers always get the same
// judgment, and teaching it means changing its wording, its checks and the words it knows. When the
// playbook switches the AI on, answers the rules cannot settle are read by Claude (bot-ai.js); the
// AI only interprets, and everything the bot says still comes from the playbook.

export const CHECK_RESULTS = ['confirmed', 'mismatch', 'not_answered'];

/** How the bot compares an answer with the value on file. */
export const MATCH_TYPES = {
  name: 'Name',     // sounds-alike spelling allowed; first and last name must be heard
  text: 'Key words', // most of the key words must be said (or the initials, e.g. ADNOC)
  number: 'Amount', // within a tolerance
  yes: 'Yes / no',  // the customer must say yes
};

/** File details a check can be compared against, and the placeholders the script can use. */
export const FIELDS = {
  full_name: { label: 'Full name', match: 'name' },
  first_name: { label: 'First name', match: 'name' },
  last_name: { label: 'Last name', match: 'name' },
  product: { label: 'Product applied for', match: 'text' },
  credit_card: { label: 'Credit card', match: 'text' },
  company_name: { label: 'Employer', match: 'text' },
  salary: { label: 'Monthly salary (AED)', match: 'number' },
  loan_amount: { label: 'Loan amount (AED)', match: 'number' },
  city: { label: 'City', match: 'text' },
  none: { label: 'No file detail (a yes / no question)', match: 'yes' },
};
// {bank} and {name} work everywhere too.
export const PLACEHOLDERS = ['bank', 'name', ...Object.keys(FIELDS).filter((f) => f !== 'none')];

export const STRICTNESS = { relaxed: 'Relaxed', normal: 'Normal', strict: 'Strict' };
// Name and word matching: how alike two words must be (1 = identical).
const WORD_SIMILARITY = { relaxed: 0.65, normal: 0.75, strict: 0.9 };
// Words matching: the share of key words that must be heard.
const WORD_COVERAGE = { relaxed: 0.5, normal: 0.6, strict: 1 };
// Amounts: how far the stated amount may be from the one on file.
const AMOUNT_TOLERANCE = { relaxed: 0.2, normal: 0.1, strict: 0.02 };

export const LANGUAGES = { 'en-GB': 'English (UK)', 'en-US': 'English (US)', 'en-IN': 'English (India)', 'ar-AE': 'Arabic (UAE)' };

/** What the CRM may do with a bot call's result, per situation. */
export const RULE_CHOICES = {
  all_confirmed: { review: 'Leave it for a processor to review', complete: 'Complete the verification' },
  mismatch: { review: 'Leave it for a processor to review', pending: 'Mark verification pending (team leader decides)' },
  not_reached: { review: 'Leave it for a processor to review', pending: 'Mark verification pending (customer unreachable) after the set number of unanswered bot calls' },
};

// The approved calling hours (UAE time). A playbook may narrow them, never widen them.
export const CALLING_WINDOW = Object.freeze({ from: '09:00', to: '18:00' });

export const DEFAULT_PLAYBOOK = Object.freeze({
  bank_name: 'the bank',
  language: 'en-GB',
  voice: '',
  recording_notice: 'This call is recorded for verification and quality purposes.',
  greeting: 'Hello, this is the verification team calling on behalf of {bank}. Am I speaking with {first_name}?',
  wrong_person: "Sorry to have troubled you. We'll try again later. Goodbye.",
  intro: 'Thank you, {first_name}. I am calling to verify your application for {product}. It takes about a minute. Is now a good time?',
  call_later: 'No problem. We will call you back later. Goodbye.',
  didnt_catch: "Sorry, I didn't catch that.",
  who_we_are: 'I am the automated verification assistant calling on behalf of {bank} about your recent application.',
  ask_again: 'Sorry, could you say that once more?',
  closing: 'Thank you, {first_name}. That is everything we needed. Have a good day.',
  max_reprompts: 2,
  ai: false,
  checks: [
    { key: 'full_name', label: 'Full name', field: 'full_name', match: 'name', strictness: 'normal', enabled: true, question: 'Please confirm your full name.' },
    { key: 'product', label: 'Product applied for', field: 'product', match: 'text', strictness: 'relaxed', enabled: true, question: 'Which product did you apply for?' },
    { key: 'company_name', label: 'Employer', field: 'company_name', match: 'text', strictness: 'normal', enabled: true, question: 'What is the name of the company you work for?' },
    { key: 'salary', label: 'Monthly salary', field: 'salary', match: 'number', strictness: 'normal', enabled: true, question: 'What is your monthly salary in AED?' },
  ],
  yes_words: ['yes', 'yeah', 'yep', 'yup', 'correct', 'right', 'sure', 'speaking', 'that is me', 'this is me', 'it is me', 'it\'s me', 'go ahead', 'ok', 'okay', 'fine', 'of course', 'absolutely', 'aiwa', 'naam', 'haan', 'نعم', 'ايوه'],
  no_words: ['no', 'nope', 'not', 'wrong', 'busy', 'later', 'incorrect', 'driving', 'la', 'لا'],
  rules: {
    all_confirmed: 'review',
    mismatch: 'review',
    not_reached: 'review',
    max_attempts: 3,
    ai_confirms_count: false,
    call_from: '09:00',
    call_to: '18:00',
    call_sunday: false,
  },
});

const SCRIPT_LINES = ['recording_notice', 'greeting', 'wrong_person', 'intro', 'call_later', 'didnt_catch', 'who_we_are', 'ask_again', 'closing'];
export const SCRIPT_LABELS = {
  recording_notice: 'Recording notice (said first; leave empty if calls are not recorded)',
  greeting: 'Greeting and identity question',
  wrong_person: 'If someone else answers',
  intro: 'Introduction (asks if now is a good time)',
  call_later: 'If it is not a good time',
  didnt_catch: 'When it did not understand',
  who_we_are: 'When asked who is calling (said before repeating the question)',
  ask_again: 'When an answer does not match (asked once more)',
  closing: 'Closing',
};

export class PlaybookError extends Error {
  constructor(message) {
    super(message);
    this.status = 400;
  }
}

const str = (v, max, label, { required = true } = {}) => {
  const s = String(v ?? '').replace(/\s+/g, ' ').trim();
  if (required && !s) throw new PlaybookError(`${label} cannot be empty`);
  if (s.length > max) throw new PlaybookError(`${label} is too long (${max} characters at most)`);
  return s;
};
const pick = (v, choices, label) => {
  if (!Object.hasOwn(choices, v)) throw new PlaybookError(`${label} must be one of: ${Object.keys(choices).join(', ')}`);
  return v;
};
const int = (v, min, max, label) => {
  const n = Number(v);
  if (!Number.isInteger(n) || n < min || n > max) throw new PlaybookError(`${label} must be a whole number from ${min} to ${max}`);
  return n;
};
function checkPlaceholders(text, label) {
  for (const [, name] of text.matchAll(/\{([^}]*)\}/g)) {
    if (!PLACEHOLDERS.includes(name)) throw new PlaybookError(`${label}: {${name}} is not a detail the bot knows. Use ${PLACEHOLDERS.map((p) => `{${p}}`).join(', ')}`);
  }
  return text;
}
function words(list, label) {
  const raw = Array.isArray(list) ? list : String(list ?? '').split(',');
  const out = [...new Set(raw.map((w) => normalize(w)).filter(Boolean))];
  if (out.length > 200) throw new PlaybookError(`${label}: 200 words or phrases at most`);
  if (out.some((w) => w.length > 40)) throw new PlaybookError(`${label}: each word or phrase is 40 characters at most`);
  if (!out.length) throw new PlaybookError(`${label}: add at least one word`);
  return out;
}

/**
 * Checks a playbook sent by the teaching page (or stored) and fills anything missing from the
 * defaults. Throws PlaybookError with a message for the person teaching the bot.
 */
export function normalizePlaybook(input = {}, { strict = true } = {}) {
  const d = DEFAULT_PLAYBOOK;
  const p = { ...d, ...input, rules: { ...d.rules, ...(input.rules || {}) } };
  const out = {
    bank_name: str(p.bank_name, 80, 'Bank name'),
    language: pick(p.language, LANGUAGES, 'Language'),
    voice: str(p.voice, 60, 'Voice', { required: false }),
    max_reprompts: int(p.max_reprompts, 0, 3, 'Times to re-ask'),
    ai: Boolean(p.ai),
  };
  for (const line of SCRIPT_LINES) out[line] = checkPlaceholders(str(p[line], 500, SCRIPT_LABELS[line], { required: line !== 'recording_notice' }), SCRIPT_LABELS[line]);

  const checks = Array.isArray(p.checks) ? p.checks : [];
  if (checks.length > 12) throw new PlaybookError('The bot can ask 12 questions at most');
  const keys = new Set();
  out.checks = checks.map((c, i) => {
    const label = str(c.label, 60, `Question ${i + 1} label`);
    const key = str(c.key || `custom_${i + 1}`, 40, `Question ${i + 1} key`).toLowerCase();
    if (!/^[a-z0-9_]+$/.test(key)) throw new PlaybookError(`Question ${i + 1}: the key may use letters, digits and _ only`);
    if (keys.has(key)) throw new PlaybookError(`Two questions share the key "${key}"`);
    keys.add(key);
    const field = pick(c.field, FIELDS, `${label}: detail`);
    const match = pick(c.match || FIELDS[field].match, MATCH_TYPES, `${label}: how to compare`);
    if (field === 'none' && match !== 'yes') throw new PlaybookError(`${label}: a question with no file detail must be a yes / no question`);
    return {
      key, label, field, match,
      strictness: pick(c.strictness || 'normal', STRICTNESS, `${label}: strictness`),
      enabled: c.enabled !== false,
      question: checkPlaceholders(str(c.question, 300, `${label}: question`), `${label}: question`),
    };
  });
  if (!out.checks.some((c) => c.enabled)) throw new PlaybookError('Switch on at least one question');

  out.yes_words = words(p.yes_words, 'Words that mean yes');
  out.no_words = words(p.no_words, 'Words that mean no');
  const clash = out.yes_words.find((w) => out.no_words.includes(w));
  if (clash) throw new PlaybookError(`"${clash}" cannot mean both yes and no`);

  const r = p.rules;
  const time = (v, label) => {
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(v))) throw new PlaybookError(`${label} must be a time like 09:00`);
    return String(v);
  };
  out.rules = {
    all_confirmed: pick(r.all_confirmed, RULE_CHOICES.all_confirmed, 'When every detail is confirmed'),
    mismatch: pick(r.mismatch, RULE_CHOICES.mismatch, 'When a detail does not match'),
    not_reached: pick(r.not_reached, RULE_CHOICES.not_reached, 'When the customer cannot be reached'),
    max_attempts: int(r.max_attempts, 1, 10, 'Unanswered bot calls before verification is marked pending'),
    ai_confirms_count: Boolean(r.ai_confirms_count),
    call_from: time(r.call_from, 'Calling hours start'),
    call_to: time(r.call_to, 'Calling hours end'),
    call_sunday: Boolean(r.call_sunday),
  };
  // Outside the approved window: refused when teaching (strict), pulled inside when reading a
  // playbook saved before the window was set.
  const { from, to } = CALLING_WINDOW;
  if (out.rules.call_from < from || out.rules.call_to > to) {
    if (strict) throw new PlaybookError(`Calling hours must be within the approved ${from} to ${to} UAE time`);
    out.rules.call_from = out.rules.call_from < from ? from : out.rules.call_from;
    out.rules.call_to = out.rules.call_to > to ? to : out.rules.call_to;
  }
  if (out.rules.call_from >= out.rules.call_to) throw new PlaybookError('Calling hours must end after they start');
  return out;
}

// ---------- understanding answers ----------

/** Lower case, accents and punctuation removed; Arabic letters kept. */
export function normalize(text) {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/[’']/g, '\'')
    .replace(/[^a-z0-9'؀-ۿ]+/g, ' ')
    .trim();
}
const tokens = (text) => normalize(text).replace(/'/g, '').split(' ').filter(Boolean);

function levenshtein(a, b) {
  if (a === b) return 0;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
export const similarity = (a, b) => (a === b ? 1 : 1 - levenshtein(a, b) / Math.max(a.length, b.length, 1));

// Heard words, plus each pair run together: "al mansoori" is also heard as "almansoori".
const candidates = (heard) => [...heard, ...heard.slice(1).map((w, i) => heard[i] + w)];
const heardWord = (word, heard, min) => candidates(heard).some((h) => similarity(word, h) >= min);

/** 'yes', 'no' or null: the first yes or no word or phrase in the answer wins. */
export function yesNo(text, playbook) {
  const said = ` ${tokens(text).join(' ')} `;
  let best = null;
  for (const [meaning, list] of [['yes', playbook.yes_words], ['no', playbook.no_words]]) {
    for (const w of list) {
      const at = said.indexOf(` ${tokens(w).join(' ')} `);
      if (at >= 0 && (!best || at < best.at)) best = { meaning, at };
    }
  }
  return best?.meaning ?? null;
}

const NAME_PARTICLES = new Set(['al', 'el', 'bin', 'bint', 'binti', 'ibn', 'abu', 'mr', 'mrs', 'ms', 'miss', 'dr', 'my', 'name', 'is', 'i', 'am', 'im', 'this', 'it', 'its']);
function matchName(expected, heard, strictness) {
  const exp = tokens(expected).filter((w) => !NAME_PARTICLES.has(w) && w.length > 1);
  if (!exp.length) return false;
  const said = tokens(heard);
  const min = WORD_SIMILARITY[strictness];
  // The first and last names must be heard; middle names are often left out.
  const needed = exp.length > 1 ? [exp[0], exp.at(-1)] : exp;
  return needed.every((w) => heardWord(w, said, min));
}

const FILLER = new Set(['the', 'a', 'an', 'of', 'and', 'for', 'with', 'my', 'i', 'it', 'is', 'its', 'in', 'at', 'to', 'applied', 'apply', 'work', 'working', 'company', 'llc', 'l', 'fze', 'fzco', 'fz', 'co', 'ltd', 'limited', 'est', 'establishment', 'group', 'dmcc', 'pjsc', 'psc', 'plc', 'inc', 'bundle', 'from', 'buy', 'out']);
function matchWords(expected, heard, strictness) {
  const exp = tokens(expected).filter((w) => !FILLER.has(w));
  const said = tokens(heard);
  if (!said.length) return false;
  // "ADNOC" for Abu Dhabi National Oil Company.
  const initials = tokens(expected).filter((w) => !['llc', 'l', 'fze', 'fzco', 'ltd', 'pjsc'].includes(w)).map((w) => w[0]).join('');
  if (initials.length > 2 && said.includes(initials)) return true;
  if (!exp.length) return false;
  const found = exp.filter((w) => heardWord(w, said, 0.8)).length;
  return found / exp.length >= WORD_COVERAGE[strictness];
}

const UNITS = { zero: 0, oh: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16, seventeen: 17, eighteen: 18, nineteen: 19 };
const TENS = { twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90 };
const SCALES = { hundred: 100, thousand: 1e3, k: 1e3, grand: 1e3, lakh: 1e5, lakhs: 1e5, million: 1e6, m: 1e6, mn: 1e6 };

/** Every amount said in the answer: "25,000", "25k", "twenty five thousand", "1.5 million". */
export function amountsIn(text) {
  const src = String(text ?? '').toLowerCase().replace(/(\d),(?=\d{3})/g, '$1').replace(/(\d)(k|m|mn)\b/g, '$1 $2');
  const ws = src.replace(/-/g, ' ').split(/[^a-z0-9.]+/).filter(Boolean);
  const out = [];
  let total = 0; let current = 0; let any = false;
  const flush = () => { if (any) out.push(total + current); total = 0; current = 0; any = false; };
  for (const w of ws) {
    if (/^\d+(\.\d+)?$/.test(w)) { if (any && current) flush(); current += Number(w); any = true; }
    else if (w in UNITS) { current += UNITS[w]; any = true; }
    else if (w in TENS) { current += TENS[w]; any = true; }
    else if (w in SCALES && any) {
      if (w === 'hundred') current *= 100;
      else { total += (current || 1) * SCALES[w]; current = 0; }
    } else if (w === 'and' && any) continue;
    else flush();
  }
  flush();
  return out;
}
function matchAmount(expected, heard, strictness) {
  const want = Number(expected);
  if (!Number.isFinite(want) || want <= 0) return false;
  return amountsIn(heard).some((n) => Math.abs(n - want) <= want * AMOUNT_TOLERANCE[strictness]);
}

/**
 * Judges one answer to a check: 'confirmed', 'mismatch', or null when nothing usable was heard.
 * `expected` may be a list of accepted answers.
 */
export function judge(check, heard, playbook) {
  if (!tokens(heard).length) return null;
  if (check.match === 'yes') {
    const yn = yesNo(heard, playbook);
    return yn === 'yes' ? 'confirmed' : yn === 'no' ? 'mismatch' : null;
  }
  if (check.match === 'number' && !amountsIn(heard).length) return null;
  const accepted = Array.isArray(check.expected) ? check.expected : [check.expected];
  const test = { name: matchName, text: matchWords, number: matchAmount }[check.match];
  if (accepted.some((e) => e != null && e !== '' && test(String(e), heard, check.strictness || 'normal'))) return 'confirmed';
  // A bare "yes" to an open question is not an answer: ask again.
  if (check.match !== 'number' && yesNo(heard, playbook) && tokens(heard).length <= 2) return null;
  return 'mismatch';
}

// ---------- the call ----------

const fill = (text, values) => text.replace(/\{([a-z_]+)\}/g, (m, k) => (values[k] != null && values[k] !== '' ? (Array.isArray(values[k]) ? values[k][0] : String(values[k])) : m));
const fmtValue = (field, v) => (['salary', 'loan_amount'].includes(field) && v != null && v !== '' ? `AED ${Number(v).toLocaleString('en-US')}` : v);

/**
 * The checks for one customer: the playbook's switched-on questions whose file detail (and any
 * placeholder in the question) has a value. `values` are the file's details by FIELDS key; each
 * may be a list of accepted answers (the first is used when spoken).
 */
export function buildChecks(playbook, values) {
  return playbook.checks
    .filter((c) => c.enabled)
    .filter((c) => c.field === 'none' || (values[c.field] != null && values[c.field] !== '' && !(Array.isArray(values[c.field]) && !values[c.field].length)))
    .map((c) => ({ ...c, question: fill(c.question, spoken(playbook, values)), expected: c.field === 'none' ? null : values[c.field] }))
    .filter((c) => !/\{[a-z_]+\}/.test(c.question));
}

/** Placeholder values as the bot says them. */
export function spoken(playbook, values) {
  const out = { bank: playbook.bank_name };
  for (const [k, v] of Object.entries(values || {})) out[k] = fmtValue(k, Array.isArray(v) ? v[0] : v);
  out.name ??= out.full_name;
  out.first_name ??= String(out.full_name || '').split(' ')[0];
  return out;
}

/**
 * Starts a call. Returns the call state; `state.say` is what the bot says next. The state is plain
 * data so the calling service can keep it between turns and the practice page can replay it.
 */
export function startCall(playbook, { values = {}, checks } = {}) {
  const v = spoken(playbook, values);
  const state = {
    stage: 'identity', index: 0, tries: 0, asked_again: false,
    checks: (checks || buildChecks(playbook, values)).map((c) => ({ key: c.key, label: c.label, match: c.match, strictness: c.strictness, question: c.question, expected: c.expected, result: 'not_answered', heard: null })),
    values: v, turns: [], done: false, outcome: null, ended_by: null, say: null,
  };
  return botSays(state, [playbook.recording_notice, fill(playbook.greeting, v)].filter(Boolean).join(' '));
}

function botSays(state, text) {
  state.say = text;
  state.turns.push({ who: 'bot', text });
  return state;
}
function end(state, text, outcome, endedBy) {
  Object.assign(state, { done: true, outcome, ended_by: endedBy });
  return botSays(state, text);
}
const current = (state) => state.checks[state.index];

function nextCheck(state, playbook, lead = '') {
  state.tries = 0; state.asked_again = false;
  if (state.stage === 'check') state.index++;
  state.stage = 'check';
  if (state.index >= state.checks.length) return end(state, `${lead}${fill(playbook.closing, state.values)}`.trim(), 'connected', 'finished');
  return botSays(state, `${lead}${current(state).question}`.trim());
}

/** Re-asks the current prompt, or gives up after the playbook's number of re-asks. */
function reprompt(state, playbook, repeat, giveUp) {
  if (state.tries >= playbook.max_reprompts) return giveUp();
  state.tries++;
  return botSays(state, `${fill(playbook.didnt_catch, state.values)} ${repeat}`);
}

/** What the bot's own rules make of an answer: 'yes' / 'no' before the checks, 'confirmed' / 'mismatch' during them, or null. */
export function ruleReading(state, playbook, text) {
  if (state.stage === 'identity' || state.stage === 'intro') return yesNo(text, playbook);
  return judge(current(state), text, playbook);
}

/**
 * Whether to ask the AI about this answer: the playbook has it switched on, something was said,
 * and the rules could not settle it, or heard a different name or wording (which may be mishearing
 * or a paraphrase, like "the national oil company" for ADNOC).
 */
export function needsAI(state, playbook, text) {
  if (!playbook.ai || state.done || !tokens(text).length) return false;
  const reading = ruleReading(state, playbook, text);
  if (reading === null) return true;
  return state.stage === 'check' && reading === 'mismatch' && ['name', 'text'].includes(current(state).match);
}

/** What the AI is told about the answer. The value on file goes only to the AI, never into speech. */
export function aiContext(state, playbook, text) {
  const check = state.stage === 'check' ? current(state) : null;
  return {
    language: playbook.language, stage: state.stage, question: state.say, heard: String(text ?? '').trim(),
    check: check && { label: check.label, match: check.match, strictness: check.strictness, expected: check.expected ?? null },
  };
}

/** hear(), asking the AI first when the rules need help. `interpret` comes from bot-ai.js. */
export async function hearWithAI(state, playbook, text, interpret) {
  let ai = null;
  if (interpret && needsAI(state, playbook, text)) ai = await interpret(aiContext(state, playbook, text)).catch(() => null);
  return hear(state, playbook, text, ai);
}

// What the AI's reading means for a check: 'confirmed', 'mismatch' or null.
function aiVerdict(check, ai, playbook) {
  if (!ai || ai.intent !== 'answer') return null;
  if (check.match === 'yes') return ai.yes_no === 'yes' ? 'confirmed' : ai.yes_no === 'no' ? 'mismatch' : null;
  if (check.match === 'number') return ai.amount == null ? null : judge(check, String(ai.amount), playbook);
  return ai.matches_file === 'yes' ? 'confirmed' : ai.matches_file === 'no' ? 'mismatch' : null;
}

/**
 * What the customer said (empty when they said nothing), and optionally the AI's reading of it.
 * Returns the updated state.
 */
export function hear(state, playbook, text, ai = null) {
  if (state.done) return state;
  const said = String(text ?? '').trim();
  const turn = { who: 'customer', text: said };
  if (ai) turn.ai = ai.intent;
  state.turns.push(turn);
  const check = state.stage === 'check' ? current(state) : null;
  const prompt = check ? check.question : fill(state.stage === 'identity' ? playbook.greeting : playbook.intro, state.values);

  // The AI noticed the customer asking something or steering the call; the bot answers with its
  // own taught lines.
  switch (ai?.intent) {
    case 'asks_who':
    case 'asks_repeat':
      turn.understood = ai.intent;
      if (state.tries >= playbook.max_reprompts + 1) break;
      state.tries++;
      return botSays(state, `${ai.intent === 'asks_who' ? `${fill(playbook.who_we_are, state.values)} ` : ''}${prompt}`);
    case 'call_later':
      turn.understood = 'call_later';
      return end(state, fill(playbook.call_later, state.values), 'call_back_later', 'not_a_good_time');
    case 'wrong_person':
      turn.understood = 'wrong_person';
      return end(state, fill(playbook.wrong_person, state.values), 'call_back_later', 'not_the_customer');
    case 'refuses':
      turn.understood = 'refuses';
      if (check) { check.result = 'not_answered'; check.heard = said; return nextCheck(state, playbook); }
      return end(state, fill(playbook.call_later, state.values), 'call_back_later', 'declined');
    default:
  }

  if (!check) {
    const aiYn = ai?.yes_no && ai.yes_no !== 'none' ? ai.yes_no : null;
    const yn = yesNo(said, playbook) || aiYn;
    turn.understood = yn || 'unclear';
    if (yn && !yesNo(said, playbook)) turn.by_ai = true;
    if (yn === 'yes') {
      if (state.stage === 'identity') { state.stage = 'intro'; state.tries = 0; return botSays(state, fill(playbook.intro, state.values)); }
      return nextCheck(state, playbook);
    }
    if (yn === 'no') {
      return state.stage === 'identity'
        ? end(state, fill(playbook.wrong_person, state.values), 'call_back_later', 'not_the_customer')
        : end(state, fill(playbook.call_later, state.values), 'call_back_later', 'not_a_good_time');
    }
    return reprompt(state, playbook, prompt, () => end(state, fill(playbook.call_later, state.values), 'call_back_later', 'not_understood'));
  }

  // The rules judge first; the AI settles what they could not, and can overrule a name or wording
  // the rules heard as different (the bot still asks once more before recording a mismatch).
  const byRules = judge(check, said, playbook);
  const byAI = aiVerdict(check, ai, playbook);
  const verdict = byRules === 'confirmed' ? 'confirmed' : byAI || byRules;
  const fromAI = Boolean(byAI) && verdict !== byRules;
  turn.check = check.key;
  turn.understood = verdict || 'unclear';
  if (fromAI) turn.by_ai = true;
  if (!verdict) {
    return reprompt(state, playbook, check.question, () => { check.result = 'not_answered'; return nextCheck(state, playbook); });
  }
  check.heard = said;
  if (verdict === 'mismatch' && !state.asked_again) {
    // Speech recognition mishears: give the customer one more go before recording a mismatch.
    state.asked_again = true;
    return botSays(state, `${fill(playbook.ask_again, state.values)} ${check.question}`);
  }
  check.result = verdict;
  if (fromAI) check.by = 'ai';
  return nextCheck(state, playbook);
}

/** The customer hung up (or the line dropped) before the bot finished. */
export function hangUp(state) {
  if (state.done) return state;
  const reached = state.stage !== 'identity';
  return Object.assign(state, { done: true, outcome: reached ? 'connected' : 'no_answer', ended_by: 'hung_up', say: null });
}

const ENDINGS = {
  finished: '',
  not_the_customer: 'Someone other than the customer answered.',
  not_a_good_time: 'The customer asked to be called back later.',
  not_understood: 'The bot could not understand the person who answered.',
  declined: 'The customer did not want to go ahead with the call.',
  hung_up: 'The call ended before the bot finished.',
};

/** The call's result as the CRM expects it: outcome, each check's result, a summary and the transcript. */
export function callResult(state) {
  const list = (r) => state.checks.filter((c) => c.result === r).map((c) => c.label);
  const parts = [ENDINGS[state.ended_by] || ''];
  if (state.outcome === 'connected') {
    const confirmed = list('confirmed'); const mismatch = list('mismatch'); const missing = list('not_answered');
    if (confirmed.length) parts.push(`Confirmed: ${confirmed.join(', ')}.`);
    const byAI = state.checks.filter((c) => c.by === 'ai' && c.result !== 'not_answered').map((c) => c.label);
    if (byAI.length) parts.push(`Understood by the AI: ${byAI.join(', ')}.`);
    if (mismatch.length) parts.push(`Did not match: ${mismatch.join(', ')}.`);
    if (missing.length) parts.push(`Not answered: ${missing.join(', ')}.`);
  }
  return {
    status: 'completed',
    outcome: state.outcome,
    checks: state.checks.map((c) => ({ key: c.key, result: c.result, ...(c.by === 'ai' && { by: 'ai' }) })),
    summary: parts.filter(Boolean).join(' '),
    transcript: state.turns.map((t) => `${t.who === 'bot' ? 'Bot' : 'Customer'}: ${t.text || '(silence)'}`).join('\n'),
  };
}
