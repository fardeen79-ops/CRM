// Creates demo users (password: "password123") and a few sample cases.
import { openDb } from '../src/db.js';
import { createUser } from '../src/auth.js';
import { createCase, applyAction } from '../src/cases.js';

const db = openDb();
const PASSWORD = 'password123';

function ensureUser(name, email, role, profile = {}) {
  return db.prepare('SELECT id, name, email, role FROM users WHERE email = ?').get(email) ||
    createUser(db, { name, email, role, password: PASSWORD, ...profile });
}

const leader = ensureUser('Tara Leader', 'leader@demo.local', 'team_leader');
const manager = ensureUser('Sana Manager', 'manager@demo.local', 'sales_manager');
const team = { team_leader_id: leader.id, sales_manager_id: manager.id };
const sales1 = ensureUser('Sam Sales', 'sales@demo.local', 'sales', { sales_code: 'DXB-S-001', ...team });
const sales2 = ensureUser('Riya Sales', 'sales2@demo.local', 'sales', { sales_code: 'AUH-S-002', ...team });
const proc = ensureUser('Pat Processing', 'processing@demo.local', 'processing');

if (db.prepare('SELECT COUNT(*) AS n FROM cases').get().n === 0) {
  const samples = [
    [sales1, { region: 'DXB', core_product: 'personal_loan', customer_name: 'Arjun Mehta', phone: '+91 98765 43210', city: 'Mumbai', product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '250000', interest_rate: '6.25', source: 'Walk-in' }],
    [sales1, { region: 'DXB', core_product: 'multi_product', customer_name: 'Neha Kapoor', phone: '+91 91234 56780', city: 'Pune', product: 'bundle', bundle_products: ['credit_card', 'accounts'], credit_card: 'Skywards Signature Credit Card', source: 'Referral' }],
    [sales2, { region: 'AUH', core_product: 'auto_loan', customer_name: 'John Fernandes', phone: '+91 99887 76655', city: 'Goa', product: 'auto_loan', amount: '900000', source: 'Field visit' }],
    [sales2, { region: 'AUH', core_product: 'credit_card', customer_name: 'Priya Nair', phone: '+91 90000 11122', city: 'Kochi', product: 'accounts', amount: '150000', source: 'Cold call' }],
  ];
  const ids = samples.map(([u, data]) => createCase(db, u, data).id);
  applyAction(db, proc, ids[0], { action: 'log_call', outcome: 'connected', note: 'Customer confirmed details' });
  applyAction(db, proc, ids[0], { action: 'complete', note: 'All details verified' });
  applyAction(db, proc, ids[2], { action: 'log_call', outcome: 'no_answer' });
  applyAction(db, proc, ids[2], { action: 'mark_incomplete', reason: 'customer_unreachable', note: 'Tried 3 times, no response' });
  console.log(`Seeded ${ids.length} sample cases.`);
}

console.log(`Demo users (password "${PASSWORD}"):`);
for (const u of [leader, manager, sales1, sales2, proc]) console.log(`  ${u.role.padEnd(12)} ${u.email}`);
