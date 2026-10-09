// Credit card incentives: what a card sales person earns on the points they make beyond target.
//
// Points beyond target pay AED 1.25 each when the staff member either sold at least 33% Premium or
// Super Premium cards, or cross-sold at least AED 50,000 of personal loans; otherwise AED 0.70 each.
// Personal loans count towards the points too: AED 50,000 disbursed = 500 points, and a loan buying
// out an Emirates Islamic loan counts at half its disbursed amount.
import { caseProducts, includesCard, COMPLETED_IN_SQL, NO_VALID_COMPLAINT_SQL, COMPLAINT_REMARK, REGIONS, WorkflowError } from './cases.js';

// A sales person's files completed in the cycle that count for incentive: files with a valid
// complaint are left out (every scheme, and every team total built from them).
const STAFF_FILES_SQL = `COALESCE(c.sales_staff_id, c.created_by) = ? AND ${COMPLETED_IN_SQL} AND ${NO_VALID_COMPLAINT_SQL}`;
/** How many of the sales person's completed files were removed for valid complaints, with the remark to show. */
function complaintExclusion(db, staffId, start, end) {
  const n = db.prepare(`SELECT COUNT(*) AS n FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = ? AND ${COMPLETED_IN_SQL} AND c.complaint_status = 'valid'`).get(staffId, start, end).n;
  return { excluded_files: n, remark: n ? `${COMPLAINT_REMARK} (${n} ${n === 1 ? 'file' : 'files'})` : '' };
}
import { cycleOf, cycleRange, isCycle, uaeDay, cycleLabel } from './cycles.js';
import { isEibBuyout } from './payouts.js';
import { achievedBy, autoLoanRate, autoLoanPoints, AUTO_LOAN_POINT_RATES } from './performance.js';
import { TEAM_LEADER_ROLES } from './users.js';

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
// Cards a personal loan sales person cross-sells pay a flat amount each, once their counted production
// reaches their target less AED 100,000; the noon card pays nothing.
export const PL_CROSS_SELL = { threshold_below_target_aed: 100000, card_aed: { Mass: 500, Premium: 900, 'Super Premium': 1100 }, noon_aed: 0 };
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
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE ${STAFF_FILES_SQL}`).all(staffId, start, end);
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
  // Cards cross-sold, paid once production reaches the threshold (target less AED 100,000).
  const cards = { noon: 0, Mass: 0, Premium: 0, 'Super Premium': 0, other: 0 };
  let cards_aed = 0;
  for (const c of rows) {
    if (!(includesCard(c) && c.credit_card)) continue;
    if (/\bnoon\b/i.test(c.credit_card)) { cards.noon++; cards_aed += PL_CROSS_SELL.noon_aed; } else if (PL_CROSS_SELL.card_aed[c.card_category] != null) { cards[c.card_category]++; cards_aed += PL_CROSS_SELL.card_aed[c.card_category]; } else cards.other++;
  }
  const cards_threshold = target == null ? null : Math.max(0, target - PL_CROSS_SELL.threshold_below_target_aed);
  const cards_qualified = cards_threshold != null && pl_counted >= cards_threshold;
  const core_aed = round2((pl_counted * rate_pct) / 100);
  const cards_incentive_aed = cards_qualified ? round2(cards_aed) : 0;
  return {
    cycle, target, loans, eib_loans, top_ups, topup_share: topupShare(cycle), pl_disbursed, pl_counted, achievement_pct: target ? Math.round((pl_counted / target) * 1000) / 10 : null,
    band: band ? plBandLabel(band) : `Below ${aedK(PL_INCENTIVE_BANDS[0].from)}`, rate_pct, core_aed,
    cards_sold: cards.noon + cards.Mass + cards.Premium + cards['Super Premium'] + cards.other, cards, cards_aed: round2(cards_aed), cards_threshold, cards_qualified, cards_incentive_aed, incentive_aed: round2(core_aed + cards_incentive_aed),
    next_band: next ? { label: plBandLabel(next), from: next.from, rate: next.rate, short_by: round2(next.from - pl_counted) } : null, files: rows.length, ...complaintExclusion(db, staffId, start, end),
  };
}
export const INCENTIVE_CRITERIA = { mix: 'Premium mix', cross_sell: 'Cross-sell', none: 'Neither' };

const round2 = (n) => Math.round(n * 100) / 100;

// Core auto loan sales staff only (core product auto_loan): the loan's points are its disbursed amount at the scheme's rate for its class (new and
// used car loans 0.80%, algo loans 0.25%, low-payout non-algo loans nothing). Points beyond the staff
// member's auto loan target pay AED 1.10 each once new and used car disbursal in the cycle reaches
// AED 250,000, otherwise AED 0.60 each. Algo loans earn points but do not count towards the AED 250,000.
export const AL_INCENTIVE_RULES = {
  rates_pct: AUTO_LOAN_POINT_RATES, // % of the disbursed amount that becomes points, by loan type or class
  multiplier_high: 1.1, // AED per excess point at or above the full-payout disbursal below
  multiplier_low: 0.6, // AED per excess point otherwise
  full_payout_aed: 250000, // new and used car loans (full payout) disbursed in the cycle
};
export const AL_CLASS_LABELS = { new: 'New car', used: 'Used car', algo: 'Algo loan', low: 'Low-payout non-algo' };

/** What a completed auto loan counts for incentives: its class, rate and points. */
export function countedAutoLoan(c) {
  if (!caseProducts(c).includes('auto_loan') || !(c.al_disbursed_amount > 0)) return null;
  const kind = c.al_payout_class && c.al_payout_class !== 'full' ? c.al_payout_class : (c.auto_loan_type || 'used');
  return { kind, label: AL_CLASS_LABELS[kind], disbursed: c.al_disbursed_amount, rate_pct: autoLoanRate(c), points: autoLoanPoints(c), full_payout: kind === 'new' || kind === 'used' };
}

/** One auto loan sales person's incentive for a cycle: points from disbursal, excess over target, the multiplier earned. */
export function alIncentiveFor(db, staffId, cycle) {
  const { start, end } = cycleRange(cycle);
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE ${STAFF_FILES_SQL}`).all(staffId, start, end);
  const target = db.prepare("SELECT target FROM targets WHERE user_id = ? AND cycle = ? AND product = 'auto_loan'").get(staffId, cycle)?.target ?? null;
  const n = { new: 0, used: 0, algo: 0, low: 0 };
  let loans = 0; let disbursed = 0; let full_payout_aed = 0; let algo_aed = 0; let low_aed = 0; let points = 0;
  for (const c of rows) {
    const loan = countedAutoLoan(c);
    if (!loan) continue;
    loans++; n[loan.kind]++;
    disbursed += loan.disbursed;
    points += loan.points;
    if (loan.full_payout) full_payout_aed += loan.disbursed;
    else if (loan.kind === 'algo') algo_aed += loan.disbursed;
    else low_aed += loan.disbursed;
  }
  points = round2(points);
  const high = full_payout_aed >= AL_INCENTIVE_RULES.full_payout_aed;
  const multiplier = high ? AL_INCENTIVE_RULES.multiplier_high : AL_INCENTIVE_RULES.multiplier_low;
  const excess_points = target == null ? null : Math.max(0, round2(points - target));
  return {
    cycle, target, loans, new_loans: n.new, used_loans: n.used, algo_loans: n.algo, low_loans: n.low, disbursed, full_payout_aed, algo_aed, low_aed, points,
    achievement_pct: target ? Math.round((points / target) * 1000) / 10 : null, excess_points, full_payout_met: high, multiplier,
    short_by: high ? 0 : round2(AL_INCENTIVE_RULES.full_payout_aed - full_payout_aed), incentive_aed: excess_points == null ? null : round2(excess_points * multiplier), files: rows.length, ...complaintExclusion(db, staffId, start, end),
  };
}

