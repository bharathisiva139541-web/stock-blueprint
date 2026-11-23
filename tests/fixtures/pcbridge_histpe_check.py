# -*- coding: utf-8 -*-
"""Offline checks of the Historical PE (pcbridge/ScreenerBridge/pe_history.py; owner, 17-Nov-2026: "Peak PE ratio, 5 year
median, 3 year median, 1 year median" - each day's Kite close / the TTM EPS known that day, screener.in's quarterly EPS
then its yearly EPS before them). Prints OK at the end."""
import importlib.util
import json
import os
import random
import statistics
import sys
import tempfile
import time
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
L.LAB_DIR = os.path.join(TMP, 'lab_cache')
spec = importlib.util.spec_from_file_location('pe_history', os.path.join(HERE, 'pe_history.py'))
H = importlib.util.module_from_spec(spec)
spec.loader.exec_module(H)
H.STORE_PATH = os.path.join(TMP, 'eps_history.json')
H.STATE_PATH = os.path.join(TMP, 'histpe_state.json')
LOGS = []
H.log = LOGS.append


def page(quarters, years, basis='Consolidated', eps_label='EPS in Rs'):
    """A trimmed screener.in page: quarters / years = [(label, net profit, EPS)]; the P&L table ends with a TTM column."""
    def table(rows, ttm=False):
        heads = ''.join('<th>%s</th>' % r[0] for r in rows) + ('<th>TTM</th>' if ttm else '')
        np_ = ''.join('<td>%s</td>' % ('{:,}'.format(r[1]) if r[1] is not None else '') for r in rows) + ('<td>1</td>' if ttm else '')
        ep = ''.join('<td>%s</td>' % ('' if r[2] is None else r[2]) for r in rows) + ('<td>9.99</td>' if ttm else '')
        return ('<table class="data-table"><thead><tr><th class="text"></th>%s</tr></thead><tbody>'
                '<tr><td class="text"><button>Sales&nbsp;<span>+</span></button></td>%s</tr>'
                '<tr><td class="text"><button>Net Profit&nbsp;<span>+</span></button></td>%s</tr>'
                '<tr><td class="text">%s</td>%s</tr></tbody></table>'
                % (heads, ''.join('<td>100</td>' for _ in rows), np_, eps_label, ep))
    return ('<html><body><section id="quarters"><p>%s Figures in Rs. Crores</p>%s</section>'
            '<section id="profit-loss"><p>%s Figures in Rs. Crores</p>%s</section>'
            '<section id="shareholding"></section></body></html>' % (basis, table(quarters), basis, table(years, True)))


def qlabels(last_y, last_m, n):
    out, y, m = [], last_y, last_m
    for _ in range(n):
        out.append('%s %d' % (H._MON[m - 1].title(), y))
        m -= 3
        if m <= 0:
            m += 12
            y -= 1
    return out[::-1]


# ------------------------------------------------------------------ 1. reading screener.in's tables
QS = qlabels(2026, 9, 12)                                       # Dec 2023 .. Sep 2026
html = page([(q, 1000 + k, 2.0 + 0.1 * k) for k, q in enumerate(QS)],
            [('Mar %d' % y, 4000, 8.0) for y in range(2015, 2027)])
r = H.parse_eps(html)
assert r['basis'] == 'C' and len(r['q']) == 12 and len(r['y']) == 12, r
assert r['q'][0] == [2023 * 12 + 12, 2.0, 1000.0] and r['q'][-1] == [2026 * 12 + 9, 3.1, 1011.0], r['q']
assert r['y'][0][0] == 2015 * 12 + 3 and all(x[1] == 8.0 for x in r['y']), 'yearly, the TTM column left out'
assert H.parse_eps(page([('Sep 2026', 5, 1.0)], [], basis='Standalone'))['basis'] == 'S'
assert H.parse_eps(page([('Sep 2026', 5, None)], [])) is None, 'no EPS figure'
assert H.parse_eps('<html>blocked</html>') is None
# blank cells / a shorter row line up from the right; 'Mar 2025 9m' (a changed year end) still a month
r = H.parse_eps(page([('Jun 2026', 10, 1.5), ('Sep 2026', 12, None)], [('Mar 2025 9m', 30, 6.0)]))
assert r['q'] == [[2026 * 12 + 6, 1.5, 10.0]] and r['y'] == [[2025 * 12 + 3, 6.0, 30.0]], r
assert H.month_index('TTM') is None and H.month_index('Sep 2026') == 2026 * 12 + 9 and H.label_of(2026 * 12 + 9) == 'Sep 2026'

