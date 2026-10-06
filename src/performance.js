// Sales targets, achievement and credit card activation.
//
// Sales cycle: the 21st of one month to the 20th of the next, named after the month it ends in
// (21 May – 20 June is the June cycle), in UAE time. A case counts towards a cycle when its case
// status is set to Completed in that cycle: a temp end for credit cards, a disbursal for loans.
// Credit cards and accounts are counted; personal and auto loans are measured by the AED amount
// disbursed. A bundle counts for each product in it.
import { transaction } from './db.js';
import { PRODUCTS, CARD_STATUS, DISBURSAL_FIELDS, WorkflowError, caseProducts, includesCard, COMPLETED_IN_SQL } from './cases.js';
import { uaeDay, cycleOf, isCycle, cycleRange, cycleLabel } from './cycles.js';

// Credit cards first: the main product for sales staff.
export const TARGET_PRODUCTS = Object.fromEntries(['credit_card', 'personal_loan', 'auto_loan', 'accounts'].map((k) => [k, PRODUCTS[k]]));
// How each product's target is measured: completed cases, or AED disbursed.
export const TARGET_UNITS = { credit_card: 'count', personal_loan: 'aed', auto_loan: 'aed', accounts: 'count' };
// Who sets targets and maps card activation.
export const TARGET_SETTERS = ['mis', 'business_head'];
const VIEWERS = ['sales', 'team_leader', 'sales_manager', 'mis', 'business_head'];
/** Sales staff whose numbers this user may see. */
function staffInScope(db, user) {
  if (!VIEWERS.includes(user.role)) throw new WorkflowError(403, 'Targets are for sales staff, team leaders, sales managers, MIS and business heads');
  const base = `SELECT u.id, u.name, u.sales_code, u.active, u.team_leader_id, u.sales_manager_id,
      tl.name AS team_leader_name, sm.name AS sales_manager_name
    FROM users u LEFT JOIN users tl ON tl.id = u.team_leader_id LEFT JOIN users sm ON sm.id = u.sales_manager_id
    WHERE u.role = 'sales'`;
  const order = ' ORDER BY u.active DESC, u.name';
  if (user.role === 'sales') return db.prepare(`${base} AND u.id = ?`).all(user.id);
  if (user.role === 'team_leader') return db.prepare(`${base} AND u.team_leader_id = ?${order}`).all(user.id);
  if (user.role === 'sales_manager') return db.prepare(`${base} AND u.sales_manager_id = ?${order}`).all(user.id);
  return db.prepare(`${base}${order}`).all();
}

const emptyCounts = () => Object.fromEntries(Object.keys(TARGET_PRODUCTS).map((p) => [p, 0]));
const emptyCards = () => ({ temp_end: 0, active: 0, inactive: 0, unmapped: 0 });

function addInto(into, from) {
  for (const [k, v] of Object.entries(from)) if (v != null) into[k] = (into[k] ?? 0) + v;
}

/**
 * Targets and achievement for one cycle, for everyone the user may see. Team leaders' and sales
 * managers' targets are the sum of their sales staff's targets.
 */
export function targetReport(db, user, cycle) {
  const today = uaeDay();
  cycle = cycle ? String(cycle) : cycleOf(today);
  if (!isCycle(cycle)) throw new WorkflowError(400, 'Cycle must look like 2026-06');
  const { start, end } = cycleRange(cycle);
  const staff = staffInScope(db, user);
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
      s.cards[CARD_STATUS[c.card_status] ? c.card_status : 'unmapped']++;
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
  if (['sales_manager', 'mis', 'business_head'].includes(user.role)) result.by_team_leader = groupBy('team_leader_id', 'team_leader_name');
  if (['mis', 'business_head'].includes(user.role)) result.by_sales_manager = groupBy('sales_manager_id', 'sales_manager_name');
  return result;
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
