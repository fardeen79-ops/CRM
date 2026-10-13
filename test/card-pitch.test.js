// Card pitch: features read from the card's page on the bank's website, with the last good reading kept.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openDb } from '../src/db.js';
import { loadCardProducts } from '../src/credit-cards.js';
import { cardPitch, cardPageUrl, isBankPage, parseCardPage } from '../src/card-pitch.js';

const PAGE = `<html><head><title>Darna Visa Infinite | Emirates NBD</title>
  <meta name="description" content="Earn up to 10% back in Darna Points across Aldar.">
  <script>var x = '<li>Earn 99% cashback</li>';</script></head>
  <body><nav><ul><li>Personal loans with 0% interest</li></ul></nav>
  <main><h1>Darna Visa Infinite Credit Card</h1>
    <ul><li>Earn up to 10% back as Darna Points on Aldar spend</li><li>Up to 1.5% back on all other spend</li>
    <li>Apply now</li><li>15,000 Darna Points welcome bonus</li><li>Up to 1.5% back on all other spend</li></ul>
    <p>Accept cookies to continue browsing this site</p>
    <p>Complimentary Darna Platinum membership &amp; dedicated parking</p></main>
  <footer><p>Copyright 2026 Emirates NBD with 100% rights</p></footer></body></html>`;

const page = (body, { status = 200, url } = {}) => async (u) => ({ ok: status < 400, status, url: url ?? u, text: async () => body });

test('reads the headline and benefit lines from the main content only', () => {
  const p = parseCardPage(PAGE);
  assert.equal(p.title, 'Darna Visa Infinite Credit Card');
  assert.equal(p.headline, 'Earn up to 10% back in Darna Points across Aldar.');
  assert.deepEqual(p.features, [
    'Earn up to 10% back as Darna Points on Aldar spend',
    'Up to 1.5% back on all other spend',
    '15,000 Darna Points welcome bonus',
    'Complimentary Darna Platinum membership & dedicated parking',
  ]);
});

test("the card's page: its usual address, or one on the bank's site from the card list", () => {
  assert.equal(cardPageUrl({ name: 'Darna Visa Infinite Credit Card' }), 'https://www.emiratesnbd.com/en/cards/credit-cards/darna-visa-infinite-credit-card');
  assert.equal(cardPageUrl({ name: 'Go4it - Gold' }), 'https://www.emiratesnbd.com/en/cards/credit-cards/go4it-gold-credit-card');
  assert.equal(cardPageUrl({ name: 'X', page_url: 'https://www.emiratesnbd.com/en/x' }), 'https://www.emiratesnbd.com/en/x');
  assert.equal(cardPageUrl({ name: 'X', page_url: 'https://evil.example/x' }), 'https://www.emiratesnbd.com/en/cards/credit-cards/x-credit-card');
  assert.ok(isBankPage('https://emiratesnbd.com/a'));
  assert.ok(!isBankPage('http://www.emiratesnbd.com/a'));
  assert.ok(!isBankPage('https://emiratesnbd.com.evil.example/a'));
});

test('live reading is saved, and the saved copy is used when the site fails', async () => {
  const db = openDb(':memory:');
  loadCardProducts(db);
  const name = 'Darna Visa Infinite Credit Card';

  const none = await cardPitch(db, name, { fetcher: async () => { throw new Error('getaddrinfo ENOTFOUND'); } });
  assert.equal(none.source, 'none');
  assert.equal(none.features.length, 0);
  assert.match(none.problem, /ENOTFOUND/);

  const live = await cardPitch(db, name, { fetcher: page(PAGE), now: () => '2026-10-09T10:00:00.000Z' });
  assert.equal(live.source, 'live');
  assert.equal(live.card.category, 'Super Premium');
  assert.equal(live.features.length, 4);

  const down = await cardPitch(db, name, { fetcher: page('', { status: 503 }) });
  assert.equal(down.source, 'saved');
  assert.equal(down.fetched_at, '2026-10-09T10:00:00.000Z');
  assert.deepEqual(down.features, live.features);
  assert.match(down.problem, /503/);

  // A page with nothing readable does not overwrite the good copy.
  const empty = await cardPitch(db, name, { fetcher: page('<main><p>Hello</p></main>') });
  assert.equal(empty.source, 'saved');
  assert.equal(empty.features.length, 4);

  // A redirect off the bank's site is not read.
  const moved = await cardPitch(db, name, { fetcher: page(PAGE, { url: 'https://elsewhere.example/' }) });
  assert.equal(moved.source, 'saved');

  assert.equal(await cardPitch(db, 'No Such Card', { fetcher: page(PAGE) }), null);
});

test('a pitch loaded with the card list is shown as it is; the website is not asked for that card', async () => {
  const { saveUploadedPitch } = await import('../src/card-pitch.js');
  const db = openDb(':memory:');
  loadCardProducts(db);
  const name = 'Darna Visa Infinite Credit Card';
  saveUploadedPitch(db, name, { headline: 'Up to 10% back across Aldar', features: ['10% back as Darna Points on Aldar spend', ' 1.5% back on everything else ', ''] });
  let calls = 0;
  const p = await cardPitch(db, name, { fetcher: async () => { calls++; return { ok: false, status: 403, text: async () => '' }; } });
  assert.equal(calls, 0);
  assert.equal(p.source, 'uploaded');
  assert.equal(p.problem, null);
  assert.deepEqual(p.features, ['10% back as Darna Points on Aldar spend', '1.5% back on everything else']);
  assert.equal(p.headline, 'Up to 10% back across Aldar');
  // Blank headline and features in a later upload remove it, and the website is read again.
  saveUploadedPitch(db, name, { headline: '', features: [''] });
  const again = await cardPitch(db, name, { fetcher: page('', { status: 403 }) });
  assert.equal(again.source, 'none');
  assert.match(again.problem, /bot protection/);
});

