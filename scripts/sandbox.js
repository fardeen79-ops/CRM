// Runs the CRM on a throwaway copy of the database, so you can click around
// without touching the real one.
//
//   npm run sandbox            # copies data/crm.db -> data/sandbox.db (first time only), serves on port 3100
//   npm run sandbox -- --fresh # throws the sandbox copy away and starts again from the real database
//
// If there is no real database yet, the sandbox starts empty with the demo
// users and sample cases (password "password123"), plus the business head
// account admin@crm.local / changeme123.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const real = process.env.DB_FILE || 'data/crm.db';
const sandbox = process.env.SANDBOX_DB_FILE || 'data/sandbox.db';
const port = process.env.SANDBOX_PORT || '3100';
const fresh = process.argv.includes('--fresh');
const node = process.execPath;
const flags = ['--disable-warning=ExperimentalWarning'];

if (fresh) for (const f of [sandbox, `${sandbox}-wal`, `${sandbox}-shm`]) fs.rmSync(f, { force: true });

const env = { ...process.env, DB_FILE: sandbox, PORT: port };
if (!fs.existsSync(sandbox)) {
  fs.mkdirSync(path.dirname(path.resolve(sandbox)), { recursive: true });
  if (fs.existsSync(real)) {
    // Flush the real database's write-ahead log into a consistent single-file copy.
    const { DatabaseSync } = await import('node:sqlite');
    const src = new DatabaseSync(real);
    src.exec(`VACUUM INTO '${path.resolve(sandbox).replace(/'/g, "''")}'`);
    src.close();
    console.log(`Sandbox copy made from ${real} -> ${sandbox}`);
  }
  const { DatabaseSync } = await import('node:sqlite');
  const copy = fs.existsSync(sandbox) ? new DatabaseSync(sandbox) : null;
  const users = copy ? copy.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'users'").get().n && copy.prepare('SELECT COUNT(*) AS n FROM users').get().n : 0;
  copy?.close();
  if (!users) {
    console.log(`No staff in ${fs.existsSync(real) ? real : 'the database'} yet: starting the sandbox with demo data.`);
    spawnSync(node, [...flags, 'scripts/seed-demo.js'], { stdio: 'inherit', env });
  }
} else {
  console.log(`Reusing ${sandbox} (run with --fresh to start over from ${real}).`);
}

console.log(`Sandbox CRM: changes stay in ${sandbox}; ${real} is never written.`);
const run = spawnSync(node, [...flags, 'src/index.js'], { stdio: 'inherit', env });
process.exit(run.status ?? 1);
