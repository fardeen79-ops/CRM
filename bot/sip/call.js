// One verification call over the SIP line: dials, then runs the playbook's conversation
// (src/bot-engine.js) over the audio: say a line, listen until the customer stops speaking,
// turn it into text, let the engine decide the next line. Returns the same result the Twilio
// service reports to the CRM, plus the path of the recording made on this server.
import path from 'node:path';
import { callResult, hangUp, respond, startCall } from '../../src/bot-engine.js';
import { Endpointer, FRAME_MS, WavWriter } from './audio.js';
import { RtpSession, bindRtp } from './rtp.js';
import { SipError, buildSdp } from './sip.js';

export const DEFAULT_AUDIO = Object.freeze({
  ringTimeoutMs: 45000,     // how long the phone rings before the call counts as not answered
  noSpeechMs: 6000,         // silence after a question before the bot re-asks
  maxUtteranceMs: 15000,    // the longest answer taken in one go
  silenceMs: 800,           // the pause that ends an answer
  bargeIn: false,           // let the customer cut the bot's line short by speaking
  machineDetection: true,   // hang up when a voicemail greeting answers
  machineMs: 3500,          // speech this long, right after answer, is a recorded greeting
  machineWindowMs: 7000,    // ...only within this long after the call is answered
  portRange: [10000, 20000],
});

/** What a SIP failure means for the file, in the CRM's words. */
export function outcomeOf(err) {
  const s = err instanceof SipError ? err.status : 0;
  const failed = (why) => ({ status: 'failed', error: why });
  if (s === 486 || s === 600) return { status: 'completed', outcome: 'busy', checks: [], summary: 'The call was not answered (busy).' };
  if ([404, 410, 484, 604].includes(s)) return { status: 'completed', outcome: 'wrong_number', checks: [], summary: `The number is not in service (${s}).` };
  if (s === 480) return { status: 'completed', outcome: 'switched_off', checks: [], summary: 'The call was not answered (temporarily unavailable, usually switched off or out of coverage).' };
  if ([408, 487].includes(s) || (s === 0 && /ring/i.test(err.message))) return { status: 'completed', outcome: 'no_answer', checks: [], summary: 'The call was not answered.' };
  if (s === 401 || s === 407) return failed('The SIP provider rejected the account (check SIP_USERNAME and SIP_PASSWORD)');
  if (s === 403) return failed('The SIP provider refused the call (403 Forbidden): the account may not be allowed to dial this number');
  if (s >= 500) return failed(`The SIP provider could not place the call (${s} ${err.reason})`);
  if (s) return failed(`The SIP provider answered ${s} ${err.reason}`);
  return failed(`The SIP server could not be reached: ${err.message}`);
}

/** Watches the first seconds of a call for a voicemail greeting: long, continuous speech. */
function machineWatch(rtp, { machineMs, machineWindowMs }, onMachine) {
  const ep = new Endpointer({ silenceMs: 400, minSpeechMs: 100 });
  let spoken = 0; const started = Date.now();
  const onFrame = (heard) => {
    if (Date.now() - started > machineWindowMs) return stop();
    const ev = ep.feed(heard);
    if (ev === 'start') spoken = 0;
    if (ev === 'start' || ev === 'frame') { spoken += FRAME_MS; if (spoken >= machineMs) { stop(); onMachine(); } }
  };
  const stop = () => rtp.removeListener('frame', onFrame);
  rtp.on('frame', onFrame);
  return stop;
}

/**
 * Listens for one answer: resolves with the customer's speech (8 kHz PCM), or null when nothing
 * was said within `noSpeechMs` of the line ending. `playing` is the promise of the line being
 * played; with `bargeIn` the customer is heard during it and speaking stops the line.
 */
export function listen(rtp, { noSpeechMs, maxUtteranceMs, silenceMs, signal, playing, bargeIn = false }) {
  return new Promise((resolve) => {
    const ep = new Endpointer({ silenceMs });
    let speaking = false; let timer = null; let done = false;
    const finish = (pcm) => {
      if (done) return;
      done = true; clearTimeout(timer); rtp.removeListener('frame', onFrame); signal?.removeEventListener('abort', onAbort);
      resolve(pcm);
    };
    const onAbort = () => finish(null);
    const arm = (ms, fn) => { clearTimeout(timer); timer = setTimeout(fn, ms); };
    const onFrame = (heard) => {
      const ev = ep.feed(heard);
      if (ev === 'start') {
        speaking = true;
        rtp.stop(); // no-op unless a line is still playing (barge-in)
        arm(maxUtteranceMs, () => finish(ep.take()));
      } else if (ev === 'end') finish(ep.take());
    };
    signal?.addEventListener('abort', onAbort);
    // Without barge-in the bot's own line is not listened to, so it cannot hear itself.
    const afterLine = () => { if (!bargeIn) rtp.on('frame', onFrame); if (!speaking) arm(noSpeechMs, () => finish(null)); };
    if (bargeIn) rtp.on('frame', onFrame);
    if (playing) playing.then(afterLine); else afterLine();
  });
}

