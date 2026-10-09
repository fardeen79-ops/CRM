// Assets issued to sales staff: the sourcing tab each sales person gets from the bank, with its
// accessories, SIM and sign-in details. The IT department keeps the register; MIS and business
// heads can see it; a sales person sees their own tab. Every status change and assignment is logged.
import { WorkflowError } from './cases.js';

export const ASSET_STATUS = { in_use: 'Active, in use', it_custody: 'With IT custody', handed_over: 'Handed over on exit', returned_to_bank: 'Returned to bank' };
/** The day a tab went back to the bank, as YYYY-MM-DD. */
function returnDate(value) {
  const s = assetText(value, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new WorkflowError(400, 'Enter the date the tab was returned to the bank (YYYY-MM-DD)');
  if (s > new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)) throw new WorkflowError(400, 'The return date cannot be in the future');
  return s;
}
export const NETWORKS = { etisalat: 'Etisalat', du: 'du' };
export const ACCESSORIES = { charger: 'Charger', stylus: 'Stylus', card_reader: 'Card reader' };
/** Who keeps the register. */
export const ASSET_ADMINS = ['it', 'business_head', 'mis'];
/** Who may run the inventory report and see every tab. */
export const ASSET_VIEWERS = ['it', 'business_head', 'mis'];

const assetNow = () => new Date().toISOString();
const assetText = (v, max = 100) => { const s = v == null ? '' : String(v).trim(); return s.length > max ? s.slice(0, max) : s; };
const assetFlag = (v) => (v === true || v === 1 || v === '1' || String(v).toLowerCase() === 'true' || String(v).toLowerCase() === 'yes' ? 1 : 0);

const ASSET_SELECT = `SELECT a.*, h.name AS holder_name, h.hrms_code AS holder_hrms_code, h.sales_code AS holder_sales_code, h.region AS holder_region, h.role AS holder_role, h.active AS holder_active,
    tl.name AS holder_team_leader, p.name AS previous_holder_name, p.hrms_code AS previous_holder_hrms_code
  FROM assets a LEFT JOIN users h ON h.id = a.holder_id LEFT JOIN users tl ON tl.id = h.team_leader_id LEFT JOIN users p ON p.id = a.previous_holder_id`;

export const requireAssetAdmin = (user) => { if (!ASSET_ADMINS.includes(user.role)) throw new WorkflowError(403, 'Only IT, MIS and business heads manage assets'); };

function assetDetails(input, current = null) {
  const out = {
    serial_no: assetText(input.serial_no ?? current?.serial_no, 60),
    tab_no: assetText(input.tab_no ?? current?.tab_no, 60),
    charger: input.charger === undefined ? (current?.charger ?? 0) : assetFlag(input.charger),
    stylus: input.stylus === undefined ? (current?.stylus ?? 0) : assetFlag(input.stylus),
    card_reader: input.card_reader === undefined ? (current?.card_reader ?? 0) : assetFlag(input.card_reader),
    network: assetText(input.network ?? current?.network, 20).toLowerCase() || null,
    sim_number: assetText(input.sim_number ?? current?.sim_number, 30) || null,
    entra_id: assetText(input.entra_id ?? current?.entra_id, 120) || null,
    mobile_number: assetText(input.mobile_number ?? current?.mobile_number, 30) || null,
    notes: assetText(input.notes ?? current?.notes, 500) || null,
  };
  if (!out.serial_no) throw new WorkflowError(400, 'Enter the tab serial number');
  if (!out.tab_no) throw new WorkflowError(400, 'Enter the tab number');
  if (out.network && !NETWORKS[out.network]) throw new WorkflowError(400, 'Network must be Etisalat or du');
  if (out.sim_number && !/^[\d\s+-]{6,30}$/.test(out.sim_number)) throw new WorkflowError(400, 'SIM card number should be digits');
  if (out.mobile_number && !/^[\d\s+-]{7,20}$/.test(out.mobile_number)) throw new WorkflowError(400, 'Mobile number should be digits');
  return out;
}

export function getAsset(db, id) {
  const row = db.prepare(`${ASSET_SELECT} WHERE a.id = ?`).get(id);
  if (!row) throw new WorkflowError(404, 'Asset not found');
  return row;
}

