// Bulk upload of users and cases from CSV files (Excel "Save as CSV" works). Each row is checked
// with the same rules as the on-screen forms. A preview runs the whole import inside a transaction
// and rolls it back; a real import keeps the good rows and reports the rest so they can be fixed
// and uploaded again.
import { transaction, savepoint } from './db.js';
import { ROLES, createUser, tempPassword } from './auth.js';
import { PRODUCTS, PERSONAL_LOAN_TYPES, AUTO_LOAN_TYPES, BUYOUT_KINDS, CARD_FEE_TYPES, REGIONS, CORE_PRODUCTS, CARD_STATUS, caseRef, insertCase, setCardStatus, includesCard, WorkflowError } from './cases.js';
import { setTargetsFor, TARGET_UNITS, TARGET_PRODUCTS } from './performance.js';
import { parseCycle } from './cycles.js';
import { cardProduct, loadCardProducts, backfillCardCategories, cardProducts } from './credit-cards.js';
import { BANKS } from './banks.js';

export const MAX_ROWS = 1000;
// Only MIS and business heads can bulk upload, for users and cases alike.
export const BULK_UPLOAD_ROLES = ['mis', 'business_head'];

function requireBulkRole(user) {
  if (!BULK_UPLOAD_ROLES.includes(user.role)) throw new WorkflowError(403, 'Only MIS and business heads can bulk upload');
}

const ROLE_LABELS = {
  sales: 'Sales', processing: 'Processing', team_leader: 'Team Leader', asm: 'Assistant Sales Manager', sales_manager: 'Sales Manager',
  mis: 'MIS', business_head: 'Business Head', governance: 'Governance',
};

// Column guide shared with the page (template download and the help table).
export const USER_IMPORT_COLUMNS = [
  { key: 'name', header: 'Full name', required: true, example: 'Aisha Khan' },
  { key: 'hrms_code', header: 'HRMS code', required: true, example: 'EN10234', help: 'The bank\'s staff code. Unique; it is the username at sign-in' },
  { key: 'email', header: 'Email', required: true, example: 'aisha.khan@yourbank.ae' },
  { key: 'role', header: 'Role', required: true, example: 'Sales', allowed: Object.values(ROLE_LABELS) },
  { key: 'mobile_number', header: 'Local mobile', required: true, example: '050 123 4567', help: 'UAE mobile number' },
  { key: 'whatsapp_number', header: 'WhatsApp number', example: '+971 50 123 4567', help: 'With country code; a UAE number without one gets +971' },
  { key: 'doj', header: 'Date of joining', example: '01/03/2024', help: 'DD/MM/YYYY or YYYY-MM-DD' },
  { key: 'dol', header: 'Date of leaving', example: '', help: 'Only for staff who have resigned. The account is disabled from that day' },
  { key: 'region', header: 'Region', example: 'DXB', allowed: Object.keys(REGIONS), help: 'DXB or AUH. Processors then see only that region\'s files; sales staff\'s files default to it' },
  { key: 'sales_code', header: 'Sales code', example: 'DXB-S-021', help: 'Sales staff only. Must be unique' },
  { key: 'team_leader_email', header: 'Team leader email', example: 'tara@yourbank.ae', help: 'Sales staff only. An active team leader, or one added earlier in this file' },
  { key: 'sales_manager_email', header: 'Sales manager email', example: 'sana@yourbank.ae', help: 'Sales staff only. An active sales manager, or one added earlier in this file' },
  { key: 'asm_email', header: 'Assistant sales manager email', example: '', help: 'Sales staff only, optional. An active assistant sales manager' },
  { key: 'salary', header: 'Monthly salary (AED)', example: '5000', help: 'Sales staff only. Sets their targets through the salary bands' },
  { key: 'core_product', header: 'Core product', example: 'Credit Cards', help: 'Sales staff only: Credit Cards, Personal Loans, Auto Loans or Multi product' },
  { key: 'password', header: 'Temporary password', example: '', help: 'Optional, 8+ characters. Left blank, one is generated and shown after the upload' },
];

