/* Stock Blueprint - the pattern guide (owner, 08-Nov-2026: "Make a PDF or powerpoint with ... charts for all the
   patterns, IPO bases which is valid, which is not valid ... so that I can teach my friend ... also preserve this: if we
   add a new pattern to our script, later we add the chart with rules to this PPT or PDF").

   One page per pattern: what it means, its rules (the thresholds the code uses - Code.gs / web/lib), and example
   charts marked VALID (the code finds the pattern) or NOT VALID (the code does not - and why).

   EVERY EXAMPLE IS CHECKED AGAINST THE REAL RULES by tests/pattern-guide.test.js: `check` says what the code must
   answer for these candles (web/lib/patterns.js = Code.gs col W, web/lib/fvg.js = Code.gs col X, Code.gs
   ab_ipoBaseSequence_ for IPO bases). A new pattern in the code without a page here fails that test.
   Build: `npm run guide` -> dist/guide/Stock-Blueprint-Pattern-Guide.pdf + .pptx (tools/pattern-guide/build.js).

   Candles: [open, high, low, close], oldest first; the last candle is "today" unless the page says otherwise.
   marks (drawing only): hl {index: label} highlighted candles; zone {from, bottom, top, label}; lines [{y, from, to,
   label, color, dash}]; rings [{i, at: 'low'|'high'|'close', color}]; notes [{i, text, at: 'high'|'low', color}]. */
'use strict';

// ---------------------------------------------------------------- helpers for the example candles
const r2 = (x) => Math.round(x * 100) / 100;
/** n candles drifting down to `to` (the open of the next candle), small bodies, every third one green. */
function down(n, to, stepPct) {
  const s = (stepPct || 0.6) / 100, out = [];
  let p = to * Math.pow(1 + s, n);
  for (let k = 0; k < n; k++) {
    const nxt = p / (1 + s);
    const green = k % 3 === 1;
    const o = green ? nxt * 0.998 : p, c = green ? p * 0.999 : nxt * 1.002;
    out.push([r2(o), r2(Math.max(o, c) * 1.003), r2(Math.min(o, c) * 0.997), r2(c)]);
    p = nxt;
  }
  return out;
}
/** n quiet candles around p (range ~1.1). */
function flat(n, p) {
  const out = [];
  for (let k = 0; k < n; k++) {
    const w = [0.2, -0.3, 0.1, -0.1, 0.3, -0.2, 0][k % 7];
    const o = p + w, c = p - w * 0.8 + (k % 2 ? 0.15 : -0.15);
    out.push([r2(o), r2(Math.max(o, c) + 0.35), r2(Math.min(o, c) - 0.35), r2(c)]);
  }
  return out;
}
/** The FVG pages' start: 14 quiet candles, then A, B (a big green) and C - C's low (102.6) is above A's high (101):
 *  a 3-candle FVG on C (index 16), zone 101 - 102.6. */
function fvgStart() {
  return flat(14, 100).concat([[100, 101.0, 99.7, 100.6], [100.8, 105.0, 100.6, 104.6], [104.6, 106.0, 102.6, 105.6]]);
}
const FVG_ZONE = { from: 16, bottom: 101.0, top: 102.6, label: 'FVG zone' };

// IPO pages: listing day + the base examples
const IPO = {
  // Base 1 = listing high 110; broken on 5; candle 7 reaches 6's high 116 and closes under it -> Base 2 = 116 (Rejection)
  cpplus: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 109.5, 105, 108], [108, 109.5, 106, 109],
    [108, 114, 107.5, 113], [113, 116, 112, 115], [115, 118, 113, 114], [114, 115.5, 111, 112], [112, 114.5, 110.5, 113],
    [113, 115.8, 112, 115], [115, 115.9, 113, 114], [114, 118, 113.5, 117], [117, 120, 116, 119.5]],
  // candle 2's high (113) is above the listing high but it closes under it -> Base 1 = 113
  mvelectro: [[100, 110, 98, 106], [106, 113, 104, 108], [108, 112, 106, 110], [110, 112.5, 108, 111], [111, 112.8, 109, 112],
    [112, 112.9, 109.5, 110], [110, 112.5, 108.5, 112], [112, 116, 111.5, 115], [115, 118, 114, 117]],
  // candle 2 CLOSES above the listing high -> 110 is dropped; the rally peak 121 with 3 closes under it = Base 1
  indomim: [[100, 110, 98, 106], [107, 115, 106, 112], [112, 118, 111, 117], [117, 121, 116, 120], [119, 120, 116, 117],
    [117, 119, 114, 115], [115, 118, 113, 116], [116, 122, 115, 121.5], [121.5, 124, 120, 123]],
  // straight up after Base 1 breaks: no rejection, no pullback -> no Base 2 (Anlon)
  straight: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 109.5, 105, 108], [108, 109.5, 106, 109],
    [108, 114, 107.5, 113], [113, 116, 112, 115.5], [115.5, 118, 114, 117.5], [117.5, 121, 117, 120.5], [120.5, 124, 120, 123.5],
    [123.5, 127, 123, 126.5], [126.5, 130, 126, 129.5]],
  // the rally peaks at 122 (candle 8), five closes under it -> Base 2 = 122 (Peak Pullback); then 2A = 116 inside it
  peak: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 109.5, 105, 108], [108, 109.5, 106, 109],
    [108, 114, 107.5, 113], [113, 116, 112, 115.5], [115.5, 119, 114.5, 118.5], [118.5, 122, 118, 121], [120, 120, 116.5, 117],
    [117, 117, 113.5, 114], [114, 115, 111.5, 112], [112, 114, 110.5, 111], [111, 113, 110.2, 110.5], [110.5, 112.5, 110, 111],
    [111, 113.5, 110.5, 112], [112, 116, 111.5, 115], [115, 115, 112.5, 113], [113, 114, 111.5, 112], [112, 114.5, 111.5, 113],
    [113, 115, 112.5, 114], [114, 115.5, 113.5, 114.5], [114.5, 117, 114, 116.5], [116.5, 121, 116, 120], [120, 124, 119.5, 123.5]],
  // the peak 122 is taken out after 2 closes: not a base, and nothing after it -> no Base 2
  peakFail: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 109.5, 105, 108], [108, 109.5, 106, 109],
    [108, 114, 107.5, 113], [113, 116, 112, 115.5], [115.5, 119, 114.5, 118.5], [118.5, 122, 118, 121], [120, 120, 117.5, 119],
    [119, 121, 118, 120], [120, 124.5, 119.5, 124], [124, 127.5, 123.5, 127], [127, 130.5, 126.5, 130]],
  // a wick above Base 1 (110) is not a break - only a close above it is
  wick: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 112, 105, 108.5], [108.5, 109.8, 106, 109],
    [109, 109.5, 106.5, 108], [108, 109, 106, 107.5]],
  closeAbove: [[100, 110, 98, 105], [104, 108, 102, 106], [106, 109, 104, 107], [107, 112, 105, 108.5], [108.5, 109.8, 106, 109],
    [109, 112.5, 108.5, 111.5], [111.5, 114, 111, 113]]
};


/** Market structure pages (owner, 10-Nov-2026 - the PC's structure.py with swings of 5 candles): a downtrend of lower
 *  highs / lows (legs of 6 candles), a CHoCH move with an FVG in it, then `kind`: 'ok' = the first pullback into that FVG
 *  with a Spring; 'bos' = a new high (BOS) first, then the pullback; 'above' = the Spring on an FVG formed above the CHoCH
 *  level, in the premium half of the move; 'slight' (11-Nov-2026) = an FVG reaching a little above the CHoCH level whose
 *  middle is still under the 50 % line (discount); 'newer' (11-Nov-2026, the owner's SUPREMEIND) = a second FVG formed
 *  above (premium), the pullback runs through it and FIRST touches the discount FVG of the CHoCH move (the last candle);
 *  'down2' = only 2 lower highs before.
 *  -> { candles, at: {highs, lows, lvl, hi, b, f, bottom, top, peak, bos, c2, low, f2, bottom2, top2} } */