/** Every tab, newest first, with optional status, region, network or text filters. */
export function listAssets(db, { status, region, network, q } = {}) {
  const where = []; const params = [];
  if (status) { if (!ASSET_STATUS[status]) throw new WorkflowError(400, 'Unknown status'); where.push('a.status = ?'); params.push(status); }
  if (network) { where.push('a.network = ?'); params.push(String(network).toLowerCase()); }
  if (region) { where.push('(h.region = ? OR (a.holder_id IS NULL AND a.region = ?))'); params.push(String(region).toUpperCase(), String(region).toUpperCase()); }
  if (q) { const like = `%${String(q).trim()}%`; where.push('(a.serial_no LIKE ? OR a.tab_no LIKE ? OR a.sim_number LIKE ? OR a.mobile_number LIKE ? OR a.entra_id LIKE ? OR h.name LIKE ? OR h.hrms_code LIKE ? OR h.sales_code LIKE ?)'); params.push(...Array(8).fill(like)); }
  return db.prepare(`${ASSET_SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY a.status = 'in_use' DESC, a.tab_no`).all(...params);
}

/** The tab a staff member currently holds, or null. */
export const assetOf = (db, userId) => db.prepare(`${ASSET_SELECT} WHERE a.holder_id = ? AND a.status = 'in_use' ORDER BY a.assigned_at DESC`).get(userId) || null;

