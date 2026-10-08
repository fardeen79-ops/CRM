// Credit card incentives: what a card sales person earns on the points they make beyond target.
//
// Points beyond target pay AED 1.25 each when the staff member either sold at least 33% Premium or
// Super Premium cards, or cross-sold at least AED 50,000 of personal loans; otherwise AED 0.70 each.
// Personal loans count towards the points too: AED 50,000 disbursed = 500 points, and a loan buying
// out an Emirates Islamic loan counts at half its disbursed amount.
import { caseProducts, includesCard, COMPLETED_IN_SQL, REGIONS, WorkflowError } from './cases.js';
import { cycleOf, cycleRange, isCycle, uaeDay, cycleLabel } from './cycles.js';
import { isEibBuyout } from './payouts.js';
import { achievedBy } from './performance.js';

export const INCENTIVE_RULES = {
  rate_high: 1.25, // AED per excess point when a criterion is met
  rate_low: 0.7, // AED per excess point otherwise
  mix_share: 33, // % of completed cards that must be Premium or Super Premium
  cross_sell_aed: 50000, // personal loans cross-sold (counted amount) that qualify on their own
  pl_aed_per_point: 100, // AED 50,000 of personal loans = 500 points
  eib_buyout_share: 50, // % of an Emirates Islamic buy-out's disbursed amount that counts
  next_cycle_minimum_pct: 60, // paid only if the staff member achieves at least this much of target in the next cycle
};
/** Conditions every incentive is subject to, shown wherever an incentive amount is shown. */
export const INCENTIVE_CONDITIONS = [
  `All incentives are subject to achieving a minimum of ${INCENTIVE_RULES.next_cycle_minimum_pct}% of target in the next sales cycle.`,
  'All incentives are subject to the bank\'s data cut finalisation.',
];
export const PREMIUM_CATEGORIES = ['Premium', 'Super Premium'];
export const INCENTIVE_CRITERIA = { mix: 'Premium mix', cross_sell: 'Cross-sell', none: 'Neither' };

const round2 = (n) => Math.round(n * 100) / 100;

/** One staff member's incentive for a cycle, from their completed files and card target. */
export function incentiveFor(db, staffId, cycle) {
  const { start, end } = cycleRange(cycle);
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = ? AND ${COMPLETED_IN_SQL}`).all(staffId, start, end);
  const target = db.prepare("SELECT target FROM targets WHERE user_id = ? AND cycle = ? AND product = 'credit_card'").get(staffId, cycle)?.target ?? null;
  let cards_sold = 0; let premium_cards = 0; let card_points = 0; let pl_disbursed = 0; let pl_counted = 0; let eib_loans = 0;
  for (const c of rows) {
    if (includesCard(c) && c.credit_card) {
      cards_sold++;
      card_points += achievedBy('credit_card', c);
      if (PREMIUM_CATEGORIES.includes(c.card_category)) premium_cards++;
    }
    if (caseProducts(c).includes('personal_loan') && c.pl_disbursed_amount > 0) {
      const eib = isEibBuyout(c);
      pl_disbursed += c.pl_disbursed_amount;
      pl_counted += eib ? (c.pl_disbursed_amount * INCENTIVE_RULES.eib_buyout_share) / 100 : c.pl_disbursed_amount;
      if (eib) eib_loans++;
    }
  }
  const pl_points = round2(pl_counted / INCENTIVE_RULES.pl_aed_per_point);
  const total_points = round2(card_points + pl_points);
  const mix_pct = cards_sold ? Math.round((premium_cards / cards_sold) * 1000) / 10 : 0;
  const mix_met = cards_sold > 0 && mix_pct >= INCENTIVE_RULES.mix_share;
  const cross_sell_met = pl_counted >= INCENTIVE_RULES.cross_sell_aed;
  const criterion = mix_met ? 'mix' : cross_sell_met ? 'cross_sell' : 'none';
  const rate = mix_met || cross_sell_met ? INCENTIVE_RULES.rate_high : INCENTIVE_RULES.rate_low;
  const excess_points = target == null ? null : Math.max(0, round2(total_points - target));
  const incentive_aed = excess_points == null ? null : round2(excess_points * rate);
  return {
    cycle, target, cards_sold, premium_cards, mix_pct, card_points, pl_disbursed, pl_counted, eib_loans, pl_points, total_points,
    excess_points, criterion, criterion_label: INCENTIVE_CRITERIA[criterion], rate, incentive_aed, files: rows.length,
  };
}

/** The staff member's own incentive, for the Targets page; null unless they sell credit cards. */
export function myIncentive(db, user, cycle) {
  if (user.role !== 'sales') throw new WorkflowError(403, 'Incentives are shown to sales staff');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const me = db.prepare('SELECT core_product FROM users WHERE id = ?').get(user.id);
  if (me?.core_product !== 'credit_card') return { cycle, label: cycleLabel(cycle), incentive: null, rules: INCENTIVE_RULES, conditions: INCENTIVE_CONDITIONS };
  return { cycle, label: cycleLabel(cycle), incentive: incentiveFor(db, user.id, cycle), rules: INCENTIVE_RULES, conditions: INCENTIVE_CONDITIONS };
}

/** Every credit card sales person's incentive for the cycle, as report rows. */
export function incentiveRows(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const staff = db.prepare(`SELECT u.id, u.name, u.sales_code, u.region, tl.name AS team_leader, sm.name AS sales_manager
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id
    WHERE u.role = 'sales' AND u.active = 1 AND u.core_product = 'credit_card'${region ? ' AND u.region = ?' : ''} ORDER BY u.name`).all(...(region ? [r] : []));
  return staff.map((s) => {
    const i = incentiveFor(db, s.id, cycle);
    return { staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader || '', sales_manager: s.sales_manager || '', region: s.region || '', ...i, criterion: i.criterion_label, rate: `AED ${i.rate.toFixed(2)}` };
  }).sort((a, b) => (b.incentive_aed ?? -1) - (a.incentive_aed ?? -1) || a.staff.localeCompare(b.staff));
}
