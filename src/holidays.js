// Public holidays: days off that, like Sundays, do not count towards the verification TAT. MIS and
// business heads keep the list (Eid dates move each year, so there is no built-in calendar).
export const HOLIDAY_EDITORS = ['mis', 'business_head'];
let holidayDays = new Set();

class HolidayError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Reads the list into memory; call on start and after every change. */
export function loadHolidays(db) {
  holidayDays = new Set(db.prepare('SELECT day FROM holidays').all().map((h) => h.day));
}
export const isHoliday = (day) => holidayDays.has(day);
export const canEditHolidays = (user) => HOLIDAY_EDITORS.includes(user?.role);

export function listHolidays(db) {
  return db.prepare('SELECT h.day, h.name, h.created_at, u.name AS added_by FROM holidays h LEFT JOIN users u ON u.id = h.created_by ORDER BY h.day').all();
}

/** Adds one day, or a run of days (`day` to `until`) under one name, e.g. Eid al-Adha. */
export function addHoliday(db, user, { day, until, name } = {}) {
  if (!canEditHolidays(user)) throw new HolidayError(403, 'Only MIS and business heads can change the holiday list');
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (!iso.test(String(day || ''))) throw new HolidayError(400, 'Choose the holiday date');
  const last = until ? String(until) : day;
  if (!iso.test(last) || last < day) throw new HolidayError(400, 'The last day must be on or after the first');
  const label = String(name || '').trim().slice(0, 100);
  if (!label) throw new HolidayError(400, 'Name the holiday, e.g. Eid al-Fitr');
  const days = [];
  for (let d = new Date(`${day}T00:00:00Z`); d.toISOString().slice(0, 10) <= last; d.setUTCDate(d.getUTCDate() + 1)) days.push(d.toISOString().slice(0, 10));
  if (days.length > 14) throw new HolidayError(400, 'A holiday can run for at most 14 days');
  const ts = new Date().toISOString();
  const put = db.prepare('INSERT INTO holidays (day, name, created_by, created_at) VALUES (?, ?, ?, ?) ON CONFLICT (day) DO UPDATE SET name = excluded.name');
  for (const d of days) put.run(d, label, user.id, ts);
  loadHolidays(db);
  return { added: days.length };
}

export function removeHoliday(db, user, day) {
  if (!canEditHolidays(user)) throw new HolidayError(403, 'Only MIS and business heads can change the holiday list');
  db.prepare('DELETE FROM holidays WHERE day = ?').run(String(day));
  loadHolidays(db);
  return { ok: true };
}
