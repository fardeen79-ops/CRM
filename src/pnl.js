// Profit and loss per sales cycle: the bank's payout on completed files, less the salaries actually
// paid (uploaded per person per cycle) and the incentives earned under the schemes, by role. The
// business head and the CEO see it; nobody else.
import { REGIONS, COMPLETED_IN_SQL, WorkflowError } from './cases.js';
import { cycleRange, cycleLabel, cycleOf, uaeDay, isCycle } from './cycles.js';
import { payoutFor } from './payouts.js';
import { incentiveRows, plIncentiveRows, alIncentiveRows, tlIncentiveRows, plTlIncentiveRows, ccSmIncentiveRows, plSmIncentiveRows } from './incentives.js';

export const PNL_VIEWERS = ['business_head'];
export const PNL_ROLES = { sales: 'Sales staff', team_leader: 'Team leaders', asm: 'Assistant sales managers', sales_manager: 'Sales managers', business_head: 'Business heads', processing: 'Processing', mis: 'MIS', governance: 'Governance', it: 'IT' };
const round = (n) => Math.round((n || 0) * 100) / 100;

/** The salaries actually paid for a cycle, per person: uploaded by the business head or Dubai MIS. */
export function payrollFor(db, cycle, region = null) {
  const r = String(region || '').toUpperCase();
  return db.prepare(`SELECT p.*, u.name, u.role, u.region, u.hrms_code, u.salary AS profile_salary FROM payroll p JOIN users u ON u.id = p.user_id WHERE p.cycle = ?${region ? ' AND u.region = ?' : ''} ORDER BY u.role, u.name`).all(...(region ? [cycle, r] : [cycle]));
}

/** The statement for a cycle: revenue, salaries and incentives by role, and the net. */
export function profitAndLoss(db, user, { cycle, region } = {}) {
  if (!PNL_VIEWERS.includes(user.role)) throw new WorkflowError(403, 'The profit and loss is for the business head');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-10');
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const { start, end } = cycleRange(cycle);
  // Revenue: the bank's payout on files completed in the cycle, by product.
  const done = db.prepare(`SELECT c.* FROM cases c WHERE ${COMPLETED_IN_SQL}${region ? ' AND c.region = ?' : ''}`).all(...(region ? [start, end, r] : [start, end]));
  const revenue = { total: 0, files: done.length, by_product: { credit_card: 0, personal_loan: 0, auto_loan: 0, accounts: 0 } };
  for (const c of done) {
    const p = payoutFor(c);
    revenue.total += p.total;
    for (const part of p.parts || []) if (revenue.by_product[part.product] != null) revenue.by_product[part.product] += part.payout || 0;
  }
  revenue.total = round(revenue.total);
  for (const k of Object.keys(revenue.by_product)) revenue.by_product[k] = round(revenue.by_product[k]);
  // Salaries: uploaded for the cycle; anyone active without an upload is estimated from the profile salary.
  const staff = db.prepare(`SELECT id, name, role, region, salary FROM users WHERE active = 1${region ? ' AND region = ?' : ''}`).all(...(region ? [r] : []));
  const paid = new Map(payrollFor(db, cycle, region).map((p) => [p.user_id, p]));
  const lines = {};
  for (const role of Object.keys(PNL_ROLES)) lines[role] = { role, label: PNL_ROLES[role], staff: 0, salary_paid: 0, salary_estimated: 0, without_upload: 0, incentive_computed: 0, incentive_paid: 0, incentive_override: 0 };
  for (const s of staff) {
    const line = lines[s.role]; if (!line) continue;
    line.staff++;
    const p = paid.get(s.id);
    if (p) line.salary_paid += p.salary_paid || 0;
    else { line.without_upload++; line.salary_estimated += s.salary || 0; }
  }
  // Incentives: computed under the schemes for the cycle, per person; an uploaded actual overrides it.
  const byUser = new Map();
  const add = (name, role, amount, key) => { const k = key || `${role}:${name}`; byUser.set(k, (byUser.get(k) || 0) + (amount || 0)); };
  for (const x of incentiveRows(db, cycle, region)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of plIncentiveRows(db, cycle, region)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of alIncentiveRows(db, cycle, region)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of tlIncentiveRows(db, cycle, region)) add(x.leader, x.role, x.incentive_aed);
  for (const x of plTlIncentiveRows(db, cycle, region)) add(x.leader, x.role, x.incentive_aed);
  for (const x of ccSmIncentiveRows(db, cycle, region)) add(x.manager, x.role, x.incentive_aed);
  for (const x of plSmIncentiveRows(db, cycle, region)) add(x.manager, x.role, x.incentive_aed);
  const nameRole = new Map(staff.map((s) => [`${s.role}:${s.name}`, s]));
  for (const [k, amount] of byUser) {
    const s = nameRole.get(k); if (!s) continue;
    const line = lines[s.role]; if (!line) continue;
    const p = paid.get(s.id);
    if (p && p.incentive_paid != null) { line.incentive_paid += p.incentive_paid; line.incentive_override++; } else line.incentive_paid += amount;
    line.incentive_computed += amount;
  }
  // Uploaded incentives for people the schemes do not cover (business heads, processing, MIS…).
  for (const p of paid.values()) {
    const line = lines[p.role]; if (!line) continue;
    if (p.incentive_paid != null && !byUser.has(`${p.role}:${p.name}`)) { line.incentive_paid += p.incentive_paid; line.incentive_override++; }
  }
  const rows = Object.values(lines).filter((l) => l.staff || l.salary_paid || l.incentive_paid).map((l) => ({ ...l, salary_paid: round(l.salary_paid), salary_estimated: round(l.salary_estimated), incentive_computed: round(l.incentive_computed), incentive_paid: round(l.incentive_paid), cost: round(l.salary_paid + l.salary_estimated + l.incentive_paid) }));
  const salaries = round(rows.reduce((n, l) => n + l.salary_paid, 0));
  const estimated = round(rows.reduce((n, l) => n + l.salary_estimated, 0));
  const incentives = round(rows.reduce((n, l) => n + l.incentive_paid, 0));
  const costs = round(salaries + estimated + incentives);
  const net = round(revenue.total - costs);
  return {
    cycle, label: cycleLabel(cycle), start, end, region: region ? r : null,
    revenue, salaries, salaries_estimated: estimated, without_upload: rows.reduce((n, l) => n + l.without_upload, 0), incentives, costs, net,
    margin_pct: revenue.total ? Math.round((net / revenue.total) * 1000) / 10 : null, rows, uploaded_people: paid.size,
  };
}
