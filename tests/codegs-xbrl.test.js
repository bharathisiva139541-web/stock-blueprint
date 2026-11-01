'use strict';
// NSE XBRL as a Results Day source (owner, 01-Nov-2026, step 2 after XbrlCheck.bat matched screener.in): the PC posts a
// filing's figures (doPost 'xbrlput'); while screener.in lacks the quarter, the XBRL quarter + the quarters stored from
// screener.in give Main's QoQ / YoY / TTM EPS / OPM QoQ% - final figures; screener.in later only gives promoter / FII /
// OPM YoY. moneycontrol's provisional figures are replaced by XBRL. Result flags in the Results Tracker + email pills.
const test = require('node:test');
const assert = require('node:assert');
const mock = require('./fixtures/apps-script-mock.js');

const TOKEN = 'bridge-token-0123456789';
const NOW = Date.UTC(2026, 9, 30, 13, 30);             // Fri 30-Oct-2026 19:00 IST
const RD = new Date(Date.UTC(2026, 9, 29, 6, 30));      // result date Thu 29-Oct-2026
const HEAD = ['Checkbox', 'StockName', 'SYMBOL', 'Result Date', '% Change', 'QoQ Revenue Growth %', 'QoQ NP Growth %',
  'YoY Revenue Growth %', 'YoY NP Growth %', 'TTM EPS', 'Last FY EPS', 'Promotor Holding', 'FII Activity', 'OPM YoY%', 'OPM QoQ%',
  'Price Fall Alert Price', 'Breakout Alert Price', 'Triggered Y/N'];
const C = {};
HEAD.forEach((h, i) => { C[h] = i; });
const OLD = [5, 6, 7, 8, 40, 30, 'Stable', 'Increasing', 'Increasing', 'Decreasing'];
const SYMS = ['PARAS', 'MCXB', 'STAND', 'GAPCO', 'SCRF', 'DOWNCO'];
function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main watchlist'], HEAD].concat(SYMS.map((s) => [false, s + ' Ltd', s, RD, 1.2].concat(OLD))) },
    { name: 'AutoFetch Log', rows: [['ts']] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_RS_SEASON: 'Sep 2026' }, now: NOW });
}

/** A screener.in company page: quarterly table (+ OPM %), annual OPM, quarterly shareholding. */
function page(quarters, rows, o) {
  o = o || {};
  const tr = (label, a) => '<tr><td class="text">' + label + '<button>+</button></td>' + a.map((v) => '<td>' + v + '</td>').join('') + '</tr>';
  const head = (qs) => '<thead><tr><th></th>' + qs.map((q) => '<th>' + q + '</th>').join('') + '</tr></thead>';
  return '<section id="quarters"><p>' + (o.basis || 'Consolidated') + ' Figures in Rs. Crores</p><table class="data-table">' + head(quarters) +
    '<tbody>' + Object.keys(rows).map((k) => tr(k, rows[k])).join('') + '</tbody></table></section>' +
    '<section id="profit-loss"><table>' + head(['Mar 2025', 'Mar 2026', 'TTM']) + '<tbody>' + tr('OPM %', (o.annualOpm || [20, 24, 25]).map((v) => v + '%')) +
    '</tbody></table></section>' +
    '<section id="shareholding"><div id="quarterly-shareholding"><table>' + head(['Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']) + '<tbody>' +
    tr('Promoters', (o.prom || [60, 60, 60, 60]).map((v) => v + '%')) + tr('FIIs', (o.fii || [5, 5, 5, 5]).map((v) => v + '%')) +
    '</tbody></table></div><div id="yearly-shareholding"></div></section>';
}
const Q8 = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026'];
const PARAS_OLD = { Sales: [90, 95, 110, 100, 106, 118, 140, 128], 'OPM %': ['22%', '21%', '25%', '20%', '24%', '23%', '27%', '24%'],
  'Net Profit': [10, 11, 12, 11, 20, 18, 30, 21], 'EPS in Rs': [1.1, 1.2, 1.5, 1.3, 2.4, 2.26, 4.27, 2.63] };
// PARAS' Sep-2026 consolidated XBRL (the owner's chat), in crore; no exceptional items
const PARAS_X = { revenue: 151.12, other_income: 2.22, expenses: 112.52, finance_costs: 0.86, depreciation: 5.06, exceptional: null,
  pbeit: 40.82, pbt: 40.82, tax: 10.26, pat: 30.56, eps: 3.76 };
const shift = (rows, add) => { const o = {}; Object.keys(rows).forEach((k) => { o[k] = rows[k].slice(1).concat([add[k]]); }); return o; };

