// Chat inside the CRM: a discussion on every case, direct messages between colleagues, and
// automatic groups (each team leader's team, the processing team, everyone). Messages are kept
// for good (edits allowed for a few minutes, no deleting) and governance and the business head can
// read any conversation. @mentions notify the person named.
import { caseRef, notify, WorkflowError } from './cases.js';

export const EDIT_WINDOW_MINUTES = 5;
export const MAX_MESSAGE = 4000;
// Readers of every conversation, for oversight. Said plainly on the Messages page.
export const CHAT_OVERSEERS = ['governance', 'business_head'];

const nowIso = () => new Date().toISOString();

// Looks like an Emirates ID or a phone number: the message is posted but flagged, so people stop
// pasting personal data into chat and governance can see where it happens.
const PII_PATTERNS = [/784[-\s]?\d{4}[-\s]?\d{7}[-\s]?\d/, /(?:\+|00)?\d[\d\s-]{8,}\d/];
export const looksLikePii = (text) => PII_PATTERNS.some((re) => re.test(String(text)));

function cleanBody(body) {
  const text = String(body ?? '').trim();
  if (!text) throw new WorkflowError(400, 'Type a message first');
  if (text.length > MAX_MESSAGE) throw new WorkflowError(400, `Messages can be up to ${MAX_MESSAGE} characters`);
  return text;
}

/** User ids mentioned as @First or @First Last (case-insensitive; full names win over first names). */
export function mentionedUsers(db, text, { exclude = null } = {}) {
  const lower = String(text).toLowerCase();
  if (!lower.includes('@')) return [];
  const users = db.prepare('SELECT id, name FROM users WHERE active = 1').all();
  const hit = new Set();
  for (const u of users) {
    if (u.id === exclude) continue;
    const full = u.name.toLowerCase();
    const first = full.split(/\s+/)[0];
    if (lower.includes(`@${full}`)) hit.add(u.id);
    else if (new RegExp(`@${first.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![a-z])`).test(lower)) hit.add(u.id);
  }
  return [...hit];
}

const MESSAGE_SELECT = `SELECT m.id, m.case_id, m.conversation_id, m.user_id, m.body, m.flagged, m.created_at, m.edited_at,
    u.name AS user_name, u.role AS user_role
  FROM messages m JOIN users u ON u.id = m.user_id`;

function canSeeCase(db, user, caseId) {
  const row = db.prepare('SELECT id, created_by, sales_staff_id, customer_name FROM cases WHERE id = ?').get(caseId);
  if (!row) throw new WorkflowError(404, 'Case not found');
  if (user.role === 'sales' && row.created_by !== user.id && row.sales_staff_id !== user.id) throw new WorkflowError(404, 'Case not found');
  return row;
}

// ---------- case discussions ----------

export function listCaseMessages(db, user, caseId, { after = 0 } = {}) {
  canSeeCase(db, user, caseId);
  const items = db.prepare(`${MESSAGE_SELECT} WHERE m.case_id = ? AND m.id > ? ORDER BY m.id`).all(caseId, Number(after) || 0);
  return { items, edit_window_minutes: EDIT_WINDOW_MINUTES };
}

