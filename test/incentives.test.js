import { test } from 'node:test';
import assert from 'node:assert/strict';
import { countedLoan, topupShare } from '../src/incentives.js';

test('a top-up counts 70% of its incremental amount from the October 2026 cycle and 100% before', () => {
  const topUp = { product: 'personal_loan', personal_loan_type: 'top_up', full_loan_amount: 300000, incremental_amount: 100000, pl_disbursed_amount: 300000 };
  assert.equal(topupShare('2026-09'), 100);
  assert.equal(topupShare('2026-10'), 70);
  assert.equal(topupShare('2027-01'), 70);
  assert.deepEqual(countedLoan(topUp, '2026-09'), { kind: 'top_up', disbursed: 300000, counted: 100000 });
  assert.deepEqual(countedLoan(topUp, '2026-10'), { kind: 'top_up', disbursed: 300000, counted: 70000 });
  // Other loans are unaffected by the cycle.
  const fresh = { product: 'personal_loan', personal_loan_type: 'fresh', pl_disbursed_amount: 250000 };
  assert.deepEqual(countedLoan(fresh, '2026-09'), { kind: 'other', disbursed: 250000, counted: 250000 });
  const eib = { product: 'personal_loan', personal_loan_type: 'buy_out', pl_disbursed_amount: 200000, pl_buyouts: JSON.stringify([{ role: 'primary', kind: 'personal_loan', bank: 'Emirates Islamic', amount: 200000 }]) };
  assert.deepEqual(countedLoan(eib, '2026-09'), { kind: 'eib', disbursed: 200000, counted: 100000 });
  assert.equal(countedLoan({ product: 'credit_card' }, '2026-10'), null);
});