# ------------------------------------------------------------------ 2. TTM EPS through time + splits
rec = {'q': [[2025 * 12 + m, 1.0, 10.0] for m in (3, 6, 9, 12)] + [[2026 * 12 + 3, 2.0, 20.0]],
       'y': [[y * 12 + 3, 4.0, 40.0] for y in (2022, 2023, 2024)], 'at': 0}
pts = H.ttm_points(rec)
when = [(date.fromordinal(p[0]).isoformat(), p[1], p[2]) for p in pts]
assert when == [('2022-05-30', 4.0, 'y'), ('2023-05-30', 4.0, 'y'), ('2024-05-30', 4.0, 'y'),
                ('2026-02-14', 4.0, 'q'),                 # Dec 2025 quarter: 45 days after its end
                ('2026-05-30', 5.0, 'q')], when           # a March quarter (the year's results): 60 days
rec['y'].append([2025 * 12 + 3, 4.0, 40.0])               # the year Mar 2025 known from 30-May-2025 - before the first quarterly TTM
assert [p[2] for p in H.ttm_points(rec)] == ['y', 'y', 'y', 'y', 'q', 'q']
rec['at'] = time.mktime(datetime(2026, 4, 20, 12).timetuple())   # this computer read the Mar 2026 quarter on 20-Apr
assert date.fromordinal(H.ttm_points(rec)[-1][0]).isoformat() == '2026-04-20', 'known from the page that had it'
# a quarter missing from the table: no TTM over the gap
gap = {'q': [[2025 * 12 + m, 1.0, 10.0] for m in (3, 9, 12)] + [[2026 * 12 + 3, 1.0, 10.0]], 'y': []}
assert H.ttm_points(gap) == []
# 1:10 split after Mar 2024: the older figures are divided by 10 (net profit / EPS = 10x fewer shares)
spl = {'q': [[2024 * 12 + 3, 10.0, 10.0], [2024 * 12 + 6, 1.0, 10.0], [2024 * 12 + 9, 1.0, 10.0], [2024 * 12 + 12, 1.0, 10.0]],
       'y': [[2023 * 12 + 3, 40.0, 40.0], [2024 * 12 + 3, 40.0, 40.0]]}
q, y, note = H.adjusted(spl)
assert q[2024 * 12 + 3] == 1.0 and y == {2023 * 12 + 3: 4.0, 2024 * 12 + 3: 4.0}, (q, y)
assert note == 'EPS up to Mar 2024 divided by 10 (split / bonus)', note
# a small EPS (rounding) is not judged - it takes the newer figure's factor; a 30 % more shares (a QIP) is not a split
odd = {'q': [[2024 * 12 + 3, 0.2, 2.0], [2024 * 12 + 6, 1.0, 13.0], [2024 * 12 + 9, 1.0, 10.0]], 'y': []}
q, _, note = H.adjusted(odd)
assert q == {2024 * 12 + 3: 0.2, 2024 * 12 + 6: 1.0, 2024 * 12 + 9: 1.0} and note == '', (q, note)
# 1:2 bonus (1.5x shares) - and a reverse split (consolidation 10:1) multiplies
assert H.adjusted({'q': [[1, 3.0, 30.0], [4, 2.0, 30.0]], 'y': []})[0] == {1: 2.0, 4: 2.0}
q, _, note = H.adjusted({'q': [[1, 1.0, 10.0], [4, 10.0, 10.0]], 'y': []})
assert q == {1: 10.0, 4: 10.0} and 'multiplied by 10' in note, (q, note)
# losses (both negative) are judged too; a negative EPS with a profit is left alone
assert H.adjusted({'q': [[1, -10.0, -10.0], [4, -1.0, -10.0]], 'y': []})[0] == {1: -1.0, 4: -1.0}

