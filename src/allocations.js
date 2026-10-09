// Processor allocation: the verification team leader (or a business head) decides which processor
// verifies each sales team leader's files. An allocated team leader's files reach that processor's
// queue only; team leaders without one go to the shared queue.
import { WorkflowError } from './cases.js';
import { isProcessingLead } from './roles.js';

export const canAllocate = (user) => isProcessingLead(user) || user.role === 'business_head';
const requireAllocator = (user) => { if (!canAllocate(user)) throw new WorkflowError(403, 'Only the verification team leader or a business head allocates processors'); };

export function listAllocations(db, user) {
  requireAllocator(user);
  const team_leaders = db.prepare(`SELECT u.id, u.name, u.region, a.processor_id, p.name AS processor_name, a.set_at, s.name AS set_by_name,
      (SELECT COUNT(*) FROM users x WHERE x.team_leader_id = u.id AND x.active = 1 AND x.role = 'sales') AS staff
    FROM users u LEFT JOIN processor_allocations a ON a.team_leader_id = u.id LEFT JOIN users p ON p.id = a.processor_id LEFT JOIN users s ON s.id = a.set_by
    WHERE u.role = 'team_leader' AND u.active = 1 ORDER BY u.region, u.name`).all();
  const processors = db.prepare(`SELECT u.id, u.name, u.region, u.role_key,
      (SELECT COUNT(*) FROM processor_allocations a WHERE a.processor_id = u.id) AS team_leaders
    FROM users u WHERE u.role = 'processing' AND u.active = 1 ORDER BY u.name`).all();
  return { team_leaders, processors };
}

export function setAllocation(db, user, teamLeaderId, processorId) {
  requireAllocator(user);
  const tl = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'team_leader' AND active = 1").get(Number(teamLeaderId));
  if (!tl) throw new WorkflowError(404, 'Team leader not found');
  if (processorId == null || processorId === '') {
    db.prepare('DELETE FROM processor_allocations WHERE team_leader_id = ?').run(tl.id);
    return { team_leader_id: tl.id, processor_id: null };
  }
  const p = db.prepare("SELECT id, name FROM users WHERE id = ? AND role = 'processing' AND active = 1").get(Number(processorId));
  if (!p) throw new WorkflowError(400, 'Choose an active processor');
  db.prepare(`INSERT INTO processor_allocations (team_leader_id, processor_id, set_by, set_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(team_leader_id) DO UPDATE SET processor_id = excluded.processor_id, set_by = excluded.set_by, set_at = excluded.set_at`).run(tl.id, p.id, user.id, new Date().toISOString());
  return { team_leader_id: tl.id, processor_id: p.id, processor_name: p.name };
}
