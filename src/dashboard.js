// Each user's own dashboard: what they (or their team, or the agency) did this cycle and over the
// last six, with the incentive so far for the people who earn one. Everything is within the
// viewer's case scope, so a sales person sees their files, a leader their team's, MIS everything.
import { caseScope, caseProducts, REGIONS, STATUS, COMPLETED_IN_SQL } from './cases.js';
import { cycleOf, cycleRange, cycleLabel, shiftCycle, uaeDay } from './cycles.js';
import { myIncentive } from './incentives.js';
import { TEAM_LEADER_ROLES, STAFF_CORE_PRODUCTS } from './users.js';
import { followUps } from './leads.js';

export const TREND_CYCLES = 6;

// Roles that see the cross-sell tiles: team leaders and above.
export const CROSS_SELL_VIEWERS = [...TEAM_LEADER_ROLES, 'business_head', 'mis'];
const CROSS_SELL_PRODUCTS = ['credit_card', 'personal_loan', 'auto_loan'];
const DISBURSED = { personal_loan: 'pl_disbursed_amount', auto_loan: 'al_disbursed_amount' };

/**
 * What each core team sold outside its own product on the files completed in the cycle: the core
 * card team's personal loans, the core loan team's cards, and so on. A file counts once per product
 * on it that is not the sales person's core product; loans carry the amount disbursed. Multi product
 * staff have no cross-sell, and staff without a core product are left out.
 */
/**
 * For each product, how much of the cycle's completed production came from its core team and how
 * much was cross-sold by other teams: files, and the amount (AED disbursed for loans, card points
 * for cards), with each side's share. Multi product staff count as core for every product.
 */
export function contributionFor(db, scope, params, start, end) {
  const rows = db.prepare(`SELECT c.product, c.bundle_products, c.credit_card, c.card_points, c.pl_disbursed_amount, c.al_disbursed_amount, u.core_product
    FROM cases c LEFT JOIN users u ON u.id = COALESCE(c.sales_staff_id, c.created_by)
    WHERE ${COMPLETED_IN_SQL} ${scope}`).all(start, end, ...params);
  const amountOf = { credit_card: (r) => r.card_points ?? 1, personal_loan: (r) => r.pl_disbursed_amount ?? 0, auto_loan: (r) => r.al_disbursed_amount ?? 0 };
  const units = { credit_card: 'points', personal_loan: 'aed', auto_loan: 'aed' };
  const out = CROSS_SELL_PRODUCTS.map((p) => ({ product: p, label: STAFF_CORE_PRODUCTS[p], unit: units[p], core: { files: 0, amount: 0 }, cross: { files: 0, amount: 0 } }));
  for (const r of rows) {
    const sold = new Set(caseProducts(r).filter((p) => CROSS_SELL_PRODUCTS.includes(p)));
    if (sold.has('credit_card') && !r.credit_card) sold.delete('credit_card');
    for (const p of sold) {
      const side = !r.core_product || r.core_product === p || r.core_product === 'multi_product' ? 'core' : 'cross';
      const cell = out.find((x) => x.product === p)[side];
      cell.files++;
      cell.amount += amountOf[p](r);
    }
  }
  for (const x of out) {
    const files = x.core.files + x.cross.files; const amount = x.core.amount + x.cross.amount;
    x.total = { files, amount };
    x.core.pct = amount ? Math.round((x.core.amount / amount) * 1000) / 10 : null;
    x.cross.pct = amount ? Math.round((x.cross.amount / amount) * 1000) / 10 : null;
    x.core.amount = Math.round(x.core.amount * 100) / 100; x.cross.amount = Math.round(x.cross.amount * 100) / 100; x.total.amount = Math.round(amount * 100) / 100;
  }
  return out;
}

