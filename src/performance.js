// Sales targets, achievement and credit card activation.
//
// Sales cycle: the 21st of one month to the 20th of the next, named after the month it ends in
// (21 May – 20 June is the June cycle), in UAE time. A case counts towards a cycle when its case
// status is set to Completed in that cycle: a temp end for credit cards, a disbursal for loans.
// Credit cards and accounts are counted; personal and auto loans are measured by the AED amount
// disbursed. A bundle counts for each product in it.
import { transaction } from './db.js';
import { PRODUCTS, CARD_STATES, DISBURSAL_FIELDS, REGIONS, STATUS, sweepCardAgeing, WorkflowError, caseProducts, includesCard, COMPLETED_IN_SQL } from './cases.js';
import { uaeDay, cycleOf, isCycle, cycleRange, cycleLabel } from './cycles.js';

// Credit cards first: the main product for sales staff.
export const TARGET_PRODUCTS = Object.fromEntries(['credit_card', 'personal_loan', 'auto_loan', 'accounts'].map((k) => [k, PRODUCTS[k]]));
// How each product's target is measured: completed cases, or AED disbursed.
export const TARGET_UNITS = { credit_card: 'count', personal_loan: 'aed', auto_loan: 'aed', accounts: 'count' };
// Who sets targets and maps card activation.
export const TARGET_SETTERS = ['mis', 'business_head'];
const VIEWERS = ['sales', 'team_leader', 'sales_manager', 'asm', 'mis', 'business_head', 'governance'];
/** Sales staff whose numbers this user may see, optionally only those in one region. */
function staffInScope(db, user, region = null) {
  if (!VIEWERS.includes(user.role)) throw new WorkflowError(403, 'Targets are for sales staff, team leaders, sales managers, MIS and business heads');
  const base = `SELECT u.id, u.name, u.sales_code, u.active, u.region, u.team_leader_id, u.sales_manager_id, u.asm_id,
      tl.name AS team_leader_name, sm.name AS sales_manager_name, asm.name AS asm_name
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id LEFT JOIN users asm ON asm.id = u.asm_id
    WHERE u.role = 'sales'${REGIONS[region] ? ` AND u.region = '${region}'` : ''}`;
  const order = ' ORDER BY u.active DESC, u.name';
  if (user.role === 'sales') return db.prepare(`${base} AND u.id = ?`).all(user.id);
  if (user.role === 'team_leader') return db.prepare(`${base} AND u.team_leader_id = ?${order}`).all(user.id);
  if (user.role === 'sales_manager') return db.prepare(`${base} AND u.sales_manager_id = ?${order}`).all(user.id);
  if (user.role === 'asm') return db.prepare(`${base} AND u.asm_id = ?${order}`).all(user.id);
  return db.prepare(`${base}${order}`).all();
}

const emptyCounts = () => Object.fromEntries(Object.keys(TARGET_PRODUCTS).map((p) => [p, 0]));
const emptyCards = () => ({ temp_end: 0, active: 0, inactive: 0, out_of_range: 0, unmapped: 0 });

function addInto(into, from) {
  for (const [k, v] of Object.entries(from)) if (v != null) into[k] = (into[k] ?? 0) + v;
}

/**
 * Targets and achievement for one cycle, for everyone the user may see. Team leaders' and sales
 * managers' targets are the sum of their sales staff's targets.
 */