/** Every auto loan sales person's incentive for the cycle, as report rows. */
export function alIncentiveRows(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const staff = db.prepare(`SELECT u.id, u.name, u.sales_code, u.region, tl.name AS team_leader, sm.name AS sales_manager
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id
    WHERE u.role = 'sales' AND u.active = 1 AND u.core_product = 'auto_loan'${region ? ' AND u.region = ?' : ''} ORDER BY u.name`).all(...(region ? [r] : []));
  return staff.map((s) => {
    const i = alIncentiveFor(db, s.id, cycle);
    return { user_id: s.id, staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader || '', sales_manager: s.sales_manager || '', region: s.region || '', ...i, multiplier: `AED ${i.multiplier.toFixed(2)}`, full_payout_met: i.full_payout_met ? 'Yes' : 'No' };
  }).sort((a, b) => (b.incentive_aed ?? -1) - (a.incentive_aed ?? -1) || a.staff.localeCompare(b.staff));
}

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
  const rows = db.prepare(`SELECT c.* FROM cases c WHERE ${STAFF_FILES_SQL}`).all(staffId, start, end);
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
    excess_points, criterion, criterion_label: INCENTIVE_CRITERIA[criterion], rate, incentive_aed, files: rows.length, ...complaintExclusion(db, staffId, start, end),
  };
}


