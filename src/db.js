import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  name          TEXT NOT NULL,
  email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
  role          TEXT NOT NULL, -- validated against ROLES in auth.js
  password_hash TEXT NOT NULL,
  active        INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  sales_code       TEXT,
  team_leader_id   INTEGER REFERENCES users(id),
  sales_manager_id INTEGER REFERENCES users(id),
  mobile_number    TEXT, -- UAE local mobile, stored as 05XXXXXXXX
  whatsapp_number  TEXT, -- international format, +9715XXXXXXXX
  region           TEXT, -- DXB or AUH: processors verify only their region's files
  asm_id           INTEGER REFERENCES users(id), -- sales staff: their assistant sales manager
  salary           REAL, -- sales staff: monthly salary in AED, which sets their targets
  hrms_code        TEXT, -- the bank's HRMS staff code: unique, and the username at sign-in
  doj              TEXT, -- date of joining, YYYY-MM-DD
  dol              TEXT, -- date of leaving, YYYY-MM-DD: the account is disabled from that day
  core_product     TEXT -- sales staff: the product line they mainly sell (credit_card, personal_loan, auto_loan, multi_product)
);

CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS cases (
  id                 INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_name      TEXT NOT NULL,
  first_name         TEXT,
  middle_name        TEXT,
  last_name          TEXT,
  company_name       TEXT,
  salary             REAL,
  eid_number         TEXT,
  passport_number    TEXT,
  bidaya_id          TEXT,
  app_id             TEXT,
  phone              TEXT NOT NULL,
  alt_phone          TEXT,
  email              TEXT,
  address            TEXT,
  city               TEXT,
  product            TEXT,
  bundle_products    TEXT,
  credit_card        TEXT,
  personal_loan_type TEXT,
  buyout_bank        TEXT,
  loan_amount        REAL,
  interest_rate      REAL,
  full_loan_amount   REAL,
  incremental_amount REAL,
  amount             REAL,
  source             TEXT,
  sales_notes        TEXT,
  status             TEXT NOT NULL,
  case_status        TEXT NOT NULL DEFAULT 'sent_to_check',
  case_status_note   TEXT,
  case_status_by     INTEGER REFERENCES users(id),
  case_status_at     TEXT,
  sourcing_date      TEXT,
  region             TEXT,
  qc_flag            INTEGER NOT NULL DEFAULT 0,
  urgent_flag        INTEGER NOT NULL DEFAULT 0,
  urgent_note        TEXT,
  urgent_by          INTEGER REFERENCES users(id),
  urgent_at          TEXT,
  qc_note            TEXT,
  qc_by              INTEGER REFERENCES users(id),
  qc_at              TEXT,
  recording_status   TEXT,
  recording_request_note TEXT,
  recording_requested_by INTEGER REFERENCES users(id),
  recording_requested_at TEXT,
  recording_ref      TEXT,
  recording_provided_by  INTEGER REFERENCES users(id),
  recording_provided_at  TEXT,
  complaint_number   TEXT,
  complaint_by       INTEGER REFERENCES users(id),
  complaint_at       TEXT,
  qc_score           REAL,
  recording_decided_by INTEGER REFERENCES users(id),
  recording_decided_at TEXT,
  recording_decision_note TEXT,
  recording_it_email_at TEXT,
  qc_score_note      TEXT,
  qc_scored_by       INTEGER REFERENCES users(id),
  qc_scored_at       TEXT,
  -- Credit card activation after the case is completed (temp end): active / inactive, set by MIS.
  card_status          TEXT,
  card_activation_date TEXT,
  card_status_by       INTEGER REFERENCES users(id),
  card_status_at       TEXT,
  -- Amounts actually disbursed, recorded when a loan case is completed (count towards AED targets).
  pl_disbursed_amount  REAL,
  al_disbursed_amount  REAL,
  -- Call-back the customer asked for: when (UTC), who scheduled it, and whether the processor
  -- has been alerted that it is due.
  -- Card fee arrangement the customer was sold, and a personal loan's first payment date.
  card_fee_type        TEXT,
  card_category        TEXT, -- from the product list when the card was chosen
  card_points          REAL,
  -- The card's salary requirement when it was chosen, and the deviation/promotion decision when
  -- the customer's salary was below it (by the sales person, or a TL/SM/ASM on approval).
  card_min_salary      REAL,
  card_salary_exception TEXT,
  card_exception_by    INTEGER REFERENCES users(id),
  card_exception_at    TEXT,
  card_exception_note  TEXT,
  fpd                  TEXT,
  callback_at          TEXT,
  callback_by          INTEGER REFERENCES users(id),
  callback_set_at      TEXT,
  callback_notified_at TEXT,
  -- Latest automated verification call (details in bot_calls).
  bot_call_status    TEXT,
  bot_call_at        TEXT,
  core_product       TEXT,
  sales_staff_id     INTEGER REFERENCES users(id),
  sales_staff_name   TEXT,
  sales_code         TEXT,
  team_leader_name   TEXT,
  sales_manager_name TEXT,
  -- The team the file belongs to: the sales person's managers when it was sourced, moved to the
  -- new team only while the file is still open if the sales person changes team.
  team_leader_id     INTEGER REFERENCES users(id),
  sales_manager_id   INTEGER REFERENCES users(id),
  asm_id             INTEGER REFERENCES users(id),
  edit_request_to    TEXT,
  edit_request_note  TEXT,
  edit_request_by    INTEGER REFERENCES users(id),
  edit_request_at    TEXT,
  created_by         INTEGER NOT NULL REFERENCES users(id),
  assigned_to        INTEGER REFERENCES users(id),
  call_attempts      INTEGER NOT NULL DEFAULT 0,
  incomplete_reason  TEXT,
  incomplete_note    TEXT,
  incomplete_at      TEXT,
  tl_action          TEXT,
  tl_note            TEXT,
  tl_actioned_by     INTEGER REFERENCES users(id),
  tl_actioned_at     TEXT,
  verified_by        INTEGER REFERENCES users(id),
  verified_at        TEXT,
  created_at         TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at         TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status);
