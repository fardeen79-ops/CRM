// User profiles. Sales staff carry a sales code plus their team leader and sales manager,
// which pre-fill the "Sales staff" section of every file they source.

export const USER_COLUMNS = `u.id, u.name, u.email, u.role, u.active, u.created_at, u.region, u.salary, u.hrms_code,
  u.mobile_number, u.whatsapp_number, u.sales_code, u.team_leader_id, u.sales_manager_id, u.asm_id,
  tl.name AS team_leader_name, sm.name AS sales_manager_name, asm.name AS asm_name`;
export const USER_FROM = `users u
  LEFT JOIN users tl ON tl.id = u.team_leader_id
  LEFT JOIN users sm ON sm.id = u.sales_manager_id
  LEFT JOIN users asm ON asm.id = u.asm_id`;

// Where a user works. Sales staff's files default to their region; processors with a region
// see only that region's files. Blank means no restriction.
export const USER_REGIONS = { DXB: 'DXB (Dubai)', AUH: 'AUH (Abu Dhabi)' };
export function regionOf(value) {
  const region = String(value ?? '').trim().toUpperCase();
  if (!region) return null;
  if (!USER_REGIONS[region]) throw new Error('Region must be DXB or AUH');
  return region;
}

export function findUser(db, id) {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM ${USER_FROM} WHERE u.id = ?`).get(id) || null;
}

export function listUsers(db, { role } = {}) {
  const where = role ? 'WHERE u.role = ? AND u.active = 1' : '';
  return db.prepare(`SELECT ${USER_COLUMNS} FROM ${USER_FROM} ${where} ORDER BY u.role, u.name`).all(...(role ? [role] : []));
}

/**
 * Validates the sales code, team leader and sales manager for a sales user. `current` is the
 * existing user when editing, so only the fields being changed need to be sent.
 */
export function salesProfile(db, input, current = null) {
  const pick = (f) => (f in input ? input[f] : current?.[f]);
  const code = String(pick('sales_code') ?? '').trim().toUpperCase();
  if (!code) throw new Error('Sales code is required for sales staff');
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new Error('Sales code should be 2–20 letters, digits or dashes');
  const clash = db.prepare('SELECT id FROM users WHERE sales_code = ? AND id != ?').get(code, current?.id ?? 0);
  if (clash) throw new Error(`Sales code ${code} is already used by another user`);

  const manager = (field, role, label, { optional = false } = {}) => {
    const id = Number(pick(field));
    if (!id && optional) return null;
    const row = id ? db.prepare('SELECT id FROM users WHERE id = ? AND role = ? AND active = 1').get(id, role) : null;
    if (!row) throw new Error(`Choose the ${label} for this sales staff member`);
    return id;
  };
  return {
    sales_code: code,
    team_leader_id: manager('team_leader_id', 'team_leader', 'team leader'),
    sales_manager_id: manager('sales_manager_id', 'sales_manager', 'sales manager'),
    // Optional: an assistant sales manager between the team leader and the sales manager.
    asm_id: manager('asm_id', 'asm', 'assistant sales manager', { optional: true }),
    salary: salaryOf(pick('salary')),
  };
}

// Excel turns long numbers into "9.71501E+11" when a column is not formatted as text, and the
// digits are lost for good, so say so instead of saving a wrong number.
function digitsOf(value, label) {
  const text = String(value ?? '').trim();
  if (/\d[.,]?\d*E\+\d+/i.test(text)) {
    throw new Error(`${label} looks like Excel scientific notation (${text}). Format the column as Text and type the number again`);
  }
  return { text, digits: text.replace(/\D/g, '') };
}

/** UAE local mobile number, stored as 05XXXXXXXX. Accepts 050…, +971 50…, 00971 50… or 50… */
export function localMobile(value, label = 'Local mobile number') {
  let { digits } = digitsOf(value, label);
  if (!digits) return null;
  if (digits.startsWith('00971')) digits = digits.slice(5);
  else if (digits.startsWith('971')) digits = digits.slice(3);
  if (digits.length === 9 && digits.startsWith('5')) digits = `0${digits}`;
  if (!/^05\d{8}$/.test(digits)) throw new Error(`${label} must be a UAE mobile number like 050 123 4567`);
  return digits;
}

/** WhatsApp number in international format (+countrycode…). A UAE local number gets +971. */
export function whatsappNumber(value, label = 'WhatsApp number') {
  const { text, digits: d } = digitsOf(value, label);
  if (!d) return null;
  let digits = d;
  if (text.startsWith('00')) digits = digits.slice(2);
  else if (/^0?5\d{8}$/.test(digits) && !text.startsWith('+')) digits = `971${digits.replace(/^0/, '')}`;
  if (digits.length < 8 || digits.length > 15 || digits.startsWith('0')) {
    throw new Error(`${label} must include the country code, e.g. +971 50 123 4567`);
  }
  return `+${digits}`;
}

/** A sales person's monthly salary in AED (blank allowed until HR provides it); sets their targets. */
export function salaryOf(value) {
  const text = String(value ?? '').replace(/,/g, '').replace(/^aed\s*/i, '').trim();
  if (text === '') return null;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0 || n > 1e7) throw new Error('Monthly salary must be an AED amount, e.g. 5000');
  return Math.round(n);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Name, email, local mobile and WhatsApp for a user. `current` is the existing user when editing,
 * so only the fields being changed need to be sent.
 */
/** The HRMS staff code: letters, digits and dashes, stored upper-case. It is the username at sign-in. */
export function hrmsCodeOf(value) {
  const code = String(value ?? '').trim().toUpperCase();
  if (!code) return null;
  if (!/^[A-Z0-9][A-Z0-9-]{1,19}$/.test(code)) throw new Error('HRMS code should be 2–20 letters, digits or dashes');
  if (/@/.test(code)) throw new Error('HRMS code cannot be an email address');
  return code;
}

/** `requireMobile` also requires the HRMS code: both are needed for users added from the Users page or a bulk upload. */
export function contactDetails(input, { current = null, requireMobile = false } = {}) {
  const out = {};
  if (!current || 'hrms_code' in input) {
    out.hrms_code = hrmsCodeOf(input.hrms_code);
    if (!out.hrms_code && requireMobile) throw new Error('HRMS code is required');
  }
  if (!current || 'name' in input) {
    out.name = String(input.name ?? '').trim();
    if (!out.name) throw new Error('Full name is required');
  }
  if (!current || 'email' in input) {
    out.email = String(input.email ?? '').trim().toLowerCase();
    if (!out.email) throw new Error('Email address is required');
    if (!EMAIL_RE.test(out.email)) throw new Error(`Invalid email address: ${out.email}`);
  }
  if (!current || 'mobile_number' in input) {
    out.mobile_number = localMobile(input.mobile_number);
    if (!out.mobile_number && requireMobile) throw new Error('Local mobile number is required');
  }
  if (!current || 'whatsapp_number' in input) out.whatsapp_number = whatsappNumber(input.whatsapp_number);
  return out;
}