// Core credit card team leaders: the team's card points (from its core credit card staff) beyond a
// team threshold of 75% of the team's combined card targets, paid AED 0.30 a point when the team's
// personal loan cross-sell reaches AED 50,000 or its Premium and Super Premium mix exceeds 20%,
// else AED 0.20. Personal loan points stay out of the team's points; the cross-sell earns 0.15% of
// the gross amount disbursed, as a separate line.
export const TL_INCENTIVE_RULES = {
  threshold_share: 75, // % of the team's combined card targets that is the team leader's threshold
  rate_high: 0.3, // AED per excess point when a criterion is met
  rate_low: 0.2, // AED per excess point otherwise
  mix_share: 20, // Premium + Super Premium share of the team's cards that must be exceeded
  cross_sell_aed: 50000, // team personal loan cross-sell (gross disbursed) that qualifies on its own
  cross_sell_pct: 0.15, // % of the team's gross personal loan cross-sell paid separately
};

/** The active core credit card sales staff a team leader leads. */
const ccTeamOf = (db, leaderId) => db.prepare("SELECT id, name, sales_code FROM users WHERE role = 'sales' AND active = 1 AND core_product = 'credit_card' AND team_leader_id = ? ORDER BY name").all(leaderId);

/** One credit card team leader's incentive for a cycle, from their core card staff's completed files. */
export function tlIncentiveFor(db, leaderId, cycle) {
  const team = ccTeamOf(db, leaderId);
  let combined_target = 0; let staff_without_target = 0; let cards_sold = 0; let premium_cards = 0; let points = 0; let cross_sell_aed = 0; let files = 0;
  const staff = team.map((s) => {
    const i = incentiveFor(db, s.id, cycle);
    if (i.target == null) staff_without_target++; else combined_target += i.target;
    cards_sold += i.cards_sold; premium_cards += i.premium_cards; points += i.card_points; cross_sell_aed += i.pl_disbursed; files += i.files;
    return { id: s.id, name: s.name, sales_code: s.sales_code, target: i.target, card_points: i.card_points, cards_sold: i.cards_sold, premium_cards: i.premium_cards, pl_disbursed: i.pl_disbursed };
  });
  const r = TL_INCENTIVE_RULES;
  const threshold = round2((combined_target * r.threshold_share) / 100);
  const mix_pct = cards_sold ? Math.round((premium_cards / cards_sold) * 1000) / 10 : 0;
  const mix_met = cards_sold > 0 && mix_pct > r.mix_share;
  const cross_sell_met = cross_sell_aed >= r.cross_sell_aed;
  const criterion = mix_met ? 'mix' : cross_sell_met ? 'cross_sell' : 'none';
  const rate = mix_met || cross_sell_met ? r.rate_high : r.rate_low;
  const excess_points = Math.max(0, round2(points - threshold));
  const core_aed = round2(excess_points * rate);
  const cross_sell_incentive_aed = round2((cross_sell_aed * r.cross_sell_pct) / 100);
  return {
    cycle, team_size: team.length, staff_without_target, combined_target, threshold, cards_sold, premium_cards, mix_pct, points, excess_points,
    criterion, criterion_label: INCENTIVE_CRITERIA[criterion], rate, core_aed, cross_sell_aed, cross_sell_incentive_aed, incentive_aed: round2(core_aed + cross_sell_incentive_aed), files, staff,
  };
}

