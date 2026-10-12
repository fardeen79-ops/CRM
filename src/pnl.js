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

const LEADER_ROLES = ['team_leader', 'sales_manager', 'asm'];
const regionKey = (code) => (REGIONS[String(code || '').toUpperCase()] ? String(code).toUpperCase() : 'NONE');

/**
 * How each person's cost is split across regions. A sales executive (SE) belongs to their own
 * region. Everyone else is split by SE count: a team leader, ASM or sales manager by the regions of
 * the SEs under them; business heads, processing, MIS, governance and IT (and a leader with no SEs)
 * by the SE count of each region across the business. Someone with no SEs to follow stays in their
 * own region. Returns (person) => [[regionKey, share], …] with the shares summing to 1.
 */
export function regionShares(people) {
  const byLeader = new Map(); const total = new Map();
  const bump = (map, key, region) => { if (!map.has(key)) map.set(key, new Map()); const m = map.get(key); m.set(region, (m.get(region) || 0) + 1); };
  for (const p of people) {
    if (p.role !== 'sales') continue;
    const region = regionKey(p.region);
    total.set(region, (total.get(region) || 0) + 1);
    for (const id of [p.team_leader_id, p.sales_manager_id, p.asm_id]) if (id) bump(byLeader, id, region);
  }
  const shares = (m) => { const n = [...m.values()].reduce((a, b) => a + b, 0); return [...m].map(([k, v]) => [k, v / n]); };
  return (p) => {
    if (p.role === 'sales') return [[regionKey(p.region), 1]];
    const own = LEADER_ROLES.includes(p.role) ? byLeader.get(p.id) : null;
    if (own && own.size) return shares(own);
    if (total.size) return shares(total);
    return [[regionKey(p.region), 1]];
  };
}

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
  // Salaries: uploaded for the cycle; anyone active without an upload is estimated from the profile
  // salary. For one region, a non-sales person's costs count at their share for that region (by SE count).
  const everyone = db.prepare('SELECT id, name, role, region, salary, team_leader_id, sales_manager_id, asm_id FROM users WHERE active = 1').all();
  const sharesOf = regionShares(everyone);
  const weightOf = (p) => (region ? (sharesOf(p).find(([k]) => k === r)?.[1] || 0) : 1);
  const staff = everyone.map((p) => ({ ...p, weight: weightOf(p) })).filter((p) => p.weight > 0);
  const paid = new Map(payrollFor(db, cycle, null).map((p) => [p.user_id, p]));
  const lines = {};
  for (const role of Object.keys(PNL_ROLES)) lines[role] = { role, label: PNL_ROLES[role], staff: 0, salary_paid: 0, salary_estimated: 0, without_upload: 0, incentive_computed: 0, incentive_paid: 0, incentive_override: 0 };
  for (const s of staff) {
    const line = lines[s.role]; if (!line) continue;
    line.staff += s.weight;
    const p = paid.get(s.id);
    if (p) line.salary_paid += (p.salary_paid || 0) * s.weight;
    else { line.without_upload += s.weight; line.salary_estimated += (s.salary || 0) * s.weight; }
  }
  // Incentives: computed under the schemes for the cycle, per person; an uploaded actual overrides it.
  const byUser = new Map();
  const add = (name, role, amount, key) => { const k = key || `${role}:${name}`; byUser.set(k, (byUser.get(k) || 0) + (amount || 0)); };
  for (const x of incentiveRows(db, cycle, null)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of plIncentiveRows(db, cycle, null)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of alIncentiveRows(db, cycle, null)) add(x.staff, 'sales', x.incentive_aed);
  for (const x of tlIncentiveRows(db, cycle, null)) add(x.leader, x.role, x.incentive_aed);
  for (const x of plTlIncentiveRows(db, cycle, null)) add(x.leader, x.role, x.incentive_aed);
  for (const x of ccSmIncentiveRows(db, cycle, null)) add(x.manager, x.role, x.incentive_aed);
  for (const x of plSmIncentiveRows(db, cycle, null)) add(x.manager, x.role, x.incentive_aed);
  const nameRole = new Map(staff.map((s) => [`${s.role}:${s.name}`, s]));
  for (const [k, amount] of byUser) {
    const s = nameRole.get(k); if (!s) continue;
    const line = lines[s.role]; if (!line) continue;
    const p = paid.get(s.id);
    if (p && p.incentive_paid != null) { line.incentive_paid += p.incentive_paid * s.weight; line.incentive_override += s.weight; } else line.incentive_paid += amount * s.weight;
    line.incentive_computed += amount * s.weight;
  }
  // Uploaded incentives for people the schemes do not cover (business heads, processing, MIS…).
  for (const p of paid.values()) {
    const line = lines[p.role]; if (!line) continue;
    const s = staff.find((x) => x.id === p.user_id); if (!s) continue;
    if (p.incentive_paid != null && !byUser.has(`${p.role}:${p.name}`)) { line.incentive_paid += p.incentive_paid * s.weight; line.incentive_override += s.weight; }
  }
  const rows = Object.values(lines).filter((l) => l.staff || l.salary_paid || l.incentive_paid).map((l) => ({ ...l, staff: round(l.staff), without_upload: round(l.without_upload), incentive_override: round(l.incentive_override), salary_paid: round(l.salary_paid), salary_estimated: round(l.salary_estimated), incentive_computed: round(l.incentive_computed), incentive_paid: round(l.incentive_paid), cost: round(l.salary_paid + l.salary_estimated + l.incentive_paid) }));
  const salaries = round(rows.reduce((n, l) => n + l.salary_paid, 0));
  const estimated = round(rows.reduce((n, l) => n + l.salary_estimated, 0));
  const incentives = round(rows.reduce((n, l) => n + l.incentive_paid, 0));
  const costs = round(salaries + estimated + incentives);
  const net = round(revenue.total - costs);
  return {
    cycle, label: cycleLabel(cycle), start, end, region: region ? r : null,
    revenue, salaries, salaries_estimated: estimated, without_upload: round(rows.reduce((n, l) => n + l.without_upload, 0)), incentives, costs, net,
    margin_pct: revenue.total ? Math.round((net / revenue.total) * 1000) / 10 : null, rows, uploaded_people: staff.filter((x) => paid.has(x.id)).length,
  };
}

