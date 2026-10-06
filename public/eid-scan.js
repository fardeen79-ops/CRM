// Emirates ID scanner: reads either the front of the card (full printed name and ID number) or the
// machine-readable lines on the back (check digits, but long names cut short), from the phone
// camera or a photo, and returns form fields. OCR runs on the device with Tesseract.js;
// no image leaves the phone or is stored.
import { findMrz, toFormFields } from './mrz.js';
import { parseFront, splitName } from './eid-front.js';

const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const CARD_ASPECT = 85.6 / 54; // ID-1 card
const FRAME_WIDTH = 0.88; // guide frame, as a share of the video width
const MRZ_SHARE = 0.45; // the MRZ sits in roughly the bottom 45% of the card's back

let workerPromise = null;
const LOAD_TIMEOUT_MS = 60000;

function loadScript(src) {
  return new Promise((resolve, reject) => {
    if (window.Tesseract) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the scanner. Check your connection and try again.'));
    document.head.append(s);
  });
}

// Downloads a file with progress, as raw bytes.
async function fetchBytes(url, onBytes) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not download the scanner (${res.status}).`);
  if (!res.body) return new Uint8Array(await res.arrayBuffer());
  const reader = res.body.getReader();
  const chunks = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
    onBytes(value.length);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) { out.set(c, at); at += c.length; }
  return out;
}

const blobUrl = (bytes, name) => `${URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' }))}#${name}`;

// WebAssembly SIMD makes OCR faster; fall back to the plain build where it is missing.
const hasSimd = () => {
  try {
    return WebAssembly.validate(new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]));
  } catch {
    return false;
  }
};

/**
 * Starts (once) a Tesseract worker set up for MRZ characters. The page downloads the worker
 * script and the WebAssembly core itself and starts them from blob: URLs, which keeps the
 * scanner working under strict content security policies; the worker then fetches the English
 * model from langPath.
 */
function getWorker(ocr, onProgress) {
  workerPromise ??= (async () => {
    const coreFile = hasSimd() ? 'tesseract-core-simd-lstm.wasm.js' : 'tesseract-core-lstm.wasm.js';
    const expected = 4.1e6 / 0.6; // worker + core are ~60% of the download; the model is the rest
    let loaded = 0;
    const tick = (n) => { loaded += n; onProgress?.(Math.min(0.99, loaded / expected)); };
    onProgress?.(0);
    const [, workerJs, coreJs] = await Promise.all([
      loadScript(ocr.script),
      fetchBytes(ocr.workerPath, tick),
      fetchBytes(`${ocr.coreDir.replace(/\/$/, '')}/${coreFile}`, tick),
    ]);
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: blobUrl(workerJs, 'worker.min.js'),
      corePath: blobUrl(coreJs, coreFile),
      workerBlobURL: false,
      // The worker runs from a blob: URL, so the model's location must be absolute.
      langPath: new URL(ocr.langPath, location.href).href,
      logger: (m) => { if (m.status === 'loading language traineddata' && m.progress != null) onProgress?.(0.6 + m.progress * 0.4); },
    });
    onProgress?.(1);
    return worker;
  })();
  const timeout = new Promise((_, reject) => setTimeout(() => reject(new Error('The scanner took too long to load. Check your connection and try again.')), LOAD_TIMEOUT_MS));
  return Promise.race([workerPromise, timeout]).catch((err) => {
    workerPromise = null;
    throw err;
  });
}

/** Grayscale + contrast stretch, which helps Tesseract on glossy cards. */
function prepare(canvas) {
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
  const d = img.data;
  let lo = 255;
  let hi = 0;
  for (let i = 0; i < d.length; i += 4) {
    const y = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    d[i] = y;
    if (y < lo) lo = y;
    if (y > hi) hi = y;
  }
  const range = Math.max(1, hi - lo);
  for (let i = 0; i < d.length; i += 4) {
    const v = ((d[i] - lo) / range) * 255;
    d[i] = d[i + 1] = d[i + 2] = v;
  }
  ctx.putImageData(img, 0, 0);
  return canvas;
}

function crop(source, sx, sy, sw, sh, targetWidth = 1200) {
  const scale = targetWidth / sw;
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(sw * scale);
  canvas.height = Math.round(sh * scale);
  canvas.getContext('2d').drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
  return prepare(canvas);
}

const FRONT_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-:/.,\' ';

// Reads one image for the chosen side. The back is read with the MRZ alphabet; the front with
// ordinary letters so the "Name" label and the full name come through.
async function read(worker, canvas, side, psm = '6') {
  await worker.setParameters({
    tessedit_char_whitelist: side === 'back' ? MRZ_CHARS : FRONT_CHARS,
    tessedit_pageseg_mode: psm,
  });
  const { data } = await worker.recognize(canvas);
  return side === 'back' ? findMrz(data.text) : parseFront(data.text);
}