export const CASE_IMPORT_COLUMNS = [
  { key: 'sales_code', header: 'Sales code', required: true, example: 'DXB-S-014', help: 'The sales person who sourced the file' },
  { key: 'sourcing_date', header: 'Sourcing date', required: true, example: '06/10/2026', help: 'DD/MM/YYYY or YYYY-MM-DD' },
  { key: 'region', header: 'Region', required: true, example: 'DXB', allowed: Object.keys(REGIONS) },
  { key: 'core_product', header: 'Core product', required: true, example: 'Personal Loan', allowed: Object.values(CORE_PRODUCTS) },
  { key: 'first_name', header: 'First name', required: true, example: 'Mohammed' },
  { key: 'middle_name', header: 'Middle name', example: 'Rashid' },
  { key: 'last_name', header: 'Last name', required: true, example: 'Al Mansoori' },
  { key: 'phone', header: 'Mobile number', required: true, example: '+971 50 123 4567' },
  { key: 'alt_phone', header: 'Alternate phone', example: '' },
  { key: 'email', header: 'Customer email', example: 'customer@example.com' },
  { key: 'company_name', header: 'Company name', example: 'Emirates Logistics LLC' },
  { key: 'salary', header: 'Salary', example: '25000', help: 'Monthly, AED' },
  { key: 'eid_number', header: 'Emirates ID', example: '784-1990-1234567-1', help: 'Keep the dashes so Excel treats it as text' },
  { key: 'passport_number', header: 'Passport number', example: 'N1234567' },
  { key: 'bidaya_id', header: 'Bidaya ID', example: '' },
  { key: 'app_id', header: 'App ID', example: '', help: 'An App ID already on the CRM is treated as a duplicate' },
  { key: 'product', header: 'Product', required: true, example: 'Personal Loan', allowed: [...Object.values(PRODUCTS), 'Bundle'] },
  { key: 'bundle_products', header: 'Bundle products', example: '', help: 'For Bundle: two or more products separated by ; e.g. Personal Loan; Credit Card' },
  { key: 'credit_card', header: 'Credit card', example: '', help: 'Card name exactly as in the New case form' },
  { key: 'card_fee_type', header: 'Card sourced type', example: '', help: 'For credit cards', allowed: ['FYF', 'Full fee', 'FFL'] },
  { key: 'personal_loan_type', header: 'Personal loan type', example: 'Top Up', allowed: Object.values(PERSONAL_LOAN_TYPES) },
  { key: 'fpd', header: 'FPD', example: '05/11/2026', help: 'Personal loan first payment date, DD/MM/YYYY' },
  { key: 'buyout_bank', header: 'Buy-out bank', example: '', help: 'For Buy Out: the primary buyout bank when Buyouts is left blank' },
  { key: 'buyouts', header: 'Buyouts', example: '', help: 'Primary|Non-STL loan|RAKBANK|120000; Secondary|Credit card|FAB|15000 — role, kind (Credit card, Non-STL loan, Auto loan, Mortgage), bank, amount or card limit; entries separated by ;' },
  { key: 'secondary_buyout', header: 'Secondary buyout', example: '', allowed: ['Yes', 'No'], help: 'Fresh and Buy Out loans: whether there are secondary buyouts' },
  { key: 'loan_amount', header: 'Loan amount', example: '150000', help: 'Personal loan' },
  { key: 'interest_rate', header: 'Interest rate', example: '6.5', help: 'Personal loan, % a year' },
  { key: 'pl_tenure', header: 'PL tenure (months)', example: '48', help: 'Personal loan, up to 48' },
  { key: 'full_loan_amount', header: 'Full loan amount', example: '250000', help: 'Top Up' },
  { key: 'incremental_amount', header: 'Incremental amount', example: '100000', help: 'Top Up' },
  { key: 'amount', header: 'Auto loan amount', example: '', help: 'Auto loan, AED' },
  { key: 'auto_loan_type', header: 'Auto loan type', example: '', allowed: ['New', 'Used'], help: 'Auto loan' },
  { key: 'car_make', header: 'Car make', example: '', help: 'Auto loan' },
  { key: 'car_model', header: 'Car model', example: '', help: 'Auto loan' },
  { key: 'car_year', header: 'Car year', example: '', help: 'Auto loan' },
  { key: 'dealer_details', header: 'Dealer details', example: '', help: 'Auto loan, optional' },
  { key: 'al_lead_source', header: 'Auto loan lead source', example: '', help: 'Auto loan' },
  { key: 'al_interest_rate', header: 'Auto loan ROI', example: '', help: 'Auto loan, % a year' },
  { key: 'al_tenure', header: 'Auto loan tenure (months)', example: '', help: 'Auto loan, up to 60' },
  { key: 'city', header: 'City', example: 'Dubai' },
  { key: 'source', header: 'Lead source', example: '' },
  { key: 'sales_notes', header: 'Notes', example: '' },
];