/** Every credit card team leader's incentive for the cycle (anyone leading active core card staff), as report rows. */
export function tlIncentiveRows(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const leaders = db.prepare(`SELECT DISTINCT l.id, l.name, l.hrms_code, l.region, l.role, sm.name AS sales_manager FROM users l
    JOIN users s ON s.team_leader_id = l.id AND s.role = 'sales' AND s.active = 1 AND s.core_product = 'credit_card'
    LEFT JOIN users sm ON sm.id = l.sales_manager_id
    WHERE l.active = 1${region ? ' AND l.region = ?' : ''} ORDER BY l.name`).all(...(region ? [r] : []));
  return leaders.map((l) => {
    const i = tlIncentiveFor(db, l.id, cycle);
    return { user_id: l.id, leader: l.name, hrms_code: l.hrms_code || '', role: l.role, sales_manager: l.sales_manager || '', region: l.region || '', ...i, staff: undefined, criterion: i.criterion_label, rate: `AED ${i.rate.toFixed(2)}` };
  }).sort((a, b) => b.incentive_aed - a.incentive_aed || a.leader.localeCompare(b.leader));
}


// Personal loan team leaders: a percentage of the team's counted production (core personal loan staff;
// regular loans in full, top-ups and Emirates Islamic buy-outs as for the staff themselves) by the
// team's achievement of its combined targets, paid on the whole production. Cards the team cross-sells
// pay a flat amount each, only once the team is at 80% of target; the noon card pays nothing.
export const PL_TL_BANDS = [
  { from: 80, to: 99.99, rate: 0.05 },
  { from: 100, to: 124.99, rate: 0.15 },
  { from: 125, to: 149.99, rate: 0.2 },
  { from: 150, to: Infinity, rate: 0.25 },
];
export const PL_TL_RULES = { qualify_pct: 80, card_aed: { Mass: 20, Premium: 50, 'Super Premium': 100 }, noon_aed: 0 };
export const plTlBandLabel = (b) => (b.to === Infinity ? `${b.from}% and above` : `${b.from}% to ${b.to}%`);
const isNoonCard = (c) => /\bnoon\b/i.test(c.credit_card || '');

/** The active core personal loan sales staff a team leader leads. */
const plTeamOf = (db, leaderId) => db.prepare("SELECT id, name, sales_code FROM users WHERE role = 'sales' AND active = 1 AND core_product = 'personal_loan' AND team_leader_id = ? ORDER BY name").all(leaderId);

/** One personal loan team leader's incentive for a cycle, from their core loan staff's completed files. */
export function plTlIncentiveFor(db, leaderId, cycle) {
  const team = plTeamOf(db, leaderId);
  const { start, end } = cycleRange(cycle);
  let combined_target = 0; let staff_without_target = 0; let loans = 0; let pl_disbursed = 0; let pl_counted = 0; let files = 0;
  const cards = { noon: 0, Mass: 0, Premium: 0, 'Super Premium': 0, other: 0 };
  let cards_aed = 0;
  const staff = team.map((s) => {
    const i = plIncentiveFor(db, s.id, cycle);
    if (i.target == null) staff_without_target++; else combined_target += i.target;
    loans += i.loans; pl_disbursed += i.pl_disbursed; pl_counted += i.pl_counted; files += i.files;
    for (const c of db.prepare(`SELECT c.credit_card, c.card_category FROM cases c WHERE c.credit_card IS NOT NULL AND ${STAFF_FILES_SQL}`).all(s.id, start, end)) {
      if (isNoonCard(c)) { cards.noon++; cards_aed += PL_TL_RULES.noon_aed; } else if (PL_TL_RULES.card_aed[c.card_category] != null) { cards[c.card_category]++; cards_aed += PL_TL_RULES.card_aed[c.card_category]; } else cards.other++;
    }
    return { id: s.id, name: s.name, sales_code: s.sales_code, target: i.target, pl_counted: i.pl_counted, loans: i.loans };
  });
  const achievement_pct = combined_target ? Math.round((pl_counted / combined_target) * 1000) / 10 : null;
  const band = achievement_pct == null ? null : PL_TL_BANDS.find((b) => achievement_pct >= b.from && achievement_pct <= b.to) || null;
  const rate_pct = band ? band.rate : 0;
  const qualified = achievement_pct != null && achievement_pct >= PL_TL_RULES.qualify_pct;
  const core_aed = round2((pl_counted * rate_pct) / 100);
  const cards_incentive_aed = qualified ? round2(cards_aed) : 0;
  return {
    cycle, team_size: team.length, staff_without_target, combined_target, loans, pl_disbursed, pl_counted, achievement_pct, band: band ? plTlBandLabel(band) : `Below ${PL_TL_RULES.qualify_pct}%`, rate_pct, core_aed,
    cards_sold: cards.noon + cards.Mass + cards.Premium + cards['Super Premium'] + cards.other, cards, cards_aed: round2(cards_aed), qualified, cards_incentive_aed, incentive_aed: round2(core_aed + cards_incentive_aed), files, staff,
  };
}

