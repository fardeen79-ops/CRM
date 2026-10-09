// Reading a lead sheet's text into lead fields: labelled lines, then whatever can be recognised.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseLeadSheet } from '../public/lead-scan.js';

test('a labelled lead sheet', () => {
  const { fields, found } = parseLeadSheet(`LEAD SHEET          Date: 09/10/2026
Name: Khalid Al Mansoor
Mobile: 050 212 3344
Email: khalid.m@example.com
Company: Emaar Properties
Salary: AED 14,000
Product: Credit card
Source: Referral
City: Dubai
Follow up: 12/10/2026
Remarks: Wants a travel card with lounge access`);
  assert.deepEqual(fields, { first_name: 'Khalid', middle_name: 'Al', last_name: 'Mansoor', phone: '+971 50 212 3344', email: 'khalid.m@example.com', company_name: 'Emaar Properties', salary: 14000, product: 'credit_card', source: 'Referral', city: 'Dubai', follow_up_at: '2026-10-12', notes: 'Wants a travel card with lounge access' });
  assert.deepEqual(found, ['first_name', 'phone', 'email', 'company_name', 'salary', 'product']);
});

test('an unlabelled sheet: the number, email, salary and product are picked out, the first name-like line is the customer', () => {
  const { fields } = parseLeadSheet(`Lina Saeed
+971 55 787 1122
lina@dewa.ae
DEWA, salary AED 9500
interested in personal loan buy-out
call after 5pm`);
  assert.deepEqual([fields.first_name, fields.last_name, fields.phone, fields.email, fields.salary, fields.product, fields.notes], ['Lina', 'Saeed', '+971 55 787 1122', 'lina@dewa.ae', 9500, 'personal_loan', 'call after 5pm']);
});

test('OCR slips in a mobile number are repaired, and nothing is invented', () => {
  assert.equal(parseLeadSheet('Mob: O5O 4l1 22O1').fields.phone, '+971 50 411 2201');
  assert.equal(parseLeadSheet('Tel: 971 50 411 2201').fields.phone, '+971 50 411 2201');
  const empty = parseLeadSheet('LEAD SHEET\nSignature');
  assert.deepEqual([empty.found, empty.fields.first_name], [[], undefined]);
});
