import { openDb } from './db.js';
import { createServer } from './server.js';
import { createUser } from './auth.js';

const db = openDb();

// First run: create the initial team-leader account so someone can log in and add staff.
if (db.prepare('SELECT COUNT(*) AS n FROM users').get().n === 0) {
  const email = process.env.ADMIN_EMAIL || 'admin@crm.local';
  const password = process.env.ADMIN_PASSWORD || 'changeme123';
  createUser(db, { name: process.env.ADMIN_NAME || 'Team Leader', email, role: 'team_leader', password });
  console.log(`Created initial team leader account: ${email} / ${password}`);
  if (!process.env.ADMIN_PASSWORD) console.log('  -> Change this password from the Users page after signing in.');
}

const port = Number(process.env.PORT) || 3000;
createServer(db).listen(port, () => {
  console.log(`CRM running at http://localhost:${port}`);
  if (process.env.TL_WEBHOOK_URL) console.log('Team-leader webhook alerts enabled.');
});
