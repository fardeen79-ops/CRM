import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { openDb } from '../src/db.js';

// A database from the first release: users with the role CHECK and none of the later columns.
test('a first-release database opens and gains the newer columns', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'crm-mig-')), 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE users (
    id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    role TEXT NOT NULL CHECK (role IN ('sales','processing','team_leader')), password_hash TEXT NOT NULL,
    active INTEGER NOT NULL DEFAULT 1, created_at TEXT NOT NULL DEFAULT (datetime('now')))`);
  old.exec("INSERT INTO users (name, email, role, password_hash) VALUES ('Old Sam', 'old@x.local', 'sales', 'x')");
  old.close();
  const db = openDb(file);
  const cols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
  for (const c of ['hrms_code', 'role_key', 'region']) assert.ok(cols.includes(c), c);
  assert.equal(db.prepare("SELECT role FROM users WHERE email = 'old@x.local'").get().role, 'sales');
  db.exec("UPDATE users SET role = 'it' WHERE email = 'old@x.local'");
  db.close();
});