function logAssetEvent(db, assetId, userId, type, detail, note = null) {
  db.prepare('INSERT INTO asset_events (asset_id, user_id, type, detail, note, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(assetId, userId, type, detail, note, assetNow());
}
export const assetEvents = (db, assetId) => db.prepare(`SELECT e.*, u.name AS user_name FROM asset_events e LEFT JOIN users u ON u.id = e.user_id WHERE e.asset_id = ? ORDER BY e.created_at DESC, e.id DESC`).all(assetId);

/** Registers a tab. It starts with IT unless a holder is given, in which case it is in use. */
export function createAsset(db, user, input) {
  requireAssetAdmin(user);
  const d = assetDetails(input);
  if (db.prepare('SELECT 1 FROM assets WHERE serial_no = ? COLLATE NOCASE').get(d.serial_no)) throw new WorkflowError(409, `A tab with serial number ${d.serial_no} is already registered`);
  const ts = assetNow();
  const region = input.region ? String(input.region).toUpperCase() : null;
  const { lastInsertRowid } = db.prepare(`INSERT INTO assets (kind, serial_no, tab_no, charger, stylus, card_reader, network, sim_number, entra_id, mobile_number, notes, status, region, created_by, created_at, updated_at)
    VALUES ('tab', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'it_custody', ?, ?, ?, ?)`)
    .run(d.serial_no, d.tab_no, d.charger, d.stylus, d.card_reader, d.network, d.sim_number, d.entra_id, d.mobile_number, d.notes, region, user.id, ts, ts);
  logAssetEvent(db, lastInsertRowid, user.id, 'registered', `Tab ${d.tab_no} (serial ${d.serial_no}) registered`);
  if (input.holder_id) return assignAsset(db, user, lastInsertRowid, { holder_id: input.holder_id, note: input.note });
  return getAsset(db, lastInsertRowid);
}

/** Changes the tab's details (serial, number, accessories, SIM, sign-in). */
export function updateAsset(db, user, id, input) {
  requireAssetAdmin(user);
  const current = getAsset(db, id);
  const d = assetDetails(input, current);
  if (d.serial_no.toLowerCase() !== current.serial_no.toLowerCase() && db.prepare('SELECT 1 FROM assets WHERE serial_no = ? COLLATE NOCASE AND id != ?').get(d.serial_no, id)) {
    throw new WorkflowError(409, `A tab with serial number ${d.serial_no} is already registered`);
  }
  db.prepare(`UPDATE assets SET serial_no = ?, tab_no = ?, charger = ?, stylus = ?, card_reader = ?, network = ?, sim_number = ?, entra_id = ?, mobile_number = ?, notes = ?, updated_at = ? WHERE id = ?`)
    .run(d.serial_no, d.tab_no, d.charger, d.stylus, d.card_reader, d.network, d.sim_number, d.entra_id, d.mobile_number, d.notes, assetNow(), id);
  const changed = Object.keys(d).filter((k) => String(d[k] ?? '') !== String(current[k] ?? ''));
  if (changed.length) logAssetEvent(db, id, user.id, 'updated', `Changed ${changed.join(', ')}`);
  return getAsset(db, id);
}

/** Hands the tab to a staff member: it becomes active and in use with them. */
export function assignAsset(db, user, id, { holder_id, note } = {}) {
  requireAssetAdmin(user);
  const current = getAsset(db, id);
  const holder = db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(Number(holder_id));
  if (!holder) throw new WorkflowError(400, 'Choose the staff member who receives the tab');
  if (!holder.active) throw new WorkflowError(400, `${holder.name}'s account is disabled`);
  const other = assetOf(db, holder.id);
  if (other && other.id !== id) throw new WorkflowError(409, `${holder.name} already holds tab ${other.tab_no}; move it to IT custody or hand it over first`);
  const ts = assetNow();
  db.prepare(`UPDATE assets SET status = 'in_use', holder_id = ?, previous_holder_id = ?, assigned_at = ?, status_note = ?, status_by = ?, status_at = ?, returned_on = NULL, updated_at = ? WHERE id = ?`)
    .run(holder.id, current.holder_id && current.holder_id !== holder.id ? current.holder_id : current.previous_holder_id, ts, assetText(note, 300) || null, user.id, ts, ts, id);
  logAssetEvent(db, id, user.id, 'assigned', `Assigned to ${holder.name}`, assetText(note, 300) || null);
  return getAsset(db, id);
}

/** Moves the tab to IT custody, records it handed over on the holder's exit, or returned to the bank on a date. */
export function setAssetStatus(db, user, id, { status, note, returned_on } = {}) {
  requireAssetAdmin(user);
  if (!ASSET_STATUS[status]) throw new WorkflowError(400, 'Choose a status: Active in use, With IT custody, Handed over on exit or Returned to bank');
  const returned = status === 'returned_to_bank' ? returnDate(returned_on) : null;
  if (status === 'in_use') throw new WorkflowError(400, 'To put a tab in use, assign it to a staff member');
  const current = getAsset(db, id);
  if (current.status === status && !(returned && returned !== current.returned_on)) throw new WorkflowError(409, `The tab is already ${ASSET_STATUS[status]}`);
  if (status === 'handed_over' && !current.holder_id && !current.previous_holder_id) throw new WorkflowError(400, 'This tab was never assigned; move it to IT custody instead');
  const ts = assetNow();
  db.prepare(`UPDATE assets SET status = ?, holder_id = NULL, previous_holder_id = COALESCE(holder_id, previous_holder_id), status_note = ?, status_by = ?, status_at = ?, returned_on = ?, updated_at = ? WHERE id = ?`)
    .run(status, assetText(note, 300) || null, user.id, ts, returned, ts, id);
  logAssetEvent(db, id, user.id, 'status', `${ASSET_STATUS[status]}${returned ? ` on ${returned}` : ''}${current.holder_name ? ` (from ${current.holder_name})` : ''}`, assetText(note, 300) || null);
  return getAsset(db, id);
}

/** Counts by status, for the register page and the inventory report. */
export function assetSummary(db) {
  const out = { total: 0 };
  for (const k of Object.keys(ASSET_STATUS)) out[k] = 0;
  for (const r of db.prepare('SELECT status, COUNT(*) AS n FROM assets GROUP BY status').all()) { out[r.status] = r.n; out.total += r.n; }
  out.staff_without_tab = db.prepare("SELECT COUNT(*) AS n FROM users u WHERE u.role = 'sales' AND u.active = 1 AND NOT EXISTS (SELECT 1 FROM assets a WHERE a.holder_id = u.id AND a.status = 'in_use')").get().n;
  return out;
}

/** The inventory: one row per tab with its holder and accessories. */
export function inventoryRows(db, region = null) {
  return listAssets(db, { region }).map((a) => ({
    tab_no: a.tab_no, serial_no: a.serial_no, status: ASSET_STATUS[a.status], holder: a.holder_name || '', holder_hrms_code: a.holder_hrms_code || '', holder_sales_code: a.holder_sales_code || '',
    region: a.holder_region || a.region || '', team_leader: a.holder_team_leader || '', charger: a.charger ? 'Yes' : 'No', stylus: a.stylus ? 'Yes' : 'No', card_reader: a.card_reader ? 'Yes' : 'No',
    network: NETWORKS[a.network] || '', sim_number: a.sim_number || '', entra_id: a.entra_id || '', mobile_number: a.mobile_number || '', assigned_at: a.assigned_at, status_at: a.status_at, returned_on: a.returned_on || null,
    previous_holder: a.previous_holder_name || '', status_note: a.status_note || '', notes: a.notes || '',
  }));
}
