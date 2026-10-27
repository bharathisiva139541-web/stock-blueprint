'use strict';
// Browser tests (Playwright + Chromium). Run: npm run test:ui
// Starts its own static server for web/, so nothing else needs to run.
// Checks: every page renders without errors in light and dark themes, no
// horizontal page scroll at 360 px, theme tokens apply, the industry page
// only lists its own category, and Daily Suggestions matches the engine.
// Live site feed: api/site, api/market-status and api/quotes are MOCKED with
// page routes (same-origin Vercel, the Firebase copy's remote API, failures);
// every other request off the test server is blocked - no network is used.
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

// ---------- live-feed mocks ----------
function windowVar(file, name) { const w = {}; new Function('window', fs.readFileSync(file, 'utf8'))(w); return w[name]; }
const CFG = windowVar(path.join(WEB, 'config.js'), 'SB_CONFIG');
const REMOTE = new URL(CFG.remoteApi);                    // the API the Firebase copy uses (mocked, never contacted)
const FIREBASE = 'http://stock-blueprint.web.app/';      // served from web/ by a route: no DNS, no network
const SAVED = windowVar(path.join(WEB, 'data', 'dashboard.js'), 'SB_DATA');
const HIST = windowVar(path.join(WEB, 'data', 'history.js'), 'SB_HISTORY');
const SENTINEL = 43210.98;                                // a price only the mocked live feed has
// IST 'YYYY-MM-DD HH:MM' a few minutes ago: web/app.js ages a DELAYED read from readAt
const istAgo = (min) => new Date(Date.now() + (330 - min) * 60000).toISOString().slice(0, 16).replace('T', ' ');
const READ_AT = istAgo(2);
const LIVE_MAIN = JSON.parse(JSON.stringify(SAVED));
LIVE_MAIN.generated = READ_AT;
LIVE_MAIN.source = 'Google Sheet (live feed)';
const SENT_SYM = LIVE_MAIN.main.rows[0][LIVE_MAIN.main.cols.indexOf('sym')];
LIVE_MAIN.main.rows[0][LIVE_MAIN.main.cols.indexOf('price')] = SENTINEL;