export function postCaseMessage(db, user, caseId, body) {
  const row = canSeeCase(db, user, caseId);
  const text = cleanBody(body);
  const { lastInsertRowid } = db.prepare('INSERT INTO messages (case_id, user_id, body, flagged, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(caseId, user.id, text, looksLikePii(text) ? 1 : 0, nowIso());
  const ref = caseRef(caseId);
  const mentioned = mentionedUsers(db, text, { exclude: user.id });
  if (mentioned.length) notify(db, mentioned, caseId, `${user.name} mentioned you on ${ref} (${row.customer_name}): ${text.slice(0, 120)}`);
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(Number(lastInsertRowid));
}

// ---------- conversations: direct messages and groups ----------

/** Keeps the automatic groups in step with the users table. Cheap enough to run on each listing. */
export function syncGroups(db) {
  const ensure = (key, name, memberIds) => {
    let conv = db.prepare('SELECT id FROM conversations WHERE kind = ? AND group_key = ?').get('group', key);
    if (!conv) {
      const r = db.prepare('INSERT INTO conversations (kind, name, group_key, created_at) VALUES (?, ?, ?, ?)').run('group', name, key, nowIso());
      conv = { id: Number(r.lastInsertRowid) };
    } else db.prepare('UPDATE conversations SET name = ? WHERE id = ?').run(name, conv.id);
    const current = new Set(db.prepare('SELECT user_id FROM conversation_members WHERE conversation_id = ?').all(conv.id).map((m) => m.user_id));
    for (const id of memberIds) if (!current.has(id)) db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(conv.id, id);
    for (const id of current) if (!memberIds.has(id)) db.prepare('DELETE FROM conversation_members WHERE conversation_id = ? AND user_id = ?').run(conv.id, id);
  };
  const users = db.prepare('SELECT id, name, role, team_leader_id, sales_manager_id FROM users WHERE active = 1').all();
  ensure('all', 'Everyone', new Set(users.map((u) => u.id)));
  ensure('processing', 'Processing team', new Set(users.filter((u) => u.role === 'processing').map((u) => u.id)));
  for (const tl of users.filter((u) => u.role === 'team_leader')) {
    const team = users.filter((u) => u.id === tl.id || u.team_leader_id === tl.id);
    const managers = new Set(team.map((u) => u.sales_manager_id).filter(Boolean));
    ensure(`team:${tl.id}`, `Team ${tl.name.split(/\s+/)[0]}`, new Set([...team.map((u) => u.id), ...managers]));
  }
}

function isMember(db, user, conversationId) {
  return Boolean(db.prepare('SELECT 1 FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conversationId, user.id));
}

function conversationFor(db, user, id) {
  const conv = db.prepare('SELECT * FROM conversations WHERE id = ?').get(Number(id));
  if (!conv) throw new WorkflowError(404, 'Conversation not found');
  const member = isMember(db, user, conv.id);
  if (!member && !CHAT_OVERSEERS.includes(user.role)) throw new WorkflowError(404, 'Conversation not found');
  return { conv, member };
}

const membersOf = (db, conversationId) =>
  db.prepare('SELECT u.id, u.name, u.role FROM conversation_members cm JOIN users u ON u.id = cm.user_id WHERE cm.conversation_id = ? ORDER BY u.name').all(conversationId);

function describe(db, user, conv) {
  const members = membersOf(db, conv.id);
  const last = db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? ORDER BY m.id DESC LIMIT 1`).get(conv.id) || null;
  const me = db.prepare('SELECT last_read_id FROM conversation_members WHERE conversation_id = ? AND user_id = ?').get(conv.id, user.id);
  const unread = me ? db.prepare('SELECT COUNT(*) AS n FROM messages WHERE conversation_id = ? AND id > ? AND user_id != ?').get(conv.id, me.last_read_id || 0, user.id).n : 0;
  const other = conv.kind === 'dm' ? members.find((m) => m.id !== user.id) || members[0] : null;
  // A direct message is named after the other person; an overseer reading it sees both names.
  const dmName = me ? (other ? other.name : 'Direct message') : members.map((m) => m.name).join(' ↔ ');
  return {
    id: conv.id, kind: conv.kind, group_key: conv.group_key,
    name: conv.kind === 'dm' ? dmName : conv.name,
    other_user: other, members, member: Boolean(me),
    last_message: last && { body: last.body, user_name: last.user_name, created_at: last.created_at, flagged: last.flagged },
    unread,
  };
}

/** The user's conversations (every conversation for overseers), most recent first. */
export function listConversations(db, user) {
  syncGroups(db);
  const rows = CHAT_OVERSEERS.includes(user.role)
    ? db.prepare('SELECT * FROM conversations ORDER BY id').all()
    : db.prepare('SELECT c.* FROM conversations c JOIN conversation_members cm ON cm.conversation_id = c.id AND cm.user_id = ? ORDER BY c.id').all(user.id);
  const items = rows.map((c) => describe(db, user, c)).sort((a, b) => {
    const ta = a.last_message?.created_at || '';
    const tb = b.last_message?.created_at || '';
    return tb.localeCompare(ta) || (a.kind === 'group') - (b.kind === 'group');
  });
  return { items, unread: items.reduce((n, c) => n + c.unread, 0), overseer: CHAT_OVERSEERS.includes(user.role) };
}

/** Colleagues a message can be started with. */
export function listColleagues(db, user) {
  return { users: db.prepare("SELECT id, name, role FROM users WHERE active = 1 AND id != ? ORDER BY name").all(user.id) };
}

/** Finds or starts the direct message conversation with another user. */
export function openDirect(db, user, otherId) {
  const other = db.prepare('SELECT id, name FROM users WHERE id = ? AND active = 1').get(Number(otherId));
  if (!other || other.id === user.id) throw new WorkflowError(400, 'Choose a colleague to message');
  const existing = db.prepare(`SELECT c.id FROM conversations c
      JOIN conversation_members a ON a.conversation_id = c.id AND a.user_id = ?
      JOIN conversation_members b ON b.conversation_id = c.id AND b.user_id = ?
    WHERE c.kind = 'dm' LIMIT 1`).get(user.id, other.id);
  let id = existing?.id;
  if (!id) {
    id = Number(db.prepare("INSERT INTO conversations (kind, name, created_at) VALUES ('dm', NULL, ?)").run(nowIso()).lastInsertRowid);
    for (const uid of [user.id, other.id]) db.prepare('INSERT INTO conversation_members (conversation_id, user_id) VALUES (?, ?)').run(id, uid);
  }
  return describe(db, user, db.prepare('SELECT * FROM conversations WHERE id = ?').get(id));
}

export function listMessages(db, user, conversationId, { after = 0, limit = 200 } = {}) {
  const { conv, member } = conversationFor(db, user, conversationId);
  const items = db.prepare(`${MESSAGE_SELECT} WHERE m.conversation_id = ? AND m.id > ? ORDER BY m.id DESC LIMIT ?`)
    .all(conv.id, Number(after) || 0, Math.min(Number(limit) || 200, 500)).reverse();
  if (member && items.length) markRead(db, user, conv.id, items[items.length - 1].id);
  return { conversation: describe(db, user, conv), items, edit_window_minutes: EDIT_WINDOW_MINUTES };
}

export function markRead(db, user, conversationId, upTo) {
  db.prepare('UPDATE conversation_members SET last_read_id = MAX(COALESCE(last_read_id, 0), ?) WHERE conversation_id = ? AND user_id = ?')
    .run(Number(upTo) || 0, Number(conversationId), user.id);
}

export function postMessage(db, user, conversationId, body) {
  const { conv, member } = conversationFor(db, user, conversationId);
  if (!member) throw new WorkflowError(403, 'You can read this conversation but only its members can post in it');
  const text = cleanBody(body);
  const { lastInsertRowid } = db.prepare('INSERT INTO messages (conversation_id, user_id, body, flagged, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(conv.id, user.id, text, looksLikePii(text) ? 1 : 0, nowIso());
  const id = Number(lastInsertRowid);
  markRead(db, user, conv.id, id);
  // Direct messages alert the other person; in groups only the people @mentioned are alerted.
  const label = conv.kind === 'dm' ? 'Message' : `${conv.name}`;
  const to = conv.kind === 'dm'
    ? membersOf(db, conv.id).map((m) => m.id).filter((uid) => uid !== user.id)
    : mentionedUsers(db, text, { exclude: user.id }).filter((uid) => isMember(db, { id: uid }, conv.id));
  if (to.length) notify(db, to, null, `${label} from ${user.name}: ${text.slice(0, 120)}`, `#/messages/${conv.id}`);
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(id);
}

/** The author can correct a message for a few minutes; the edit is marked, nothing is deleted. */
export function editMessage(db, user, messageId, body) {
  const m = db.prepare('SELECT * FROM messages WHERE id = ?').get(Number(messageId));
  if (!m || m.user_id !== user.id) throw new WorkflowError(404, 'Message not found');
  if (Date.now() - Date.parse(m.created_at) > EDIT_WINDOW_MINUTES * 60e3) throw new WorkflowError(409, `Messages can only be edited for ${EDIT_WINDOW_MINUTES} minutes`);
  const text = cleanBody(body);
  db.prepare('UPDATE messages SET body = ?, flagged = ?, edited_at = ? WHERE id = ?').run(text, looksLikePii(text) ? 1 : 0, nowIso(), m.id);
  return db.prepare(`${MESSAGE_SELECT} WHERE m.id = ?`).get(m.id);
}

/** Unread direct and group messages, for the menu badge. */
export function unreadCount(db, user) {
  return db.prepare(`SELECT COUNT(*) AS n FROM messages m JOIN conversation_members cm ON cm.conversation_id = m.conversation_id AND cm.user_id = ?
    WHERE m.id > COALESCE(cm.last_read_id, 0) AND m.user_id != ?`).get(user.id, user.id).n;
}