# ------------------------------------------------------------------ 3. the medians on made prices
START = date(2019, 1, 1)


def sessions(first, last):
    d, out = first, []
    while d <= last:
        if d.weekday() < 5:
            out.append(d.toordinal())
        d += timedelta(days=1)
    return out


UPTO = date(2026, 11, 13)
DAYS = sessions(START, UPTO)
yearly = {'q': [], 'y': [[y * 12 + 3, 5.0, 50.0] for y in range(2015, 2027)], 'at': 0}
st = H.stats(DAYS, [100.0] * len(DAYS), yearly)
assert st['m'] == {'1Y': 20.0, '3Y': 20.0, '5Y': 20.0} and st['peak'] == 20.0 and st['now'] == 20.0 and st['ttm'] == 5.0, st
assert st['qShare'] == 0
# a brute-force second calculation on random prices + EPS (quarters for the last 3 years, years before)
random.seed(7)
closes = []
px = 200.0
for _ in DAYS:
    px *= 1 + random.uniform(-0.03, 0.031)
    closes.append(round(px, 2))
qrec = {'q': [], 'y': [], 'at': 0}
for k, lab in enumerate(qlabels(2026, 9, 12)):
    mi = H.month_index(lab)
    qrec['q'].append([mi, round(random.uniform(-0.5, 3.0), 2) if k != 5 else -0.4, None])
for yr in range(2012, 2025):
    qrec['y'].append([yr * 12 + 3, round(random.uniform(-2, 12), 2), None])


def brute(days, closes, rec, upto, span):
    q = {m: e for m, e, _ in rec['q']}
    y = {m: e for m, e, _ in rec['y']}
    known = []
    for m in q:
        if all(m - 3 * k in q for k in range(4)):
            yy, mm = divmod(m - 1, 12)
            end = date(yy + (mm == 11), 1 if mm == 11 else mm + 2, 1) - timedelta(days=1)
            known.append(((end + timedelta(days=60 if mm + 1 == 3 else 45)).toordinal(), sum(q[m - 3 * k] for k in range(4))))
    first_q = min(k for k, _ in known) if known else None
    for m in y:
        yy, mm = divmod(m - 1, 12)
        end = date(yy + (mm == 11), 1 if mm == 11 else mm + 2, 1) - timedelta(days=1)
        k = (end + timedelta(days=60)).toordinal()
        if first_q is None or k < first_q:
            known.append((k, y[m]))
    known.sort()
    pes, n, cov = [], 0, 0
    for d, c in zip(days, closes):
        if d <= upto - span or d > upto:
            continue
        n += 1
        e = None
        for k, v in known:
            if k <= d:
                e = v
        if e is None:
            continue
        cov += 1
        if e > 0:
            pes.append(c / e)
    if cov < 0.9 * n or len(pes) < 0.5 * n:
        return None, None
    return round(statistics.median(pes), 2), round(max(pes), 2)


u = UPTO.toordinal()
st = H.stats(DAYS, closes, qrec)
for name, span in H.WINDOWS:
    want, peak = brute(DAYS, closes, qrec, u, span)
    assert st['m'].get(name) == want, (name, st, want)
    if name == '5Y' and want is not None:
        assert st['peak'] == peak, (st['peak'], peak)