export const CARD_IMPORT_COLUMNS = [
  { key: 'reference', header: 'Reference', required: true, example: 'CRM-000012', help: 'The CRM reference, App ID or Emirates ID of a completed credit card case' },
  { key: 'card_status', header: 'Card status', required: true, example: 'Active', allowed: Object.values(CARD_STATUS) },
  { key: 'activation_date', header: 'Status date', example: '15/06/2026', help: 'Date activated (Active) or inactive since (Inactive). DD/MM/YYYY or YYYY-MM-DD; blank means today' },
];

export const CARD_PRODUCT_IMPORT_COLUMNS = [
  { key: 'name', header: 'Card name', required: true, example: 'Skywards Signature Credit Card', help: 'As it should appear in the drop-down. Must be unique' },
  { key: 'family', header: 'Family', required: true, example: 'Skywards', help: 'Groups the cards in the drop-down' },
  { key: 'category', header: 'Card category', required: true, example: 'Signature', help: 'Shown on the form when the card is chosen, and saved on each file' },
  { key: 'points', header: 'Points', example: '', help: 'Optional. Points the card earns the sales person; a number' },
  { key: 'min_salary', header: 'Minimum salary (AED)', example: '5000', help: 'Monthly salary the customer needs for this card. A lower salary needs a product deviation or promotion, or team approval' },
];

export const TARGET_RULE_IMPORT_COLUMNS = [
  { key: 'product', header: 'Product', required: true, example: 'Personal Loan', allowed: Object.values(TARGET_PRODUCTS) },
  { key: 'salary_from', header: 'Salary from (AED)', required: true, example: '5000', help: 'Lowest monthly salary in the band, inclusive' },
  { key: 'salary_to', header: 'Salary to (AED)', required: true, example: '7999', help: 'Highest monthly salary in the band, inclusive' },
  { key: 'target', header: 'Target', required: true, example: '600000', help: 'Credit card and auto loan: points. Personal loan: AED to disburse. Accounts: number of accounts' },
];

export const AUTO_LOAN_POINTS_IMPORT_COLUMNS = [
  { key: 'amount_from', header: 'Loan amount from (AED)', required: true, example: '0', help: 'Lowest disbursed amount in the band, inclusive' },
  { key: 'amount_to', header: 'Loan amount to (AED)', required: true, example: '99999', help: 'Highest disbursed amount in the band, inclusive' },
  { key: 'points', header: 'Points', required: true, example: '1', help: 'Points an auto loan in this band earns' },
];

export const TARGET_IMPORT_COLUMNS = [
  { key: 'sales_code', header: 'Sales code', required: true, example: 'DXB-S-014' },
  { key: 'cycle', header: 'Cycle', required: true, example: 'Jun 2026', help: 'The month the cycle ends in: Jun 2026 is 21 May to 20 June' },
  { key: 'credit_card', header: 'Credit Card', example: '20', help: 'Number of temp ends. Blank leaves the target unchanged; 0 sets a zero target' },
  { key: 'personal_loan', header: 'Personal Loan disbursal (AED)', example: '1500000', help: 'AED amount to disburse. Blank leaves the target unchanged' },
  { key: 'auto_loan', header: 'Auto Loan disbursal (AED)', example: '400000', help: 'AED amount to disburse. Blank leaves the target unchanged' },
  { key: 'accounts', header: 'Accounts', example: '10', help: 'Number of accounts. Blank leaves the target unchanged' },
];

// ---------- CSV ----------

/** Parses CSV text (RFC 4180 quoting; comma, semicolon or tab separated) into rows of cells. */
export function parseCsv(text) {
  text = String(text ?? '').replace(/^﻿/, '');
  const firstLine = text.slice(0, text.search(/\r?\n|$/));
  const delimiter = [',', ';', '\t'].reduce((best, d) => (firstLine.split(d).length > firstLine.split(best).length ? d : best), ',');
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') quoted = false;
      else cell += c;
    } else if (c === '"' && cell === '') quoted = true;
    else if (c === delimiter) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(cell); rows.push(row); row = []; cell = '';
    } else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  return rows;
}

const norm = (s) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');

