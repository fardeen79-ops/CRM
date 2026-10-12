// Profit and loss per sales cycle: the bank's payout on completed files, less the salaries on the
// staff profiles and the incentives earned under the schemes, by role. The
// business head and the CEO see it; nobody else.
import { REGIONS, COMPLETED_IN_SQL, WorkflowError } from './cases.js';
import { cycleRange, cycleLabel, cycleOf, uaeDay, isCycle } from './cycles.js';
import { revenueIn } from './payouts.js';
import { isCeo } from './roles.js';
import { incentiveRows, plIncentiveRows, alIncentiveRows, tlIncentiveRows, plTlIncentiveRows, ccSmIncentiveRows, plSmIncentiveRows } from './incentives.js';

export const PNL_VIEWERS = ['business_head'];
export const PNL_ROLES = { sales: 'Sales staff', team_leader: 'Team leaders', asm: 'Assistant sales managers', sales_manager: 'Sales managers', business_head: 'Business heads', processing: 'Processing', mis: 'MIS', governance: 'Governance', it: 'IT', staff: 'Other staff (no CRM access)' };
const round = (n) => Math.round((n || 0) * 100) / 100;

const LEADER_ROLES = ['team_leader', 'sales_manager', 'asm'];
const SUPPORT_ROLES = ['business_head', 'processing', 'mis', 'governance', 'it', 'staff'];
const regionKey = (code) => (REGIONS[String(code || '').toUpperCase()] ? String(code).toUpperCase() : 'NONE');

/**
 * Where each person's cost sits: whole, in their own region (no splitting across regions). Someone
 * with no region set goes to the "No region set" bucket and counts in the all-regions view only.
 * Returns (person) => [[regionKey, share]] with the one share of 1, so the statement and the
 * hierarchy can carry a share per region should the business ever want a split again.
 */
export function regionShares() {
  return (p) => [[regionKey(p.region), 1]];
}

/** The statement for a cycle: revenue, salaries and incentives by role, and the net. */
export function profitAndLoss(db, user, { cycle, region } = {}) {
  if (!PNL_VIEWERS.includes(user.role)) throw new WorkflowError(403, 'The profit and loss is for the business head');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-10');
  const r = String(region || '').toUpperCase();
  if (region && !REGIONS[r]) throw new WorkflowError(400, 'Region must be DXB or AUH');
  const { start, end } = cycleRange(cycle);
  // Revenue: the bank's payout in the cycle, by product: loans on the files disbursed (completed) in
  // it, cards on the cards activated in it within the window after the temp end.
  const paid = revenueIn(db, start, end, region ? { where: 'c.region = ?', params: [r] } : {});
  const revenue = { total: 0, files: paid.length, by_product: { credit_card: 0, personal_loan: 0, auto_loan: 0, accounts: 0 } };
  for (const e of paid) {
    revenue.total += e.total;
    for (const part of e.parts) if (revenue.by_product[part.product] != null) revenue.by_product[part.product] += part.payout || 0;
  }
  revenue.total = round(revenue.total);
  for (const k of Object.keys(revenue.by_product)) revenue.by_product[k] = round(revenue.by_product[k]);
  // Salaries: each active person's salary from their profile, at their share for the region.
  const everyone = db.prepare('SELECT id, name, role, region, salary, team_leader_id, sales_manager_id, asm_id FROM users WHERE active = 1').all();
  const sharesOf = regionShares(everyone);
  const weightOf = (p) => (region ? (sharesOf(p).find(([k]) => k === r)?.[1] || 0) : 1);
  const staff = everyone.map((p) => ({ ...p, weight: weightOf(p) })).filter((p) => p.weight > 0);
  const lines = {};
  for (const role of Object.keys(PNL_ROLES)) lines[role] = { role, label: PNL_ROLES[role], staff: 0, salary: 0, incentive: 0 };
  for (const s of staff) {
    const line = lines[s.role]; if (!line) continue;
    line.staff += s.weight;
    line.salary += (s.salary || 0) * s.weight;
  }
  // Incentives: what the schemes work out for the cycle, per person.
  const byUser = new Map();
  const add = (name, role, amount) => { const k = `${role}:${name}`; byUser.set(k, (byUser.get(k) || 0) + (amount || 0)); };
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
    line.incentive += amount * s.weight;
  }
  // Business heads' salaries are for the CEO (and the heads themselves): any other viewer sees them
  // folded into one support line with processing, MIS, governance and IT, so no head's pay can be read off.
  if (!isCeo(user)) {
    const support = { role: 'support', label: 'Support (business heads, processing, MIS, governance, IT, other staff)', staff: 0, salary: 0, incentive: 0 };
    for (const role of SUPPORT_ROLES) { const l = lines[role]; support.staff += l.staff; support.salary += l.salary; support.incentive += l.incentive; delete lines[role]; }
    lines.support = support;
  }
  const rows = Object.values(lines).filter((l) => l.staff || l.salary || l.incentive).map((l) => ({ ...l, staff: round(l.staff), salary: round(l.salary), incentive: round(l.incentive), cost: round(l.salary + l.incentive) }));
  const salaries = round(rows.reduce((n, l) => n + l.salary, 0));
  const incentives = round(rows.reduce((n, l) => n + l.incentive, 0));
  const costs = round(salaries + incentives);
  const net = round(revenue.total - costs);
  return {
    cycle, label: cycleLabel(cycle), start, end, region: region ? r : null,
    revenue, salaries, incentives, costs, net, margin_pct: revenue.total ? Math.round((net / revenue.total) * 1000) / 10 : null, rows, people: round(rows.reduce((n, l) => n + l.staff, 0)),
  };
}

