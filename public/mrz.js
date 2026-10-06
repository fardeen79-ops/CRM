// Reads the machine-readable zone (MRZ) on the back of an Emirates ID: three lines of 30
// characters in the ICAO 9303 "TD1" layout. Works on raw OCR text, fixing the usual OCR
// confusions and using the MRZ check digits to tell a good read from a bad one.

const WEIGHTS = [7, 3, 1];
const charValue = (c) => (c === '<' ? 0 : /\d/.test(c) ? Number(c) : c.charCodeAt(0) - 55);
export const checkDigit = (s) => String([...s].reduce((sum, c, i) => sum + charValue(c) * WEIGHTS[i % 3], 0) % 10);

// OCR confusions between look-alike characters, fixed by what the field is allowed to contain.
const TO_DIGIT = { O: '0', Q: '0', D: '0', U: '0', I: '1', L: '1', T: '1', Z: '2', S: '5', G: '6', B: '8' };
const TO_ALPHA = { 0: 'O', 1: 'I', 2: 'Z', 5: 'S', 6: 'G', 8: 'B' };
const digits = (s) => [...s].map((c) => TO_DIGIT[c] ?? c).join('');
const alpha = (s) => [...s].map((c) => TO_ALPHA[c] ?? c).join('');

/** Cleans one OCR line into MRZ characters (A–Z, 0–9 and the < filler). */
export function normalizeLine(line) {
  return String(line)
    .toUpperCase()
    .replace(/[«‹]/g, '<<')
    .replace(/[\s|]/g, '')
    .replace(/[^A-Z0-9<]/g, '<');
}

const fit = (line) => (line.length >= 30 ? line.slice(0, 30) : line + '<'.repeat(30 - line.length));

function parseDate(yymmdd, { future = false } = {}) {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const yy = Number(yymmdd.slice(0, 2));
  const mm = Number(yymmdd.slice(2, 4));
  const dd = Number(yymmdd.slice(4, 6));
  if (mm < 1 || mm > 12 || dd < 1 || dd > 31) return null;
  // Birth dates are in the past; expiry dates are at most ~20 years ahead.
  const nowYY = new Date().getFullYear() % 100;
  const century = future ? (yy <= nowYY + 30 ? 2000 : 1900) : (yy <= nowYY ? 2000 : 1900);
  return `${century + yy}-${yymmdd.slice(2, 4)}-${yymmdd.slice(4, 6)}`;
}