/** Maps each template column to its position in the uploaded header row. */
function mapHeader(header, columns) {
  const positions = {};
  const unknown = [];
  header.forEach((h, i) => {
    const n = norm(h);
    if (!n) return;
    const col = columns.find((c) => norm(c.header) === n || norm(c.key) === n);
    if (col) positions[col.key] ??= i;
    else unknown.push(h.trim());
  });
  const missing = columns.filter((c) => c.required && !(c.key in positions)).map((c) => c.header);
  return { positions, missing, unknown };
}

function readFile(csv, columns) {
  const rows = parseCsv(csv);
  const headerAt = rows.findIndex((r) => r.some((c) => c.trim()));
  if (headerAt < 0) throw new WorkflowError(400, 'The file is empty. Download the template and add one row per record');
  const header = rows[headerAt];
  const { positions, missing, unknown } = mapHeader(header, columns);
  if (missing.length) {
    throw new WorkflowError(400, `The file is missing these columns: ${missing.join(', ')}. Start from the downloaded template`);
  }
  const records = [];
  rows.slice(headerAt + 1).forEach((cells, i) => {
    if (!cells.some((c) => c.trim())) return;
    const values = Object.fromEntries(Object.entries(positions).map(([key, at]) => [key, (cells[at] ?? '').trim()]));
    records.push({ line: headerAt + i + 2, cells, values });
  });
  if (!records.length) throw new WorkflowError(400, 'The file has a header row but no data rows');
  if (records.length > MAX_ROWS) throw new WorkflowError(400, `Upload at most ${MAX_ROWS} rows at a time (this file has ${records.length})`);
  return { header, records, unknown };
}

// ---------- value matching ----------

/** Matches a cell against a { key: label } map by key or label, ignoring case, spaces and punctuation. */
function choose(value, options, label) {
  if (!value) return '';
  const n = norm(value);
  const hit = Object.entries(options).find(([k, l]) => norm(k) === n || norm(l) === n);
  if (!hit) throw new Error(`${label} "${value}" is not one of: ${Object.values(options).join(', ')}`);
  return hit[0];
}

const REGION_NAMES = { DXB: 'DXB', AUH: 'AUH' };
const REGION_ALIASES = { dubai: 'DXB', abudhabi: 'AUH' };
const BANK_BY_NORM = new Map(BANKS.flatMap((g) => g.banks).map((b) => [norm(b), b]));

/** "Primary|Credit card|FAB|15000; Secondary|Mortgage|ADCB|900000" → the list the form sends. */
function parseBuyoutsColumn(text) {
  const t = String(text ?? '').trim();
  if (!t) return [];
  return t.split(';').map((e) => e.trim()).filter(Boolean).map((e) => {
    const [role, kind, bank, amount] = e.split('|').map((x) => x.trim());
    return { role: choose(role, { primary: 'Primary', secondary: 'Secondary' }, 'Buyout role'), kind: choose(kind, BUYOUT_KINDS, 'Buyout kind'), bank: bank ? BANK_BY_NORM.get(norm(bank)) || bank : '', amount };
  });
}

/** A date as YYYY-MM-DD from YYYY-MM-DD, DD/MM/YYYY (UAE order) or an Excel date serial. */
export function parseDate(value, label = 'Sourcing date') {
  const v = String(value ?? '').trim();
  if (!v) return '';
  let m = v.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = v.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/);
  if (m) {
    if (Number(m[2]) > 12) throw new Error(`${label} "${v}" is not a valid date. Use day first: DD/MM/YYYY`);
    return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  }
  if (/^\d{5}$/.test(v)) return new Date(Date.UTC(1899, 11, 30) + Number(v) * 864e5).toISOString().slice(0, 10);
  throw new Error(`${label} "${v}" should be DD/MM/YYYY or YYYY-MM-DD`);
}

function noScientific(values) {
  for (const [key, v] of Object.entries(values)) {
    if (/^\d(\.\d+)?E\+\d+$/i.test(v)) {
      const col = CASE_IMPORT_COLUMNS.find((c) => c.key === key);
      throw new Error(`${col?.header || key} "${v}" was changed by Excel into scientific notation. Format the column as Text and enter the number again`);
    }
  }
}

