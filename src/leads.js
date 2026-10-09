// Leads: prospects a sales person is working before there is a file. A lead belongs to the sales
// person who entered it; their team leader can see it too. Nobody else. A lead ends by becoming a
// file (converted), or marked not interested or not eligible.
import { WorkflowError, PRODUCTS } from './cases.js';
import { TEAM_LEADER_ROLES } from './users.js';

export const LEAD_STATUS = { open: 'Open', converted: 'Converted', not_interested: 'Not interested', not_eligible: 'Not eligible' };
const leadNow = () => new Date().toISOString();
const leadText = (v, max = 200) => { const s = v == null ? '' : String(v).trim(); return s.length > max ? s.slice(0, max) : s; };

const LEAD_SELECT = `SELECT l.*, u.name AS owner_name, u.sales_code AS owner_sales_code, u.team_leader_id AS owner_team_leader_id FROM leads l JOIN users u ON u.id = l.owner_id`;

/** Whether the viewer may see a lead: its owner, or the owner's team leader. */
export const canSeeLead = (user, lead) => lead.owner_id === user.id || (TEAM_LEADER_ROLES.includes(user.role) && lead.owner_team_leader_id === user.id);
const leadScope = (user) => {
  if (user.role === 'sales') return { sql: 'l.owner_id = ?', params: [user.id] };
  if (TEAM_LEADER_ROLES.includes(user.role)) return { sql: 'u.team_leader_id = ?', params: [user.id] };
  throw new WorkflowError(403, 'Leads are for sales staff and their team leaders');
};

export function getLead(db, user, id) {
  const lead = db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(id);
  if (!lead || !canSeeLead(user, lead)) throw new WorkflowError(404, 'Lead not found');
  return lead;
}

/** The viewer's leads: their own, or their team's for a team leader. */
export function listLeads(db, user, { status, q } = {}) {
  const scope = leadScope(user);
  const where = [scope.sql]; const params = [...scope.params];
  if (status) { if (!LEAD_STATUS[status]) throw new WorkflowError(400, 'Unknown lead status'); where.push('l.status = ?'); params.push(status); }
  if (q) { const like = `%${String(q).trim()}%`; where.push('(l.customer_name LIKE ? OR l.phone LIKE ? OR l.company_name LIKE ? OR u.name LIKE ?)'); params.push(like, like, like, like); }
  const leads = db.prepare(`${LEAD_SELECT} WHERE ${where.join(' AND ')} ORDER BY l.status = 'open' DESC, COALESCE(l.follow_up_at, '9999') , l.updated_at DESC`).all(...params);
  const counts = { open: 0, converted: 0, not_interested: 0, not_eligible: 0, due: 0 };
  const today = new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10);
  for (const l of db.prepare(`SELECT l.status, l.follow_up_at FROM leads l JOIN users u ON u.id = l.owner_id WHERE ${scope.sql}`).all(...scope.params)) {
    counts[l.status] = (counts[l.status] || 0) + 1;
    if (l.status === 'open' && l.follow_up_at && l.follow_up_at <= today) counts.due++;
  }
  return { leads, counts };
}

function leadDetails(input, current = null) {
  const pick = (k, max) => leadText(input[k] ?? current?.[k], max);
  const out = {
    first_name: pick('first_name', 60), middle_name: pick('middle_name', 60) || null, last_name: pick('last_name', 60),
    phone: pick('phone', 30), email: pick('email', 200) || null, company_name: pick('company_name', 200) || null,
    product: pick('product', 30) || null, source: pick('source', 200) || null, city: pick('city', 100) || null, notes: pick('notes', 2000) || null,
    follow_up_at: pick('follow_up_at', 10) || null,
  };
  const salary = input.salary === undefined ? current?.salary ?? null : (String(input.salary).trim() === '' ? null : Number(String(input.salary).replace(/,/g, '')));
  if (salary != null && !(salary >= 0)) throw new WorkflowError(400, 'Salary must be a number');
  out.salary = salary;
  if (!out.first_name || !out.last_name) throw new WorkflowError(400, 'Enter the customer\'s first and last name');
  if (!/^[+\d][\d\s-]{6,29}$/.test(out.phone)) throw new WorkflowError(400, 'Enter a mobile number');
  if (out.product && !PRODUCTS[out.product]) throw new WorkflowError(400, 'Choose a product: Personal Loan, Credit Card, Auto Loan or Accounts');
  if (out.follow_up_at && !/^\d{4}-\d{2}-\d{2}$/.test(out.follow_up_at)) throw new WorkflowError(400, 'Follow-up date must be YYYY-MM-DD');
  out.customer_name = [out.first_name, out.middle_name, out.last_name].filter(Boolean).join(' ');
  return out;
}