CREATE INDEX IF NOT EXISTS idx_cases_created_by ON cases(created_by);

CREATE TABLE IF NOT EXISTS case_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id     INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  user_id     INTEGER REFERENCES users(id),
  type        TEXT NOT NULL,
  from_status TEXT,
  to_status   TEXT,
  detail      TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_events_case ON case_events(case_id);

CREATE TABLE IF NOT EXISTS notifications (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id    INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  message    TEXT NOT NULL,
  link       TEXT,                     -- where the notification opens, when not a case
  is_read    INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, is_read);

-- Monthly targets per sales person and product. A cycle runs from the 21st to the 20th and is
-- named after the month it ends in ('2026-06' = 21 May to 20 June).
-- Chat: a discussion per case (case_id) and conversations (direct messages and automatic groups).
CREATE TABLE IF NOT EXISTS conversations (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  kind       TEXT NOT NULL,            -- 'dm' or 'group'
  name       TEXT,
  group_key  TEXT UNIQUE,              -- 'all', 'processing', 'team:<team leader id>'
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS conversation_members (
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  last_read_id    INTEGER,
  PRIMARY KEY (conversation_id, user_id)
);
CREATE TABLE IF NOT EXISTS messages (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id         INTEGER REFERENCES cases(id) ON DELETE CASCADE,
  conversation_id INTEGER REFERENCES conversations(id) ON DELETE CASCADE,
  user_id         INTEGER NOT NULL REFERENCES users(id),
  body            TEXT NOT NULL,
  flagged         INTEGER NOT NULL DEFAULT 0,  -- looks like it holds personal data
  created_at      TEXT NOT NULL,
  edited_at       TEXT
);
CREATE INDEX IF NOT EXISTS idx_messages_case ON messages(case_id, id);
CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, id);