assert st['qShare'] is not None and 30 < st['qShare'] < 60, st['qShare']
# blank medians with the reason: listed less than 3 years ago / EPS history too short / losses
late = DAYS[-500:]
st = H.stats(late, [100.0] * len(late), yearly)
assert st['m'] == {'1Y': 20.0} and st['why'] == {'3Y': 'listed less than 3 years ago', '5Y': 'listed less than 5 years ago'}, st
st = H.stats(DAYS[-500:], [100.0] * 500, yearly, first=DAYS[0])
assert st['m'] == {'1Y': 20.0, '3Y': 20.0, '5Y': 20.0}, 'the first candle of the whole history decides the listing'
short = {'q': [[H.month_index(l), 1.0, 10.0] for l in qlabels(2026, 9, 12)], 'y': [], 'at': 0}
st = H.stats(DAYS, [100.0] * len(DAYS), short)
assert st['m'] == {'1Y': 25.0} and st['why']['3Y'] == 'EPS history shorter than 3Y', st
loss = {'q': [], 'y': [[y * 12 + 3, -1.0 if y > 2022 else 4.0, None] for y in range(2015, 2027)]}
st = H.stats(DAYS, [100.0] * len(DAYS), loss)
assert st['m'] == {} and st['why']['1Y'] == 'a loss on most days' and st['now'] is None and st['ttm'] == -1.0, st

# ------------------------------------------------------------------ 4. the store
S = H.store()
NOW = time.time()
assert S.put('ABC', {'src': 'sheet', 'q': [[1, 1.0, 1.0]] * 4, 'y': []}, NOW)
assert S.put('ABC', {'src': 'page', 'q': [[1, 1.0, 1.0]] * 3, 'y': []}, NOW + 10) is False, 'a page with 3 quarters vs 4'
assert S.put('ABC', {'src': 'page', 'q': [[1, 1.0, 1.0]] * 12, 'y': [[1, 1, 1]]}, NOW + 10)
assert S.put('ABC', {'src': 'sheet', 'q': [[1, 1.0, 1.0]] * 12, 'y': []}, NOW + 99999) is False, 'never over a page'
assert S.put('ABC', {'src': 'page', 'q': [[1, 1.0, 1.0]] * 8, 'y': []}, NOW + 20) is False, 'the same round: fewer quarters'
assert S.put('ABC', {'src': 'page', 'q': [[1, 1.0, 1.0]] * 8, 'y': []}, NOW + 2 * 86400), 'a newer page'
H.save()
assert json.load(open(H.STORE_PATH))['syms']['ABC']['src'] == 'page'
S.syms.clear()
S.dirty = True
H.save()

# ------------------------------------------------------------------ 5. the round's step: cache, seed, backfill, post
def candles(days, closes):
    return [{'t': date.fromordinal(d).isoformat(), 'day': date.fromordinal(d).isoformat(), 'o': c, 'h': c, 'l': c, 'c': c, 'v': 1}
            for d, c in zip(days, closes)]


def build_cache(prices):
    w = L.CacheWriter(UPTO)
    for sym, cl in prices.items():
        w.add(sym, 'D', candles(DAYS[-len(cl):], cl), [])
    w.close()


build_cache({'AAA': [100.0] * len(DAYS), 'BBB': [50.0] * len(DAYS), 'CCC': [80.0] * len(DAYS), 'NEW': [30.0] * 200})
got, upto = H.closes_from_cache(L)
assert upto == UPTO.isoformat() and sorted(got) == ['AAA', 'BBB', 'CCC', 'NEW'] and len(got['AAA'][1]) == H.TAIL, upto
assert got['AAA'][0] == DAYS[0] and got['AAA'][2][-1] == 100.0

CALLS, FETCHED = [], []
REPLY = {}


def api(cfg, action, payload=None, tries=3, timeout=120):
    CALLS.append((action, json.loads(json.dumps(payload))))
    if REPLY.get(payload.get('op')):
        return REPLY[payload['op']]
    if payload['op'] == 'seed':
        assert action == 'histpe'
        return {'ok': True, 'series': {'CCC': ['C', qlabels(2026, 9, 8), [1.0] * 8, [10.0] * 8, NOW - 86400]}}
    return {'ok': True, 'main': len(payload['rows'])}