/** The incentive each person earns in the cycle under the schemes, by user id. */
function incentiveByUser(db, cycle) {
  const out = new Map();
  const add = (x) => out.set(x.user_id, (out.get(x.user_id) || 0) + (x.incentive_aed || 0));
  for (const fn of [incentiveRows, plIncentiveRows, alIncentiveRows, tlIncentiveRows, plTlIncentiveRows, ccSmIncentiveRows, plSmIncentiveRows]) for (const x of fn(db, cycle, null)) add(x);
  return out;
}

const OVERHEAD_ROLES = ['business_head', 'processing', 'mis', 'governance', 'it', 'staff'];

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
  const incentives = incentiveByUser(db, cycle);
  const node = (key, label, kind, extra = {}) => ({ key, label, kind, revenue: 0, files: 0, salary: 0, incentives: 0, headcount: 0, children: [], ...extra });
  // A person's costs land on a node at their share for that region (1 for a sales executive).
  const costOf = (p, n, share = 1) => {
    n.headcount += share;
    n.salary += (p.salary || 0) * share;
    n.incentives += (incentives.get(p.id) || 0) * share;
  };
  // Regions, each with its managers, and overheads (business heads, processing, MIS, governance, IT) at region level.
  const regions = new Map();
  const regionNode = (code) => {
    const k = REGIONS[code] ? code : 'NONE';
    if (!regions.has(k)) regions.set(k, node(k, REGIONS[k] || 'No region set', 'region', { managers: new Map(), overheads: node(`${k}:oh`, 'Overheads (business heads, processing, MIS, governance, IT, other staff)', 'overheads') }));
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
  // Everyone else sits whole in their own region: a leader under their own node, overheads on the region's overheads node.
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
  // Revenue: each payout in the cycle goes to the staff member who sourced the file, under the team on the file.
  for (const { row: c, total: amount } of revenueIn(db, start, end, region ? { where: 'c.region = ?', params: [r] } : {})) {
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
    for (const c of children) { n.revenue += c.revenue; n.files += c.files; n.salary += c.salary; n.incentives += c.incentives; n.headcount += c.headcount; }
    n.costs = round(n.salary + n.incentives);
    n.net = round(n.revenue - n.costs);
    n.revenue = round(n.revenue); n.salary = round(n.salary); n.incentives = round(n.incentives); n.headcount = round(n.headcount);
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
    rows.push({ level: ['Region', 'Sales manager', 'Team leader', 'Staff'][depth] || 'Staff', region: path[0] || '', sales_manager: depth >= 1 ? (n.kind === 'overheads' ? '' : path[1] || n.label) : '', team_leader: depth >= 2 ? path[2] || n.label : '', name: n.label, headcount: n.headcount, files: n.files, revenue: n.revenue, salary: n.salary, incentives: n.incentives, costs: n.costs, net: n.net, margin_pct: n.margin_pct });
    for (const c of n.children) walk(c, depth + 1, [...path, n.label]);
  };
  for (const reg of t.tree) walk(reg, 0, []);
  return { ...t, rows };
}
