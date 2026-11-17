'use strict';
// Results Edge guide (owner, 17-Nov-2026: "result edge page epdi work aaguthu nu text la oru pdf kudu. epdi outcomes edukuthu. epdi
// score calculate panuthu"): tools/edge-guide/guide.html (Tamil, FreeSans) -> Chromium PDF dist/guide/Results-Edge-Guide.pdf.
// Run: NODE_PATH=$(npm root -g) node tools/edge-guide/build.js   (only when the owner asks for an update)
const path = require('path');
const fs = require('fs');
const { chromium } = require('playwright');

(async () => {
  const src = path.join(__dirname, 'guide.html');
  const outDir = path.join(__dirname, '..', '..', 'dist', 'guide');
  fs.mkdirSync(outDir, { recursive: true });
  const out = path.join(outDir, 'Results-Edge-Guide.pdf');
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  await page.goto('file://' + src, { waitUntil: 'load' });
  await page.pdf({ path: out, format: 'A4', printBackground: true, displayHeaderFooter: true, headerTemplate: '<div></div>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#94a3b8;font-family:sans-serif">Results Edge guide · <span class="pageNumber"></span> / <span class="totalPages"></span></div>',
    margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' } });
  await browser.close();
  console.log('written ' + out + ' (' + Math.round(fs.statSync(out).size / 1024) + ' KB)');
})().catch((e) => { console.error(e); process.exit(1); });
