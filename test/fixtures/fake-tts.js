// Stands in for piper: reads the line from stdin and writes a 22050 Hz WAV of a tone, half a second long.
import fs from 'node:fs';
let text = '';
process.stdin.on('data', (d) => { text += d; });
process.stdin.on('end', () => {
  const file = process.argv[process.argv.indexOf('--output_file') + 1];
  const rate = 22050; const n = Math.round(rate * 0.5);
  const data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 440 * i) / rate) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8); h.write('fmt ', 12); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([h, data]));
  if (!text.trim()) process.exit(3);
});
