// Scanning the customer-details page of the bank's application form: the sales person holds the
// tab's camera over the page (or picks a photo), the text is read on the device with the same OCR
// engine as the other scanners, and every labelled detail the page carries fills the matching field
// of the case form for checking. Nothing leaves the device or is stored.
import { openSheetScanner } from './lead-scan.js';
import { splitName } from './eid-front.js';

const FORM_SALUTATIONS = ['Mr', 'Mrs', 'Ms', 'Dr'];
// Labels as they appear on application forms, matched against the text before the colon.
const FORM_LABEL_RES = {
  salutation: /^(title|salutation)\b/i,
  name: /^((customer|applicant|client|full|primary\s*applicant)['’]?s?\s*)?(full\s*)?name(\s*(of\s*(the\s*)?(applicant|customer)|as\s*per\s*(passport|emirates\s*id|id)))?\b/i,
  first_name: /^(first|given)\s*name/i,
  middle_name: /^middle\s*name/i,
  last_name: /^(last|sur|family)\s*name/i,
  phone: /^(mobile|mob|cell|phone|contact)(\s*(no|number|#|\(mobile\)))?\s*$/i,
  alt_phone: /^((alternate|alternative|alt|other|second|home|office|work|landline)\s*(mobile|phone|number|no|contact)?|(mobile|phone)\s*(no|number)?\s*2)\b/i,
  email: /^(e-?mail)(\s*(id|address))?\b/i,
  customer_type: /^(customer|applicant|employment|income)\s*(type|status)\b|^(type\s*of\s*(customer|applicant|employment)|employment)\b/i,
  company_name: /^(company|employer|organi[sz]ation|firm|business)(\s*name)?\b|^(name\s*of\s*(the\s*)?(employer|company|organi[sz]ation))\b/i,
  designation: /^(designation|job\s*title|position|occupation|profession|title\s*of\s*(the\s*)?job)\b/i,
  department: /^(department|dept)\b/i,
  customer_doj: /^(date\s*of\s*joining|joining\s*date|doj|employed\s*since|service\s*since|with\s*(the\s*)?(company|employer)\s*since)\b/i,
  salary_bank: /^((salary|salary\s*transfer|salary\s*account|income)\s*bank|bank(\s*name)?(\s*\(salary\))?|bank\s*where\s*salary\s*is\s*(credited|transferred))\b/i,
  salary: /^(?!.*bank)((net|gross|total|monthly|basic)\s*)*(salary|income|pay)(\s*(per\s*month|\(aed\)|aed|in\s*aed))?\b/i,
  city: /^(city|emirate|town)\b/i,
  address: /^(residential\s*|home\s*|residence\s*|current\s*)?(address|p\.?o\.?\s*box)\b/i,
  app_id: /^(app(lication)?\s*(id|no|number|ref|reference)?)\b/i,
  bidaya_id: /^(bidaya)(\s*(id|no|number|ref))?\b/i,
};
const FORM_NOISE = /^(application\s*form|customer\s*details|personal\s*details|employment\s*details|contact\s*details|page\b|date\b|signature|for\s*bank\s*use|emirates\s*nbd|derby|section\b)/i;

const digitsOf = (s) => String(s).replace(/[oO]/g, '0').replace(/[lI|]/g, '1').replace(/[sS]/g, '5').replace(/[^\d+]/g, '');
/** A UAE mobile number in the CRM's +971 5x xxx xxxx layout, repairing the digits OCR confuses. */
export function phoneOf(s) {
  const m = String(s).match(/(\+?\s*9?7?1?[\s-]*0?5[\d\s\-oOlI]{8,})|(\+?971[\d\s-]{8,})/);
  if (!m) return null;
  let d = digitsOf(m[0]);
  if (d.startsWith('+971')) d = '0' + d.slice(4);
  else if (d.startsWith('971')) d = '0' + d.slice(3);
  else if (d.startsWith('5') && d.length === 9) d = '0' + d;
  return /^05\d{8}$/.test(d) ? `+971 ${d.slice(1, 3)} ${d.slice(3, 6)} ${d.slice(6)}` : null;
}
/** Any phone number on the line (landlines included), digits only with a leading + kept. */
const anyPhone = (s) => { const m = String(s).match(/\+?[\d][\d\s\-oOlI]{6,}/); if (!m) return null; const d = digitsOf(m[0]); return d.replace(/\D/g, '').length >= 7 ? d : null; };
const emailOf = (s) => (String(s).match(/[\w.+-]+@[\w-]+\.[\w.-]+/) || [null])[0];
export function salaryOf(s) {
  const m = String(s).replace(/,/g, '').match(/(\d{4,6})(?:\s*(k|000))?/i);
  if (!m) return null;
  let n = Number(m[1]); if (/k/i.test(m[2] || '')) n *= 1000;
  return n >= 1000 && n <= 500000 ? n : null;
}
export function dateOf(s) {
  const t = String(s);
  let m = t.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = t.match(/(\d{1,2})[\/.\- ](\d{1,2})[\/.\- ](\d{2,4})/);
  if (m) { const y = m[3].length === 2 ? `20${m[3]}` : m[3]; return `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`; }
  const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  m = t.match(/(\d{1,2})\s*([A-Za-z]{3,9})[\s,.-]*(\d{4})/) || t.match(/([A-Za-z]{3,9})\s*(\d{1,2})[\s,.-]*(\d{4})/);
  if (m) {
    const [day, mon] = /^\d/.test(m[1]) ? [m[1], m[2]] : [m[2], m[1]];
    const i = MONTHS.indexOf(mon.slice(0, 3).toLowerCase());
    if (i >= 0) return `${m[3]}-${String(i + 1).padStart(2, '0')}-${day.padStart(2, '0')}`;
  }
  return null;
}
const formTitleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])\S/g, (c) => c.toUpperCase());
const tidy = (s) => s.replace(/[.,;:]+$/, '').trim();
const salutationOf = (s) => { const w = String(s).replace(/\./g, '').trim().toLowerCase(); return FORM_SALUTATIONS.find((x) => x.toLowerCase() === w) || null; };
const customerTypeOf = (s) => (/self/i.test(s) ? 'self_employed' : /salar|employ/i.test(s) ? 'salaried' : null);
const nameLike = (s) => /^[A-Za-z][A-Za-z'.\- ]{2,60}$/.test(s.trim()) && s.trim().split(/\s+/).length >= 2 && !FORM_NOISE.test(s);

/** Splits a full name into first, middle and last, with a leading salutation taken off. */
export function splitFullName(value) {
  const out = {};
  const parts = value.split(/\s+/).filter((p) => /[A-Za-z]/.test(p));
  if (parts.length && salutationOf(parts[0])) out.salutation = salutationOf(parts.shift());
  if (!parts.length) return out;
  const split = splitName(parts.join(' '));
  for (const k of ['first_name', 'middle_name', 'last_name']) if (split[k]) out[k] = formTitleCase(split[k]);
  return out;
}

/**
 * Reads the OCR text of the customer-details page into case form fields. Labelled lines
 * ("Mobile: 050…", "Designation: Accountant") win; a mobile number, an email, a salary and a
 * name-like line are picked out of unlabelled text. Returns { fields, lines, found }.
 */
export function parseApplicationForm(text) {
  // Column gaps (runs of spaces or tabs) are kept so two details on one line can be told apart.
  const lines = String(text || '').split(/\r?\n/).map((l) => l.replace(/\t/g, '   ').replace(/ {2,}/g, '   ').trim()).filter(Boolean);
  const fields = {};
  const knownLabel = (label) => Object.keys(FORM_LABEL_RES).find((k) => FORM_LABEL_RES[k].test(label.trim())) || null;
  const leftover = [];
  const set = (k, v) => { if (v !== null && v !== undefined && v !== '' && fields[k] == null) fields[k] = v; };
  for (const line of lines) {
    // A line can carry two labelled details ("Designation: Accountant   Department: Finance").
    const LABELLED = /^([A-Za-z][A-Za-z\s\/().'’-]{1,40}?)\s*[:\-–=]\s*(.*)$/;
    const pieces = [];
    for (const piece of line.split(/\s{2,}/)) {
      if (pieces.length && !LABELLED.test(piece)) pieces[pieces.length - 1] += ` ${piece}`; else pieces.push(piece);
    }
    const pairs = [];
    for (const piece of pieces) {
      const m = piece.replace(/\s+/g, ' ').match(LABELLED);
      if (!m) continue;
      // Single-spaced columns: the value runs into the next label ("Senior Accountant Department: Finance"),
      // so every word boundary in the value is tried as the start of a known label.
      let rest = m[2]; let label = m[1];
      for (;;) {
        let cut = null;
        for (const at of [...rest.matchAll(/\s(?=[A-Za-z])/g)].map((x) => x.index)) {
          const inner = rest.slice(at + 1).match(/^([A-Za-z][A-Za-z ().]{1,30}?)\s*[:=]\s*/);
          if (inner && knownLabel(inner[1])) { cut = { at, label: inner[1], after: at + 1 + inner[0].length }; break; }
        }
        if (!cut) { pairs.push([null, label, rest]); break; }
        pairs.push([null, label, rest.slice(0, cut.at)]);
        label = cut.label; rest = rest.slice(cut.after);
      }
    }
    if (!pairs.length) { leftover.push(line.replace(/\s+/g, ' ')); continue; }
    let any = false;
    for (const [, label, raw] of pairs) {
      const key = knownLabel(label);
      if (!key) continue;
      any = true;
      const value = tidy(raw);
      if (!value) continue;
      if (key === 'name') Object.entries(splitFullName(value)).forEach(([k, v]) => set(k, v));
      else if (key === 'first_name' || key === 'middle_name' || key === 'last_name') set(key, formTitleCase(value));
      else if (key === 'salutation') set('salutation', salutationOf(value));
      else if (key === 'phone') set('phone', phoneOf(value));
      else if (key === 'alt_phone') set('alt_phone', phoneOf(value) || anyPhone(value));
      else if (key === 'email') set('email', (emailOf(value) || '').toLowerCase());
      else if (key === 'customer_type') set('customer_type', customerTypeOf(value));
      else if (key === 'salary') set('salary', salaryOf(value));
      else if (key === 'customer_doj') set('customer_doj', dateOf(value));
      else if (key === 'app_id' || key === 'bidaya_id') set(key, value.replace(/\s+/g, ''));
      else set(key, value);
    }
    if (!any) leftover.push(line.replace(/\s+/g, ' '));
  }
  for (const line of leftover) {
    if (FORM_NOISE.test(line)) continue;
    let used = false;
    if (!fields.phone) { const p = phoneOf(line); if (p) { set('phone', p); used = true; } }
    if (!fields.email) { const e = emailOf(line); if (e) { set('email', e.toLowerCase()); used = true; } }
    if (!fields.salary && /aed|salary|income/i.test(line) && !phoneOf(line)) { const n = salaryOf(line); if (n) { set('salary', n); used = true; } }
    if (!fields.customer_type && /self[\s-]*employed|salaried/i.test(line)) { set('customer_type', customerTypeOf(line)); used = true; }
    if (!fields.first_name && !used && nameLike(line)) Object.entries(splitFullName(line)).forEach(([k, v]) => set(k, v));
  }
  const found = Object.keys(fields);
  return { fields, lines, found };
}

async function readApplicationForm(worker, canvas) {
  await worker.setParameters({ tessedit_char_whitelist: '', tessedit_pageseg_mode: '6' });
  let r = parseApplicationForm((await worker.recognize(canvas)).data.text);
  if (r.found.length < 3) {
    await worker.setParameters({ tessedit_pageseg_mode: '4' });
    const again = parseApplicationForm((await worker.recognize(canvas)).data.text);
    if (again.found.length > r.found.length) r = again;
  }
  return r;
}

/** Opens the application form scanner. Resolves with { fields, found, text } or null if cancelled. */
export function openFormScanner(ocr) {
  return openSheetScanner(ocr, {
    title: 'Scan the application form', hint: 'Fill the frame with the customer-details page, flat and well lit, then capture. The image stays on this device.',
    read: readApplicationForm, nothing: 'No customer details were recognised. Try again closer, with the page flat and the text sharp, or type the details in.',
  });
}