/** Every personal loan team leader's incentive for the cycle (anyone leading active core loan staff), as report rows. */
export function plTlIncentiveRows(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const leaders = db.prepare(`SELECT DISTINCT l.id, l.name, l.hrms_code, l.region, l.role, sm.name AS sales_manager FROM users l
    JOIN users s ON s.team_leader_id = l.id AND s.role = 'sales' AND s.active = 1 AND s.core_product = 'personal_loan'
    LEFT JOIN users sm ON sm.id = l.sales_manager_id
    WHERE l.active = 1${region ? ' AND l.region = ?' : ''} ORDER BY l.name`).all(...(region ? [r] : []));
  return leaders.map((l) => {
    const i = plTlIncentiveFor(db, l.id, cycle);
    return { user_id: l.id, leader: l.name, hrms_code: l.hrms_code || '', role: l.role, sales_manager: l.sales_manager || '', region: l.region || '', ...i, staff: undefined, cards: undefined,
      mass_cards: i.cards.Mass, premium_cards: i.cards.Premium, super_premium_cards: i.cards['Super Premium'], noon_cards: i.cards.noon, rate: `${i.rate_pct.toFixed(2)}%`, qualified: i.qualified ? 'Yes' : 'No' };
  }).sort((a, b) => b.incentive_aed - a.incentive_aed || a.leader.localeCompare(b.leader));
}


// Sales managers and ASMs. A credit card manager earns a flat amount per card the core card team
// sold, by the team's achievement of its combined card targets. A manager of personal loan
// production earns a percentage of the whole production (core loan staff plus loans cross-sold by
// the rest of the team, Emirates Islamic buy-outs at 50%) by its achievement of the core staff's
// combined targets. The loan grid applies to every manager with loan staff (confirmed). Cards
// cross-sold by the rest of a card manager's team are added to the team's card numbers.
export const CC_SM_SLABS = [
  { from: 70, to: 79.99, aed: 15 }, { from: 80, to: 99.99, aed: 20 }, { from: 100, to: 109.99, aed: 30 }, { from: 110, to: 124.99, aed: 35 },
  { from: 125, to: 139.99, aed: 40 }, { from: 140, to: 149.99, aed: 45 }, { from: 150, to: Infinity, aed: 50 },
];
export const PL_SM_BANDS = [
  { from: 80, to: 99.99, rate: 0.02 }, { from: 100, to: 124.99, rate: 0.0625 }, { from: 125, to: 149.99, rate: 0.075 }, { from: 150, to: Infinity, rate: 0.1 },
];
export const SM_RULES = { cc_qualify_pct: 70, pl_qualify_pct: 80 };
const smColumn = (role) => (role === 'asm' ? 'asm_id' : 'sales_manager_id');
/** The active sales staff under a sales manager or ASM, optionally by core product. */
const smTeamOf = (db, managerId, role, product = null) => db.prepare(`SELECT id, name, sales_code, core_product FROM users WHERE role = 'sales' AND active = 1 AND ${smColumn(role)} = ?${product ? ' AND core_product = ?' : ''} ORDER BY name`).all(...(product ? [managerId, product] : [managerId]));
/** Counted personal loan production on a staff member's files completed in the cycle. */
function plCountedFor(db, staffId, cycle) {
  const { start, end } = cycleRange(cycle);
  let counted = 0; let disbursed = 0; let loans = 0;
  for (const c of db.prepare(`SELECT c.* FROM cases c WHERE ${STAFF_FILES_SQL}`).all(staffId, start, end)) {
    const loan = countedLoan(c, cycle);
    if (loan) { loans++; counted += loan.counted; disbursed += loan.disbursed; }
  }
  return { loans, counted, disbursed };
}