/** Turns one case row into the same input the New case form sends. */
function caseInput(v) {
  noScientific(v);
  const regionKey = REGION_ALIASES[norm(v.region)] || v.region;
  const product = choose(v.product, { ...PRODUCTS, bundle: 'Bundle' }, 'Product');
  const input = {
    ...v,
    sourcing_date: parseDate(v.sourcing_date),
    region: choose(regionKey, REGION_NAMES, 'Region'),
    core_product: choose(v.core_product, CORE_PRODUCTS, 'Core product'),
    product,
    personal_loan_type: choose(v.personal_loan_type, PERSONAL_LOAN_TYPES, 'Personal loan type'),
    card_fee_type: choose({ firstyearfree: 'fyf', freeforlife: 'ffl', fullannualfee: 'full_fee' }[norm(v.card_fee_type)] || v.card_fee_type, { fyf: 'FYF', full_fee: 'Full fee', ffl: 'FFL' }, 'Card sourced type'),
    fpd: v.fpd ? parseDate(v.fpd, 'FPD') : '',
    pl_tenure: v.pl_tenure, amount: v.amount, auto_loan_type: v.auto_loan_type ? choose(v.auto_loan_type, AUTO_LOAN_TYPES, 'Auto loan type') : '', car_make: v.car_make, car_model: v.car_model, car_year: v.car_year, dealer_details: v.dealer_details, al_lead_source: v.al_lead_source, al_interest_rate: v.al_interest_rate, al_tenure: v.al_tenure,
    bundle_products: product === 'bundle'
      ? String(v.bundle_products || '').split(/[;,|/+]/).map((p) => p.trim()).filter(Boolean).map((p) => choose(p, PRODUCTS, 'Bundle product'))
      : '',
    credit_card: v.credit_card ? cardProduct(v.credit_card)?.name || v.credit_card : '',
    buyout_bank: v.buyout_bank ? BANK_BY_NORM.get(norm(v.buyout_bank)) || v.buyout_bank : '',
    pl_buyouts: parseBuyoutsColumn(v.buyouts), secondary_buyout: v.secondary_buyout,
  };
  if (!input.sourcing_date) throw new Error('Sourcing date is required');
  delete input.sales_code;
  return input;
}

// ---------- imports ----------

function run(db, dryRun, fn) {
  // A preview does every insert for real, then rolls back, so it reports exactly what an import would.
  if (!dryRun) return transaction(db, fn);
  db.exec('BEGIN');
  try {
    return fn();
  } finally {
    db.exec('ROLLBACK');
  }
}

function summarize(header, unknown, results, dryRun) {
  // Nothing from a preview was kept, so it has no case numbers or passwords to show.
  if (dryRun) for (const r of results) { delete r.id; delete r.ref; delete r.temp_password; }
  const failed = results.filter((r) => !r.ok);
  return {
    dry_run: dryRun,
    total: results.length,
    ok: results.length - failed.length,
    failed: failed.length,
    ignored_columns: unknown,
    header,
    rows: results,
  };
}

function rowResult(record, fn) {
  try {
    return { line: record.line, ok: true, ...fn() };
  } catch (err) {
    return { line: record.line, ok: false, error: err.message, cells: record.cells };
  }
}

/**
 * Replaces the credit card product list with a CSV file. Cards not in the file are retired: they
 * stay on the files that already have them but are no longer offered. Files that already have a
 * card keep the category saved on them.
 */
export function importCardProducts(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, CARD_PRODUCT_IMPORT_COLUMNS);
  const seen = new Map();
  const ts = new Date().toISOString();
  const results = run(db, dryRun, () => {
    const out = records.map((record) => rowResult(record, () => savepoint(db, () => {
      const v = record.values;
      const name = v.name.trim().replace(/\s+/g, ' ');
      if (!name) throw new Error('Card name is required');
      const key = norm(name);
      if (seen.has(key)) throw new Error(`${name} is already on line ${seen.get(key)}`);
      seen.set(key, record.line);
      const family = v.family.trim();
      const category = v.category.trim();
      if (!family) throw new Error('Family is required');
      if (!category) throw new Error('Card category is required');
      let points = null;
      if (String(v.points ?? '').trim() !== '') {
        points = Number(String(v.points).replace(/,/g, ''));
        if (!Number.isFinite(points) || points < 0) throw new Error(`Points must be a number: ${v.points}`);
      }
      let minSalary = null;
      if (String(v.min_salary ?? '').trim() !== '') {
        minSalary = Number(String(v.min_salary).replace(/,/g, '').replace(/^aed\s*/i, ''));
        if (!Number.isFinite(minSalary) || minSalary < 0) throw new Error(`Minimum salary must be an amount: ${v.min_salary}`);
      }
      db.prepare(`INSERT INTO card_products (name, family, category, points, min_salary, active, updated_by, updated_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
        ON CONFLICT (name) DO UPDATE SET family = excluded.family, category = excluded.category, points = excluded.points, min_salary = excluded.min_salary, active = 1, updated_by = excluded.updated_by, updated_at = excluded.updated_at`)
        .run(name, family, category, points, minSalary, user.id, ts);
      return { label: `${name} · ${category}`, email: `${family}${points != null ? ` · ${points} points` : ''}${minSalary != null ? ` · min salary AED ${minSalary.toLocaleString('en-US')}` : ''}` };
    })));
    // Only a file with at least one good row replaces the list; cards it leaves out are retired.
    if (out.some((r) => r.ok)) {
      const kept = out.filter((r) => r.ok).map((r) => r.label.split(' · ')[0]);
      db.prepare(`UPDATE card_products SET active = 0, updated_at = ? WHERE name NOT IN (${kept.map(() => '?').join(',')})`).run(ts, ...kept);
    }
    return out;
  });
  if (!dryRun) {
    loadCardProducts(db);
    backfillCardCategories(db);
  }
  return { ...summarize(header, unknown, results, dryRun), offered: cardProducts().length };
}

