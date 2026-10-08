// Sales targets, achievement and credit card activation.
//
// Sales cycle: the 21st of one month to the 20th of the next, named after the month it ends in
// (21 May – 20 June is the June cycle), in UAE time. A case counts towards a cycle when its case
// status is set to Completed in that cycle: a temp end for credit cards, a disbursal for loans.
// Credit cards and auto loans are measured in points (each card's points from the product list;
// an auto loan's points from the amount band table), personal loans by the AED disbursed and
// accounts by count. Until points are loaded, each card or auto loan counts 1 point. A bundle
// counts for each product in it.
import { transaction } from './db.js';
import { PRODUCTS, CARD_STATES, DISBURSAL_FIELDS, REGIONS, STATUS, sweepCardAgeing, WorkflowError, caseProducts, caseScope, includesCard, COMPLETED_IN_SQL } from './cases.js';
import { uaeDay, cycleOf, isCycle, cycleRange, cycleLabel } from './cycles.js';
import { cardProducts } from './credit-cards.js';

// Credit cards first: the main product for sales staff.
export const TARGET_PRODUCTS = Object.fromEntries(['credit_card', 'personal_loan', 'auto_loan', 'accounts'].map((k) => [k, PRODUCTS[k]]));
// How each product's target is measured: completed cases, or AED disbursed.
export const TARGET_UNITS = { credit_card: 'points', personal_loan: 'aed', auto_loan: 'points', accounts: 'count' };

