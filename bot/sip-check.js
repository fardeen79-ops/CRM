// Checks the native calling bot's setup before go-live: the voice and recognition programs,
// the SIP line, and optionally one test call to your own phone.
//
//   node bot/sip-check.js                 # speech engines, then the SIP line (registration)
//   node bot/sip-check.js --call 0501234567   # ...and call this number, say a line, hang up
//
// Reads the same environment as `npm run bot:sip`.
import { LINE_RATE, WavWriter } from './sip/audio.js';
import { RtpSession, bindRtp } from './sip/rtp.js';
import { SipUA, buildSdp } from './sip/sip.js';
import { speechFromEnv } from './sip/speech.js';
import { audioFromEnv, sipFromEnv } from './sip-server.js';
import { toE164 } from './server.js';

const TEST_LINE = 'Hello. This is a test call from the verification bot. Everything is working. Goodbye.';
const ok = (m) => console.log(`  ✓ ${m}`);
const bad = (m) => { console.log(`  ✗ ${m}`); process.exitCode = 1; };

async function checkSpeech() {
  console.log('Speech engines');
  const { stt, tts, describe } = speechFromEnv(process.env);
  if (!tts) { bad('Voice not set up: set TTS_MODEL (Piper model path) or TTS_COMMAND'); return null; }
  if (!stt) bad('Recognition not set up: set STT_MODEL (whisper.cpp model path) or STT_COMMAND');
  let pcm;
  try {
    const t = Date.now();
    pcm = await tts({ text: TEST_LINE, language: process.env.BOT_CHECK_LANGUAGE || 'en-GB', voice: process.env.TTS_VOICE || '' });
    ok(`Voice: "${describe.tts}" produced ${(pcm.length / LINE_RATE).toFixed(1)} s of audio in ${Date.now() - t} ms`);
  } catch (err) { bad(`Voice failed: ${err.message}`); return null; }
  if (process.env.BOT_CHECK_WAV) { const w = new WavWriter(process.env.BOT_CHECK_WAV); w.write(pcm); w.close(); ok(`Wrote the line to ${process.env.BOT_CHECK_WAV} (listen to it)`); }
  if (stt) {
    try {
      const t = Date.now();
      const heard = await stt({ pcm, rate: LINE_RATE, language: process.env.BOT_CHECK_LANGUAGE || 'en-GB', hints: 'verification bot' });
      const good = /verification/i.test(heard) && /working/i.test(heard);
      (good ? ok : bad)(`Recognition: "${describe.stt}" heard "${heard}" in ${Date.now() - t} ms${good ? '' : ' (expected the test line)'}`);
    } catch (err) { bad(`Recognition failed: ${err.message}`); }
  }
  return { tts, pcm };
}

async function checkLine(speech) {
  console.log('SIP line');
  const sip = sipFromEnv(process.env);
  if (!sip) { bad('Not set up: set SIP_SERVER, SIP_USERNAME and SIP_PASSWORD'); return; }
  const ua = new SipUA({ ...sip, log: { info() {}, warn: (m) => console.log(`    ${m}`), error: (m) => console.log(`    ${m}`) } });
  if (process.env.SIP_TRACE) ua.on('trace', (dir, text) => console.log(`    ${dir === 'out' ? '→' : '←'} ${text.split('\r\n')[0]}`));
  try {
    await ua.start();
    ok(`Bound to ${ua.localIp}:${ua.localPort}, server ${ua.server.host} (${ua.serverIp}:${ua.server.port})`);
    if (ua.shouldRegister) (ua.registered ? ok : bad)(ua.registered ? `Registered as ${ua.username}@${ua.domain}` : 'Registration failed (see above): check SIP_USERNAME, SIP_PASSWORD, SIP_DOMAIN');
    else ok('Registration not required (SIP_REGISTER=0)');
  } catch (err) {
    bad(`Could not start: ${err.message}`);
    return;
  }
  const at = process.argv.indexOf('--call');
  const number = at !== -1 ? toE164(process.argv[at + 1], process.env.BOT_COUNTRY_CODE || '971') : null;
  if (at !== -1 && !number) bad(`"${process.argv[at + 1]}" is not a number that can be dialled`);
  if (number && speech) {
    console.log(`Test call to ${number}`);
    const audio = audioFromEnv(process.env);
    const socket = await bindRtp(ua.localIp, audio.portRange);
    const rtp = new RtpSession(socket);
    try {
      const t = Date.now();
      const { dialog, sdp } = await ua.call({ number: number.replace(/^\+/, ''), sdp: buildSdp({ ip: process.env.SIP_MEDIA_IP || ua.localIp, port: rtp.localPort }), ringTimeout: audio.ringTimeoutMs, onProgress: (c) => console.log(`    ${c === 180 ? 'ringing' : `progress ${c}`}`) });
      ok(`Answered after ${((Date.now() - t) / 1000).toFixed(1)} s; audio to ${sdp?.address}:${sdp?.port} (${sdp?.payloadType === 8 ? 'A-law' : 'µ-law'})`);
      rtp.setRemote(sdp.address, sdp.port, sdp.payloadType);
      rtp.start();
      await new Promise((r) => setTimeout(r, 500));
      await rtp.play(speech.pcm);
      await new Promise((r) => setTimeout(r, 500));
      (rtp.received > 0 ? ok : bad)(`Said the test line; ${rtp.received} audio packets came back from the line${rtp.received ? '' : ' (check SIP_MEDIA_IP / firewall for the RTP ports)'}`);
      await dialog.bye();
      ok('Hung up');
    } catch (err) {
      bad(`Call failed: ${err.message}`);
    } finally {
      rtp.close();
    }
  }
  await ua.stop();
}

const speech = await checkSpeech();
await checkLine(speech);
console.log(process.exitCode ? 'Some checks failed.' : 'All checks passed.');
