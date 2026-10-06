// Sales cycles: the 21st of one month to the 20th of the next, named after the month they end in
// (21 May – 20 June is the June cycle, '2026-06'). Dates are UAE dates.
const UAE_OFFSET_MS = 4 * 3600e3;
const pad2 = (n) => String(n).padStart(2, '0');

/** Today's date in the UAE as YYYY-MM-DD. */
export const uaeDay = (ms = Date.now()) => new Date(ms + UAE_OFFSET_MS).toISOString().slice(0, 10);

/** The cycle ('YYYY-MM') a UAE date falls in. */
export function cycleOf(ymd) {
  let [y, m, d] = String(ymd).split('-').map(Number);
  if (d >= 21) [y, m] = m === 12 ? [y + 1, 1] : [y, m + 1];
  return `${y}-${pad2(m)}`;
}

export const isCycle = (c) => /^\d{4}-(0[1-9]|1[0-2])$/.test(String(c));

export function shiftCycle(cycle, by) {
  const [y, m] = cycle.split('-').map(Number);
  const i = y * 12 + (m - 1) + by;
  return `${Math.floor(i / 12)}-${pad2((i % 12) + 1)}`;
}

/** First and last UAE day of a cycle. */
export function cycleRange(cycle) {
  return { start: `${shiftCycle(cycle, -1)}-21`, end: `${cycle}-20` };
}

export function cycleLabel(cycle) {
  const [y, m] = cycle.split('-').map(Number);
  return `${new Date(Date.UTC(y, m - 1, 1)).toLocaleString('en-GB', { month: 'long', timeZone: 'UTC' })} ${y}`;
}

/** Accepts 2026-06, 06/2026, Jun 2026 or June 2026. */
export function parseCycle(value) {
  const v = String(value ?? '').trim();
  if (isCycle(v)) return v;
  let m = v.match(/^(\d{1,2})[/\-. ](\d{4})$/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 12) return `${m[2]}-${pad2(m[1])}`;
  m = v.match(/^([A-Za-z]{3,9})[\s\-/]+(\d{4})$/);
  if (m) {
    const names = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
    const word = m[1].toLowerCase();
    const month = names.findIndex((n) => n === word || n.slice(0, 3) === word || (n === 'september' && word === 'sept'));
    if (month >= 0) return `${m[2]}-${pad2(month + 1)}`;
  }
  throw new Error(`Cycle "${v}" should look like Jun 2026 or 2026-06`);
}

