// Downloads the Emirates ID scanner's OCR engine (Tesseract.js, its WebAssembly core and the
// English model) into public/vendor/tesseract so the CRM serves it itself instead of a CDN.
// Run once: npm run setup:ocr
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const target = path.join(root, 'public', 'vendor', 'tesseract');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'crm-ocr-'));

const packages = {
  'tesseract.js@5.1.1': ['dist/tesseract.min.js', 'dist/worker.min.js'],
  'tesseract.js-core@5.1.1': ['tesseract-core-lstm.wasm.js', 'tesseract-core-simd-lstm.wasm.js'],
  '@tesseract.js-data/eng@1.0.0': ['4.0.0_best_int/eng.traineddata.gz'],
};

fs.mkdirSync(target, { recursive: true });
for (const [pkg, files] of Object.entries(packages)) {
  const tgz = execFileSync('npm', ['pack', pkg, '--silent'], { cwd: tmp, encoding: 'utf8' }).trim().split('\n').pop();
  const dir = path.join(tmp, tgz.replace(/\.tgz$/, ''));
  fs.mkdirSync(dir);
  execFileSync('tar', ['xzf', path.join(tmp, tgz), '-C', dir]);
  for (const f of files) {
    fs.copyFileSync(path.join(dir, 'package', f), path.join(target, path.basename(f)));
    console.log(`  ${path.basename(f)}`);
  }
}
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`Scanner files saved to ${path.relative(root, target)}. Restart the CRM to use them.`);
