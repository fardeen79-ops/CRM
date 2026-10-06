import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseFront, splitName, findIdNumber } from '../public/eid-front.js';

test('reads the full name, ID number and dates from the front of a current card', () => {
  const ocr = [
    'UNITED ARAB EMIRATES',
    'FEDERAL AUTHORITY FOR IDENTITY, CITIZENSHIP, CUSTOMS & PORT SECURITY',
    'Resident Identity Card',
    'ID Number 784-1990-1234567-1',
    'iol oh uw ia', // Arabic name line read as noise
    'Name: Mohammed Rashid Saeed Abdulla',
    'Al Mansoori',
    'Date of Birth: 15/01/1990  Nationality: India',
    'Issuing Date: 20/06/2021  Expiry Date: 20/06/2031',
    'Sex: M',
  ].join('\n');
  const r = parseFront(ocr);
  assert.equal(r.found, true);
  assert.equal(r.fullName, 'Mohammed Rashid Saeed Abdulla Al Mansoori');
  assert.equal(r.eidNumber, '784-1990-1234567-1');
  assert.equal(r.birthDate, '1990-01-15');
  assert.equal(r.expiryDate, '2031-06-20');
  assert.deepEqual(splitName(r.fullName), { first_name: 'Mohammed', middle_name: 'Rashid Saeed Abdulla', last_name: 'Al Mansoori' });
});

test('copes with OCR look-alikes in the ID number and older card layouts', () => {
  assert.equal(findIdNumber('ID Number: 784 l99O 12345G7 1'), '784-1990-1234567-1');
  assert.equal(findIdNumber('7B4-1990-1234567-1'), '784-1990-1234567-1');
  assert.equal(findIdNumber('ID Number: 123-4567'), null);
  const old = parseFront(['Identity Card', 'ID Number: 784-1985-7710243-9', 'Name:', 'JOHN PAUL FERNANDES', 'Nationality: India'].join('\n'));
  assert.equal(old.fullName, 'John Paul Fernandes');
  assert.equal(old.eidNumber, '784-1985-7710243-9');
  assert.equal(old.expiryDate, null);
});

test('splits names, keeping family prefixes with the last name', () => {
  assert.deepEqual(splitName('Fatima Bint Khalid'), { first_name: 'Fatima', middle_name: '', last_name: 'Bint Khalid' });
  assert.deepEqual(splitName('Omar Abu Bakr'), { first_name: 'Omar', middle_name: '', last_name: 'Abu Bakr' });
  assert.deepEqual(splitName('Priya Lakshmi Nair'), { first_name: 'Priya', middle_name: 'Lakshmi', last_name: 'Nair' });
  // "Bin Rashid" (son of Rashid) is a patronymic, so it stays in the middle; Al Maktoum is the family name.
  assert.deepEqual(splitName('Ahmed Bin Rashid Al Maktoum'), { first_name: 'Ahmed', middle_name: 'Bin Rashid', last_name: 'Al Maktoum' });
});

test('does not mistake the card title or other fields for a name', () => {
  const r = parseFront(['UNITED ARAB EMIRATES', 'Name: Sara Ali', 'Nationality: United Arab Emirates'].join('\n'));
  assert.equal(r.fullName, 'Sara Ali');
  assert.equal(r.found, false); // no ID number
});