export function crossSellFor(db, scope, params, start, end) {
  const rows = db.prepare(`SELECT c.product, c.bundle_products, c.credit_card, c.pl_disbursed_amount, c.al_disbursed_amount, u.core_product
    FROM cases c JOIN users u ON u.id = COALESCE(c.sales_staff_id, c.created_by)
    WHERE ${COMPLETED_IN_SQL} ${scope} AND u.core_product IN ('credit_card', 'personal_loan', 'auto_loan')`).all(start, end, ...params);
  const teams = {};
  for (const r of rows) {
    const sold = new Set(caseProducts(r).filter((p) => CROSS_SELL_PRODUCTS.includes(p) && p !== r.core_product));
    if (r.core_product !== 'credit_card' && sold.has('credit_card') && !r.credit_card) sold.delete('credit_card');
    for (const p of sold) {
      const team = (teams[r.core_product] ??= { core: r.core_product, core_label: STAFF_CORE_PRODUCTS[r.core_product], products: {} });
      const cell = (team.products[p] ??= { product: p, label: STAFF_CORE_PRODUCTS[p], files: 0, amount: 0 });
      cell.files++;
      if (DISBURSED[p]) cell.amount += r[DISBURSED[p]] ?? 0;
    }
  }
  return Object.values(teams).map((t) => ({ ...t, products: Object.values(t.products) }));
}

export function dashboardFor(db, user, { region } = {}) {
  const sc = caseScope(user);
  const clauses = sc ? [sc.sql] : [];
  const params = sc ? [...sc.params] : [];
  if (REGIONS[String(region || '').toUpperCase()]) { clauses.push('c.region = ?'); params.push(String(region).toUpperCase()); }
  const scope = clauses.length ? `AND ${clauses.join(' AND ')}` : '';
  const cycle = cycleOf(uaeDay());
  const { start, end } = cycleRange(cycle);
  const count = (sql, ...p) => db.prepare(`SELECT COUNT(*) AS n FROM cases c WHERE ${sql} ${scope}`).get(...p, ...params).n;
  const sourcedIn = (a, b) => count('COALESCE(c.sourcing_date, date(c.created_at, \'+4 hours\')) BETWEEN ? AND ?', a, b);
  const completedIn = (a, b) => count(COMPLETED_IN_SQL, a, b);
  const files = {
    sourced: sourcedIn(start, end),
    completed: completedIn(start, end),
    awaiting_approval: count('c.status = ?', STATUS.APPROVAL ?? 'awaiting_approval'),
    in_verification: count('c.status IN (?, ?)', STATUS.PENDING, STATUS.IN_VERIFICATION),
    returned: count('c.status = ?', 'returned_to_sales'),
    verification_pending: count('c.status = ?', 'incomplete'),
    applicant_review: count("c.case_status = 'applicant_review'"),
    rejected: count("c.case_status = 'rejected' AND date(c.case_status_at, '+4 hours') BETWEEN ? AND ?", start, end),
    open: count("c.case_status NOT IN ('completed', 'rejected')"),
  };
  const trend = [];
  for (let i = TREND_CYCLES - 1; i >= 0; i--) {
    const c = shiftCycle(cycle, -i);
    const r = cycleRange(c);
    trend.push({ cycle: c, label: cycleLabel(c), sourced: sourcedIn(r.start, r.end), completed: completedIn(r.start, r.end) });
  }
  // The incentive so far, for the people who earn one.
  let incentive = null;
  if (user.role === 'sales' || TEAM_LEADER_ROLES.includes(user.role)) {
    try {
      const mine = myIncentive(db, user, cycle);
      const parts = mine.incentive ? [{ type: mine.type, amount: mine.incentive.incentive_aed ?? 0 }] : [...(mine.teams || []), ...(mine.products || [])].map((t) => ({ type: t.type, amount: t.incentive.incentive_aed ?? 0 }));
      if (parts.length) incentive = { total: Math.round(parts.reduce((a, p) => a + (p.amount || 0), 0) * 100) / 100, parts, conditions: mine.conditions };
    } catch { incentive = null; }
  }
  const dayNo = Math.floor((Date.parse(uaeDay()) - Date.parse(start)) / 864e5) + 1;
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  const cross_sell = CROSS_SELL_VIEWERS.includes(user.role) ? crossSellFor(db, scope, params, start, end) : null;
  const contribution = ['business_head', 'mis'].includes(user.role) ? contributionFor(db, scope, params, start, end) : null;
  return { cycle, label: cycleLabel(cycle), start, end, day: dayNo, days, days_left: Math.max(0, days - dayNo), files, trend, incentive, cross_sell, contribution, follow_ups: followUps(db, user) };
}