class Blocked(Exception):
    pass


PAGES = {
    ('AAA', True): ('ok', page([(q, 50, 1.25) for q in qlabels(2026, 9, 12)], [('Mar %d' % y, 200, 5.0) for y in range(2015, 2027)])),
    ('BBB', True): ('404', None),
    ('BBB', False): ('ok', page([(q, 50, 0.5) for q in qlabels(2026, 9, 12)], [('Mar %d' % y, 200, 2.0) for y in range(2015, 2027)],
                               basis='Standalone')),
}


def fetch(cfg, sym, cons=True):
    FETCHED.append((sym, cons))
    if sym == 'CCC':
        raise Blocked('HTTP 429')
    return PAGES.get((sym, cons), ('404', None))


CFG = {'pe_history': True}
n = H.step(CFG, api, L, fetch, lambda cfg: None, Blocked, now=NOW)
assert CALLS[0] == ('histpe', {'op': 'seed', 'want': ['AAA', 'BBB', 'CCC', 'NEW']}), CALLS[0]
# never read first (NEW: no page at all -> marked), then the sheet's figures only (CCC); stops when screener.in blocks
assert FETCHED == [('AAA', True), ('BBB', True), ('BBB', False), ('NEW', True), ('NEW', False), ('CCC', True)], FETCHED
assert any('screener.in stopped the extra pages (HTTP 429)' in x for x in LOGS), LOGS
assert any('read 5 more screener.in page(s)' in x and '1 stock(s) still to read' in x for x in LOGS), LOGS
op, put = CALLS[-1]
assert put['op'] == 'put' and put['upto'] == UPTO.isoformat() and n == 3 and put['engine'] == H.ENGINE == 2, (n, put)
rows = put['rows']
assert rows['AAA'][:4] == [20.0, 20.0, 20.0, 20.0] and rows['AAA'][5] == 20.0 and rows['AAA'][6] == 5.0, rows['AAA']
assert rows['BBB'][:3] == [25.0, 25.0, 25.0] and rows['BBB'][8].startswith('screener.in page'), rows['BBB']
assert rows['CCC'][0] == 20.0 and rows['CCC'][2] is None and rows['CCC'][8] == 'the sheet (quarterly figures only)', rows['CCC']
assert 'EPS history shorter than 3Y' in rows['CCC'][9], rows['CCC']
assert 'NEW' not in rows, 'no EPS history at all: not sent'
assert any('Historical PE (prices up to %s): 3 stock(s) -> the sheet - 1Y median for 3, 3Y 2, 5Y 2' % UPTO.isoformat() in x for x in LOGS), LOGS
# nothing changed: no post, no seed (asked a moment ago), only the stocks still to read
del CALLS[:], FETCHED[:]
assert H.step(CFG, api, L, fetch, lambda cfg: None, Blocked, now=NOW + 60) is None and CALLS == [], CALLS
assert FETCHED == [('CCC', True)], 'CCC still to read (blocked again); NEW was tried'
# a new candle cache (the daily Kite scan) -> posted again; pages = 0 -> no screener.in page
build_cache({'AAA': [110.0] * len(DAYS), 'BBB': [50.0] * len(DAYS)})
del CALLS[:], FETCHED[:]
H.step(CFG, api, L, fetch, lambda cfg: None, Blocked, pages=0, now=NOW + 120)
assert FETCHED == [] and [c[1]['op'] for c in CALLS] == ['put'] and CALLS[0][1]['rows']['AAA'][0] == 22.0, CALLS
# the sheet's older web app: a hint, not marked as sent (the next round tries again)
REPLY['put'] = {'ok': False, 'error': 'unknown action'}
del LOGS[:]
H.step(CFG, api, L, None, force=True, now=NOW + 180)
assert any('do the New version deploy' in x for x in LOGS), LOGS
del REPLY['put']
del CALLS[:]
H.step(CFG, api, L, None, now=NOW + 240)
assert [c[1]['op'] for c in CALLS] == [], 'force does not undo the last good post: nothing changed since'
# a state posted by another engine (the background program's older version sent its own figures after the new ones -
# owner, 23-Nov-2026, RVNL / SCI): posted again at once
st_ = H._load_state()
st_.pop('engine', None)
H._save_state(st_)
H.step(CFG, api, L, None, now=NOW + 250)
assert [c[1]['op'] for c in CALLS] == ['put'] and H._load_state()['engine'] == H.ENGINE, CALLS
H.step(CFG, api, L, None, now=NOW + 260)
assert len(CALLS) == 1, 'once'
del CALLS[:]
# a stock read again with new figures -> the EPS changed -> posted
H.keep_page('AAA', page([(q, 50, 2.5) for q in qlabels(2026, 9, 12)], []), NOW + 3 * 86400)
H.step(CFG, api, L, None, now=NOW + 3 * 86400)
assert [c[1]['op'] for c in CALLS] == ['put'] and CALLS[0][1]['rows']['AAA'][0] == 11.0, CALLS
# a stock screener.in has no page of: marked, not asked again for STALE_DAYS
del FETCHED[:]
H.backfill({}, lambda c, s, x=True: FETCHED.append((s, x)) or ('404', None), lambda c: None, Blocked, ['ZZZ'], 5)
assert FETCHED == [('ZZZ', True), ('ZZZ', False)] and H.store().syms['ZZZ'].get('none') == 1
assert H.backfill_order(['ZZZ']) == [] and H.backfill_order(['ZZZ'], time.time() + 91 * 86400) == ['ZZZ']
# switched off
assert H.step({'pe_history': False}, api, L) is None
# no cache: said once, nothing written
L.LAB_DIR = os.path.join(TMP, 'none')
del LOGS[:]
H._SAID.clear()
H.step(CFG, api, L)
H.step(CFG, api, L)
assert sum('no Kite daily candles on this computer yet' in x for x in LOGS) == 1, LOGS

