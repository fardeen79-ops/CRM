// The stage log: a file's history replayed into stages with how long each took.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { caseStages, verificationDue } from '../src/cases.js';
import { openDb } from '../src/db.js';
import { addHoliday, loadHolidays, removeHoliday } from '../src/holidays.js';

const at = (h) => new Date(Date.UTC(2026, 9, 5, 6) + h * 36e5).toISOString();
const ev = (id, h, type, extra = {}) => ({ id, created_at: at(h), type, user_name: 'Someone', ...extra });

test('stages, time at each and the slowest; returning to a stage adds to it', () => {
  const events = [
    ev(1, 0, 'created', { to_status: 'pending_verification' }),
    ev(2, 3, 'start_verification', { to_status: 'in_verification' }),
    ev(3, 5, 'mark_incomplete', { to_status: 'incomplete' }),
    ev(4, 30, 'reverify', { to_status: 'pending_verification' }),
    ev(5, 31, 'start_verification', { to_status: 'in_verification' }),
    ev(6, 32, 'complete', { to_status: 'completed' }),
    ev(7, 40, 'case_status', { detail: 'applicant_review' }),
    ev(8, 50, 'case_status', { detail: 'completed' }),
    ev(9, 60, 'log_call'),
  ];
  const s = caseStages({ created_at: at(0) }, events.reverse());
  assert.deepEqual(s.rows.map((r) => [r.stage, r.ms / 36e5]), [
    ['pending_verification', 3], ['in_verification', 2], ['incomplete', 25], ['pending_verification', 1],
    ['in_verification', 1], ['with_bank', 8], ['applicant_review', 10],
  ]);
  assert.equal(s.longest, 'incomplete');
  assert.equal(s.totals.find((t) => t.stage === 'pending_verification').visits, 2);
  assert.equal(s.total_ms / 36e5, 50);
  assert.equal(s.closed.outcome, 'Case completed');
});

test('an open file runs to now; approval requests open the approval stage', () => {
  const s = caseStages({ created_at: at(0) }, [
    ev(1, 0, 'created', { to_status: 'pending_verification' }),
    ev(2, 1, 'card_approval_requested'),
    ev(3, 4, 'approve_card', { to_status: 'pending_verification' }),
  ], at(10));
  assert.deepEqual(s.rows.map((r) => [r.stage, r.ms / 36e5, Boolean(r.current)]), [
    ['pending_verification', 1, false], ['awaiting_approval', 3, false], ['pending_verification', 6, true],
  ]);
  assert.equal(s.closed, null);
});

test('public holidays are days off for the TAT', () => {
  const db = openDb(':memory:');
  loadHolidays(db);
  const mis = { id: null, role: 'mis' };
  assert.equal(verificationDue('2026-12-01'), '2026-12-03');
  addHoliday(db, mis, { day: '2026-12-02', until: '2026-12-03', name: 'National Day' });
  assert.equal(verificationDue('2026-12-01'), '2026-12-05'); // Wed, Thu off → Fri, Sat
  assert.throws(() => addHoliday(db, { role: 'sales' }, { day: '2026-12-04', name: 'X' }), /MIS/);
  removeHoliday(db, mis, '2026-12-02');
  removeHoliday(db, mis, '2026-12-03');
  assert.equal(verificationDue('2026-12-01'), '2026-12-03');
});