/** A credit card sales manager's or ASM's incentive for a cycle: a flat amount per card by the core card team's achievement. */
export function ccSmIncentiveFor(db, managerId, role, cycle) {
  const everyone = smTeamOf(db, managerId, role);
  const team = everyone.filter((s) => s.core_product === 'credit_card');
  const { start, end } = cycleRange(cycle);
  let combined_target = 0; let staff_without_target = 0; let cards_sold = 0; let points = 0; let files = 0; let cross_sell_cards = 0;
  for (const s of team) {
    const i = incentiveFor(db, s.id, cycle);
    if (i.target == null) staff_without_target++; else combined_target += i.target;
    cards_sold += i.cards_sold; points += i.card_points; files += i.files;
  }
  // Cards cross-sold by the rest of the team (loan and other staff) count in the card numbers.
  for (const s of everyone.filter((s) => s.core_product !== 'credit_card')) {
    for (const c of db.prepare(`SELECT c.* FROM cases c WHERE c.credit_card IS NOT NULL AND ${STAFF_FILES_SQL}`).all(s.id, start, end)) {
      if (!includesCard(c)) continue;
      cross_sell_cards++; cards_sold++; points += achievedBy('credit_card', c);
    }
  }
  const achievement_pct = combined_target ? Math.round((points / combined_target) * 1000) / 10 : null;
  const slab = achievement_pct == null ? null : CC_SM_SLABS.find((b) => achievement_pct >= b.from && achievement_pct <= b.to) || null;
  const aed_per_card = slab ? slab.aed : 0;
  return { cycle, team_size: team.length, staff_without_target, combined_target, points, achievement_pct, slab: slab ? plTlBandLabel(slab) : `Below ${SM_RULES.cc_qualify_pct}%`, cards_sold, cross_sell_cards, aed_per_card, incentive_aed: round2(cards_sold * aed_per_card), files };
}

/** A sales manager's or ASM's personal loan incentive for a cycle: a percentage of the team's whole loan production, cross-sell included, by achievement of the core loan staff's targets. */
export function plSmIncentiveFor(db, managerId, role, cycle) {
  const team = smTeamOf(db, managerId, role);
  const core = team.filter((s) => s.core_product === 'personal_loan');
  let combined_target = 0; let staff_without_target = 0; let core_counted = 0; let cross_sell_counted = 0; let loans = 0; let pl_disbursed = 0;
  for (const s of core) {
    const i = plIncentiveFor(db, s.id, cycle);
    if (i.target == null) staff_without_target++; else combined_target += i.target;
    core_counted += i.pl_counted; loans += i.loans; pl_disbursed += i.pl_disbursed;
  }
  for (const s of team.filter((s) => s.core_product !== 'personal_loan')) {
    const p = plCountedFor(db, s.id, cycle);
    cross_sell_counted += p.counted; loans += p.loans; pl_disbursed += p.disbursed;
  }
  const pl_counted = round2(core_counted + cross_sell_counted);
  const achievement_pct = combined_target ? Math.round((pl_counted / combined_target) * 1000) / 10 : null;
  const band = achievement_pct == null ? null : PL_SM_BANDS.find((b) => achievement_pct >= b.from && achievement_pct <= b.to) || null;
  const rate_pct = band ? band.rate : 0;
  return { cycle, team_size: team.length, core_staff: core.length, staff_without_target, combined_target, loans, pl_disbursed, core_counted: round2(core_counted), cross_sell_counted: round2(cross_sell_counted), pl_counted, achievement_pct,
    band: band ? plTlBandLabel(band) : `Below ${SM_RULES.pl_qualify_pct}%`, rate_pct, incentive_aed: round2((pl_counted * rate_pct) / 100) };
}

function smLeaders(db, product, region) {
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const where = product ? ` AND s.core_product = '${product}'` : '';
  return db.prepare(`SELECT DISTINCT m.id, m.name, m.hrms_code, m.region, m.role FROM users m
    JOIN users s ON s.role = 'sales' AND s.active = 1 AND ((m.role = 'asm' AND s.asm_id = m.id) OR (m.role = 'sales_manager' AND s.sales_manager_id = m.id))${where}
    WHERE m.active = 1 AND m.role IN ('sales_manager', 'asm')${region ? ' AND m.region = ?' : ''} ORDER BY m.name`).all(...(region ? [r] : []));
}
/** Every credit card manager's incentive for the cycle (managers of active core card staff), as report rows. */
export function ccSmIncentiveRows(db, cycle, region = null) {
  return smLeaders(db, 'credit_card', region).map((m) => ({ user_id: m.id, manager: m.name, hrms_code: m.hrms_code || '', role: m.role, region: m.region || '', ...ccSmIncentiveFor(db, m.id, m.role, cycle) }))
    .sort((a, b) => b.incentive_aed - a.incentive_aed || a.manager.localeCompare(b.manager));
}
/** Every manager with personal loan production in their team (core loan staff), as report rows. */
export function plSmIncentiveRows(db, cycle, region = null) {
  return smLeaders(db, 'personal_loan', region).map((m) => ({ user_id: m.id, manager: m.name, hrms_code: m.hrms_code || '', role: m.role, region: m.region || '', ...plSmIncentiveFor(db, m.id, m.role, cycle) }))
    .map((x) => ({ ...x, rate: `${x.rate_pct.toFixed(4)}%` })).sort((a, b) => b.incentive_aed - a.incentive_aed || a.manager.localeCompare(b.manager));
}