function tracker(e) {
  const rows = e.sheet('Results Tracker').rows;
  const out = {};
  rows.slice(1).forEach((r) => { const o = {}; rows[0].forEach((k, i) => { o[k] = r[i]; }); out[r[0]] = o; });
  return out;
}
const row = (e, sym) => e.sheet('Main').rows.find((x) => x[C.SYMBOL] === sym);
const figures = (e, sym) => row(e, sym).slice(C['QoQ Revenue Growth %'], C['OPM QoQ%'] + 1);

test('xbrlput: figures checked and stored in a hidden tab; list asks for the quarters not stored yet', () => {
  const e = env();
  const l1 = e.post({ token: TOKEN, action: 'list' });
  assert.deepStrictEqual(l1.xbrl, {}, 'no tracker rows yet (the first Results Day run makes them)');
  e.post({ token: TOKEN, action: 'process' });
  assert.deepStrictEqual(Object.keys(e.post({ token: TOKEN, action: 'list' }).xbrl).sort(), SYMS.slice().sort());
  assert.strictEqual(e.post({ token: TOKEN, action: 'list' }).xbrl.PARAS, 'Sep 2026');
  const r = e.post({ token: TOKEN, action: 'xbrlput', items: [
    { sym: 'PARAS', quarter: 'Sep 2026', cons: PARAS_X, stand: null, files: ['INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'] },
    { sym: 'BADQ', quarter: 'Q2FY27', cons: PARAS_X },
    { sym: 'EMPTY', quarter: 'Sep 2026', cons: { tax: 1 } },
    { sym: 'bad sym!', quarter: 'Sep 2026', cons: PARAS_X }] });
  assert.deepStrictEqual([r.ok, r.stored, r.details.map((d) => d.ok)], [true, 1, [true, false, false, false]]);
  const tab = e.sheet('XBRL_Bridge');
  assert.strictEqual(tab.hidden, true);
  const d = JSON.parse(tab.rows[1][4]);
  assert.deepStrictEqual([tab.rows[1][0], tab.rows[1][1], d.cons.eps, d.stand], ['PARAS', 'Sep 2026', 3.76, null]);
  assert.ok(!('PARAS' in e.post({ token: TOKEN, action: 'list' }).xbrl), 'stored: not asked again');
  assert.deepStrictEqual(e.post({ token: 'nope', action: 'xbrlput', items: [] }), { ok: false, error: 'bad token' });
});

test('list -> xbrl: rows needing figures first; Updated rows only while the result is 3 days old; the file needed', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'PARAS', html: page(Q8, PARAS_OLD) },
    { sym: 'STAND', html: page(Q8, PARAS_OLD, { basis: 'Standalone' }) }] });
  const tr = { list: [
    { symbol: 'OLDUPD', status: 'Updated', source: 'screener.in', rdKey: '2026-10-20', quarter: 'Sep 2026' },   // 10 days: no
    { symbol: 'NEWUPD', status: 'Updated', source: 'screener.in', rdKey: '2026-10-28', quarter: 'Sep 2026' },   // 2 days
    { symbol: 'PARAS', status: 'Pending', source: '', rdKey: '2026-10-12', quarter: 'Sep 2026' },
    { symbol: 'STAND', status: 'Pending', source: '', rdKey: '2026-10-29', quarter: 'Sep 2026' },
    { symbol: 'MCROW', status: 'Updated', source: 'moneycontrol', rdKey: '2026-10-15', quarter: 'Sep 2026' },
    { symbol: 'FUTURE', status: 'Pending', source: '', rdKey: '2026-11-05', quarter: 'Sep 2026' },
    { symbol: 'GONE', status: 'Gave up', source: '', rdKey: '2026-10-25', quarter: 'Sep 2026' },
    { symbol: 'XDONE', status: 'Updated', source: 'NSE XBRL', rdKey: '2026-10-29', quarter: 'Sep 2026' }] };
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'XDONE', quarter: 'Sep 2026', cons: PARAS_X }] });
  const basis = {};
  const want = e.call('ab_xbrlWant_', tr, '2026-10-30', basis);
  assert.deepStrictEqual(Object.keys(want), ['PARAS', 'STAND', 'MCROW', 'NEWUPD']);
  assert.deepStrictEqual(JSON.parse(JSON.stringify(basis)), { PARAS: 'C', STAND: 'S' }, 'no stored screener.in figures: both files');
  const l = e.post({ token: TOKEN, action: 'list' });
  assert.ok(l.xbrlBasis && typeof l.xbrlBasis === 'object', 'list sends the basis too');
});

