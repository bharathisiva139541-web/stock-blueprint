'use strict';
// tools/export_xlsx.py history60_data() (the saved copy web/data/history60.js) gives the same candles as
// Code.gs ab_site_history60_ (the live site feed part 'history60') on one workbook: random prices, splits,
// gaps, a seam GOOGLEFINANCE prices differently, stocks History30 lacks. Skipped without python3.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');

const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
const FEED = 'feed-token-0123456789';

function weekdays(n, last) {
  const out = [];
  for (let t = Date.parse(last + 'T00:00:00Z'); out.length < n; t -= 86400000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.unshift(d.toISOString().slice(0, 10));
  }
  return out;
}

function workbook() {
  let seed = 7;
  const rnd = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  const days = weekdays(45, '2026-10-28');
  const syms = Array.from({ length: 40 }, (_, i) => 'S' + String(i).padStart(3, '0'));
  const nse = {}, gf = {};
  syms.forEach((s, k) => {
    let px = 20 + rnd() * 2000, prev = null;
    const splitAt = k % 7 === 0 ? 10 + (k % 20) : -1;                     // a 1:2 split for some
    const seam = k % 5 === 0 ? 1 + (rnd() - 0.5) / 5 : 1;                  // GOOGLEFINANCE priced differently for some
    nse[s] = {};
    days.forEach((d, i) => {
      if (i === splitAt) { px = px / 2; prev = prev / 2; }
      const o = Math.round(px * (1 + (rnd() - 0.5) / 50) * 100) / 100, c = Math.round(px * (1 + (rnd() - 0.5) / 25) * 100) / 100;
      const h = Math.round(Math.max(o, c) * (1 + rnd() / 40) * 100) / 100, l = Math.round(Math.min(o, c) * (1 - rnd() / 40) * 100) / 100;
      const v = k % 9 === 4 && i % 6 === 0 ? 'NaN' : Math.floor(rnd() * 900000);
      if (!(k % 11 === 3 && i % 8 === 2)) nse[s][d] = [o, h, l, c, v, prev === null ? 'NaN' : prev].join(' ');   // some days missing
      prev = c;
      px = c;
      if (i >= 20 && k % 13 !== 6) (gf[s] = gf[s] || []).push([d, o * seam, h * seam, l * seam, c * seam, typeof v === 'number' ? v : '']);
    });
  });
  const desc = days.slice().reverse();
  const h60 = [['note'], ['Symbol'].concat(desc), ['(linked)'].concat(desc.map((d, i) => (i === desc.length - 1 || d === days[30] ? '' : 'Y')))];
  syms.concat(['XGONE']).forEach((s) => h60.push([s].concat(desc.map((d) => (nse[s] || {})[d] || ''))));
  const h30 = [['Symbol', 'Date', 'Open', 'High', 'Low', 'Close', 'Volume']];
  Object.keys(gf).forEach((s) => gf[s].forEach((r) => h30.push([s].concat(r))));
  const pd = [['Name', '', '', 'Symbol']].concat(syms.map((s) => ['Co', '', '', s]));
  const main = [['Main'], ['Checkbox', 'StockName', 'SYMBOL']].concat(syms.map((s) => [false, 'Co', s]));
  return { h60, h30, pd, main };
}

test('export_xlsx.py history60_data = Code.gs site feed part history60 (python)', { skip: !py && 'python3 not installed' }, () => {
  const w = workbook();
  const env = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: w.main }, { name: 'PatternData', rows: w.pd },
    { name: 'History30', rows: w.h30, numFmts: w.h30.map((r, i) => (i ? [null, 'yyyy-mm-dd'] : [])) }, { name: 'History60', rows: w.h60 }] },
  { now: Date.UTC(2026, 9, 28, 14, 30), props: { AB_FEED_TOKEN: FEED } });
  const r = env.post({ action: 'site', part: 'history60', token: FEED });
  assert.strictEqual(r.ok, true, r.error);
  const gs = r.data;
  assert.ok(Object.keys(gs.bars).length >= 30 && gs.dates.length === 35 && gs.bars.S006.length === 15, Object.keys(gs.bars).length + ' / ' + gs.dates.length);
  assert.ok(!gs.bars.XGONE, 'not in PatternData');

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'h60-')), 'wb.json');
  fs.writeFileSync(file, JSON.stringify({ sheets: [{ name: 'PatternData', rows: w.pd }, { name: 'History60', rows: w.h60 },
    { name: 'History30', rows: w.h30, dates: w.h30.map((_, i) => [i, 1]).slice(1) }] }));
  const p = spawnSync(py, [path.join(__dirname, 'fixtures', 'export_history60_check.py'), file], { encoding: 'utf8', timeout: 60000 });
  assert.strictEqual(p.status, 0, (p.stderr || '').slice(-1500));
  const ex = JSON.parse(p.stdout);
  assert.deepStrictEqual(ex, JSON.parse(JSON.stringify(gs)));
});