const money = (value, label) => {
  const n = Number(String(value ?? '').replace(/,/g, '').replace(/^aed\s*/i, '').trim());
  if (String(value ?? '').trim() === '' || !Number.isFinite(n) || n < 0) throw new Error(`${label} must be an amount, e.g. 5000`);
  return n;
};

/** Checks a set of bands do not overlap, in insertion order. */
function noOverlap(bands, label) {
  const sorted = [...bands].sort((a, b) => a.from - b.from);
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i].from <= sorted[i - 1].to) throw new Error(`${label} ${sorted[i].from.toLocaleString('en-US')}–${sorted[i].to.toLocaleString('en-US')} overlaps ${sorted[i - 1].from.toLocaleString('en-US')}–${sorted[i - 1].to.toLocaleString('en-US')} (line ${sorted[i - 1].line})`);
  }
}

/**
 * Replaces the salary-band target rules with a CSV file: one row per product and salary band. The
 * file replaces the rules for every product it mentions; other products keep theirs.
 */
export function importTargetRules(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, TARGET_RULE_IMPORT_COLUMNS);
  const ts = new Date().toISOString();
  const results = run(db, dryRun, () => {
    const parsed = records.map((record) => rowResult(record, () => {
      const v = record.values;
      const product = choose(v.product, TARGET_PRODUCTS, 'Product');
      const from = money(v.salary_from, 'Salary from');
      const to = money(v.salary_to, 'Salary to');
      if (to < from) throw new Error('Salary to is below salary from');
      const target = money(v.target, 'Target');
      return { product, from, to, target, line: record.line, label: `${TARGET_PRODUCTS[product]} · AED ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')}`, email: `${TARGET_UNITS[product] === 'aed' ? 'AED ' : ''}${target.toLocaleString('en-US')}${TARGET_UNITS[product] === 'points' ? ' points' : TARGET_UNITS[product] === 'count' ? ' accounts' : ''}` };
    }));
    for (const product of new Set(parsed.filter((r) => r.ok).map((r) => r.product))) {
      try {
        noOverlap(parsed.filter((r) => r.ok && r.product === product), `${TARGET_PRODUCTS[product]} band`);
      } catch (err) {
        for (const r of parsed) if (r.ok && r.product === product) { r.ok = false; r.error = err.message; }
      }
      if (parsed.some((r) => r.ok && r.product === product)) db.prepare('DELETE FROM target_rules WHERE product = ?').run(product);
    }
    for (const r of parsed.filter((r) => r.ok)) {
      db.prepare('INSERT INTO target_rules (product, salary_from, salary_to, target, set_by, set_at) VALUES (?, ?, ?, ?, ?, ?)').run(r.product, r.from, r.to, r.target, user.id, ts);
    }
    return parsed;
  });
  return summarize(header, unknown, results, dryRun);
}

