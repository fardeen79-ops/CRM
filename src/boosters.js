// Boosters: a product campaign that runs between two dates, with a reward line, shown to the sales
// staff it is for and to their leaders and managers while it runs (and shortly before it starts).
// Business heads and MIS create them. Progress is the files completed in the window with the
// booster's product, by the person or by the team.
import { WorkflowError, caseProducts, COMPLETED_IN_SQL, PRODUCTS, TEAM_FIELDS, REGIONS } from './cases.js';
import { TEAM_LEADER_ROLES } from './users.js';
import { uaeDay } from './cycles.js';

export const BOOSTER_PRODUCTS = { all: 'All products', ...PRODUCTS };
export const BOOSTER_AUDIENCE = { core: 'Core staff of the product', all: 'Every sales person' };
export const BOOSTER_ADMINS = ['business_head', 'mis'];
const UPCOMING_DAYS = 14;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

export const canManageBoosters = (user) => BOOSTER_ADMINS.includes(user.role);
const requireAdmin = (user) => { if (!canManageBoosters(user)) throw new WorkflowError(403, 'Only business heads and MIS run boosters'); };

const BOOSTER_SELECT = `SELECT b.*, u.name AS created_by_name FROM boosters b LEFT JOIN users u ON u.id = b.created_by`;
const parse = (b) => b && ({ ...b, team_leader_ids: JSON.parse(b.team_leader_ids || '[]'), status: statusOf(b) });
function statusOf(b) {
  const today = uaeDay();
  if (!b.active) return 'off';
  if (today < b.starts_on) return 'upcoming';
  if (today > b.ends_on) return 'ended';
  return 'running';
}

function validate(input, current = null) {
  const s = (v, max) => { const t = String(v ?? '').trim(); return t ? t.slice(0, max) : null; };
  const title = s(input.title ?? current?.title, 120);
  if (!title) throw new WorkflowError(400, 'Give the booster a title');
  const product = s(input.product ?? current?.product ?? 'all', 30);
  if (!BOOSTER_PRODUCTS[product]) throw new WorkflowError(400, `Product must be one of: ${Object.values(BOOSTER_PRODUCTS).join(', ')}`);
  const starts_on = s(input.starts_on ?? current?.starts_on, 10); const ends_on = s(input.ends_on ?? current?.ends_on, 10);
  if (!DAY.test(starts_on || '') || !DAY.test(ends_on || '')) throw new WorkflowError(400, 'Give the start and end dates as YYYY-MM-DD');
  if (ends_on < starts_on) throw new WorkflowError(400, 'The booster ends before it starts');
  const region = s(input.region ?? current?.region, 3)?.toUpperCase() || null;
  if (region && !REGIONS[region]) throw new WorkflowError(400, 'Region must be DXB or AUH, or blank for both');
  const audience = s(input.audience ?? current?.audience ?? 'core', 10);
  if (!BOOSTER_AUDIENCE[audience]) throw new WorkflowError(400, 'Audience must be core or all');
  const raw = input.team_leader_ids ?? (current ? JSON.parse(current.team_leader_ids || '[]') : []);
  const team_leader_ids = (Array.isArray(raw) ? raw : String(raw || '').split(',')).map((x) => Number(x)).filter((n) => Number.isInteger(n) && n > 0);
  return { title, product, reward: s(input.reward ?? current?.reward, 200), details: s(input.details ?? current?.details, 1000), starts_on, ends_on, region, audience, team_leader_ids: JSON.stringify(team_leader_ids), active: input.active === undefined ? (current ? current.active : 1) : (input.active === true || input.active === 1 || input.active === '1' || input.active === 'true' ? 1 : 0) };
}

export function listBoosters(db, user) {
  requireAdmin(user);
  return db.prepare(`${BOOSTER_SELECT} ORDER BY b.starts_on DESC, b.id DESC`).all().map(parse);
}

