'use strict';
// Browser tests (Playwright + Chromium). Run: npm run test:ui
// Starts its own static server for web/, so nothing else needs to run.
// Checks: every page renders without errors in light and dark themes, no
// horizontal page scroll at 360 px, theme tokens apply, the industry page
// only lists its own category, and Daily Suggestions matches the engine.
const http = require('http');
const fs = require('fs');
const path = require('path');
const assert = require('assert');
let chromium;
try { chromium = require('playwright').chromium; } catch (e) {
  console.log('SKIP: playwright is not installed (npm i -g playwright, or set NODE_PATH)');
  process.exit(0);
}

const WEB = path.join(__dirname, '..', '..', 'web');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json' };
const server = http.createServer((req, res) => {
  const p = path.join(WEB, decodeURIComponent(req.url.split('?')[0]).replace(/^\/$/, '/index.html'));
  if (!p.startsWith(WEB) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404, { 'Content-Type': 'text/plain' }); res.end('not found'); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});

const PAGES = ['overview', 'watchlist', 'suggestions', 'industries', 'industries/it', 'industries/review', 'strategy', 'signals', 'excel', 'results', 'alerts', 'backtest', 'markets'];
let failures = 0;
function check(name, fn) {
  return Promise.resolve().then(fn).then(() => console.log('  ✓ ' + name), (e) => { failures++; console.log('  ✗ ' + name + '\n    ' + e.message); });
}

(async () => {
  await new Promise((r) => server.listen(0, r));
  const base = 'http://127.0.0.1:' + server.address().port + '/';
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  for (const theme of ['light', 'dark']) {
    for (const vp of [{ width: 1366, height: 900 }, { width: 360, height: 780 }]) {
      const ctx = await browser.newContext({ viewport: vp });
      await ctx.addInitScript((t) => { try { localStorage.setItem('sb:theme', JSON.stringify(t)); } catch (e) { /* ignore */ } }, theme);
      const page = await ctx.newPage();
      const errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
      console.log(theme + ' ' + vp.width + 'px');
      for (const p of PAGES) {
        await check('#' + p + ' renders', async () => {
          errors.length = 0;
          await page.goto(base + '#' + p, { waitUntil: 'load' });
          await page.waitForTimeout(p === 'suggestions' || p === 'signals' || p === 'industries' ? 2500 : 800);
          const info = await page.evaluate(() => ({
            overflow: document.documentElement.scrollWidth - window.innerWidth,
            text: document.querySelector('#app').innerText.length,
            bad: !!document.querySelector('#app .note.bad') && /could not be shown/.test(document.querySelector('#app').innerText),
            bg: getComputedStyle(document.body).backgroundColor,
            theme: document.documentElement.getAttribute('data-theme')
          }));
          assert.deepStrictEqual(errors, [], 'console/page errors');
          assert.ok(info.text > 200, 'page has content');
          assert.ok(!info.bad, 'page did not crash');
          assert.ok(info.overflow <= 0, 'horizontal page overflow ' + info.overflow + 'px');
          if (theme === 'light') assert.strictEqual(info.bg, 'rgb(255, 255, 255)', 'light theme body is white');
          else { assert.strictEqual(info.theme, 'dark'); assert.notStrictEqual(info.bg, 'rgb(255, 255, 255)', 'dark theme body is not white'); }
        });
      }
      if (vp.width > 1000 && theme === 'light') {
        await check('industry page lists only its own category', async () => {
          await page.goto(base + '#industries/it', { waitUntil: 'load' });
          await page.waitForTimeout(2500);
          const syms = await page.$$eval('#app table.tbl tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')));
          assert.ok(syms.length > 0, 'IT page lists stocks');
          const cats = await page.evaluate((s) => s.map((x) => window.SB.ctx.bySym[x] && window.SB.ctx.bySym[x].cat), syms);
          assert.ok(cats.every((c) => c === 'it'), 'all listed stocks are IT: ' + cats.filter((c) => c !== 'it').length + ' are not');
        });
        await check('daily suggestions match the engine run', async () => {
          await page.goto(base + '#suggestions', { waitUntil: 'load' });
          await page.waitForTimeout(3000);
          const r = await page.evaluate(() => {
            const run = window.SB.strategies.lastRun();
            const chip = document.querySelector('[data-chip="sgl"][data-v="qualified"]');
            return { q: run.lists.qualified.length, chip: chip && chip.textContent, cards: document.querySelectorAll('.sugg-item').length };
          });
          assert.ok(r.chip && r.chip.indexOf('(' + r.q + ')') > 0, 'chip shows ' + r.q);
          assert.ok(r.cards === Math.min(20, r.q) || (r.q === 0 && r.cards === 0), 'cards ' + r.cards);
        });
        await check('theme toggle switches and persists', async () => {
          await page.goto(base + '#overview', { waitUntil: 'load' });
          await page.click('#theme');
          const t1 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await page.reload({ waitUntil: 'load' });
          const t2 = await page.evaluate(() => document.documentElement.getAttribute('data-theme'));
          assert.strictEqual(t1, 'dark');
          assert.strictEqual(t2, 'dark');
          await page.click('#theme');
        });
      }
      await ctx.close();
    }
  }
  await browser.close();
  server.close();
  console.log(failures ? '\n' + failures + ' UI check(s) failed' : '\nall UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
