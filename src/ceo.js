// The CEO dashboard: one screen with the business's headline numbers for a cycle, drawn from the
// modules that already compute them. Revenue and net from the profit and loss, production against
// target, personal loan yield, payout lost to cards sold below eligibility, the pipeline, staff on
// zero, each region side by side, and the last six cycles. Business heads only (a CEO account is a
// business head, or a role based on one).
import { REGIONS, COMPLETED_IN_SQL, WorkflowError, NO_VALID_COMPLAINT_SQL } from './cases.js';
import { cycleRange, cycleLabel, cycleOf, uaeDay, isCycle, shiftCycle } from './cycles.js';
import { profitAndLoss, PNL_VIEWERS } from './pnl.js';
import { targetReport, TARGET_PRODUCTS, TARGET_UNITS } from './performance.js';
import { plYieldFor, PL_MIN_YIELD } from './yield.js';
import { contributionFor, zeroStaff, TREND_CYCLES } from './dashboard.js';
import { runReport } from './reports.js';

const ceoRound = (n) => Math.round((n || 0) * 100) / 100;
const ceoPct = (a, of) => (of ? Math.round((a / of) * 1000) / 10 : null);
const change = (now, before) => ({ now: ceoRound(now), before: ceoRound(before), delta: ceoRound(now - before), pct: before ? Math.round(((now - before) / Math.abs(before)) * 1000) / 10 : null });