/** The staff member's own incentive, for the Targets page: sales staff by core product, leaders one calculation per team they lead or manage. */
export function myIncentive(db, user, cycle) {
  if (user.role !== 'sales' && !TEAM_LEADER_ROLES.includes(user.role)) throw new WorkflowError(403, 'Incentives are shown to sales staff and team leaders');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const me = db.prepare('SELECT core_product FROM users WHERE id = ?').get(user.id);
  const base = { cycle, label: cycleLabel(cycle), rules: INCENTIVE_RULES, pl_cross_sell: PL_CROSS_SELL, al_rules: AL_INCENTIVE_RULES, tl_rules: TL_INCENTIVE_RULES, pl_tl_rules: PL_TL_RULES, pl_tl_bands: PL_TL_BANDS.map((b) => ({ label: plTlBandLabel(b), rate: b.rate })), cc_sm_slabs: CC_SM_SLABS.map((b) => ({ label: plTlBandLabel(b), aed: b.aed })), pl_sm_bands: PL_SM_BANDS.map((b) => ({ label: plTlBandLabel(b), rate: b.rate })), sm_rules: SM_RULES, conditions: INCENTIVE_CONDITIONS, pl_bands: PL_INCENTIVE_BANDS.map((b) => ({ label: plBandLabel(b), rate: b.rate })) };
  if (user.role !== 'sales') {
    const teams = [];
    if (ccTeamOf(db, user.id).length) teams.push({ type: 'cc_team_leader', incentive: tlIncentiveFor(db, user.id, cycle) });
    if (plTeamOf(db, user.id).length) teams.push({ type: 'pl_team_leader', incentive: plTlIncentiveFor(db, user.id, cycle) });
    if (user.role !== 'team_leader') {
      if (smTeamOf(db, user.id, user.role, 'credit_card').length) teams.push({ type: 'cc_sales_manager', incentive: ccSmIncentiveFor(db, user.id, user.role, cycle) });
      if (smTeamOf(db, user.id, user.role, 'personal_loan').length) teams.push({ type: 'pl_sales_manager', incentive: plSmIncentiveFor(db, user.id, user.role, cycle) });
    }
    return { ...base, type: teams.length ? 'team_leader' : null, incentive: null, teams };
  }
  if (me?.core_product === 'credit_card') return { ...base, type: 'credit_card', incentive: incentiveFor(db, user.id, cycle) };
  if (me?.core_product === 'personal_loan') return { ...base, type: 'personal_loan', incentive: plIncentiveFor(db, user.id, cycle) };
  if (me?.core_product === 'auto_loan') return { ...base, type: 'auto_loan', incentive: alIncentiveFor(db, user.id, cycle) };
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
    return { user_id: s.id, staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader || '', sales_manager: s.sales_manager || '', region: s.region || '', ...i, cards: undefined, mass_cards: i.cards.Mass, premium_cards: i.cards.Premium, super_premium_cards: i.cards['Super Premium'], noon_cards: i.cards.noon, cards_qualified: i.cards_qualified ? 'Yes' : 'No', rate: `${i.rate_pct.toFixed(2)}%` };
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
    return { user_id: s.id, staff: s.name, sales_code: s.sales_code || '', team_leader: s.team_leader || '', sales_manager: s.sales_manager || '', region: s.region || '', ...i, criterion: i.criterion_label, rate: `AED ${i.rate.toFixed(2)}` };
  }).sort((a, b) => (b.incentive_aed ?? -1) - (a.incentive_aed ?? -1) || a.staff.localeCompare(b.staff));
}
