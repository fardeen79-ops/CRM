// Reading the customer-details page of an application form into case form fields.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseApplicationForm, dateOf, splitFullName } from '../public/form-scan.js';

test('a labelled customer-details page fills every field the CRM has', () => {
  const { fields, found } = parseApplicationForm(`APPLICATION FORM            Page 1
CUSTOMER DETAILS
Title: Mr
Name of the applicant: Mohammed Rashid Al Mansoori
Mobile No: 050 765 4321
Alternate phone: 04 123 4567
Email ID: m.rashid@example.com
Employment type: Salaried
Employer name: Al Futtaim Motors
Designation: Senior Accountant      Department: Finance
Date of joining: 15/03/2019
Net salary (AED): 28,000
Salary transfer bank: Emirates NBD
City: Dubai
Residential address: Al Barsha 1, Building 14, Flat 302
Application No: APP-55012
Bidaya ID: BID-10231`);
  assert.deepEqual(fields, {
    salutation: 'Mr', first_name: 'Mohammed', middle_name: 'Rashid', last_name: 'Al Mansoori',
    phone: '+971 50 765 4321', alt_phone: '041234567', email: 'm.rashid@example.com', customer_type: 'salaried',
    company_name: 'Al Futtaim Motors', designation: 'Senior Accountant', department: 'Finance', customer_doj: '2019-03-15',
    salary: 28000, salary_bank: 'Emirates NBD', city: 'Dubai', address: 'Al Barsha 1, Building 14, Flat 302', app_id: 'APP-55012', bidaya_id: 'BID-10231',
  });
  assert.equal(found.length, 18);
});

test('OCR slips in numbers are repaired, dates in words are read, and unlabelled text still yields what it can', () => {
  const { fields } = parseApplicationForm(`Customer details
Fatima Sheikh
Mobile : O5O 212 33l4
fatima.s@example.com
Monthly income AED 36,000
Self-employed
Joining date: 1 June 2021`);
  assert.equal(fields.first_name, 'Fatima'); assert.equal(fields.last_name, 'Sheikh');
  assert.equal(fields.phone, '+971 50 212 3314');
  assert.equal(fields.email, 'fatima.s@example.com');
  assert.equal(fields.salary, 36000);
  assert.equal(fields.customer_type, 'self_employed');
  assert.equal(fields.customer_doj, '2021-06-01');
  assert.equal(dateOf('2024-02-29'), '2024-02-29');
  assert.equal(dateOf('March 5, 2020'), '2020-03-05');
  assert.deepEqual(splitFullName('Dr. Aisha Khan'), { salutation: 'Dr', first_name: 'Aisha', last_name: 'Khan' });
});

test('two columns read as one line with single spaces are still told apart', () => {
  const { fields } = parseApplicationForm(`Title: Mr Name of the applicant: Mohammed Rashid Al Mansoori
Designation: Senior Accountant Department: Finance
Date of joining: 15/03/2019 Net salary (AED): 28,000
Salary transfer bank: Emirates NBD City: Dubai`);
  assert.deepEqual(fields, { salutation: 'Mr', first_name: 'Mohammed', middle_name: 'Rashid', last_name: 'Al Mansoori', designation: 'Senior Accountant', department: 'Finance', customer_doj: '2019-03-15', salary: 28000, salary_bank: 'Emirates NBD', city: 'Dubai' });
});

test('a page with nothing recognisable fills nothing', () => {
  const { fields, found } = parseApplicationForm('FOR BANK USE ONLY\nSignature\nPage 3');
  assert.deepEqual(fields, {}); assert.equal(found.length, 0);
});