/** Replaces the auto loan points bands with a CSV file. */
export function importAutoLoanPoints(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, AUTO_LOAN_POINTS_IMPORT_COLUMNS);
  const ts = new Date().toISOString();
  const results = run(db, dryRun, () => {
    const parsed = records.map((record) => rowResult(record, () => {
      const v = record.values;
      const from = money(v.amount_from, 'Loan amount from');
      const to = money(v.amount_to, 'Loan amount to');
      if (to < from) throw new Error('Loan amount to is below loan amount from');
      const points = money(v.points, 'Points');
      return { from, to, points, line: record.line, label: `AED ${from.toLocaleString('en-US')}–${to.toLocaleString('en-US')}`, email: `${points} points` };
    }));
    try {
      noOverlap(parsed.filter((r) => r.ok), 'Band');
    } catch (err) {
      for (const r of parsed) if (r.ok) { r.ok = false; r.error = err.message; }
    }
    if (parsed.some((r) => r.ok)) {
      db.exec('DELETE FROM auto_loan_points');
      for (const r of parsed.filter((r) => r.ok)) db.prepare('INSERT INTO auto_loan_points (amount_from, amount_to, points, set_by, set_at) VALUES (?, ?, ?, ?, ?)').run(r.from, r.to, r.points, user.id, ts);
    }
    return parsed;
  });
  return summarize(header, unknown, results, dryRun);
}

/** Adds users from a CSV file. Team leaders and sales managers in the file are added before sales staff. */
export function importUsers(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, USER_IMPORT_COLUMNS);
  const seen = new Set();
  return run(db, dryRun, () => {
    const roleOf = (r) => {
      try { return choose(r.values.role, ROLE_LABELS, 'Role'); } catch { return null; }
    };
    // Managers first so sales rows can name a team leader or sales manager added in the same file.
    const ordered = [...records].sort((a, b) => (roleOf(a) === 'sales') - (roleOf(b) === 'sales'));
    const results = new Map();
    for (const record of ordered) {
      results.set(record, rowResult(record, () => savepoint(db, () => {
        const v = record.values;
        const role = choose(v.role, ROLE_LABELS, 'Role');
        if (!ROLES.includes(role)) throw new Error('Role is required');
        const email = v.email.toLowerCase();
        if (seen.has(email)) throw new Error(`${email} appears more than once in this file`);
        seen.add(email);
        const manager = (field, wanted, label) => {
          if (!v[field]) throw new Error(`${label} email is required for sales staff`);
          const row = db.prepare('SELECT id, role, active FROM users WHERE email = ? COLLATE NOCASE').get(v[field]);
          if (!row) throw new Error(`No user with the email ${v[field]} (${label.toLowerCase()})`);
          if (row.role !== wanted || !row.active) throw new Error(`${v[field]} is not an active ${label.toLowerCase()}`);
          return row.id;
        };
        const generated = v.password ? null : tempPassword();
        const input = { ...v, role, password: v.password || generated };
        if (role === 'sales') {
          input.team_leader_id = manager('team_leader_email', 'team_leader', 'Team leader');
          input.sales_manager_id = manager('sales_manager_email', 'sales_manager', 'Sales manager');
          if (v.asm_email) input.asm_id = manager('asm_email', 'asm', 'Assistant sales manager');
        }
        const created = createUser(db, input, { requireMobile: true });
        return {
          id: created.id, label: `${created.name} · ${ROLE_LABELS[role]}`, email: created.email, hrms_code: created.hrms_code,
          ...(generated && { temp_password: generated }),
        };
      })));
    }
    return summarize(header, unknown, records.map((r) => results.get(r)), dryRun);
  });
}

/** Adds cases from a CSV file, each naming the sales person who sourced it by sales code. */
export function importCases(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, CASE_IMPORT_COLUMNS);
  const appIds = new Map();
  const results = run(db, dryRun, () => records.map((record) => rowResult(record, () => savepoint(db, () => {
    const v = record.values;
    if (!v.sales_code) throw new Error('Sales code is required');
    const staff = db.prepare("SELECT id FROM users WHERE sales_code = ? COLLATE NOCASE AND role = 'sales'").get(v.sales_code.trim());
    if (!staff) throw new Error(`No sales staff member has the sales code ${v.sales_code}`);
    const staffId = staff.id;
    const input = caseInput(v);
    if (input.app_id) {
      const key = input.app_id.toUpperCase();
      if (appIds.has(key)) throw new Error(`App ID ${input.app_id} is also on line ${appIds.get(key)} of this file`);
      const existing = db.prepare('SELECT id FROM cases WHERE app_id = ? COLLATE NOCASE').get(input.app_id);
      if (existing) throw new Error(`App ID ${input.app_id} is already on ${caseRef(existing.id)}`);
      appIds.set(key, record.line);
    }
    const id = insertCase(db, user, { ...input, sales_staff_id: staffId }, { bulk: true });
    const row = db.prepare('SELECT customer_name FROM cases WHERE id = ?').get(id);
    return { id, ref: caseRef(id), label: row.customer_name };
  }))));
  return summarize(header, unknown, results, dryRun);
}

