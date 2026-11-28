'use strict';
// Corporate Intelligence (owner, 28-Nov-2026: NSE's corporate announcements sorted into 6 categories and scored by fixed rules -
// "No AI involvment here"; "30 days sheet vachurukalam, but all announcmenet should be stored in laptop, laptop on la iruntha
// all announment um website kaatanum"): the laptop (pcbridge/ScreenerBridge/corp_ann.py, tests/fixtures/pcbridge_corp_check.py)
// -> Code2.gs ab_corpFromBridge_ (Corp_Announcements, 30 days; Corp_Older + the website's questions) -> doPost action 'site'
// part 'corp' -> api/corp (unpacks + checks) -> web/lib/corp.js.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const zlib = require('zlib');
const { spawnSync } = require('child_process');
const mock = require('./fixtures/apps-script-mock.js');
const C = require('../web/lib/corp.js');
const api = require('../api/corp');

const TOKEN = 'bridge-token-0123456789';
const FEED = 'feed-token-abcdef';
const NOW = Date.UTC(2026, 10, 28, 9, 0);
const py = ['python3', 'python'].find((p) => spawnSync(p, ['--version']).status === 0);
let PY = null;      // the Python fixture's output (its names + a packed row) - run once

function pyOut() {
  if (PY) return PY;
  const r = spawnSync(py, [path.join(__dirname, 'fixtures', 'pcbridge_corp_check.py')], { encoding: 'utf8', timeout: 240000 });
  assert.strictEqual(r.status, 0, (r.stdout || '').slice(-1500) + (r.stderr || '').slice(-1500));
  assert.ok(/(^|\n)OK\s*$/.test(r.stdout), r.stdout.slice(-500));
  const lines = r.stdout.trim().split('\n');
  PY = JSON.parse(lines[lines.length - 2]);
  return PY;
}

function env() {
  return mock.loadCodeGs({ sheets: [
    { name: 'Main', rows: [['Main'], ['Checkbox', 'StockName', 'SYMBOL', 'MKT Price', 'MCAP(CR)'], [false, 'ABC Industries Ltd', 'ABC', 100, 2000],
      [false, 'XYZ Finance Ltd', 'XYZ', 50, ''], [false, 'ABC dup', 'ABC', 1, 1]] }
  ] }, { props: { AB_BRIDGE_TOKEN: TOKEN, AB_FEED_TOKEN: FEED }, now: NOW });
}
function row(o) {
  const r = Object.assign({ id: '101', sym: 'ABC', co: 'ABC Industries', at: '2026-11-28 12:00:00', cat: 'A', ev: 'order', ex: [], pr: 'high', bi: 75,
    gr: 0, su: 80, risk: 0, num: { val: 400, mo: 24, pct: 50 }, sub: 'Bagging/Receiving of orders/contracts', tx: 'received an order worth Rs 400 crore',
    pdf: 'https://nsearchives.nseindia.com/corporate/ABC_28112026120000_order.pdf', pg: 'r', why: 'NSE subject "Bagging"' }, o || {});
  return C.COLS.map((k) => r[k]);
}
const pack = (rows) => zlib.gzipSync(Buffer.from(JSON.stringify({ cols: C.COLS, rows }))).toString('base64');
const SUM = { n: 1, stocks: 1, high: 1, risk: 0, cats: { A: 1, Z: 9 }, evs: { order: 1, 'Bad Key': 3 } };
const put = (e, days, extra) => e.post(Object.assign({ token: TOKEN, action: 'corp', op: 'put', engine: 1, keep: 30, made: '2026-11-28 12:30:00', days }, extra || {}));
const day = (d, rows, sum) => ({ day: d, n: rows.length, sum: sum || SUM, blob: pack(rows) });
const res = () => {
  const r = { headers: {}, statusCode: 200 };
  r.setHeader = (k, v) => { r.headers[String(k).toLowerCase()] = v; };
  r.status = (c) => { r.statusCode = c; return r; };
  r.json = (o) => { r.body = JSON.parse(JSON.stringify(o)); };
  r.end = () => {};
  return r;
};

test('the laptop\'s rules (python, offline) and the same names in the laptop / api / page', { skip: !py && 'python3 not installed' }, () => {
  const o = pyOut();
  assert.deepStrictEqual(o.cols, C.COLS);
  assert.deepStrictEqual(api.COLS, C.COLS);
  assert.deepStrictEqual(o.events, C.EVENTS, 'event names + categories');
  assert.deepStrictEqual(Object.keys(o.events), api.EVENTS, 'api/corp knows every event');
  assert.deepStrictEqual(o.filters, C.FILTERS);
  assert.deepStrictEqual(o.filterEvents, C.FILTER_EVENTS);
  assert.deepStrictEqual(o.cats, C.CATS);
});

