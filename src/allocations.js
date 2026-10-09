// Processor allocation: the verification team leader (or a business head) decides which processor
// verifies each sales team leader's files, per product: credit cards, personal loans and auto loans
// can go to the same processor or to different ones. A file with an allocated product reaches the
// allocated processors' queues only; team leaders and products without one go to the shared queue.
import { WorkflowError } from './cases.js';
import { isProcessingLead } from './roles.js';

export const ALLOCATION_PRODUCTS = { credit_card: 'Credit cards', personal_loan: 'Personal loans', auto_loan: 'Auto loans' };
export const canAllocate = (user) => isProcessingLead(user) || user.role === 'business_head';
const requireAllocator = (user) => { if (!canAllocate(user)) throw new WorkflowError(403, 'Only the verification team leader or a business head allocates processors'); };

export function listAllocations(db, user) {
  requireAllocator(user);
  const rows = db.prepare(`SELECT a.team_leader_id, a.product, a.processor_id, p.name AS processor_name, a.set_at, s.name AS set_by_name
    FROM processor_allocations a JOIN users p ON p.id = a.processor_id LEFT JOIN users s ON s.id = a.set_by`).all();
  const team_leaders = db.prepare(`SELECT u.id, u.name, u.region,
      (SELECT COUNT(*) FROM users x WHERE x.team_leader_id = u.id AND x.active = 1 AND x.role = 'sales') AS staff
    FROM users u WHERE u.role = 'team_leader' AND u.active = 1 ORDER BY u.region, u.name`).all()
    .map((t) => ({ ...t, products: Object.fromEntries(Object.keys(ALLOCATION_PRODUCTS).map((p) => { const a = rows.find((r) => r.team_leader_id === t.id && r.product === p); return [p, a ? { processor_id: a.processor_id, processor_name: a.processor_name, set_at: a.set_at, set_by_name: a.set_by_name } : null]; })) }));
  const processors = db.prepare(`SELECT u.id, u.name, u.region, u.role_key,
      (SELECT COUNT(DISTINCT a.team_leader_id) FROM processor_allocations a WHERE a.processor_id = u.id) AS team_leaders,
      (SELECT COUNT(*) FROM processor_allocations a WHERE a.processor_id = u.id) AS allocations
    FROM users u WHERE u.role = 'processing' AND u.active = 1 ORDER BY u.name`).all();
  return { team_leaders, processors, products: ALLOCATION_PRODUCTS };
}

/** Sets who verifies a team leader's files for one product, or for 'all' of them; a null processor clears it. */
export function setAllocation(db, user, teamLeaderId, { product = 'all', processor_id } = {}) {
  requireAllocator(user);
  const tl = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'team_leader' AND active = 1").get(Number(teamLeaderId));
  if (!tl) throw new WorkflowError(404, 'Team leader not found');
  const products = product === 'all' || product == null ? Object.keys(ALLOCATION_PRODUCTS) : [String(product)];
  if (products.some((p) => !ALLOCATION_PRODUCTS[p])) throw new WorkflowError(400, 'Product must be credit cards, personal loans, auto loans or all');
  if (processor_id == null || processor_id === '') {
    for (const p of products) db.prepare('DELETE FROM processor_allocations WHERE team_leader_id = ? AND product = ?').run(tl.id, p);
    return { team_leader_id: tl.id, products, processor_id: null };
  }
  const p = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'processing' AND active = 1").get(Number(processor_id));
  if (!p) throw new WorkflowError(400, 'Choose an active processor');
  const ts = new Date().toISOString();
  for (const prod of products) {
    db.prepare(`INSERT INTO processor_allocations (team_leader_id, product, processor_id, set_by, set_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(team_leader_id, product) DO UPDATE SET processor_id = excluded.processor_id, set_by = excluded.set_by, set_at = excluded.set_at`).run(tl.id, prod, p.id, user.id, ts);
  }
  return { team_leader_id: tl.id, products, processor_id: p.id, processor_name: p.name };
}
