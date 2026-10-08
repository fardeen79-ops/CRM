// Speech on the case form: dictating into a text box, and reading an ID number back to check it.
// Uses the browser's own speech recognition (Chrome, Edge and Safari; not Firefox). Nothing is
// sent to the CRM server; the browser does the recognition.

const Recognition = typeof window !== 'undefined' ? (window.SpeechRecognition || window.webkitSpeechRecognition) : null;

/** True when this browser can listen (a test or the demo can plug in a fake via window.__crmSpeech). */
export const speechSupported = () => Boolean((typeof window !== 'undefined' && window.__crmSpeech) || Recognition);

/**
 * Listens once and calls onResult with the text heard (interim results first, then the final
 * one with `final: true`). Returns a function that stops listening.
 */
export function listen({ lang = 'en-US', onResult, onEnd, onError } = {}) {
  if (typeof window !== 'undefined' && window.__crmSpeech) return window.__crmSpeech({ lang, onResult, onEnd, onError });
  if (!Recognition) { onError?.('Speech recognition is not available in this browser'); onEnd?.(); return () => {}; }
  const rec = new Recognition();
  rec.lang = lang;
  rec.interimResults = true;
  rec.maxAlternatives = 1;
  rec.continuous = false;
  let ended = false;
  rec.onresult = (e) => {
    let text = '';
    let final = false;
    for (const r of e.results) { text += r[0].transcript; if (r.isFinal) final = true; }
    onResult?.(text.trim(), { final });
  };
  rec.onerror = (e) => onError?.(e.error === 'not-allowed' ? 'Microphone access was blocked. Allow the microphone for this site and try again.' : e.error === 'no-speech' ? 'Nothing was heard. Try again, closer to the microphone.' : `Could not listen (${e.error})`);
  rec.onend = () => { if (!ended) { ended = true; onEnd?.(); } };
  try { rec.start(); } catch (err) { onError?.(err.message); onEnd?.(); }
  return () => { try { rec.stop(); } catch { /* already stopped */ } };
}

const NUMBER_WORDS = {
  zero: '0', oh: '0', o: '0', nought: '0', one: '1', two: '2', three: '3', four: '4', for: '4', five: '5',
  six: '6', seven: '7', eight: '8', ate: '8', nine: '9',
};
const NATO = {
  alpha: 'A', alfa: 'A', bravo: 'B', charlie: 'C', delta: 'D', echo: 'E', foxtrot: 'F', golf: 'G', hotel: 'H', india: 'I',
  juliet: 'J', juliett: 'J', kilo: 'K', lima: 'L', mike: 'M', november: 'N', oscar: 'O', papa: 'P', quebec: 'Q', romeo: 'R',
  sierra: 'S', tango: 'T', uniform: 'U', victor: 'V', whiskey: 'W', xray: 'X', yankee: 'Y', zulu: 'Z',
};
// "double seven" and "triple two" are common when reading numbers aloud.
const REPEATS = { double: 2, triple: 3 };

/**
 * Turns something read aloud ("seven eight four, double one, N for November") into the letters
 * and digits it names: "78411N". Digits the recogniser already wrote as numbers are kept.
 */
export function spokenToCode(text) {
  const words = String(text).toLowerCase().replace(/[-.,]/g, ' ').split(/\s+/).filter(Boolean);
  let out = '';
  let repeat = 1;
  for (let i = 0; i < words.length; i++) {
    const w = words[i];
    // "N for November": the letter, then "for" and its alphabet word, which just confirm it.
    if (/^[a-z]$/.test(w) && ['for', 'as', 'like'].includes(words[i + 1]) && NATO[words[i + (words[i + 1] === 'as' ? 3 : 2)]] === w.toUpperCase()) {
      out += w.toUpperCase().repeat(repeat); repeat = 1; i += words[i + 1] === 'as' ? 3 : 2; continue;
    }
    if (REPEATS[w]) { repeat = REPEATS[w]; continue; }
    let piece = '';
    if (/^\d+$/.test(w)) piece = w;
    else if (NUMBER_WORDS[w]) piece = NUMBER_WORDS[w];
    else if (NATO[w]) piece = NATO[w];
    else if (/^[a-z]$/.test(w)) piece = w.toUpperCase();
    else if (/^[a-z]\d+$/.test(w) || /^\d+[a-z]$/.test(w)) piece = w.toUpperCase(); // "n1234567" run together
    else { repeat = 1; continue; } // filler words: "and", "then", "it's"
    out += piece.repeat(repeat);
    repeat = 1;
  }
  return out;
}

/** Does what was read aloud match the value in the box? Dashes, spaces and case are ignored. */
export function readBackMatches(fieldValue, spoken) {
  const want = String(fieldValue || '').replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  const heard = spokenToCode(spoken);
  return { want, heard, match: Boolean(want) && want === heard };
}
