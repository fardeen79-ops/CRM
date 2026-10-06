// Emirates ID scanner: reads the machine-readable lines on the back of the card with the phone
// camera (or a photo) and returns the parsed fields. OCR runs on the device with Tesseract.js;
// no image leaves the phone or is stored.
import { findMrz } from './mrz.js';

const MRZ_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789<';
const CARD_ASPECT = 85.6 / 54; // ID-1 card
const FRAME_WIDTH = 0.88; // guide frame, as a share of the video width
const MRZ_SHARE = 0.45; // the MRZ sits in roughly the bottom 45% of the card's back

let workerPromise = null;

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

/** Starts (once) a Tesseract worker set up for MRZ characters. */
function getWorker(ocr, onProgress) {
  workerPromise ??= (async () => {
    await loadScript(ocr.script);
    const worker = await window.Tesseract.createWorker('eng', 1, {
      workerPath: ocr.workerPath,
      corePath: ocr.corePath,
      langPath: ocr.langPath,
      workerBlobURL: ocr.workerBlobURL,
      logger: (m) => { if (m.progress != null && /loading/.test(m.status)) onProgress?.(m.progress); },
    });
    await worker.setParameters({ tessedit_char_whitelist: MRZ_CHARS, tessedit_pageseg_mode: '6' });
    return worker;
  })().catch((err) => {
    workerPromise = null;
    throw err;
  });
  return workerPromise;
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

async function read(worker, canvas) {
  const { data } = await worker.recognize(canvas);
  return findMrz(data.text);
}

// A usable read has passing document, birth and expiry check digits and an Emirates ID number.
// The ID number itself is only covered by the composite check, so a read that also passes that
// is preferred; the scanner keeps trying briefly for one before settling.
const accept = (mrz) => mrz && mrz.valid && mrz.eidNumber;
const perfect = (mrz) => accept(mrz) && mrz.checks.composite;
const SETTLE_MS = 4000;

function explain(mrz) {
  if (!mrz) return 'Hold the back of the card inside the frame, with the three lines of letters and < signs at the bottom.';
  if (mrz.valid && !mrz.eidNumber) {
    return mrz.issuingState && mrz.issuingState !== 'ARE'
      ? 'That card is not an Emirates ID. Scan the back of the customer’s Emirates ID.'
      : 'Card read, but no Emirates ID number was found on it. Try again or type the details.';
  }
  return 'Almost there. Hold the card steady, flat and out of direct light.';
}

/**
 * Opens the scanner. Resolves with the parsed MRZ when a read passes its check digits,
 * or null if the user cancels.
 */
export function openEidScanner(ocr) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.setAttribute('role', 'dialog');
    modal.setAttribute('aria-modal', 'true');
    modal.setAttribute('aria-labelledby', 'scan-title');
    modal.innerHTML = `
      <div class="scan-sheet">
        <div class="scan-head">
          <div><h2 id="scan-title">Scan Emirates ID</h2><p class="muted small">Back of the card. The image stays on this device.</p></div>
          <button type="button" class="btn-link" data-close aria-label="Close scanner">Close</button>
        </div>
        <div class="scan-view" hidden>
          <video playsinline muted autoplay></video>
          <div class="scan-frame" style="--frame-w:${FRAME_WIDTH * 100}%;--card-aspect:${CARD_ASPECT}">
            <div class="scan-mrz" style="height:${MRZ_SHARE * 100}%"><span>Machine-readable lines</span></div>
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
    const status = modal.querySelector('.scan-status');
    const progress = modal.querySelector('.scan-progress');
    const bar = progress.querySelector('span');
    const photoButton = modal.querySelector('label[for="scan-photo"]');
    let stream = null;
    let done = false;
    let timer = null;

    const say = (msg) => { status.textContent = msg; };
    const onProgress = (p) => {
      progress.hidden = p >= 1;
      bar.style.width = `${Math.round(p * 100)}%`;
      if (p < 1) say('Loading the scanner (first time only)…');
    };
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
    modal.querySelector('#scan-photo').onchange = async (e) => {
      const file = e.target.files?.[0];
      if (!file) return;
      try {
        say('Reading the photo…');
        const img = await createImageBitmap(file);
        const worker = await getWorker(ocr, onProgress);
        say('Reading the photo…');
        const w = img.width;
        const h = img.height;
        // Try the bottom of the photo first (where the lines usually are), then the whole photo.
        let mrz = await read(worker, crop(img, 0, Math.round(h * 0.45), w, Math.round(h * 0.55), 1400));
        if (!perfect(mrz)) {
          const whole = await read(worker, crop(img, 0, 0, w, h, 1600));
          if (perfect(whole) || (!accept(mrz) && accept(whole))) mrz = whole;
        }
        if (accept(mrz)) return finish(mrz);
        say(`${explain(mrz)} Try another photo: the whole back of the card, sharp, with no glare.`);
      } catch (err) {
        say(err.message || 'Could not read that photo.');
      }
    };

    // Live camera path.
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) {
        say('Live scanning needs the CRM to be opened over HTTPS on this device. Use a photo instead.');
        photoButton.classList.add('btn-primary');
        return;
      }
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
          audio: false,
        });
      } catch {
        say('The camera is not available (permission denied or in use). Use a photo instead.');
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
      say(explain(null));

      let candidate = null; // best read so far that passed the main checks but not the composite
      let candidateAt = 0;
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
          const mrzH = cardH * MRZ_SHARE;
          // A little margin around the band in case the card sits slightly off the guide.
          const sy = Math.max(0, cardY + cardH - mrzH - cardH * 0.08);
          const sh = Math.min(vh - sy, mrzH + cardH * 0.16);
          try {
            const mrz = await read(worker, crop(video, Math.max(0, cardX - cardW * 0.04), sy, Math.min(vw, cardW * 1.08), sh));
            if (perfect(mrz)) return finish(mrz);
            if (accept(mrz) && !candidate) {
              candidate = mrz;
              candidateAt = Date.now();
            }
            if (candidate && Date.now() - candidateAt > SETTLE_MS) return finish(candidate);
            if (!done) say(candidate ? 'Card found. Keep the whole card inside the frame and hold steady…' : explain(mrz));
          } catch { /* keep trying */ }
        }
        timer = setTimeout(tick, 400);
      };
      tick();
    })();
  });
}