// Back: a usable read has passing document, birth and expiry check digits and an Emirates ID
// number. The ID number itself is only covered by the composite check, so a read that also
// passes that is preferred; the scanner keeps trying briefly for one before settling.
const accept = (mrz) => mrz && mrz.valid && mrz.eidNumber;
const perfect = (mrz) => accept(mrz) && mrz.checks.composite;
const SETTLE_MS = 4000;
// Front: no check digits, so a live scan waits for two frames that agree.
const frontKey = (f) => (f?.found ? `${f.fullName.toLowerCase()}|${f.eidNumber}` : null);

function explain(side, r) {
  if (side === 'front') {
    if (!r) return 'Hold the front of the card inside the frame, flat and out of direct light.';
    if (r.fullName && !r.eidNumber) return 'Name found. Keep the ID number in view too.';
    if (!r.fullName && r.eidNumber) return 'ID number found. Keep the English name in view too.';
    return 'Hold the front of the card inside the frame, flat and out of direct light.';
  }
  if (!r) return 'Hold the back of the card inside the frame, with the three lines of letters and < signs at the bottom.';
  if (r.valid && !r.eidNumber) {
    return r.issuingState && r.issuingState !== 'ARE'
      ? 'That card is not an Emirates ID. Scan the back of the customer’s Emirates ID.'
      : 'Card read, but no Emirates ID number was found on it. Try again or type the details.';
  }
  return 'Almost there. Hold the card steady, flat and out of direct light.';
}

/** Turns a read of either side into form fields plus notes for the person checking them. */
function toResult(side, r) {
  if (side === 'front') {
    return {
      side,
      fields: { ...splitName(r.fullName), eid_number: r.eidNumber },
      expiryDate: r.expiryDate,
      notes: ['The front of the card has no check digits, so compare the name and ID number with the card.'],
    };
  }
  const notes = [];
  if (r.nameTruncated) notes.push('The back of the card cuts long names short. Scan the front for the full name, or check it against the card.');
  if (!r.checks.composite) notes.push('One of the card’s check digits did not match. Compare the ID number with the card carefully.');
  return { side, fields: toFormFields(r), expiryDate: r.expiryDate, notes };
}

/**
 * Opens the scanner. Resolves with { side, fields, expiryDate, notes } once a side is read,
 * or null if the user cancels.
 */
