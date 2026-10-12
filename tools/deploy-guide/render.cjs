// Renders tools/deploy-guide/guide.html to deploy/STRIDE-IT-Deployment-Guide.pdf with Chromium.
//   node tools/deploy-guide/render.cjs [out.pdf]
const path = require('path');
const { chromium } = require(require('child_process').execSync('npm root -g').toString().trim() + '/playwright');
(async () => {
  const out = path.resolve(process.argv[2] || 'deploy/STRIDE-IT-Deployment-Guide.pdf');
  const b = await chromium.launch({ executablePath: process.env.CHROMIUM || '/opt/pw-browsers/chromium' });
  const p = await b.newPage();
  await p.goto('file://' + path.resolve(__dirname, 'guide.html'));
  await p.pdf({
    path: out, format: 'A4', printBackground: true, displayHeaderFooter: true,
    margin: { top: '20mm', bottom: '20mm', left: '18mm', right: '18mm' },
    headerTemplate: '<div style="font-size:8px;color:#5A6473;width:100%;padding:0 18mm;font-family:Helvetica,Arial,sans-serif">STRIDE — IT Deployment Guide · v2, 12 October 2026</div>',
    footerTemplate: '<div style="font-size:8px;color:#5A6473;width:100%;padding:0 18mm;text-align:right;font-family:Helvetica,Arial,sans-serif">Page <span class="pageNumber"></span> of <span class="totalPages"></span></div>',
  });
  await b.close();
  console.log('wrote', out);
})();