test('op syms = Main\'s stocks + market cap; op put keeps a row a day, 30 days; refusals', () => {
  const e = env();
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'corp', op: 'syms' }), { ok: true, syms: { ABC: ['ABC Industries Ltd', 2000], XYZ: ['XYZ Finance Ltd', null] } });
  assert.strictEqual(e.post({ token: FEED, action: 'corp', op: 'syms' }).ok, false, 'the bridge token');
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'corp' }).days, [], 'nothing yet');
  const big = 'A'.repeat(100000);
  assert.deepStrictEqual(put(e, [{ day: '2026-11-28', n: 1, sum: SUM, blob: big }]), { ok: true, days: 1, dropped: 0 });
  const b28 = pack([row()]), b27 = pack([row({ id: '102', at: '2026-11-27 18:00:00', ev: 'comp', cat: 'F', pr: 'routine' })]);
  assert.deepStrictEqual(put(e, [day('2026-11-28', [row()]), day('2026-11-27', [row({ id: '102', at: '2026-11-27 18:00:00' })])]),
    { ok: true, days: 2, dropped: 0 });
  const t = e.sheet('Corp_Announcements').rows;
  assert.deepStrictEqual(t[0], ['Day', 'Filings', 'Made', 'Summary (JSON)', 'Parts', 'Data']);
  assert.strictEqual(t.length, 3, 'a day replaced, a new day added');
  assert.strictEqual(String(t[1][4]), '1');
  assert.strictEqual(t[1].slice(6).join(''), '', 'the old parts of the replaced day are gone');
  let s = e.post({ token: FEED, action: 'site', part: 'corp' });
  assert.deepStrictEqual(s.days.map((d) => d.day), ['2026-11-28', '2026-11-27']);
  assert.deepStrictEqual(s.days[0].sum, { n: 1, stocks: 1, high: 1, risk: 0, cats: { A: 1, B: 0, C: 0, D: 0, E: 0, F: 0 }, evs: { order: 1 } });
  assert.strictEqual(s.blobs[0].blob, b28);
  assert.strictEqual(s.laptop, -1, 'the laptop never looked for questions');
  s = e.post({ token: FEED, action: 'site', part: 'corp', from: '2026-11-27', to: '2026-11-27' });
  assert.deepStrictEqual(s.blobs.map((x) => x.day), ['2026-11-27']);
  assert.notStrictEqual(s.blobs[0].blob, b27);
  // 30 days: a day 30 days after the oldest drops it
  assert.deepStrictEqual(put(e, [day('2026-12-27', [row({ at: '2026-12-27 10:00:00' })])]), { ok: true, days: 1, dropped: 1 });
  assert.deepStrictEqual(e.post({ token: FEED, action: 'site', part: 'corp' }).days.map((d) => d.day), ['2026-12-27', '2026-11-28']);
  for (const bad of [{ engine: 0 }, { days: [] }, { days: [{ day: 'x', blob: b28 }] }, { days: [{ day: '2026-11-28', blob: 'not base64!' }] }]) {
    assert.strictEqual(put(e, [day('2026-11-28', [row()])], bad).ok, false, JSON.stringify(bad));
  }
  assert.strictEqual(e.post({ token: TOKEN, action: 'corp', op: 'x', engine: 1 }).ok, false);
  assert.strictEqual(e.post({ token: TOKEN, action: 'site', part: 'corp' }).ok, false, 'the bridge token is not the feed token');
});

