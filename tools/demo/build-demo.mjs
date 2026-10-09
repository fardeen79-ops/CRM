// Bundles the CRM into one self-contained HTML page: the real UI (public/) and
// workflow logic (src/cases.js) running on sql.js, with fetch('/api/...') served in-browser.
import fs from 'node:fs';
import path from 'node:path';

const [repo, sqljsDist, out] = process.argv.slice(2);
const read = (p) => fs.readFileSync(path.join(repo, p), 'utf8');
const safe = (js) => js.replace(/<\/script/gi, '<\\/script');

const schema = read('src/db.js').match(/const SCHEMA = `([\s\S]*?)`;/)[1];
// Columns added after the first release, so a demo database saved in the browser earlier can be upgraded.
const addedCols = read('src/db.js').match(/const ADDED_COLUMNS = \{([\s\S]*?)\};/)[1];
const addedUserCols = read('src/db.js').match(/const ADDED_USER_COLUMNS = \{([\s\S]*?)\};/)[1];
const strip = (src) => src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const casesSrc = strip(read('src/credit-cards.js')) + strip(read('src/banks.js')) + strip(read('src/users.js')) + strip(read('src/cycles.js')) + strip(read('src/cases.js')) + strip(read('src/payouts.js')) + strip(read('src/performance.js')) + strip(read('src/incentives.js')) + strip(read('src/dashboard.js')) + strip(read('src/pnl.js')) + strip(read('src/leads.js')) + strip(read('src/roles.js')) + strip(read('src/allocations.js')) + strip(read('src/boosters.js')) + strip(read('src/assets.js')) + strip(read('src/imports.js')) + strip(read('src/chat.js')) + strip(read('src/reports.js')) + '\nconst chatUnread = unreadCount;\n';
const css = read('public/styles.css');
// The app's ES-module imports (mrz.js, eid-scan.js) are inlined into one module for the demo.
const stripModule = (src) => src.replace(/^import .*$/gm, '').replace(/^export /gm, '');
const appJs = stripModule(read('public/mrz.js')) + stripModule(read('public/eid-front.js')) + stripModule(read('public/eid-scan.js')) + stripModule(read('public/lead-scan.js')) + stripModule(read('public/speech.js')) + stripModule(read('public/app.js'));
const sqlJs = fs.readFileSync(path.join(sqljsDist, 'sql-wasm.js'), 'utf8');
const wasm = fs.readFileSync(path.join(sqljsDist, 'sql-wasm.wasm')).toString('base64');

// The agency's real staff list and salary bands (docs/go-live), loaded into the demo so the hierarchy,
// Staff page and targets are the real ones. Leaders get placeholder HRMS codes (LEAD001…) and everyone
// the demo password, because the sheet has neither.
const leaderCode = (() => { let n = 0; return () => 'LEAD' + String(++n).padStart(3, '0'); })();
const staffCsv = read('docs/go-live/staff-upload.csv').replace(/\r/g, '').split('\n').map((line, i) => {
  if (!i || !line.trim()) return line;
  const cells = line.split(',');
  if (!cells[1]) cells[1] = leaderCode();
  cells[15] = 'password123';
  return cells.join(',');
}).join('\n');
const GO_LIVE = { staff: Buffer.from(staffCsv).toString('base64'), targets: Buffer.from(read('docs/go-live/salary-targets.csv')).toString('base64') };