const titleCase = (s) => s.toLowerCase().replace(/(^|[\s'-])([a-z])/g, (_, a, b) => a + b.toUpperCase());

/** Parses three TD1 lines. Returns the fields plus which check digits passed. */
// OCR often reads one < too many or too few in a run of filler. Line 2 ends with the composite
// check digit, so rebuild it by position: 18 fixed characters, 11 optional, then the digit.
function fitLine2(raw) {
  if (raw.length === 30 || raw.length < 20) return fit(raw);
  const optional = raw.slice(18, -1);
  return raw.slice(0, 18) + (/^<*$/.test(optional) ? '<'.repeat(11) : optional.padEnd(11, '<').slice(0, 11)) + raw.slice(-1);
}

// OCR sometimes reads the < filler after the name as K or C. Only treat those letters as filler when
// they come after a real < or form a long run at the very end, so names ending in K, C or S
// (Malik, Isaac, Thomas) keep their last letter.
function cleanNameLine(line) {
  return alpha(line)
    .replace(/[KC]{4,}(?=<*$)/, (m) => '<'.repeat(m.length))
    .replace(/<[<KC]*$/, (m) => '<'.repeat(m.length));
}

export function parseTd1(lines) {
  const [r1, r2, r3] = lines.map(normalizeLine);
  let l1 = fit(r1);
  let l2 = fitLine2(r2);
  let l3 = fit(r3);
  // Fix field types before checking: numbers where numbers belong, letters where letters belong.
  l1 = alpha(l1.slice(0, 5)) + l1.slice(5, 14) + digits(l1[14]) + l1.slice(15);
  l2 = digits(l2.slice(0, 7)) + l2[7].replace('H', 'M').replace('P', 'F') + digits(l2.slice(8, 15)) + alpha(l2.slice(15, 18)) + l2.slice(18, 29) + digits(l2[29]);
  // Trailing filler in the name line is often read as K or S; names never end in a run of them.
  l3 = cleanNameLine(l3);

  const docNumber = l1.slice(5, 14);
  const optional1 = l1.slice(15, 30);
  const dob = l2.slice(0, 6);
  const expiry = l2.slice(8, 14);
  const checks = {
    document: checkDigit(docNumber) === l1[14],
    birth: checkDigit(dob) === l2[6],
    expiry: checkDigit(expiry) === l2[14],
    composite: checkDigit(l1.slice(5, 30) + l2.slice(0, 7) + l2.slice(8, 15) + l2.slice(18, 29)) === l2[29],
  };

  // The Emirates ID number (784-YYYY-NNNNNNN-C) sits in the first optional data field.
  const eidDigits = digits(optional1.replace(/<+$/, ''));
  const eid = /^784\d{12}$/.test(eidDigits)
    ? `${eidDigits.slice(0, 3)}-${eidDigits.slice(3, 7)}-${eidDigits.slice(7, 14)}-${eidDigits.slice(14)}`
    : null;

  // Name line: SURNAME<<GIVEN<NAMES, padded with <.
  const split = l3.indexOf('<<');
  const surnamePart = split >= 0 ? l3.slice(0, split) : l3;
  const givenPart = split >= 0 ? l3.slice(split + 2) : '';
  const surname = titleCase(surnamePart.replace(/</g, ' ').trim());
  const given = givenPart.split('<').filter(Boolean).map(titleCase);

  return {
    documentCode: l1.slice(0, 2).replace(/</g, ''),
    issuingState: l1.slice(2, 5),
    documentNumber: docNumber.replace(/</g, ''),
    eidNumber: eid,
    birthDate: parseDate(dob),
    sex: { M: 'M', F: 'F' }[l2[7]] || null,
    expiryDate: parseDate(expiry, { future: true }),
    nationality: l2.slice(15, 18).replace(/</g, ''),
    surname,
    givenNames: given,
    // A full name line with no filler at the end means the name was cut to fit the card.
    nameTruncated: !l3.endsWith('<'),
    checks,
    valid: checks.document && checks.birth && checks.expiry,
    lines: [l1, l2, l3],
  };
}

/**
 * Finds the MRZ in OCR output (which may also contain other text from the card) and parses it.
 * Tries every run of three candidate lines and keeps the read with the most passing checks.
 */
export function findMrz(text) {
  const candidates = String(text)
    .split(/\r?\n/)
    .map(normalizeLine)
    .filter((l) => l.length >= 24 && l.length <= 36 && (
      (l.match(/</g) || []).length >= 2 // name and data lines carry < filler
      || /^[IAC][A-Z<1]?[A-Z]{3}/.test(l) // line 1 can be all characters (e.g. ILARE + card + 784…)
      || /^\d{6}.[MFH<P]\d{6}/.test(l) // line 2 starts with birth date, sex, expiry
    ));
  let best = null;
  for (let i = 0; i + 2 < candidates.length; i++) {
    const result = parseTd1(candidates.slice(i, i + 3));
    const score = Object.values(result.checks).filter(Boolean).length + (result.eidNumber ? 1 : 0);
    if (!best || score > best.score) best = { ...result, score };
  }
  return best;
}

/** Splits a parsed MRZ into the CRM's first / middle / last name fields. */
export function toFormFields(mrz) {
  return {
    first_name: mrz.givenNames[0] || '',
    middle_name: mrz.givenNames.slice(1).join(' '),
    last_name: mrz.surname,
    eid_number: mrz.eidNumber || '',
  };
}
