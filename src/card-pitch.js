// Card pitch: when a sales person picks a higher card to offer, the card's features are read from its
// page on the Emirates NBD website at that moment. The last good reading of each card is kept, so the
// pitch still has features when the site is slow, unreachable or changes its layout.
import { cardProduct } from './credit-cards.js';

export const CARD_SITE = 'https://www.emiratesnbd.com/en/cards/credit-cards/';
const PITCH_TIMEOUT_MS = 6000;
const PITCH_MAX_FEATURES = 8;

/** Only pages on the bank's own site are read, whatever a card list upload says. */
export function isBankPage(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && (u.hostname === 'emiratesnbd.com' || u.hostname.endsWith('.emiratesnbd.com'));
  } catch { return false; }
}

/** The card's page: the one given in the card list, else the site's usual address for the card's name. */
export function cardPageUrl(card) {
  if (card?.page_url && isBankPage(card.page_url)) return card.page_url;
  const slug = String(card?.name ?? '').toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return CARD_SITE + (/credit-card$/.test(slug) ? slug : `${slug}-credit-card`);
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
function pitchText(fragment) {
  return fragment
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&([a-z]+);/gi, (m, n) => ENTITIES[n.toLowerCase()] ?? m)
    .replace(/\s+/g, ' ')
    .trim();
}
const metaContent = (html, key) => {
  const tag = html.match(new RegExp(`<meta[^>]+(?:name|property)=["']${key}["'][^>]*>`, 'i'))?.[0];
  return tag ? pitchText(tag.match(/content=["']([^"']*)["']/i)?.[1] ?? '') : '';
};
// Lines that are site furniture rather than card features.
const NOT_A_FEATURE = /cookie|javascript|log ?in|sign ?in|download (the )?app|privacy|terms (and|&) conditions apply$|copyright|©|all rights reserved|follow us|contact us|apply now|^learn more|^read more|^find out more|^home$/i;

/**
 * The card's headline and features from its page: the page's description, then the bullet points and
 * short paragraphs in the main content that read like benefits (with a number, or a benefit word).
 */
export function parseCardPage(html) {
  const body = String(html || '');
  const title = pitchText(body.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i)?.[1] ?? '') || pitchText(body.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? '');
  const headline = metaContent(body, 'description') || metaContent(body, 'og:description');
  const main = (body.match(/<main[\s\S]*?<\/main>/i)?.[0] ?? body)
    .replace(/<(script|style|noscript|svg|nav|header|footer|form)[\s\S]*?<\/\1>/gi, ' ');
  const seen = new Set();
  const features = [];
  const benefit = /\d|%|aed|cashback|cash back|points|miles|lounge|free|complimentary|discount|reward|insurance|access|offer|bonus|waiver|interest|instal|valet|golf|cinema|travel|dining/i;
  for (const [, inner] of main.matchAll(/<(?:li|p|h3|h4)[^>]*>([\s\S]*?)<\/(?:li|p|h3|h4)>/gi)) {
    const line = pitchText(inner);
    const key = line.toLowerCase();
    if (line.length < 18 || line.length > 220 || seen.has(key) || NOT_A_FEATURE.test(line) || !benefit.test(line)) continue;
    seen.add(key);
    features.push(line);
    if (features.length >= PITCH_MAX_FEATURES) break;
  }
  return { title, headline, features };
}

/** Reads the page with a time limit. Resolves to the HTML, or throws with a reason staff can read. */
async function readCardPage(url, fetcher) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), PITCH_TIMEOUT_MS);
  try {
    const res = await fetcher(url, { signal: ctrl.signal, redirect: 'follow', headers: { 'user-agent': 'Mozilla/5.0 (Sourcing CRM card pitch)', accept: 'text/html' } });
    if (res.url && !isBankPage(res.url)) throw new Error('the page moved off the bank\'s site');
    if (res.status === 404) throw new Error('no page at this address');
    if (!res.ok) throw new Error(`the site answered ${res.status}`);
    return await res.text();
  } catch (err) {
    throw new Error(err.name === 'AbortError' ? 'the site took too long to answer' : !err.message || err.message === 'fetch failed' ? 'the site could not be reached' : err.message);
  } finally {
    clearTimeout(timer);
  }
}

/** The last good reading of a card's page, or null. */
export function savedPitch(db, name) {
  const row = db.prepare('SELECT card_name, url, title, headline, features, fetched_at FROM card_pitch_cache WHERE card_name = ? COLLATE NOCASE').get(name);
  return row ? { ...row, features: JSON.parse(row.features) } : null;
}

/** Pitch details for a card from saved readings only (no website), as the in-browser demo serves it. */
export function savedCardPitch(db, name, { reason = 'the website is not read here' } = {}) {
  const card = cardProduct(name);
  if (!card) return null;
  const url = cardPageUrl(card);
  const saved = savedPitch(db, card.name);
  return {
    card: { name: card.name, family: card.family, category: card.category, min_salary: card.min_salary },
    url: saved?.url || url,
    title: saved?.title || card.name,
    headline: saved?.headline || '',
    features: saved?.features || [],
    source: saved ? 'saved' : 'none',
    fetched_at: saved?.fetched_at || null,
    problem: reason,
  };
}

/**
 * Pitch details for a card: read live from the bank's page each time, falling back to the last good
 * reading. `source` says which: live, saved (with `problem`) or none (with `problem`).
 */
export async function cardPitch(db, name, { fetcher = globalThis.fetch, now = () => new Date().toISOString() } = {}) {
  const card = cardProduct(name);
  if (!card) return null;
  const url = cardPageUrl(card);
  let problem;
  try {
    const page = parseCardPage(await readCardPage(url, fetcher));
    if (page.features.length < 2 && !page.headline) throw new Error('the page had no features the CRM could read');
    const fetched_at = now();
    db.prepare(`INSERT INTO card_pitch_cache (card_name, url, title, headline, features, fetched_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT (card_name) DO UPDATE SET url = excluded.url, title = excluded.title, headline = excluded.headline, features = excluded.features, fetched_at = excluded.fetched_at`)
      .run(card.name, url, page.title || card.name, page.headline, JSON.stringify(page.features), fetched_at);
    return { card: { name: card.name, family: card.family, category: card.category, min_salary: card.min_salary }, url, title: page.title || card.name, headline: page.headline, features: page.features, source: 'live', fetched_at, problem: null };
  } catch (err) {
    problem = err.message;
  }
  return savedCardPitch(db, card.name, { reason: problem });
}