/** The incentive each person earns in the cycle under the schemes, by user id, with an uploaded actual overriding it. */
function incentiveByUser(db, cycle, region, paid) {
  const out = new Map();
  const add = (x) => out.set(x.user_id, (out.get(x.user_id) || 0) + (x.incentive_aed || 0));
  for (const fn of [incentiveRows, plIncentiveRows, alIncentiveRows, tlIncentiveRows, plTlIncentiveRows, ccSmIncentiveRows, plSmIncentiveRows]) for (const x of fn(db, cycle, region)) add(x);
  for (const p of paid.values()) if (p.incentive_paid != null) out.set(p.user_id, p.incentive_paid);
  return out;
}
const OVERHEAD_ROLES = ['business_head', 'processing', 'mis', 'governance', 'it'];

/** The statement by region and hierarchy: region → sales manager → team leader → staff, overheads at region level. */
export function profitAndLossTree(db, user, { cycle, region } = {}) {
  if (!PNL_VIEWERS.includes(user.role)) throw new WorkflowError(403, 'The profit and loss is for the business head');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-10');
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const { start, end } = cycleRange(cycle);
  const people = db.prepare('SELECT id, name, role, role_key, region, salary, team_leader_id, sales_manager_id, asm_id, sales_code, hrms_code FROM users WHERE active = 1').all();
  const sharesOf = regionShares(people);
  // A team leader's manager: from their own profile, else the manager most of their SEs report to.
  const leaderManager = (tl) => {
    if (tl.sales_manager_id) return byId.get(tl.sales_manager_id) || null;
    const counts = new Map();
    for (const p of people) if (p.role === 'sales' && p.team_leader_id === tl.id && p.sales_manager_id) counts.set(p.sales_manager_id, (counts.get(p.sales_manager_id) || 0) + 1);
    const best = [...counts].sort((a, b) => b[1] - a[1])[0];
    return best ? byId.get(best[0]) || null : null;
  };
  const byId = new Map(people.map((p) => [p.id, p]));
  const paid = new Map(payrollFor(db, cycle, null).map((p) => [p.user_id, p]));
  const incentives = incentiveByUser(db, cycle, null, paid);
  const node = (key, label, kind, extra = {}) => ({ key, label, kind, revenue: 0, files: 0, salary_paid: 0, salary_estimated: 0, incentives: 0, headcount: 0, without_upload: 0, children: [], ...extra });
  // A person's costs land on a node at their share for that region (1 for a sales executive).
  const costOf = (p, n, share = 1) => {
    const pay = paid.get(p.id);
    n.headcount += share;
    if (pay) n.salary_paid += (pay.salary_paid || 0) * share; else { n.salary_estimated += (p.salary || 0) * share; n.without_upload += share; }
    n.incentives += (incentives.get(p.id) || 0) * share;
  };
  // Regions, each with its managers, and overheads (business heads, processing, MIS, governance, IT) at region level.
  const regions = new Map();
  const regionNode = (code) => {
    const k = REGIONS[code] ? code : 'NONE';
    if (!regions.has(k)) regions.set(k, node(k, REGIONS[k] || 'No region set', 'region', { managers: new Map(), overheads: node(`${k}:oh`, 'Overheads (business heads, processing, MIS, governance, IT)', 'overheads') }));
    return regions.get(k);
  };
  const managerNode = (reg, sm) => {
    const k = sm ? sm.id : 0;
    if (!reg.managers.has(k)) reg.managers.set(k, node(`sm:${k}`, sm ? sm.name : 'No sales manager', 'manager', { leaders: new Map(), person: sm ? { id: sm.id, role: sm.role } : null }));
    return reg.managers.get(k);
  };
  const leaderNode = (mgr, tl) => {
    const k = tl ? tl.id : 0;
    if (!mgr.leaders.has(k)) mgr.leaders.set(k, node(`tl:${k}`, tl ? tl.name : 'No team leader', 'leader', { staff: new Map(), person: tl ? { id: tl.id, role: tl.role } : null }));
    return mgr.leaders.get(k);
  };
  // Sales staff sit under their team leader and sales manager, in their own region.
  for (const p of people.filter((x) => x.role === 'sales')) {
    if (region && regionKey(p.region) !== r) continue;
    const tl = byId.get(p.team_leader_id) || null; const sm = byId.get(p.sales_manager_id) || (tl && byId.get(tl.sales_manager_id)) || null;
    const reg = regionNode(regionKey(p.region));
    const ldr = leaderNode(managerNode(reg, sm), tl);
    const s = node(`u:${p.id}`, p.name, 'staff', { person: { id: p.id, role: p.role, sales_code: p.sales_code } });
    costOf(p, s); ldr.staff.set(p.id, s);
  }
  // Everyone else is split across regions by SE count: a leader by the SEs under them, overheads by
  // the business's SEs. Each share lands on that region's node for the person.
  for (const p of people.filter((x) => x.role !== 'sales')) {
    for (const [k, share] of sharesOf(p)) {
      if (region && k !== r) continue;
      const reg = regionNode(k);
      if (OVERHEAD_ROLES.includes(p.role)) costOf(p, reg.overheads, share);
      else if (p.role === 'sales_manager' || p.role === 'asm') costOf(p, managerNode(reg, p), share);
      else if (p.role === 'team_leader') costOf(p, leaderNode(managerNode(reg, leaderManager(p)), p), share);
    }
  }
  // Revenue: each completed file goes to the staff member who sourced it, under the team on the file.
  const done = db.prepare(`SELECT c.* FROM cases c WHERE ${COMPLETED_IN_SQL}${region ? ' AND c.region = ?' : ''}`).all(...(region ? [start, end, r] : [start, end]));
  for (const c of done) {
    const amount = payoutFor(c).total;
    const staffId = c.sales_staff_id || c.created_by;
    const p = byId.get(staffId);
    const tl = byId.get(c.team_leader_id ?? p?.team_leader_id) || null; const sm = byId.get(c.sales_manager_id ?? p?.sales_manager_id) || (tl && byId.get(tl.sales_manager_id)) || null;
    const reg = regionNode(String(c.region || p?.region || '').toUpperCase());
    const mgr = managerNode(reg, sm); const ldr = leaderNode(mgr, tl);
    if (!ldr.staff.has(staffId)) ldr.staff.set(staffId, node(`u:${staffId}`, p ? p.name : c.sales_staff_name || 'Unknown', 'staff', { person: p ? { id: p.id, role: p.role, sales_code: p.sales_code } : null, left: !p }));
    const s = ldr.staff.get(staffId);
    s.revenue += amount; s.files++;
  }
  // Roll up: a node's totals are its own costs plus its children's.
  const finish = (n, children) => {
    n.children = children;
    for (const c of children) { n.revenue += c.revenue; n.files += c.files; n.salary_paid += c.salary_paid; n.salary_estimated += c.salary_estimated; n.incentives += c.incentives; n.headcount += c.headcount; n.without_upload += c.without_upload; }
    n.costs = round(n.salary_paid + n.salary_estimated + n.incentives);
    n.net = round(n.revenue - n.costs);
    n.revenue = round(n.revenue); n.salary_paid = round(n.salary_paid); n.salary_estimated = round(n.salary_estimated); n.incentives = round(n.incentives);
    n.headcount = round(n.headcount); n.without_upload = round(n.without_upload);
    n.margin_pct = n.revenue ? Math.round((n.net / n.revenue) * 1000) / 10 : null;
    return n;
  };
  const out = [...regions.values()].sort((a, b) => a.key.localeCompare(b.key)).map((reg) => {
    const managers = [...reg.managers.values()].map((m) => {
      const leaders = [...m.leaders.values()].map((l) => { const staff = [...l.staff.values()].map((s) => finish(s, [])).sort((a, b) => b.revenue - a.revenue); delete l.staff; return finish(l, staff); }).sort((a, b) => b.revenue - a.revenue);
      delete m.leaders; return finish(m, leaders);
    }).sort((a, b) => b.revenue - a.revenue);
    const overheads = finish(reg.overheads, []); delete reg.overheads; delete reg.managers;
    return finish(reg, [...managers, ...(overheads.headcount ? [overheads] : [])]);
  });
  const total = finish(node('all', 'All regions', 'total'), out);
  return { cycle, label: cycleLabel(cycle), region: region ? r : null, tree: out, total };
}

/** The tree flattened for the report: one row per node with its level. */
export function profitAndLossRows(db, user, opts) {
  const t = profitAndLossTree(db, user, opts);
  const rows = [];
  const walk = (n, depth, path) => {
    rows.push({ level: ['Region', 'Sales manager', 'Team leader', 'Staff'][depth] || 'Staff', region: path[0] || '', sales_manager: depth >= 1 ? (n.kind === 'overheads' ? '' : path[1] || n.label) : '', team_leader: depth >= 2 ? path[2] || n.label : '', name: n.label, headcount: n.headcount, files: n.files, revenue: n.revenue, salary_paid: n.salary_paid, salary_estimated: n.salary_estimated, incentives: n.incentives, costs: n.costs, net: n.net, margin_pct: n.margin_pct });
    for (const c of n.children) walk(c, depth + 1, [...path, n.label]);
  };
  for (const reg of t.tree) walk(reg, 0, []);
  return { ...t, rows };
}