/**
 * Maps card activation from a bank report. Each row names a completed credit card case by CRM
 * reference, App ID or Emirates ID; the case already belongs to its sales person.
 */
export function importCards(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, CARD_IMPORT_COLUMNS);
  const seen = new Map();
  const results = run(db, dryRun, () => records.map((record) => rowResult(record, () => savepoint(db, () => {
    const v = record.values;
    noScientific(v);
    const ref = v.reference.trim();
    if (!ref) throw new Error('Reference is required');
    const idMatch = ref.match(/^crm-?0*(\d+)$/i);
    const eid = ref.replace(/[\s-]/g, '');
    const matches = idMatch
      ? db.prepare('SELECT * FROM cases WHERE id = ?').all(Number(idMatch[1]))
      : /^784\d{12}$/.test(eid)
        ? db.prepare("SELECT * FROM cases WHERE REPLACE(eid_number, '-', '') = ?").all(eid)
        : db.prepare('SELECT * FROM cases WHERE app_id = ? COLLATE NOCASE').all(ref);
    const cards = matches.filter((c) => c.case_status === 'completed' && includesCard(c));
    if (!matches.length) throw new Error(`No case found for ${ref}`);
    if (!cards.length) throw new Error(`${ref} is not a completed credit card case (${matches.map((c) => caseRef(c.id)).join(', ')})`);
    if (cards.length > 1) throw new Error(`${ref} matches more than one card case: ${cards.map((c) => caseRef(c.id)).join(', ')}. Use the CRM reference`);
    const row = cards[0];
    if (seen.has(row.id)) throw new Error(`${caseRef(row.id)} is also on line ${seen.get(row.id)} of this file`);
    seen.set(row.id, record.line);
    const status = choose(v.card_status, CARD_STATUS, 'Card status');
    if (!status) throw new Error('Card status is required');
    setCardStatus(db, user, row, { card_status: status, activation_date: v.activation_date ? parseDate(v.activation_date, 'Status date') : null });
    return {
      id: row.id, ref: caseRef(row.id),
      label: `${row.customer_name} · ${CARD_STATUS[status]}`,
      email: row.sales_staff_name ? `Sales: ${row.sales_staff_name} (${row.sales_code})` : '',
    };
  }))));
  return summarize(header, unknown, results, dryRun);
}

/** Sets targets for many sales staff and cycles. Blank product cells leave that target as it is. */
export function importTargets(db, user, csv, { dryRun = false } = {}) {
  requireBulkRole(user);
  const { header, records, unknown } = readFile(csv, TARGET_IMPORT_COLUMNS);
  const seen = new Map();
  const results = run(db, dryRun, () => records.map((record) => rowResult(record, () => savepoint(db, () => {
    const v = record.values;
    if (!v.sales_code) throw new Error('Sales code is required');
    const staff = db.prepare("SELECT id, name FROM users WHERE sales_code = ? COLLATE NOCASE AND role = 'sales'").get(v.sales_code.trim());
    if (!staff) throw new Error(`No sales staff member has the sales code ${v.sales_code}`);
    if (!v.cycle) throw new Error('Cycle is required');
    const cycle = parseCycle(v.cycle);
    const key = `${staff.id}:${cycle}`;
    if (seen.has(key)) throw new Error(`${v.sales_code} already has a row for this cycle on line ${seen.get(key)}`);
    seen.set(key, record.line);
    const values = Object.fromEntries(Object.keys(PRODUCTS).filter((p) => String(v[p] ?? '').trim() !== '').map((p) => [p, v[p]]));
    if (!Object.keys(values).length) throw new Error('Enter a target for at least one product');
    setTargetsFor(db, user, staff.id, cycle, values);
    const [y, m] = cycle.split('-');
    return {
      label: `${staff.name} · ${new Date(Date.UTC(+y, +m - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' })} cycle`,
      email: Object.entries(values).map(([p, n]) => `${PRODUCTS[p]} ${TARGET_UNITS[p] === 'aed' ? 'AED ' : ''}${n}${TARGET_UNITS[p] === 'points' ? ' pts' : ''}`).join(' · '),
    };
  }))));
  return summarize(header, unknown, results, dryRun);
}