/** A sales person adds a lead for themselves; a team leader may add one for a staff member of theirs. */
export function createLead(db, user, input) {
  let owner = user.id;
  if (user.role !== 'sales') {
    if (!TEAM_LEADER_ROLES.includes(user.role)) throw new WorkflowError(403, 'Only sales staff and their team leaders add leads');
    const s = db.prepare("SELECT id FROM users WHERE id = ? AND role = 'sales' AND active = 1 AND team_leader_id = ?").get(Number(input.owner_id), user.id);
    if (!s) throw new WorkflowError(400, 'Choose which of your sales staff the lead is for');
    owner = s.id;
  }
  const d = leadDetails(input);
  const ts = leadNow();
  const { lastInsertRowid } = db.prepare(`INSERT INTO leads (owner_id, customer_name, first_name, middle_name, last_name, phone, email, company_name, salary, product, source, city, notes, follow_up_at, status, created_by, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?, ?)`)
    .run(owner, d.customer_name, d.first_name, d.middle_name, d.last_name, d.phone, d.email, d.company_name, d.salary, d.product, d.source, d.city, d.notes, d.follow_up_at, user.id, ts, ts);
  return getLead(db, user, Number(lastInsertRowid));
}

/** The owner edits an open lead. */
export function updateLead(db, user, id, input) {
  const lead = getLead(db, user, id);
  if (lead.owner_id !== user.id) throw new WorkflowError(403, 'Only the sales person who owns the lead can change it');
  if (lead.status !== 'open') throw new WorkflowError(409, `The lead is ${LEAD_STATUS[lead.status].toLowerCase()}; reopen it first`);
  const d = leadDetails(input, lead);
  db.prepare(`UPDATE leads SET customer_name = ?, first_name = ?, middle_name = ?, last_name = ?, phone = ?, email = ?, company_name = ?, salary = ?, product = ?, source = ?, city = ?, notes = ?, follow_up_at = ?, updated_at = ? WHERE id = ?`)
    .run(d.customer_name, d.first_name, d.middle_name, d.last_name, d.phone, d.email, d.company_name, d.salary, d.product, d.source, d.city, d.notes, d.follow_up_at, leadNow(), id);
  return getLead(db, user, id);
}

/** Not interested, not eligible, or back to open. Converting happens when the file is created. */
export function setLeadStatus(db, user, id, { status, note } = {}) {
  const lead = getLead(db, user, id);
  if (lead.owner_id !== user.id) throw new WorkflowError(403, 'Only the sales person who owns the lead can change it');
  if (!['open', 'not_interested', 'not_eligible'].includes(status)) throw new WorkflowError(400, 'Mark the lead Not interested or Not eligible, or reopen it');
  if (lead.status === 'converted') throw new WorkflowError(409, 'The lead was converted into a file and cannot change');
  if (lead.status === status) throw new WorkflowError(409, `The lead is already ${LEAD_STATUS[status].toLowerCase()}`);
  const ts = leadNow();
  db.prepare('UPDATE leads SET status = ?, status_note = ?, status_at = ?, updated_at = ? WHERE id = ?').run(status, leadText(note, 500) || null, ts, ts, id);
  return getLead(db, user, id);
}

/** Called when a file is created from a lead: the lead becomes Converted and points at the file. */
export function convertLead(db, user, id, caseId) {
  const lead = db.prepare(`${LEAD_SELECT} WHERE l.id = ?`).get(Number(id));
  if (!lead || lead.owner_id !== user.id) throw new WorkflowError(404, 'Lead not found');
  if (lead.status !== 'open') throw new WorkflowError(409, `The lead is ${LEAD_STATUS[lead.status].toLowerCase()} and cannot be converted`);
  const ts = leadNow();
  db.prepare("UPDATE leads SET status = 'converted', case_id = ?, status_at = ?, updated_at = ? WHERE id = ?").run(caseId, ts, ts, lead.id);
}