export function openEidScanner(ocr) {
  return new Promise((resolve) => {
    let side = 'front';
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'scan-title');
    modal.innerHTML = `
      <div class="scan-sheet">
        <div class="scan-head">
          <div><h2 id="scan-title">Scan Emirates ID</h2><p class="muted small">The image stays on this device.</p></div>
          <button type="button" class="btn-link" data-close aria-label="Close scanner">Close</button>
        </div>
        <div class="segmented two-up scan-sides" role="radiogroup" aria-label="Side of the card">
          <label><input type="radio" name="scan-side" value="front" checked><span>Front <small>full name</small></span></label>
          <label><input type="radio" name="scan-side" value="back"><span>Back <small>check digits</small></span></label>
        </div>
        <div class="scan-view" hidden>
          <video playsinline muted autoplay></video>
          <div class="scan-frame" style="--frame-w:${FRAME_WIDTH * 100}%;--card-aspect:${CARD_ASPECT}">
            <div class="scan-mrz" style="height:${MRZ_SHARE * 100}%"><span>Machine-readable lines</span></div>
            <div class="scan-front-hint"><span>Front of the card</span></div>
          </div>
        </div>
        <p class="scan-status" role="status" aria-live="polite">Starting the camera…</p>
        <div class="scan-progress" hidden><span></span></div>
        <div class="actions scan-actions">
          <label class="btn" for="scan-photo">Use a photo instead</label>
          <input id="scan-photo" type="file" accept="image/*" capture="environment" hidden>
          <button type="button" data-close>Cancel</button>
        </div>
      </div>`;
    document.body.append(modal);
    const video = modal.querySelector('video');
    const view = modal.querySelector('.scan-view');
    const frame = modal.querySelector('.scan-frame');
    const status = modal.querySelector('.scan-status');
    const progress = modal.querySelector('.scan-progress');
    const bar = progress.querySelector('span');
    const photoButton = modal.querySelector('label[for="scan-photo"]');
    let stream = null;
    let done = false;
    let timer = null;
    let ready = false;
    let candidate = null; // back: best read that passed the main checks but not the composite
    let candidateAt = 0;
    let lastFront = null; // front: previous frame's read, to confirm with the next one

    const say = (msg) => { status.textContent = msg; };
    const onProgress = (p) => {
      progress.hidden = p >= 1;
      bar.style.width = `${Math.round(p * 100)}%`;
      if (p < 1) say('Loading the scanner (first time only)…');
    };
    const setSide = (value) => {
      side = value;
      frame.dataset.side = side;
      candidate = null;
      lastFront = null;
      if (ready) say(explain(side, null));
    };
    modal.querySelectorAll('input[name="scan-side"]').forEach((r) => (r.onchange = () => setSide(r.value)));
    setSide('front');

    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      stream?.getTracks().forEach((t) => t.stop());
      document.removeEventListener('keydown', onKey);
      modal.remove();
      resolve(result);
    };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    modal.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => finish(null)));

    // Photo path: works without live camera access (and over plain HTTP on most phones).
    // Reads the chosen side; if that fails, tries the other side in case the photo shows it.
    const readPhoto = async (worker, img, photoSide) => {
      const w = img.width;
      const h = img.height;
      if (photoSide === 'front') {
        // Whole photo as a block of text, then as scattered text if the layout confused it.
        let r = await read(worker, crop(img, 0, 0, w, h, 1800), 'front', '6');
        if (!r.found) {
          const sparse = await read(worker, crop(img, 0, 0, w, h, 1800), 'front', '11');
          if (sparse.found || (!r.fullName && sparse.fullName)) r = sparse;
        }
        return { ok: r.found, r };
      }
      // Back: the bottom of the photo first (where the lines usually are), then the whole photo.
      let mrz = await read(worker, crop(img, 0, Math.round(h * 0.45), w, Math.round(h * 0.55), 1400), 'back');
      if (!perfect(mrz)) {
        const whole = await read(worker, crop(img, 0, 0, w, h, 1600), 'back');
        if (perfect(whole) || (!accept(mrz) && accept(whole))) mrz = whole;
      }
      return { ok: Boolean(accept(mrz)), r: mrz };
    };
    modal.querySelector('#scan-photo').onchange = async (e) => {
      const file = e.target.files?.[0];
      e.target.value = '';
      if (!file) return;
      const chosen = side;
      const other = chosen === 'front' ? 'back' : 'front';
      try {
        say('Reading the photo…');
        const img = await createImageBitmap(file);
        const worker = await getWorker(ocr, onProgress);
        say('Reading the photo…');
        const first = await readPhoto(worker, img, chosen);
        if (first.ok) return finish(toResult(chosen, first.r));
        const second = await readPhoto(worker, img, other);
        if (second.ok) return finish(toResult(other, second.r));
        say(`${explain(chosen, first.r)} Try another photo: the whole ${chosen} of the card, sharp, with no glare.`);
      } catch (err) {
        say(err.message || 'Could not read that photo.');
      }
    };

    // Live camera path.
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        say('Live scanning needs the CRM to be opened over HTTPS. Take or choose a photo of the card instead.');
        photoButton.classList.add('btn-primary');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch {
        say('The camera can’t be opened here (it may be blocked or in use). Take or choose a photo of the card instead.');
        photoButton.classList.add('btn-primary');
        return;
      }
      if (done) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream;
      view.hidden = false;
      await video.play().catch(() => {});
      say('Loading the scanner…');
      let worker;
      try {
        worker = await getWorker(ocr, onProgress);
      } catch (err) {
        say(err.message);
        return;
      }
      ready = true;
      say(explain(side, null));

      const tick = async () => {
        if (done) return;
        if (video.videoWidth) {
          // Map the on-screen guide frame (centred, object-fit: cover) onto video pixels.
          const vw = video.videoWidth;
          const vh = video.videoHeight;
          const box = video.getBoundingClientRect();
          const scale = Math.max(box.width / vw, box.height / vh);
          const shownW = box.width / scale;
          const shownH = box.height / scale;
          const offX = (vw - shownW) / 2;
          const offY = (vh - shownH) / 2;
          const cardW = shownW * FRAME_WIDTH;
          const cardH = cardW / CARD_ASPECT;
          const cardX = offX + (shownW - cardW) / 2;
          const cardY = offY + (shownH - cardH) / 2;
          const sx = Math.max(0, cardX - cardW * 0.04);
          const sw = Math.min(vw - sx, cardW * 1.08);
          const scanning = side;
          try {
            if (scanning === 'front') {
              const sy = Math.max(0, cardY - cardH * 0.06);
              const r = await read(worker, crop(video, sx, sy, sw, Math.min(vh - sy, cardH * 1.12), 1600), 'front');
              if (scanning === side) {
                const key = frontKey(r);
                if (key && key === frontKey(lastFront)) return finish(toResult('front', r));
                lastFront = r;
                if (!done) say(key ? 'Card found. Hold steady while it is confirmed…' : explain('front', r));
              }
            } else {
              const mrzH = cardH * MRZ_SHARE;
              // A little margin around the band in case the card sits slightly off the guide.
              const sy = Math.max(0, cardY + cardH - mrzH - cardH * 0.08);
              const mrz = await read(worker, crop(video, sx, sy, sw, Math.min(vh - sy, mrzH + cardH * 0.16)), 'back');
              if (scanning === side) {
                if (perfect(mrz)) return finish(toResult('back', mrz));
                if (accept(mrz) && !candidate) {
                  candidate = mrz;
                  candidateAt = Date.now();
                }
                if (candidate && Date.now() - candidateAt > SETTLE_MS) return finish(toResult('back', candidate));
                if (!done) say(candidate ? 'Card found. Keep the whole card inside the frame and hold steady…' : explain('back', mrz));
              }
            }
          } catch { /* keep trying */ }
        }
        timer = setTimeout(tick, 400);
      };
      tick();
    })();
  });
}
