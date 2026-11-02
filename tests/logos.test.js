'use strict';
// Company logos (owner, 02-Nov-2026: "use the best free source to update logos in our website"): tools/build_logos.js
// lists the NSE symbols of github.com/dharunashokkumar/indian-listed-company-logos at one pinned commit (the images are
// not copied here); web/ui/core.js logoHtml loads them from jsDelivr, then GitHub's raw files, then the monogram.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');
const { buildLogos } = require('../tools/build_logos.js');

const ROOT = path.join(__dirname, '..');
const COMMIT = '3ea18ddd90926f8daf1e9e7a8de3d20ff53da615';

function fixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'logos-'));
  const nse = path.join(dir, 'data', 'logos', 'nse');
  fs.mkdirSync(nse, { recursive: true });
  ['TCS', 'BAJAJ_AUTO', 'M&M', 'HEGAM', 'ONIDA', 'NEWCO', 'OLDCO'].forEach((t) => fs.writeFileSync(path.join(nse, 'NSE_' + t + '.svg'), '<svg/>'));
  fs.writeFileSync(path.join(nse, 'README.md'), 'not a logo');
  fs.writeFileSync(path.join(dir, 'data', 'logos', 'metadata.json'), JSON.stringify({ logos: [
    { exchange: 'NSE', ticker: 'HEGAM', aliases: ['HEG'] },
    { exchange: 'NSE', ticker: 'ONIDA', aliases: ['NSE:MIRCELECTR'] },
    { exchange: 'NSE', ticker: 'NEWCO', aliases: ['OLDCO', 'TWICE'] },     // OLDCO has its own logo: not an alias
    { exchange: 'NSE', ticker: 'TCS', aliases: ['TWICE'] },                // TWICE -> two companies: dropped
    { exchange: 'BSE', ticker: 'HEGAM', aliases: ['500292'] }] }));
  return dir;
}

test('build_logos: the NSE tickers of a checkout, single-company old tickers, the pinned addresses', () => {
  const dir = fixture();
  const out = buildLogos(dir, COMMIT, '2026-11-02');
  assert.deepStrictEqual(out.tickers, ['BAJAJ_AUTO', 'HEGAM', 'M&M', 'NEWCO', 'OLDCO', 'ONIDA', 'TCS']);
  assert.deepStrictEqual(out.aliases, { HEG: 'HEGAM', MIRCELECTR: 'ONIDA' });
  const w = {};
  new Function('window', out.text)(w);
  assert.strictEqual(w.SB_LOGO_TICKERS, 'BAJAJ_AUTO HEGAM M&M NEWCO OLDCO ONIDA TCS');
  assert.deepStrictEqual(w.SB_LOGO_SOURCE.urls, [
    'https://cdn.jsdelivr.net/gh/dharunashokkumar/indian-listed-company-logos@' + COMMIT + '/data/logos/nse/',
    'https://raw.githubusercontent.com/dharunashokkumar/indian-listed-company-logos/' + COMMIT + '/data/logos/nse/']);
  assert.deepStrictEqual([w.SB_LOGO_SOURCE.count, w.SB_LOGO_SOURCE.built, w.SB_LOGOS], [7, '2026-11-02', {}]);
  assert.throws(() => buildLogos(dir, 'main', 'x'), /40-character commit/, 'always pinned to one version');
  assert.throws(() => buildLogos(os.tmpdir(), COMMIT, 'x'), /no data\/logos\/nse/);
});

test('web/data/logos.js: pinned, loads, and covers the saved copy\'s Main stocks', () => {
  const w = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'web', 'data', 'logos.js'), 'utf8'))(w);
  assert.match(w.SB_LOGO_SOURCE.commit, /^[0-9a-f]{40}$/);
  w.SB_LOGO_SOURCE.urls.forEach((u) => assert.ok(u.indexOf(w.SB_LOGO_SOURCE.commit) > 0, u));
  const set = new Set(w.SB_LOGO_TICKERS.split(' '));
  assert.ok(set.size > 3000, String(set.size));
  const d = {};
  new Function('window', fs.readFileSync(path.join(ROOT, 'web', 'data', 'dashboard.js'), 'utf8'))(d);
  const i = d.SB_DATA.main.cols.indexOf('sym');
  const syms = [...new Set(d.SB_DATA.main.rows.map((r) => String(r[i] || '').toUpperCase()).filter(Boolean))];
  const found = syms.filter((s) => set.has(s) || set.has(s.replace(/-/g, '_')) || set.has(w.SB_LOGO_ALIASES[s]));
  assert.ok(found.length / syms.length > 0.9, found.length + ' of ' + syms.length);
});

