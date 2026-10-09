// Verification TAT: two working days from the sourcing date, Sunday being the day off.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { verificationDue, verificationTat, workingDaysBetween } from '../src/cases.js';

test('due two working days after sourcing, skipping Sunday', () => {
  assert.equal(verificationDue('2026-10-08'), '2026-10-10'); // Thu → Sat
  assert.equal(verificationDue('2026-10-09'), '2026-10-12'); // Fri → Sat, (Sun off), Mon
  assert.equal(verificationDue('2026-10-10'), '2026-10-13'); // Sat → Mon, Tue
  assert.equal(verificationDue('2026-10-11'), '2026-10-13'); // sourced on a Sunday → Mon, Tue
  assert.equal(verificationDue(null), null);
  assert.equal(workingDaysBetween('2026-10-10', '2026-10-13'), 2);
});

test('open files are due or overdue; verified files met or missed it', () => {
  const file = { sourcing_date: '2026-10-09', status: 'pending_verification', case_status: 'sent_to_check' };
  assert.deepEqual(verificationTat(file, '2026-10-09'), { due: '2026-10-12', state: 'due', days_left: 2 });
  assert.deepEqual(verificationTat(file, '2026-10-12'), { due: '2026-10-12', state: 'due', days_left: 0 });
  assert.deepEqual(verificationTat(file, '2026-10-14'), { due: '2026-10-12', state: 'overdue', days_over: 2 });
  // Verified at 23:30 UTC on the 11th is the 12th in the UAE: on time.
  assert.equal(verificationTat({ ...file, verified_at: '2026-10-11T23:30:00.000Z' }).state, 'met');
  assert.deepEqual(verificationTat({ ...file, verified_at: '2026-10-13T08:00:00.000Z' }), { due: '2026-10-12', state: 'missed', verified_on: '2026-10-13', days_over: 1 });
  assert.equal(verificationTat({ ...file, status: 'rejected' }).state, 'closed');
  // A file without a sourcing date runs from the day it was created.
  assert.equal(verificationTat({ created_at: '2026-10-08T06:00:00.000Z', status: 'pending_verification' }, '2026-10-09').due, '2026-10-10');
});