/** API answers for one scenario: url -> { json, status } | 'abort'. */
function liveApi(o) {
  return (u) => {
    const part = u.searchParams.get('part');
    if (u.pathname === '/api/site') {
      if (o.site === 'abort') return 'abort';
      if (o.site === 'fail') return { json: { ok: false, configured: true, part, message: 'mock failure: sheet is updating (History30 has 3 of 1800 symbols) - try again shortly' } };
      return { json: { ok: true, configured: true, part, readAt: READ_AT, fetchedAt: istAgo(1), stale: false,
        session: { state: o.session, lastCompletedSession: '2026-10-20' }, priceState: o.priceState, data: part === 'history' ? HIST : LIVE_MAIN } };
    }
    if (u.pathname === '/api/market-status') {
      return { json: o.provider === 'sheet'
        ? { provider: { name: 'sheet', configured: true, requires: ['SHEET_FEED_URL', 'SHEET_FEED_TOKEN'], licensing: 'mock licensing note' },
            session: { state: o.session, now: '2026-10-21 10:06', lastCompletedSession: '2026-10-20' }, status: { ok: false, state: 'UNAVAILABLE', message: 'mock provider: sheet feed timed out' } }
        : { provider: { name: 'none', configured: false, requires: ['MARKET_DATA_PROVIDER'], licensing: '' },
            session: { state: o.session, now: '2026-10-21 10:06', lastCompletedSession: '2026-10-20' }, status: { ok: false, state: 'UNAVAILABLE', message: 'no provider' } } };
    }
    if (u.pathname === '/api/quotes') {
      return { json: { state: 'UNAVAILABLE', source: 'sheet', asOf: null, items: [], errors: [{ symbol: '*', reason: 'mock provider: sheet feed timed out' }], message: 'mock provider: sheet feed timed out' } };
    }
    return { status: 404, json: { error: 'not found' } };
  };
}
/** Route every request of a context: mocked api/, web/ files, everything else blocked. */
async function routeAll(context, siteBase, api, calls) {
  const site = new URL(siteBase);
  await context.route('**/*', async (route) => {
    const u = new URL(route.request().url());
    if ((u.origin === site.origin || u.origin === REMOTE.origin) && u.pathname.indexOf('/api/') === 0) {
      calls.push(u.origin + u.pathname + u.search);
      const r = api(u);
      if (r === 'abort') return route.abort('failed');
      return route.fulfill({ status: r.status || 200, contentType: 'application/json; charset=utf-8',
        headers: { 'Access-Control-Allow-Origin': '*' }, body: JSON.stringify(r.json) });
    }
    if (u.origin !== site.origin) return route.abort('blockedbyclient');   // nothing leaves the machine
    if (site.hostname !== '127.0.0.1') {                                   // the fake Firebase host: serve web/
      const f = path.join(WEB, decodeURIComponent(u.pathname).replace(/^\/$/, '/index.html'));
      if (!f.startsWith(WEB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) return route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' });
      return route.fulfill({ path: f, contentType: TYPES[path.extname(f)] || 'application/octet-stream' });
    }
    return route.continue();
  });
}
function watchErrors(page) {
  const errors = [];
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => { if (m.type() === 'error' && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
  return errors;
}
const dataReady = () => window.SB && window.SB.ctx && window.SB.ctx.D && document.querySelector('#app .page');
async function pageState(page) {
  return page.evaluate(() => {
    const pill = document.querySelector('#status'), ban = document.querySelector('#site-banner');
    const first = document.querySelector('#ov-data tbody tr');
    return {
      pillCls: pill.className, pill: pill.textContent, tip: pill.title,
      banner: ban.hidden ? null : ban.textContent, live: window.SB.ctx.site.live, state: window.SB.ctx.market.state,
      message: window.SB.ctx.market.message, apiBase: window.SB.apiBase(), siteRow: first ? first.textContent : '',
      liveBadge: [...document.querySelectorAll('.badge, .status-pill')].some((b) => /^LIVE\b/.test(b.textContent.trim())),
      overflow: document.documentElement.scrollWidth - window.innerWidth
    };
  });
}

const PAGES = ['overview', 'watchlist', 'lists', 'suggestions', 'industries', 'industries/companies', 'industries/groups', 'industries/macro/financial-services',
  'industries/sector/capital-goods', 'industries/industry/banks', 'industries/basic/public-sector-bank', 'industries/it', 'industries/review',
  'strategy', 'signals', 'excel', 'results', 'alerts', 'backtest', 'markets'];
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
          await page.waitForTimeout(p === 'suggestions' || p === 'signals' || p.indexOf('industries') === 0 ? 2500 : 800);
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
        await check('industry explorer: counts, tree, search, basic page, filters, strategy', async () => {
          errors.length = 0;
          await page.goto(base + '#industries', { waitUntil: 'load' });
          await page.waitForSelector('#ix-tiles [data-count="basic"]', { timeout: 15000 });
          const counts = await page.$$eval('#ix-tiles [data-count]', (x) => x.map((e) => e.getAttribute('data-count') + '=' + e.textContent));
          assert.deepStrictEqual(counts, ['macro=12', 'sector=22', 'industry=59', 'basic=197'], 'landing tiles');
          // tree: expanding a macro sector shows its sectors
          await page.evaluate(() => { const d = document.querySelector('#ix-tree-box'); d.open = true; });
          await page.click('[data-tog="m-financial-services"]');
          const kids = await page.$$eval('[data-tog="m-financial-services"]', (b) => [b[0].getAttribute('aria-expanded'), [...b[0].closest('li').querySelectorAll(':scope > ul > li .ix-name')].map((a) => a.textContent)]);
          assert.strictEqual(kids[0], 'true');
          assert.deepStrictEqual(kids[1], ['Financial Services'], 'sectors of the Financial Services macro sector');
          // search: symbol -> breadcrumb -> its basic industry + the stock drawer
          await page.fill('#ix-q', 'sbin');
          await page.waitForSelector('#ix-q-list .ix-opt', { timeout: 5000 });
          const first = await page.$eval('#ix-q-list .ix-opt', (o) => o.innerText);
          assert.ok(/SBIN/.test(first) && /Financial Services › Financial Services › Banks › Public Sector Bank/.test(first), 'first suggestion: ' + first);
          assert.strictEqual(await page.getAttribute('#ix-q', 'aria-activedescendant'), 'ix-opt-0');
          await page.keyboard.press('Enter');
          await page.waitForFunction(() => location.hash === '#industries/basic/public-sector-bank' && document.querySelector('#ix-bstocks tbody'), null, { timeout: 15000 });
          await page.waitForFunction(() => !document.querySelector('#drawer').hidden, null, { timeout: 5000 });
          assert.strictEqual(await page.$eval('#drawer-title', (h) => h.firstChild.textContent), 'SBIN');
          await page.keyboard.press('Escape');
          // basic page: 4 hierarchy links, only its own stocks, strategy statuses from the engine run
          const lv = await page.$$eval('.ix-crumbs a[data-lv]', (a) => a.map((x) => x.getAttribute('data-lv')));
          assert.deepStrictEqual(lv, ['macro', 'sector', 'industry', 'basic']);
          await page.waitForFunction(() => window.SB.strategies.lastRun() && document.querySelector('[data-chip="ixsg"]'), null, { timeout: 15000 });
          const b = await page.evaluate(() => {
            const IND = window.SB.industry, I = IND.createIndex(window.SB_INDUSTRIES);
            const syms = [...document.querySelectorAll('#ix-bstocks tbody button[data-sym]')].map((x) => x.getAttribute('data-sym'));
            const basics = syms.map((x) => IND.classifyStock(I, window.SB.ctx.bySym[x]).basicId);
            const all = window.SB.ctx.stocks.filter((x) => IND.classifyStock(I, x).basicId === 'b-public-sector-bank').map((x) => x.sym);
            const run = window.SB.strategies.lastRun();
            const ev = all.filter((x) => run.bySym[x]);
            const q = ev.filter((x) => run.bySym[x].status === 'qualified').length;
            const chips = [...document.querySelectorAll('[data-chip="ixsg"]')].map((c) => c.textContent);
            return { syms, basics, all: all.length, ev: ev.length, q, chips, items: document.querySelectorAll('.ix-sg-item').length };
          });
          assert.ok(b.syms.length > 0 && b.basics.every((x) => x === 'b-public-sector-bank'), 'only Public Sector Bank stocks: ' + b.basics.join(','));
          assert.strictEqual(b.syms.length, Math.min(25, b.all), 'every mapped stock is listed (first page)');
          assert.strictEqual(b.chips[0], 'All (' + b.ev + ')');
          assert.ok(b.chips.indexOf('Qualified (' + b.q + ')') >= 0, 'qualified chip: ' + b.chips.join(' | '));
          assert.strictEqual(b.items, Math.min(10, b.ev), 'strategy cards');
          // companies: combined filters give the count computed with SB.industry
          await page.goto(base + '#industries/companies', { waitUntil: 'load' });
          await page.waitForSelector('#co-macroId option[value="m-financial-services"]', { state: 'attached', timeout: 15000 });
          await page.selectOption('#co-macroId', 'm-financial-services');
          await page.selectOption('#co-cap', 'large');
          const co = await page.evaluate(() => {
            const IND = window.SB.industry, I = IND.createIndex(window.SB_INDUSTRIES);
            const n = window.SB.ctx.stocks.filter((x) => IND.classifyStock(I, x).macroId === 'm-financial-services' && IND.capBucket(x).key === 'large').length;
            const sectorOpts = [...document.querySelectorAll('#co-sectorId option')].map((o) => o.value).filter(Boolean);
            return { n, text: document.querySelector('#co-count').textContent, sectorOpts };
          });
          assert.ok(co.n > 0 && co.text.indexOf(co.n + ' of ') === 0, co.n + ' vs ' + co.text);
          assert.deepStrictEqual(co.sectorOpts, ['s-financial-services'], 'sector options follow the macro sector');
          await page.click('#co-clear');
          const cleared = await page.evaluate(() => [document.querySelector('#co-count').textContent, document.querySelector('#co-macroId').value, document.querySelector('#co-cap').value]);
          assert.ok(/^1,?800 of /.test(cleared[0]) || cleared[0].split(' of ')[0] === cleared[0].split(' of ')[1].split(' ')[0], 'clear all: ' + cleared[0]);
          assert.deepStrictEqual(cleared.slice(1), ['', '']);
          // unknown slug: friendly not-found
          await page.goto(base + '#industries/basic/no-such-industry', { waitUntil: 'load' });
          await page.waitForFunction(() => /Not found/.test(document.querySelector('#app').innerText), null, { timeout: 15000 });
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('IPOs & markets: IPO tracker sections and price band filters', async () => {
          errors.length = 0;
          await page.goto(base + '#markets', { waitUntil: 'load' });
          await page.waitForSelector('#pb-t table', { timeout: 15000 });
          const r = await page.evaluate(() => {
            const H = ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note'];
            window.SB.ctx.D.ipoTracker = {
              note: 'Updated 2026-10-27 08:28 IST from NSE, read by your PC.', warning: '',
              open: { cols: H, rows: [['BLS Polymers Limited', 'BLSPOLY', '2026-10-27', '2026-10-29', null, '₹142 to ₹150', 11900000, 'Closes in 2 days']] },
              closed: { cols: H, rows: [] },
              upcoming: { cols: H, rows: [['Bombay Coated and Special Steels Limited', 'BCSSL', '2026-10-29', '2026-11-02', null, '₹78 to ₹82', 23468846, 'Opens in 2 days']] }
            };
            window.SB.route();
            const t = (id) => document.querySelector(id).innerText;
            const pb = window.SB.ctx.D.priceBands;
            const ei = pb.cols.indexOf('Effective (next weekday)');
            const latest = pb.rows.reduce((m, x) => (x[ei] > m ? x[ei] : m), '');
            return { open: t('#ipot-open'), closed: t('#ipot-closed'), upcoming: t('#ipot-upcoming'),
              count: t('#pb-count'), latestN: pb.rows.filter((x) => x[ei] === latest).length };
          });
          assert.ok(/BLS Polymers Limited/.test(r.open) && /BLSPOLY/.test(r.open) && /1,19,00,000/.test(r.open) && /Closes in 2 days/.test(r.open), r.open);
          assert.ok(/None/.test(r.closed), r.closed);
          assert.ok(/BCSSL/.test(r.upcoming) && /2,34,68,846/.test(r.upcoming), r.upcoming);
          assert.ok(r.count.indexOf(r.latestN + ' of ' + r.latestN) === 0, 'latest day only by default: ' + r.count);
          await page.click('[data-chip="pbv"][data-v="all"]');
          const all = await page.$eval('#pb-count', (x) => x.textContent);
          assert.ok(/^([\d,]+) of \1$/.test(all), 'all days: ' + all);
          assert.deepStrictEqual(errors, [], 'console/page errors');
        });
        await check('my watchlists: star, create, no duplicates, rename, search, delete, kept after reload', async () => {
          errors.length = 0;
          await page.goto(base + '#watchlist', { waitUntil: 'load' });
          await page.waitForSelector('#app table.tbl .wl-star', { timeout: 15000 });
          const sym = await page.$eval('#app table.tbl .wl-star', (x) => x.getAttribute('data-wl'));
          const star = '#app table.tbl .wl-star[data-wl="' + sym + '"]';
          await page.click(star);
          await page.waitForSelector('.wl-pop');
          await page.fill('#wl-pop-name', 'Swing trades');
          await page.press('#wl-pop-name', 'Enter');
          await page.waitForFunction((s) => document.querySelector(s).classList.contains('on'), star);
          assert.strictEqual(await page.$eval(star, (x) => x.textContent), '★');
          await page.keyboard.press('Escape');
          assert.strictEqual(await page.$('.wl-pop'), null, 'Escape closes the popover');
          // the drawer has the same star
          await page.click('#app table.tbl button[data-sym="' + sym + '"]');
          await page.waitForSelector('#drawer-title .wl-star.on');
          await page.keyboard.press('Escape');
          await page.goto(base + '#lists', { waitUntil: 'load' });
          await page.waitForSelector('.wl-names');
          await page.fill('#wl-add-in', 'TCS, infy, TCS, ' + sym);
          await page.press('#wl-add-in', 'Enter');
          await page.waitForFunction(() => /already in this watchlist/.test(document.querySelector('.wl-msg').textContent));
          const syms = await page.$$eval('#wl-table tbody button[data-sym]', (b) => b.map((x) => x.getAttribute('data-sym')).sort());
          assert.deepStrictEqual(syms, [sym, 'INFY', 'TCS'].sort(), 'each stock once');
          await page.fill('#wl-new', 'Long term');
          await page.press('#wl-new', 'Enter');
          await page.fill('#wl-new', 'swing  TRADES');
          await page.press('#wl-new', 'Enter');
          await page.waitForFunction(() => /already exists/.test(document.querySelector('.wl-msg').textContent));
          assert.strictEqual(await page.$$eval('.wl-name', (x) => x.length), 2, 'no duplicate watchlist');
          // rename the selected one (Long term)
          await page.click('#wl-rename-btn');
          await page.fill('#wl-rename-in', 'Long-term holds');
          await page.press('#wl-rename-in', 'Enter');
          await page.waitForFunction(() => [...document.querySelectorAll('.wl-name-t')].some((x) => x.textContent === 'Long-term holds'));
          // search by name and by a symbol inside
          await page.fill('#wl-q', 'hold');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1);
          await page.fill('#wl-q', 'TCS');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1 && /Swing trades/.test(document.querySelector('.wl-name').textContent));
          await page.fill('#wl-q', '');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 2);
          // kept after a reload (localStorage)
          await page.reload({ waitUntil: 'load' });
          await page.waitForSelector('.wl-names');
          const names = await page.$$eval('.wl-name', (x) => x.map((e) => e.innerText.replace(/\s+/g, ' ').trim()));
          assert.deepStrictEqual(names, ['Long-term holds 0', 'Swing trades 3']);
          // remove a stock, then delete a watchlist (with a confirm step)
          await page.click('[data-wl-pick]:not(.on)');
          await page.click('[data-wl-rm="TCS"]');
          await page.waitForFunction(() => document.querySelectorAll('#wl-table tbody button[data-sym]').length === 2);
          await page.click('#wl-del');
          await page.click('#wl-del-yes');
          await page.waitForFunction(() => document.querySelectorAll('.wl-name').length === 1);
          const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('sb:watchlists')));
          assert.deepStrictEqual(stored.lists.map((l) => [l.name, l.syms.length]), [['Long-term holds', 0]]);
          await page.evaluate(() => localStorage.removeItem('sb:watchlists'));
          assert.deepStrictEqual(errors, [], 'console/page errors');
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
        await check('theme toggle switches and persists (default light)', async () => {
          const c2 = await browser.newContext({ viewport: vp });       // no init script: real persistence
          const p2 = await c2.newPage();
          await p2.goto(base + '#overview', { waitUntil: 'load' });
          const t0 = await p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await p2.click('#theme');
          const t1 = await p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await p2.reload({ waitUntil: 'load' });
          const t2 = await p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await p2.click('#theme');
          const t3 = await p2.evaluate(() => document.documentElement.getAttribute('data-theme'));
          await c2.close();
          assert.strictEqual(t0, null, 'starts light');
          assert.strictEqual(t1, 'dark');
          assert.strictEqual(t2, 'dark', 'persists after reload');
          assert.strictEqual(t3, null, 'back to light');
        });
      }
      await ctx.close();
    }
  }

  console.log('live site feed (mocked api/)');
  await check('static host: saved copy with banner, no API calls', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    const calls = [];
    await routeAll(c, base, liveApi({}), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(dataReady, null, { timeout: 15000 });
    await p.waitForTimeout(300);
    const st = await pageState(p);
    const bases = await p.evaluate(() => {
      const f = window.SB.apiBaseFor, R = 'https://example.vercel.app';
      return [f('stock-blueprint.web.app', 'https:', null, R), f('x.firebaseapp.com', 'https:', true, R), f('stock-blueprint.web.app', 'https:', null, ''),
        f('stock-blueprint-sandy.vercel.app', 'https:', null, R), f('localhost', 'http:', null, R), f('localhost', 'http:', true, R), f('', 'file:', null, R)];
    });
    await c.close();
    assert.deepStrictEqual(bases, ['https://example.vercel.app/', 'https://example.vercel.app/', null, '', null, '', null], 'API base per host');
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.deepStrictEqual(calls, [], 'no api/ request on a static host');
    assert.strictEqual(st.apiBase, null);
    assert.strictEqual(st.live, false);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED: ' + st.pillCls);
    assert.ok(st.banner && /Showing a saved copy/.test(st.banner) && /not updated automatically/.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/Site data \(Google Sheet\)\s*Saved copy/.test(st.siteRow), 'site row: ' + st.siteRow);
  });

  await check('live feed (same-origin api/): DELAYED pill, live prices + candles, provider failure shown, no banner', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ priceState: 'DELAYED', session: 'open', provider: 'sheet' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /Quotes unavailable/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    const drawer = await p.evaluate((sym) => { window.SB.openStock(sym); return document.querySelector('#drawer-body').textContent; }, SENT_SYM);
    await p.keyboard.press('Escape');
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB.ctx.history, null, { timeout: 15000 });
    const H = await p.evaluate(() => ({ live: window.SB.ctx.history.live, readAt: window.SB.ctx.history.readAt, reason: window.SB.ctx.site.historyReason }));
    await p.waitForTimeout(500);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.apiBase, '');
    assert.strictEqual(st.live, true);
    assert.ok(/st-DELAYED/.test(st.pillCls) && /^DELAYED/.test(st.pill), 'pill DELAYED: ' + st.pill);
    assert.ok(!st.liveBadge, 'sheet data is never labelled LIVE');
    assert.ok(/mock provider: sheet feed timed out/.test(st.tip), 'provider failure in the pill tooltip: ' + st.tip);
    assert.strictEqual(st.banner, null, 'no stale banner');
    assert.ok(/Site data \(Google Sheet\)\s*Live feed/.test(st.siteRow), 'site row: ' + st.siteRow);
    assert.ok(drawer.indexOf('43,210.98') >= 0, 'sentinel price from the live feed is shown');
    assert.ok(H.live === true && H.readAt === READ_AT && !H.reason, 'candles from the live feed: ' + JSON.stringify(H));
    assert.ok(calls.some((u) => /\/api\/site\?part=main$/.test(u)) && calls.some((u) => /\/api\/site\?part=history$/.test(u)), 'calls: ' + calls.join(' '));
    assert.ok(calls.every((u) => u.indexOf(new URL(base).origin) === 0), 'same-origin API only');
  });

  await check('Firebase copy: remote API from web/config.js, EOD pill, no overflow at 360 px', async () => {
    const c = await browser.newContext({ viewport: { width: 360, height: 780 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:theme', '"dark"'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, FIREBASE, liveApi({ priceState: 'EOD', session: 'closed' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(FIREBASE + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /No market-data provider/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.apiBase, REMOTE.href);
    assert.ok(calls.length && calls.every((u) => u.indexOf(REMOTE.origin + '/api/') === 0), 'remote API only: ' + calls.join(' '));
    assert.ok(/st-EOD/.test(st.pillCls) && /^EOD/.test(st.pill), 'pill EOD: ' + st.pill);
    assert.strictEqual(st.banner, null, 'no stale banner');
    assert.ok(st.overflow <= 0, 'horizontal page overflow ' + st.overflow + 'px');
  });

  await check('live feed fails (ok:false): saved copy + banner with the reason, candles from data/history.js', async () => {
    const c = await browser.newContext({ viewport: { width: 360, height: 780 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    const calls = [];
    await routeAll(c, base, liveApi({ site: 'fail', session: 'open' }), calls);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /No market-data provider/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    const price = await p.evaluate((sym) => window.SB.ctx.bySym[sym].price, SENT_SYM);
    await p.goto(base + '#suggestions', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB.ctx.history, null, { timeout: 15000 });
    const hLive = await p.evaluate(() => !!window.SB.ctx.history.live);
    await p.waitForTimeout(500);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.strictEqual(st.live, false);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED: ' + st.pillCls);
    assert.ok(st.banner && /Showing a saved copy/.test(st.banner) && /Live data could not be loaded: mock failure: sheet is updating/.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/Saved copy/.test(st.siteRow) && /mock failure/.test(st.siteRow), 'site row: ' + st.siteRow);
    assert.notStrictEqual(price, SENTINEL, 'saved prices, not the live mock');
    assert.strictEqual(hLive, false, 'candles from data/history.js');
    assert.ok(!calls.some((u) => /part=history/.test(u)), 'no live candle request after a failed boot');
    assert.ok(st.overflow <= 0, 'horizontal page overflow ' + st.overflow + 'px');
  });

  await check('live feed unreachable (network error): saved copy + banner', async () => {
    const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await c.addInitScript(() => { try { localStorage.setItem('sb:api', 'true'); } catch (e) { /* ignore */ } });
    await routeAll(c, base, () => 'abort', []);
    const p = await c.newPage(), errors = watchErrors(p);
    await p.goto(base + '#overview', { waitUntil: 'load' });
    await p.waitForFunction(() => window.SB && window.SB.ctx && window.SB.ctx.D && /Market-data API not available/.test(window.SB.ctx.market.message || ''), null, { timeout: 15000 });
    const st = await pageState(p);
    await c.close();
    assert.deepStrictEqual(errors, [], 'console/page errors');
    assert.ok(st.banner && /Live data could not be loaded: /.test(st.banner), 'banner: ' + st.banner);
    assert.ok(/st-CACHED/.test(st.pillCls), 'pill CACHED');
  });

  const preview = path.join(__dirname, '..', '..', 'dist', 'stock-blueprint-preview.html');
  if (fs.existsSync(preview)) {
    await check('single-file preview (file://) renders the inlined saved copy', async () => {
      const c = await browser.newContext({ viewport: { width: 1366, height: 900 } });
      const p = await c.newPage(), errors = watchErrors(p);
      await p.goto('file://' + preview + '#overview', { waitUntil: 'load' });
      await p.waitForFunction(dataReady, null, { timeout: 15000 });
      const st = await pageState(p);
      await c.close();
      assert.deepStrictEqual(errors, [], 'console/page errors');
      assert.strictEqual(st.apiBase, null);
      assert.ok(st.banner && /not updated automatically/.test(st.banner), 'banner: ' + st.banner);
    });
  } else console.log('  - single-file preview: skipped (run npm run build first)');

  await browser.close();
  server.close();
  console.log(failures ? '\n' + failures + ' UI check(s) failed' : '\nall UI checks passed');
  process.exit(failures ? 1 : 0);
})().catch((e) => { console.error(e); server.close(); process.exit(1); });
