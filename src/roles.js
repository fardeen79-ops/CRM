// Custom roles: a role the agency defines on top of a built-in one. It behaves like its base role in
// the workflow (what files it can see, which actions it has) but can be given fewer screens, fewer
// reports, no uploads, no downloads, or no pricing. IT, Dubai MIS and business heads define them.
import { WorkflowError } from './cases.js';

/** The screens a role can be given, with the API each one needs (gated for custom roles). */
export const PAGES = {
  cases: { label: 'Files', help: 'The case list, case pages and the verification work of the base role', paths: /^\/api\/cases(\/|$)/ },
  targets: { label: 'Targets and incentives', help: 'Targets, achievement and the incentive working', paths: /^\/api\/(targets|incentives)(\/|$)/ },
  my_tab: { label: 'My tab', help: 'The sales person\'s own sourcing tab', paths: /^\/api\/assets\/mine$/ },
  team: { label: 'Team view', help: 'The hierarchy with each team\'s numbers', paths: /^\/api\/hierarchy(\/|$)/ },
  cards: { label: 'Card activation', help: 'Card status and ageing', paths: null },
  reports: { label: 'Reports', help: 'The reports chosen below', paths: /^\/api\/reports(\/|$)/ },
  uploads: { label: 'Bulk upload', help: 'The uploads chosen below', paths: /^\/api\/import(\/|$)/ },
  staff: { label: 'Staff', help: 'The staff list and user accounts', paths: /^\/api\/users(\/|$)/ },
  access_log: { label: 'Access log', help: 'Who opened and revealed what', paths: /^\/api\/access(\/|-)/ },
  assets: { label: 'Tab register', help: 'The sourcing tabs issued to staff', paths: /^\/api\/assets(\/|$)/ },
  chat: { label: 'Messages', help: 'Case discussions and direct messages', paths: /^\/api\/(conversations|messages)(\/|$)/ },
  roles: { label: 'Roles', help: 'Defining roles (IT, Dubai MIS and business heads only)', paths: /^\/api\/roles(\/|$)/ },
};
/** The uploads a role can be given. */
export const UPLOAD_KINDS = { cases: 'Files', users: 'Staff', cards: 'Card activation', card_products: 'Card products', target_rules: 'Salary targets', targets: 'Targets', payout_rules: 'Payout rules', assets: 'Tab register' };

/** The built-in roles: what each one sees, which a custom role based on it can only narrow. */
const MANAGE = ['cases', 'targets', 'team', 'cards', 'reports', 'uploads', 'staff', 'access_log', 'assets', 'chat', 'roles'];
export const BUILTIN_ROLES = {
  sales: { label: 'Sales', pages: ['cases', 'targets', 'my_tab', 'chat'], uploads: [] },
  processing: { label: 'Processing', pages: ['cases', 'chat'], uploads: [] },
  team_leader: { label: 'Team Leader', pages: ['cases', 'targets', 'team', 'reports', 'chat'], uploads: [] },
  asm: { label: 'Assistant Sales Manager', pages: ['cases', 'targets', 'team', 'reports', 'chat'], uploads: [] },
  sales_manager: { label: 'Sales Manager', pages: ['cases', 'targets', 'team', 'reports', 'chat'], uploads: [] },
  mis: { label: 'MIS', pages: MANAGE, uploads: Object.keys(UPLOAD_KINDS) },
  business_head: { label: 'Business Head', pages: MANAGE, uploads: Object.keys(UPLOAD_KINDS) },
  governance: { label: 'Governance', pages: ['cases', 'team', 'reports', 'access_log', 'chat'], uploads: [] },
  it: { label: 'IT', pages: ['assets', 'uploads', 'reports', 'roles'], uploads: ['assets'] },
};
export const BUILTIN_KEYS = Object.keys(BUILTIN_ROLES);

/** Who defines roles: IT, Dubai MIS and business heads. */
export const canManageRoles = (user) => user.role === 'it' || user.role === 'business_head' || (user.role === 'mis' && String(user.region || '').toUpperCase() === 'DXB');
export const requireRoleManager = (user) => { if (!canManageRoles(user)) throw new WorkflowError(403, 'Only IT, Dubai MIS and business heads define roles'); };

