// Renders the deck's slide files to a PDF, one 1920x1080 page per slide.
const fs = require('fs');
const path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');

const ROOT = path.join(__dirname, process.argv[3] || 'deck', 'project');
const OUT = process.argv[2];
const BLOBS = process.argv[4] ? JSON.parse(fs.readFileSync(path.join(__dirname, process.argv[4]), 'utf8')) : {};
const deck = JSON.parse(fs.readFileSync(path.join(ROOT, 'deck.json'), 'utf8'));

// Simple line icons (24x24 viewBox) standing in for <x-icon>.
const ICONS = {
  Warning: '<path d="M12 3 2 21h20L12 3z"/><path d="M12 10v5"/><path d="M12 18h.01"/>',
  Clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  Chart: '<path d="M4 20V10"/><path d="M10 20V4"/><path d="M16 20v-7"/><path d="M22 20H2"/>',
  Lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
  Users: '<circle cx="9" cy="8" r="3.5"/><path d="M2 20a7 7 0 0 1 14 0"/><circle cx="17" cy="9" r="3"/><path d="M22 20a5 5 0 0 0-6-5"/>',
  Search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="M21 21l-5.5-5.5"/>',
  Verified: '<path d="M12 2 4 6v6c0 5 3.5 8.5 8 10 4.5-1.5 8-5 8-10V6l-8-4z"/><path d="m9 12 2 2 4-4"/>',
  Key: '<circle cx="8" cy="15" r="4.5"/><path d="M11.5 11.5 21 2"/><path d="M17 6l3 3"/><path d="M14 9l3 3"/>',
  Database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  CheckCircle: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  Lightbulb: '<path d="M9 18h6"/><path d="M10 21h4"/><path d="M8.5 14.5A6 6 0 1 1 15.5 14.5c-.8.7-1.5 1.5-1.5 2.5h-4c0-1-.7-1.8-1.5-2.5z"/>',
};
const icon = (name, style) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" style="flex:none;${style}">${ICONS[name] || ''}</svg>`;

function convert(html) {
  return html
    .replace(/<aside>[\s\S]*?<\/aside>/g, '')
    .replace(/src="\/_blob\/([0-9a-f]+)"/g, (_, id) => `src="file://${path.join(__dirname, BLOBS[id] || '')}"`)
    .replace(/<x-icon name="([^"]+)" style="([^"]*)"><\/x-icon>/g, (_, n, s) => icon(n, s))
    .replace(/<x-shape kind="line" style="([^"]*)"><\/x-shape>/g, '<div style="flex:none;$1"></div>')
    .replace(/<x-connector style="width:(\d+)px;color:([^;]+);border-width:(\d+)px"><\/x-connector>/g, (_, w, c, bw) =>
      `<svg viewBox="0 0 ${w} 40" style="flex:none;width:${w}px;height:40px" fill="none" stroke="${c}" stroke-width="${bw}" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20H${w - 8}"/><path d="M${w - 20} 8l12 12-12 12"/></svg>`);
}

const slides = deck.order.map((id) => convert(fs.readFileSync(path.join(ROOT, 'slides', `${id}.html`), 'utf8')));
const fonts = Object.values(deck.faces).map((f) => `<link rel="stylesheet" href="${f.href}">`).join('');
const page = `<!doctype html><html><head><meta charset="utf-8"><title>${deck.title}</title>${fonts}<style>
@page { size: 1920px 1080px; margin: 0; }
html, body { margin: 0; padding: 0; }
section { position: relative; width: 1920px; height: 1080px; box-sizing: border-box; overflow: hidden; page-break-after: always; break-after: page; }
section:last-child { page-break-after: auto; break-after: auto; }
* { box-sizing: border-box; }
h1, h2, h3, p, ul, ol { margin: 0; }
h1 { font-size: 96px; font-weight: 600; line-height: 1.1; }
h2 { font-size: 64px; font-weight: 600; line-height: 1.15; }
h3 { font-size: 44px; font-weight: 600; line-height: 1.2; }
p { font-size: 32px; line-height: 1.4; }
ul, ol { padding-left: 1.1em; display: flex; flex-direction: column; gap: 0.35em; }
table { border-collapse: collapse; width: 100%; }
th, td { padding: 0.35em 0.6em; border-bottom: 1px solid #DDD9CE; vertical-align: top; }
th { font-weight: 600; }
div { display: flex; flex-direction: column; }
div[style*="display:grid"] { display: grid; }
div[style*="display:flex"] { display: flex; flex-direction: row; }
</style></head><body>${slides.join('\n')}</body></html>`;

fs.writeFileSync(path.join(__dirname, `${process.argv[3] || 'deck'}-print.html`), page);

(async () => {
  const b = await chromium.launch();
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  await p.goto('file://' + path.join(__dirname, `${process.argv[3] || 'deck'}-print.html`), { waitUntil: 'networkidle' });
  await p.evaluate(() => document.fonts.ready);
  await p.waitForTimeout(500);
  // The live page shrinks text on an over-full slide; do the same here.
  await p.evaluate(() => {
    // A div with inline display:flex and no direction is a row (the slide format's rule).
    for (const d of document.querySelectorAll('div')) if (d.style.display === 'flex' && !d.style.flexDirection) d.style.flexDirection = 'row';
    for (const s of document.querySelectorAll('section')) {
      const flow = [...s.children].filter((c) => getComputedStyle(c).position !== 'absolute');
      const bottom = () => Math.max(...flow.map((c) => c.getBoundingClientRect().bottom - s.getBoundingClientRect().top));
      const limit = 1080 - parseFloat(getComputedStyle(s).paddingBottom) + 8;
      for (let i = 0; i < 30 && bottom() > limit; i++) {
        for (const el of s.querySelectorAll('*')) {
          const fs = parseFloat(getComputedStyle(el).fontSize);
          if (fs) el.style.fontSize = (fs * 0.97) + 'px';
        }
      }
    }
  });
  await p.pdf({ path: OUT, width: '1920px', height: '1080px', printBackground: true, preferCSSPageSize: true });
  await b.close();
  console.log('wrote', OUT);
})();