# ------------------------------------------------------------------ 6. screener_bridge: every page it reads feeds the EPS history
src = open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read()
assert src.count('PEH.keep_page(') == 2 and src.count('histpe_step(cfg)') == 2 and "cmd == 'histpe'" in src
assert "'pe_history': True" in src and "'pe_history_pages_per_run': 40" in src
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(HERE, 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.log = LOGS.append
sb.PEH = H
seen = []
H.step = lambda cfg, api, lab, fetch=None, sleep=None, blocked=Exception, pages=None, max_s=None, force=False, now=None, xbrl=None, \
    tables=None: seen.append((lab is K.backtest_lab or lab.__name__, fetch is sb.fetch_page, blocked is sb.Blocked, pages, force,
                               xbrl is sb.XH.hist_quarters, tables is sb.XH.hist_tables)) or 7
assert sb.histpe_step({'pe_history': True}) == 7 and seen[-1][1:] == (True, True, None, False, True, True), seen
# XbrlHistoryCheck: every stock made again (no page), the checked stocks printed
H.LAST.clear()
H.LAST['RVX'] = [30.5, 31.0, 33.0, 48.7, '2021-11-22', 45.5, 4.07, 45, 'the results table (NSE filings + screener.in, 33 quarter(s), 12 year(s))', '']
said = []
sb.histpe_check({}, ['rvx', 'NOPE'], out=said.append)
assert seen[-1][3:5] == (0, True), 'no screener.in page, sent at once'
assert any('RVX: median PE 1Y 30.5 / 3Y 31 / 5Y 33, peak 48.7 on 2021-11-22, PE now 45.5 - EPS from the results table' in x for x in said), said
assert any('NOPE: no figures' in x for x in said), said
assert sb.histpe_step({'pe_history': False}) is None
H.step = lambda *a, **k: 1 / 0
assert sb.histpe_step({'pe_history': True}) is None, 'never raises'
print('OK')