const backend = String.raw`
const SCHEMA = ${JSON.stringify(schema)};
const ADDED_COLUMNS = {${addedCols}};
const ADDED_USER_COLUMNS = {${addedUserCols}};
// Brings a database saved by an earlier version of the demo up to date, like the server's migrate().
function migrateDemo(d) {
  const cols = (table) => d.prepare('PRAGMA table_info(' + table + ')').all().map((c) => c.name);
  const caseCols = cols('cases');
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) if (!caseCols.includes(name)) d.exec('ALTER TABLE cases ADD COLUMN ' + name + ' ' + type);
  if (cols('leads').length && !cols('leads').includes('follow_up_time')) d.exec('ALTER TABLE leads ADD COLUMN follow_up_time TEXT');
  const userCols = cols('users');
  for (const [name, type] of Object.entries(ADDED_USER_COLUMNS)) if (!userCols.includes(name)) d.exec('ALTER TABLE users ADD COLUMN ' + name + ' ' + type);
  if (!cols('notifications').includes('link')) d.exec('ALTER TABLE notifications ADD COLUMN link TEXT');
  if (!cols('card_products').includes('min_salary')) d.exec('ALTER TABLE card_products ADD COLUMN min_salary REAL');
  d.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hrms ON users(hrms_code COLLATE NOCASE)');
  d.exec('UPDATE cases SET team_leader_id = (SELECT team_leader_id FROM users WHERE id = cases.sales_staff_id), sales_manager_id = (SELECT sales_manager_id FROM users WHERE id = cases.sales_staff_id), asm_id = (SELECT asm_id FROM users WHERE id = cases.sales_staff_id) WHERE team_leader_id IS NULL AND sales_staff_id IS NOT NULL');
}
const DB_KEY = 'sourcing-crm-demo-db-v60';
const STAFF_CSV = atob('${GO_LIVE.staff}');
const TARGET_RULES_CSV = atob('${GO_LIVE.targets}');
const SESSION_KEY = 'sourcing-crm-demo-user';
const DEMO_PASSWORD = 'password123';

function savepoint(db, fn) {
  db.exec('SAVEPOINT row');
  try { const r = fn(); db.exec('RELEASE row'); return r; } catch (e) { db.exec('ROLLBACK TO row'); db.exec('RELEASE row'); throw e; }
}
const ROLES = ['sales', 'processing', 'team_leader', 'asm', 'sales_manager', 'mis', 'business_head', 'governance', 'it'];
function tempPassword() {
  const chars = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from(crypto.getRandomValues(new Uint8Array(10)), (b) => chars[b % chars.length]).join('');
}

function transaction(db, fn) {
  db.exec('BEGIN');
  try { const r = fn(); db.exec('COMMIT'); return r; } catch (e) { db.exec('ROLLBACK'); throw e; }
}

// Minimal node:sqlite-style adapter over sql.js so src/cases.js runs unchanged.
const normParams = (p) => p.map((v) => (v === undefined ? null : typeof v === 'boolean' ? +v : v));
class Db {
  constructor(raw) { this.raw = raw; raw.exec('PRAGMA foreign_keys = ON'); }
  exec(sql) { this.raw.exec(sql); }
  prepare(sql) {
    const raw = this.raw;
    return {
      get: (...p) => { const s = raw.prepare(sql); try { s.bind(normParams(p)); return s.step() ? s.getAsObject() : undefined; } finally { s.free(); } },
      all: (...p) => { const s = raw.prepare(sql); const rows = []; try { s.bind(normParams(p)); while (s.step()) rows.push(s.getAsObject()); } finally { s.free(); } return rows; },
      run: (...p) => { raw.run(sql, normParams(p)); return { changes: raw.getRowsModified(), lastInsertRowid: raw.exec('SELECT last_insert_rowid()')[0].values[0][0] }; },
    };
  }
}

${casesSrc}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage blocked: keep in memory */ } },
  del(k) { try { localStorage.removeItem(k); } catch {} },
};
let memSession = null;
const getSession = () => Number(store.get(SESSION_KEY) || memSession) || null;
const setSession = (id) => { memSession = id; id ? store.set(SESSION_KEY, String(id)) : store.del(SESSION_KEY); };

function toB64(u8) { let s = ''; for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000)); return btoa(s); }
function fromB64(b) { const s = atob(b); const u = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i); return u; }

let SQL, db;
function persist() { try { store.set(DB_KEY, toB64(db.raw.export())); db.raw.exec('PRAGMA foreign_keys = ON'); } catch {} }

function createUser(d, input, { requireMobile = false } = {}) {
  const { role, password } = input;
  let contact;
  try { contact = contactDetails(input, { requireMobile }); } catch (e) { throw new WorkflowError(400, e.message); }
  const resolvedRole = resolveRole(role);
  if (!password || String(password).length < 8) throw new WorkflowError(400, 'Password must be at least 8 characters');
  if (d.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE').get(contact.email)) throw new WorkflowError(409, 'A user with the email ' + contact.email + ' already exists');
  if (contact.hrms_code && d.prepare('SELECT 1 FROM users WHERE hrms_code = ? COLLATE NOCASE').get(contact.hrms_code)) throw new WorkflowError(409, 'HRMS code ' + contact.hrms_code + ' is already used by another user');
  let profile = { sales_code: null, team_leader_id: null, sales_manager_id: null, asm_id: null, salary: null, core_product: null };
  let region = null;
  try {
    if (resolvedRole.base === 'sales') profile = salesProfile(d, input);
    region = regionOf(input.region);
  } catch (e) { throw new WorkflowError(400, e.message); }
  const { lastInsertRowid } = d.prepare('INSERT INTO users (name, email, role, role_key, password_hash, mobile_number, whatsapp_number, sales_code, team_leader_id, sales_manager_id, asm_id, region, salary, hrms_code, doj, dol, core_product) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(contact.name, contact.email, resolvedRole.base, resolvedRole.key, 'demo:' + password, contact.mobile_number, contact.whatsapp_number, profile.sales_code, profile.team_leader_id, profile.sales_manager_id, profile.asm_id, region, profile.salary, contact.hrms_code, contact.doj, contact.dol, profile.core_product);
  return publicUser(Number(lastInsertRowid));
}
const publicUser = (id) => findUser(db, id);

const ago = (mins) => new Date(Date.now() - mins * 60000).toISOString();
function backdate(id, mins) {
  // Spread the sample history out so timelines and "waiting" times look realistic.
  const events = db.prepare('SELECT id FROM case_events WHERE case_id = ? ORDER BY id').all(id);
  events.forEach((e, i) => db.prepare('UPDATE case_events SET created_at = ? WHERE id = ?').run(ago(mins - i * Math.floor(mins / (events.length + 1))), e.id));
  const last = ago(mins - (events.length - 1) * Math.floor(mins / (events.length + 1)));
  db.prepare('UPDATE cases SET created_at = ?, updated_at = ? WHERE id = ?').run(ago(mins), last, id);
  db.prepare('UPDATE cases SET incomplete_at = ? WHERE id = ? AND incomplete_at IS NOT NULL').run(last, id);
  db.prepare('UPDATE cases SET verified_at = ? WHERE id = ? AND verified_at IS NOT NULL').run(last, id);
  db.prepare('UPDATE cases SET case_status_at = ? WHERE id = ? AND case_status_at IS NOT NULL').run(last, id);
  for (const col of ['urgent_at', 'qc_at', 'recording_requested_at', 'recording_decided_at', 'recording_it_email_at', 'recording_provided_at', 'complaint_at', 'qc_scored_at']) {
    db.prepare('UPDATE cases SET ' + col + ' = ? WHERE id = ? AND ' + col + ' IS NOT NULL').run(last, id);
  }
  db.prepare('UPDATE cases SET edit_request_at = ? WHERE id = ? AND edit_request_at IS NOT NULL').run(last, id);
  // Sourcing date is the local (UAE) day the file was created.
  db.prepare('UPDATE cases SET sourcing_date = ? WHERE id = ?').run(new Date(Date.parse(ago(mins)) + 4 * 3600e3).toISOString().slice(0, 10), id);
}

function seed() {
  let phone = 1110000;
  const u = (name, email, role, profile = {}) => {
    const mobile = '05' + ['0', '5', '2', '6'][phone % 4] + String(++phone).padStart(7, '0');
    return createUser(db, { name, email, role, password: DEMO_PASSWORD, hrms_code: 'EN' + String(10000 + phone - 1110000), doj: new Date(Date.now() - (120 + (phone % 7) * 200) * 864e5).toISOString().slice(0, 10), mobile_number: mobile, whatsapp_number: phone % 3 ? '+971' + mobile.slice(1) : '', ...profile });
  };
  const tara = u('Tara Leader', 'leader@demo.local', 'team_leader');
  const sana = u('Sana Manager', 'manager@demo.local', 'sales_manager');
  const team = { team_leader_id: tara.id, sales_manager_id: sana.id };
  const adil = u('Adil Assistant', 'asm@demo.local', 'asm');
  // A core personal loan team under Sana: Leena leads Dev and Anita.
  const leena = u('Leena Loans', 'leader2@demo.local', 'team_leader', { region: 'DXB' });
  const loanTeam = { team_leader_id: leena.id, sales_manager_id: sana.id };
  const dev = u('Dev Sales', 'sales4@demo.local', 'sales', { sales_code: 'DXB-S-031', region: 'DXB', salary: 5500, core_product: 'personal_loan', ...loanTeam });
  const anita = u('Anita Sales', 'sales5@demo.local', 'sales', { sales_code: 'DXB-S-032', region: 'DXB', salary: 5000, core_product: 'personal_loan', ...loanTeam });
  const sam = u('Sam Sales', 'sales@demo.local', 'sales', { sales_code: 'DXB-S-014', region: 'DXB', asm_id: adil.id, salary: 6500, core_product: 'credit_card', ...team });
  const riya = u('Riya Sales', 'sales2@demo.local', 'sales', { sales_code: 'AUH-S-007', region: 'AUH', salary: 5000, core_product: 'credit_card', ...team });
  const noor = u('Noor Sales', 'sales3@demo.local', 'sales', { sales_code: 'DXB-S-021', region: 'DXB', asm_id: adil.id, salary: 4500, core_product: 'auto_loan', ...team });
  // A team member with nothing this cycle, so the leaders' zero tiles have someone to show.
  u('Zayd Sales', 'sales6@demo.local', 'sales', { sales_code: 'DXB-S-022', region: 'DXB', salary: 4500, core_product: 'credit_card', ...team });
  const pat = u('Pat Processing', 'processing@demo.local', 'processing', { region: 'DXB' });
  const vera = u('Vera Verification', 'vlead@demo.local', 'processing_lead', { region: 'DXB' });
  const omar = u('Omar Processing', 'processing2@demo.local', 'processing', { region: 'AUH' });
  const mira = u('Mira MIS', 'mis@demo.local', 'mis', { region: 'DXB' });
  const bilal = u('Bilal Head', 'head@demo.local', 'business_head', { region: 'DXB' });
  const gina = u('Gina Governance', 'governance@demo.local', 'governance');
  const irfan = u('Irfan IT', 'it@demo.local', 'it');
  // Every card has a sourced type and every personal loan an FPD; sample files get a spread of them.
  // Sample files are entered on a weekday morning, whatever the real clock says; live entries use the real clock.
  const liveClock = timing.now;
  timing.now = () => Date.parse('2026-10-05T06:00:00Z');
  let nth = 0;
  const mk = (who, data) => {
    const products = data.product === 'bundle' ? data.bundle_products : [data.product];
    const extra = {};
    if (products.includes('credit_card') && !data.card_fee_type) extra.card_fee_type = ['fyf', 'full_fee', 'ffl'][nth++ % 3];
    if (products.includes('personal_loan') && !data.fpd) extra.fpd = new Date(Date.now() + (28 + (nth % 4) * 7) * 864e5).toISOString().slice(0, 10);
    if (!data.salary_bank) extra.salary_bank = ['Emirates NBD', 'First Abu Dhabi Bank (FAB)', 'Mashreq', 'Abu Dhabi Commercial Bank (ADCB)'][nth % 4];
    if (products.includes('personal_loan') && !data.pl_tenure) extra.pl_tenure = [48, 36, 24][nth % 3];
    if (products.includes('personal_loan') && !data.secondary_buyout && ['fresh', 'buy_out', 'top_up'].includes(data.personal_loan_type)) extra.secondary_buyout = 'no';
    if (products.includes('auto_loan')) {
      const cars = [['Toyota', 'Land Cruiser', 2026, 'Al-Futtaim Motors, Festival City', 'Dealer referral'], ['Nissan', 'Patrol', 2024, 'Arabian Automobiles, Deira', 'Walk-in'], ['Hyundai', 'Tucson', 2025, 'Juma Al Majid, Sheikh Zayed Road', 'Web enquiry']];
      const [make, model, year, dealer, lead] = cars[nth % 3];
      Object.assign(extra, { auto_loan_type: data.auto_loan_type || (year >= 2025 ? 'new' : 'used'), car_make: make, car_model: model, car_year: year, dealer_details: dealer, al_lead_source: lead, al_interest_rate: [3.25, 3.99, 4.5][nth % 3], al_tenure: [60, 48, 36][nth % 3] });
      if (!data.amount) extra.amount = '135000';
    }
    return createCase(db, who, { ...data, ...extra }).id;
  };
  const act = (who, id, body) => applyAction(db, who, id, body);

  // Sample customers (fictional names, IDs and numbers).
  const a = mk(sam, { region: 'DXB', core_product: 'personal_loan', first_name: 'Arjun', last_name: 'Mehta', phone: '+971 50 765 4321', eid_number: '784-1988-4821736-2', passport_number: 'Z4821736', company_name: 'Al Futtaim Motors', salary: '28000', bidaya_id: 'BID-10231', app_id: 'APP-55012', email: 'arjun.mehta@example.com', city: 'Dubai', address: 'Al Barsha 1, Building 14', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '250000', interest_rate: '6.25', source: 'Walk-in', sales_notes: 'Prefers calls after 6pm.' });
  act(pat, a, { action: 'log_call', outcome: 'connected', note: 'Confirmed employer, salary and loan amount.' });
  act(pat, a, { action: 'complete', note: 'All details verified.' });
  act(tara, a, { action: 'set_case_status', case_status: 'completed', note: 'Disbursal approved.' });
  act(gina, a, { action: 'set_complaint', complaint_number: 'CMP-2026-0418' });
  act(gina, a, { action: 'request_recording', note: 'Customer complaint says the interest rate was not explained on the call.' });
  act(bilal, a, { action: 'approve_recording', note: 'Approved for complaint review.' });
  act(gina, a, { action: 'receive_recording', recording_ref: 'https://recordings.example/calls/CRM-000001.wav' });
  act(gina, a, { action: 'score_quality', score: '7.5', note: 'Rate disclosed but not the processing fee. Identity checks complete.' });
  backdate(a, 60 * 30);

  const b = mk(riya, { region: 'AUH', core_product: 'auto_loan', first_name: 'John', last_name: 'Fernandes', phone: '+971 55 988 7665', eid_number: '784-1985-7710243-9', company_name: 'Emaar Hospitality', salary: '19500', app_id: 'APP-55087', city: 'Abu Dhabi', product: 'auto_loan', source: 'Field visit' });
  act(omar, b, { action: 'log_call', outcome: 'no_answer' });
  act(omar, b, { action: 'log_call', outcome: 'switched_off' });
  act(omar, b, { action: 'mark_incomplete', reason: 'customer_unreachable', note: 'Tried 3 times over two days. Phone switched off.' });
  backdate(b, 60 * 26);

  const c = mk(sam, { region: 'DXB', core_product: 'multi_product', first_name: 'Neha', last_name: 'Kapoor', phone: '+971 52 123 4567', eid_number: '784-1992-3301874-5', passport_number: 'M7741290', company_name: 'Dubai Healthcare City Authority', salary: '32000', bidaya_id: 'BID-10257', city: 'Dubai', product: 'bundle', bundle_products: ['credit_card', 'accounts'], credit_card: 'Skywards Signature Credit Card', source: 'Referral', sales_notes: 'Referred by Arjun Mehta.' });
  act(pat, c, { action: 'log_call', outcome: 'connected', note: 'Customer says the Emirates ID on file is wrong.' });
  act(pat, c, { action: 'mark_incomplete', reason: 'incorrect_details', note: 'Emirates ID does not match. Need the correct number from the customer.' });
  act(tara, c, { action: 'return_to_sales', note: 'Please collect the correct Emirates ID from Neha and resubmit.' });
  backdate(c, 60 * 20);

  const d = mk(riya, { region: 'AUH', core_product: 'multi_product', first_name: 'Priya', middle_name: 'Lakshmi', last_name: 'Nair', phone: '+971 50 001 1122', eid_number: '784-1990-6620418-1', passport_number: 'T3390152', company_name: 'ADNOC Distribution', salary: '24000', bidaya_id: 'BID-10262', app_id: 'APP-55110', city: 'Sharjah', product: 'bundle', bundle_products: ['personal_loan', 'credit_card', 'accounts'], credit_card: 'Etihad Guest Visa Inspire', personal_loan_type: 'buy_out', loan_amount: '150000', interest_rate: '5.99', source: 'Cold call', secondary_buyout: 'yes', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Mashreq', amount: 142500 }, { role: 'secondary', kind: 'credit_card', bank: 'FAB', amount: 25000 }, { role: 'secondary', kind: 'credit_card', bank: 'Emirates NBD', amount: 15000 }] });
  act(omar, d, { action: 'claim' });
  act(omar, d, { action: 'log_call', outcome: 'call_back_later', callback_at: new Date(Date.now() + 3600e3).toISOString(), note: 'In a meeting; asked for a call in an hour.' });
  act(mira, d, { action: 'set_case_status', case_status: 'applicant_review', note: 'Mashreq liability letter is missing.' });
  act(riya, d, { action: 'request_edit', to: 'sales_manager', note: 'Customer gave a new liability letter: outstanding is AED 142,500, so loan amount should be 142500.' });
  backdate(d, 60 * 5);

  const e = mk(sam, { region: 'DXB', core_product: 'auto_loan', first_name: 'Vikram', last_name: 'Singh', phone: '+971 56 811 2233', company_name: 'Etisalat', salary: '21000', city: 'Ajman', product: 'auto_loan', source: 'Dealer referral' });
  act(pat, e, { action: 'log_call', outcome: 'call_back_later', callback_at: new Date(Date.now() + 3 * 3600e3).toISOString(), note: 'Driving; call back this afternoon.' });
  backdate(e, 90);
  // Priya's call-back time has already passed, so Omar gets the alert as soon as the demo opens.
  db.prepare('UPDATE cases SET callback_at = ? WHERE id = ?').run(new Date(Date.now() - 25 * 60000).toISOString(), d);
  const f = mk(riya, { region: 'AUH', core_product: 'credit_card', first_name: 'Fatima', last_name: 'Sheikh', phone: '+971 54 700 3344', eid_number: '784-1995-2209176-4', company_name: 'Emirates Airline', salary: '36000', bidaya_id: 'BID-10274', email: 'fatima.s@example.com', city: 'Dubai', product: 'credit_card', credit_card: 'Marriott Bonvoy World Elite Mastercard', source: 'Website enquiry' });
  backdate(f, 40);
  // A customer on the Do Not Call Register: the file waits for the customer's permission, with the email drafted.
  const dncr = mk(sam, { region: 'DXB', core_product: 'credit_card', first_name: 'Hind', last_name: 'Saeed', email: 'hind.saeed@example.com', phone: '+971 50 212 9087', company_name: 'Emirates Airline', salary: '21000', app_id: 'APP-55142', city: 'Dubai', product: 'credit_card', credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', source: 'Referral' });
  act(pat, dncr, { action: 'claim' });
  act(pat, dncr, { action: 'mark_incomplete', reason: 'customer_in_dncr', note: 'Number is on the Do Not Call Register; cannot be phoned until the customer agrees.' });
  backdate(dncr, 60 * 5);
  // A card sold below its salary requirement as a promotion, and one still awaiting the team's approval.
  const promoCard = mk(sam, { region: 'DXB', core_product: 'credit_card', first_name: 'Yasmin', last_name: 'Rashid', phone: '+971 50 310 9988', company_name: 'Dubai Holding', salary: '9000', salary_bank: 'Mashreq', city: 'Dubai', product: 'credit_card', credit_card: 'Skywards Infinite Credit Card', card_fee_type: 'fyf', card_salary_exception: 'promotion', card_exception_note: 'Oct Skywards campaign', source: 'Referral' });
  backdate(promoCard, 60 * 7);
  const waitCard = mk(riya, { region: 'AUH', core_product: 'credit_card', first_name: 'Bilal', last_name: 'Karim', phone: '+971 50 320 1122', company_name: 'Etihad Rail', salary: '7000', salary_bank: 'First Abu Dhabi Bank (FAB)', city: 'Abu Dhabi', product: 'credit_card', credit_card: 'Share Visa Signature Credit Card', card_fee_type: 'full_fee', source: 'Walk-in' });
  backdate(waitCard, 60 * 3);
  const g = mk(sam, { region: 'DXB', core_product: 'personal_loan', first_name: 'Rahul', last_name: 'Verma', phone: '+971 50 333 4455', eid_number: '784-1987-5512903-7', passport_number: 'K9902231', company_name: 'Damac Properties', salary: '18000', app_id: 'APP-55131', city: 'Dubai', product: 'personal_loan', personal_loan_type: 'top_up', loan_amount: '120000', interest_rate: '6.49', full_loan_amount: '120000', incremental_amount: '40000', source: 'Walk-in' });
  act(pat, g, { action: 'log_call', outcome: 'connected', note: 'Customer has not received salary slips yet.' });
  act(pat, g, { action: 'mark_incomplete', reason: 'documents_pending', note: 'Salary slips for the last 3 months are missing.' });
  act(sana, g, { action: 'set_case_status', case_status: 'applicant_review', note: 'Waiting for 3 months of salary slips from the customer.' });
  act(gina, g, { action: 'mark_qc', note: 'Monthly random sample.' });
  act(gina, g, { action: 'flag_urgent', note: 'Customer has raised a complaint; verification must be finished before the recording can be pulled.' });
  backdate(g, 75);
  // Completed cases spread over this cycle and the last, with card activation mapped by MIS.
  const cycleNow = cycleOf(uaeDay());
  const cycleStartMs = Date.parse(cycleRange(cycleNow).start + 'T08:00:00Z');
  const minsSince = (ms) => Math.max(5, Math.round((Date.now() - ms) / 60000));
  const done = [
    [sam, 'Hessa', 'Al Marri', 'credit_card', 'Infinite Credit Card', 'active', 0.2],
    [sam, 'Karim', 'Saleh', 'credit_card', 'Etihad Guest Visa Elevate', 'active', 0.35],
    [sam, 'Laila', 'Haddad', 'credit_card', 'Darna Visa Signature Credit Card', 'inactive', 0.5],
    [sam, 'Yousef', 'Khalil', 'personal_loan', null, null, 0.6],
    [sam, 'Meera', 'Pillai', 'credit_card', 'LuLu Titanium Mastercard', null, 0.8],
    [riya, 'Omar', 'Farouk', 'credit_card', 'Mastercard Platinum', 'active', 0.3],
    [riya, 'Sara', 'Nouri', 'auto_loan', null, null, 0.45],
    [riya, 'Tariq', 'Aziz', 'credit_card', 'Titanium Credit Card', null, 0.7],
    [riya, 'Nadia', 'Rahman', 'personal_loan', null, null, 0.9],
    // The loan team: Dev clears the AED 750K band with a card cross-sold; Anita sits below AED 600K.
    [dev, 'Khalid', 'Nasser', 'personal_loan', null, null, 0.15, { loan_amount: '320000', interest_rate: '5.99' }],
    [dev, 'Fatima', 'Rashed', 'personal_loan', null, null, 0.4, { loan_amount: '280000', interest_rate: '6.25' }],
    [dev, 'Salem', 'Obaid', 'bundle', 'Titanium Credit Card', 'active', 0.7, { core_product: 'personal_loan', bundle_products: ['personal_loan', 'credit_card'], credit_card: 'Titanium Credit Card', loan_amount: '210000', interest_rate: '6.49', personal_loan_type: 'fresh' }],
    [anita, 'Mona', 'Hilal', 'personal_loan', null, null, 0.3, { loan_amount: '190000', interest_rate: '6.75' }],
    [anita, 'Rashid', 'Tamimi', 'personal_loan', null, null, 0.75, { loan_amount: '260000', interest_rate: '6.25', personal_loan_type: 'buy_out', buyout_bank: 'Emirates Islamic', pl_buyouts: [{ role: 'primary', kind: 'personal_loan', bank: 'Emirates Islamic', amount: 250000 }] }],
    // Noor's auto loans: the bank's worked example (200,000 new + 300,000 used + 100,000 algo = 4,250 points).
    [noor, 'Hassan', 'Mansoor', 'auto_loan', null, null, 0.25, { amount: '200000', auto_loan_type: 'new' }],
    [noor, 'Reem', 'Darwish', 'auto_loan', null, null, 0.55, { amount: '300000', auto_loan_type: 'used' }],
    [noor, 'Samir', 'Haddad', 'auto_loan', null, null, 0.85, { amount: '100000', auto_loan_type: 'used', al_payout_class: 'algo' }],
    // A card cross-sold by the auto loan team, on a used-car loan: shows on the leaders' cross-sell tiles.
    [noor, 'Huda', 'Salem', 'bundle', 'Titanium Credit Card', 'active', 0.65, { core_product: 'auto_loan', bundle_products: ['auto_loan', 'credit_card'], credit_card: 'Titanium Credit Card', amount: '150000', auto_loan_type: 'used' }],
    // Last cycle
    [sam, 'Ali', 'Hamdan', 'credit_card', 'Infinite Credit Card', 'active', -0.4],
    [riya, 'Zainab', 'Qasim', 'credit_card', 'Darna Select Visa Credit Card', 'inactive', -0.6],
    // Older inactive cards: one ageing (about 70 days) and one past the 90-day activation window.
    [sam, 'Rania', 'Aboud', 'credit_card', 'Titanium Credit Card', 'inactive', -2.2],
    [riya, 'Faisal', 'Karam', 'credit_card', 'Infinite Credit Card', 'inactive', -3.4],
  ];
  const nowMs = Date.now();
  let n = 0;
  for (const [who, first, last, product, card, cardStatus, at, more = {}] of done) {
    // A point in this cycle (0–1 of the time so far) or, if negative, in the previous one.
    const ms = at >= 0 ? cycleStartMs + (nowMs - cycleStartMs) * at : cycleStartMs + 30 * 864e5 * at;
    const id = mk(who, {
      region: who === riya ? 'AUH' : 'DXB', core_product: product, first_name: first, last_name: last,
      phone: '+971 50 4' + String(10 + n++).padStart(2, '0') + ' 2' + String(100 + n).slice(-3), app_id: 'APP-6' + String(1000 + n),
      product, ...(product === 'credit_card' && { credit_card: card }), ...(product === 'personal_loan' && { personal_loan_type: 'fresh', loan_amount: String(90000 + n * 15000), interest_rate: '6.75' }),
      ...(product === 'auto_loan' && { amount: '135000' }), ...more,
      salary: '32000', city: who === riya ? 'Abu Dhabi' : 'Dubai', source: 'Walk-in',
    });
    act(who === riya ? omar : pat, id, { action: 'log_call', outcome: 'connected', note: 'Details confirmed.' });
    act(who === riya ? omar : pat, id, { action: 'complete' });
    act(mira, id, { action: 'set_case_status', case_status: 'completed' });
    // A realistic timeline around the chosen completion point: sourced two days before, the call
    // and the verification the day after that, the case completed at the point, the card mapped a
    // day later. An inactive card counts from the day the case completed (temp end).
    const t = (days) => new Date(Math.min(ms + days * 864e5, nowMs)).toISOString();
    const day = (iso) => new Date(Date.parse(iso) + 4 * 3600e3).toISOString().slice(0, 10);
    const [createdAt, callAt, verifiedAt, doneAt, mappedAt] = [t(-2), t(-1.5), t(-1), t(0), t(1)];
    if (cardStatus) act(mira, id, { action: 'set_card_status', card_status: cardStatus, activation_date: cardStatus === 'active' ? day(t(3)) : day(doneAt) });
    db.prepare('UPDATE cases SET created_at = ?, sourcing_date = ?, verified_at = ?, case_status_at = ?, updated_at = ?, card_status_at = CASE WHEN card_status IS NULL THEN NULL ELSE ? END WHERE id = ?')
      .run(createdAt, day(createdAt), verifiedAt, doneAt, mappedAt, mappedAt, id);
    for (const [type, at] of [['created', createdAt], ['log_call', callAt], ['complete', verifiedAt], ['case_status', doneAt], ['card_status', mappedAt]]) {
      db.prepare('UPDATE case_events SET created_at = ? WHERE case_id = ? AND type = ?').run(at, id, type);
    }
  }
  // Targets for this cycle and the last.
  for (const cyc of [cycleNow, shiftCycle(cycleNow, -1)]) {
    setTargetsFor(db, mira, sam.id, cyc, { credit_card: 6, personal_loan: 600000, auto_loan: 1200, accounts: 2 });
    setTargetsFor(db, mira, riya.id, cyc, { credit_card: 5, personal_loan: 400000, auto_loan: 2400, accounts: 1 });
    setTargetsFor(db, mira, dev.id, cyc, { personal_loan: 700000 });
    setTargetsFor(db, mira, anita.id, cyc, { personal_loan: 600000 });
  }

  // The real staff list and salary bands, then targets generated for this cycle and the last.
  const loaded = importUsers(db, mira, STAFF_CSV);
  if (loaded.failed) console.warn('staff rows that did not load:', loaded.rows.filter((r) => !r.ok).slice(0, 5));
  const bands = importTargetRules(db, mira, TARGET_RULES_CSV);
  if (bands.failed) console.warn('salary bands that did not load:', bands.rows.filter((r) => !r.ok).slice(0, 5));
  for (const cyc of [cycleNow, shiftCycle(cycleNow, -1)]) generateTargets(db, mira, cyc);
  // The tab register: tabs issued to the demo sales staff, one spare with IT, one handed back by a leaver.
  const tab = (n, serial, extra = {}) => createAsset(db, irfan, { tab_no: 'TAB-' + n, serial_no: serial, charger: 1, stylus: n % 2 === 0 ? 1 : 0, card_reader: 1, network: n % 2 ? 'etisalat' : 'du', sim_number: '8997101' + String(2000000 + n * 7), entra_id: extra.entra, mobile_number: extra.mobile, holder_id: extra.holder });
  tab(101, 'SM-T510-004417', { holder: sam.id, entra: 'sam.sales@derbygroup.ae', mobile: '050 411 2201' });
  tab(102, 'SM-T510-004418', { holder: riya.id, entra: 'riya.sales@derbygroup.ae', mobile: '050 411 2202' });
  tab(103, 'SM-T510-004419', { holder: noor.id, entra: 'noor.sales@derbygroup.ae', mobile: '050 411 2203' });
  // Two boosters: a Dubai Premium card push running now, and a loan drive starting next week.
  const dayPlus = (n) => new Date(Date.now() + 4 * 3600e3 + n * 864e5).toISOString().slice(0, 10);
  createBooster(db, bilal, { title: 'Premium card push', product: 'credit_card', reward: 'AED 150 extra per Premium or Super Premium card', details: 'Paid with the cycle incentive on cards completed in the window. Cards sold below eligibility do not count.', starts_on: dayPlus(-4), ends_on: dayPlus(6), region: 'DXB', audience: 'core' });
  createBooster(db, mira, { title: 'Loan drive', product: 'personal_loan', reward: '0.10% extra on every loan disbursed in the window', starts_on: dayPlus(5), ends_on: dayPlus(19), audience: 'all' });
  // Tara's team is verified by Pat; Vera, the verification team leader, set it.
  setAllocation(db, vera, tara.id, { product: 'all', processor_id: pat.id });
  tab(104, 'SM-T510-004420', {});
  const fajan = db.prepare("SELECT id FROM users WHERE hrms_code = '7337'").get();
  const left = tab(105, 'SM-T510-004421', fajan ? { holder: fajan.id, entra: 'fajan@derbygroup.ae', mobile: '050 411 2205' } : {});
  if (fajan) setAssetStatus(db, irfan, left.id, { status: 'handed_over', note: 'Returned at exit clearance' });
  // Sam's leads: prospects he is working on before there is a file.
  for (const [first, last, phone, company, salary, product, source, follow, time, notes] of [['Khalid', 'Mansoor', '+971 50 212 3344', 'Emaar', 14000, 'credit_card', 'Referral', 1, '10:30', 'Wants a travel card with lounge access'], ['Lina', 'Saeed', '+971 55 787 1122', 'DEWA', 9500, 'personal_loan', 'Field visit', 1, '16:00', 'Buy-out of a RAKBANK loan, asks for the rate'], ['Yusuf', 'Rahimi', '+971 52 300 9988', 'Jumeirah Group', 7000, 'auto_loan', 'Walk-in', 0, '11:00', 'Looking at a used Patrol']]) createLead(db, sam, { first_name: first, last_name: last, phone, company_name: company, salary, product, source, follow_up_at: new Date(Date.now() + (4 + follow * 24) * 3600e3).toISOString().slice(0, 10), follow_up_time: time, notes });
  setLeadStatus(db, sam, createLead(db, sam, { first_name: 'Ravi', last_name: 'Menon', phone: '+971 50 101 2020', company_name: 'Etisalat', salary: 6000, product: 'credit_card' }).id, { status: 'not_interested', note: 'Happy with his current bank' });
  // Noor's threshold is the bank's worked example (2,000 points), not her salary band.
  for (const cyc of [cycleNow, shiftCycle(cycleNow, -1)]) setTargetsFor(db, mira, noor.id, cyc, { auto_loan: 2000 });

  // A few messages so the chat has something to show.
  syncGroups(db);
  postCaseMessage(db, pat, g, 'Called twice, salary slips still not in. @Sam can you chase the customer?');
  postCaseMessage(db, sam, g, 'On it. He said he will email them by Thursday.');
  const dmSamPat = openDirect(db, sam, pat.id);
  postMessage(db, sam, dmSamPat.id, 'Hi Pat, Rahul Verma (CRM-000007) asked for a call after 6pm today.');
  postMessage(db, pat, dmSamPat.id, 'Noted, I will call him at 6:15.');
  const teamTara = db.prepare("SELECT id FROM conversations WHERE group_key = ?").get('team:' + tara.id);
  postMessage(db, tara, teamTara.id, 'Team: October targets are on the Targets page. Cards first this cycle, please.');
  const proc = db.prepare("SELECT id FROM conversations WHERE group_key = 'processing'").get();
  postMessage(db, omar, proc.id, 'Queue is clear up to CRM-000005; call-backs due this afternoon are on the Call-backs page.');

  // Clear seed-time notifications so the demo starts with only the ones that still matter.
  db.prepare('UPDATE notifications SET is_read = 1 WHERE case_id = ? OR (case_id = ? AND user_id = ?)').run(a, c, tara.id);
  // One file sourced on a Sunday, waiting for Tara's or Sana's approval.
  const sundayMs = Date.now() - ((new Date(Date.now() + 4 * 3600e3).getUTCDay() || 7) * 864e5);
  timing.now = () => Date.parse('2026-10-04T07:00:00Z');
  mk(sam, { region: 'DXB', core_product: 'personal_loan', first_name: 'Maryam', last_name: 'Al Suwaidi', phone: '+971 50 606 7788', company_name: 'Etisalat', salary: '21000', app_id: 'APP-55140', city: 'Dubai', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '95000', interest_rate: '6.49', source: 'Referral', sourcing_date: new Date(sundayMs + 4 * 3600e3).toISOString().slice(0, 10) });
  timing.now = liveClock;
}

function openDemoDb(fresh = false) {
  const saved = !fresh && store.get(DB_KEY);
  if (saved) {
    try { db = new Db(new SQL.Database(fromB64(saved))); db.exec(SCHEMA); migrateDemo(db); loadCardProducts(db); loadPayoutRules(db); backfillCardCategories(db); persist(); return; } catch { /* corrupt: reseed */ }
  }
  db = new Db(new SQL.Database());
  db.exec(SCHEMA);
  loadCardProducts(db); loadPayoutRules(db); loadRoles(db);
  seed();
  persist();
}

class ApiError extends Error { constructor(status, msg) { super(msg); this.status = status; } }
const role = (user, ...roles) => { if (!roles.includes(user.role)) throw new ApiError(403, 'You do not have permission to do that'); };

function currentUser() {
  const id = getSession();
  const row = id ? db.prepare('SELECT id, name, email, role, role_key, active, region FROM users WHERE id = ? AND active = 1').get(id) || null : null;
  return row ? withRole(row) : null;
}

function handle(method, pathname, query, body) {
  let m;
  if (method === 'POST' && pathname === '/api/login') {
    const who = String(body.email || '').trim();
    const row = db.prepare('SELECT * FROM users WHERE email = ? COLLATE NOCASE OR (hrms_code IS NOT NULL AND hrms_code = ? COLLATE NOCASE)').get(who, who);
    if (!row) throw new ApiError(401, "There's no account for that HRMS code or email yet. Pick a demo account below, or sign in as Mira (MIS) and add yourself on the Staff page.");
    if (!row.active) throw new ApiError(401, 'This account has been disabled by a team leader.');
    if (row.password_hash !== 'demo:' + String(body.password || '')) throw new ApiError(401, 'Wrong password. The demo accounts all use password123.');
    setSession(row.id);
    return { user: publicUser(row.id) };
  }
  const user = currentUser();
  if (!user) throw new ApiError(401, 'Please sign in');
  if (method === 'POST' && pathname === '/api/logout') { setSession(null); return { ok: true }; }
  if (user.role === 'it' && !/^\/api\/(me|logout|password|assets|users|reports|notifications|roles|import\/assets)(\/|$)/.test(pathname)) throw new ApiError(403, 'IT accounts manage assets only');
  { const blocked = blockedPage(user, pathname); if (blocked) throw new ApiError(403, 'Your role does not include ' + PAGES[blocked].label); if (query.get('format') === 'csv' && !allowsDownload(user)) throw new ApiError(403, 'Your role cannot download files'); }
  if (pathname === '/api/boosters' && method === 'GET') return { boosters: listBoosters(db, user) };
  if (pathname === '/api/boosters' && method === 'POST') { const b = createBooster(db, user, body); persist(); return [201, { booster: b }]; }
  { const m = pathname.match(/^\/api\/boosters\/(\d+)$/); if (m && method === 'PUT') { const b = updateBooster(db, user, m[1], body); persist(); return { booster: b }; } if (m && method === 'DELETE') { const r = deleteBooster(db, user, m[1]); persist(); return r; } }
  if (pathname === '/api/allocations' && method === 'GET') return listAllocations(db, user);
  { const m = pathname.match(/^\/api\/allocations\/(\d+)$/); if (m && method === 'PUT') { const r = setAllocation(db, user, m[1], { product: body.product, processor_id: body.processor_id }); persist(); return { allocation: r }; } }
  if (pathname === '/api/roles' && method === 'GET') { requireRoleManager(user); return { builtin: Object.entries(BUILTIN_ROLES).map(([key, r]) => ({ key, ...r, reports: reportKeysForBase(key) })), custom: customRoles(), pages: Object.fromEntries(Object.entries(PAGES).map(([k, p]) => [k, { label: p.label, help: p.help }])), uploads: UPLOAD_KINDS, reports: reportCatalog(), usage: roleUsage(db) }; }
  if (pathname === '/api/roles' && method === 'POST') { const r = createRole(db, user, body, { reportsForBase: reportKeysForBase }); persist(); return [201, { role: r }]; }
  if ((m = pathname.match(/^\/api\/roles\/([a-z0-9_]+)$/)) && method === 'PATCH') { const r = updateRole(db, user, m[1], body, { reportsForBase: reportKeysForBase }); persist(); return { role: r }; }
  if ((m = pathname.match(/^\/api\/roles\/([a-z0-9_]+)$/)) && method === 'DELETE') { const r = deleteRole(db, user, m[1]); persist(); return r; }
  if ((m = pathname.match(/^\/api\/roles\/([a-z0-9_]+)\/(approve|reject)$/)) && method === 'POST') { const r = decideRole(db, user, m[1], { approve: m[2] === 'approve', note: body.note }); persist(); return { role: r }; }
  if (pathname === '/api/leads' && method === 'GET') return listLeads(db, user, { status: query.get('status'), q: query.get('q') });
  if (pathname === '/api/leads' && method === 'POST') { const r = createLead(db, user, body); persist(); return [201, { lead: r }]; }
  if ((m = pathname.match(/^\/api\/leads\/(\d+)$/)) && method === 'GET') return { lead: getLead(db, user, Number(m[1])) };
  if ((m = pathname.match(/^\/api\/leads\/(\d+)$/)) && method === 'PATCH') { const r = updateLead(db, user, Number(m[1]), body); persist(); return { lead: r }; }
  if ((m = pathname.match(/^\/api\/leads\/(\d+)\/follow-up$/)) && method === 'POST') { const r = setFollowUp(db, user, Number(m[1]), body); persist(); return { lead: r }; }
  if ((m = pathname.match(/^\/api\/leads\/(\d+)\/status$/)) && method === 'POST') { const r = setLeadStatus(db, user, Number(m[1]), body); persist(); return { lead: r }; }
  if (pathname === '/api/assets' && method === 'GET') { role(user, ...ASSET_VIEWERS); return { assets: listAssets(db, { status: query.get('status'), region: query.get('region'), network: query.get('network'), q: query.get('q') }), summary: assetSummary(db) }; }
  if (pathname === '/api/assets/mine') return { asset: assetOf(db, user.id) };
  if (pathname === '/api/assets' && method === 'POST') { const r = createAsset(db, user, body); persist(); return [201, { asset: r }]; }
  if ((m = pathname.match(/^\/api\/assets\/(\d+)$/)) && method === 'GET') { const asset = getAsset(db, Number(m[1])); if (!ASSET_VIEWERS.includes(user.role) && asset.holder_id !== user.id) throw new ApiError(404, 'Asset not found'); return { asset, events: assetEvents(db, asset.id) }; }
  if ((m = pathname.match(/^\/api\/assets\/(\d+)$/)) && method === 'PATCH') { const r = updateAsset(db, user, Number(m[1]), body); persist(); return { asset: r }; }
  if ((m = pathname.match(/^\/api\/assets\/(\d+)\/assign$/)) && method === 'POST') { const r = assignAsset(db, user, Number(m[1]), body); persist(); return { asset: r }; }
  if ((m = pathname.match(/^\/api\/assets\/(\d+)\/status$/)) && method === 'POST') { const r = setAssetStatus(db, user, Number(m[1]), body); persist(); return { asset: r }; }
  if (method === 'GET' && pathname === '/api/me') {
    return { user: publicUser(user.id), meta: { statuses: Object.values(STATUS), call_outcomes: CALL_OUTCOMES, incomplete_reasons: INCOMPLETE_REASONS, regions: REGIONS, core_products: CORE_PRODUCTS, products: PRODUCTS, credit_cards: cardFamilies(), card_list_source: cardProductSource(), can_see_payout: canSeePayout(user), incentive_rules: INCENTIVE_RULES, ...(canSeePayout(user) ? { payout_rates: payoutRules(), payout_labels: PAYOUT_LABELS, payout_source: payoutSource() } : {}), personal_loan_types: PERSONAL_LOAN_TYPES, auto_loan_types: AUTO_LOAN_TYPES, role_labels: roleLabels(), assignable_roles: assignableLabels(), custom_roles: customRoles().map(({ key, label, base, description, status }) => ({ key, label, base, description, status })), perms: permissionsOf(user), can_manage_roles: canManageRoles(user), can_approve_roles: canApproveRoles(user), roles_pending: canApproveRoles(user) ? customRoles().filter((r) => r.status === 'pending').length : 0, lead_status: LEAD_STATUS, timing_flags: TIMING_FLAGS, salutations: SALUTATIONS, customer_types: CUSTOMER_TYPES, booster_products: BOOSTER_PRODUCTS, booster_audience: BOOSTER_AUDIENCE, can_manage_boosters: canManageBoosters(user), calendar_green_pct: CALENDAR_GREEN_PCT, calendar_orange_pct: CALENDAR_ORANGE_PCT, can_allocate: canAllocate(user), complaint_status: COMPLAINT_STATUS, complaint_remark: COMPLAINT_REMARK, asset_status: ASSET_STATUS, networks: NETWORKS, accessories: ACCESSORIES, asset_admins: ASSET_ADMINS, auto_loan_classes: AUTO_LOAN_CLASSES, al_incentive_rules: AL_INCENTIVE_RULES, buyout_kinds: BUYOUT_KINDS, secondary_buyout_kinds: SECONDARY_BUYOUT_KINDS, tenure_max: { personal_loan: PL_TENURE_MAX, auto_loan: AL_TENURE_MAX }, card_fee_types: CARD_FEE_TYPES, card_exceptions: CARD_EXCEPTIONS, masked_fields: MASKED_FIELDS, chat_overseers: CHAT_OVERSEERS, chat_edit_minutes: EDIT_WINDOW_MINUTES, banks: BANKS, case_statuses: CASE_STATUS, settable_case_statuses: SETTABLE_CASE_STATUSES, edit_queues: EDIT_QUEUES, recording_statuses: RECORDING_STATUS, score_max: SCORE_MAX, callback_max_days: CALLBACK_MAX_DAYS, it_email: config.itEmail, ocr: DEMO_OCR, import_columns: { users: USER_IMPORT_COLUMNS, cases: CASE_IMPORT_COLUMNS, cards: CARD_IMPORT_COLUMNS, targets: TARGET_IMPORT_COLUMNS, card_products: CARD_PRODUCT_IMPORT_COLUMNS, target_rules: TARGET_RULE_IMPORT_COLUMNS, payout_rules: PAYOUT_RULE_IMPORT_COLUMNS, assets: ASSET_IMPORT_COLUMNS, payroll: PAYROLL_IMPORT_COLUMNS }, import_max_rows: MAX_ROWS, card_statuses: CARD_STATES, card_range_days: CARD_RANGE_DAYS, card_mappers: CARD_MAPPERS, current_cycle: cycleOf(uaeDay()), reports: reportsFor(user), hierarchy_levels: LEVEL_LABELS, staff_core_products: STAFF_CORE_PRODUCTS } };
  }
  if (method === 'GET' && pathname === '/api/stats') return stats(db, user, { region: query.get('region') });
  if (method === 'GET' && pathname === '/api/dashboard') return dashboardFor(db, user, { region: query.get('region') });
  if (method === 'GET' && pathname === '/api/hierarchy') return hierarchy(db, user, { cycle: query.get('cycle'), region: query.get('region') });
  if (method === 'GET' && pathname === '/api/reports') return { reports: reportsFor(user), recent: ['governance', 'business_head', 'mis'].includes(user.role) ? recentRuns(db) : [] };
  if (method === 'GET' && (m = pathname.match(/^\/api\/reports\/([a-z_]+)$/))) {
    const report = runReport(db, user, m[1], Object.fromEntries(query));
    persist();
    if (query.get('format') === 'csv') return { csv: toCsv(report), filename: report.key + '-' + report.from + '-to-' + report.to + (report.region ? '-' + report.region : '') + '.csv' };
    return report;
  }
  if (pathname === '/api/cases') {
    if (method === 'GET') return { cases: listCases(db, user, Object.fromEntries(query)) };
    if (method === 'POST') { if (body.lead_id) getLead(db, user, Number(body.lead_id)); const created = createCase(db, user, body); if (body.lead_id) convertLead(db, user, body.lead_id, created.id); persist(); return [201, { case: created }]; }
  }
  if (method === 'GET' && (m = pathname.match(/^\/api\/cases\/(\d+)\/reveal$/))) return revealFields(db, user, Number(m[1]), query.get('fields'));
  if ((m = pathname.match(/^\/api\/cases\/(\d+)\/messages$/))) {
    if (method === 'GET') return listCaseMessages(db, user, Number(m[1]), Object.fromEntries(query));
    if (method === 'POST') return [201, { message: postCaseMessage(db, user, Number(m[1]), body.body) }];
  }
  if (method === 'GET' && pathname === '/api/conversations') return listConversations(db, user);
  if (method === 'GET' && pathname === '/api/colleagues') return listColleagues(db, user);
  if (method === 'POST' && pathname === '/api/conversations/direct') return { conversation: openDirect(db, user, body.user_id) };
  if ((m = pathname.match(/^\/api\/conversations\/(\d+)\/messages$/))) {
    if (method === 'GET') { const r = listMessages(db, user, Number(m[1]), Object.fromEntries(query)); persist(); return r; }
    if (method === 'POST') return [201, { message: postMessage(db, user, Number(m[1]), body.body) }];
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/messages\/(\d+)\/edit$/))) return { message: editMessage(db, user, Number(m[1]), body.body) };
  if (method === 'GET' && pathname === '/api/access-log') return listAccessLog(db, user, Object.fromEntries(query));
  if ((m = pathname.match(/^\/api\/cases\/(\d+)$/))) {
    if (method === 'GET') { const c = getCase(db, user, Number(m[1])); logAccess(db, user, Number(m[1]), 'view'); persist(); return { case: c }; }
    if (method === 'PUT') return { case: updateCase(db, user, Number(m[1]), body) };
  }
  if (method === 'POST' && (m = pathname.match(/^\/api\/cases\/(\d+)\/actions$/))) {
    return { case: applyAction(db, user, Number(m[1]), body).case };
  }
  if (method === 'GET' && pathname === '/api/notifications') return listNotifications(db, user);
  if (method === 'POST' && pathname === '/api/notifications/read') { markNotificationsRead(db, user, body.ids); return { ok: true }; }
  if (method === 'GET' && pathname === '/api/sales-staff') {
    role(user, 'team_leader', 'sales_manager', 'asm');
    const field = TEAM_FIELDS[user.role];
    return { staff: listUsers(db, { role: 'sales' }).filter((s) => s[field] === user.id).map(({ id, name, sales_code, team_leader_name, sales_manager_name, region, core_product }) => ({ id, name, sales_code, team_leader_name, sales_manager_name, region, core_product })) };
  }
  if (pathname === '/api/users') {
    role(user, 'mis', 'business_head', 'it');
    if (method === 'GET') return { users: user.role === 'it' ? listUsers(db).map(({ id, name, hrms_code, sales_code, role: r, region, active, team_leader_name, sales_manager_name }) => ({ id, name, hrms_code, sales_code, role: r, region, active, team_leader_name, sales_manager_name })) : listUsers(db) };
    role(user, 'mis', 'business_head');
    if (method === 'POST') return [201, { user: createUser(db, body, { requireMobile: true }) }];
  }
  if (method === 'POST' && pathname === '/api/import/users') {
    return importUsers(db, user, body.csv, { dryRun: Boolean(body.dry_run) });
  }
  if (method === 'POST' && pathname === '/api/import/cases') return importCases(db, user, body.csv, { dryRun: Boolean(body.dry_run) });
  if (method === 'POST' && pathname === '/api/import/cards') return importCards(db, user, body.csv, { dryRun: Boolean(body.dry_run) });
  if (method === 'POST' && pathname === '/api/import/targets') return importTargets(db, user, body.csv, { dryRun: Boolean(body.dry_run) });
  if (method === 'POST' && pathname === '/api/targets/generate') { const r = generateTargets(db, user, body.cycle); persist(); return r; }
  if (method === 'POST' && pathname === '/api/import/target_rules') { const r = importTargetRules(db, user, body.csv, { dryRun: Boolean(body.dry_run) }); persist(); return r; }
  if (method === 'POST' && pathname === '/api/import/card_products') { const r = importCardProducts(db, user, body.csv, { dryRun: Boolean(body.dry_run) }); persist(); return r; }
  if (method === 'POST' && pathname === '/api/import/payroll') { const r = importPayroll(db, user, body.csv, { dryRun: Boolean(body.dry_run) }); persist(); return r; }
  if (method === 'GET' && pathname === '/api/pnl') { const pnl = profitAndLoss(db, user, { cycle: query.get('cycle'), region: query.get('region') }); return { pnl, tree: profitAndLossTree(db, user, { cycle: query.get('cycle'), region: query.get('region') }), payroll: payrollFor(db, pnl.cycle, query.get('region')) }; }
  if (method === 'POST' && pathname === '/api/import/assets') { const r = importAssets(db, user, body.csv, { dryRun: Boolean(body.dry_run) }); persist(); return r; }
  if (method === 'POST' && pathname === '/api/import/payout_rules') { const r = importPayoutRules(db, user, body.csv, { dryRun: Boolean(body.dry_run) }); persist(); return r; }
  if (method === 'GET' && pathname === '/api/incentives/me') return myIncentive(db, user, query.get('cycle'));
  if (pathname === '/api/targets') {
    if (method === 'GET') return targetReport(db, user, query.get('cycle'), { region: query.get('region') });
    if (method === 'PUT') return saveTargets(db, user, body);
  }
  if (method === 'PATCH' && (m = pathname.match(/^\/api\/users\/(\d+)$/))) {
    role(user, 'mis', 'business_head');
    const id = Number(m[1]);
    const target = publicUser(id);
    if (!target) throw new ApiError(404, 'User not found');
    let moved = 0;
    if ('role' in body) { const r = resolveRole(body.role); if (id === user.id) throw new ApiError(400, 'You cannot change your own role'); if (r.base !== 'sales' && target.role === 'sales') db.prepare('UPDATE users SET sales_code = NULL, team_leader_id = NULL, sales_manager_id = NULL, asm_id = NULL, salary = NULL, core_product = NULL WHERE id = ?').run(id); if (r.base === 'sales' && target.role !== 'sales') { let pr; try { pr = salesProfile(db, body); } catch (e) { throw new ApiError(400, 'A sales role needs a sales profile: ' + e.message); } db.prepare('UPDATE users SET sales_code = ?, team_leader_id = ?, sales_manager_id = ?, asm_id = ?, salary = ?, core_product = ? WHERE id = ?').run(pr.sales_code, pr.team_leader_id, pr.sales_manager_id, pr.asm_id, pr.salary, pr.core_product, id); } db.prepare('UPDATE users SET role = ?, role_key = ? WHERE id = ?').run(r.base, r.key, id); }
    if (['name', 'email', 'mobile_number', 'whatsapp_number', 'hrms_code', 'doj', 'dol'].some((f) => f in body)) {
      let c;
      try { c = contactDetails(body, { current: target }); } catch (e) { throw new ApiError(400, e.message); }
      if (c.email && db.prepare('SELECT 1 FROM users WHERE email = ? COLLATE NOCASE AND id != ?').get(c.email, id)) throw new ApiError(409, 'A user with that email already exists');
      if (c.hrms_code && db.prepare('SELECT 1 FROM users WHERE hrms_code = ? COLLATE NOCASE AND id != ?').get(c.hrms_code, id)) throw new ApiError(409, 'HRMS code ' + c.hrms_code + ' is already used by another user');
      if (c.dol && id === user.id) throw new ApiError(400, 'You cannot set your own date of leaving');
      for (const [f, v] of Object.entries(c)) db.prepare('UPDATE users SET ' + f + ' = ? WHERE id = ?').run(v, id);
      sweepLeavers(db);
    }
    if ('region' in body) {
      try { db.prepare('UPDATE users SET region = ? WHERE id = ?').run(regionOf(body.region), id); } catch (e) { throw new ApiError(400, e.message); }
    }
    if (['sales_code', 'team_leader_id', 'sales_manager_id', 'asm_id', 'salary', 'core_product'].some((f) => f in body)) {
      if (target.role !== 'sales') throw new ApiError(400, 'Only sales staff have a sales code, team leader and sales manager');
      let p;
      try { p = salesProfile(db, body, target); } catch (e) { throw new ApiError(400, e.message); }
      db.prepare('UPDATE users SET sales_code = ?, team_leader_id = ?, sales_manager_id = ?, asm_id = ?, salary = ?, core_product = ? WHERE id = ?').run(p.sales_code, p.team_leader_id, p.sales_manager_id, p.asm_id, p.salary, p.core_product, id);
      if (['team_leader_id', 'sales_manager_id', 'asm_id'].some((f) => (p[f] ?? null) !== (target[f] ?? null))) moved = moveOpenCases(db, user, id);
    }
    if ('active' in body) {
      if (id === user.id && !body.active) throw new ApiError(400, 'You cannot deactivate your own account');
      if (body.active && target.dol && target.dol <= new Date(Date.now() + 4 * 3600e3).toISOString().slice(0, 10)) throw new ApiError(400, target.name + ' left on ' + target.dol + '. Clear the date of leaving to re-enable the account');
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(body.active ? 1 : 0, id);
    }
    if (body.password) {
      if (String(body.password).length < 8) throw new ApiError(400, 'Password must be at least 8 characters');
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run('demo:' + body.password, id);
    }
    return { user: publicUser(id), moved_cases: moved };
  }
  throw new ApiError(404, 'Not found');
}

config.itEmail = 'it-recordings@demo.local';
// Templates and error reports are offered through the viewer's download prompt when the page
// runs inside claude.ai; elsewhere a normal browser download is used.
let downloadsReady = null;
window.__crmDownloadCsv = async (href) => {
  const r = await fetch(href); const d = await r.json();
  if (d.csv) window.__saveFile(d.filename, d.csv, 'text/csv');
};
window.__saveFile = async (filename, text, type) => {
  try {
    downloadsReady ??= window.claude?.use ? window.claude.use('downloads') : Promise.resolve(null);
    const downloads = await downloadsReady;
    if (downloads) { await downloads.save({ filename, data: text }); return; }
  } catch (e) {
    if (e?.code === 'declined' || e?.code === 'rate_limited') return;
  }
  const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
};
// Scanner files are published alongside the demo page (see the Artifact files map).
const ocrUrl = (f) => new URL('ocr/' + f, location.href).href;
const DEMO_OCR = { script: ocrUrl('tesseract.min.js'), workerPath: ocrUrl('worker.min.js'), coreDir: new URL('ocr', location.href).href, langPath: ocrUrl('eng-model.wasm?l=') };
const ready = initSqlJs({ wasmBinary: fromB64(document.getElementById('sql-wasm').textContent.trim()) })
  .then((S) => { SQL = S; openDemoDb(); });

// Call-back alerts fire at the scheduled time while the page is open.
setInterval(() => { try { if (db && triggerDueCallbacks(db).length) persist(); } catch {} }, 30e3);

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init = {}) => {
  const url = new URL(typeof input === 'string' ? input : input.url, location.href);
  if (!url.pathname.startsWith('/api/')) {
    if (url.href.includes('/ocr/')) {
      // The scanner's engine is five separate files next to the page; a browser will not load them
      // from a file opened off the disk, so say so instead of "Failed to fetch".
      if (location.protocol === 'file:') throw new Error('Scanning needs the demo opened from its web link (or the folder served by a web server). An HTML file opened from the disk cannot load the scanner; everything else works.');
      return realFetch(input, init).then((r) => { if (!r.ok) throw new Error('The scanner could not load its files (' + r.status + '). Reload the page and try again.'); return r; })
        .catch((err) => { throw new Error(err.message === 'Failed to fetch' ? 'The scanner could not download its files. Check the connection and try again.' : err.message); });
    }
    return realFetch(input, init);
  }
  await ready;
  const method = (init.method || 'GET').toUpperCase();
  let status = 200, data;
  try {
    const result = handle(method, url.pathname, url.searchParams, init.body ? JSON.parse(init.body) : {});
    [status, data] = Array.isArray(result) ? result : [200, result];
    if (method !== 'GET') persist();
  } catch (err) {
    status = err.status || 500;
    data = { error: status === 500 ? 'Something went wrong: ' + err.message : err.message };
    if (status === 500) console.error(err);
  }
  return new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
};

// ---- demo bar: one-click role switching and reset ----
const DEMO_USERS = [
  ['sales@demo.local', 'Sam', 'Sales'],
  ['sales2@demo.local', 'Riya', 'Sales'],
  ['sales3@demo.local', 'Noor', 'Sales · auto loans'],
  ['sales4@demo.local', 'Dev', 'Sales · personal loans'],
  ['sales5@demo.local', 'Anita', 'Sales · personal loans'],
  ['processing@demo.local', 'Pat', 'Processing · DXB'],
  ['vlead@demo.local', 'Vera', 'Verification TL'],
  ['processing2@demo.local', 'Omar', 'Processing · AUH'],
  ['leader@demo.local', 'Tara', 'Team leader'],
  ['leader2@demo.local', 'Leena', 'Team leader · loans'],
  ['asm@demo.local', 'Adil', 'Assistant SM'],
  ['manager@demo.local', 'Sana', 'Sales manager'],
  ['7337', 'Fajan', 'Sales · real list'],
  ['mis@demo.local', 'Mira', 'MIS'],
  ['head@demo.local', 'Bilal', 'Business head'],
  ['governance@demo.local', 'Gina', 'Governance'],
  ['it@demo.local', 'Irfan', 'IT'],
];
async function switchTo(email) {
  await ready;
  const row = db.prepare('SELECT id, active FROM users WHERE email = ? COLLATE NOCASE OR (hrms_code IS NOT NULL AND hrms_code = ? COLLATE NOCASE)').get(email, email);
  if (!row || !row.active) return;
  setSession(row.id);
  try { history.replaceState(null, '', '#/'); } catch { location.hash = '#/'; }
  document.getElementById('notif-panel')?.replaceChildren();
  await window.__crmBoot();
  markActive();
}
function markActive() {
  const id = getSession();
  const me = id && db?.prepare('SELECT email, hrms_code FROM users WHERE id = ?').get(id);
  document.querySelectorAll('#demo-bar [data-user]').forEach((b) => b.setAttribute('aria-pressed', String(me && (b.dataset.user === me.email || b.dataset.user === me.hrms_code))));
}
const bar = document.getElementById('demo-bar');
bar.querySelector('.who').innerHTML = DEMO_USERS.map(([email, name, r]) =>
  '<button type="button" data-user="' + email + '" aria-pressed="false"><b>' + name + '</b> ' + r + '</button>').join('');
bar.addEventListener('click', async (e) => {
  const u = e.target.closest('[data-user]');
  if (u) return switchTo(u.dataset.user);
  const reset = e.target.closest('#demo-reset');
  if (!reset) return;
  if (!reset.dataset.armed) {
    reset.dataset.armed = '1';
    reset.textContent = 'Click again to reset';
    setTimeout(() => { delete reset.dataset.armed; reset.textContent = 'Reset sample data'; }, 4000);
    return;
  }
  delete reset.dataset.armed;
  reset.textContent = 'Reset sample data';
  await ready;
  openDemoDb(true);
  const id = getSession();
  await switchTo(id ? (db.prepare('SELECT email FROM users WHERE id = ?').get(id)?.email || 'sales@demo.local') : 'sales@demo.local');
});
window.addEventListener('hashchange', markActive);
document.addEventListener('submit', () => setTimeout(markActive, 300));
document.addEventListener('click', (e) => { if (e.target.closest('#logout')) setTimeout(markActive, 300); });
ready.then(markActive);

// Add one-tap demo accounts to the sign-in screen.
new MutationObserver(() => {
  const form = document.getElementById('login-form');
  if (!form || form.querySelector('.demo-accounts')) return;
  const box = document.createElement('div');
  box.className = 'demo-accounts';
  box.innerHTML = '<p><b>This is a demo.</b> Only these sample accounts exist, so your own email won\u2019t work until a team leader adds it on the Users page. Tap an account to sign in:</p>' +
    DEMO_USERS.map(([email, name, r]) => '<button type="button" data-login="' + email + '"><span><b>' + name + '</b> \u00b7 ' + r + '</span><span class="muted small">' + email + '</span></button>').join('') +
    '<p class="muted small">Password for every demo account: <b>password123</b></p>';
  box.addEventListener('click', (e) => { const b = e.target.closest('[data-login]'); if (b) switchTo(b.dataset.login); });
  form.append(box);
}).observe(document.getElementById('app'), { childList: true });
window.__demoMarkActive = markActive;
`;

