// Scanning a lead sheet: a photo of a printed or hand-written lead form, read on the device with
// the same OCR engine as the Emirates ID scanner, turned into the fields of a lead for the sales
// person to check before saving. Nothing leaves the phone.
import { getWorker, crop } from './eid-scan.js';

const LEAD_LABELS = {
  name: /^(customer|client|applicant)?\s*(full\s*)?name\b/i,
  first_name: /^first\s*name\b/i,
  last_name: /^(last|sur|family)\s*name\b/i,
  phone: /^(mobile|phone|mob|cell|contact|tel|telephone|whatsapp)(\s*(no|number|#))?\b/i,
  email: /^(e-?mail)\b/i,
  company_name: /^(company|employer|organi[sz]ation|firm|works?\s*at)\b/i,
  salary: /^(monthly\s*)?(salary|income|pay)\b/i,
  product: /^(product|interested\s*in|interest|looking\s*for|requirement)\b/i,
  source: /^(lead\s*)?(source|referred\s*by|referral|channel)\b/i,
  city: /^(city|location|emirate|area)\b/i,
  follow_up_at: /^(follow[\s-]*up|call\s*back|next\s*call|visit)(\s*(date|on))?\b/i,
  notes: /^(notes?|remarks?|comments?)\b/i,
};
const LEAD_PRODUCT_WORDS = [
  ['credit_card', /\b(credit\s*card|card|cc)\b/i], ['personal_loan', /\b(personal\s*loan|pl|loan|buy-?out|top-?up)\b/i],
  ['auto_loan', /\b(auto\s*loan|car\s*loan|auto|car|vehicle)\b/i], ['accounts', /\b(account|savings|current)\b/i],
];
const LEAD_NOISE = /^(lead\s*sheet|lead\s*form|date|sales\s*(staff|person|executive)|se\s*name|signature|remarks?|page\b|derby|enbd|emirates\s*nbd)/i;

/** Fixes the digits OCR confuses in a phone number, keeps a leading +. */
const leadDigits = (s) => String(s).replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[sS]/g, '5').replace(/[^\d+]/g, '');
function leadPhone(s) {
  const m = String(s).match(/(\+?\s*9?7?1?[\s-]*0?5[\d\s\-oOlI]{8,})|(\+?971[\d\s-]{8,})/);
  if (!m) return null;
  let d = leadDigits(m[0]);
  if (d.startsWith('+971')) d = '0' + d.slice(4);
  else if (d.startsWith('971')) d = '0' + d.slice(3);
  else if (d.startsWith('5') && d.length === 9) d = '0' + d;
  return /^05\d{8}$/.test(d) ? `+971 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : null;
}
const leadEmail = (s) => (String(s).match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [null])[0];
function leadSalary(s) {
  const m = String(s).replace(/,/g, '').match(/(\d{4,6})(?:\s*(k|000))?/i);
  if (!m) return null;
  let n = Number(m[1]); if (/k/i.test(m[2] || '')) n *= 1000;
  return n >= 1000 && n <= 500000 ? n : null;
}
const leadDate = (s) => {
  const m = String(s).match(/(\d{1,2})[\/.-](\d{1,2})[\/.-](\d{2,4})/) || String(s).match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  if (m[1].length === 4) return `${m[1]}-${m[2]}-${m[3]}`;
  const y = m[3].length === 2 ? `20${m[3]}` : m[3];
  return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
};
const leadProduct = (s) => (LEAD_PRODUCT_WORDS.find(([, re]) => re.test(s)) || [null])[0];
const leadTitleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase());
const leadNameLike = (s) => /^[A-Za-z][A-Za-z'.\- ]{2,60}$/.test(s.trim()) && s.trim().split(/\s+/).length >= 2 && !LEAD_NOISE.test(s);

/**
 * Reads the OCR text of a lead sheet into lead fields. Labelled lines ("Mobile: 050…") win;
 * otherwise a phone number, an email, a salary and a product are picked out of the text and the
 * first name-like line becomes the customer's name. Returns { fields, lines, found }.
 */
export function parseLeadSheet(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\s+/g, ' ').trim()).filter(Boolean);
  const fields = {};
  const leftover = [];
  for (const line of lines) {
    const m = line.match(/^([A-Za-z][A-Za-z\s\/-]{1,24}?)\s*[:\-–=]\s*(.+)$/);
    let key = null; let value = line;
    if (m) { key = Object.keys(LEAD_LABELS).find((k) => LEAD_LABELS[k].test(m[1].trim())) || null; value = m[2].trim(); }
    if (!key) { leftover.push(line); continue; }
    if (key === 'name') { const parts = value.split(/\s+/).filter((p) => /[A-Za-z]/.test(p)); if (parts.length) { fields.first_name = leadTitleCase(parts[0]); fields.last_name = leadTitleCase(parts[parts.length - 1]); if (parts.length > 2) fields.middle_name = leadTitleCase(parts.slice(1, -1).join(' ')); } }
    else if (key === 'first_name') fields.first_name = leadTitleCase(value);
    else if (key === 'last_name') fields.last_name = leadTitleCase(value);
    else if (key === 'phone') fields.phone = leadPhone(value) || fields.phone;
    else if (key === 'email') fields.email = (leadEmail(value) || '').toLowerCase() || fields.email;
    else if (key === 'salary') fields.salary = leadSalary(value) ?? fields.salary;
    else if (key === 'product') fields.product = leadProduct(value) || fields.product;
    else if (key === 'follow_up_at') fields.follow_up_at = leadDate(value) || fields.follow_up_at;
    else if (key === 'notes') fields.notes = value;
    else fields[key] = value.replace(/[.,;]+$/, '');
  }
  // Unlabelled text: pick out what can be recognised, the rest becomes notes.
  const rest = [];
  for (const line of leftover) {
    if (LEAD_NOISE.test(line)) continue;
    let used = false;
    if (!fields.phone) { const p = leadPhone(line); if (p) { fields.phone = p; used = true; } }
    if (!fields.email) { const e = leadEmail(line); if (e) { fields.email = e.toLowerCase(); used = true; } }
    if (!fields.salary && /aed|salary|income|\d{4,6}/i.test(line) && !leadPhone(line)) { const s = leadSalary(line); if (s && /aed|salary|income/i.test(line)) { fields.salary = s; used = true; } }
    if (!fields.product) { const pr = leadProduct(line); if (pr && /card|loan|auto|account|product|interested/i.test(line)) { fields.product = pr; used = true; } }
    if (!fields.first_name && !used && leadNameLike(line)) { const parts = line.trim().split(/\s+/); fields.first_name = leadTitleCase(parts[0]); fields.last_name = leadTitleCase(parts[parts.length - 1]); if (parts.length > 2) fields.middle_name = leadTitleCase(parts.slice(1, -1).join(' ')); used = true; }
    if (!used) rest.push(line);
  }
  if (!fields.notes && rest.length) fields.notes = rest.join('\n').slice(0, 2000);
  if (fields.salary != null && typeof fields.salary === 'string') fields.salary = leadSalary(fields.salary);
  const found = ['first_name', 'phone', 'email', 'company_name', 'salary', 'product'].filter((k) => fields[k]);
  return { fields, lines, found };
}

const LEAD_SHEET_CHARS = ''; // no whitelist: a sheet has any text
async function readLeadSheet(worker, canvas) {
  await worker.setParameters({ tessedit_char_whitelist: LEAD_SHEET_CHARS, tessedit_pageseg_mode: '6' });
  const { data } = await worker.recognize(canvas);
  let r = parseLeadSheet(data.text);
  if (r.found.length < 2) {
    await worker.setParameters({ tessedit_pageseg_mode: '4' });
    const again = parseLeadSheet((await worker.recognize(canvas)).data.text);
    if (again.found.length > r.found.length) r = again;
  }
  return r;
}

/**
 * Opens the lead sheet scanner: the camera with a Capture button, or a photo. Resolves with
 * { fields, found, text } once a sheet is read, or null if the user cancels.
 */
export function openLeadScanner(ocr) {
  return new Promise((resolve) => {
    const modal = document.createElement('div');
    modal.className = 'scan-modal';
    modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true'); modal.setAttribute('aria-labelledby', 'lead-scan-title');
    modal.innerHTML = `
      <div class="scan-sheet">
        <div class="scan-head">
          <div><h2 id="lead-scan-title">Scan a lead sheet</h2><p class="muted small">Fill the frame with the sheet, flat and well lit, then capture. The image stays on this device.</p></div>
          <button type="button" class="btn-link" data-close aria-label="Close scanner">Close</button>
        </div>
        <div class="scan-view lead-scan-view" hidden><video playsinline muted autoplay></video></div>
        <p class="scan-status" role="status" aria-live="polite">Starting the camera…</p>
        <div class="scan-progress" hidden><span></span></div>
        <div class="actions scan-actions">
          <button type="button" class="btn-primary" data-capture hidden>Capture</button>
          <label class="btn" for="lead-scan-photo">Use a photo instead</label>
          <input id="lead-scan-photo" type="file" accept="image/*" capture="environment" hidden>
          <button type="button" data-close>Cancel</button>
        </div>
      </div>`;
    document.body.append(modal);
    const video = modal.querySelector('video'); const view = modal.querySelector('.scan-view');
    const status = modal.querySelector('.scan-status'); const progress = modal.querySelector('.scan-progress'); const bar = progress.querySelector('span');
    const captureBtn = modal.querySelector('[data-capture]'); const photoButton = modal.querySelector('label[for="lead-scan-photo"]');
    let stream = null; let done = false;
    const say = (m) => { status.textContent = m; };
    const onProgress = (p) => { progress.hidden = p >= 1; bar.style.width = `${Math.round(p * 100)}%`; if (p < 1) say('Loading the scanner (first time only)…'); };
    const finish = (result) => { if (done) return; done = true; stream?.getTracks().forEach((t) => t.stop()); document.removeEventListener('keydown', onKey); modal.remove(); resolve(result); };
    const onKey = (e) => { if (e.key === 'Escape') finish(null); };
    document.addEventListener('keydown', onKey);
    modal.querySelectorAll('[data-close]').forEach((b) => (b.onclick = () => finish(null)));
    const readImage = async (source, w, h) => {
      say('Reading the sheet…'); captureBtn.disabled = true;
      try {
        const worker = await getWorker(ocr, onProgress);
        say('Reading the sheet…');
        const r = await readLeadSheet(worker, crop(source, 0, 0, w, h, 1800));
        if (r.found.length) return finish({ ...r, text: r.lines.join('\n') });
        say('No lead details were recognised. Try again closer, with the sheet flat and the text sharp, or type the lead in.');
      } catch (err) { say(err.message || 'Could not read that image.'); }
      captureBtn.disabled = false;
    };
    modal.querySelector('#lead-scan-photo').onchange = async (e) => {
      const file = e.target.files?.[0]; e.target.value = '';
      if (!file) return;
      const img = await createImageBitmap(file);
      await readImage(img, img.width, img.height);
    };
    captureBtn.onclick = () => { if (video.videoWidth) readImage(video, video.videoWidth, video.videoHeight); };
    (async () => {
      if (!navigator.mediaDevices?.getUserMedia || !window.isSecureContext) { say('Live scanning needs the CRM to be opened over HTTPS. Take or choose a photo of the sheet instead.'); photoButton.classList.add('btn-primary'); return; }
      try { stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } }, audio: false }); }
      catch { say('The camera can’t be opened here (it may be blocked or in use). Take or choose a photo of the sheet instead.'); photoButton.classList.add('btn-primary'); return; }
      if (done) return stream.getTracks().forEach((t) => t.stop());
      video.srcObject = stream; view.hidden = false; await video.play().catch(() => {});
      say('Loading the scanner…');
      try { await getWorker(ocr, onProgress); } catch (err) { say(err.message); return; }
      captureBtn.hidden = false;
      say('Hold the sheet flat inside the frame and tap Capture.');
    })();
  });
}
