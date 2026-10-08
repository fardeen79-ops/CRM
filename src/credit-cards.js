// The credit card product list: every card staff can choose when a case includes the Credit Card
// product, with its family, its category and (later) the points it earns the sales person.
//
// The built-in list below is the starting point. MIS or a business head uploads the bank's final
// product list from the Bulk upload page (Card products), which replaces it; cards left out of an
// upload are retired (kept on old files, no longer offered). Until that upload, the category is
// provisional: the card's tier taken from its name.

// Provisional minimum monthly salary (AED) by tier, until the bank's product list is uploaded.
const MIN_SALARY = { 'World Elite': 25000, Infinite: 15000, World: 12000, Signature: 10000, Platinum: 8000, Elevate: 8000, Titanium: 5000, Inspire: 5000, Standard: 5000 };
const tier = (name) => {
  const n = name.toLowerCase();
  if (n.includes('world elite')) return 'World Elite';
  if (n.includes('infinite')) return 'Infinite';
  if (n.includes('signature')) return 'Signature';
  if (/\bworld\b/.test(n)) return 'World';
  if (n.includes('platinum')) return 'Platinum';
  if (n.includes('titanium')) return 'Titanium';
  if (n.includes('elevate')) return 'Elevate';
  if (n.includes('inspire')) return 'Inspire';
  return 'Standard';
};

const FAMILIES = [
  ['Core (Platinum/Titanium/Infinite)', ['Infinite Credit Card', 'MasterCard Platinum Credit Card', 'Titanium Credit Card']],
  ['Darna', ['Darna Select Visa Credit Card', 'Darna Visa Infinite Credit Card', 'Darna Visa Signature Credit Card']],
  ['Duo Card', ['Diners Club Credit Card']],
  ['Etihad Guest', ['Etihad Guest Visa Elevate Credit Card', 'Etihad Guest Visa Inspire Credit Card']],
  ['LuLu', ['LuLu Platinum Mastercard Credit Card', 'LuLu Titanium Mastercard Credit Card']],
  ['Marriott Bonvoy', ['Marriott Bonvoy World Elite Mastercard Credit Card', 'Marriott Bonvoy World Mastercard Credit Card']],
  ['Priority Banking', ['PRIORITY BANKING VISA INFINITE CREDIT CARD']],
  ['Share', ['Share Visa Infinite Credit Card', 'Share Visa Platinum Credit Card', 'Share Visa Signature Credit Card']],
  ['Skywards', ['Skywards Infinite Credit Card', 'Skywards Signature Credit Card']],
  ['U By Emaar', ['U By Emaar Family Credit Card', 'U By Emaar Infinite Credit Card', 'U By Emaar Signature Credit Card']],
  ['Visa Flexi', ['Visa Flexi Credit card']],
  ['Voyager', ['Voyager World', 'Voyager World Elite']],
  ['Webshopper', ['Webshopper Credit Card']],
  ['dnata', ['dnata Platinum Credit Card', 'dnata World Mastercard Credit Card']],
  ['noon', ['noon One Visa Credit Card']],
];

/** The built-in list: { name, family, category, points }. */
export const DEFAULT_CARD_PRODUCTS = FAMILIES.flatMap(([family, names]) => names.map((name) => ({ name, family, category: tier(name), points: null, min_salary: MIN_SALARY[tier(name)] ?? null })));

let products = DEFAULT_CARD_PRODUCTS;
let source = 'built_in';

/** Uses the uploaded product list when there is one, else the built-in list. Call on start and after an upload. */
export function loadCardProducts(db) {
  const rows = db.prepare('SELECT name, family, category, points, min_salary FROM card_products WHERE active = 1 ORDER BY family, name').all();
  products = rows.length ? rows : DEFAULT_CARD_PRODUCTS;
  source = rows.length ? 'uploaded' : 'built_in';
  return products;
}

export const cardProducts = () => products;
export const cardProductSource = () => source;
/** One card by name (exact, then ignoring case and spacing); null when not offered. */
export function cardProduct(name) {
  const key = String(name ?? '');
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return products.find((p) => p.name === key) || products.find((p) => norm(p.name) === norm(key)) || null;
}
export const cardNames = () => new Set(products.map((p) => p.name));

/** The list grouped by family for the form's drop-down. */
export function cardFamilies() {
  const map = new Map();
  for (const p of products) {
    if (!map.has(p.family)) map.set(p.family, { family: p.family, cards: [] });
    map.get(p.family).cards.push({ name: p.name, category: p.category, points: p.points, min_salary: p.min_salary });
  }
  return [...map.values()];
}

/** Cards the customer's salary qualifies for that need more salary than the chosen one: the upgrade prompt. */
export function higherCards(salary, chosen) {
  const base = chosen?.min_salary ?? 0;
  if (salary == null) return [];
  return products.filter((p) => p.min_salary != null && p.min_salary > base && p.min_salary <= salary).sort((a, b) => b.min_salary - a.min_salary);
}

/** Fills the category and points on files that have a card but no category yet (older files). */
export function backfillCardCategories(db) {
  for (const row of db.prepare('SELECT id, credit_card FROM cases WHERE credit_card IS NOT NULL AND card_category IS NULL').all()) {
    const p = cardProduct(row.credit_card);
    if (p) db.prepare('UPDATE cases SET card_category = ?, card_points = ? WHERE id = ?').run(p.category, p.points, row.id);
  }
}
