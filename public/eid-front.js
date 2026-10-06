// Reads the printed English fields on the FRONT of an Emirates ID from OCR text: the full name
// (never cut short, unlike the back's machine-readable lines), the ID number and, where printed,
// date of birth and expiry. The front has no check digits for the name, so callers should confirm
// a read (e.g. two matching camera frames) and staff must check the result against the card.

// Field labels printed on current and older cards. Anything after one of these on a line is that
// field's value; a line that starts with one is never part of a wrapped name.
const LABELS = /\b(name|id\s*number|identity\s*number|card\s*number|date\s*of\s*birth|birth|nationality|sex|gender|issuing|issue\s*date|expiry|expiration|signature|occupation|employer|place)\b/i;
const NOT_NAME = /\b(united|arab|emirates|resident|identity|card|federal|authority|citizenship|customs|port|security|uae|icp)\b/i;
// Prefixes that belong with the family name (Al Mansoori, Bin Rashid, Abu Bakr).
const FAMILY_PREFIX = new Set(['al', 'el', 'bin', 'bint', 'abu', 'bu', 'ibn', 'ben', 'van', 'von', 'de', 'da', 'del', 'di', 'le', 'la']);

const FRONT_DIGIT = { O: '0', o: '0', Q: '0', D: '0', I: '1', l: '1', L: '1', i: '1', '|': '1', Z: '2', z: '2', S: '5', s: '5', G: '6', B: '8' };
const titleCaseName = (s) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Finds an Emirates ID number (784-YYYY-NNNNNNN-C), tolerating spaces and OCR look-alikes. */
export function findIdNumber(text) {
  // Groups of digit-like characters separated by dashes, spaces or dots.
  const re = /7\s*[8B]\s*[4A][\s\-.–—]*([0-9OoQDIlLi|ZzSsGB]{4})[\s\-.–—]*([0-9OoQDIlLi|ZzSsGB]{7})[\s\-.–—]*([0-9OoQDIlLi|ZzSsGB])/;
  const m = String(text).match(re);
  if (!m) return null;
  const digits = (m[1] + m[2] + m[3]).replace(/./g, (c) => FRONT_DIGIT[c] ?? c);
  if (!/^\d{12}$/.test(digits)) return null;
  return `784-${digits.slice(0, 4)}-${digits.slice(4, 11)}-${digits.slice(11)}`;
}

function findDate(lines, label) {
  for (const line of lines) {
    const at = line.search(label);
    if (at < 0) continue;
    // Read the date after the label: a line can hold two fields ("Issuing Date … Expiry Date …").
    const m = line.slice(at).match(/(\d{1,2})\s*[/.\-]\s*(\d{1,2})\s*[/.\-]\s*((?:19|20)\d{2})/);
    if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  return null;
}

// Keeps only name characters and drops OCR noise (stray 1–2 letter fragments that are not prefixes).
function cleanName(raw) {
  const words = raw
    .replace(/[^A-Za-z' -]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .filter((w, i, all) => w.length > 2 || FAMILY_PREFIX.has(w.toLowerCase()) || (i > 0 && i < all.length - 1));
  return words.join(' ');
}

/** Pulls the full English name from the line labelled "Name", joining a wrapped second line. */
export function findName(lines) {
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(/\bname\b\s*[:.;]?\s*(.*)$/i);
    if (!m) continue;
    let name = cleanName(m[1]);
    // Long names wrap: take the next line too when it is only letters and not another field.
    const next = lines[i + 1];
    if (next && !LABELS.test(next) && !NOT_NAME.test(next) && /^[A-Za-z][A-Za-z' -]{2,}$/.test(next.trim())) {
      name = `${name} ${cleanName(next)}`.trim();
    }
    // A label with nothing usable after it: the name may be on the following line.
    if (name.split(' ').length < 2 && next && !LABELS.test(next) && !NOT_NAME.test(next)) {
      name = cleanName(next);
    }
    if (name.split(' ').length >= 2) return titleCaseName(name);
  }
  return null;
}

/** Splits a full name into first / middle / last, keeping family prefixes with the last name. */
export function splitName(full) {
  const words = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return { first_name: words[0] || '', middle_name: '', last_name: '' };
  let lastStart = words.length - 1;
  while (lastStart > 1 && FAMILY_PREFIX.has(words[lastStart - 1].toLowerCase())) lastStart--;
  return {
    first_name: words[0],
    middle_name: words.slice(1, lastStart).join(' '),
    last_name: words.slice(lastStart).join(' '),
  };
}

/** Parses OCR text from the front of the card. */
export function parseFront(text) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const fullName = findName(lines);
  const eidNumber = findIdNumber(text);
  return {
    side: 'front',
    fullName,
    eidNumber,
    birthDate: findDate(lines, /birth/i),
    expiryDate: findDate(lines, /expir/i),
    found: Boolean(fullName && eidNumber),
  };
}
