// The app icons (owner, 09-Nov-2026: the website as an app on Android / iPhone): web/icons/*.png + the Android app's
// android/app/src/main/res/*/ic_launcher.png / ic_notification_icon.png, drawn from one SVG
// (the site's mark - a rising line on the brand blue). Run: NODE_PATH=$(npm root -g) node tools/build_icons.js
// (Chromium via Playwright; CHROMIUM_PATH optional). The PNGs are committed; run again only when the mark changes.
'use strict';
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
// pad = the share of the size kept clear around the mark (maskable icons: the safe zone is the middle 80 %)
function svg(size, opts) {
  const o = opts || {};
  const pad = o.pad || 0.18, r = o.round === false ? 0 : size * 0.22;
  const a = size * pad, b = size - a, w = b - a;
  const pts = [[0, 0.72], [0.36, 0.38], [0.6, 0.6], [1, 0.12]].map(([x, y]) => (a + x * w).toFixed(1) + ' ' + (a + y * w).toFixed(1));
  const line = '<path d="M' + pts.join(' L') + '" fill="none" stroke="' + (o.mono ? '#fff' : '#fff') + '" stroke-width="' + (size * 0.085).toFixed(1) +
    '" stroke-linecap="round" stroke-linejoin="round"/>';
  const dot = '<circle cx="' + (a + w).toFixed(1) + '" cy="' + (a + 0.12 * w).toFixed(1) + '" r="' + (size * 0.065).toFixed(1) + '" fill="#fff"/>';
  const bg = o.mono ? '' : '<defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#3b82f6"/><stop offset="1" stop-color="#1d4ed8"/></linearGradient></defs>' +
    '<rect width="' + size + '" height="' + size + '" rx="' + r + '" fill="url(#g)"/>';
  return '<svg xmlns="http://www.w3.org/2000/svg" width="' + size + '" height="' + size + '" viewBox="0 0 ' + size + ' ' + size + '">' + bg + line + dot + '</svg>';
}
const ICONS = [
  ['web/icons/icon-192.png', 192, {}], ['web/icons/icon-512.png', 512, {}],
  ['web/icons/maskable-512.png', 512, { pad: 0.28, round: false }],      // Android masks it to a circle / squircle itself
  ['web/icons/apple-touch-icon.png', 180, { round: false }],             // iOS rounds the corners itself
  ['web/icons/badge-96.png', 96, { mono: true, pad: 0.14 }]               // Android's status bar: white on transparent
];
// the Android app (android/): launcher icons + the notification's small icon (white on transparent) per screen density
[['mdpi', 1], ['hdpi', 1.5], ['xhdpi', 2], ['xxhdpi', 3], ['xxxhdpi', 4]].forEach(([d, k]) => {
  ICONS.push(['android/app/src/main/res/mipmap-' + d + '/ic_launcher.png', Math.round(48 * k), {}]);
  ICONS.push(['android/app/src/main/res/drawable-' + d + '/ic_notification_icon.png', Math.round(24 * k), { mono: true, pad: 0.12 }]);
});

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage();
  for (const [name, size, opts] of ICONS) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent('<html><body style="margin:0;background:transparent">' + svg(size, opts) + '</body></html>');
    fs.mkdirSync(path.dirname(path.join(ROOT, name)), { recursive: true });
    await page.locator('svg').screenshot({ path: path.join(ROOT, name), omitBackground: true });
    console.log('  ' + name);
  }
  await browser.close();
})();
