// What the bank pays the agency for each product sold: the revenue behind every file.
//
// Cards pay a flat amount by category (one card, noon One, has its own rate). Personal loans pay a
// percentage of the amount disbursed, lower when the loan being bought out is from Emirates Islamic.
// Auto loans pay a percentage of the amount, by new or used car. MIS or a business head can replace
// any rate from the Bulk upload page (Payout payoutRates); until then these built-in rates apply.
import { caseProducts, includesCard } from './cases.js';
import { cardProducts } from './credit-cards.js';

/** Built-in rates. Keys are what the upload uses; amounts in AED, percentages as plain numbers (3 = 3%). */
export const PAYOUT_DEFAULTS = {
  'card:Mass': 1400,
  'card:Premium': 2000,
  'card:Super Premium': 2600,
  'card_name:noon One Visa Credit Card': 1100,
  personal_loan_pct: 3,
  personal_loan_eib_buyout_pct: 1.5,
  auto_loan_new_pct: 0.7,
  auto_loan_used_pct: 1.75,
};
export const PAYOUT_KEYS = Object.keys(PAYOUT_DEFAULTS);
export const PAYOUT_LABELS = {
  'card:Mass': 'Mass card (AED per card)',
  'card:Premium': 'Premium card (AED per card)',
  'card:Super Premium': 'Super Premium card (AED per card)',
  'card_name:noon One Visa Credit Card': 'noon One Visa card (AED per card)',
  personal_loan_pct: 'Personal loan (% of amount)',
  personal_loan_eib_buyout_pct: 'Personal loan buying out Emirates Islamic (% of amount)',
  auto_loan_new_pct: 'Auto loan, new car (% of amount)',
  auto_loan_used_pct: 'Auto loan, used car (% of amount)',
};

// Who may see what a file earns: managers and above, never sales staff or processors.
export const PAYOUT_ROLES = ['team_leader', 'asm', 'sales_manager', 'mis', 'business_head', 'governance'];

let payoutRates = { ...PAYOUT_DEFAULTS };
let payoutSrc = 'built_in';

/** Uses uploaded rates where there are any, built-in rates for the rest. Call on start and after an upload. */
export function loadPayoutRules(db) {
  payoutRates = { ...PAYOUT_DEFAULTS };
  let uploaded = 0;
  for (const r of db.prepare('SELECT key, value FROM payout_rules').all()) {
    if (PAYOUT_KEYS.includes(r.key)) { payoutRates[r.key] = Number(r.value); uploaded++; }
  }
  payoutSrc = uploaded ? 'uploaded' : 'built_in';
  return payoutRates;
}
export const payoutRules = () => ({ ...payoutRates });
export const payoutSource = () => payoutSrc;

const normName = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Flat payout for one card, by its name first (a card with its own rate) then its category. */
export function cardPayout(category, name) {
  if (name) {
    const byName = Object.entries(payoutRates).find(([k]) => k.startsWith('card_name:') && normName(k.slice(10)) === normName(name));
    if (byName) return byName[1];
  }
  const byCat = payoutRates[`card:${category}`];
  return byCat == null ? null : byCat;
}

/** The highest card payout the salary qualifies for, from the current product list. */
export function bestCardPayout(salary) {
  if (salary == null) return null;
  const eligible = cardProducts().filter((p) => p.min_salary != null && p.min_salary <= salary);
  return eligible.reduce((best, p) => Math.max(best, cardPayout(p.category, p.name) ?? 0), 0);
}

const EIB_BANK = /emirates\s*islamic|\beib\b/i;
/** Is this loan buying out an Emirates Islamic loan (the lower personal loan rate)? */
export function isEibBuyout(row) {
  if (row.personal_loan_type !== 'buy_out') return false;
  const list = Array.isArray(row.pl_buyouts) ? row.pl_buyouts : (() => { try { return JSON.parse(row.pl_buyouts || '[]'); } catch { return []; } })();
  const primary = list.find((b) => b.role === 'primary' && b.kind === 'personal_loan');
  return EIB_BANK.test(primary?.bank || row.buyout_bank || '');
}

const roundAed = (n) => Math.round(n * 100) / 100;

/**
 * What a file earns, product by product: `{ total, parts: [{ product, basis, amount, rate, payout }] }`.
 * Loans use the disbursed amount once completed, else the amount sourced; cards the flat rate.
 */
export function payoutFor(row) {
  const parts = [];
  for (const product of caseProducts(row)) {
    if (product === 'credit_card' && includesCard(row) && row.credit_card) {
      const payout = cardPayout(row.card_category, row.credit_card);
      if (payout != null) parts.push({ product, basis: `${row.card_category || 'Card'} card`, amount: null, rate: null, payout });
    } else if (product === 'personal_loan') {
      const amount = row.pl_disbursed_amount ?? row.loan_amount ?? row.full_loan_amount;
      if (amount != null) {
        const eib = isEibBuyout(row);
        const rate = eib ? payoutRates.personal_loan_eib_buyout_pct : payoutRates.personal_loan_pct;
        parts.push({ product, basis: eib ? 'Buy-out of an Emirates Islamic loan' : 'Personal loan', amount: Number(amount), rate, payout: roundAed((Number(amount) * rate) / 100) });
      }
    } else if (product === 'auto_loan') {
      const amount = row.al_disbursed_amount ?? row.amount;
      if (amount != null && row.auto_loan_type) {
        const rate = row.auto_loan_type === 'used' ? payoutRates.auto_loan_used_pct : payoutRates.auto_loan_new_pct;
        parts.push({ product, basis: row.auto_loan_type === 'used' ? 'Used car' : 'New car', amount: Number(amount), rate, payout: roundAed((Number(amount) * rate) / 100) });
      }
    }
  }
  return { total: roundAed(parts.reduce((n, p) => n + p.payout, 0)), parts };
}