test('Results Day: NSE XBRL figures while screener.in is behind (final), then only the trend tags from screener.in', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'PARAS', html: page(Q8, PARAS_OLD) }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'PARAS', quarter: 'Sep 2026', cons: PARAS_X, stand: Object.assign({}, PARAS_X, { revenue: 140 }) }] });
  const p = e.post({ token: TOKEN, action: 'process' });
  assert.match(p.result.results, /NSE XBRL: 1 filled from NSE XBRL/);
  let t = tracker(e).PARAS;
  assert.deepStrictEqual([t.Status, t.Source, t['Screener Latest Quarter']], ['Updated', 'NSE XBRL', 'Jun 2026']);
  assert.match(t.Note, /^NSE XBRL figures \(consolidated, final\) \+ earlier quarters from screener\.in; trend tags \(promoter, FII, OPM YoY\) wait for screener\.in$/);
  // Rev QoQ 151.12 vs 128 = 18, YoY vs 106 = 43; NP 30.56 vs 21 = 46, vs 20 = 53; TTM EPS 3.76+2.63+4.27+2.26 = 12.92,
  // last FY 2.4+1.3+1.5+1.2 = 6.4; OPM 29 (EBITDA 44.52 / 151.12) vs 24 = +5 points -> Aggressive Increase; other tags kept
  assert.deepStrictEqual(figures(e, 'PARAS'), [18, 46, 43, 53, 12.92, 6.4, 'Stable', 'Increasing', 'Increasing', 'Aggressive Increase']);
  assert.strictEqual(row(e, 'PARAS')[C.Checkbox], true);
  assert.strictEqual(t.Flags, 'Profit growing faster than revenue (YoY profit +53.0% vs revenue +43.0%)');
  const html = e.mails[0][0].htmlBody;
  assert.ok(/VIA NSE XBRL/.test(html) && /PROFIT &gt; REVENUE/.test(html), 'pills in the email');
  assert.match(e.mails[0][0].body, /\| via NSE XBRL \| Flags: Profit growing faster than revenue/);
  // still wanted from screener.in for the tags
  assert.ok(e.post({ token: TOKEN, action: 'list' }).priority.includes('PARAS'));

  // next day screener.in shows Sep 2026 (rounded crores, other tags): the figures stay XBRL's, the three tags come
  e.setNow(NOW + 864e5);
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'PARAS', html: page(Q8.slice(1).concat(['Sep 2026']),
    shift(PARAS_OLD, { Sales: 151, 'OPM %': '29%', 'Net Profit': 31, 'EPS in Rs': 3.76 }),
    { prom: [60, 60, 58, 52], fii: [5, 6, 7, 9], annualOpm: [20, 26, 27] }) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = tracker(e).PARAS;
  assert.deepStrictEqual([t.Status, t.Source, t['Updated At']], ['Updated', 'NSE XBRL + screener.in tags', '30/10/2026 19:00']);
  assert.match(t.Note, /^NSE XBRL figures \(final\); trend tags \(promoter, FII, OPM YoY\) from screener\.in on 31\/10\/2026 19:00$/);
  const f = figures(e, 'PARAS');
  assert.deepStrictEqual(f.slice(0, 6), [18, 46, 43, 53, 12.92, 6.4], 'XBRL figures are final');
  assert.strictEqual(f[9], 'Aggressive Increase', 'OPM QoQ% stays the XBRL one');
  assert.notDeepStrictEqual(f.slice(6, 9), ['Stable', 'Increasing', 'Increasing'], 'promoter / FII / OPM YoY from screener.in');
  assert.ok(!e.post({ token: TOKEN, action: 'list' }).priority.includes('PARAS'), 'done');
});

