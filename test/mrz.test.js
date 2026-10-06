import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkDigit, parseTd1, findMrz, toFormFields } from '../public/mrz.js';

// Builds a valid Emirates ID MRZ so tests do not depend on a real card.
function uaeMrz({ card = '123456789', eid = '784199012345671', dob = '900115', sex = 'M', expiry = '310620', surname = 'AL<MANSOORI', given = 'AHMED<KHALID' } = {}) {
  const l1 = `ILARE${card}${checkDigit(card)}${eid}`.padEnd(30, '<');
  const l2core = `${dob}${checkDigit(dob)}${sex}${expiry}${checkDigit(expiry)}ARE`.padEnd(29, '<');
  const composite = checkDigit(l1.slice(5, 30) + l2core.slice(0, 7) + l2core.slice(8, 15) + l2core.slice(18, 29));
  const l3 = `${surname}<<${given}`.padEnd(30, '<').slice(0, 30);
  return [l1, l2core + composite, l3];
}

test('check digits follow ICAO 9303 (7-3-1 weights)', () => {
  assert.equal(checkDigit('D23145890'), '7');
  assert.equal(checkDigit('740812'), '2');
  assert.equal(checkDigit('120415'), '9');
});

test('parses the ICAO TD1 specimen', () => {
  const r = parseTd1(['I<UTOD231458907<<<<<<<<<<<<<<<', '7408122F1204159UTO<<<<<<<<<<<6', 'ERIKSSON<<ANNA<MARIA<<<<<<<<<<']);
  assert.equal(r.valid, true);
  assert.equal(r.checks.composite, true);
  assert.equal(r.documentNumber, 'D23145890');
  assert.equal(r.surname, 'Eriksson');
  assert.deepEqual(r.givenNames, ['Anna', 'Maria']);
  assert.equal(r.birthDate, '1974-08-12');
  assert.equal(r.sex, 'F');
  assert.equal(r.eidNumber, null); // not an Emirates ID
});

test('reads the Emirates ID number and names from a UAE card', () => {
  const r = parseTd1(uaeMrz());
  assert.equal(r.valid, true);
  assert.equal(r.checks.composite, true);
  assert.equal(r.issuingState, 'ARE');
  assert.equal(r.eidNumber, '784-1990-1234567-1');
  assert.equal(r.birthDate, '1990-01-15');
  assert.equal(r.expiryDate, '2031-06-20');
  assert.deepEqual(toFormFields(r), { first_name: 'Ahmed', middle_name: 'Khalid', last_name: 'Al Mansoori', eid_number: '784-1990-1234567-1' });
  assert.equal(r.nameTruncated, false);
});

test('recovers from typical OCR mistakes and finds the MRZ among other card text', () => {
  const [l1, l2, l3] = uaeMrz();
  const noisy = [
    'Occupation: Engineer',
    'Employer: Emirates Airline',
    l1.replace('7841990', '784199O').replace(/<</, '« ').toLowerCase(),
    l2.replace('900115', '9OO1I5'),
    l3.replace(/<+$/, 'KKKKK'),
    'Issuing Place: Dubai',
  ].join('\n');
  const r = findMrz(noisy);
  assert.ok(r, 'MRZ found');
  assert.equal(r.valid, true);
  assert.equal(r.eidNumber, '784-1990-1234567-1');
  assert.equal(toFormFields(r).first_name, 'Ahmed');
});

test('flags bad reads and cut-short names', () => {
  const [l1, l2] = uaeMrz();
  const r = parseTd1([l1, l2.replace('900115', '900116'), 'ALMANSOORI<<MOHAMMED<RASHID<SAEED']);
  assert.equal(r.checks.birth, false);
  assert.equal(r.valid, false);
  assert.equal(r.nameTruncated, true);
  assert.equal(findMrz('nothing useful here\nat all'), null);
});

test('copes with OCR reading one < too many or too few in line 2', () => {
  const [l1, l2, l3] = uaeMrz();
  for (const bad of [l2.replace('<<<<', '<<<'), l2.replace('<<<<', '<<<<<')]) {
    const r = parseTd1([l1, bad, l3]);
    assert.equal(r.checks.composite, true, bad);
    assert.equal(r.valid, true);
  }
});