const demoCss = `
body { padding-bottom: 76px; }
#demo-bar {
  position: fixed; left: 0; right: 0; bottom: 0; z-index: 40;
  padding: 8px 16px calc(8px + env(safe-area-inset-bottom, 0px));
  background: var(--surface); border-top: 1px solid var(--border);
  display: flex; align-items: center; gap: 8px 14px; flex-wrap: wrap;
  font-size: 13px;
}
@media (min-width: 1024px) { #demo-bar { left: 240px; } }
@media (max-width: 1023px) { .sidebar.open { z-index: 50; } .scrim { z-index: 45; } }
#demo-bar .tag { font-size: 11px; font-weight: 700; letter-spacing: .06em; text-transform: uppercase; color: var(--s-pending); background: var(--s-pending-bg); padding: 2px 8px; border-radius: 999px; }
#demo-bar .who { display: flex; gap: 6px; flex-wrap: wrap; flex: 1; min-width: 0; }
#demo-bar .who button { padding: 4px 10px; font-weight: 400; border-radius: 999px; font-size: 13px; }
#demo-bar .who button[aria-pressed="true"] { background: var(--primary); border-color: var(--primary); color: var(--primary-ink); }
#demo-bar .hint { color: var(--muted); }
#demo-bar #demo-reset { padding: 4px 10px; font-size: 13px; }
.demo-accounts { margin-top: 20px; padding-top: 16px; border-top: 1px solid var(--border); display: grid; gap: 8px; }
.demo-accounts p { margin: 0; }
.demo-accounts button { justify-content: space-between; flex-wrap: wrap; font-weight: 400; text-align: left; }
#toast { bottom: 84px; }
button:focus-visible, a:focus-visible { outline: 2px solid var(--primary); outline-offset: 2px; }
@media (max-width: 760px) {
  body { padding-bottom: 96px; } #toast { bottom: 104px; } #demo-bar .hint { display: none; }
  #demo-bar .who { order: 3; flex-basis: 100%; flex-wrap: nowrap; overflow-x: auto; padding-bottom: 2px; }
  #demo-bar .who button { flex: none; }
  #demo-bar #demo-reset { margin-left: auto; }
}
@media (prefers-reduced-motion: reduce) { #toast { transition: none; } }
`;

const html = `<title>Sourcing CRM</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;500&family=IBM+Plex+Sans:wght@400;500;600;700&display=swap">
<style>
${css}
${demoCss}
</style>
<div id="app"><div class="boot">Loading…</div></div>
<div id="toast" role="status" aria-live="polite"></div>
<div id="demo-bar" role="region" aria-label="Demo controls">
  <span class="tag">Demo</span>
  <span class="hint">Sign in as:</span>
  <div class="who"></div>
  <span class="hint">Saved in this browser only</span>
  <button type="button" id="demo-reset">Reset sample data</button>
</div>
<script type="application/octet-stream" id="sql-wasm">${wasm}</script>
<script>${safe(sqlJs)}</script>
<script type="module">${safe(backend)}</script>
<script type="module">${safe(appJs.replace(/boot\(\)\.then\(\(\) => \{ if \(!state\.user\) renderLogin\(\); \}\);\s*$/, `window.__crmBoot = boot;
boot().then(() => { if (!state.user) renderLogin(); window.__demoMarkActive?.(); });
`))}</script>
`;
if (!html.includes('window.__crmBoot = boot')) throw new Error('boot hook not injected');
fs.writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1024).toFixed(0)} KB)`);
