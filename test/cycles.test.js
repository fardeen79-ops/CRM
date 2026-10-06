import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cycleOf, cycleRange, cycleLabel, parseCycle, shiftCycle, uaeDay } from '../src/cycles.js';

test('a sales cycle runs from the 21st to the 20th and is named after the month it ends in', () => {
  assert.equal(cycleOf('2026-05-20'), '2026-05');
  assert.equal(cycleOf('2026-05-21'), '2026-06');
  assert.equal(cycleOf('2026-06-20'), '2026-06');
  assert.equal(cycleOf('2026-12-21'), '2027-01');
  assert.deepEqual(cycleRange('2026-06'), { start: '2026-05-21', end: '2026-06-20' });
  assert.deepEqual(cycleRange('2027-01'), { start: '2026-12-21', end: '2027-01-20' });
  assert.equal(cycleLabel('2026-06'), 'June 2026');
  assert.equal(shiftCycle('2026-01', -1), '2025-12');
  assert.equal(shiftCycle('2026-12', 1), '2027-01');
});

test('cycle dates use UAE time', () => {
  // 20 June 21:30 UTC is already 21 June in the UAE, so it belongs to the July cycle.
  const ms = Date.parse('2026-06-20T21:30:00Z');
  assert.equal(uaeDay(ms), '2026-06-21');
  assert.equal(cycleOf(uaeDay(ms)), '2026-07');
});

test('cycles typed in a spreadsheet', () => {
  for (const v of ['Jun 2026', 'June 2026', '06/2026', '6-2026', '2026-06']) assert.equal(parseCycle(v), '2026-06');
  assert.throws(() => parseCycle('Juny 2026'));
  assert.throws(() => parseCycle('13/2026'));
});
