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
  topup_share: 70, // % of a top-up's incremental amount that counts, from the cycle below; 100% before it
  topup_share_from_cycle: '2026-10',
  next_cycle_minimum_pct: 60, // paid only if the staff member achieves at least this much of target in the next cycle
};
/** Conditions every incentive is subject to, shown wherever an incentive amount is shown. */
export const INCENTIVE_CONDITIONS = [
  `All incentives are subject to achieving a minimum of ${INCENTIVE_RULES.next_cycle_minimum_pct}% of target in the next sales cycle.`,
  'All incentives are subject to the bank\'s data cut finalisation.',
];
export const PREMIUM_CATEGORIES = ['Premium', 'Super Premium'];

// Personal loan sales staff: a percentage of the cycle's disbursed production, by band. The whole
// production pays at the band's rate; below the first band nothing is paid. An Emirates Islamic
// buy-out counts at half its disbursed amount, as for cards.
export const PL_INCENTIVE_BANDS = [
  { from: 600000, to: 749999.99, rate: 0.4 },
  { from: 750000, to: 999999.99, rate: 0.55 },
  { from: 1000000, to: 1249999.99, rate: 0.75 },
  { from: 1250000, to: 1499999.99, rate: 0.9 },
  { from: 1500000, to: 1999999.99, rate: 1.1 },
  { from: 2000000, to: Infinity, rate: 1.2 },
];
const aedK = (n) => (n >= 1000000 ? `AED ${(n / 1000000).toFixed(n % 1000000 ? 2 : 0).replace(/\.?0+$/, '')}M` : `AED ${Math.round(n / 1000)}K`);
export const plBandLabel = (b) => (b.to === Infinity ? `${aedK(b.from)}+` : `${aedK(b.from)} to ${aedK(b.to + 0.01)}`);