/**
 * @param {object} o
 * @param {import('./sip.js').SipUA} o.ua
 * @param {object} o.request      the CRM's call request
 * @param {object} o.playbook     normalised playbook
 * @param {string} o.number       E.164 number to dial
 * @param {Function} o.stt        ({ pcm, rate, language, hints }) -> text
 * @param {Function} o.tts        ({ text, language, voice }) -> Int16Array
 * @param {Function} [o.interpret] Claude reading answers (optional; sends transcripts out)
 * @param {Function} [o.phrase]
 * @param {string} [o.recordingPath]  where to write the recording; none = not recorded
 * @param {Function} [o.onAnswered]
 * @param {object} [o.audio]      DEFAULT_AUDIO overrides
 */
export async function runCall({ ua, request, playbook, number, stt, tts, interpret, phrase, recordingPath, onAnswered, audio = {}, log = console, mediaIp }) {
  const opts = { ...DEFAULT_AUDIO, ...audio };
  const socket = await bindRtp(ua.localIp, opts.portRange);
  const rtp = new RtpSession(socket);
  const sdp = buildSdp({ ip: mediaIp || ua.localIp, port: rtp.localPort });
  const ref = request.ref || request.case_id;
  let answered;
  try {
    answered = await ua.call({ number, sdp, ringTimeout: opts.ringTimeoutMs, onProgress: (code) => log.info?.(`[sip] ${ref}: ${code === 180 ? 'ringing' : 'progress'}`) });
  } catch (err) {
    rtp.close();
    const result = outcomeOf(err);
    log.info?.(`[sip] ${ref}: ${result.error || result.summary}`);
    return { result };
  }
  const { dialog } = answered;
  if (!answered.sdp || answered.sdp.payloadType === null) {
    await dialog.bye();
    rtp.close();
    return { result: { status: 'failed', error: 'The SIP provider offered no G.711 audio for the call' } };
  }
  rtp.setRemote(answered.sdp.address, answered.sdp.port, answered.sdp.payloadType);
  dialog.on('media', (m) => rtp.setRemote(m.address, m.port, m.payloadType ?? undefined));
  const recorder = recordingPath ? new WavWriter(recordingPath) : null;
  rtp.recorder = recorder;
  rtp.start();
  onAnswered?.();

  const hung = new AbortController();
  let machine = false;
  dialog.on('bye', () => { log.info?.(`[sip] ${ref}: the customer hung up`); hung.abort(); rtp.stop(); });
  const stopMachineWatch = opts.machineDetection ? machineWatch(rtp, opts, () => { machine = true; hung.abort(); rtp.stop(); }) : () => {};

  const lang = playbook.language; const voice = playbook.voice || '';
  let state = startCall(playbook, { values: request.values || {}, checks: request.checks });
  let failure = null;
  try {
    while (!hung.signal.aborted) {
      let pcm;
      try { pcm = await tts({ text: state.say, language: lang, voice }); } catch (err) { failure = `The bot's voice could not be produced: ${err.message}`; break; }
      if (hung.signal.aborted) break;
      const playing = rtp.play(pcm);
      if (state.done) { await playing; break; }
      const check = state.stage === 'check' ? state.checks[state.index] : null;
      const hints = [...playbook.yes_words, ...playbook.no_words, ...(check?.expected ? [].concat(check.expected).map(String) : [])].slice(0, 60).join(', ');
      const heardPcm = await listen(rtp, { ...opts, signal: hung.signal, playing });
      if (hung.signal.aborted) break;
      let heard = '';
      if (heardPcm) {
        try { heard = await stt({ pcm: heardPcm, rate: 8000, language: lang, hints }); } catch (err) { log.warn?.(`[sip] ${ref}: recognition failed, treating the answer as not understood: ${err.message}`); }
      }
      if (hung.signal.aborted) break;
      state = await respond(state, playbook, heard, { interpret, phrase });
    }
  } finally {
    stopMachineWatch();
    await dialog.bye();
    rtp.close();
    recorder?.close();
  }
  let result;
  if (failure) result = { status: 'failed', error: failure };
  else if (machine) result = { status: 'completed', outcome: 'no_answer', checks: [], summary: 'A voicemail answered; the bot hung up.' };
  else result = callResult(state.done ? state : hangUp(state));
  return { result, recordingPath: recorder ? recordingPath : null, answered: true };
}

export const recordingFile = (dir, id) => path.join(dir, `${id}.wav`);