export function ceoDashboard(db, user, { cycle, region } = {}) {
  if (!PNL_VIEWERS.includes(user.role)) throw new WorkflowError(403, 'The CEO dashboard is for the business head');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-10');
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const reg = region ? r : null;
  const { start, end } = cycleRange(cycle);
  const prev = shiftCycle(cycle, -1);
  const scope = reg ? 'AND c.region = ?' : '';
  const params = reg ? [reg] : [];

  // Money: the bank's payout, costs and net, this cycle against last.
  const pnl = profitAndLoss(db, user, { cycle, region: reg });
  const last = profitAndLoss(db, user, { cycle: prev, region: reg });
  const money = {
    revenue: change(pnl.revenue.total, last.revenue.total), costs: change(pnl.costs, last.costs), net: change(pnl.net, last.net),
    margin_pct: pnl.margin_pct, margin_before_pct: last.margin_pct, salaries: ceoRound(pnl.salaries + pnl.salaries_estimated), incentives: pnl.incentives,
    by_product: pnl.revenue.by_product, files: change(pnl.revenue.files, last.revenue.files), without_upload: pnl.without_upload,
  };

  // Production against target, per product, over the whole sales force in scope.
  const t = targetReport(db, user, cycle, { region: reg });
  const production = Object.keys(TARGET_PRODUCTS).map((p) => {
    const target = t.total.target[p] || 0; const achieved = ceoRound(t.total.achieved[p] || 0);
    return { product: p, label: TARGET_PRODUCTS[p], unit: TARGET_UNITS[p], target, achieved, files: t.total.cases[p] || 0, pct: ceoPct(achieved, target) };
  }).filter((x) => x.target || x.achieved);
  const cards = t.total.cards;

  // Personal loan yield against the minimum.
  const y = plYieldFor(db, user, cycle, { region: reg });
  const yieldInfo = y ? { yield_pct: y.yield_pct, min: PL_MIN_YIELD, vs_min: y.vs_min, below_min: y.below_min, files: y.files, disbursed: y.disbursed, below: y.below, members: y.members.length } : null;

  // Revenue lost to cards sold below what the salary qualified for (files sourced in the cycle).
  const down = runReport(db, user, 'card_downsell', { cycle, region: reg });
  const loss = { files: down.rows.length, points_lost: down.totals.points_lost || 0, payout_lost: ceoRound(down.totals.payout_lost || 0), payout_possible: ceoRound(down.totals.payout_possible || 0) };

  // The pipeline today, and the cycle's flow.
  const count = (sql, ...p) => db.prepare(`SELECT COUNT(*) AS n FROM cases c WHERE ${sql} ${scope}`).get(...p, ...params).n;
  const sourced = (a, b) => count("COALESCE(c.sourcing_date, date(c.created_at, '+4 hours')) BETWEEN ? AND ?", a, b);
  const completed = (a, b) => count(COMPLETED_IN_SQL, a, b);
  const pipeline = {
    sourced: change(sourced(start, end), sourced(...Object.values(cycleRange(prev)))),
    completed: completed(start, end),
    rejected: count("c.case_status = 'rejected' AND date(c.case_status_at, '+4 hours') BETWEEN ? AND ?", start, end),
    awaiting_approval: count("c.status = 'awaiting_approval'"),
    in_verification: count("c.status IN ('pending_verification', 'in_verification')"),
    verification_pending: count("c.status = 'incomplete'"),
    returned: count("c.status = 'returned_to_sales'"),
    open: count("c.case_status NOT IN ('completed', 'rejected')"),
    dncr: count("c.incomplete_reason = 'customer_in_dncr' AND c.status IN ('incomplete', 'rejected', 'returned_to_sales')"),
  };
  pipeline.conversion_pct = ceoPct(pipeline.completed, pipeline.sourced.now);
  const trend = [];
  for (let i = TREND_CYCLES - 1; i >= 0; i--) {
    const c = shiftCycle(cycle, -i); const cr = cycleRange(c);
    const done = db.prepare(`SELECT c.* FROM cases c WHERE ${COMPLETED_IN_SQL} ${scope}`).all(cr.start, cr.end, ...params);
    trend.push({ cycle: c, label: cycleLabel(c), sourced: sourced(cr.start, cr.end), completed: done.length });
  }

  // People: staff on zero, core team against cross-sell, headcount.
  const zero = zeroStaff(db, user, cycle, { region: reg });
  const contribution = contributionFor(db, scope, params, start, end);
  const headcount = db.prepare(`SELECT role, COUNT(*) AS n FROM users WHERE active = 1 ${reg ? 'AND region = ?' : ''} GROUP BY role`).all(...params);
  const people = { sales: 0, leaders: 0, processing: 0, other: 0 };
  for (const h of headcount) { if (h.role === 'sales') people.sales += h.n; else if (['team_leader', 'asm', 'sales_manager'].includes(h.role)) people.leaders += h.n; else if (h.role === 'processing') people.processing += h.n; else people.other += h.n; }

  // Governance: complaints found valid this cycle, files with a complaint, call recordings requested.
  const governance = {
    complaints: count("c.complaint_number IS NOT NULL AND c.complaint_number <> '' AND date(COALESCE(c.complaint_at, c.updated_at), '+4 hours') BETWEEN ? AND ?", start, end),
    valid_complaints: count(`NOT (${NO_VALID_COMPLAINT_SQL}) AND date(c.complaint_decided_at, '+4 hours') BETWEEN ? AND ?`, start, end),
    deviations: count("c.card_salary_exception IS NOT NULL AND c.card_salary_exception <> '' AND c.sourcing_date BETWEEN ? AND ?", start, end),
  };

  // Each region side by side (only without a region filter).
  const regions = reg ? [] : Object.keys(REGIONS).map((k) => {
    const p = profitAndLoss(db, user, { cycle, region: k });
    const yk = plYieldFor(db, user, cycle, { region: k });
    const z = zeroStaff(db, user, cycle, { region: k });
    const tr = t.by_region?.find((x) => String(x.name).toUpperCase() === k);
    const ach = tr ? Object.keys(TARGET_PRODUCTS).map((pr) => ({ product: pr, pct: ceoPct(tr.achieved[pr] || 0, tr.target[pr] || 0) })).filter((x) => x.pct != null) : [];
    return {
      region: k, label: REGIONS[k], revenue: p.revenue.total, files: p.revenue.files, costs: p.costs, net: p.net, margin_pct: p.margin_pct,
      yield_pct: yk?.yield_pct ?? null, yield_below_min: yk?.below_min ?? false, staff: z.team, zero_ends_pct: z.zero_ends.pct, zero_submissions_pct: z.zero_submissions.pct,
      achievement: ach,
    };
  }).filter((x) => x.files || x.staff || x.revenue);

  return {
    cycle, label: cycleLabel(cycle), start, end, previous: { cycle: prev, label: cycleLabel(prev) }, region: reg, is_current: cycle === cycleOf(uaeDay()), days_left: t.days_left,
    money, production, cards, yield: yieldInfo, loss, pipeline, trend, zero: { team: zero.team, zero_ends: { count: zero.zero_ends.count, pct: zero.zero_ends.pct }, zero_submissions: { count: zero.zero_submissions.count, pct: zero.zero_submissions.pct }, by_product: zero.by_product.map((b) => ({ product: b.product, label: b.label, team: b.team, zero_ends_pct: b.zero_ends.pct, zero_submissions_pct: b.zero_submissions.pct })) },
    contribution, people, governance, regions,
  };
}
