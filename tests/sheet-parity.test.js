'use strict';
// Parity: the JS ports must reproduce the sheet's own PatternData W (patterns)
// and X (FVG tags) for every symbol in the exported History30 snapshot.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const P = require('../web/lib/patterns.js');
const FVG = require('../web/lib/fvg.js');

const file = path.join(__dirname, '..', 'web', 'data', 'history.js');
const H = fs.existsSync(file) ? (() => { const w = {}; new Function('window', fs.readFileSync(file, 'utf8'))(w); return w.SB_HISTORY; })() : null;

function candlesOf(sym) {
  return H.bars[sym].map((b) => ({ t: H.dates[b[0]], o: b[1], h: b[2], l: b[3], c: b[4], v: b[5] }));
}
function last4(candles) {
  // the day tabs hold the last 4 candles of the past 15 calendar days; for a
  // fully-fetched symbol that equals the last 4 History30 bars
  return candles;
}

// Patterns added to Code.gs after the saved export was made: until a newer export
// contains them, the JS tags for them are left out of the comparison.
const NEW_TAGS = ['Bullish Harami + Inverted Hammer', 'Bullish Harami + Inverted Hammer (confirmed)'];
const EXPORT_HAS_NEW = !!H && Object.keys(H.sheetTags).some((k) => NEW_TAGS.some((t) => String(H.sheetTags[k][0] || '').indexOf(t) >= 0));
function dropNew(tags) {
  return EXPORT_HAS_NEW ? tags : P.splitTags(tags).filter((t) => NEW_TAGS.indexOf(t) < 0).join(', ');
}

test('patterns (col W) match the sheet for every symbol', { skip: !H && 'no web/data/history.js' }, () => {
  let n = 0; const bad = [];
  for (const sym of Object.keys(H.bars)) {
    const sheet = H.sheetTags[sym];
    if (!sheet) continue;
    const got = dropNew(P.latestTags(last4(candlesOf(sym))));
    n++;
    if (got !== String(sheet[0] || '')) bad.push(sym + ': sheet="' + sheet[0] + '" js="' + got + '"');
  }
  assert.ok(n > 1500, 'compared ' + n);
  assert.deepStrictEqual(bad.slice(0, 15), [], bad.length + ' mismatches of ' + n);
});

// FVG+Spring changed to the owner's broader rule (Oct 2026) after the saved export
// was made, so its tag is set aside here; tests/fvg-spring.test.js checks Code.gs = JS.
function dropSpring(tags) { return P.splitTags(tags).filter((t) => !/^FVG\+Spring/.test(t)).join(', '); }

test('FVG tags (col X) match the sheet for every symbol', { skip: !H && 'no web/data/history.js' }, () => {
  let n = 0; const bad = [];
  for (const sym of Object.keys(H.bars)) {
    const sheet = H.sheetTags[sym];
    if (!sheet) continue;
    const got = dropSpring(FVG.columnTags(candlesOf(sym)));
    n++;
    if (got !== dropSpring(String(sheet[1] || ''))) bad.push(sym + ': sheet="' + sheet[1] + '" js="' + got + '"');
  }
  assert.ok(n > 1500, 'compared ' + n);
  assert.deepStrictEqual(bad.slice(0, 15), [], bad.length + ' mismatches of ' + n);
});

const I = require('../web/lib/indicators.js');
test('10/21 EMA support tags (cols Y, AA) and ATR14 EMA (col Z) match the sheet', { skip: !H && 'no web/data/history.js' }, () => {
  let n = 0; const bad = [];
  for (const sym of Object.keys(H.bars)) {
    const s = H.sheetTags[sym];
    if (!s) continue;
    const c = candlesOf(sym);
    n++;
    const e10 = I.emaSupportTag(c, 10, 0.5), e21 = I.emaSupportTag(c, 21, 0.5);
    if (e10 !== String(s[2] || '')) bad.push(sym + ' 10EMA sheet="' + s[2] + '" js="' + e10 + '"');
    if (e21 !== String(s[4] || '')) bad.push(sym + ' 21EMA sheet="' + s[4] + '" js="' + e21 + '"');
    const atr = I.atrEmaLast(c, 14);
    const sheetAtr = s[3] === '' ? NaN : Number(s[3]);
    if (!(isNaN(atr) && isNaN(sheetAtr)) && Math.abs(Math.round(atr * 100) / 100 - sheetAtr) > 0.011) bad.push(sym + ' ATR sheet=' + s[3] + ' js=' + atr);
  }
  assert.ok(n > 1500);
  assert.deepStrictEqual(bad.slice(0, 15), [], bad.length + ' mismatches');
});

const S = require('../web/lib/strategy.js');
test('Pattern Dashboard confluence = non-empty count of the four PatternData cells', { skip: !H && 'no web/data/history.js' }, () => {
  let n = 0; const bad = [];
  for (const sym of Object.keys(H.bars)) {
    const s = H.sheetTags[sym];
    if (!s) continue;
    const want = [s[0], s[1], s[2], s[4]].filter((v) => !!v).length;
    const c = candlesOf(sym);
    if (dropNew(P.latestTags(c)) !== P.latestTags(c)) continue;   // a new pattern the old export cannot know
    const x = FVG.columnTags(c);
    if (dropSpring(x) !== x && !/FVG\+Spring/.test(String(s[1] || ''))) continue;   // FVG+Spring under the new rule
    const got = S.CONDITIONS.sheetConfluence.eval(S.buildContext({ sym }, c, c.length - 1), { min: 3, touchPct: 0.5 }).value;
    n++;
    if (got !== want) bad.push(sym + ' sheet=' + want + ' js=' + got);
  }
  assert.ok(n > 1500);
  assert.deepStrictEqual(bad.slice(0, 10), [], bad.length + ' mismatches');
});
