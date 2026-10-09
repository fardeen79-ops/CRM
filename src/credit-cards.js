// The credit card product list: every card staff can choose when a case includes the Credit Card
// product, with its family, its category and (later) the points it earns the sales person.
//
// The built-in list below is the bank's product list as supplied. MIS or a business head can upload
// a newer list from the Bulk upload page (Card products), which replaces it; cards left out of an
// upload are retired (kept on old files, no longer offered).

// The bank's card product list (Derby Group's "Card family category" sheet): every card with its
// family, category (Mass, Premium or Super Premium), the monthly salary it needs and the points it
// earns the sales person. Names the sheet gives in capitals are shown in title case. Lookups ignore case.
export const DEFAULT_CARD_PRODUCTS = [
  // Darna
  { name: "Darna Select Visa Credit Card", family: "Darna", category: "Mass", points: 650, min_salary: 5000 },
  { name: "Darna Visa Infinite Credit Card", family: "Darna", category: "Super Premium", points: 1050, min_salary: 30000 },
  { name: "Darna Visa Signature Credit Card", family: "Darna", category: "Premium", points: 800, min_salary: 12000 },
  // Diners
  { name: "Diners Bundle Product", family: "Diners", category: "Premium", points: 800, min_salary: 12000 },
  { name: "Diners Club Credit Card", family: "Diners", category: "Premium", points: 800, min_salary: 12000 },
  { name: "Diners-Bundle", family: "Diners", category: "Premium", points: 800, min_salary: 12000 },
  // dnata
  { name: "dnata Platinum", family: "dnata", category: "Mass", points: 650, min_salary: 5000 },
  { name: "dnata World", family: "dnata", category: "Premium", points: 800, min_salary: 20000 },
  // Etihad
  { name: "Etihad Guest Visa Elevate", family: "Etihad", category: "Super Premium", points: 1050, min_salary: 30000 },
  { name: "Etihad Guest Visa Inspire", family: "Etihad", category: "Premium", points: 800, min_salary: 12000 },
  // Go4it
  { name: "Go4it - Gold", family: "Go4it", category: "Mass", points: 650, min_salary: 5000 },
  { name: "Go4it - Platinum", family: "Go4it", category: "Premium", points: 800, min_salary: 12000 },
  // Infinite
  { name: "Infinite Credit Card", family: "Infinite", category: "Super Premium", points: 1050, min_salary: 30000 },
  // LuLu
  { name: "LuLu Platinum Mastercard", family: "LuLu", category: "Premium", points: 800, min_salary: 12000 },
  { name: "LuLu Titanium Mastercard", family: "LuLu", category: "Mass", points: 650, min_salary: 5000 },
  // Manchester United
  { name: "Manchester United", family: "Manchester United", category: "Mass", points: 650, min_salary: 5000 },
  // Marriott Bonvoy
  { name: "Marriott Bonvoy World Elite Mastercard", family: "Marriott Bonvoy", category: "Super Premium", points: 1050, min_salary: 25000 },
  { name: "Marriott Bonvoy World Mastercard", family: "Marriott Bonvoy", category: "Super Premium", points: 1050, min_salary: 25000 },
  // Mastercard
  { name: "Mastercard Platinum", family: "Mastercard", category: "Premium", points: 800, min_salary: 12000 },
  // noon
  { name: "noon One Visa Credit Card", family: "noon", category: "Mass", points: 450, min_salary: 5000 },
  // Priority Banking
  { name: "Priority Banking Visa Infinite Credit Card", family: "Priority Banking", category: "Super Premium", points: 1050, min_salary: 30000 },
  // Share
  { name: "Share Visa Infinite Credit Card", family: "Share", category: "Super Premium", points: 1050, min_salary: 30000 },
  { name: "Share Visa Platinum Credit Card", family: "Share", category: "Mass", points: 650, min_salary: 5000 },
  { name: "Share Visa Signature Credit Card", family: "Share", category: "Premium", points: 800, min_salary: 12000 },
  // Skywards
  { name: "Skywards Infinite Credit Card", family: "Skywards", category: "Super Premium", points: 1050, min_salary: 30000 },
  { name: "Skywards Signature Credit Card", family: "Skywards", category: "Premium", points: 800, min_salary: 12000 },
  // Titanium
  { name: "Titanium Credit Card", family: "Titanium", category: "Mass", points: 650, min_salary: 5000 },
  // U By Emaar
  { name: "U By Emaar Family Credit Card", family: "U By Emaar", category: "Mass", points: 650, min_salary: 5000 },
  { name: "U By Emaar Infinite Credit Card", family: "U By Emaar", category: "Super Premium", points: 1050, min_salary: 30000 },
  { name: "U By Emaar Signature Credit Card", family: "U By Emaar", category: "Premium", points: 800, min_salary: 12000 },
  // Visa
  { name: "Visa Flexi", family: "Visa", category: "Premium", points: 800, min_salary: 12000 },
  { name: "Visa Infinite", family: "Visa", category: "Super Premium", points: 1050, min_salary: 30000 },
  // Voyager
  { name: "Voyager World", family: "Voyager", category: "Premium", points: 800, min_salary: 12000 },
  { name: "Voyager World Elite", family: "Voyager", category: "Super Premium", points: 1050, min_salary: 30000 },
];

/** Card categories from lowest to highest, as the bank ranks them. */
export const CARD_CATEGORY_ORDER = ['Mass', 'Premium', 'Super Premium'];

let products = DEFAULT_CARD_PRODUCTS;
let source = 'built_in';

/** Uses the uploaded product list when there is one, else the built-in list. Call on start and after an upload. */
export function loadCardProducts(db) {
  const rows = db.prepare('SELECT name, family, category, points, min_salary, page_url FROM card_products WHERE active = 1 ORDER BY family, name').all();
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
    if (p) db.prepare('UPDATE cases SET card_category = ?, card_points = ?, card_min_salary = ? WHERE id = ?').run(p.category, p.points, p.min_salary, row.id);
  }
  // Older files: whether the salary qualified for a higher card than the one sold.
  for (const row of db.prepare('SELECT id, credit_card, salary FROM cases WHERE credit_card IS NOT NULL AND card_higher_options IS NULL').all()) {
    const higher = row.salary == null ? [] : higherCards(row.salary, cardProduct(row.credit_card));
    db.prepare('UPDATE cases SET card_higher_options = ?, card_eligible_category = ? WHERE id = ?').run(higher.length, higher[0]?.category ?? null, row.id);
  }
}
