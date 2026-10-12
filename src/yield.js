// Personal loan yield: the average interest rate on the personal loans a person disbursed,
// weighted by the amount disbursed. A 300,000 loan at 5% and a 100,000 loan at 9% yield 6.00%.
// Shown for each sales person, team leader, sales manager and ASM, each region and overall,
// against the minimum the business asks for. Only loans on files completed in the period count,
// at the amount actually disbursed and the rate on the file.
import { caseProducts, caseScope, COMPLETED_IN_SQL } from './cases.js';
import { cycleRange } from './cycles.js';

export const PL_MIN_YIELD = 8.49; // % a year, the floor every level is measured against

export const LOAN_TYPES = { fresh: 'Fresh', top_up: 'Top-up', buy_out: 'Buy-out' };
export const YIELD_LEVELS = { overall: 'Overall', region: 'Region', sales_manager: 'Sales manager', asm: 'ASM', team_leader: 'Team leader', staff: 'Sales staff' };

const yieldRound = (n) => Math.round(n * 100) / 100;

/** The disbursed personal loans in the viewer's scope for the period: amount, rate, type and who sourced them. */
export function disbursedLoans(db, user, { from, to, region = null }) {
  const where = [COMPLETED_IN_SQL, `(c.product = 'personal_loan' OR (c.product = 'bundle' AND ',' || c.bundle_products || ',' LIKE '%,personal_loan,%'))`, 'c.pl_disbursed_amount > 0'];
  const params = [from, to];
  const scope = caseScope(user);
  if (scope) { where.push(scope.sql); params.push(...scope.params); }
  if (region) { where.push('c.region = ?'); params.push(region); }
  const rows = db.prepare(`SELECT c.id, c.region, c.personal_loan_type, c.buyout_bank, c.pl_disbursed_amount, c.interest_rate, c.product, c.bundle_products,
      COALESCE(c.sales_staff_id, c.created_by) AS staff_id, s.name AS staff_name, s.sales_code,
      c.team_leader_id, tl.name AS team_leader_name, c.sales_manager_id, sm.name AS sales_manager_name, c.asm_id, asm.name AS asm_name,
      s.region AS staff_region, tl.region AS tl_region, sm.region AS sm_region, asm.region AS asm_region
    FROM cases c
      LEFT JOIN users s ON s.id = COALESCE(c.sales_staff_id, c.created_by)
      LEFT JOIN users tl ON tl.id = c.team_leader_id LEFT JOIN users sm ON sm.id = c.sales_manager_id LEFT JOIN users asm ON asm.id = c.asm_id
    WHERE ${where.join(' AND ')} ORDER BY c.id`).all(...params);
  return rows.filter((c) => caseProducts(c).includes('personal_loan')).map((c) => ({
    id: c.id, region: c.region || '', type: LOAN_TYPES[c.personal_loan_type] ? c.personal_loan_type : 'fresh',
    disbursed: Number(c.pl_disbursed_amount) || 0, rate: c.interest_rate == null ? null : Number(c.interest_rate),
    staff_id: c.staff_id, staff_name: c.staff_name || '', sales_code: c.sales_code || '',
    team_leader_id: c.team_leader_id, team_leader_name: c.team_leader_name || '', sales_manager_id: c.sales_manager_id, sales_manager_name: c.sales_manager_name || '', asm_id: c.asm_id, asm_name: c.asm_name || '',
    // A person's own region, for the rows about them (a team may have files in both regions).
    staff_region: c.staff_region || c.region || '', tl_region: c.tl_region || c.region || '', sm_region: c.sm_region || c.region || '', asm_region: c.asm_region || c.region || '',
  }));
}