export function targetReport(db, user, cycle, { region = null } = {}) {
  const today = uaeDay();
  cycle = cycle ? String(cycle) : cycleOf(today);
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const { start, end } = cycleRange(cycle);
  sweepCardAgeing(db);
  region = String(region || '').toUpperCase() || null;
  const staff = staffInScope(db, user, region);
  // `achieved` is in each product's unit (cases or AED); `cases` counts completed cases per product.
  const byId = new Map(staff.map((s) => [s.id, { ...s, target: {}, achieved: emptyCounts(), cases: emptyCounts(), cards: emptyCards() }]));

  for (const t of db.prepare('SELECT user_id, product, target FROM targets WHERE cycle = ?').all(cycle)) {
    const s = byId.get(t.user_id);
    if (s && TARGET_PRODUCTS[t.product]) s.target[t.product] = t.target;
  }
  const done = db.prepare(`SELECT c.sales_staff_id, c.product, c.bundle_products, c.card_status, c.pl_disbursed_amount, c.al_disbursed_amount
    FROM cases c WHERE ${COMPLETED_IN_SQL}`).all(start, end);
  for (const c of done) {
    const s = byId.get(c.sales_staff_id);
    if (!s) continue;
    for (const p of caseProducts(c)) {
      if (!(p in s.achieved)) continue;
      s.cases[p]++;
      s.achieved[p] += TARGET_UNITS[p] === 'aed' ? c[DISBURSAL_FIELDS[p]] ?? 0 : 1;
    }
    if (includesCard(c)) {
      s.cards.temp_end++;
      s.cards[CARD_STATES[c.card_status] ? c.card_status : 'unmapped']++;
    }
  }
  // Former staff only appear when they have numbers in this cycle.
  const rows = [...byId.values()].filter((s) => s.active || Object.keys(s.target).length || Object.values(s.achieved).some(Boolean));

  const rollup = (list) => {
    const out = { target: {}, achieved: emptyCounts(), cases: emptyCounts(), cards: emptyCards(), staff_count: list.length };
    for (const s of list) {
      addInto(out.target, s.target);
      addInto(out.achieved, s.achieved);
      addInto(out.cases, s.cases);
      addInto(out.cards, s.cards);
    }
    return out;
  };
  const groupBy = (key, nameKey) => {
    const groups = new Map();
    for (const s of rows) {
      const id = s[key] ?? 0;
      if (!groups.has(id)) groups.set(id, { id, name: s[nameKey] || 'Not assigned', list: [] });
      groups.get(id).list.push(s);
    }
    return [...groups.values()].map(({ id, name, list }) => ({ id, name, ...rollup(list) })).sort((a, b) => a.name.localeCompare(b.name));
  };

  const result = {
    cycle,
    region,
    label: cycleLabel(cycle),
    start,
    end,
    is_current: cycle === cycleOf(today),
    // Days left including today, for the current cycle.
    days_left: cycle === cycleOf(today) ? Math.round((Date.parse(end) - Date.parse(today)) / 864e5) + 1 : null,
    products: TARGET_PRODUCTS,
    units: TARGET_UNITS,
    can_set: TARGET_SETTERS.includes(user.role),
    staff: rows,
    total: rollup(rows),
  };
  if (['sales_manager', 'asm', 'mis', 'business_head', 'governance'].includes(user.role)) result.by_team_leader = groupBy('team_leader_id', 'team_leader_name');
  if (['mis', 'business_head', 'governance'].includes(user.role)) {
    result.by_sales_manager = groupBy('sales_manager_id', 'sales_manager_name');
    result.by_region = groupBy('region', 'region');
  }
  return result;
}

// Each level of the sales hierarchy, top down, and the users column that places a sales person in it.
const LEVELS = [['region', 'region', (s) => s.region || 'No region'], ['sales_manager', 'sales_manager_id', (s) => s.sales_manager_name || 'No sales manager'], ['team_leader', 'team_leader_id', (s) => s.team_leader_name || 'No team leader'], ['staff', 'id', (s) => s.name]];
const TOP_LEVEL = { business_head: 'region', mis: 'region', governance: 'region', sales_manager: 'team_leader', asm: 'team_leader', team_leader: 'staff', sales: 'staff' };
export const LEVEL_LABELS = { region: 'Region', sales_manager: 'Sales manager', team_leader: 'Team leader', staff: 'Sales staff' };

const emptyKpis = () => ({ staff: 0, sourced: 0, awaiting: 0, verified: 0, verification_pending: 0, completed: 0, disbursed_aed: 0, target: {}, achieved: emptyCounts(), cards: emptyCards() });

/**
 * The viewer's part of the hierarchy for one cycle, as a tree: region → sales manager → team
 * leader → sales staff, with every number rolled up at each level. A business head sees all
 * regions (or one with `region`), a sales manager their team leaders, a team leader their staff.
 */