function smc(kind) {
  const out = [], at = { highs: [], lows: [] };
  let prev = 165;
  const put = (o, h, l, c) => out.push([r2(o), r2(h), r2(l), r2(c)]);
  const go = (to, k) => {
    for (let j = 1; j <= k; j++) {
      const x = prev + (to - prev) * j / k;
      put(prev, Math.max(prev, x) + 0.3, Math.min(prev, x) - 0.3, x);
      prev = x;
    }
  };
  const legs = kind === 'down2' ? [150, 160, 142, 152, 134, 144, 120] : [150, 160, 142, 152, 134, 144, 126, 136, 120];
  legs.forEach((to, j) => { go(to, 6); (j % 2 ? at.highs : at.lows).push(out.length - 1); });
  const L = 120, lvl = r2(legs[legs.length - 2] + 0.3);
  at.lvl = lvl; at.hi = at.highs[at.highs.length - 1]; at.low = out.length - 1;
  put(L, L + 1.3, L - 0.3, L + 1);                          // A
  put(L + 1, L + 10.3, L + 0.7, L + 10);                    // B - a big green
  // C: its low over A's high = the FVG ('slight': no FVG here - its zone is the only discount zone of the move, so the 2nd-zone
  // rule of 12-Nov-2026 does not wait for a deeper one)
  put(L + 10, L + 13.3, kind === 'slight' ? L + 1.2 : L + 6.5, L + 13);
  at.f = out.length - 1; at.bottom = r2(L + 1.3); at.top = r2(L + 6.5);
  put(L + 13, lvl + 2, L + 12.7, lvl + 1.7);                // D: CLOSES above the last lower high = CHoCH
  at.b = out.length - 1;
  prev = lvl + 1.7;
  let base = L, peak = 0;
  if (kind === 'above' || kind === 'newer') {
    put(prev, prev + 1.3, prev - 0.3, prev + 1);            // an FVG above the CHoCH level (the premium half of the move)
    put(prev + 1, prev + 7.3, prev + 0.7, prev + 7);
    put(prev + 7, prev + 9.3, prev + 4.5, prev + 9);
    if (kind === 'above') { at.f = out.length - 1; at.bottom = r2(prev + 1.3); at.top = r2(prev + 4.5); base = at.top - 6.5; }
    else { at.f2 = out.length - 1; at.bottom2 = r2(prev + 1.3); at.top2 = r2(prev + 4.5); }
    prev = prev + 9;
  }
  if (kind === 'slight') {
    put(prev, prev + 3.3, prev, prev + 3);                  // E: its low over C's high = an FVG reaching above the CHoCH level
    at.f = out.length - 1; at.bottom = out[at.f - 2][1]; at.top = out[at.f][2];
    base = at.top - 6.5;
    prev = prev + 3;
    peak = 156;                                             // a move high far enough up: the zone's middle under the 50 % line
  }
  peak = peak || prev + 8;
  go(peak, 3);
  at.peak = out.length - 1;
  if (kind === 'bos') {
    go(base + 14, 6);
    go(peak + 6, 4);                                        // closes above the peak = BOS
    at.bos = out.findIndex((c, i) => i > at.peak + 5 && c[3] > peak + 0.3);
  }
  go(base + 8, 6);                                          // the pullback
  put(base + 8, base + 8.3, base + 4.8, base + 5);          // c1 (red) - 'newer': the first touch of the discount FVG, the end
  at.c2 = out.length - 1;
  if (kind !== 'newer') {
    put(base + 5.3, base + 5.6, base + 3, base + 5.1);      // c2 = the Spring, its low in the zone
    at.c2 = out.length - 1;
  }
  // the move (owner, 11-Nov-2026): from the final low to the highest high before the entry candle - its 50 % line
  at.moveHigh = Math.max.apply(null, out.slice(at.low, at.c2).map((c) => c[1]));
  at.finalLow = Math.min.apply(null, out.slice(at.hi + 1, at.b + 1).map((c) => c[2]));
  at.half = r2((at.moveHigh + at.finalLow) / 2);
  return { candles: out, at };
}
function smcMarks(x, extra) {
  const a = x.at, m = { zone: { from: a.f, bottom: a.bottom, top: a.top, label: 'FVG' },
    lines: [{ y: a.lvl, from: a.hi, to: a.b, label: 'CHoCH ' + a.lvl, dash: true },
      { y: a.half, from: a.low, to: a.c2, label: '50% ' + a.half, dash: true, color: '#ffd166' }].concat(a.f2 ? [
      { y: a.top2, from: a.f2, to: a.c2 - 1, label: 'FVG 2 (premium)', dash: true, color: '#ff8a80' },
      { y: a.bottom2, from: a.f2, to: a.c2 - 1, dash: true, color: '#ff8a80' }] : []),
    hl: { [a.b]: 'CHoCH', [a.c2]: a.f2 ? '1st touch' : 'Spring' },
    rings: a.highs.slice(1).map((i) => ({ i, at: 'high', color: '#8fb4ff' })).concat(a.lows.slice(1).map((i) => ({ i, at: 'low', color: '#8fb4ff' }))) };
  return Object.assign(m, extra || {});
}
const SMC = { ok: smc('ok'), bos: smc('bos'), above: smc('above'), down2: smc('down2'), slight: smc('slight'), newer: smc('newer') };

// ---------------------------------------------------------------- the pages
const SECTIONS = [
  { id: 'W', title: 'Candlestick patterns', ta: 'மெழுகுவர்த்தி (Candle) பேட்டர்ன்கள்', where: 'Main / PatternData - "Pattern" column (col W), daily candles' },
  { id: 'X', title: 'FVG patterns', ta: 'FVG (Fair Value Gap) பேட்டர்ன்கள்', where: 'Main / PatternData - "FVG" column (col X), daily candles; 4H / W from Zerodha Kite' },
  { id: 'S', title: 'Market structure setups', ta: 'Market structure (CHoCH / BOS) setup-கள்', where: 'Patterns & FVG page - "CHoCH + FVG setups" (your PC program, Zerodha Kite 4H / D / W); Backtest Lab step 2; Strategy Settings' },
  { id: 'IPO', title: 'IPO bases', ta: 'IPO Base-கள்', where: 'IPOs tab - IPO Base / IPO Base 2 / IPO Base 2A / Active Base columns' }
];

