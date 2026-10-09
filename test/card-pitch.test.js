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
