// Each user's own dashboard: what they (or their team, or the agency) did this cycle and over the
// last six, with the incentive so far for the people who earn one. Everything is within the
// viewer's case scope, so a sales person sees their files, a leader their team's, MIS everything.
import { caseScope, caseProducts, REGIONS, STATUS, COMPLETED_IN_SQL, TEAM_FIELDS } from './cases.js';
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
  const rows = db.prepare(`SELECT c.product, c.bundle_products, c.credit_card, c.card_category, c.card_points, c.pl_disbursed_amount, c.al_disbursed_amount, u.core_product
    FROM cases c LEFT JOIN users u ON u.id = COALESCE(c.sales_staff_id, c.created_by)
    WHERE ${COMPLETED_IN_SQL} ${scope}`).all(start, end, ...params);
  const amountOf = { credit_card: (r) => r.card_points ?? 1, personal_loan: (r) => r.pl_disbursed_amount ?? 0, auto_loan: (r) => r.al_disbursed_amount ?? 0 };
  const units = { credit_card: 'points', personal_loan: 'aed', auto_loan: 'aed' };
  const cardMix = () => ({ Mass: 0, Premium: 0, 'Super Premium': 0, noon: 0, other: 0 });
  const out = CROSS_SELL_PRODUCTS.map((p) => ({ product: p, label: STAFF_CORE_PRODUCTS[p], unit: units[p], core: { files: 0, amount: 0, ...(p === 'credit_card' && { cards: cardMix() }) }, cross: { files: 0, amount: 0, ...(p === 'credit_card' && { cards: cardMix() }) } }));
  for (const r of rows) {
    const sold = new Set(caseProducts(r).filter((p) => CROSS_SELL_PRODUCTS.includes(p)));
    if (sold.has('credit_card') && !r.credit_card) sold.delete('credit_card');
    for (const p of sold) {
      const side = !r.core_product || r.core_product === p || r.core_product === 'multi_product' ? 'core' : 'cross';
      const cell = out.find((x) => x.product === p)[side];
      cell.files++;
      cell.amount += amountOf[p](r);
      // Cards by category, so the breakdown can say how many Mass, Premium and Super Premium.
      if (p === 'credit_card') cell.cards[/\bnoon\b/i.test(r.credit_card) ? 'noon' : cell.cards[r.card_category] != null ? r.card_category : 'other']++;
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

// Submission calendar thresholds for leaders: the share of the team that sourced a file on the day.
export const CALENDAR_GREEN_PCT = 70;
export const CALENDAR_ORANGE_PCT = 50;
export const CALENDAR_ROLES = ['sales', ...TEAM_LEADER_ROLES];

/**
 * One cell per day of the cycle up to today. A sales person's day is green when they sourced a file
 * and red when not; a leader's day is green when 70% or more of the team sourced one, orange from
 * 50%, red below. Saturday is a working day; a Sunday with nothing sourced is the day off, not red.
 * Days still to come are blank.
 */
export function submissionCalendar(db, user, scope, params, cycle) {
  const { start, end } = cycleRange(cycle);
  const today = uaeDay();
  const dayOf = "COALESCE(c.sourcing_date, date(c.created_at, '+4 hours'))";
  const rows = db.prepare(`SELECT ${dayOf} AS day, COUNT(*) AS files, COUNT(DISTINCT COALESCE(c.sales_staff_id, c.created_by)) AS staff
    FROM cases c WHERE ${dayOf} BETWEEN ? AND ? ${scope} GROUP BY day`).all(start, end, ...params);
  const byDay = new Map(rows.map((r) => [r.day, r]));
  const leader = TEAM_LEADER_ROLES.includes(user.role);
  const team = leader ? db.prepare(`SELECT COUNT(*) AS n FROM users u WHERE u.role = 'sales' AND u.active = 1 AND u.${TEAM_FIELDS[user.role]} = ?`).get(user.id).n : null;
  const days = [];
  for (let ms = Date.parse(start); ms <= Date.parse(end); ms += 864e5) {
    const date = new Date(ms).toISOString().slice(0, 10);
    const dow = new Date(ms).getUTCDay();
    const r = byDay.get(date);
    const files = r?.files ?? 0; const staff = r?.staff ?? 0;
    let status;
    if (date > today) status = 'future';
    else if (leader) {
      const pct = team ? Math.round((staff / team) * 1000) / 10 : null;
      status = pct == null ? 'none' : pct >= CALENDAR_GREEN_PCT ? 'green' : pct >= CALENDAR_ORANGE_PCT ? 'orange' : dow === 0 && !files ? 'off' : 'red';
      days.push({ date, dow, files, staff, team, pct, status });
      continue;
    } else status = files ? 'green' : dow === 0 ? 'off' : 'red';
    days.push({ date, dow, files, status });
  }
  const counted = days.filter((d) => !['future', 'off', 'none'].includes(d.status));
  return { cycle, start, end, today, team, days, summary: { green: counted.filter((d) => d.status === 'green').length, orange: counted.filter((d) => d.status === 'orange').length, red: counted.filter((d) => d.status === 'red').length, days: counted.length } };
}

/**
 * The leader's sales staff with nothing to show this cycle: zero ends or disbursals (no file of
 * theirs completed in the cycle) and zero submissions (no file sourced in the cycle), each as a
 * count, a share of the active team, and the names. Business heads and MIS see every sales person,
 * narrowed by the region filter when one is set.
 */
export function zeroStaff(db, user, cycle, { region } = {}) {
  const { start, end } = cycleRange(cycle);
  const field = TEAM_FIELDS[user.role];
  const where = field ? `u.${field} = ?` : REGIONS[String(region || '').toUpperCase()] ? 'u.region = ?' : '1 = 1';
  const args = field ? [user.id] : REGIONS[String(region || '').toUpperCase()] ? [String(region).toUpperCase()] : [];
  const staff = db.prepare(`SELECT u.id, u.name, u.sales_code, u.region, u.core_product, tl.name AS team_leader,
      (SELECT COUNT(*) FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = u.id AND COALESCE(c.sourcing_date, date(c.created_at, '+4 hours')) BETWEEN ? AND ?) AS sourced,
      (SELECT COUNT(*) FROM cases c WHERE COALESCE(c.sales_staff_id, c.created_by) = u.id AND ${COMPLETED_IN_SQL}) AS completed
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id
    WHERE u.role = 'sales' AND u.active = 1 AND ${where} ORDER BY u.name`).all(start, end, start, end, ...args);
  const pick = (list) => ({ count: list.length, pct: staff.length ? Math.round((list.length / staff.length) * 1000) / 10 : null, staff: list.map(({ id, name, sales_code, region, team_leader, sourced, completed }) => ({ id, name, sales_code, region, team_leader, sourced, completed })) });
  return { cycle, team: staff.length, zero_ends: pick(staff.filter((s) => !s.completed)), zero_submissions: pick(staff.filter((s) => !s.sourced)) };
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
      const blocks = mine.incentive ? [{ type: mine.type, incentive: mine.incentive }] : [...(mine.teams || []), ...(mine.products || [])];
      const parts = blocks.map((t) => ({ type: t.type, amount: t.incentive.incentive_aed ?? 0, potential: t.incentive.potential?.incentive_aed ?? null, open_files: t.incentive.potential?.open_files ?? 0 }));
      if (parts.length) {
        // What the open files would add if they all completed (sales staff schemes carry a projection).
        const withPotential = parts.filter((p) => p.potential != null);
        const potential = withPotential.length ? Math.round(withPotential.reduce((a, p) => a + p.potential, 0) * 100) / 100 : null;
        const open_files = Math.max(0, ...parts.map((p) => p.open_files));
        incentive = { total: Math.round(parts.reduce((a, p) => a + (p.amount || 0), 0) * 100) / 100, parts, conditions: mine.conditions, potential, open_files };
      }
    } catch { incentive = null; }
  }
  const dayNo = Math.floor((Date.parse(uaeDay()) - Date.parse(start)) / 864e5) + 1;
  const days = Math.floor((Date.parse(end) - Date.parse(start)) / 864e5) + 1;
  const cross_sell = CROSS_SELL_VIEWERS.includes(user.role) ? crossSellFor(db, scope, params, start, end) : null;
  const contribution = ['business_head', 'mis'].includes(user.role) ? contributionFor(db, scope, params, start, end) : null;
  const calendar = CALENDAR_ROLES.includes(user.role) ? submissionCalendar(db, user, scope, params, cycle) : null;
  const zero = [...TEAM_LEADER_ROLES, 'business_head', 'mis'].includes(user.role) ? zeroStaff(db, user, cycle, { region }) : null;
  return { cycle, label: cycleLabel(cycle), start, end, day: dayNo, days, days_left: Math.max(0, days - dayNo), files, trend, incentive, cross_sell, contribution, calendar, zero, follow_ups: followUps(db, user) };
}