test('the website\'s questions: asked -> the laptop gets them (and waits while the page is open) -> its answer is kept 6 hours', () => {
  const e = env();
  let s = e.post({ token: FEED, action: 'site', part: 'corp', older: 'sym:ABC' });
  assert.deepStrictEqual(s, { ok: true, pending: true, key: 'sym:ABC', laptop: -1 });
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'corp', older: 'sym:abc!' }).ok, false, 'bad key');
  e.post({ token: FEED, action: 'site', part: 'corp', older: 'day:2026-10-05' });
  let a = e.post({ token: TOKEN, action: 'corp', op: 'ask', wait: 20 });
  assert.deepStrictEqual(a.asks.sort(), ['day:2026-10-05', 'sym:ABC']);
  assert.strictEqual(a.next, 0, 'the page was read just now: the laptop asks again at once');
  a = e.post({ token: TOKEN, action: 'corp', op: 'ask', wait: 20 });
  assert.deepStrictEqual(a.asks, [], 'handed out once (the page asks again while it waits)');
  s = e.post({ token: FEED, action: 'site', part: 'corp', older: 'sym:ABC' });
  assert.ok(s.pending && s.laptop === 0, 'the laptop looked just now');
  const blob = pack([row(), row({ id: '7', at: '2026-01-05 10:00:00' })]);
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'corp', op: 'older', engine: 1, key: 'sym:ABC', n: 2, blob, from: '2025-12-01' }), { ok: true, n: 2 });
  assert.deepStrictEqual(e.post({ token: TOKEN, action: 'corp', op: 'ask', wait: 20 }).asks, ['day:2026-10-05'].filter(() => false), 'answered = no longer asked');
  s = e.post({ token: FEED, action: 'site', part: 'corp', older: 'sym:ABC' });
  assert.strictEqual(s.older.blob, blob);
  assert.deepStrictEqual([s.older.key, s.older.n, s.older.from], ['sym:ABC', 2, '2025-12-01']);
  assert.strictEqual(e.post({ token: TOKEN, action: 'corp', op: 'older', engine: 1, key: 'bad', blob }).ok, false);
  // six hours later the answer is old: asked again
  e.setNow(NOW + 7 * 3600000);
  assert.strictEqual(e.post({ token: FEED, action: 'site', part: 'corp', older: 'sym:ABC' }).pending, true);
  // nobody looked for 10 minutes: the laptop is told to come back in 2 minutes, no waiting
  e.setNow(NOW + 8 * 3600000);
  a = e.post({ token: TOKEN, action: 'corp', op: 'ask', wait: 20 });
  assert.strictEqual(a.next, 120);
  // the 'ask' never waits for the script lock
  const busy = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] }, { props: { AB_BRIDGE_TOKEN: TOKEN }, now: NOW, lockBusy: true });
  assert.strictEqual(busy.post({ token: TOKEN, action: 'corp', op: 'ask' }).ok, true);
});

