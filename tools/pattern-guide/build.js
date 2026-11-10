#!/usr/bin/env node
/* Builds the pattern guide from tools/pattern-guide/examples.js:
     dist/guide/Stock-Blueprint-Pattern-Guide.html  (the slides, 1280 x 720 each - open in a browser)
     dist/guide/Stock-Blueprint-Pattern-Guide.pdf   (Chromium print - one slide a page, Tamil shaped correctly)
     dist/guide/Stock-Blueprint-Pattern-Guide.pptx  (each slide as a picture + its rules as speaker notes; python-pptx)
   `npm run guide` (Chromium = the pre-installed Playwright; NODE_PATH or the global npm root is used to find it).
   The examples are checked against the real rules by tests/pattern-guide.test.js - run `npm test` before a build. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');
const G = require('./examples.js');

const OUT = path.join(__dirname, '..', '..', 'dist', 'guide');
const NAME = 'Stock-Blueprint-Pattern-Guide';
const W = 1280, H = 720;
const C = { bg: '#0f141c', panel: '#161c27', line: '#263042', text: '#e6edf3', muted: '#9aa7b4', yellow: '#f5c542',
  green: '#26a69a', red: '#ef5350', ringBad: '#ff5252', zoneFill: 'rgba(245,197,66,0.12)', zoneLine: '#d4a72c' };

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'); }
function fmt(v) { return (Math.round(v * 100) / 100).toString(); }

// ---------------------------------------------------------------- one example chart (SVG)
function chart(ex, w, h, viewFrom) {
  // the drawing may start later than the candles the code reads (the FVG pages' quiet lead-in): indices shift by v
  const v = Math.max(0, viewFrom || 0), all = ex.candles, k = all.slice(v), n = k.length, m0 = ex.marks || {};
  const sh = (i) => i - v;
  const m = {
    zone: m0.zone ? Object.assign({}, m0.zone, { from: Math.max(0, sh(m0.zone.from)) }) : null,
    lines: (m0.lines || []).map((l) => Object.assign({}, l, { from: Math.max(0, sh(l.from)), to: sh(l.to) })),
    rings: (m0.rings || []).map((r) => Object.assign({}, r, { i: sh(r.i) })),
    hl: {}
  };
  Object.keys(m0.hl || {}).forEach((key) => { m.hl[sh(+key)] = m0.hl[key]; });
  const padL = 8, padR = 96, padT = 26, padB = 14;
  let lo = Infinity, hi = -Infinity;
  k.forEach((c) => { lo = Math.min(lo, c[2]); hi = Math.max(hi, c[1]); });
  if (m.zone) { lo = Math.min(lo, m.zone.bottom); hi = Math.max(hi, m.zone.top); }
  m.lines.forEach((l) => { lo = Math.min(lo, l.y); hi = Math.max(hi, l.y); });
  const span = (hi - lo) || 1;
  lo -= span * 0.08; hi += span * 0.12;
  const slot = (w - padL - padR) / n;
  const X = (i) => padL + slot * (i + 0.5);
  const Y = (val) => padT + (hi - val) / (hi - lo) * (h - padT - padB);
  const bw = Math.max(3, Math.min(26, slot * 0.6));
  const gx = w - padR + 8;                                  // the label column on the right
  const s = [];
  s.push('<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '" viewBox="0 0 ' + w + ' ' + h + '">');
  // labels in the right column: lines + zone edges, nudged apart; price ticks only where there is room
  const labels = [];
  if (m.zone) {
    labels.push({ y: Y(m.zone.top), text: 'top ' + fmt(m.zone.top), color: C.yellow });
    labels.push({ y: Y(m.zone.bottom), text: 'bottom ' + fmt(m.zone.bottom), color: C.yellow });
  }
  m.lines.forEach((l) => { if (l.label) labels.push({ y: Y(l.y), text: l.label, color: l.color || '#8fb4ff', line: l }); });
  labels.sort((a, b) => a.y - b.y);
  for (let i = 1; i < labels.length; i++) if (labels[i].y - labels[i - 1].y < 14) labels[i].y = labels[i - 1].y + 14;
  for (let t = 0; t <= 3; t++) {
    const val = lo + (hi - lo) * (0.1 + 0.8 * t / 3), y = Y(val);
    s.push('<line x1="' + padL + '" x2="' + (w - padR + 4) + '" y1="' + y + '" y2="' + y + '" stroke="' + C.line + '" stroke-width="1"/>');
    if (!labels.some((L) => Math.abs(L.y - y) < 14)) s.push('<text x="' + gx + '" y="' + (y + 4) + '" fill="' + C.muted + '" font-size="10">' + fmt(val) + '</text>');
  }
  if (m.zone) {
    const z = m.zone, x0 = X(z.from) - slot / 2, x1 = w - padR;
    s.push('<rect x="' + x0 + '" y="' + Y(z.top) + '" width="' + (x1 - x0) + '" height="' + Math.max(2, Y(z.bottom) - Y(z.top)) +
      '" fill="' + C.zoneFill + '" stroke="' + C.zoneLine + '" stroke-width="1.2"/>');
    s.push('<text x="' + (x0 + 4) + '" y="' + (Y(z.top) + 13) + '" fill="' + C.yellow + '" font-size="11">' + esc(z.label || 'zone') + '</text>');
  }
  m.lines.forEach((l) => {
    const x0 = X(l.from) - slot * 0.45, x1 = X(l.to) + slot * 0.45, col = l.color || '#8fb4ff';
    s.push('<line x1="' + x0 + '" x2="' + x1 + '" y1="' + Y(l.y) + '" y2="' + Y(l.y) + '" stroke="' + col + '" stroke-width="1.6"' +
      (l.dash ? ' stroke-dasharray="5 4"' : '') + '/>');
    if (l.label) s.push('<line x1="' + x1 + '" x2="' + (w - padR + 4) + '" y1="' + Y(l.y) + '" y2="' + Y(l.y) + '" stroke="' + col +
      '" stroke-width="1" stroke-dasharray="1 4" opacity="0.7"/>');
  });
  k.forEach((c, i) => {
    const up = c[3] >= c[0], col = up ? C.green : C.red, x = X(i);
    s.push('<line x1="' + x + '" x2="' + x + '" y1="' + Y(c[1]) + '" y2="' + Y(c[2]) + '" stroke="' + col + '" stroke-width="1.4"/>');
    const top = Y(Math.max(c[0], c[3])), bot = Y(Math.min(c[0], c[3]));
    s.push('<rect x="' + (x - bw / 2) + '" y="' + top + '" width="' + bw + '" height="' + Math.max(1.2, bot - top) + '" fill="' + col + '"/>');
  });
  const placed = [];                                        // candle labels: lifted when they would overlap a neighbour's
  Object.keys(m.hl).sort((a, b) => a - b).forEach((key) => {
    const i = +key, c = k[i], x = X(i);
    if (!c) return;
    s.push('<rect x="' + (x - bw / 2 - 4) + '" y="' + (Y(c[1]) - 4) + '" width="' + (bw + 8) + '" height="' + (Y(c[2]) - Y(c[1]) + 8) +
      '" rx="4" fill="none" stroke="' + C.yellow + '" stroke-width="1.6"/>');
    const text = String(m.hl[key]), half = Math.max(8, text.length * 3.4);
    let y = Y(c[1]) - 9;
    for (let guard = 0; guard < 6 && placed.some((P) => x - half < P.x1 && x + half > P.x0 && Math.abs(P.y - y) < 12); guard++) y -= 13;
    placed.push({ x0: x - half, x1: x + half, y: y });
    s.push('<text x="' + x + '" y="' + y + '" fill="' + C.yellow + '" font-size="11" font-weight="700" text-anchor="middle">' + esc(text) + '</text>');
  });
  m.rings.forEach((r) => {
    const c = k[r.i];
    if (!c) return;
    const val = r.at === 'high' ? c[1] : r.at === 'low' ? c[2] : c[3];
    s.push('<circle cx="' + X(r.i) + '" cy="' + Y(val) + '" r="10" fill="none" stroke="' + (r.color || (ex.ok ? C.green : C.ringBad)) + '" stroke-width="2.2"/>');
  });
  labels.forEach((L) => s.push('<text x="' + gx + '" y="' + (L.y + 4) + '" fill="' + L.color + '" font-size="10.5" font-weight="700">' + esc(L.text) + '</text>'));
  s.push('</svg>');
  return s.join('');
}

// ---------------------------------------------------------------- slides
const CSS = `
@page { size: ${W}px ${H}px; margin: 0; }
* { box-sizing: border-box; }
html, body { margin: 0; background: ${C.bg}; }
body { font-family: 'FreeSans', 'Noto Sans Tamil', 'Latha', 'Nirmala UI', sans-serif; color: ${C.text}; }
.slide { width: ${W}px; height: ${H}px; padding: 30px 36px 20px; position: relative; overflow: hidden; page-break-after: always; break-after: page;
  background: radial-gradient(1200px 500px at 85% -10%, rgba(245,197,66,0.07), transparent 60%), ${C.bg}; display: flex; flex-direction: column; }
.sec { color: ${C.yellow}; font-size: 13px; letter-spacing: 1.5px; text-transform: uppercase; font-weight: 700; }
h1 { margin: 2px 0 6px; font-size: 30px; }
.ta { margin: 0; color: #c9d4df; font-size: 16px; line-height: 1.45; }
.body { flex: 1; display: flex; gap: 20px; margin-top: 14px; min-height: 0; }
.wide .body { flex-direction: column; gap: 10px; }
.rules { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 12px; padding: 14px 18px; width: 400px; flex: none; }
.wide .rules { width: auto; padding: 10px 18px; }
.rules h3 { margin: 0 0 6px; font-size: 15px; color: ${C.yellow}; }
.rules ol { margin: 0; padding-left: 20px; font-size: 14.5px; line-height: 1.45; }
.wide .rules ol { columns: 2; column-gap: 34px; font-size: 14px; }
.rules li { margin-bottom: 4px; break-inside: avoid; }
.where { margin: 8px 0 0; font-size: 12.5px; color: ${C.muted}; }
.ex { flex: 1; display: flex; gap: 14px; min-width: 0; }
figure { margin: 0; flex: 1; min-width: 0; background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; align-self: flex-start; }
figure .head { padding: 8px 12px; font-size: 15px; font-weight: 700; }
figure.ok .head { background: rgba(38,166,154,0.16); color: #5fd3c6; }
figure.bad .head { background: rgba(239,83,80,0.16); color: #ff8a80; }
figure svg { display: block; margin: 4px auto 0; }
figure .why { margin: 4px 12px 10px; font-size: 13.5px; color: #c9d4df; line-height: 1.4; }
footer { position: absolute; left: 36px; right: 36px; bottom: 8px; font-size: 11px; color: ${C.muted}; display: flex; justify-content: space-between; }
.cover { justify-content: center; }
.cover h1 { font-size: 54px; margin-bottom: 10px; }
.cover .big { font-size: 22px; color: #c9d4df; line-height: 1.5; max-width: 1050px; }
.pills { display: flex; gap: 12px; margin-top: 26px; flex-wrap: wrap; }
.pill { background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 999px; padding: 8px 16px; font-size: 16px; }
.pill b { color: ${C.yellow}; }
.cols { display: flex; gap: 22px; margin-top: 16px; }
.col { flex: 1; background: ${C.panel}; border: 1px solid ${C.line}; border-radius: 12px; padding: 14px 18px; }
.col h3 { margin: 0 0 8px; color: ${C.yellow}; font-size: 17px; }
.col ol { margin: 0; padding-left: 22px; font-size: 15px; line-height: 1.6; }
.col .pg { color: ${C.muted}; float: right; }
.legend { border-collapse: collapse; font-size: 16.5px; line-height: 1.4; align-self: flex-start; }
.legend td { padding: 9px 12px; border-bottom: 1px solid ${C.line}; vertical-align: top; }
.legend td:first-child { font-weight: 700; white-space: nowrap; }
.txt { font-size: 20px; line-height: 1.6; margin-top: 18px; }
.txt li { margin-bottom: 14px; }
`;

function footer(no, total) {
  return '<footer><span>Stock Blueprint · Pattern guide (விதி வழிகாட்டி)</span><span>ஒவ்வொரு chart-உம் உங்கள் Sheet-இன் அதே விதியால் சரிபார்க்கப்பட்டது · ' + no + ' / ' + total + '</span></footer>';
}
function pageSlide(p, no, total, heights) {
  const sec = G.SECTIONS.filter((x) => x.id === p.section)[0];
  const wide = true;                                          // rules on top, the charts side by side below
  const ew = Math.floor((W - 72 - 14 * (p.examples.length - 1)) / p.examples.length) - 2;
  const textLen = p.rules.join(' ').length + p.ta.length;
  const ch = textLen > 520 ? 262 : textLen > 380 ? 292 : 322;
  const figs = p.examples.map((ex, j) => {
    const view = p.section === 'X' && ex.candles.length > 16 ? 9 : 0;   // FVG pages: from a few quiet candles before the gap
    const hh = heights && heights[p.id] && heights[p.id][j] ? heights[p.id][j] : ch;
    return '<figure class="' + (ex.ok ? 'ok' : 'bad') + '" data-page="' + esc(p.id) + '" data-n="' + j + '"><div class="head">' +
      (ex.ok ? '✓ சரி (VALID)' : '✗ செல்லாது (NOT VALID)') + ' · ' + esc(ex.label) + '</div>' +
      chart(ex, ew - 8, hh, view) + '<p class="why">' + esc(ex.why) + '</p></figure>';
  }).join('');
  return '<section class="slide' + (wide ? ' wide' : '') + '"><div class="sec">' + esc(sec.title) + ' · ' + esc(sec.ta) + '</div><h1>' + esc(p.title) + '</h1>' +
    '<p class="ta">' + esc(p.ta) + '</p><div class="body"><div class="rules"><h3>விதிகள் (Rules)</h3><ol>' +
    p.rules.map((r) => '<li>' + esc(r) + '</li>').join('') + '</ol>' +
    '</div><div class="ex">' + figs + '</div></div>' + footer(no, total) + '</section>';
}
function anatomy() {
  const s = ['<svg width="600" height="340" viewBox="0 0 600 340" xmlns="http://www.w3.org/2000/svg">'];
  const cand = (x, o, hgh, l, c, col) => {
    s.push('<line x1="' + x + '" x2="' + x + '" y1="' + hgh + '" y2="' + l + '" stroke="' + col + '" stroke-width="3"/>');
    s.push('<rect x="' + (x - 26) + '" y="' + Math.min(o, c) + '" width="52" height="' + Math.abs(c - o) + '" fill="' + col + '"/>');
  };
  cand(140, 230, 40, 300, 100, C.green);
  cand(380, 100, 40, 300, 230, C.red);
  const lab = (x, y, t, a) => s.push('<text x="' + x + '" y="' + y + '" fill="' + C.text + '" font-size="15" text-anchor="' + (a || 'start') + '">' + esc(t) + '</text>');
  lab(176, 44, 'High (உயர்ந்த விலை)'); lab(176, 104, 'Close (பச்சை: மேலே)'); lab(176, 234, 'Open'); lab(176, 302, 'Low (குறைந்த விலை)');
  lab(104, 170, 'Body', 'end'); lab(104, 70, 'மேல் wick', 'end'); lab(104, 270, 'கீழ் wick', 'end');
  lab(416, 104, 'Open'); lab(416, 234, 'Close'); lab(416, 254, '(சிவப்பு: கீழே)');
  s.push('</svg>');
  return s.join('');
}

function slides(heights) {
  const out = [];
  const pages = G.PAGES;
  const exCount = pages.reduce((a, p) => a + p.examples.length, 0);
  const total = '@@TOTAL@@';
  let no = 0;
  const today = new Date().toISOString().slice(0, 10);
  // 1. cover
  no++;
  out.push('<section class="slide cover"><div class="sec">Stock Blueprint</div><h1>Pattern Guide · விதி வழிகாட்டி</h1>' +
    '<p class="big">உங்கள் Google Sheet (Code.gs) கண்டுபிடிக்கும் ஒவ்வொரு pattern-உம், IPO base-உம் - படங்களுடன்: எது <b style="color:#5fd3c6">சரி (VALID)</b>, எது <b style="color:#ff8a80">செல்லாது (NOT VALID)</b>, ஏன். ' +
    'ஒவ்வொரு படமும் Sheet-இன் அதே விதிகளால் சோதிக்கப்பட்டது - படம் சொல்வதும் Sheet செய்வதும் ஒன்றே.</p>' +
    '<div class="pills"><span class="pill"><b>' + G.PAGES.filter((p) => p.section === 'W').length + '</b> candle pattern பக்கங்கள்</span>' +
    '<span class="pill"><b>' + G.PAGES.filter((p) => p.section === 'X').length + '</b> FVG பக்கங்கள்</span>' +
    '<span class="pill"><b>' + G.PAGES.filter((p) => p.section === 'S').length + '</b> market structure பக்கங்கள்</span>' +
    '<span class="pill"><b>' + G.PAGES.filter((p) => p.section === 'IPO').length + '</b> IPO base பக்கங்கள்</span>' +
    '<span class="pill"><b>' + exCount + '</b> எடுத்துக்காட்டு charts</span><span class="pill">' + today + '</span></div>' + footer(no, total) + '</section>');
  // 2. how to read
  no++;
  out.push('<section class="slide"><div class="sec">எப்படிப் படிப்பது · How to read</div><h1>Candle-இன் பகுதிகளும் படக் குறிகளும்</h1>' +
    '<div class="body"><div style="background:' + C.panel + ';border:1px solid ' + C.line + ';border-radius:12px;padding:10px;align-self:flex-start">' + anatomy() + '</div>' +
    '<table class="legend">' + [
      ['color:#5fd3c6', '✓ சரி (VALID)', 'Sheet இந்த pattern-ஐக் கண்டுபிடித்து tag செய்யும்'],
      ['color:#ff8a80', '✗ செல்லாது', 'Sheet tag செய்யாது - படத்தின் கீழே காரணம்'],
      ['color:' + C.yellow, 'மஞ்சள் பெட்டி', 'pattern-இன் candle-கள் (c1, c2 ...)'],
      ['color:#ff8a80', '◯ வட்டம்', 'விதி உடைந்த / முக்கியமான இடம்'],
      ['color:#8fb4ff', '- - - கோடு', 'ஒப்பிடும் விலை (c1 low, நடு ...) - பெயர் வலது பக்கம்'],
      ['color:' + C.yellow, 'மஞ்சள் zone', 'FVG / Gap-up zone (top - bottom)'],
      ['', 'கடைசி candle', '"இன்று" (Today); அதற்கு முந்தையது c1 = நேற்று'],
      ['', 'வலது எண்கள்', 'விலை அளவு (எடுத்துக்காட்டு விலைகள்)']
    ].map((r) => '<tr><td style="' + r[0] + '">' + esc(r[1]) + '</td><td>' + esc(r[2]) + '</td></tr>').join('') + '</table>' +
    '</div>' + footer(no, total) + '</section>');
  // 3. contents
  no++;
  const startNo = no + 1;
  let pn = startNo;
  const cols = G.SECTIONS.map((sec) => {
    pn++;                                   // the section's divider slide
    const items = pages.filter((p) => p.section === sec.id).map((p) => '<li>' + esc(p.title) + '<span class="pg">' + (pn++) + '</span></li>').join('');
    return '<div class="col"><h3>' + esc(sec.ta) + '</h3><ol>' + items + '</ol></div>';
  }).join('');
  out.push('<section class="slide"><div class="sec">உள்ளடக்கம் · Contents</div><h1>பக்கங்கள்</h1><div class="cols">' + cols + '</div>' + footer(no, total) + '</section>');
  // sections
  G.SECTIONS.forEach((sec) => {
    no++;
    const ps = pages.filter((p) => p.section === sec.id);
    out.push('<section class="slide cover"><div class="sec">பகுதி · Section</div><h1>' + esc(sec.ta) + '</h1><p class="big">' + esc(sec.title) + '</p>' +
      '<p class="big" style="font-size:18px;color:' + C.muted + '">எங்கே தெரியும்: ' + esc(sec.where) + '</p>' +
      '<div class="pills">' + ps.map((p) => '<span class="pill">' + esc(p.title) + '</span>').join('') + '</div>' + footer(no, total) + '</section>');
    ps.forEach((p) => { no++; out.push(pageSlide(p, no, total, heights)); });
  });
  // timeframes
  no++;
  out.push('<section class="slide"><div class="sec">Timeframes · Zerodha Kite</div><h1>எந்த timeframe-இல் எந்த pattern</h1><ol class="txt">' +
    '<li><b>Daily (Sheet):</b> எல்லா candle pattern-களும் (Pattern column) மற்றும் FVG pattern-களும் (FVG column) - ஒவ்வொரு நாளும் Phase 2-இல்.</li>' +
    '<li><b>Zerodha Kite (உங்கள் laptop):</b> Spring, FVG + Spring, Gap-up FVG + Spring - 4H, Daily, Weekly; Monthly-இல் சாதாரண Spring மட்டும்.</li>' +
    '<li><b>4H:</b> Spring / FVG + Spring / Gap-up FVG + Spring - அன்றைய 2வது 4H candle (13:15 - 15:30) மட்டும். FVG First Touch / Confirmed / Twin Star Bottom + FVG - எல்லா 4H candle-களிலும்.</li>' +
    '<li><b>4H FVG zones:</b> தொடப்படாத சமீபத்திய FVG + Gap-up zone-கள் (நாள் turnover ≥ ₹50 லட்சம் உள்ள பங்குகள்) - சந்தை நேரத்தில் zone-க்குள் வந்தால் mitigated email (ஒரு மணிக்கு ஒன்று). Gap-up zone தொட்ட பின்னும் bottom-க்குக் கீழே close ஆகும் வரை தொடரும்.</li>' +
    '<li><b>Win rate:</b> FVG + Spring / Gap-up FVG + Spring backtest - entry = Spring close, stop = Spring low-க்குக் கீழே, target = 2R, 20 candle-களுக்குள் (Website: Patterns & FVG).</li>' +
    '</ol>' + footer(no, total) + '</section>');
  // adding a pattern
  no++;
  out.push('<section class="slide"><div class="sec">பராமரிப்பு · Keeping this guide current</div><h1>புதிய pattern சேர்க்கும்போது</h1><ol class="txt">' +
    '<li>புதிய pattern-இன் விதியை Claude-இடம் சொல்லுங்கள் (படம் இருந்தால் இன்னும் நல்லது).</li>' +
    '<li>Claude அதை Sheet code-இலும் Website-இலும் சேர்க்கும் - <b>அதே நேரத்தில் இந்த guide-இல் ஒரு பக்கம்</b>: விதிகள் + ✓ / ✗ படங்கள்.</li>' +
    '<li>ஒரு சோதனை (tests/pattern-guide.test.js) உறுதி செய்கிறது: (1) ஒவ்வொரு ✓ படத்தையும் code கண்டுபிடிக்கிறது, ✗ படத்தைக் கண்டுபிடிப்பதில்லை; (2) code-இல் உள்ள ஒவ்வொரு pattern-க்கும் இங்கே பக்கம் உண்டு - பக்கம் இல்லாமல் புதிய pattern சேர்ந்தால் சோதனை தோல்வியடையும்.</li>' +
    '<li>விதி மாறினால் (எ.கா. FVG + Spring, 08-Nov-2026) இங்குள்ள படங்களும் அதே நேரத்தில் மாறும்.</li>' +
    '<li>புதிய PDF / PowerPoint: <code>npm run guide</code> (Claude செய்யும்).</li></ol>' + footer(no, total) + '</section>');
  return { html: out.map((x) => x.replace(/@@TOTAL@@/g, String(out.length))), total: out.length };
}

function notesFor() {
  // speaker notes per slide (PowerPoint): the rules as plain text, in slide order
  const notes = ['Stock Blueprint - Pattern guide', 'How to read', 'Contents'];
  G.SECTIONS.forEach((sec) => {
    notes.push(sec.title + ' - ' + sec.where);
    G.PAGES.filter((p) => p.section === sec.id).forEach((p) => {
      notes.push(p.title + '\n' + p.ta + '\n\nRules:\n' + p.rules.map((r, i) => (i + 1) + '. ' + r).join('\n') + '\n\nExamples:\n' +
        p.examples.map((e) => (e.ok ? 'VALID' : 'NOT VALID') + ' - ' + e.label + ': ' + e.why).join('\n'));
    });
  });
  notes.push('Timeframes', 'Keeping this guide current');
  return notes;
}

function playwright() {
  try { return require('playwright'); } catch (e) {
    const root = execSync('npm root -g').toString().trim();
    return require(path.join(root, 'playwright'));
  }
}

function docOf(html) {
  return '<!doctype html><html lang="ta"><head><meta charset="utf-8"><title>Stock Blueprint - Pattern Guide</title><style>' + CSS + '</style></head><body>' + html.join('\n') + '</body></html>';
}

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const htmlPath = path.join(OUT, NAME + '.html');
  const { chromium } = playwright();
  const browser = await chromium.launch(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {});
  const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 2 });
  // pass 1: measure the room each chart has in its box (the text above it differs page to page), pass 2: draw to fit
  fs.writeFileSync(htmlPath, docOf(slides().html));
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  const heights = await page.evaluate(() => {
    const out = {};
    document.querySelectorAll('figure[data-page]').forEach((f) => {
      const svg = f.querySelector('svg'), head = f.querySelector('.head'), why = f.querySelector('.why');
      const slide = f.closest('.slide'), foot = slide.querySelector('footer');
      const room = foot.getBoundingClientRect().top - 10 - f.getBoundingClientRect().top - head.offsetHeight - why.offsetHeight - 24;
      (out[f.dataset.page] = out[f.dataset.page] || [])[+f.dataset.n] = Math.max(200, Math.min(460, Math.floor(room)));
      void svg;
    });
    return out;
  });
  const { html, total } = slides(heights);
  fs.writeFileSync(htmlPath, docOf(html));
  await page.goto('file://' + htmlPath, { waitUntil: 'load' });
  await page.pdf({ path: path.join(OUT, NAME + '.pdf'), width: W + 'px', height: H + 'px', printBackground: true, pageRanges: '1-' + total });
  const pngDir = path.join(OUT, 'slides');
  fs.rmSync(pngDir, { recursive: true, force: true });
  fs.mkdirSync(pngDir, { recursive: true });
  const els = await page.$$('section.slide');
  for (let i = 0; i < els.length; i++) await els[i].screenshot({ path: path.join(pngDir, 'slide-' + String(i + 1).padStart(2, '0') + '.png') });
  await browser.close();
  const notesPath = path.join(pngDir, 'notes.json');
  fs.writeFileSync(notesPath, JSON.stringify(notesFor()));
  execFileSync('python3', [path.join(__dirname, 'make_pptx.py'), pngDir, notesPath, path.join(OUT, NAME + '.pptx')], { stdio: 'inherit' });
  console.log('guide: ' + els.length + ' slides -> ' + path.relative(process.cwd(), OUT) + '/' + NAME + '.pdf / .pptx / .html');
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { chart, slides };