/** The auto loan points bands. */
export const autoLoanBands = (db) => db.prepare('SELECT amount_from, amount_to, points FROM auto_loan_points ORDER BY amount_from').all();
/** What one completed file adds to a product's achievement. */
export function achievedBy(product, row, bands = []) {
  if (product === 'personal_loan') return row.pl_disbursed_amount ?? 0;
  if (product === 'credit_card') return row.card_points ?? 1;
  if (product === 'auto_loan') {
    const amount = row.al_disbursed_amount ?? 0;
    const band = bands.find((b) => amount >= b.amount_from && amount <= b.amount_to);
    return band ? band.points : 1;
  }
  return 1;
}
/** How targets and points are set up, for the Targets page. */
export function targetSetup(db) {
  return {
    salary_bands: db.prepare('SELECT product, COUNT(*) AS n FROM target_rules GROUP BY product').all().reduce((o, r) => ({ ...o, [r.product]: r.n }), {}),
    auto_loan_bands: db.prepare('SELECT COUNT(*) AS n FROM auto_loan_points').get().n,
    card_points_set: cardProducts().some((p) => p.points != null),
    staff_with_salary: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'sales' AND active = 1 AND salary IS NOT NULL").get().n,
    staff: db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'sales' AND active = 1").get().n,
  };
}
// Who sets targets and maps card activation.
export const TARGET_SETTERS = ['mis', 'business_head'];
const VIEWERS = ['sales', 'team_leader', 'sales_manager', 'asm', 'mis', 'business_head', 'governance'];
/** Sales staff whose numbers this user may see, optionally only those in one region. */
function staffInScope(db, user, region = null) {
  if (!VIEWERS.includes(user.role)) throw new WorkflowError(403, 'Targets are for sales staff, team leaders, sales managers, MIS and business heads');
  const base = `SELECT u.id, u.name, u.sales_code, u.active, u.region, u.salary, u.team_leader_id, u.sales_manager_id, u.asm_id,
      tl.name AS team_leader_name, sm.name AS sales_manager_name, asm.name AS asm_name
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id LEFT JOIN users asm ON asm.id = u.asm_id
    WHERE u.role = 'sales'${region ? ` AND u.region = '${region}'` : ''}`;
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
  // A region view: the sales staff whose own region it is (every file of theirs counts).
  region = REGIONS[String(region || '').toUpperCase()] ? String(region).toUpperCase() : null;
  const staff = staffInScope(db, user, region);
  // `achieved` is in each product's unit (cases or AED); `cases` counts completed cases per product.
  const byId = new Map(staff.map((s) => [s.id, { ...s, target: {}, achieved: emptyCounts(), cases: emptyCounts(), cards: emptyCards() }]));

  for (const t of db.prepare('SELECT user_id, product, target FROM targets WHERE cycle = ?').all(cycle)) {
    const s = byId.get(t.user_id);
    if (s && TARGET_PRODUCTS[t.product]) s.target[t.product] = t.target;
  }
  const bands = autoLoanBands(db);
  const done = db.prepare(`SELECT c.sales_staff_id, c.product, c.bundle_products, c.card_status, c.card_points, c.pl_disbursed_amount, c.al_disbursed_amount
    FROM cases c WHERE ${COMPLETED_IN_SQL}`).all(start, end);
  for (const c of done) {
    const s = byId.get(c.sales_staff_id);
    if (!s) continue;
    for (const p of caseProducts(c)) {
      if (!(p in s.achieved)) continue;
      s.cases[p]++;
      s.achieved[p] += achievedBy(p, c, bands);
    }
    if (includesCard(c)) {
      s.cards.temp_end++;
      s.cards[CARD_STATES[c.card_status] ? c.card_status : 'unmapped']++;
    }
  }
  // Former staff only appear when they have numbers in this cycle. Salaries are for MIS and business heads.
  const seesSalary = TARGET_SETTERS.includes(user.role);
  const rows = [...byId.values()].filter((s) => s.active || Object.keys(s.target).length || Object.values(s.achieved).some(Boolean))
    .map((s) => (seesSalary ? s : { ...s, salary: undefined }));

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
    setup: seesSalary ? targetSetup(db) : undefined,
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

// Each level of the sales hierarchy, top down: the file column that places a file in it.
const LEVELS = [['region', 'region'], ['sales_manager', 'sales_manager_id'], ['team_leader', 'team_leader_id'], ['staff', 'sales_staff_id']];
const TOP_LEVEL = { business_head: 'region', mis: 'region', governance: 'region', sales_manager: 'team_leader', asm: 'team_leader', team_leader: 'staff', sales: 'staff' };
export const LEVEL_LABELS = { region: 'Region', sales_manager: 'Sales manager', team_leader: 'Team leader', staff: 'Sales staff' };

const emptyKpis = () => ({ staff: 0, sourced: 0, awaiting: 0, verified: 0, verification_pending: 0, completed: 0, disbursed_aed: 0, target: {}, achieved: emptyCounts(), cards: emptyCards() });
const addKpis = (into, k) => {
  for (const f of ['staff', 'sourced', 'awaiting', 'verified', 'verification_pending', 'completed', 'disbursed_aed']) into[f] += k[f];
  addInto(into.target, k.target); addInto(into.achieved, k.achieved); addInto(into.cards, k.cards);
};

/**
 * The viewer's part of the hierarchy for one cycle, as a tree: region → sales manager → team
 * leader → sales staff, with every number rolled up at each level. Region is the sales person's
 * own region. Files count under the team stored on them, so when a sales person changes team
 * their completed files stay with the old team (shown as a "previous team" row) while open files
 * follow them. `region` limits it to the sales staff of one region.
 */
export function hierarchy(db, user, { cycle, region } = {}) {
  const rep = targetReport(db, user, cycle, { region });
  const { start, end } = cycleRange(rep.cycle);
  region = rep.region;
  const scope = caseScope(user);
  const where = [scope?.sql].filter(Boolean);
  const params = [...(scope?.params || [])];
  const rows = db.prepare(`SELECT c.sales_staff_id, c.sales_staff_name, c.team_leader_id, c.sales_manager_id, c.asm_id, c.status, c.sourcing_date, c.case_status,
      c.product, c.bundle_products, c.card_status, c.card_points, c.pl_disbursed_amount, c.al_disbursed_amount,
      date(c.verified_at, '+4 hours') AS verified_day, date(c.case_status_at, '+4 hours') AS completed_day
    FROM cases c ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...params);
  // Numbers per sales person per team they filed under.
  const bands = autoLoanBands(db);
  const keyOf = (r) => `${r.sales_staff_id ?? 0}|${r.team_leader_id ?? 0}|${r.sales_manager_id ?? 0}|${r.asm_id ?? 0}`;
  const agg = new Map();
  for (const r of rows) {
    const key = keyOf(r);
    if (!agg.has(key)) agg.set(key, { ...emptyKpis(), ids: r, name: r.sales_staff_name });
    const k = agg.get(key);
    const inCycle = (day) => day && day >= start && day <= end;
    if (inCycle(r.sourcing_date)) k.sourced++;
    if ([STATUS.PENDING, STATUS.IN_VERIFICATION, STATUS.APPROVAL].includes(r.status)) k.awaiting++;
    if (r.status === STATUS.INCOMPLETE) k.verification_pending++;
    if (r.status === STATUS.COMPLETED && inCycle(r.verified_day)) k.verified++;
    if (r.case_status === 'completed' && inCycle(r.completed_day)) {
      k.completed++;
      for (const p of caseProducts(r)) {
        if (!(p in k.achieved)) continue;
        k.achieved[p] += achievedBy(p, r, bands);
      }
      k.disbursed_aed += (r.pl_disbursed_amount || 0) + (r.al_disbursed_amount || 0);
      if (includesCard(r)) { k.cards.temp_end++; k.cards[CARD_STATES[r.card_status] ? r.card_status : 'unmapped']++; }
    }
  }
  // Leaves: every current sales person under their current team (with targets), then files left
  // under a previous team as their own row.
  const leaves = [];
  const used = new Set();
  for (const s of rep.staff) {
    const key = `${s.id}|${s.team_leader_id ?? 0}|${s.sales_manager_id ?? 0}|${s.asm_id ?? 0}`;
    used.add(key);
    const k = agg.get(key) || emptyKpis();
    leaves.push({ level: 'staff', id: s.id, name: s.name, sales_code: s.sales_code, active: s.active, asm: s.asm_name, region: s.region, team_leader_id: s.team_leader_id, sales_manager_id: s.sales_manager_id,
      kpis: { ...k, staff: 1, target: { ...s.target }, achieved: { ...k.achieved }, cards: { ...k.cards }, ids: undefined, name: undefined } });
  }
  const people = new Map(db.prepare('SELECT id, name, region FROM users').all().map((u) => [u.id, u]));
  for (const [key, k] of agg) {
    if (used.has(key) || !k.ids.sales_staff_id) continue;
    const who = people.get(k.ids.sales_staff_id);
    if (region && who?.region !== region) continue;
    leaves.push({ level: 'staff', id: k.ids.sales_staff_id, name: who?.name || k.name, previous_team: true, region: who?.region ?? null, team_leader_id: k.ids.team_leader_id, sales_manager_id: k.ids.sales_manager_id,
      kpis: { ...k, staff: 0, achieved: { ...k.achieved }, cards: { ...k.cards }, ids: undefined, name: undefined } });
  }

  const top = LEVELS.findIndex(([l]) => l === TOP_LEVEL[user.role]);
  const build = (list, depth) => {
    const [level, field] = LEVELS[depth];
    if (level === 'staff') return list.sort((a, b) => (a.previous_team ? 1 : 0) - (b.previous_team ? 1 : 0) || a.name.localeCompare(b.name));
    const groups = new Map();
    for (const leaf of list) {
      const id = leaf[field] ?? 0;
      if (!groups.has(id)) groups.set(id, { level, id, name: level === 'region' ? (id || 'No region') : people.get(id)?.name || `No ${LEVEL_LABELS[level].toLowerCase()}`, kpis: emptyKpis(), children: [] });
      groups.get(id).children.push(leaf);
    }
    return [...groups.values()].map((g) => {
      g.children = build(g.children, depth + 1);
      for (const c of g.children) addKpis(g.kpis, c.kpis);
      return g;
    }).sort((a, b) => a.name.localeCompare(b.name));
  };
  const nodes = build(leaves, top);
  const total = emptyKpis();
  for (const n of nodes) addKpis(total, n.kpis);
  return { cycle: rep.cycle, label: rep.label, start, end, days_left: rep.days_left, is_current: rep.is_current, region, products: rep.products, units: rep.units, levels: LEVELS.slice(top).map(([l]) => l), level_labels: LEVEL_LABELS, nodes, total };
}

// Count targets are whole numbers; points and AED targets are whole numbers too ("1,500,000" is fine).
const parseTarget = (value, label, unit) => {
  const text = String(value ?? '').replace(/,/g, '').replace(/^aed\s*/i, '').trim();
  if (text === '') return null;
  const n = Number(text);
  const max = unit === 'count' ? 100000 : 1e10;
  if (!Number.isInteger(n) || n < 0 || n > max) {
    throw new Error(unit === 'aed'
      ? `${label} target is the AED amount to disburse: a whole number, e.g. 1500000`
      : unit === 'points' ? `${label} target is a whole number of points`
        : `${label} target must be a whole number of cases from 0 to 100000`);
  }
  return n;
};

/**
 * Sets every active sales person's targets for a cycle from their salary and the salary-band rules
 * (Bulk upload → Salary targets). Staff without a salary or outside every band are listed as skipped.
 * Targets already set by hand for the cycle are replaced for the products that have a rule.
 */
export function generateTargets(db, user, cycle) {
  if (!TARGET_SETTERS.includes(user.role)) throw new WorkflowError(403, 'Only MIS and business heads can set targets');
  cycle = cycle ? String(cycle) : cycleOf(uaeDay());
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const rules = db.prepare('SELECT product, salary_from, salary_to, target FROM target_rules ORDER BY product, salary_from').all();
  if (!rules.length) throw new WorkflowError(400, 'No salary-band rules yet. Upload them from Bulk upload → Salary targets first');
  const staff = db.prepare("SELECT id, name, salary, core_product FROM users WHERE role = 'sales' AND active = 1 ORDER BY name").all();
  const set = [];
  const skipped = [];
  transaction(db, () => {
    for (const s of staff) {
      if (s.salary == null) { skipped.push({ name: s.name, reason: 'no salary on the profile' }); continue; }
      // A staff member gets the target of their core product; multi-product staff get every product with a rule.
      const wanted = TARGET_PRODUCTS[s.core_product] ? [s.core_product] : Object.keys(TARGET_PRODUCTS);
      const values = {};
      for (const p of wanted) {
        const rule = rules.find((r) => r.product === p && s.salary >= r.salary_from && s.salary <= r.salary_to);
        if (rule) values[p] = Math.round(rule.target);
      }
      if (!Object.keys(values).length) { skipped.push({ name: s.name, reason: `salary AED ${s.salary.toLocaleString('en-US')} is outside every band` }); continue; }
      setTargetsFor(db, user, s.id, cycle, values);
      set.push({ name: s.name, salary: s.salary, targets: values });
    }
  });
  return { cycle, set, skipped, report: targetReport(db, user, cycle) };
}

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