/** One personal loan sales person's incentive for a cycle: production in the cycle, its band and rate. */
export function plIncentiveFor(db, staffId, cycle) {
  const { start, end } = cycleRange(cycle);
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = ? AND ${COMPLETED_IN_SQL}`).all(staffId, start, end);
  const target = db.prepare("SELECT target FROM targets WHERE user_id = ? AND cycle = ? AND product = 'personal_loan'").get(staffId, cycle)?.target ?? null;
  let loans = 0; let pl_disbursed = 0; let pl_counted = 0; let eib_loans = 0; let top_ups = 0;
  for (const c of rows) {
    const loan = countedLoan(c, cycle);
    if (!loan) continue;
    loans++;
    pl_disbursed += loan.disbursed;
    pl_counted += loan.counted;
    if (loan.kind === 'eib') eib_loans++;
    if (loan.kind === 'top_up') top_ups++;
  }
  const band = PL_INCENTIVE_BANDS.find((b) => pl_counted >= b.from && pl_counted <= b.to) || null;
  const rate_pct = band ? band.rate : 0;
  const next = band ? PL_INCENTIVE_BANDS[PL_INCENTIVE_BANDS.indexOf(band) + 1] || null : PL_INCENTIVE_BANDS[0];
  return {
    cycle, target, loans, eib_loans, top_ups, topup_share: topupShare(cycle), pl_disbursed, pl_counted, achievement_pct: target ? Math.round((pl_counted / target) * 1000) / 10 : null,
    band: band ? plBandLabel(band) : `Below ${aedK(PL_INCENTIVE_BANDS[0].from)}`, rate_pct, incentive_aed: round2((pl_counted * rate_pct) / 100),
    next_band: next ? { label: plBandLabel(next), from: next.from, rate: next.rate, short_by: round2(next.from - pl_counted) } : null, files: rows.length,
  };
}
export const INCENTIVE_CRITERIA = { mix: 'Premium mix', cross_sell: 'Cross-sell', none: 'Neither' };

const round2 = (n) => Math.round(n * 100) / 100;

/** The share of a top-up's incremental amount that counts in a cycle: 70% from October 2026, 100% before. */
export const topupShare = (cycle) => (String(cycle) >= INCENTIVE_RULES.topup_share_from_cycle ? INCENTIVE_RULES.topup_share : 100);

/** What a completed personal loan counts for incentives: top-ups a share of the incremental amount, Emirates Islamic buy-outs 50%, else the amount disbursed. */
export function countedLoan(c, cycle) {
  if (!caseProducts(c).includes('personal_loan') || !(c.pl_disbursed_amount > 0)) return null;
  if (c.personal_loan_type === 'top_up') {
    const base = c.incremental_amount ?? c.pl_disbursed_amount;
    return { kind: 'top_up', disbursed: c.pl_disbursed_amount, counted: (base * topupShare(cycle)) / 100 };
  }
  if (isEibBuyout(c)) return { kind: 'eib', disbursed: c.pl_disbursed_amount, counted: (c.pl_disbursed_amount * INCENTIVE_RULES.eib_buyout_share) / 100 };
  return { kind: 'other', disbursed: c.pl_disbursed_amount, counted: c.pl_disbursed_amount };
}

/** One staff member's incentive for a cycle, from their completed files and card target. */
export function incentiveFor(db, staffId, cycle) {
  const { start, end } = cycleRange(cycle);
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = ? AND ${COMPLETED_IN_SQL}`).all(staffId, start, end);
  const target = db.prepare("SELECT target FROM targets WHERE user_id = ? AND cycle = ? AND product = 'credit_card'").get(staffId, cycle)?.target ?? null;
  let cards_sold = 0; let premium_cards = 0; let card_points = 0; let pl_disbursed = 0; let pl_counted = 0; let eib_loans = 0; let top_ups = 0;
  for (const c of rows) {
    if (includesCard(c) && c.credit_card) {
      cards_sold++;
      card_points += achievedBy('credit_card', c);
      if (PREMIUM_CATEGORIES.includes(c.card_category)) premium_cards++;
    }
    const loan = countedLoan(c, cycle);
    if (loan) {
      pl_disbursed += loan.disbursed;
      pl_counted += loan.counted;
      if (loan.kind === 'eib') eib_loans++;
      if (loan.kind === 'top_up') top_ups++;
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
    cycle, target, cards_sold, premium_cards, mix_pct, card_points, pl_disbursed, pl_counted, eib_loans, top_ups, topup_share: topupShare(cycle), pl_points, total_points,
    excess_points, criterion, criterion_label: INCENTIVE_CRITERIA[criterion], rate, incentive_aed, files: rows.length,
  };
}

/** The staff member's own incentive, for the Targets page; null unless they sell credit cards. */
export function myIncentive(db, user, cycle) {
  if (user.role !== 'sales') throw new WorkflowError(403, 'Incentives are shown to sales staff');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const me = db.prepare('SELECT core_product FROM users WHERE id = ?').get(user.id);
  const base = { cycle, label: cycleLabel(cycle), rules: INCENTIVE_RULES, conditions: INCENTIVE_CONDITIONS, pl_bands: PL_INCENTIVE_BANDS.map((b) => ({ label: plBandLabel(b), rate: b.rate })) };
  if (me?.core_product === 'credit_card') return { ...base, type: 'credit_card', incentive: incentiveFor(db, user.id, cycle) };
  if (me?.core_product === 'personal_loan') return { ...base, type: 'personal_loan', incentive: plIncentiveFor(db, user.id, cycle) };
  return { ...base, type: null, incentive: null };
}

/** Every personal loan sales person's incentive for the cycle, as report rows. */
export function plIncentiveRows(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const staff = db.prepare(`SELECT u.id, u.name, u.sales_code, u.region, tl.name AS team_leader, sm.name AS sales_manager
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id
    WHERE u.role = 'sales' AND u.active = 1 AND u.core_product = 'personal_loan'${region ? ' AND u.region = ?' : ''} ORDER BY u.name`).all(...(region ? [r] : []));
  return staff.map((s) => {
    const i = plIncentiveFor(db, s.id, cycle);
    return { staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader || '', sales_manager: s.sales_manager || '', region: s.region || '', ...i, rate: `${i.rate_pct.toFixed(2)}%` };
  }).sort((a, b) => b.incentive_aed - a.incentive_aed || a.staff.localeCompare(b.staff));
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