test('Results Day: XBRL replaces moneycontrol figures; mismatched basis or a gap in the stored quarters waits for screener.in', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'MCXB', html: page(Q8, PARAS_OLD) },
    { sym: 'STAND', html: page(Q8, PARAS_OLD) },
    { sym: 'GAPCO', html: page(Q8.slice(0, 7), { Sales: PARAS_OLD.Sales.slice(0, 7), 'Net Profit': PARAS_OLD['Net Profit'].slice(0, 7),
      'EPS in Rs': PARAS_OLD['EPS in Rs'].slice(0, 7) }) }] });
  e.post({ token: TOKEN, action: 'mcput', items: [{ sym: 'MCXB', basis: 'Consolidated', quarters: ['Jun 2026', 'Sep 2026'], revenue: [128, 150], netProfit: [21, 30] }] });
  e.post({ token: TOKEN, action: 'process' });
  assert.strictEqual(tracker(e).MCXB.Source, 'moneycontrol');
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [
    { sym: 'MCXB', quarter: 'Sep 2026', cons: PARAS_X },
    { sym: 'STAND', quarter: 'Sep 2026', stand: PARAS_X },
    { sym: 'GAPCO', quarter: 'Sep 2026', cons: PARAS_X }] });
  e.post({ token: TOKEN, action: 'put', items: [{ sym: 'MCXB', html: page(Q8, PARAS_OLD) }] });
  e.post({ token: TOKEN, action: 'process' });
  const t = tracker(e);
  assert.deepStrictEqual([t.MCXB.Status, t.MCXB.Source, t.MCXB['Updated At']], ['Updated', 'NSE XBRL', '30/10/2026 19:00']);
  assert.match(t.MCXB.Note, /they replaced the moneycontrol figures on 30\/10\/2026 20:00/);
  assert.deepStrictEqual(figures(e, 'MCXB').slice(0, 6), [18, 46, 43, 53, 12.92, 6.4]);
  const m = e.mails[e.mails.length - 1][0];
  assert.match(m.htmlBody, /Now with final figures - screener\.in \/ NSE XBRL \(they replace the moneycontrol ones\)/);
  assert.match(m.htmlBody, /NSE XBRL FIGURES/);
  assert.deepStrictEqual([t.STAND.Status, t.GAPCO.Status], ['Pending', 'Pending']);
  assert.match(t.STAND.Note, /NSE XBRL: NSE XBRL has no consolidated figures \(screener\.in's are Consolidated\)/);
  assert.match(t.GAPCO.Note, /NSE XBRL: screener\.in's stored quarters end Mar 2026, not the quarter before Sep 2026/);
});

test('result flags: revenue up / profit down; an exceptional gain read after screener.in\'s figures', () => {
  const e = env();
  e.post({ token: TOKEN, action: 'put', items: [
    { sym: 'DOWNCO', html: page(Q8, PARAS_OLD) },
    // screener.in already shows Sep 2026 for SCRF
    { sym: 'SCRF', html: page(Q8.slice(1).concat(['Sep 2026']), shift(PARAS_OLD, { Sales: 151, 'OPM %': '29%', 'Net Profit': 31, 'EPS in Rs': 3.76 })) }] });
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'DOWNCO', quarter: 'Sep 2026',
    cons: Object.assign({}, PARAS_X, { revenue: 120, pat: 15, eps: 1.8 }) }] });
  e.post({ token: TOKEN, action: 'process' });
  let t = tracker(e);
  assert.strictEqual(t.DOWNCO.Flags, 'Revenue up, profit down (YoY revenue +13.0%, profit -25.0%)');
  assert.deepStrictEqual([t.SCRF.Source, t.SCRF.Flags], ['screener.in', 'Profit growing faster than revenue (YoY profit +55.0% vs revenue +42.0%)']);
  assert.match(e.mails[0][0].htmlBody, /REV &#8593; PROFIT &#8595;/);
  // the XBRL filing of SCRF comes later, with a Rs 10 Cr exceptional gain in a PBT of 40.82 - the flag is added
  e.setNow(NOW + 3600e3);
  e.post({ token: TOKEN, action: 'xbrlput', items: [{ sym: 'SCRF', quarter: 'Sep 2026', cons: Object.assign({}, PARAS_X, { pbeit: 30.82, exceptional: 10 }) }] });
  e.post({ token: TOKEN, action: 'process' });
  t = tracker(e);
  assert.strictEqual(t.SCRF.Flags, 'Profit growing faster than revenue (YoY profit +55.0% vs revenue +42.0%); Exceptional gain Rs 10.00 Cr = 24% of PBT');
  assert.deepStrictEqual(figures(e, 'SCRF').slice(0, 4), [18, 48, 42, 55], 'screener.in\'s figures stay');
  // the flag rules on their own
  const fl = (g, f) => e.call('ab_rsFlags_', g, f || null);
  assert.strictEqual(fl({ qoqRev: 10, qoqNp: -5, yoyRev: '', yoyNp: '' }), 'Revenue up, profit down (QoQ revenue +10.0%, profit -5.0%)');
  assert.strictEqual(fl({ yoyRev: 10, yoyNp: 19 }), '', 'under 10 points faster: no flag');
  assert.strictEqual(fl({ yoyRev: -5, yoyNp: 8 }), 'Profit growing faster than revenue (YoY profit +8.0% vs revenue -5.0%)');
  assert.strictEqual(fl({}, { pbt: 50, pbeit: 46, exceptional: 4 }), '', 'an exceptional gain under 10% of PBT');
  assert.strictEqual(fl({}, { pbt: 50, pbeit: 60, exceptional: -10 }), '', 'an exceptional loss');
  assert.strictEqual(fl({}, { pbt: 50, pbeit: null, exceptional: 30 }), 'Exceptional gain Rs 30.00 Cr = 60% of PBT');
});