test('api/corp: unpacks + checks every column, e-mails / markup out, guarded, pending never cached; a Python-packed day too', async () => {
  const e = env();
  const odd = row({ id: '201', sym: 'XYZ', co: 'XYZ <script>alert(1)</script>', sub: 'Mail cs@xyz.co.in now', tx: 'contact investor@xyz.com', pdf: 'https://evil.example/x.pdf',
    num: { val: 'x', pct: 12, evil: 1, ract: 'up', rrt: 'AA+', role: 'Hacker', fv: [10, 2] }, ex: ['order', 'nope', 'fund'], pr: 'zz', bi: 500, pg: 'q' });
  const rows = [row(), odd, row({ id: 'BAD ID' }), row({ sym: 'bad sym' }), row({ ev: 'party' }), row({ at: 'soon' }), 'junk'];
  // owner, 28-Nov-2026: NSE's PDF on nseindia.in + the PDF's own lines
  rows.push(row({ id: '301', sym: 'ABC', pdf: 'https://nsearchives.nseindia.in/corporate/RATNAVEER_26112026163619_Press_release_signed.pdf',
    ps: ['Subject: Press Release - Update on Copper Cladded Steel Wire project', 'The new line cost Rs. 45 crore; mail ir@abc.com',
      '<b>x</b> 3', '4', '5', 'six', 'seven', 12, null] }));
  rows.push(row({ id: '302', sym: 'ABC', pdf: 'https://nsearchives.nseindia.in.evil.example/x.pdf', ps: 'not a list' }));
  if (py) rows.push(pyOut().row ? C.COLS.map((k) => pyOut().row[k]) : 'junk');
  put(e, [day('2026-11-28', rows)]);
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(JSON.parse(init.body));
    return new Response(JSON.stringify(e.post(JSON.parse(init.body))), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  const ENV = { SHEET_FEED_URL: 'https://script.google.com/macros/s/AKfy_SECRET_X/exec', SHEET_FEED_TOKEN: FEED, SITE_ACCESS: 'open' };
  const h = api.createHandler({ env: ENV, fetch, now: () => NOW, cache: require('../api/_lib/cache').createCache() });
  let r = res();
  await h({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.body.ok, true, JSON.stringify(r.body));
  assert.deepStrictEqual(r.body.cols, C.COLS);
  const ci = (k) => C.COLS.indexOf(k);
  assert.deepStrictEqual(r.body.rows.map((x) => x[ci('id')]), ['101', '201', '301', '302'].concat(py ? ['101'] : []), 'bad id / symbol / event / time / junk left out');
  const ps = r.body.rows[2];
  assert.strictEqual(ps[ci('pdf')], 'https://nsearchives.nseindia.in/corporate/RATNAVEER_26112026163619_Press_release_signed.pdf', 'nseindia.in passes');
  assert.deepStrictEqual(ps[ci('ps')], ['Subject: Press Release - Update on Copper Cladded Steel Wire project', 'The new line cost Rs. 45 crore; mail (e-mail)',
    'b x /b 3', '4', '5'], 'at most 5 lines, words only, no e-mail');
  assert.deepStrictEqual([r.body.rows[3][ci('pdf')], r.body.rows[3][ci('ps')]], ['', []], 'another host / not a list: nothing');
  const o = r.body.rows[1];
  assert.deepStrictEqual([o[ci('pdf')], o[ci('pr')], o[ci('bi')], o[ci('pg')], o[ci('ex')]], ['', 'low', 100, '', ['fund']], 'the event itself is not one of its other events');
  assert.deepStrictEqual(o[ci('num')], { pct: 12, ract: 'up', rrt: 'AA+', fv: [10, 2] }, 'known figures only');
  assert.deepStrictEqual([o[ci('sub')], o[ci('tx')]], ['Mail (e-mail) now', 'contact (e-mail)']);
  assert.strictEqual(o[ci('co')], 'XYZ script alert(1) /script', 'no markup');
  assert.deepStrictEqual(r.body.shown, ['2026-11-28']);
  assert.match(r.headers['cache-control'], /s-maxage=300/);
  assert.deepStrictEqual(calls[0], { action: 'site', part: 'corp', token: FEED });
  if (py) {
    const p = r.body.rows[4];
    assert.deepStrictEqual([p[ci('ev')], p[ci('cat')], p[ci('pg')], p[ci('num')].val], ['order', 'A', 'r', 400], 'the laptop\'s own row passes');
    assert.ok(p[ci('ps')].some((x) => /Rs\. 400 crore/.test(x)), p[ci('ps')].join(' | '));
  }
  const text = JSON.stringify(r.body) + JSON.stringify(r.headers);
  assert.ok(text.indexOf(FEED) < 0 && text.indexOf('AKfy_SECRET') < 0 && text.indexOf('@') < 0 && text.indexOf('<script') < 0, 'no token / address / mail / markup');
  assert.ok(!require('../api/site.js').PERSONAL_MARKERS.some((re) => re.test(JSON.stringify(r.body))), 'nothing the site guard would block');
  r = res();
  await h({ method: 'GET', query: {} }, r);
  assert.strictEqual(calls.length, 1, 'a second ask within 5 minutes: from the server\'s memory');
  r = res();
  await h({ method: 'GET', query: { from: '2026-11-28', to: '2026-11-28' } }, r);
  assert.deepStrictEqual(calls[1], { action: 'site', part: 'corp', token: FEED, from: '2026-11-28', to: '2026-11-28' });
  // older: pending (never cached), then the laptop's answer
  r = res();
  await h({ method: 'GET', query: { older: 'sym:ABC' } }, r);
  assert.deepStrictEqual([r.body.pending, r.body.key, r.headers['cache-control']], [true, 'sym:ABC', 'no-store']);
  e.post({ token: TOKEN, action: 'corp', op: 'older', engine: 1, key: 'sym:ABC', n: 1, blob: pack([row()]), from: '2026-11-01' });
  r = res();
  await h({ method: 'GET', query: { older: 'sym:ABC' } }, r);
  assert.deepStrictEqual([r.body.older.key, r.body.older.from, r.body.rows.length], ['sym:ABC', '2026-11-01', 1]);
  // bad requests, the guard, an older laptop program
  for (const q of [{ days: '0' }, { days: '11' }, { from: 'x' }, { older: 'sym:a b' }]) {
    r = res();
    await h({ method: 'GET', query: q }, r);
    assert.strictEqual(r.statusCode, 400, JSON.stringify(q));
  }
  r = res();
  await api.createHandler({ env: Object.assign({}, ENV, { SITE_ACCESS: '' }), fetch })({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.statusCode, 401, 'the website\'s access key is wanted');
  const k = require('../api/_lib/access').issueKey(ENV, Date.now()).k;
  r = res();
  await api.createHandler({ env: Object.assign({}, ENV, { SITE_ACCESS: '' }), fetch, cache: require('../api/_lib/cache').createCache() })({ method: 'GET', query: { k } }, r);
  assert.strictEqual(r.body.ok, true);
  assert.throws(() => api.unpack(zlib.gzipSync(Buffer.from(JSON.stringify({ cols: ['id'], rows: [] }))).toString('base64')), /CorpNow\.bat/);
  // the first laptop version's rows (no PDF lines) are still read
  const v1 = zlib.gzipSync(Buffer.from(JSON.stringify({ cols: C.COLS.slice(0, -1), rows: [row().slice(0, -1)] }))).toString('base64');
  const r1 = api.unpack(v1);
  assert.strictEqual(r1.length, 1);
  assert.deepStrictEqual(r1[0][C.COLS.indexOf('ps')], []);
  r = res();
  await api.createHandler({ env: {}, fetch })({ method: 'GET', query: {} }, r);
  assert.strictEqual(r.body.ok, false, 'not configured');
});

test('web/lib/corp.js: filters, counts, the strongest, the numbers in words', () => {
  const rows = C.objects({ cols: C.COLS, rows: [
    row(),
    row({ id: '2', sym: 'XYZ', ev: 'rating', cat: 'B', pr: 'high', bi: 10, gr: 80, risk: 1, num: { rag: 'CRISIL', rfrom: 'BBB', rrt: 'BB', ract: 'down' } }),
    row({ id: '3', ev: 'results', cat: 'B', ex: ['dividend'], pr: 'med', bi: 45, gr: 0, num: { dps: 5, dty: 'interim', rd: '2026-12-10' }, at: '2026-11-27 16:00:00' }),
    row({ id: '4', ev: 'meeting', cat: 'C', ex: ['fund', 'results'], pr: 'low', bi: 20, gr: 0, num: { ins: 'QIP' } }),
    row({ id: '5', ev: 'kmp', cat: 'C', pr: 'high', bi: 15, gr: 65, risk: 1, num: { role: 'CFO', act: 'out' } }),
    row({ id: '6', ev: 'comp', cat: 'F', pr: 'routine', bi: 0, gr: 0, su: 0, num: {} }),
    row({ id: '7', ev: 'call', cat: 'F', pr: 'routine', bi: 10, gr: 0, num: {} })
  ] });
  const c = C.counts(rows);
  assert.deepStrictEqual(c.filters, { all: 7, high: 3, orders: 1, mgmt: 1, fund: 1, results: 1, calls: 1, risk: 2, actions: 1 });
  assert.deepStrictEqual(c.cats, { A: 1, B: 2, C: 2, D: 0, E: 0, F: 2 });
  assert.deepStrictEqual([c.pdfs, c.read, c.scanned], [7, 7, 0], 'every made row has a read PDF');
  assert.strictEqual(c.stocks, 2);
  assert.deepStrictEqual(rows.filter((r) => C.inFilter(r, 'results')).map((r) => r.id), ['3'], 'a meeting notice is no result');
  assert.deepStrictEqual(rows.filter((r) => C.inFilter(r, 'actions')).map((r) => r.id), ['3'], 'its dividend is a corporate action');
  assert.deepStrictEqual(C.top(rows, 3).map((r) => r.id), ['2', '101', '5']);
  assert.deepStrictEqual(C.sort(rows).map((r) => r.id).slice(-1), ['3'], 'newest first');
  assert.deepStrictEqual(C.numWords(rows[0]), ['Order Rs 400 Cr', '50% of revenue (TTM)', 'over 2 years']);
  assert.deepStrictEqual(C.numWords(rows[1]), ['CRISIL BBB → BB downgraded']);
  assert.deepStrictEqual(C.numWords(rows[2]), ['Interim dividend Rs 5 a share', 'Record date 10-12-2026']);
  assert.deepStrictEqual(C.numWords(rows[4]), ['CFO left']);
  assert.ok(C.matches(rows[0], 'abc') && C.matches(rows[0], 'industries') && !C.matches(rows[0], 'zzz'));
  assert.deepStrictEqual(C.rangeDays('2026-11-28', 3), ['2026-11-28', '2026-11-27', '2026-11-26']);
});
