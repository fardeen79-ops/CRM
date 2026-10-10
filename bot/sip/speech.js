// Speech on the server itself: the bot's lines are turned into audio and the customer's answers
// into text by programs installed next to the service, so nothing leaves the machine.
//
// Both engines are commands given as templates. The defaults are whisper.cpp for recognition and
// Piper for the voice; any program that takes a WAV file and prints text (or takes text and
// writes a WAV file) will do. Placeholders: {file} the WAV path, {lang} two-letter language,
// {model} the model path (per language when TTS_MODEL_AR / STT_MODEL_AR style settings exist),
// {voice} the playbook's voice, {hints} words the answer may contain, {text} the line to say
// (when absent from the template it is written to the program's stdin).
import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { LINE_RATE, resample, wavDecode, wavEncode } from './audio.js';

export const DEFAULT_STT_COMMAND = 'whisper-cli -m {model} -l {lang} -nt -np --prompt {hints} -f {file}';
export const DEFAULT_TTS_COMMAND = 'piper --model {model} --output_file {file}';
const STT_RATE = 16000;
const CACHE_MAX = 300;

/** Splits a command template into argv, honouring quotes. */
export function splitCommand(template) {
  const out = []; let cur = ''; let quote = null; let has = false;
  for (const ch of String(template || '')) {
    if (quote) { if (ch === quote) quote = null; else cur += ch; }
    else if (ch === '"' || ch === "'") { quote = ch; has = true; }
    else if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; }
    else cur += ch;
  }
  if (cur || has) out.push(cur);
  return out;
}

export const langCode = (language) => String(language || 'en').split(/[-_]/)[0].toLowerCase();

function fillArgs(argv, values) {
  return argv.map((a) => a.replace(/\{(\w+)\}/g, (m, k) => (k in values ? String(values[k] ?? '') : m)));
}

function run(argv, { stdin, timeout, log }) {
  return new Promise((resolve, reject) => {
    const [cmd, ...args] = argv;
    const child = execFile(cmd, args, { timeout, maxBuffer: 8 * 1024 * 1024, windowsHide: true }, (err, stdout, stderr) => {
      if (err) {
        const why = err.killed ? `timed out after ${timeout} ms` : (stderr || err.message || '').toString().trim().split('\n').slice(-3).join(' ');
        log?.warn?.(`[speech] ${cmd} failed: ${why}`);
        return reject(new Error(`${cmd}: ${why}`));
      }
      resolve(String(stdout));
    });
    if (stdin !== undefined) { child.stdin.on('error', () => {}); child.stdin.end(stdin); }
  });
}

/** Removes what whisper prints for silence and noise ("[BLANK_AUDIO]", "(music)"). */
export function cleanTranscript(text) {
  return String(text || '')
    .replace(/\[[^\]]*\]|\([^)]*\)|<\|[^|]*\|>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function modelFor(env, prefix, lang) {
  return env[`${prefix}_MODEL_${lang.toUpperCase()}`] || env[`${prefix}_MODEL`] || '';
}

/**
 * Speech to text: ({ pcm, rate, language, hints }) -> text. `pcm` is what the customer said.
 */
export function makeStt({ command = DEFAULT_STT_COMMAND, env = process.env, timeout = 20000, tmpDir = os.tmpdir(), log } = {}) {
  const argv = splitCommand(command);
  if (!argv.length) return null;
  return async ({ pcm, rate = LINE_RATE, language = 'en', hints = '' }) => {
    const lang = langCode(language);
    const file = path.join(tmpDir, `crm-hear-${crypto.randomBytes(6).toString('hex')}.wav`);
    await fs.writeFile(file, wavEncode(resample(pcm, rate, STT_RATE), STT_RATE));
    try {
      const out = await run(fillArgs(argv, { file, lang, hints, model: modelFor(env, 'STT', lang) }), { timeout, log });
      return cleanTranscript(out);
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  };
}

/**
 * Text to speech: ({ text, language, voice }) -> Int16Array at the line rate. Lines are cached,
 * so a question asked on every call is only synthesised once.
 */
export function makeTts({ command = DEFAULT_TTS_COMMAND, env = process.env, timeout = 20000, tmpDir = os.tmpdir(), log } = {}) {
  const argv = splitCommand(command);
  if (!argv.length) return null;
  const cache = new Map();
  const inline = argv.some((a) => a.includes('{text}'));
  const tts = async ({ text, language = 'en', voice = '' }) => {
    const lang = langCode(language);
    const key = `${lang}\n${voice}\n${text}`;
    if (cache.has(key)) { const v = cache.get(key); cache.delete(key); cache.set(key, v); return v; }
    const file = path.join(tmpDir, `crm-say-${crypto.randomBytes(6).toString('hex')}.wav`);
    try {
      await run(fillArgs(argv, { file, lang, voice: voice || env.TTS_VOICE || '', model: modelFor(env, 'TTS', lang), text }), { stdin: inline ? undefined : `${text}\n`, timeout, log });
      const { rate, pcm } = wavDecode(await fs.readFile(file));
      const out = resample(pcm, rate, LINE_RATE);
      cache.set(key, out);
      if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return out;
    } finally {
      await fs.unlink(file).catch(() => {});
    }
  };
  tts.cache = cache;
  return tts;
}

/** The engines the environment describes; either is null when not set up. */
export function speechFromEnv(env = process.env, { log, tmpDir } = {}) {
  const sttCommand = env.STT_COMMAND || (env.STT_MODEL ? DEFAULT_STT_COMMAND : '');
  const ttsCommand = env.TTS_COMMAND || (env.TTS_MODEL ? DEFAULT_TTS_COMMAND : '');
  return {
    stt: sttCommand ? makeStt({ command: sttCommand, env, timeout: Number(env.STT_TIMEOUT_MS) || 20000, log, tmpDir }) : null,
    tts: ttsCommand ? makeTts({ command: ttsCommand, env, timeout: Number(env.TTS_TIMEOUT_MS) || 20000, log, tmpDir }) : null,
    describe: { stt: sttCommand || null, tts: ttsCommand || null },
  };
}