const PAGES = [
  // ======================================================== candlestick patterns (col W)
  {
    id: 'spring', section: 'W', title: 'Spring', tags: ['Spring'],
    ta: 'பெரிய சிவப்பு candle-க்குப் பிறகு, அடுத்த candle அதன் low-ஐ உடைத்துக் கீழே போய், மீண்டும் மேலே close ஆகிறது - ' +
      'கீழே இருந்த stop-loss-களைப் பிடித்துவிட்டுத் திரும்புவது (false breakdown).',
    rules: [
      'c1 = சிவப்பு candle; body ≥ open-இன் 0.5%',
      'c2-இன் low, c1-இன் low-ஐவிடக் குறைந்தது 0.10% கீழே',
      'c2 close > c1 low (மீண்டும் உள்ளே வந்து close)',
      'c2 body < c1 body-யின் 30% (சிறிய candle)',
      'c2 high ≤ c1 low + c1 range-இன் 50% (அதிகம் மேலே போகக்கூடாது)'
    ],
    examples: [
      { ok: true, label: 'Spring', why: 'c1 low-க்குக் கீழே போய், மீண்டும் அதற்கு மேலே close; சிறிய body',
        candles: down(6, 100).concat([[100, 100.4, 96.8, 97], [96.9, 97.6, 96.0, 97.3]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 96.8, from: 6, to: 7, label: 'c1 low', dash: true }] },
        check: { type: 'w', tag: 'Spring' } },
      { ok: false, label: 'Close c1 low-க்குக் கீழே', why: 'c2 மீண்டும் c1 low-க்கு மேலே வரவில்லை - இது breakdown',
        candles: down(6, 100).concat([[100, 100.4, 96.8, 97], [96.9, 97.2, 95.8, 96.5]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 96.8, from: 6, to: 7, label: 'c1 low', dash: true }], rings: [{ i: 7, at: 'close' }] },
        check: { type: 'w', tag: 'Spring' } },
      { ok: false, label: 'c2 body பெரியது', why: 'c2 body (2.0) ≥ c1 body-யின் 30% (0.9) - Spring அல்ல',
        candles: down(6, 100).concat([[100, 100.4, 96.8, 97], [96.2, 98.4, 96.0, 98.2]]), marks: { hl: { 6: 'c1', 7: 'c2' }, rings: [{ i: 7, at: 'close' }] },
        check: { type: 'w', tag: 'Spring' } }
    ]
  },
  {
    id: 'springq', section: 'W', title: 'Spring?', tags: ['Spring?'],
    ta: 'இன்று ஒரு பெரிய சிவப்பு candle, low-க்கு அருகிலேயே close. நாளை Spring உருவாகலாம் - முன்னெச்சரிக்கை (watch).',
    rules: [
      'இன்றைய candle சிவப்பு; body ≥ open-இன் 1.5%',
      'கீழ் wick ≤ candle range-இன் 25% (low அருகே close)',
      'ஒரே ஒரு candle - நாளை Spring ஆகிறதா என்று பாருங்கள்'
    ],
    examples: [
      { ok: true, label: 'Spring?', why: 'body 1.8%, கீழ் wick 12% - low அருகே close',
        candles: down(6, 100).concat([[100, 100.3, 97.9, 98.2]]), marks: { hl: { 6: 'இன்று' } }, check: { type: 'w', tag: 'Spring?' } },
      { ok: false, label: 'நீண்ட கீழ் wick', why: 'கீழ் wick range-இன் 45% - வாங்குபவர்கள் ஏற்கனவே தள்ளிவிட்டார்கள்',
        candles: down(6, 100).concat([[100, 100.3, 96.5, 98.2]]), marks: { hl: { 6: 'இன்று' }, rings: [{ i: 6, at: 'low' }] }, check: { type: 'w', tag: 'Spring?' } },
      { ok: false, label: 'Body சிறியது', why: 'body 1.0% < 1.5%',
        candles: down(6, 100).concat([[100, 100.2, 98.9, 99]]), marks: { hl: { 6: 'இன்று' } }, check: { type: 'w', tag: 'Spring?' } }
    ]
  },
  {
    id: 'piercing', section: 'W', title: 'Piercing', tags: ['Piercing'],
    ta: 'சிவப்பு candle-க்குப் பின் gap down-ஆகத் திறந்து, முந்தைய சிவப்பு body-யின் பாதிக்கு மேலே close ஆகும் பச்சை candle.',
    rules: [
      'c1 சிவப்பு',
      'c2 open < c1 low (கீழே திறப்பு)',
      'c2 close > c1 body-யின் நடுப்புள்ளி',
      'c2 close < c1 open (முழுவதும் மூடவில்லை - மூடினால் Engulfing)'
    ],
    examples: [
      { ok: true, label: 'Piercing', why: 'கீழே திறந்து, c1 body நடுவுக்கு மேலே (98.5) close 99.0',
        candles: down(6, 100).concat([[100, 100.4, 96.6, 97], [96.2, 99.4, 96.0, 99.0]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 98.5, from: 6, to: 7, label: 'c1 நடு', dash: true }] }, check: { type: 'w', tag: 'Piercing' } },
      { ok: false, label: 'நடுவுக்குக் கீழே close', why: 'c2 close 98.0 < c1 நடு 98.5',
        candles: down(6, 100).concat([[100, 100.4, 96.6, 97], [96.2, 98.4, 96.0, 98.0]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 98.5, from: 6, to: 7, label: 'c1 நடு', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'Piercing' } }
    ]
  },
  {
    id: 'engulfing', section: 'W', title: 'Bullish Engulfing', tags: ['Bullish Engulfing'],
    ta: 'பச்சை candle-இன் body, முந்தைய சிவப்பு candle-இன் body-யை முழுவதும் விழுங்குகிறது.',
    rules: [
      'c1 சிவப்பு, c2 பச்சை',
      'c2 open ≤ c1 close மற்றும் c2 close ≥ c1 open',
      'c2 body > c1 body'
    ],
    examples: [
      { ok: true, label: 'Bullish Engulfing', why: 'c2 body (2.8) c1 body (2.0)-ஐ முழுவதும் மூடுகிறது',
        candles: down(6, 100).concat([[100, 100.4, 97.6, 98], [97.8, 100.8, 97.5, 100.6]]), marks: { hl: { 6: 'c1', 7: 'c2' } }, check: { type: 'w', tag: 'Bullish Engulfing' } },
      { ok: false, label: 'c1 open-ஐ அடையவில்லை', why: 'c2 close 99.6 < c1 open 100',
        candles: down(6, 100).concat([[100, 100.4, 97.6, 98], [97.8, 99.9, 97.5, 99.6]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 100, from: 6, to: 7, label: 'c1 open', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'Bullish Engulfing' } }
    ]
  },
  {
    id: 'harami', section: 'W', title: 'Bullish Harami', tags: ['Bullish Harami'],
    ta: 'பெரிய சிவப்பு candle-இன் body-க்குள்ளேயே ஒரு சிறிய பச்சை candle - விற்பனை வேகம் குறைகிறது.',
    rules: [
      'c1 சிவப்பு, c2 பச்சை (Engulfing ஆக இல்லாதபோது)',
      'c2 body முழுவதும் c1 body-க்குள் (c2 open ≥ c1 close, c2 close ≤ c1 open)',
      'c2 low > c1 low',
      'c2 body < c1 body'
    ],
    examples: [
      { ok: true, label: 'Bullish Harami', why: 'c2 body c1 body-க்குள்; c2 low (97.2) > c1 low (96.6)',
        candles: down(6, 100).concat([[100, 100.3, 96.6, 97], [97.4, 98.9, 97.2, 98.6]]), marks: { hl: { 6: 'c1', 7: 'c2' } }, check: { type: 'w', tag: 'Bullish Harami' } },
      { ok: false, label: 'c2 low c1 low-க்குக் கீழே', why: 'c2 low 96.3 < c1 low 96.6',
        candles: down(6, 100).concat([[100, 100.3, 96.6, 97], [97.4, 98.9, 96.3, 98.6]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 96.6, from: 6, to: 7, label: 'c1 low', dash: true }], rings: [{ i: 7, at: 'low' }] }, check: { type: 'w', tag: 'Bullish Harami' } }
    ]
  },
  {
    id: 'tweezer', section: 'W', title: 'Tweezer Bottoms', tags: ['Tweezer Bottoms'],
    ta: 'இரண்டு candle-களும் ஒரே low-இல் நின்று திரும்புகின்றன - அந்த விலையில் வலுவான support.',
    rules: [
      'c1 சிவப்பு, c2 பச்சை',
      'இரண்டு low-களும் 1.25%-க்குள் சமம்',
      'body அளவு ஒத்திருக்கும் (வித்தியாசம் ≤ பெரிய body-யின் 25%)',
      'இரண்டுக்கும் கீழ் wick உண்டு, அளவு ஒத்திருக்கும் (வித்தியாசம் ≤ 30%)'
    ],
    examples: [
      { ok: true, label: 'Tweezer Bottoms', why: 'low 97.0 / 97.1 - ஒரே இடத்தில் இரண்டு முறை நிராகரிப்பு',
        candles: down(6, 100).concat([[100, 100.3, 97, 98], [98.1, 100.3, 97.1, 100]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 97.05, from: 6, to: 7, label: 'ஒரே low', dash: true }] }, check: { type: 'w', tag: 'Tweezer Bottoms' } },
      { ok: false, label: 'Low-கள் வேறுபடுகின்றன', why: 'c2 low 95.5 - c1 low-ஐவிட 1.5% கீழே (> 1.25%)',
        candles: down(6, 100).concat([[100, 100.3, 97, 98], [98.1, 100.3, 95.5, 100]]), marks: { hl: { 6: 'c1', 7: 'c2' }, rings: [{ i: 7, at: 'low' }] }, check: { type: 'w', tag: 'Tweezer Bottoms' } }
    ]
  },
  {
    id: 'tdlr', section: 'W', title: 'Three Day Low Rejection', tags: ['Three Day Low Rejection'],
    ta: 'மூன்று சிவப்பு நாட்கள்; ஒவ்வொரு நாளும் முந்தைய low-ஐ உடைக்கிறது, ஆனால் அதற்கு மேலேயே close - கீழே தொடர்ந்து நிராகரிப்பு.',
    rules: [
      'மூன்று candle-களும் சிவப்பு, ஒவ்வொன்றின் body ≥ 1%',
      'நாள் 2: low < நாள் 1 low, ஆனால் close > நாள் 1 low',
      'நாள் 3: low < நாள் 2 low, ஆனால் close > நாள் 2 low'
    ],
    examples: [
      { ok: true, label: 'Three Day Low Rejection', why: 'ஒவ்வொரு நாளும் கீழே போய் முந்தைய low-க்கு மேலே close',
        candles: down(5, 100).concat([[100, 100.2, 98.4, 98.8], [99.8, 100.0, 97.9, 98.6], [99.4, 99.6, 97.4, 98.2]]), marks: { hl: { 5: 'நாள் 1', 6: 'நாள் 2', 7: 'நாள் 3' } }, check: { type: 'w', tag: 'Three Day Low Rejection' } },
      { ok: false, label: 'நாள் 3 கீழே close', why: 'நாள் 3 close 97.7 < நாள் 2 low 97.9',
        candles: down(5, 100).concat([[100, 100.2, 98.4, 98.8], [99.8, 100.0, 97.9, 98.6], [99.0, 99.2, 97.4, 97.7]]), marks: { hl: { 5: 'நாள் 1', 6: 'நாள் 2', 7: 'நாள் 3' }, lines: [{ y: 97.9, from: 6, to: 7, label: 'நாள் 2 low', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'Three Day Low Rejection' } }
    ]
  },
  {
    id: 'morningstar', section: 'W', title: 'Morningstar', tags: ['Morningstar'],
    ta: 'பெரிய சிவப்பு, பிறகு சிறிய "நட்சத்திர" candle, பிறகு பெரிய பச்சை - மூன்று candle திருப்பம்.',
    rules: [
      'c1 சிவப்பு, body ≥ 2%, கீழ் wick ≤ range-இன் 30%',
      'c2 body ≤ c1 body-யின் 30% (சிறியது)',
      'c3 பச்சை, body ≥ 2%',
      'c3 close ≥ c1 body-யின் நடுப்புள்ளி'
    ],
    examples: [
      { ok: true, label: 'Morningstar', why: 'c3 close 99.2 > c1 நடு 98.5',
        candles: down(5, 100).concat([[100, 100.4, 96.6, 97], [96.6, 97.2, 96.0, 96.9], [96.9, 99.4, 96.8, 99.2]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 98.5, from: 5, to: 7, label: 'c1 நடு', dash: true }] }, check: { type: 'w', tag: 'Morningstar' } },
      { ok: false, label: 'c3 நடுவுக்குக் கீழே', why: 'c3 close 98.2 < 98.5 (body-உம் 2%-க்குக் குறைவு)',
        candles: down(5, 100).concat([[100, 100.4, 96.6, 97], [96.6, 97.2, 96.0, 96.9], [96.9, 98.4, 96.8, 98.2]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 98.5, from: 5, to: 7, label: 'c1 நடு', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'Morningstar' } }
    ]
  },
  {
    id: 'trio', section: 'W', title: 'Trio', tags: ['Trio'],
    ta: 'பெரிய சிவப்பு + Spring போன்ற c2, பிறகு c3 இரண்டு low-களையும் உடைத்து மீண்டும் மேலே close - இரட்டை false breakdown.',
    rules: [
      'c1 சிவப்பு, body ≥ 3%',
      'c2: low ≥ 0.25% c1 low-க்குக் கீழே, close > c1 low, body < c1 body-யின் 30%, high ≤ c1 high + c1 body-யின் 40%',
      'c3: low < c1 low மற்றும் c2 low',
      'c3 close > c1 low மற்றும் c2 low'
    ],
    examples: [
      { ok: true, label: 'Trio', why: 'c3 இரண்டு low-களுக்கும் கீழே போய், இரண்டுக்கும் மேலே close',
        candles: down(5, 100).concat([[100, 100.4, 96.6, 96.8], [96.5, 97.3, 96.2, 96.9], [96.8, 97.8, 95.6, 97.4]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 96.6, from: 5, to: 7, label: 'c1 low', dash: true }] }, check: { type: 'w', tag: 'Trio' } },
      { ok: false, label: 'c3 கீழேயே close', why: 'c3 close 96.0 < c1 low 96.6',
        candles: down(5, 100).concat([[100, 100.4, 96.6, 96.8], [96.5, 97.3, 96.2, 96.9], [96.8, 97.2, 95.6, 96.0]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 96.6, from: 5, to: 7, label: 'c1 low', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'Trio' } }
    ]
  },
  {
    id: 'fvg1234', section: 'W', title: 'FVG 1234', tags: ['FVG 1234'],
    ta: 'ஏற்றத்தில் 4 candle தொடர்: c1, c2 பச்சை, c3 சிறிய சிவப்பு pullback (c2-க்குள்), c4 பச்சையாகத் தொடர்கிறது.',
    rules: [
      'c1 பச்சை, body ≥ 2%',
      'c2 பச்சை, body ≥ 1%, கீழ் wick ≤ 1%, மேல் wick ≤ 0.3%; c2 low > c1 open',
      'c3 சிவப்பு, body c2-இன் 15%-க்குள் சமம், c2 range-க்குள்',
      'c4 பச்சை, body > c3 body, high ≤ c2 high, low c1 open-க்கும் c2 low-க்கும் இடையே'
    ],
    examples: [
      { ok: true, label: 'FVG 1234', why: 'c4 low (103.0) c1 open-க்கும் c2 low-க்கும் இடையே',
        candles: down(4, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.2, 103.2, 105.0], [104.8, 105.0, 103.3, 103.4], [103.4, 105.1, 103.0, 105.0]]), marks: { hl: { 4: 'c1', 5: 'c2', 6: 'c3', 7: 'c4' }, lines: [{ y: 100, from: 4, to: 7, label: 'c1 open', dash: true }] }, check: { type: 'w', tag: 'FVG 1234' } },
      { ok: false, label: 'c4 c1 open-க்குக் கீழே', why: 'c4 low 99.5 < c1 open 100',
        candles: down(4, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.2, 103.2, 105.0], [104.8, 105.0, 103.3, 103.4], [103.4, 105.1, 99.5, 105.0]]), marks: { hl: { 4: 'c1', 5: 'c2', 6: 'c3', 7: 'c4' }, lines: [{ y: 100, from: 4, to: 7, label: 'c1 open', dash: true }], rings: [{ i: 7, at: 'low' }] }, check: { type: 'w', tag: 'FVG 1234' } }
    ]
  },
  {
    id: 'fvg123', section: 'W', title: 'FVG 123', tags: ['FVG 123'],
    ta: 'ஏற்றத்தில் 3 candle: c1, c2 பச்சை (c2 low > c1 open = இடைவெளி), c3 சிவப்பு pullback அந்த இடைவெளிக்குள் வந்து c2 low-க்கு மேலே close.',
    rules: [
      'c1 பச்சை, body ≥ 2%; c2 low > c1 open',
      'c2 பச்சை, body ≥ 0.5%, கீழ் wick ≤ 1.5%, மேல் wick ≤ 3%',
      'c3 சிவப்பு, body c2-இன் 50%-க்குள், high ≤ c2 high',
      'c3 low c1 open-க்கும் c2 low-க்கும் இடையே; c3 close ≥ c2 low'
    ],
    examples: [
      { ok: true, label: 'FVG 123', why: 'c3 c2 low-க்குக் கீழே போய் (102.6), மேலே close (103.4)',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.6, 103.0, 105.0], [104.6, 104.9, 102.6, 103.4]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 103.0, from: 6, to: 7, label: 'c2 low', dash: true }] }, check: { type: 'w', tag: 'FVG 123' } },
      { ok: false, label: 'c3 c2 low-க்குக் கீழே close', why: 'c3 close 102.8 < c2 low 103.0',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.6, 103.0, 105.0], [104.0, 104.3, 102.5, 102.8]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 103.0, from: 6, to: 7, label: 'c2 low', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'FVG 123' } }
    ]
  },
  {
    id: 'fvg123t2', section: 'W', title: 'FVG 123 Type 2', tags: ['FVG 123 Type 2'],
    ta: 'FVG 123 போலவே, ஆனால் c3 பச்சையாகவும் இருக்கலாம் - இடைவெளிக்குள் dip செய்து c2 low-க்கு மேலே close.',
    rules: [
      'c1, c2: FVG 123 போலவே',
      'c3 close > c2 low (நிறம் எதுவாகவும்)',
      'c3 body c2-இன் 50%-க்குள்',
      'c3 low c1 open-க்கும் c2 low-க்கும் இடையே'
    ],
    examples: [
      { ok: true, label: 'FVG 123 Type 2', why: 'பச்சை c3, low 102.7 இடைவெளிக்குள், close 104.4',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.6, 103.0, 105.0], [103.2, 104.6, 102.7, 104.4]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 103.0, from: 6, to: 7, label: 'c2 low', dash: true }] }, check: { type: 'w', tag: 'FVG 123 Type 2' } },
      { ok: false, label: 'c3 c1 open-க்குக் கீழே', why: 'c3 low 99.6 < c1 open 100 - இடைவெளி முழுவதும் நிரம்பியது',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.5, 105.6, 103.0, 105.0], [103.2, 104.6, 99.6, 104.4]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 100, from: 5, to: 7, label: 'c1 open', dash: true }], rings: [{ i: 7, at: 'low' }] }, check: { type: 'w', tag: 'FVG 123 Type 2' } }
    ]
  },
  {
    id: 'fvgtouch', section: 'W', title: 'FVGTouch', tags: ['FVGTouch'],
    ta: 'c1 பெரிய பச்சை, c2 மிகச் சிறிய candle (doji போல), c3 சிவப்பு c2-இன் low-ஐத் தொட்டு மேலே close.',
    rules: [
      'c1 பச்சை, body ≥ 2%; c2 low > c1 open',
      'c2 body ≤ 1%, wick-கள் ≤ 2%',
      'c3 சிவப்பு, open < c2 high',
      'c3 low c1 open-க்கும் c2 low-க்கும் இடையே; c3 close ≥ c2 low'
    ],
    examples: [
      { ok: true, label: 'FVGTouch', why: 'c3 low 102.9 c2 low (103.2)-க்குக் கீழே, close 103.4 மேலே',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.6, 104.6, 103.2, 104.2], [104.3, 104.4, 102.9, 103.4]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 103.2, from: 6, to: 7, label: 'c2 low', dash: true }] }, check: { type: 'w', tag: 'FVGTouch' } },
      { ok: false, label: 'c3 c2 low-க்குக் கீழே close', why: 'c3 close 103.0 < c2 low 103.2',
        candles: down(5, 100, 0.6).concat([[100, 103.2, 99.8, 103], [103.6, 104.6, 103.2, 104.2], [104.3, 104.4, 102.9, 103.0]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'c3' }, lines: [{ y: 103.2, from: 6, to: 7, label: 'c2 low', dash: true }], rings: [{ i: 7, at: 'close' }] }, check: { type: 'w', tag: 'FVGTouch' } }
    ]
  },
  {
    id: 'hih', section: 'W', title: 'Bullish Harami + Inverted Hammer', tags: ['Bullish Harami + Inverted Hammer', 'Bullish Harami + Inverted Hammer (confirmed)'],
    ta: 'பெரிய சிவப்பு candle-க்குப் பின், அதன் கீழ்ப் பாதியில் ஒரு சிறிய candle - நீண்ட மேல் wick (inverted hammer) உடன். ' +
      'அடுத்த நாள் close அதன் high-க்கு மேலே = (confirmed).',
    rules: [
      'c1 பெரிய சிவப்பு: body ≥ range-இன் 65%',
      'பச்சை c2: body c1 body-யின் 10-50%, open c1 close-இலிருந்து 0.5%-க்குள், close c1 body கீழ்ப் பாதியில்',
      'மேல் wick ≥ body × 1.5; high ≥ c1 body-யின் 60% உயரம் (≤ c1 high + 15%)',
      'கீழ் wick ≤ range-இன் 10%; c2 low ≥ c1 low',
      'சிவப்பு c2-உம் சரி: open c1 close-இலிருந்து 1%-க்குள், high ≥ c1 open, கீழ் wick ≤ 20%',
      '(confirmed): அடுத்த நாள் close > c2 high'
    ],
    examples: [
      { ok: true, label: 'பச்சை c2', why: 'wick 99.2 வரை - c1 body-யின் 60% (98.8)-க்கு மேலே',
        candles: down(6, 100).concat([[100, 100.4, 96.8, 97], [97.1, 99.2, 97.0, 97.7]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 98.8, from: 6, to: 7, label: '60%', dash: true }] }, check: { type: 'w', tag: 'Bullish Harami + Inverted Hammer' } },
      { ok: true, label: '(confirmed)', why: 'அடுத்த நாள் close 99.8 > c2 high 99.2',
        candles: down(5, 100).concat([[100, 100.4, 96.8, 97], [97.1, 99.2, 97.0, 97.7], [99.0, 100.0, 98.8, 99.8]]), marks: { hl: { 5: 'c1', 6: 'c2', 7: 'உறுதி' }, lines: [{ y: 99.2, from: 6, to: 7, label: 'c2 high', dash: true }] }, check: { type: 'w', tag: 'Bullish Harami + Inverted Hammer (confirmed)' } },
      { ok: false, label: 'Wick குட்டை', why: 'wick 98.0 வரை மட்டும் - 60% (98.8) அடையவில்லை',
        candles: down(6, 100).concat([[100, 100.4, 96.8, 97], [97.1, 98.0, 97.0, 97.5]]), marks: { hl: { 6: 'c1', 7: 'c2' }, lines: [{ y: 98.8, from: 6, to: 7, label: '60%', dash: true }], rings: [{ i: 7, at: 'high' }] }, check: { type: 'w', tag: 'Bullish Harami + Inverted Hammer' } }
    ]
  },
  {
    id: 'twinstar', section: 'W', title: 'Twin Star Bottom', tags: ['Twin Star Bottom', 'Twin Star Bottom (confirmed)'],
    ta: 'சிவப்பு candle-க்குப் பின் இரண்டு சிறிய "நட்சத்திரங்கள்" ஒரே low-இல் - விலை அங்கே நிற்கிறது. அடுத்த close c1 open-க்கு மேலே = (confirmed).',
    rules: [
      'c1 சிவப்பு, body ≥ 1%',
      'இரண்டு நட்சத்திரங்கள்: body ≤ c1 body-யின் 35%; body மேல் பகுதி ≤ c1 close + c1 body-யின் 25%',
      'இரண்டு low-களும் 1%-க்குள்',
      '2வது நட்சத்திரத்தின் close ≥ 1வது நட்சத்திரத்தின் low',
      '(confirmed): அடுத்த நாள் close > c1 open'
    ],
    examples: [
      { ok: true, label: 'Twin Star Bottom', why: 'low 97.30 / 97.35 - ஒரே இடம்',
        candles: down(5, 100).concat([[100, 100.3, 97.8, 98], [98.0, 98.3, 97.3, 97.8], [97.7, 98.4, 97.35, 98.1]]), marks: { hl: { 5: 'c1', 6: '★', 7: '★' }, lines: [{ y: 97.3, from: 6, to: 7, label: 'ஒரே low', dash: true }] }, check: { type: 'w', tag: 'Twin Star Bottom' } },
      { ok: true, label: '(confirmed)', why: 'அடுத்த close 100.4 > c1 open 100',
        candles: down(4, 100).concat([[100, 100.3, 97.8, 98], [98.0, 98.3, 97.3, 97.8], [97.7, 98.4, 97.35, 98.1], [98.3, 100.6, 98.2, 100.4]]), marks: { hl: { 4: 'c1', 5: '★', 6: '★', 7: 'உறுதி' }, lines: [{ y: 100, from: 4, to: 7, label: 'c1 open', dash: true }] }, check: { type: 'w', tag: 'Twin Star Bottom (confirmed)' } },
      { ok: false, label: 'Low-கள் வேறு', why: '2வது நட்சத்திர low 96.0 - 1%-க்கு மேல் வித்தியாசம்',
        candles: down(5, 100).concat([[100, 100.3, 97.8, 98], [98.0, 98.3, 97.3, 97.8], [97.7, 98.4, 96.0, 98.1]]), marks: { hl: { 5: 'c1', 6: '★', 7: '★' }, rings: [{ i: 7, at: 'low' }] }, check: { type: 'w', tag: 'Twin Star Bottom' } }
    ]
  },

  // ======================================================== FVG patterns (col X)
  {
    id: 'fvg', section: 'X', title: 'FVG - Fair Value Gap (Unmitigated)', tags: ['FVG Unmitigated'],
    ta: 'வேகமான ஏற்றத்தில் candle C-இன் low, இரண்டு candle முன்பு (A)-இன் high-ஐவிட மேலே - நடுவில் வர்த்தகமே ஆகாத இடைவெளி. ' +
      'அந்த இடைவெளி (zone) பின்னர் support-ஆகச் செயல்படலாம். இதுவரை தொடப்படாதது = Unmitigated.',
    rules: [
      'C low > A high (A = C-க்கு இரண்டு candle முன்பு)',
      'இடைவெளி ≥ கடைசி 14 candle-களின் சராசரி range × 0.70 (சின்ன இடைவெளி கணக்கில் இல்லை)',
      'Zone = A high முதல் C low வரை',
      'Unmitigated: zone உருவான பின் எந்த candle-உம் அதன் மேல்கோட்டுக்குக் கீழே போகவில்லை',
      'கணக்கிட குறைந்தது 17 candle-கள் வேண்டும்'
    ],
    examples: [
      { ok: true, label: 'FVG (தொடப்படவில்லை)', why: 'C low 102.6 > A high 101.0 - இடைவெளி 1.6, போதுமான அளவு',
        candles: fvgStart().concat([[105.6, 106.8, 105.2, 106.4], [106.4, 107.0, 105.6, 106.0], [106.0, 106.9, 105.4, 106.6]]),
        marks: { hl: { 14: 'A', 15: 'B', 16: 'C' }, zone: FVG_ZONE }, check: { type: 'x', tag: 'FVG Unmitigated' } },
      { ok: false, label: 'இடைவெளி சிறியது', why: 'C low 101.3 - இடைவெளி 0.3 < தேவையான அளவு',
        candles: flat(14, 100).concat([[100, 101.0, 99.7, 100.6], [100.8, 105.0, 100.6, 104.6], [104.6, 106.0, 101.3, 105.6], [105.6, 106.8, 105.2, 106.4], [106.4, 107.0, 105.6, 106.0], [106.0, 106.9, 105.4, 106.6]]),
        marks: { hl: { 14: 'A', 15: 'B', 16: 'C' }, lines: [{ y: 101.0, from: 14, to: 16, label: 'A high', dash: true }, { y: 101.3, from: 16, to: 19, label: 'C low', dash: true }] }, check: { type: 'x', tag: 'FVG Unmitigated' } }
    ]
  },
  {
    id: 'firsttouch', section: 'X', title: 'FVG First Touch', tags: ['FVG First Touch'],
    ta: 'FVG உருவான பின், விலை முதல் முறையாகத் திரும்பி வந்து zone-இன் மேல்கோட்டுக்குக் கீழே போகும் நாள்.',
    rules: [
      'ஒரு புதிய FVG உருவாகியிருக்க வேண்டும்',
      'இன்றைய low < zone top; நேற்றைய low ≥ zone top (முதல் தொடுதல்)',
      'அதே zone-இன் 2வது தொடுதல் கணக்கில் இல்லை',
      'கடைசி 4 நாட்களில் நடந்தால் tag-இல் வரும் ("(Today)", "(2d ago)")'
    ],
    examples: [
      { ok: true, label: 'முதல் தொடுதல்', why: 'low 102.2 < zone top 102.6 - முதல் முறை',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.2, 102.9]]),
        marks: { zone: FVG_ZONE, rings: [{ i: 20, at: 'low' }] }, check: { type: 'x', tag: 'FVG First Touch' } },
      { ok: false, label: 'தொடவில்லை', why: 'low 102.8 - zone top (102.6)-க்கு மேலேயே',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.8, 103.1]]),
        marks: { zone: FVG_ZONE, rings: [{ i: 20, at: 'low' }] }, check: { type: 'x', tag: 'FVG First Touch' } }
    ]
  },
  {
    id: 'ftconfirmed', section: 'X', title: 'FVG First Touch Confirmed', tags: ['FVG First Touch Confirmed'],
    ta: 'First Touch நடந்த பின், ஒரு close அந்தத் தொடுதல் candle-இன் high-க்கு மேலே - zone-இலிருந்து விலை மீண்டும் மேலே போகிறது.',
    rules: [
      'முதலில் FVG First Touch',
      'பிறகு ஒரு close > தொடுதல் candle-இன் high',
      'கடைசி 4 நாட்களில் நடந்தால் tag-இல் வரும்'
    ],
    examples: [
      { ok: true, label: 'உறுதி', why: 'close 104.8 > தொடுதல் candle high 104.4',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.2, 102.9], [103.0, 105.0, 102.8, 104.8]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'தொடுதல்', 21: 'உறுதி' }, lines: [{ y: 104.4, from: 20, to: 21, label: 'தொடுதல் high', dash: true }] }, check: { type: 'x', tag: 'FVG First Touch Confirmed' } },
      { ok: false, label: 'உறுதி இல்லை', why: 'close 104.0 < தொடுதல் candle high 104.4',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.2, 102.9], [103.0, 104.3, 102.8, 104.0]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'தொடுதல்' }, lines: [{ y: 104.4, from: 20, to: 21, label: 'தொடுதல் high', dash: true }], rings: [{ i: 21, at: 'close' }] }, check: { type: 'x', tag: 'FVG First Touch Confirmed' } }
    ]
  },
  {
    id: 'fvgspring', section: 'X', title: 'FVG + Spring', tags: ['FVG+Spring'],
    ta: 'Spring (2-candle) ஒரு 3-candle FVG zone-இல் உருவாகிறது. உங்கள் இறுதி விதி (08-Nov-2026, படத்தில் சரிபார்த்தது): ' +
      'Spring low zone-க்குள் எங்கும் (மேல் / நடு) அல்லது கீழ்க்கோட்டுக்குக் கீழே (எவ்வளவும்); close கீழ்க்கோட்டுக்கு மேலே. Gap-up zone-இல் = "Gap-up FVG + Spring" (தனி பக்கம்).',
    rules: [
      'Spring = Spring பக்கத்தின் அதே 2-candle விதி',
      'Zone = 3-candle FVG, சிவப்பு candle-க்கு முன் உருவானது (Gap-up zone = Gap-up FVG + Spring)',
      'Spring candle low ≤ zone top (உள்ளே எங்கும், அல்லது கீழ்க்கோட்டுக்குக் கீழே); close > zone bottom',
      'Zone உருவானதிலிருந்து சிவப்பு candle வரை: எந்த close-உம் zone bottom-க்கோ Spring low-க்கோ கீழே இல்லை',
      'எத்தனையாவது தொடுதல் என்றாலும் சரி; இடம் = top / middle / bottom',
      'பின்னர் ஒரு close Spring low-க்குக் கீழே = பட்டியலிலிருந்து நீக்கம்',
      'Kite: 4H (13:15 candle), D, W - M-இல் இல்லை'
    ],
    examples: [
      { ok: true, label: 'மேல் (Top)', why: 'low 102.2 zone மேல் பாதியில்; close 103.2',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.9, 103.1], [103.0, 103.5, 102.2, 103.2]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' }, lines: [{ y: 101.8, from: 16, to: 21, label: 'நடு', dash: true }] }, check: { type: 'x', tag: 'FVG+Spring', where: 'top' } },
      { ok: true, label: 'நடு (Middle)', why: 'low 101.5 - zone கீழ்ப் பாதியில் (PARAGMILK போல)',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.9, 103.1], [103.0, 103.5, 101.5, 103.2]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' }, lines: [{ y: 101.8, from: 16, to: 21, label: 'நடு', dash: true }] }, check: { type: 'x', tag: 'FVG+Spring', where: 'middle' } },
      { ok: true, label: 'கீழ் (Bottom)', why: 'low 100.4 - கீழ்க்கோட்டுக்குக் கீழே; close மேலே',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.9, 103.1], [103.0, 103.5, 100.4, 103.2]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' } }, check: { type: 'x', tag: 'FVG+Spring', where: 'bottom' } }
    ]
  },
  {
    id: 'fvgspring2', section: 'X', title: 'FVG + Spring - செல்லாதவை', tags: [],
    ta: 'இந்த மூன்றும் FVG+Spring இல்லை (இதே zone, இதே Spring - வேறுபாடு வட்டமிட்ட candle மட்டும்).',
    rules: [
      'முன் candle Spring low-க்குக் கீழே close ஆனால் → செல்லாது',
      'Zone உடைந்துவிட்டால் (bottom-க்குக் கீழே close) → செல்லாது',
      'Spring-க்குப் பின் ஒரு close அதன் low-க்குக் கீழே → நீக்கப்படும் (backtest-இல் இது stop)'
    ],
    examples: [
      { ok: false, label: 'முன் close Spring low-க்குக் கீழே', why: '102.0-இல் close - Spring low 102.2-க்குக் கீழே',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 104.4, 104.6], [104.6, 104.8, 101.6, 102.0], [103.6, 103.8, 102.7, 102.9], [102.8, 103.2, 102.2, 103.0]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' }, rings: [{ i: 19, at: 'close', color: '#ff5252' }], lines: [{ y: 102.2, from: 17, to: 21, label: 'Spring low', dash: true, color: '#f5c542' }] }, check: { type: 'x', tag: 'FVG+Spring' } },
      { ok: false, label: 'Zone உடைந்தது', why: 'close 100.6 - zone bottom 101-க்குக் கீழே',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 104.4, 104.6], [104.6, 104.8, 100.3, 100.6], [103.6, 103.8, 102.7, 102.9], [102.8, 103.2, 102.2, 103.0]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' }, rings: [{ i: 19, at: 'close', color: '#ff5252' }] }, check: { type: 'x', tag: 'FVG+Spring' } },
      { ok: false, label: 'பின்னர் Spring low-க்குக் கீழே', why: 'Spring-க்கு அடுத்த நாள் close 101.9 < 102.2 - நீக்கம்',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [105.4, 105.6, 103.9, 104.2], [104.2, 104.4, 102.9, 103.1], [103.0, 103.5, 102.2, 103.2], [103.2, 103.4, 101.6, 101.9]]),
        marks: { zone: FVG_ZONE, hl: { 20: 'c1', 21: 'c2' }, rings: [{ i: 22, at: 'close', color: '#ff5252' }], lines: [{ y: 102.2, from: 21, to: 22, label: 'Spring low', dash: true, color: '#f5c542' }] }, check: { type: 'x', tag: 'FVG+Spring' } }
    ]
  },
  {
    id: 'twinstarfvg', section: 'X', title: 'Twin Star Bottom + FVG', tags: ['Twin Star Bottom + FVG'],
    ta: 'Twin Star Bottom-இன் நட்சத்திரங்கள் ஒரு FVG zone-க்குள் இறங்குகின்றன - zone-இல் support.',
    rules: [
      'Twin Star Bottom விதி (c1 சிவப்பு + இரண்டு நட்சத்திரங்கள் ஒரே low-இல்)',
      'c1-க்கு முன் உருவான FVG; அதுவரை எந்த close-உம் zone bottom-க்குக் கீழே இல்லை',
      'நட்சத்திரங்களின் குறைந்த low ≤ zone top',
      'இரண்டு நட்சத்திர close-களும் ≥ zone bottom'
    ],
    examples: [
      { ok: true, label: 'Zone-க்குள் நட்சத்திரங்கள்', why: 'low 102.3 / 102.35 ≤ zone top 102.6',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [104.4, 104.6, 102.9, 103.0], [103.0, 103.2, 102.3, 102.7], [102.6, 103.1, 102.35, 102.9]]),
        marks: { zone: FVG_ZONE, hl: { 19: 'c1', 20: '★', 21: '★' } }, check: { type: 'x', tag: 'Twin Star Bottom + FVG' } },
      { ok: false, label: 'Zone-ஐத் தொடவில்லை', why: 'நட்சத்திர low 102.95 > zone top 102.6',
        candles: fvgStart().concat([[105.6, 107.0, 105.3, 106.6], [106.6, 106.8, 105.0, 105.4], [104.4, 104.6, 102.9, 103.0], [103.0, 103.3, 102.95, 103.1], [103.1, 103.3, 102.97, 103.2]]),
        marks: { zone: FVG_ZONE, hl: { 19: 'c1', 20: '★', 21: '★' }, rings: [{ i: 20, at: 'low' }] }, check: { type: 'x', tag: 'Twin Star Bottom + FVG' } }
    ]
  },
  {
    id: 'gapup', section: 'X', title: 'Gap-up FVG', tags: ['Gap-up FVG'],
    ta: 'இன்றைய low, நேற்றைய high-ஐவிட 3%-இலிருந்து 5% மேலே திறந்து நிற்கிறது - ஒரு gap-up zone (நேற்றைய high முதல் இன்றைய low வரை). ' +
      'தொட்டால் mitigated - ஆனால் zone தொடர்கிறது (08-Nov-2026).',
    rules: [
      'இன்றைய low > நேற்றைய high; இடைவெளி 3% - 5% (Control Panel)',
      'Circuit-இல் பூட்டிய candle (range ≤ 0.05%) கணக்கில் இல்லை',
      'பின்னர் ஒரு candle-இன் low zone top-ஐத் தொட்டால் (wick போதும்) → "mitigated": ஒரே ஒரு email (hourly mail-இல்); zone நீக்கப்படாது',
      'ஒரு candle zone bottom-க்குக் கீழே close ஆனால் மட்டும் → செல்லாது (அடுத்த பக்கம்)',
      '"Approaching" alert தொடாத zone-க்கு மட்டும்; Kite 4H Gap-up zone-களுக்கும் இதே விதி'
    ],
    examples: [
      { ok: true, label: 'Gap-up 3.5%', why: 'low 104.0 - நேற்றைய high 100.5-ஐவிட 3.5% மேலே; இன்னும் தொடவில்லை',
        candles: flat(5, 100).concat([[100.2, 100.5, 99.8, 100.3], [104.2, 106.4, 104.0, 106.0], [106.0, 107.0, 105.0, 106.5], [106.5, 107.2, 105.5, 106.8]]),
        marks: { zone: { from: 6, bottom: 100.5, top: 104.0, label: 'Gap-up zone' }, hl: { 5: 'நேற்று', 6: 'gap' } }, check: { type: 'gap', touched: false } },
      { ok: false, label: 'Gap பெரியது (7%)', why: '5%-க்கு மேல் - கணக்கில் இல்லை',
        candles: flat(5, 100).concat([[100.2, 100.5, 99.8, 100.3], [107.8, 109.6, 107.6, 109.0], [109.0, 110.0, 108.0, 109.5], [109.5, 110.2, 108.5, 109.8]]),
        marks: { hl: { 5: 'நேற்று', 6: 'gap' }, rings: [{ i: 6, at: 'low' }] }, check: { type: 'gap' } },
      { ok: true, label: 'Mitigated - இன்னும் valid', why: 'low 103.8 zone-ஐத் தொட்டது = mitigated (ஒரு email); close 104.5 bottom-க்கு மேலே - zone தொடர்கிறது',
        candles: flat(5, 100).concat([[100.2, 100.5, 99.8, 100.3], [104.2, 106.4, 104.0, 106.0], [106.0, 107.0, 105.0, 106.5], [106.5, 106.8, 103.8, 104.5], [104.5, 106.6, 104.2, 106.2]]),
        marks: { zone: { from: 6, bottom: 100.5, top: 104.0, label: 'Gap-up zone' }, hl: { 5: 'நேற்று', 6: 'gap', 8: 'mitigated' }, rings: [{ i: 8, at: 'low' }] }, check: { type: 'gap', touched: true } }
    ]
  },
  {
    id: 'gapup2', section: 'X', title: 'Gap-up FVG - நீக்கம் & FVG-க்குள்', tags: [],
    ta: 'Zone bottom-க்குக் கீழே ஒரு close = zone முடிந்தது. "Inside FVG" = இரண்டு பெரிய பச்சை candle-களுக்கு இடையிலான gap-up, ஒரு FVG-இன் நடுவில் - மிக வலுவானது (உங்கள் BSE chart, 09-Nov-2026).',
    rules: [
      'Close < zone bottom → செல்லாது: GapUpFVG tab-இலிருந்தும் alert-இலிருந்தும் நீக்கம் (முன் email போகவில்லை என்றால் அந்தத் தொடுதலுக்கு ஒன்று)',
      'Inside FVG = A B C D நான்கு candle: B, C பச்சை, body ≥ 2% (Control Panel); C low > B high (gap எவ்வளவு சிறியதானாலும் சரி, 5% வரை)',
      'A high < B high, D low > C low → FVG = A high முதல் D low; gap-up zone = B high முதல் C low (நடுவில்)',
      'D close ஆன பிறகே தெரியும்; tab-இல் "Inside FVG" = Y, FVG column-இல் "(…, inside FVG)", mitigated email-இல் முதலில்'
    ],
    examples: [
      { ok: false, label: 'Bottom-க்குக் கீழே close', why: 'close 100.0 < zone bottom 100.5 - zone செல்லாது',
        candles: flat(5, 100).concat([[100.2, 100.5, 99.8, 100.3], [104.2, 106.4, 104.0, 106.0], [106.0, 107.0, 105.0, 106.5], [106.5, 106.8, 103.8, 104.5], [104.5, 104.8, 99.6, 100.0]]),
        marks: { zone: { from: 6, bottom: 100.5, top: 104.0, label: 'Gap-up zone' }, hl: { 5: 'நேற்று', 6: 'gap' }, rings: [{ i: 9, at: 'close', color: '#ff5252' }] }, check: { type: 'gap' } },
      { ok: true, label: 'FVG-க்குள் Gap-up (inside FVG)', why: 'B, C பெரிய பச்சை; gap 0.78% (102.6 - 103.4) - FVG 100.5 - 104.8-இன் நடுவில்',
        candles: flat(14, 100).concat([[100.4, 102.6, 100.3, 102.5], [103.6, 106.4, 103.4, 106.1], [106.1, 107.2, 104.8, 106.8], [106.8, 107.6, 105.6, 107.2]]),
        marks: { zone: { from: 15, bottom: 102.6, top: 103.4, label: 'Gap-up zone' }, hl: { 13: 'A', 14: 'B', 15: 'C', 16: 'D' },
          lines: [{ y: 100.5, from: 13, to: 17, label: 'FVG bottom', dash: true }, { y: 104.8, from: 13, to: 17, label: 'FVG top', dash: true }] }, check: { type: 'gap', inside: true } },
      { ok: false, label: 'சிறிய candle - கணக்கில் இல்லை', why: 'B-இன் body 0.5% (2%-க்குக் கீழே): 0.78% gap எதுவும் இல்லை',
        candles: flat(14, 100).concat([[102.1, 102.6, 100.3, 102.6], [103.6, 106.4, 103.4, 106.1], [106.1, 107.2, 104.8, 106.8], [106.8, 107.6, 105.6, 107.2]]),
        marks: { hl: { 14: 'B', 15: 'C' }, rings: [{ i: 14, at: 'close', color: '#ff5252' }] }, check: { type: 'gap' } }
    ]
  },
  {
    id: 'gapupspring', section: 'X', title: 'Gap-up FVG + Spring', tags: ['Gap-up FVG + Spring'],
    ta: 'FVG + Spring போலவே - ஆனால் zone ஒரு Gap-up zone (3-5%, அல்லது inside FVG gap எந்த அளவிலும்). Inside FVG zone-இல் இருந்தால் tag-இல் "inside FVG".',
    rules: [
      'Spring = Spring பக்கத்தின் அதே 2-candle விதி',
      'Zone = Gap-up (3-5%) அல்லது inside FVG gap-up, சிவப்பு candle-க்கு முன் உருவானது',
      'Spring candle low ≤ zone top (உள்ளே எங்கும், அல்லது கீழ்க்கோட்டுக்குக் கீழே); close > zone bottom',
      'Zone உருவானதிலிருந்து சிவப்பு candle வரை: எந்த close-உம் zone bottom-க்கோ Spring low-க்கோ கீழே இல்லை',
      'எத்தனையாவது தொடுதல் என்றாலும் சரி; பின்னர் ஒரு close Spring low-க்குக் கீழே = நீக்கம்',
      'ஒரே Spring 3-candle FVG-இலும் இருந்தால் FVG+Spring tag-உம் வரும்',
      'Kite: 4H (13:15 candle), D, W - backtest-இல் தனி வரி'
    ],
    examples: [
      { ok: true, label: 'மேல் (Top), inside FVG', why: 'low 103.2 - gap zone 102.6 - 103.4-இன் மேல் பாதியில்; close 104.3',
        candles: flat(14, 100).concat([[100.4, 102.6, 100.3, 102.5], [103.6, 106.4, 103.4, 106.1], [106.1, 107.2, 104.8, 106.8],
          [106.8, 107.4, 106.0, 107.0], [107.0, 107.2, 105.6, 105.8], [105.8, 106.0, 104.0, 104.2], [104.1, 104.6, 103.2, 104.3]]),
        marks: { zone: { from: 15, bottom: 102.6, top: 103.4, label: 'Gap-up zone' }, hl: { 14: 'B', 15: 'C', 19: 'c1', 20: 'c2' } },
        check: { type: 'x', tag: 'Gap-up FVG + Spring', where: 'top', inside: true } },
      { ok: true, label: 'கீழ் (Bottom), inside FVG', why: 'low 102.3 - zone bottom 102.6-க்குக் கீழே; close 103.2 மேலே',
        candles: flat(14, 100).concat([[100.4, 102.6, 100.3, 102.5], [103.6, 106.4, 103.4, 106.1], [106.1, 107.2, 104.8, 106.8],
          [106.8, 107.4, 106.0, 107.0], [107.0, 107.2, 105.6, 105.8], [105.8, 106.0, 102.9, 103.1], [103.0, 103.8, 102.3, 103.2]]),
        marks: { zone: { from: 15, bottom: 102.6, top: 103.4, label: 'Gap-up zone' }, hl: { 14: 'B', 15: 'C', 19: 'c1', 20: 'c2' } },
        check: { type: 'x', tag: 'Gap-up FVG + Spring', where: 'bottom', inside: true } },
      { ok: false, label: 'Zone உடைந்தது', why: 'முன் close 102.4 - zone bottom 102.6-க்குக் கீழே',
        candles: flat(14, 100).concat([[100.4, 102.6, 100.3, 102.5], [103.6, 106.4, 103.4, 106.1], [106.1, 107.2, 104.8, 106.8],
          [106.8, 107.4, 106.0, 107.0], [107.0, 107.2, 102.0, 102.4], [104.6, 104.8, 103.4, 103.5], [103.4, 104.0, 103.0, 103.6]]),
        marks: { zone: { from: 15, bottom: 102.6, top: 103.4, label: 'Gap-up zone' }, hl: { 14: 'B', 15: 'C', 19: 'c1', 20: 'c2' }, rings: [{ i: 18, at: 'close', color: '#ff5252' }] },
        check: { type: 'x', tag: 'Gap-up FVG + Spring' } }
    ]
  },

  // ======================================================== IPO bases
  // ======================================================== market structure (owner, 10-Nov-2026) - the PC's structure.py
  {
    id: 'choch', section: 'S', title: 'CHoCH + FVG (உங்கள் SMC setup)', tags: ['CHoCH + FVG'],
    ta: 'Downtrend-இல் (குறைந்தது 3 lower high + 3 lower low) ஒரு candle கடைசி lower high-க்கு மேலே CLOSE ஆனால் = CHoCH. அந்த move-இல் (அல்லது பிறகு) ' +
      'உருவான FVG, move-இன் 50% கோட்டுக்குக் கீழே (discount); அதற்கு price முதல் முறை திரும்பி வருவது / அங்கே Spring = entry.',
    rules: [
      'Swing high / low = இருபுறமும் 5 candle-களைவிட உயர்ந்த high / குறைந்த low (5 candle கழித்துதான் உறுதியாகும் - backtest முன்கூட்டிப் பார்க்காது)',
      'குறைந்தது 3 lower highs + 3 lower lows (ஒவ்வொன்றும் முந்தையதைவிடக் குறைவு; நீல வட்டங்கள்)',
      'CHoCH = கடைசி lower high-க்கு மேலே candle CLOSE (wick மட்டும் போதாது)',
      'Zone = CHoCH-இன் கடைசி low-க்குப் பிறகு உருவான FVG / Gap-up (அந்த move-இல் அல்லது பிறகு)',
      'Discount: zone-இன் நடுப்பகுதி move-இன் 50% கோட்டுக்குக் கீழே (கடைசி low → entry-க்கு முந்தைய உச்சம்; மஞ்சள் கோடு = Fib 0.5). Zone சற்று CHoCH level-க்கு மேலே நீண்டாலும் OK',
      'முதல் pullback மட்டும்: CHoCH-க்குப் பின் புதிய உயரம் (BOS = உச்ச swing high-க்கு மேலே close) வருவதற்கு முன்',
      'Entry = அந்த zone-க்கு price முதல் முறை வருவது (zone top-இல் limit order, அல்லது அந்த candle close) - மேலே புதிய FVG உருவானாலும்; அல்லது zone-இல் Spring (4H: 13:15 candle) / FVG First Touch Confirmed; stop = zone-க்குக் கீழே',
      'Move-இல் இரண்டு discount zone இருந்தால்: price முதலில் தொடும் (மேலே உள்ள) zone-ஐக் கவனிக்க மட்டும்; trade 2-வது zone-இல் (3-வது zone = trade இல்லை) - owner, 12-Nov-2026',
      'கடைசி low-க்குக் கீழே close = CHoCH செல்லாது; பின்னர் entry candle low-க்குக் கீழே close = பட்டியலிலிருந்து நீக்கம்'
    ],
    examples: [
      { ok: true, label: 'முதல் pullback-இல் Spring', why: '3 lower highs / lows, CHoCH close, FVG அந்த move-இல், 50% கோட்டுக்கு நன்றாகக் கீழே (discount); BOS இன்னும் இல்லை',
        candles: SMC.ok.candles, marks: smcMarks(SMC.ok), check: { type: 'choch', stage: 'disc' } },
      { ok: true, label: 'மேலே புதிய FVG - கீழே உள்ள zone-இன் முதல் touch', why: 'CHoCH-க்குப் பின் மேலே இன்னொரு FVG (premium, 50%-க்கு மேலே) - அதைத் தாண்டி, discount FVG-க்கு price முதல் முறை வந்ததே entry (SUPREMEIND)',
        candles: SMC.newer.candles, marks: smcMarks(SMC.newer), check: { type: 'choch', stage: 'disc', trigger: 'Zone first touch' } },
      { ok: false, label: 'BOS-க்குப் பிறகு', why: 'CHoCH-க்குப் பின் price உச்சத்துக்கு மேலே close (BOS) - "ஏற்கனவே ஓடிவிட்டது"; இது முதல் pullback அல்ல',
        candles: SMC.bos.candles, marks: smcMarks(SMC.bos, { lines: smcMarks(SMC.bos).lines.concat([
          { y: SMC.bos.candles[SMC.bos.at.peak][1], from: SMC.bos.at.peak, to: SMC.bos.at.bos, label: 'BOS', color: '#ff8a80' }]) }),
        check: { type: 'choch', stage: 'bos' } }
    ]
  },
  {
    id: 'choch2', section: 'S', title: 'CHoCH + FVG - செல்லாதவை', tags: [],
    ta: 'Zone move-இன் மேல் பாதியில் (premium) இருந்தால், அல்லது downtrend-இல் 3 lower high / low இல்லை என்றால் setup இல்லை. CHoCH level-க்குச் சற்று மேலே நீளும் zone, நடுப்பகுதி 50%-க்குக் கீழே என்றால் சரி.',
    rules: [
      'Zone-இன் நடுப்பகுதி 50% கோட்டுக்கு மேலே (premium) → செல்லாது (விலை ஏற்கனவே மேலே போய்விட்டது; risk அதிகம்)',
      'Zone CHoCH level-க்குச் சற்று மேலே நீண்டாலும், நடுப்பகுதி 50%-க்குக் கீழே என்றால் → சரி (owner, 11-Nov-2026)',
      'CHoCH-க்கு முன் 3-க்குக் குறைவான lower highs / lows → செல்லாது (Lab-இல் இந்த எண்ணை மாற்றிச் சோதிக்கலாம்)'
    ],
    examples: [
      { ok: false, label: 'Zone premium பகுதியில் (50%-க்கு மேலே)', why: 'Spring, CHoCH-க்குப் பிறகு உருவான FVG-இல் - ஆனால் அந்த FVG-இன் நடுப்பகுதி move-இன் 50% கோட்டுக்கு மேலே',
        candles: SMC.above.candles, marks: smcMarks(SMC.above), check: { type: 'choch', stage: 'prem' } },
      { ok: true, label: 'CHoCH-க்குச் சற்று மேலே - ஆனால் discount', why: 'FVG-இன் மேல் பகுதி CHoCH level-க்கு மேலே; நடுப்பகுதி 50% கோட்டுக்குக் கீழே → சரியான setup',
        candles: SMC.slight.candles, marks: smcMarks(SMC.slight), check: { type: 'choch', stage: 'disc' } },
      { ok: false, label: '2 lower highs மட்டும்', why: 'CHoCH-க்கு முன் 2 lower highs / lows மட்டுமே - குறைந்தது 3 வேண்டும்',
        candles: SMC.down2.candles, marks: smcMarks(SMC.down2), check: { type: 'choch', stage: 'none' } }
    ]
  },
  {
    id: 'ipo-base1', section: 'IPO', title: 'IPO Base 1', tags: ['Base 1'],
    ta: 'புதிதாக listing ஆன பங்கின் முதல் "கூரை" (resistance). இது listing நாளுக்கு அடுத்த 2வது candle-ஐப் பொறுத்தது.',
    rules: [
      '2வது candle listing high-க்குக் கீழே இருந்தால் → Base 1 = listing-day high (CPPLUS)',
      '2வது candle-இன் high listing high-க்கு மேலே போய், கீழே close → Base 1 = 2வது candle-இன் high (MVELECTRO); அதற்குக் கீழே 5 close வேண்டும்',
      '2வது candle listing high-க்கு மேலே close → listing high base அல்ல, நீக்கம் (INDOMIM); அடுத்து வரும் base Base 1 ஆகும்',
      'இப்படி நீக்கிய பின் வரும் முதல் base-க்கு 3 close போதும் (MILKYMIST)'
    ],
    examples: [
      { ok: true, label: 'Listing high = Base 1', why: '2வது candle 110-க்குக் கீழே - Base 1 = 110',
        candles: IPO.cpplus.slice(0, 7), marks: { hl: { 0: 'Listing', 1: '2' }, lines: [{ y: 110, from: 0, to: 6, label: 'Base 1 = 110', color: '#f5c542' }] },
        check: { type: 'ipo', levels: [110] } },
      { ok: true, label: '2வது candle-இன் high', why: '113 வரை போய் 108-இல் close - Base 1 = 113',
        candles: IPO.mvelectro, marks: { hl: { 0: 'Listing', 1: '2' }, lines: [{ y: 110, from: 0, to: 1, label: 'listing high', dash: true }, { y: 113, from: 1, to: 8, label: 'Base 1 = 113', color: '#f5c542' }] },
        check: { type: 'ipo', levels: [113] } },
      { ok: false, label: 'Listing high நீக்கம்', why: '2வது candle 112-இல் close (> 110) - அடுத்த peak 121 = Base 1',
        candles: IPO.indomim, marks: { hl: { 0: 'Listing', 1: '2' }, lines: [{ y: 110, from: 0, to: 2, label: '110 நீக்கம்', dash: true, color: '#ff5252' }, { y: 121, from: 3, to: 8, label: 'Base 1 = 121', color: '#f5c542' }], rings: [{ i: 1, at: 'close', color: '#ff5252' }] },
        check: { type: 'ipo', levels: [121], dropped: 110 } }
    ]
  },
  {
    id: 'ipo-broken', section: 'IPO', title: 'IPO Base - உடைப்பு (Breakout)', tags: ['Base broken'],
    ta: 'ஒரு base "உடைந்தது" = ஒரு candle அதற்கு மேலே CLOSE ஆகும் நாள். நாள் நடுவில் தொட்டுவிட்டு (wick) கீழே close ஆனால் உடைப்பு அல்ல.',
    rules: [
      'உடைப்பு = close > base',
      'High மட்டும் base-க்கு மேலே (wick) → உடைப்பு இல்லை',
      'உடைக்காத base = "Active Base" - Near Base alert அதைக் கவனிக்கும் (breakout-க்கு முன் entry)',
      'உடைந்த நாளில் "Base broken" alert'
    ],
    examples: [
      { ok: false, label: 'Wick மட்டும்', why: 'high 112, close 108.5 - Base 1 (110) இன்னும் Active',
        candles: IPO.wick, marks: { lines: [{ y: 110, from: 0, to: 6, label: 'Base 1 = 110', color: '#f5c542' }], rings: [{ i: 3, at: 'high', color: '#ff5252' }] },
        check: { type: 'ipo', levels: [110], broken: [-1] } },
      { ok: true, label: 'Close மேலே = உடைப்பு', why: 'close 111.5 > 110 - Base 1 உடைந்தது',
        candles: IPO.closeAbove, marks: { lines: [{ y: 110, from: 0, to: 6, label: 'Base 1 = 110', color: '#f5c542' }], rings: [{ i: 5, at: 'close', color: '#26a69a' }] },
        check: { type: 'ipo', levels: [110], broken: [5] } }
    ]
  },
  {
    id: 'ipo-base2', section: 'IPO', title: 'IPO Base 2 - Rejection / Peak Pullback', tags: ['Base 2'],
    ta: 'Base 1 உடைந்த பின் அடுத்த கூரை. இரண்டு வகை: Rejection (CPPLUS) அல்லது Peak Pullback (SHREEJISPG). ' +
      'நேராக மேலே ஓடிய பங்குக்கு Base 2 இல்லை (Anlon).',
    rules: [
      'Rejection: ஒரு candle முந்தைய candle-இன் high-ஐ அடைந்து அதற்குக் கீழே close → Base 2 = அந்த முந்தைய high',
      'Peak Pullback: உடைப்புக்குப் பின் உயர்ந்த high, அடுத்த 2 candle-கள் அதைவிடக் குறைவு → Base 2 = அந்த peak',
      'Base 2 > Base 1; அதற்குக் கீழே குறைந்தது 5 close (consolidation) வேண்டும்',
      'Rejection, Base 1 உடைந்த 10 trading நாட்களுக்குள் வர வேண்டும்',
      '5 close ஆவதற்குள் மேலே close ஆனால் → base அல்ல'
    ],
    examples: [
      { ok: true, label: 'Rejection (CPPLUS)', why: 'candle 118 வரை போய் 114-இல் close - Base 2 = 116',
        candles: IPO.cpplus, marks: { lines: [{ y: 110, from: 0, to: 5, label: 'Base 1', color: '#8b949e' }, { y: 116, from: 6, to: 13, label: 'Base 2 = 116', color: '#f5c542' }], rings: [{ i: 7, at: 'high' }] },
        check: { type: 'ipo', levels: [110, 116], types: [null, 'Rejection'] } },
      { ok: true, label: 'Peak Pullback', why: 'peak 122, அதற்குக் கீழே 5+ close - Base 2 = 122',
        candles: IPO.peak.slice(0, 16), marks: { lines: [{ y: 110, from: 0, to: 5, label: 'Base 1', color: '#8b949e' }, { y: 122, from: 8, to: 15, label: 'Base 2 = 122', color: '#f5c542' }], rings: [{ i: 8, at: 'high' }] },
        check: { type: 'ipo', levels: [110, 122], types: [null, 'Peak Pullback'] } },
      { ok: false, label: 'நேராக ஏற்றம்', why: 'நிராகரிப்பும் இல்லை, pullback-உம் இல்லை - Base 2 இல்லை',
        candles: IPO.straight, marks: { lines: [{ y: 110, from: 0, to: 5, label: 'Base 1', color: '#8b949e' }] },
        check: { type: 'ipo', levels: [110] } }
    ]
  },
  {
    id: 'ipo-base2a', section: 'IPO', title: 'IPO Base 2A (Lower High)', tags: ['Base 2A'],
    ta: 'விலை Base 2-க்குக் கீழே இருக்கும்போது உருவாகும் ஒரு சிறிய கூரை: Base 1-ஐவிட உயரம், Base 2-ஐவிடத் தாழ்வு (ADVIT JEWELS). ' +
      'இருந்தால், அதுவே அருகிலுள்ள base - Near Base alert அதைக் கவனிக்கும்.',
    rules: [
      'Base 2 உருவான பின், அது உடையும் முன்',
      'Swing high: அதன் இருபுறமும் 5 candle-களின் high அதைவிடக் குறைவு',
      'Base 1 < 2A < Base 2',
      'அதற்குக் கீழே குறைந்தது 5 close'
    ],
    examples: [
      { ok: true, label: 'Base 2A = 116', why: '116 - இருபுறமும் 5 candle குறைவு; Base 1 (110) - Base 2 (122) இடையே',
        candles: IPO.peak, marks: { lines: [{ y: 110, from: 0, to: 5, label: 'Base 1', color: '#8b949e' }, { y: 122, from: 8, to: 24, label: 'Base 2 = 122', color: '#8b949e' }, { y: 116, from: 16, to: 22, label: '2A = 116', color: '#f5c542' }], rings: [{ i: 16, at: 'high' }] },
        check: { type: 'ipo', levels: [110, 122], sub: 116 } },
      { ok: false, label: 'Peak உடனே உடைந்தது', why: 'peak 122-க்குக் கீழே 2 close மட்டும் - base அல்ல',
        candles: IPO.peakFail, marks: { lines: [{ y: 110, from: 0, to: 5, label: 'Base 1', color: '#8b949e' }, { y: 122, from: 8, to: 11, label: '122 - base அல்ல', dash: true, color: '#ff5252' }], rings: [{ i: 11, at: 'close', color: '#ff5252' }] },
        check: { type: 'ipo', levels: [110] } }
    ]
  }
];

module.exports = { SECTIONS, PAGES, helpers: { down, flat, fvgStart, smc } };
