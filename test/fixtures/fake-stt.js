// Stands in for whisper-cli: checks it was given a 16 kHz WAV and prints what "it heard".
import fs from 'node:fs';
const [file, lang, hints] = process.argv.slice(2);
const buf = fs.readFileSync(file);
const rate = buf.readUInt32LE(24);
if (buf.toString('ascii', 0, 4) !== 'RIFF' || rate !== 16000) { console.error(`bad input: rate ${rate}`); process.exit(2); }
console.log(`[BLANK_AUDIO] ${process.env.FAKE_STT_TEXT || 'yes please'} (${lang}; hints: ${hints})`);