/** The figures for one set of loans: files, amounts, the weighted yield and the yield per loan type. */
export function yieldOf(loans, min = PL_MIN_YIELD) {
  const rated = loans.filter((l) => l.rate != null);
  const disbursed = loans.reduce((n, l) => n + l.disbursed, 0);
  const ratedAmount = rated.reduce((n, l) => n + l.disbursed, 0);
  const interest = rated.reduce((n, l) => n + (l.disbursed * l.rate) / 100, 0);
  const yieldPct = ratedAmount ? yieldRound((interest / ratedAmount) * 100) : null;
  const byType = {};
  for (const t of Object.keys(LOAN_TYPES)) {
    const of = rated.filter((l) => l.type === t);
    const amt = of.reduce((n, l) => n + l.disbursed, 0);
    byType[t] = amt ? yieldRound((of.reduce((n, l) => n + (l.disbursed * l.rate) / 100, 0) / amt) * 100) : null;
  }
  const buyOutAmount = loans.filter((l) => l.type === 'buy_out').reduce((n, l) => n + l.disbursed, 0);
  return {
    files: loans.length, disbursed: yieldRound(disbursed), interest_aed: yieldRound(interest), yield_pct: yieldPct,
    fresh_pct: byType.fresh, top_up_pct: byType.top_up, buy_out_pct: byType.buy_out,
    buy_out_share_pct: disbursed ? yieldRound((buyOutAmount / disbursed) * 100) : null,
    vs_min: yieldPct == null ? null : yieldRound(yieldPct - min), below_min: yieldPct != null && yieldPct < min,
    unrated: loans.length - rated.length,
  };
}

function group(loans, keyOf, make) {
  const map = new Map();
  for (const l of loans) {
    const k = keyOf(l);
    if (k == null || k === '') continue;
    if (!map.has(k)) map.set(k, { ...make(l), loans: [] });
    map.get(k).loans.push(l);
  }
  return [...map.values()].map(({ loans: list, ...row }) => ({ ...row, ...yieldOf(list) }));
}

const byRegionThenYield = (a, b) => a.region.localeCompare(b.region) || (b.yield_pct ?? -1) - (a.yield_pct ?? -1) || a.name.localeCompare(b.name);

/**
 * Every level in one list: overall, each region, sales managers, ASMs, team leaders and sales
 * staff, each with files, disbursed, yield, yield per loan type, the buy-out share and the gap to
 * the minimum. Levels the viewer's scope has no files in are left out.
 */
export function plYieldRows(db, user, { from, to, region = null }) {
  const loans = disbursedLoans(db, user, { from, to, region });
  const rows = [];
  rows.push({ level: 'overall', name: 'Overall', region: '', ...yieldOf(loans) });
  rows.push(...group(loans, (l) => l.region, (l) => ({ level: 'region', name: l.region, region: l.region })).sort(byRegionThenYield));
  rows.push(...group(loans, (l) => l.sales_manager_id, (l) => ({ level: 'sales_manager', name: l.sales_manager_name, region: l.sm_region, manager: l.sales_manager_name })).sort(byRegionThenYield));
  rows.push(...group(loans, (l) => l.asm_id, (l) => ({ level: 'asm', name: l.asm_name, region: l.asm_region, manager: l.asm_name })).sort(byRegionThenYield));
  rows.push(...group(loans, (l) => l.team_leader_id, (l) => ({ level: 'team_leader', name: l.team_leader_name, region: l.tl_region, manager: l.sales_manager_name, team_leader: l.team_leader_name })).sort(byRegionThenYield));
  rows.push(...group(loans, (l) => l.staff_id, (l) => ({ level: 'staff', name: l.staff_name, region: l.staff_region, manager: l.sales_manager_name, team_leader: l.team_leader_name, staff: l.staff_name, sales_code: l.sales_code })).sort(byRegionThenYield));
  return rows;
}

/**
 * The dashboard tile: the viewer's own yield for the cycle (their files, team or teams, or the
 * whole business) and who below them is under the minimum.
 */
export function plYieldFor(db, user, cycle, { region = null } = {}) {
  const { start, end } = cycleRange(cycle);
  const rows = plYieldRows(db, user, { from: start, to: end, region });
  const overall = rows[0];
  if (!overall.files && user.core_product !== 'personal_loan' && !['team_leader', 'sales_manager', 'asm', 'business_head', 'mis'].includes(user.role)) return null;
  // What the viewer manages directly: a team leader their staff, a manager their team leaders, the business its team leaders.
  const level = { team_leader: 'staff', sales_manager: 'team_leader', asm: 'team_leader', business_head: 'team_leader', mis: 'team_leader' }[user.role];
  const members = level ? rows.filter((r) => r.level === level) : [];
  return {
    min: PL_MIN_YIELD, cycle, level: user.role === 'sales' ? 'you' : user.role,
    ...overall,
    members: members.map((m) => ({ name: m.name, region: m.region, files: m.files, disbursed: m.disbursed, yield_pct: m.yield_pct, vs_min: m.vs_min, below_min: m.below_min })),
    below: members.filter((m) => m.below_min).length,
    member_label: level ? YIELD_LEVELS[level] : null,
  };
}