test('the AI writes the pitch for the customer from the page it reads, keeps the reading, and falls back when it cannot', async () => {
  const { aiCardPitch } = await import('../src/card-pitch.js');
  const db = openDb(':memory:');
  loadCardProducts(db);
  const name = 'Darna Visa Infinite Credit Card';
  const seen = [];
  const writer = async (ctx) => { seen.push(ctx); return { read_page: true, headline: 'Up to 10% back across Aldar', features: ['10% back on Aldar spend', 'Lounge access'], script: ['Mr Khan, your salary of AED 35,000 qualifies you for the Darna Visa Infinite.', 'Shall I put the application in for it?'], caution: 'Check the annual fee.' }; };
  const p = await aiCardPitch(db, name, { customer: 'Mr Khan', income: 35000, income_word: 'salary', current: { name: 'Darna Select Visa Credit Card', category: 'Mass' } }, writer, { now: () => new Date('2026-10-13T09:00:00Z') });
  assert.equal(p.source, 'ai'); assert.equal(p.read_page, true);
  assert.deepEqual(p.features, ['10% back on Aldar spend', 'Lounge access']);
  assert.equal(p.script.length, 2); assert.equal(p.caution, 'Check the annual fee.');
  assert.equal(seen[0].card.url, 'https://www.emiratesnbd.com/en/cards/credit-cards/darna-visa-infinite-credit-card');
  assert.equal(seen[0].customer, 'Mr Khan'); assert.deepEqual(seen[0].features, []);
  // The reading is kept for the plain pitch too, and handed to the AI next time.
  const saved = (await cardPitch(db, name, { fetcher: page('', { status: 403 }) }));
  assert.equal(saved.source, 'saved'); assert.deepEqual(saved.features, ['10% back on Aldar spend', 'Lounge access']);
  const noPage = async (ctx) => ({ read_page: false, headline: '', features: [], script: ['From what we hold, the card gives 10% back on Aldar spend.'], caution: '' });
  const p2 = await aiCardPitch(db, name, { customer: 'Ms Ali' }, noPage);
  assert.equal(p2.read_page, false); assert.deepEqual(p2.features, ['10% back on Aldar spend', 'Lounge access']); assert.equal(p2.problem, null);
  // The AI unavailable: the plain pitch, with the saved reading.
  const p3 = await aiCardPitch(db, name, {}, async () => null);
  assert.equal(p3.source, 'saved');
  // An uploaded pitch is never overwritten by a reading.
  const { saveUploadedPitch } = await import('../src/card-pitch.js');
  saveUploadedPitch(db, name, { headline: 'Loaded', features: ['Loaded feature'] });
  await aiCardPitch(db, name, {}, writer);
  assert.equal((await cardPitch(db, name)).source, 'uploaded');
  assert.equal(await aiCardPitch(db, 'No Such Card', {}, writer), null);
});

test('the pitch route hands the customer, income and current card to the AI writer', async () => {
  const { createServer } = await import('../src/server.js');
  const { createUser } = await import('../src/auth.js');
  const db = openDb(':memory:');
  loadCardProducts(db);
  const tl = createUser(db, { name: 'Tara', email: 'tl@t.local', role: 'team_leader', password: 'password123', region: 'DXB', hrms_code: 'EN0' });
  createUser(db, { name: 'Sam', email: 'sam@t.local', role: 'sales', password: 'password123', region: 'DXB', sales_code: 'D-1', core_product: 'credit_card', hrms_code: 'EN1', team_leader_id: tl.id });
  let got = null;
  const server = createServer(db, { pitchWriter: async (ctx) => { got = ctx; return { read_page: true, headline: 'H', features: ['F1', 'F2', 'F3'], script: ['Hello Mr Khan.'], caution: '' }; } });
  await new Promise((r) => server.listen(0, r));
  const base = `http://localhost:${server.address().port}`;
  const res = await fetch(`${base}/api/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'sam@t.local', password: 'password123' }) });
  const cookie = res.headers.get('set-cookie').split(';')[0];
  const r = await fetch(`${base}/api/cards/pitch?name=Darna%20Visa%20Infinite%20Credit%20Card&customer=Mr%20Khan&income=35000&income_word=salary&current=Darna%20Select%20Visa%20Credit%20Card&current_category=Mass`, { headers: { cookie } });
  const p = await r.json();
  assert.equal(r.status, 200, JSON.stringify(p));
  assert.equal(p.source, 'ai'); assert.deepEqual(p.script, ['Hello Mr Khan.']);
  assert.equal(got.customer, 'Mr Khan'); assert.equal(got.income, 35000); assert.equal(got.current.name, 'Darna Select Visa Credit Card');
  server.close();
});