-- Who looked at a customer's personal data: each reveal of a masked value, and each case opened.
CREATE TABLE IF NOT EXISTS access_log (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  case_id INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  what    TEXT NOT NULL,
  at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_access_log_case ON access_log(case_id, id);
CREATE INDEX IF NOT EXISTS idx_access_log_user ON access_log(user_id, id);

-- The bank's credit card product list, uploaded by MIS or a business head (see credit-cards.js).
CREATE TABLE IF NOT EXISTS card_products (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT NOT NULL UNIQUE COLLATE NOCASE,
  family     TEXT NOT NULL,
  category   TEXT NOT NULL,
  points     REAL,
  min_salary REAL, -- minimum monthly salary (AED) the customer needs for this card
  active     INTEGER NOT NULL DEFAULT 1,
  updated_by INTEGER REFERENCES users(id),
  updated_at TEXT NOT NULL
);

-- Salary-based target rules: a sales person whose salary falls in a band gets that target for the
-- product (points for cards and auto loans, AED for personal loans, a count for accounts).
CREATE TABLE IF NOT EXISTS target_rules (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product     TEXT NOT NULL,
  salary_from REAL NOT NULL,
  salary_to   REAL NOT NULL,
  target      REAL NOT NULL,
  set_by      INTEGER REFERENCES users(id),
  set_at      TEXT NOT NULL
);
-- Points an auto loan earns by the amount disbursed.
CREATE TABLE IF NOT EXISTS auto_loan_points (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  amount_from REAL NOT NULL,
  amount_to   REAL NOT NULL,
  points      REAL NOT NULL,
  set_by      INTEGER REFERENCES users(id),
  set_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS report_runs (
  id      INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  report  TEXT NOT NULL,
  filters TEXT,
  at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS targets (
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  cycle   TEXT NOT NULL,
  product TEXT NOT NULL,
  target  INTEGER NOT NULL,
  set_by  INTEGER REFERENCES users(id),
  set_at  TEXT NOT NULL,
  PRIMARY KEY (user_id, cycle, product)
);

-- Automated verification calls placed by the calling bot. The bot reports back to a callback URL
-- that carries the call's one-time token. Only the outcome of each check is kept, never the values.
CREATE TABLE IF NOT EXISTS bot_calls (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  case_id      INTEGER NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
  token        TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL, -- requested, in_progress, completed, failed, expired
  requested_by INTEGER NOT NULL REFERENCES users(id),
  requested_at TEXT NOT NULL,
  finished_at  TEXT,
  outcome      TEXT,
  checks       TEXT, -- JSON [{key, label, result}]
  summary      TEXT,
  transcript   TEXT,
  recording_url TEXT,
  error        TEXT
);
CREATE INDEX IF NOT EXISTS idx_bot_calls_case ON bot_calls(case_id);
`;

export function openDb(file = process.env.DB_FILE || 'data/crm.db') {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA foreign_keys = ON;');
  if (file !== ':memory:') db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  migrate(db);
  return db;
}

// Columns added after the first release; ALTER existing databases in place.
const ADDED_COLUMNS = {
  bundle_products: 'TEXT', credit_card: 'TEXT', personal_loan_type: 'TEXT', buyout_bank: 'TEXT',
  first_name: 'TEXT', middle_name: 'TEXT', last_name: 'TEXT', company_name: 'TEXT', salary: 'REAL',
  eid_number: 'TEXT', passport_number: 'TEXT', bidaya_id: 'TEXT', app_id: 'TEXT',
  loan_amount: 'REAL', interest_rate: 'REAL', full_loan_amount: 'REAL', incremental_amount: 'REAL',
  case_status: "TEXT NOT NULL DEFAULT 'sent_to_check'", case_status_note: 'TEXT',
  case_status_by: 'INTEGER REFERENCES users(id)', case_status_at: 'TEXT', sourcing_date: 'TEXT',
  edit_request_to: 'TEXT', edit_request_note: 'TEXT', edit_request_by: 'INTEGER REFERENCES users(id)', edit_request_at: 'TEXT',
  region: 'TEXT', core_product: 'TEXT', sales_staff_id: 'INTEGER REFERENCES users(id)', sales_staff_name: 'TEXT',
  sales_code: 'TEXT', team_leader_name: 'TEXT', sales_manager_name: 'TEXT',
  team_leader_id: 'INTEGER REFERENCES users(id)', sales_manager_id: 'INTEGER REFERENCES users(id)', asm_id: 'INTEGER REFERENCES users(id)',
  qc_flag: 'INTEGER NOT NULL DEFAULT 0', urgent_flag: 'INTEGER NOT NULL DEFAULT 0', urgent_note: 'TEXT',
  urgent_by: 'INTEGER REFERENCES users(id)', urgent_at: 'TEXT', qc_note: 'TEXT', qc_by: 'INTEGER REFERENCES users(id)', qc_at: 'TEXT',
  recording_status: 'TEXT', recording_request_note: 'TEXT', recording_requested_by: 'INTEGER REFERENCES users(id)',
  recording_requested_at: 'TEXT', recording_ref: 'TEXT', recording_provided_by: 'INTEGER REFERENCES users(id)',
  recording_provided_at: 'TEXT', complaint_number: 'TEXT', complaint_by: 'INTEGER REFERENCES users(id)', complaint_at: 'TEXT',
  qc_score: 'REAL', recording_decided_by: 'INTEGER REFERENCES users(id)', recording_decided_at: 'TEXT',
  recording_decision_note: 'TEXT', recording_it_email_at: 'TEXT', qc_score_note: 'TEXT', qc_scored_by: 'INTEGER REFERENCES users(id)', qc_scored_at: 'TEXT',
  card_status: 'TEXT', card_activation_date: 'TEXT', card_status_by: 'INTEGER REFERENCES users(id)', card_status_at: 'TEXT',
  pl_disbursed_amount: 'REAL', al_disbursed_amount: 'REAL', bot_call_status: 'TEXT', bot_call_at: 'TEXT',
  card_fee_type: 'TEXT', fpd: 'TEXT', card_category: 'TEXT', card_points: 'REAL',
  card_min_salary: 'REAL', card_salary_exception: 'TEXT', card_exception_by: 'INTEGER REFERENCES users(id)', card_exception_at: 'TEXT', card_exception_note: 'TEXT',
  callback_at: 'TEXT', callback_by: 'INTEGER REFERENCES users(id)', callback_set_at: 'TEXT', callback_notified_at: 'TEXT',
};
const ADDED_USER_COLUMNS = {
  sales_code: 'TEXT', team_leader_id: 'INTEGER REFERENCES users(id)', sales_manager_id: 'INTEGER REFERENCES users(id)',
  mobile_number: 'TEXT', whatsapp_number: 'TEXT', region: 'TEXT', asm_id: 'INTEGER REFERENCES users(id)', salary: 'REAL', hrms_code: 'TEXT', doj: 'TEXT', dol: 'TEXT', core_product: 'TEXT',
};

function migrate(db) {
  if (!db.prepare('PRAGMA table_info(notifications)').all().some((c) => c.name === 'link')) db.exec('ALTER TABLE notifications ADD COLUMN link TEXT');
  const cols = db.prepare('PRAGMA table_info(cases)').all().map((c) => c.name);
  for (const [name, type] of Object.entries(ADDED_COLUMNS)) {
    if (!cols.includes(name)) db.exec(`ALTER TABLE cases ADD COLUMN ${name} ${type}`);
  }
  // Files from before the team was stored on them belong to the sales person's current team.
  db.exec(`UPDATE cases SET team_leader_id = (SELECT team_leader_id FROM users WHERE id = cases.sales_staff_id),
      sales_manager_id = (SELECT sales_manager_id FROM users WHERE id = cases.sales_staff_id),
      asm_id = (SELECT asm_id FROM users WHERE id = cases.sales_staff_id)
    WHERE team_leader_id IS NULL AND sales_staff_id IS NOT NULL`);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_users_hrms ON users(hrms_code COLLATE NOCASE)');
  if (!db.prepare('PRAGMA table_info(card_products)').all().some((c) => c.name === 'min_salary')) db.exec('ALTER TABLE card_products ADD COLUMN min_salary REAL');
  // Cases created before the sourcing date existed were sourced on the day they were entered.
  db.exec("UPDATE cases SET sourcing_date = substr(created_at, 1, 10) WHERE sourcing_date IS NULL");
  // Loans completed before disbursed amounts were recorded: assume the amount on the file.
  db.exec(`UPDATE cases SET pl_disbursed_amount = CASE WHEN personal_loan_type = 'top_up' THEN incremental_amount ELSE loan_amount END
    WHERE case_status = 'completed' AND pl_disbursed_amount IS NULL
      AND (product = 'personal_loan' OR ',' || bundle_products || ',' LIKE '%,personal_loan,%')`);
  db.exec(`UPDATE cases SET al_disbursed_amount = amount
    WHERE case_status = 'completed' AND al_disbursed_amount IS NULL
      AND (product = 'auto_loan' OR ',' || bundle_products || ',' LIKE '%,auto_loan,%')`);

  // The first release limited users.role to three roles with a CHECK constraint; rebuild the
  // table without it so the newer roles (MIS, sales manager, business head) can be stored.
  const usersSql = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'users'").get()?.sql || '';
  if (/CHECK\s*\(\s*role IN/i.test(usersSql)) {
    db.exec('PRAGMA foreign_keys = OFF');
    try {
      transaction(db, () => {
        db.exec(`CREATE TABLE users_new (
          id            INTEGER PRIMARY KEY AUTOINCREMENT,
          name          TEXT NOT NULL,
          email         TEXT NOT NULL UNIQUE COLLATE NOCASE,
          role          TEXT NOT NULL,
          password_hash TEXT NOT NULL,
          active        INTEGER NOT NULL DEFAULT 1,
          created_at    TEXT NOT NULL DEFAULT (datetime('now'))
        )`);
        db.exec('INSERT INTO users_new SELECT id, name, email, role, password_hash, active, created_at FROM users');
        db.exec('DROP TABLE users');
        db.exec('ALTER TABLE users_new RENAME TO users');
      });
    } finally {
      db.exec('PRAGMA foreign_keys = ON');
    }
  }

  const userCols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const [name, type] of Object.entries(ADDED_USER_COLUMNS)) {
    if (!userCols.includes(name)) db.exec(`ALTER TABLE users ADD COLUMN ${name} ${type}`);
  }
  // Files entered before sales staff details existed belong to the sales person who created them.
  db.exec(`UPDATE cases SET sales_staff_id = created_by,
             sales_staff_name = (SELECT name FROM users WHERE users.id = cases.created_by)
           WHERE sales_staff_id IS NULL AND created_by IN (SELECT id FROM users WHERE role = 'sales')`);
}

/**
 * Runs fn inside a savepoint so one failing step can be undone without ending the surrounding
 * transaction (used by bulk imports to skip bad rows).
 */
export function savepoint(db, fn) {
  db.exec('SAVEPOINT row');
  try {
    const result = fn();
    db.exec('RELEASE row');
    return result;
  } catch (err) {
    db.exec('ROLLBACK TO row');
    db.exec('RELEASE row');
    throw err;
  }
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