export function hierarchy(db, user, { cycle, region } = {}) {
  const rep = targetReport(db, user, cycle, { region });
  const { start, end } = cycleRange(rep.cycle);
  const byStaff = new Map(rep.staff.map((s) => [s.id, s]));
  // Sourced in the cycle, and what is open or verified right now, per sales person.
  const flow = db.prepare(`SELECT c.sales_staff_id AS id,
      SUM(c.sourcing_date BETWEEN ? AND ?) AS sourced,
      SUM(c.status IN (?, ?)) AS awaiting,
      SUM(c.status = ?) AS verification_pending,
      SUM(c.status = ? AND date(c.verified_at, '+4 hours') BETWEEN ? AND ?) AS verified,
      SUM(${COMPLETED_IN_SQL}) AS completed
    FROM cases c GROUP BY c.sales_staff_id`).all(start, end, STATUS.PENDING, STATUS.IN_VERIFICATION, STATUS.INCOMPLETE, STATUS.COMPLETED, start, end, start, end);
  const flowBy = new Map(flow.map((f) => [f.id, f]));
  const leaf = (s) => {
    const f = flowBy.get(s.id) || {};
    return { staff: 1, sourced: f.sourced || 0, awaiting: f.awaiting || 0, verified: f.verified || 0, verification_pending: f.verification_pending || 0,
      completed: f.completed || 0,
      disbursed_aed: (s.achieved.personal_loan || 0) + (s.achieved.auto_loan || 0), target: { ...s.target }, achieved: { ...s.achieved }, cards: { ...s.cards } };
  };
  const add = (into, k) => {
    for (const f of ['staff', 'sourced', 'awaiting', 'verified', 'verification_pending', 'completed', 'disbursed_aed']) into[f] += k[f];
    addInto(into.target, k.target); addInto(into.achieved, k.achieved); addInto(into.cards, k.cards);
  };
  const build = (list, depth) => {
    const [level, field, nameOf] = LEVELS[depth];
    if (level === 'staff') return list.map((s) => ({ level, id: s.id, name: s.name, sales_code: s.sales_code, region: s.region, active: s.active, asm: s.asm_name, kpis: leaf(s) }));
    const groups = new Map();
    for (const s of list) {
      const key = s[field] ?? 0;
      if (!groups.has(key)) groups.set(key, { level, id: key, name: nameOf(s), region: level === 'region' ? s.region : undefined, kpis: emptyKpis(), children: [] });
      groups.get(key).children.push(s);
    }
    return [...groups.values()].map((g) => {
      g.children = build(g.children, depth + 1);
      for (const c of g.children) add(g.kpis, c.kpis);
      return g;
    }).sort((a, b) => a.name.localeCompare(b.name));
  };
  const top = LEVELS.findIndex(([l]) => l === TOP_LEVEL[user.role]);
  const nodes = build(rep.staff.filter((s) => byStaff.has(s.id)), top);
  const total = emptyKpis();
  for (const n of nodes) add(total, n.kpis);
  return { cycle: rep.cycle, label: rep.label, start, end, days_left: rep.days_left, is_current: rep.is_current, region: rep.region, products: rep.products, units: rep.units, levels: LEVELS.slice(top).map(([l]) => l), level_labels: LEVEL_LABELS, nodes, total };
}

// Case targets are whole numbers of cases; loan targets are whole AED amounts ("1,500,000" is fine).
const parseTarget = (value, label, unit) => {
  const text = String(value ?? '').replace(/,/g, '').replace(/^aed\s*/i, '').trim();
  if (text === '') return null;
  const n = Number(text);
  const max = unit === 'aed' ? 1e10 : 100000;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(unit === 'aed'
      ? `${label} target is the AED amount to disburse: a whole number, e.g. 1500000`
      : `${label} target must be a whole number of cases from 0 to 100000`);
  }
  return n;
};

/** Sets one sales person's targets for a cycle: { product: number | null }. Null or blank clears. */
export function setTargetsFor(db, user, staffId, cycle, values) {
  const staff = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'sales'").get(Number(staffId));
  if (!staff) throw new Error('Targets can only be set for sales staff');
  const ts = new Date().toISOString();
  for (const [product, label] of Object.entries(TARGET_PRODUCTS)) {
    if (!(product in values)) continue;
    const n = parseTarget(values[product], label, TARGET_UNITS[product]);
    if (n === null) db.prepare('DELETE FROM targets WHERE user_id = ? AND cycle = ? AND product = ?').run(staff.id, cycle, product);
    else {
      db.prepare(`INSERT INTO targets (user_id, cycle, product, target, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (user_id, cycle, product) DO UPDATE SET target = excluded.target, set_by = excluded.set_by, set_at = excluded.set_at`)
        .run(staff.id, cycle, product, n, user.id, ts);
    }
  }
}

/** PUT /targets: { cycle, targets: [{ user_id, credit_card: 10, ... }] }. MIS and business heads only. */
export function saveTargets(db, user, { cycle, targets } = {}) {
  if (!TARGET_SETTERS.includes(user.role)) throw new WorkflowError(403, 'Only MIS and business heads can set targets');
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  if (!Array.isArray(targets)) throw new WorkflowError(400, 'Send the targets as a list');
  transaction(db, () => {
    for (const t of targets) {
      try {
        setTargetsFor(db, user, t.user_id, cycle, t);
      } catch (err) {
        throw new WorkflowError(400, err.message);
      }
    }
  });
  return targetReport(db, user, cycle);
}