/** web/ui/core.js in a small sandbox: { ui, fire(type, img) } */
function loadUi(logos) {
  const handlers = {};
  const window = Object.assign({}, logos);
  const ctx = { window, console, document: { addEventListener: (t, fn) => { handlers[t] = fn; }, querySelector: () => null } };
  ctx.window.document = ctx.document;
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(ROOT, 'web', 'ui', 'core.js'), 'utf8'), ctx);
  return { ui: window.SB.ui, fire: (type, el) => handlers[type]({ target: el }) };
}
function img(src, alt) {
  const attrs = { src: src, 'data-alt': alt };
  const parent = { textContent: '', getAttribute: () => 'TC' };
  return { attrs, parent, parentNode: parent, classList: { contains: (c) => c === 'logo-img' },
    getAttribute: (k) => attrs[k], setAttribute: (k, v) => { attrs[k] = v; } };
}
const J = (x) => JSON.parse(JSON.stringify(x));      // arrays made inside the sandbox
const SRC = { urls: ['https://cdn.example/x@' + COMMIT + '/nse/', 'https://raw.example/' + COMMIT + '/nse/'] };

test('logoHtml: by NSE symbol only (- or _, old tickers), CDN first then GitHub, else the monogram', () => {
  const { ui } = loadUi({ SB_LOGO_SOURCE: SRC, SB_LOGO_TICKERS: 'TCS BAJAJ_AUTO M&M HEGAM', SB_LOGO_ALIASES: { HEG: 'HEGAM' }, SB_LOGOS: {} });
  assert.deepStrictEqual(J(ui.logoUrls('TCS')), [SRC.urls[0] + 'NSE_TCS.svg', SRC.urls[1] + 'NSE_TCS.svg']);
  assert.strictEqual(ui.logoUrls('BAJAJ-AUTO')[0], SRC.urls[0] + 'NSE_BAJAJ_AUTO.svg');
  assert.strictEqual(ui.logoUrls('M&M')[0], SRC.urls[0] + 'NSE_M%26M.svg');
  assert.strictEqual(ui.logoUrls('HEG')[0], SRC.urls[0] + 'NSE_HEGAM.svg');
  assert.deepStrictEqual(J(ui.logoUrls('NEWIPO')), []);
  const h = ui.logoHtml('TCS');
  assert.match(h, /^<span class="logo" data-mono="TC"><img class="logo-img" src="https:\/\/cdn\.example\/[^"]+NSE_TCS\.svg" data-alt="https:\/\/raw\.example\/[^"]+NSE_TCS\.svg" alt="" loading="lazy"/);
  assert.strictEqual(ui.logoHtml('NEWIPO', 'lg'), '<span class="logo lg" aria-hidden="true">NE</span>');
  assert.match(ui.stockCell('TCS', 'Tata Consultancy'), /class="logo-img"/);
});

test('logo load errors: the next address, then the monogram; an address that only fails is tried last', () => {
  const { ui, fire } = loadUi({ SB_LOGO_SOURCE: SRC, SB_LOGO_TICKERS: 'TCS INFY WIPRO HCLTECH', SB_LOGO_ALIASES: {}, SB_LOGOS: {} });
  const a = img(SRC.urls[0] + 'NSE_TCS.svg', SRC.urls[1] + 'NSE_TCS.svg');
  fire('error', a);
  assert.deepStrictEqual([a.attrs.src, a.attrs['data-alt']], [SRC.urls[1] + 'NSE_TCS.svg', '']);
  fire('error', a);
  assert.strictEqual(a.parent.textContent, 'TC', 'both failed: the monogram');
  ['INFY', 'WIPRO'].forEach((s) => fire('error', img(SRC.urls[0] + 'NSE_' + s + '.svg', '')));
  assert.strictEqual(ui.logoUrls('HCLTECH')[0], SRC.urls[1] + 'NSE_HCLTECH.svg', 'the CDN failed 3 times, never loaded: GitHub first');
  assert.strictEqual(ui.logoUrls('HCLTECH')[1], SRC.urls[0] + 'NSE_HCLTECH.svg');
  // one success and the CDN is first again
  fire('load', img(SRC.urls[0] + 'NSE_INFY.svg', ''));
  assert.strictEqual(ui.logoUrls('HCLTECH')[0], SRC.urls[0] + 'NSE_HCLTECH.svg');
  // a hand-checked logo wins
  const { ui: ui2 } = loadUi({ SB_LOGO_SOURCE: SRC, SB_LOGO_TICKERS: 'TCS', SB_LOGOS: { 'NSE:TCS': { url: 'https://tcs.example/logo.svg', verified: true } } });
  assert.deepStrictEqual(J(ui2.logoUrls('TCS')), ['https://tcs.example/logo.svg']);
});
