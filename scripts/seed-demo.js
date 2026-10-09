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

const leader = ensureUser('Tara Leader', 'leader@demo.local', 'team_leader', { mobile_number: '0501110001', whatsapp_number: '+971501110001' });
const manager = ensureUser('Sana Manager', 'manager@demo.local', 'sales_manager', { mobile_number: '0501110002' });
const team = { team_leader_id: leader.id, sales_manager_id: manager.id };
const sales1 = ensureUser('Sam Sales', 'sales@demo.local', 'sales', { sales_code: 'DXB-S-001', mobile_number: '0551110003', whatsapp_number: '+971551110003', ...team });
const sales2 = ensureUser('Riya Sales', 'sales2@demo.local', 'sales', { sales_code: 'AUH-S-002', mobile_number: '0561110004', whatsapp_number: '+919876543210', ...team });
const proc = ensureUser('Pat Processing', 'processing@demo.local', 'processing', { mobile_number: '0521110005' });

if (db.prepare('SELECT COUNT(*) AS n FROM cases').get().n === 0) {
  const fpd = new Date(Date.now() + 35 * 864e5).toISOString().slice(0, 10);
  const samples = [
    [sales1, { region: 'DXB', core_product: 'personal_loan', first_name: 'Arjun', last_name: 'Mehta', phone: '0501234567', city: 'Dubai', salary: 18000, product: 'personal_loan', personal_loan_type: 'fresh', loan_amount: '250000', interest_rate: '6.25', pl_tenure: 48, fpd, source: 'Walk-in' }],
    [sales1, { region: 'DXB', core_product: 'multi_product', first_name: 'Neha', last_name: 'Kapoor', phone: '0507654321', city: 'Dubai', salary: 25000, product: 'bundle', bundle_products: ['credit_card', 'accounts'], credit_card: 'Skywards Signature Credit Card', card_fee_type: 'fyf', source: 'Referral' }],
    [sales2, { region: 'AUH', core_product: 'auto_loan', first_name: 'John', last_name: 'Fernandes', phone: '0551112233', city: 'Abu Dhabi', salary: 22000, product: 'auto_loan', auto_loan_type: 'new', amount: '90000', car_make: 'Toyota', car_model: 'Camry', car_year: 2026, al_lead_source: 'Dealer referral', al_interest_rate: 3.25, al_tenure: 60, source: 'Field visit' }],
    [sales2, { region: 'AUH', core_product: 'credit_card', first_name: 'Priya', last_name: 'Nair', phone: '0569998877', city: 'Abu Dhabi', salary: 12000, product: 'credit_card', credit_card: 'noon One Visa Credit Card', card_fee_type: 'fyf', source: 'Cold call' }],
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