let cache = new Map();
/** Loads the custom roles into memory; called at start-up and after every change. */
export function loadRoles(db) {
  cache = new Map(db.prepare('SELECT * FROM roles ORDER BY label').all().map((r) => [r.key, { ...r, pages: JSON.parse(r.pages), reports: r.reports == null ? null : JSON.parse(r.reports), uploads: JSON.parse(r.uploads), downloads: !!r.downloads, payout: !!r.payout }]));
  return cache;
}
export const customRoles = () => [...cache.values()];
export const roleLabels = () => ({ ...Object.fromEntries(BUILTIN_KEYS.map((k) => [k, BUILTIN_ROLES[k].label])), ...Object.fromEntries(customRoles().map((r) => [r.key, r.label])) });

/** A role key as users and uploads give it (built-in key, custom key, or either's label) → { base, key }. */
export function resolveRole(value) {
  const v = String(value ?? '').trim().toLowerCase();
  if (!v) throw new WorkflowError(400, 'Choose a role');
  const builtin = BUILTIN_KEYS.find((k) => k === v || BUILTIN_ROLES[k].label.toLowerCase() === v);
  if (builtin) return { base: builtin, key: null };
  const custom = customRoles().find((r) => r.key === v || r.label.toLowerCase() === v);
  if (custom) return { base: custom.base, key: custom.key };
  throw new WorkflowError(400, `Role must be one of: ${Object.values(roleLabels()).join(', ')}`);
}

/** What a user may see and do, from their base role narrowed by their custom role, if any. */
export function permissionsOf(user) {
  const base = BUILTIN_ROLES[user.role] || { pages: [], uploads: [] };
  const custom = user.role_key ? cache.get(user.role_key) : null;
  if (!custom) return { custom: false, pages: base.pages, reports: null, uploads: base.uploads, downloads: true, payout: true };
  return {
    custom: true, key: custom.key, label: custom.label,
    pages: custom.pages.filter((p) => base.pages.includes(p)),
    reports: custom.reports, // null = every report of the base role
    uploads: custom.uploads.filter((u) => base.uploads.includes(u)),
    downloads: custom.downloads, payout: custom.payout,
  };
}
/** Attaches role_label and perms to a user row that carries role and role_key. */
export function withRole(row) {
  if (!row) return row;
  const perms = permissionsOf(row);
  return { ...row, role_label: roleLabels()[row.role_key || row.role] || row.role, perms };
}
export const allowsPage = (user, page) => permissionsOf(user).pages.includes(page);
export const allowsReport = (user, key) => { const p = permissionsOf(user); return !p.pages.includes('reports') ? false : p.reports == null || p.reports.includes(key); };
export const allowsUpload = (user, kind) => { const p = permissionsOf(user); return p.pages.includes('uploads') && p.uploads.includes(kind); };
export const allowsDownload = (user) => permissionsOf(user).downloads;
/** The API path a custom role may not call, or null. Built-in roles keep their own checks. */
export function blockedPage(user, pathname) {
  const p = permissionsOf(user);
  if (!p.custom) return null;
  // A sales person's own tab is part of My tab, not the register.
  if (/^\/api\/assets\/(mine|\d+)$/.test(pathname) && p.pages.includes('my_tab')) return null;
  for (const [page, def] of Object.entries(PAGES)) if (def.paths && def.paths.test(pathname) && !p.pages.includes(page)) return page;
  const m = pathname.match(/^\/api\/import\/([a-z_]+)$/);
  if (m && !p.uploads.includes(m[1])) return 'uploads';
  return null;
}