export function createBooster(db, user, input) {
  requireAdmin(user);
  const v = validate(input);
  const { lastInsertRowid } = db.prepare('INSERT INTO boosters (title, product, reward, details, starts_on, ends_on, region, audience, team_leader_ids, active, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(v.title, v.product, v.reward, v.details, v.starts_on, v.ends_on, v.region, v.audience, v.team_leader_ids, v.active, user.id, new Date().toISOString());
  return parse(db.prepare(`${BOOSTER_SELECT} WHERE b.id = ?`).get(Number(lastInsertRowid)));
}

export function updateBooster(db, user, id, input) {
  requireAdmin(user);
  const current = db.prepare('SELECT * FROM boosters WHERE id = ?').get(Number(id));
  if (!current) throw new WorkflowError(404, 'Booster not found');
  const v = validate(input, current);
  db.prepare('UPDATE boosters SET title = ?, product = ?, reward = ?, details = ?, starts_on = ?, ends_on = ?, region = ?, audience = ?, team_leader_ids = ?, active = ? WHERE id = ?')
    .run(v.title, v.product, v.reward, v.details, v.starts_on, v.ends_on, v.region, v.audience, v.team_leader_ids, v.active, current.id);
  return parse(db.prepare(`${BOOSTER_SELECT} WHERE b.id = ?`).get(current.id));
}

export function deleteBooster(db, user, id) {
  requireAdmin(user);
  const r = db.prepare('DELETE FROM boosters WHERE id = ?').run(Number(id));
  if (!r.changes) throw new WorkflowError(404, 'Booster not found');
  return { ok: true };
}

/** Does a booster cover this sales person? Region, audience (core staff of the product) and named teams. */
function coversStaff(b, s) {
  if (b.region && s.region !== b.region) return false;
  if (b.audience === 'core' && b.product !== 'all' && s.core_product !== b.product) return false;
  const teams = JSON.parse(b.team_leader_ids || '[]');
  if (teams.length && !teams.includes(s.team_leader_id)) return false;
  return true;
}

const productMatch = (b) => (b.product === 'all' ? '1 = 1' : `(c.product = '${b.product}' OR (c.product = 'bundle' AND ',' || c.bundle_products || ',' LIKE '%,${b.product},%'))`);

/**
 * The boosters that apply to the viewer, with progress: a sales person's own completed files in the
 * window; a leader's team's, with how many of the team are covered. Running ones and those starting
 * within two weeks; ended ones from the last week stay so the result is visible.
 */
export function boostersFor(db, user) {
  const today = uaeDay();
  const soon = new Date(Date.parse(today) + UPCOMING_DAYS * 864e5).toISOString().slice(0, 10);
  const recent = new Date(Date.parse(today) - 7 * 864e5).toISOString().slice(0, 10);
  const live = db.prepare(`${BOOSTER_SELECT} WHERE b.active = 1 AND b.starts_on <= ? AND b.ends_on >= ? ORDER BY b.starts_on, b.id`).all(soon, recent);
  if (!live.length) return [];
  let staff;
  if (user.role === 'sales') staff = db.prepare('SELECT id, name, region, core_product, team_leader_id FROM users WHERE id = ?').all(user.id);
  else if (TEAM_LEADER_ROLES.includes(user.role)) staff = db.prepare(`SELECT id, name, region, core_product, team_leader_id FROM users WHERE role = 'sales' AND active = 1 AND ${TEAM_FIELDS[user.role]} = ?`).all(user.id);
  else if (BOOSTER_ADMINS.includes(user.role)) staff = db.prepare("SELECT id, name, region, core_product, team_leader_id FROM users WHERE role = 'sales' AND active = 1").all();
  else return [];
  const out = [];
  for (const b of live) {
    const covered = staff.filter((s) => coversStaff(b, s));
    if (!covered.length) continue;
    const ids = covered.map((s) => s.id);
    const rows = db.prepare(`SELECT c.product, c.bundle_products, c.pl_disbursed_amount, c.al_disbursed_amount, COALESCE(c.sales_staff_id, c.created_by) AS staff_id FROM cases c
      WHERE COALESCE(c.sales_staff_id, c.created_by) IN (${ids.map(() => '?').join(',')}) AND ${COMPLETED_IN_SQL} AND ${productMatch(b)} AND COALESCE(c.complaint_status, '') <> 'valid'`).all(...ids, b.starts_on, b.ends_on);
    let aed = 0;
    for (const r of rows) { const ps = caseProducts(r); if (ps.includes('personal_loan') && (b.product === 'all' || b.product === 'personal_loan')) aed += r.pl_disbursed_amount ?? 0; if (ps.includes('auto_loan') && (b.product === 'all' || b.product === 'auto_loan')) aed += r.al_disbursed_amount ?? 0; }
    const days_left = Math.max(0, Math.round((Date.parse(b.ends_on) - Date.parse(today)) / 864e5));
    const days_to_start = Math.max(0, Math.round((Date.parse(b.starts_on) - Date.parse(today)) / 864e5));
    out.push({ ...parse(b), product_label: BOOSTER_PRODUCTS[b.product], covered: covered.length, covered_names: user.role === 'sales' ? [] : covered.map((s) => s.name), progress: { files: rows.length, staff_with_files: new Set(rows.map((r) => r.staff_id)).size, aed: Math.round(aed) }, days_left, days_to_start });
  }
  return out;
}