const slug = (label) => String(label).trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 40);
function validate(input, { reportsForBase }, current = null) {
  const label = String(input.label ?? current?.label ?? '').trim().slice(0, 60);
  if (!label) throw new WorkflowError(400, 'Give the role a name');
  const base = String(input.base ?? current?.base ?? '').trim();
  if (!BUILTIN_ROLES[base]) throw new WorkflowError(400, `Base the role on one of: ${BUILTIN_KEYS.map((k) => BUILTIN_ROLES[k].label).join(', ')}`);
  const list = (v, fallback) => (v === undefined ? fallback : Array.isArray(v) ? v.map(String) : String(v).split(',').map((x) => x.trim()).filter(Boolean));
  const pages = list(input.pages, current?.pages ?? BUILTIN_ROLES[base].pages).filter((p) => BUILTIN_ROLES[base].pages.includes(p));
  const available = reportsForBase(base);
  let reports = input.reports === undefined ? (current?.reports ?? null) : input.reports === null || input.reports === 'all' ? null : list(input.reports, []);
  if (reports) reports = reports.filter((k) => available.includes(k));
  const uploads = list(input.uploads, current?.uploads ?? BUILTIN_ROLES[base].uploads).filter((u) => BUILTIN_ROLES[base].uploads.includes(u));
  const bool = (v, fallback) => (v === undefined ? fallback : v === true || v === 1 || v === '1' || v === 'true' || v === 'yes');
  const description = String(input.description ?? current?.description ?? '').trim().slice(0, 300);
  return { label, base, pages, reports, uploads, downloads: bool(input.downloads, current ? current.downloads : true) ? 1 : 0, payout: bool(input.payout, current ? current.payout : true) ? 1 : 0, description };
}

export function createRole(db, user, input, opts) {
  requireRoleManager(user);
  const v = validate(input, opts);
  const key = slug(input.key || v.label);
  if (!key) throw new WorkflowError(400, 'The role name must contain letters or digits');
  if (BUILTIN_ROLES[key] || cache.has(key) || BUILTIN_KEYS.some((k) => BUILTIN_ROLES[k].label.toLowerCase() === v.label.toLowerCase())) throw new WorkflowError(409, `There is already a role called ${v.label}`);
  const ts = new Date().toISOString();
  db.prepare('INSERT INTO roles (key, label, base, pages, reports, uploads, downloads, payout, description, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(key, v.label, v.base, JSON.stringify(v.pages), v.reports == null ? null : JSON.stringify(v.reports), JSON.stringify(v.uploads), v.downloads, v.payout, v.description, user.id, ts, ts);
  loadRoles(db);
  return cache.get(key);
}
export function updateRole(db, user, key, input, opts) {
  requireRoleManager(user);
  const current = cache.get(key);
  if (!current) throw new WorkflowError(404, 'Role not found');
  const v = validate(input, opts, current);
  if (v.base !== current.base && db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_key = ?').get(key).n) throw new WorkflowError(400, 'Move the users off this role before changing what it is based on');
  db.prepare('UPDATE roles SET label = ?, base = ?, pages = ?, reports = ?, uploads = ?, downloads = ?, payout = ?, description = ?, updated_at = ? WHERE key = ?')
    .run(v.label, v.base, JSON.stringify(v.pages), v.reports == null ? null : JSON.stringify(v.reports), JSON.stringify(v.uploads), v.downloads, v.payout, v.description, new Date().toISOString(), key);
  loadRoles(db);
  return cache.get(key);
}
export function deleteRole(db, user, key) {
  requireRoleManager(user);
  if (!cache.has(key)) throw new WorkflowError(404, 'Role not found');
  const n = db.prepare('SELECT COUNT(*) AS n FROM users WHERE role_key = ?').get(key).n;
  if (n) throw new WorkflowError(409, `${n} ${n === 1 ? 'user has' : 'users have'} this role; move them to another role first`);
  db.prepare('DELETE FROM roles WHERE key = ?').run(key);
  loadRoles(db);
  return { ok: true };
}
/** Users per custom role, for the Roles page. */
export const roleUsage = (db) => Object.fromEntries(db.prepare("SELECT role_key, COUNT(*) AS n FROM users WHERE role_key IS NOT NULL AND active = 1 GROUP BY role_key").all().map((r) => [r.role_key, r.n]));
