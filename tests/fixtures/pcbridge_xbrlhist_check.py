# -*- coding: utf-8 -*-
"""Offline checks of the NSE XBRL 5-year history (pcbridge/ScreenerBridge/xbrl_history.py; owner, 18-Nov-2026: "if we download
all XBRL file from NSE for upto 5 years, can we able to build a table like Screener.in in our website?" -> quarterly + yearly
P&L, the files kept). Made NSE lists + made XBRL files served by a fake NSE. Prints OK at the end."""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import time
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(HERE, 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
LOGS = []
sb.log = LOGS.append
X = sb.XH
X.DIR = os.path.join(TMP, 'xbrl_data')
X.log = LOGS.append
assert X.D.get('facts') is sb.XBRL_FACTS and X.D.get('records') is sb.ipo_records, 'screener_bridge binds its helpers'
TODAY = date(2026, 11, 18)

# ------------------------------------------------------------------ made filings
MON = ('Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec')


def qend(y, m):
    nxt = date(y + (m == 12), 1 if m == 12 else m + 1, 1)
    return nxt - timedelta(days=1)


def qstart(e, months):
    y, m = e.year, e.month - months + 1
    while m <= 0:
        m += 12
        y -= 1
    return date(y, m, 1)


def figs(k, bump=0.0):
    """Quarter number k -> its figures in RUPEES (EPS in rupees): revenue 100 + k crore, total expenses 80 + k (interest 2,
    depreciation 3), other income 5, PBT 25, tax 25 %, net profit 18.75, 10 crore shares."""
    rev, exp, oi = 100 + k + bump, 80 + k, 5.0
    pbt = rev + oi - exp
    tax = pbt * 0.25
    pat = pbt - tax
    cr = 1e7
    return {'RevenueFromOperations': rev * cr, 'Expenses': exp * cr, 'FinanceCosts': 2 * cr,
            'DepreciationDepletionAndAmortisationExpense': 3 * cr, 'OtherIncome': oi * cr, 'ProfitBeforeTax': pbt * cr,
            'TaxExpense': tax * cr, 'ProfitLossForPeriod': pat * cr, 'BasicEarningsLossPerShare': round(pat / 10, 2)}


def year_figs(ks):
    out = {}
    for k in ks:
        for n, v in figs(k).items():
            out[n] = out.get(n, 0) + v
    out['BasicEarningsLossPerShare'] = round(sum(figs(k)['BasicEarningsLossPerShare'] for k in ks), 2)
    return out


def xml(nature, periods):
    """periods: [(start date, end date, {element: value})] -> an XBRL instance (+ a segment context that must be ignored)."""
    parts = ['<?xml version="1.0" encoding="UTF-8"?>',
             '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-bse-fin="http://www.bseindia.com/xbrl/fin" '
             'xmlns:xbrldi="http://xbrl.org/2006/xbrldi">',
             '<xbrli:context id="I1"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>'
             '<xbrli:period><xbrli:instant>2026-01-01</xbrli:instant></xbrli:period></xbrli:context>',
             '<in-bse-fin:NatureOfReportStandaloneConsolidated contextRef="I1">%s</in-bse-fin:NatureOfReportStandaloneConsolidated>'
             % nature]
    for n, (s, e, f) in enumerate(periods):
        cid = 'D%d' % n
        parts.append('<xbrli:context id="%s"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>'
                     '<xbrli:period><xbrli:startDate>%s</xbrli:startDate><xbrli:endDate>%s</xbrli:endDate></xbrli:period>'
                     '</xbrli:context>' % (cid, s.isoformat(), e.isoformat()))
        parts.append('<xbrli:context id="%sS"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier><xbrli:segment>'
                     '<xbrldi:explicitMember dimension="in-bse-fin:SegmentsAxis">A</xbrldi:explicitMember></xbrli:segment>'
                     '</xbrli:entity><xbrli:period><xbrli:startDate>%s</xbrli:startDate><xbrli:endDate>%s</xbrli:endDate>'
                     '</xbrli:period></xbrli:context>' % (cid, s.isoformat(), e.isoformat()))
        for el, v in f.items():
            parts.append('<in-bse-fin:%s contextRef="%s" unitRef="INR" decimals="-5">%s</in-bse-fin:%s>' % (el, cid, repr(v), el))
            parts.append('<in-bse-fin:%s contextRef="%sS" unitRef="INR" decimals="-5">999</in-bse-fin:%s>' % (el, cid, el))
    parts.append('</xbrli:xbrl>')
    return '\n'.join(parts).encode('utf-8')


# the quarters: k = 0 .. 23 = Dec 2020 .. Sep 2026
QS = []
y, m = 2020, 12
for k in range(24):
    QS.append((k, qend(y, m)))
    m += 3
    if m > 12:
        m -= 12
        y += 1
KOF = {e: k for k, e in QS}


def filing(k, nature='Consolidated', bump=0.0):
    """The quarter's filing as Indian results show it: the quarter, the quarter before, the same quarter a year before,
    the year (March) or the year-to-date (other quarters), and the last full year."""
    e = QS[k][1]
    per = [(qstart(e, 3), e, figs(k, bump))]
    if k >= 1:
        per.append((qstart(QS[k - 1][1], 3), QS[k - 1][1], figs(k - 1)))
    if k >= 4:
        per.append((qstart(QS[k - 4][1], 3), QS[k - 4][1], figs(k - 4)))
    if e.month == 3:
        if k >= 3:
            per.append((qstart(e, 12), e, year_figs(range(k - 3, k + 1))))
        if k >= 5:
            per.append((qstart(QS[k - 4][1], 12), QS[k - 4][1], year_figs(range(k - 7, k - 3))))
    else:
        months = {6: 3, 9: 6, 12: 9}[e.month]
        per.append((qstart(e, months), e, figs(k)))                      # a 3/6/9-month year-to-date column
    return xml(nature, per)


NSE = {}            # url -> bytes
REQ = []


def url_of(k, kind='C', rev=False, sym='ABC'):
    e = QS[k][1]
    stamp = (e + timedelta(days=40 + (5 if rev else 0))).strftime('%d%m%Y') + '183000'
    return 'https://nsearchives.nseindia.com/corporate/xbrl/%s_%s_%s%s_%s_WEB.xml' % (
        'INTEGRATED_FILING_INDAS' if e.year >= 2025 else 'FINANCIAL_RESULTS', sym, kind, 'R' if rev else '', stamp)


def add(k, kind='C', rev=False, bump=0.0, sym='ABC'):
    u = url_of(k, kind, rev, sym)
    NSE[u] = filing(k, 'Consolidated' if kind == 'C' else 'Standalone', bump)
    return u


# ABC: consolidated + standalone for every quarter, except Jun 2022 (k=6: nothing filed) and Dec 2020..Mar 2021 (k 0..1:
# outside the 5 years); Mar 2024 (k=13) has an Original and a Revised (revenue +1)
INT, OLD = [], []
for k, e in QS:
    if k == 6:
        continue
    for kind in ('C', 'S'):
        u = add(k, kind)
        rec = {'symbol': 'ABC', 'xbrl': u}
        if e.year >= 2025:
            rec.update({'qe_Date': e.strftime('%d-%b-%Y'), 'consolidated': 'Consolidated' if kind == 'C' else 'Standalone',
                        'typeOfSubmission': 'Original'})
            INT.append(rec)
        else:
            rec.update({'toDate': e.strftime('%d-%b-%Y').upper(), 'consolidated': 'Consolidated' if kind == 'C' else 'Non-Consolidated',
                        'cumulative': 'Non-cumulative', 'period': 'Quarterly'})
            OLD.append(rec)
ur = add(13, 'C', rev=True, bump=1.0)
OLD.append({'symbol': 'ABC', 'xbrl': ur, 'toDate': '31-MAR-2024', 'consolidated': 'Consolidated', 'typeOfSubmission': 'Revised'})
GOV = 'https://nsearchives.nseindia.com/corporate/xbrl/GOVERNANCE_ABC_01012026120000_WEB.xml'
INT.append({'symbol': 'ABC', 'xbrl': GOV, 'qe_Date': '31-Dec-2025'})
LIST = {'ABC': ({'data': INT}, OLD)}


class Opener:
    pass


STATUS = {}


def fake_get(opener, url, referer='', timeout=30):
    REQ.append(url)
    if STATUS.get('all'):
        return STATUS['all'], b''
    if 'integrated-filing-results' in url or 'corporates-financial-results' in url:
        sym = url.split('symbol=')[1].split('&')[0]
        lists = LIST.get(sym)
        if not lists:
            return 200, b'{"data": []}'
        obj = lists[0] if 'integrated' in url else lists[1]
        return 200, json.dumps(obj).encode()
    if url in NSE:
        return 200, NSE[url]
    return 404, b''


def screener_page(rows):
    """A trimmed screener.in page: rows = [(quarter, sales, net profit, eps, opm)]."""
    head = ''.join('<th>%s</th>' % r[0] for r in rows)
    line = lambda name, i: '<tr><td>%s</td>%s</tr>' % (name, ''.join('<td>%s</td>' % r[i] for r in rows))
    return ('<html><section id="quarters"><table><thead><tr><th></th>%s</tr></thead><tbody>%s%s%s%s</tbody></table></section>'
            '<section id="profit-loss"></section></html>' % (head, line('Sales +', 1), line('Net Profit +', 2),
                                                           line('EPS in Rs', 3), line('OPM %', 4)))


X.bind(session=Opener, get=fake_get, screener=lambda cfg, sym, cons=True: ('ok', screener_page(
    [('Jun 2026', 122, 18.75, 1.88, 20), ('Sep 2026', 130, 18.75, 1.88, 19)])))
SLEEPS = []


def nap(s):
    SLEEPS.append(s)


# ------------------------------------------------------------------ 1. the list records + the pick
mi = X.rec_meta(INT[0])
assert mi['end'] == '2025-03-31' and mi['basis'] == 'C' and not mi['rev'] and mi['stamp'] == '20250510183000', mi
mo = X.rec_meta(OLD[1])
assert mo['basis'] == 'S' and mo['end'] == '2020-12-31' and not mo['cum'], mo
assert X.rec_meta({'symbol': 'ABC', 'pdf': 'x.pdf'}) is None, 'no XBRL link'
assert X.rec_meta(OLD[-1])['rev'] is True
assert X.rec_meta({'attachment': {'link': 'https://a/b/X_c_01012026120000_W.xml'}, 'period_ended': '2025-12-31'})['end'] == '2025-12-31', 'nested'
metas = [X.rec_meta(r) for r in INT + OLD]
picked = X.pick(metas, X.since_iso(TODAY))
ends = [c[0]['end'] for c in picked]
assert ends[0] == '2026-09-30' and '2022-06-30' not in ends and '2020-12-31' not in ends and len(ends) == 20, ends
assert all(c[0]['basis'] == 'C' for c in picked), 'consolidated when filed'
mar24 = [c for c in picked if c[0]['end'] == '2024-03-31'][0]
assert mar24[0]['rev'] and not mar24[1]['rev'], 'Revised first, the Original as the fallback'
assert not any(c[0]['gov'] for c in picked), 'governance files are not results'
only_s = X.pick([X.rec_meta({'xbrl': 'https://a/S_01012026120000_.xml', 'toDate': '31-Dec-2025', 'consolidated': 'Non-Consolidated'})],
                '2021-01-01')
assert only_s[0][0]['basis'] == 'S', 'standalone when the company files no consolidated results'
assert X.pick([X.rec_meta({'xbrl': 'https://a/U_01012026120000_.xml'})], '2021-01-01')[0][0]['end'] == '', 'unknown: read to find out'

# ------------------------------------------------------------------ 2. reading a file
p = X.parse_periods(NSE[url_of(23)])
assert p['nature'] == 'C' and sorted((q['end'], q['m']) for q in p['periods']) == [
    ('2025-09-30', 3), ('2026-06-30', 3), ('2026-09-30', 3)], p['periods']                 # the 6-month column left out
own = [q for q in p['periods'] if q['end'] == '2026-09-30'][0]['f']
assert own['revenue'] == 123.0 and own['expenses'] == 103.0 and own['finance_costs'] == 2.0 and own['eps'] == 1.88, own
assert X.parse_periods(b'not xml') is None
p = X.parse_periods(NSE[url_of(21)])                       # March 2026: the year and the year before too
assert sorted(q['end'] for q in p['periods'] if q['m'] == 12) == ['2025-03-31', '2026-03-31']
assert X.parse_periods(NSE[url_of(20, 'S')])['nature'] == 'S'

# ------------------------------------------------------------------ 3. one stock: download, keep, table
nse = X.Nse(0, nap)
st, got = X.process_stock(nse, 'ABC', TODAY)
t = st['table']
files_dir = os.path.join(X.DIR, 'files', 'ABC')
kept = sorted(os.listdir(files_dir))
assert got == 20 and len(kept) == 20, (got, kept)
assert not any('_S_' in n for n in kept), 'only the consolidated files are downloaded'
assert t['b'] == 'C' and len(t['q']) == 20 and t['q'][0][0] == 'Dec 2021' and t['q'][-1][0] == 'Sep 2026', [r[0] for r in t['q']]
by = {r[0]: r for r in t['q']}
assert by['Jun 2022'][-1] == 'c', 'no filing of its own: a later filing\'s comparison column'
assert by['Sep 2026'][-1] == '' and by['Mar 2024'][1] == 114.0, 'the Revised filing (revenue +1)'
row = by['Sep 2026']   # rev 123, total expenses 103 (interest 2, depreciation 3) -> expenses 98, OP 25, OPM 20.3 %
assert row[1:13] == [123.0, 98.0, 25.0, 20.3, 5.0, None, 2.0, 3.0, 25.0, 25.0, 18.75, 1.88], row
ys = [r[0] for r in t['y']]
assert ys == ['Mar 2021', 'Mar 2022', 'Mar 2023', 'Mar 2024', 'Mar 2025', 'Mar 2026'], ys
yb = {r[0]: r for r in t['y']}
assert yb['Mar 2026'][1] == round(sum(100 + k for k in (18, 19, 20, 21)), 2) and yb['Mar 2026'][-1] == ''
assert yb['Mar 2021'][-1] == 'c', 'the year before, from the March 2022 filing'
assert yb['Mar 2026'][12] == round(sum(figs(k)['BasicEarningsLossPerShare'] for k in (18, 19, 20, 21)), 2)
# again: nothing downloaded (the files are kept), the same table; a new Revised filing of Sep 2026 -> only it is read
before = len(REQ)
st2, got2 = X.process_stock(nse, 'ABC', TODAY)
assert got2 == 0 and st2['table']['q'] == t['q'] and len(REQ) - before == 2, (got2, REQ[before:])
ur2 = add(23, 'C', rev=True, bump=2.0)
INT.append({'symbol': 'ABC', 'xbrl': ur2, 'qe_Date': '30-Sep-2026', 'consolidated': 'Consolidated', 'typeOfSubmission': 'Revised'})
st3, got3 = X.process_stock(nse, 'ABC', TODAY)
assert got3 == 1 and {r[0]: r for r in st3['table']['q']}['Sep 2026'][1] == 125.0, 'the revised figures'
# new reading rules: the kept files read again without NSE
before = len(REQ)
assert X.reread('ABC', TODAY) is False and len(REQ) == before
# the other basis only where the stock's own basis has nothing: XYZ files standalone for Dec 2021 only
for k in (5, 22, 23):
    add(k, 'C' if k > 5 else 'S', sym='XYZ')
LIST['XYZ'] = ({'data': [{'xbrl': url_of(k, 'C', sym='XYZ'), 'qe_Date': QS[k][1].strftime('%d-%b-%Y'), 'consolidated': 'Consolidated'}
                         for k in (22, 23)]},
               [{'xbrl': url_of(5, 'S', sym='XYZ'), 'toDate': '31-MAR-2022', 'consolidated': 'Non-Consolidated'}])
sx, _ = X.process_stock(nse, 'XYZ', TODAY)
bx = {r[0]: r for r in sx['table']['q']}
assert sx['table']['b'] == 'C' and bx['Mar 2022'][-1] == 's' and bx['Sep 2026'][-1] == '', bx.keys()
assert X.eps_quarters(t)[0] == 'C' and X.eps_quarters(t)[1][-1] == [2026 * 12 + 9, 1.88, 18.75]

# ------------------------------------------------------------------ 4. when a stock is read again
now = time.time()
assert X.due('NEW', {}, TODAY, now)
assert not X.due('ABC', {'listed': now, 'table': t}, TODAY, now)
assert X.due('ABC', {'listed': now - 46 * 86400, 'table': t}, TODAY, now), 'every 45 days (revised filings)'
assert not X.due('ABC', {'listed': now - 8 * 86400, 'table': t}, date(2027, 2, 18), now), 'Dec 2026 results not due yet (31-Dec + 50 days)'
assert X.due('ABC', {'listed': now - 8 * 86400, 'table': t}, date(2027, 2, 19), now), 'the next quarter\'s results are due'
assert not X.due('ABC', {'listed': now - 3 * 86400, 'table': t}, date(2027, 2, 19), now), 'at most once a week'

# ------------------------------------------------------------------ 5. the whole job: sheet, posts, pauses, NSE refusing
CALLS = []


def api(cfg, action, payload=None, tries=3, timeout=120):
    CALLS.append((action, json.loads(json.dumps(payload))))
    if payload['op'] == 'syms':
        return {'ok': True, 'syms': ['abc', 'XYZ', 'NONE']}
    return {'ok': True, 'stored': len(payload['items'])}


for s in ('ABC', 'XYZ'):
    os.remove(X._stock_path(s))                       # a fresh start (the kept files stay)
X.POST_MAX = 1
busy = [True, True, False]
res = X.run_all({'url': 'x'}, api, round_busy=lambda: busy.pop(0) if busy else False, gap=0, sleep=nap, today=TODAY)
assert res['done'] == 3 and res['blocked'] == '' and res['left'] == 0, res
assert SLEEPS.count(20) == 2, 'waited while a round ran'
assert [c[1]['op'] for c in CALLS] == ['syms', 'put', 'put'], [c[1]['op'] for c in CALLS]
assert [c[1]['items'][0]['sym'] for c in CALLS[1:]] == ['ABC', 'XYZ'] and CALLS[1][1]['items'][0]['fin']['q'][-1][0] == 'Sep 2026'
assert res['files'] == 0, 'every file was kept from before - nothing downloaded again'
assert any('3 of 3 stock(s) to read' in x for x in LOGS) and any('2 table(s) sent to the sheet' in x for x in LOGS), LOGS[-3:]
del CALLS[:]
res = X.run_all({'url': 'x'}, api, gap=0, sleep=nap, today=TODAY)
assert res['done'] == 0 and [c[1]['op'] for c in CALLS] == [], 'nothing due, nothing new to send (the stocks asked a day ago)'
# NSE refusing: stops, the stock is not marked as read
os.remove(X._stock_path('ABC'))
st_ = X.load_state()
st_['symsAt'] = 0
X.save_state(st_)
STATUS['all'] = 403
del CALLS[:]
res = X.run_all({'url': 'x'}, api, gap=0, sleep=nap, today=TODAY)
assert res['blocked'] and res['done'] == 0 and not os.path.exists(X._stock_path('ABC')), res
STATUS['all'] = None
STATUS.pop('all')
# no internet: the same
X.bind(get=lambda *a, **k: (_ for _ in ()).throw(OSError('offline')))
res = X.run_all({'url': 'x'}, api, gap=0, sleep=nap, today=TODAY)
assert res['blocked'] == 'NSE did not answer' and not os.path.exists(X._stock_path('ABC')), res
X.bind(get=fake_get)
# another program at it: this one does nothing
alive = {'p': True}
X.bind(pid_alive=lambda pid: alive['p'])
with open(X._lock_path(), 'w') as f:
    json.dump({'pid': 1, 'what': 'XbrlHistoryNow', 'at': time.time()}, f)
assert X.run_all({'url': 'x'}, api, gap=0, sleep=nap, today=TODAY) is None
alive['p'] = False
assert X.run_all({'url': 'x'}, api, gap=0, sleep=nap, today=TODAY) is not None, 'its program has gone'
assert not os.path.exists(X._lock_path()), 'released'
# an older web app: no stocks, a hint once
X.save_state({})
r = X.run_all({'url': 'x'}, lambda *a, **k: {'ok': False, 'error': 'unknown action'}, gap=0, sleep=nap, today=TODAY)
assert r['done'] == 0 and any('older version' in x for x in LOGS)

# ------------------------------------------------------------------ 6. the background worker
X.save_state({})
w = X.Worker()
assert w.maybe_start({'url': 'x', 'xbrl_history': False}, api, lambda: False) is False
assert w.maybe_start({'url': 'x', 'xbrl_history_gap_s': 0.001}, api, lambda: False) is True
w.thread.join(30)
assert not w.busy() and w.next_at > time.time() + 3600, 'rests after a finished job'
assert w.maybe_start({'url': 'x'}, api, lambda: False) is False, 'not again before its time'

# ------------------------------------------------------------------ 7. XbrlHistoryCheck.bat
out = []
assert X.check({}, ['abc'], out=out.append, today=TODAY) == 0
text = '\n'.join(out)
assert 'integrated filing:' in text and 'financial results:' in text and 'Quarterly results (consolidated, Rs crore)' in text, text
assert 'Profit & Loss (years)' in text and 'OPM %' in text and 'Sep 2026' in text, text
assert 'Jun 2026  Sales 122.00 | Net Profit 18.75 | EPS 1.88 | OPM % 20.5%' in text, text   # 25 / 122 vs screener.in's 20 %: agrees
assert 'compared with screener.in:' in text and 'nothing was sent to the sheet' in text, text
assert 'Sep 2026  Sales 125.00 (screener.in 130.00)' in text, 'a difference is shown'

# ------------------------------------------------------------------ 8. Historical PE: the filings' quarters
PEH = sb.PEH
rec = {'src': 'page', 'basis': 'C', 'at': 0, 'q': [[2026 * 12 + m, 2.0, 20.0] for m in (3, 6, 9)], 'y': []}
xq = X.eps_quarters(t)
m = PEH.merge_xbrl(rec, xq)
assert len(m['q']) == 20 and m['xbrl'] == 17 and [r for r in m['q'] if r[0] == 2026 * 12 + 9][0][1] == 2.0, 'screener.in stays'
assert PEH.merge_xbrl(dict(rec, basis='S'), xq) is not m and PEH.merge_xbrl(dict(rec, basis='S'), xq)['q'] == rec['q'], 'another basis'
assert PEH.merge_xbrl(None, xq)['src'] == 'xbrl'
days = [d.toordinal() for d in (TODAY - timedelta(days=i) for i in range(2000, -1, -1)) if d.weekday() < 5]
rows = PEH.compute({'ABC': (days[0], days, [100.0] * len(days))}, {}, TODAY.isoformat(), {'ABC': xq})
assert rows['ABC'][0] is not None and rows['ABC'][1] is not None and rows['ABC'][8] == 'NSE XBRL filings', rows['ABC']
rows = PEH.compute({'ABC': (days[0], days, [100.0] * len(days))}, {'ABC': rec}, TODAY.isoformat(), {'ABC': xq})
assert rows['ABC'][8].endswith('+ 17 quarter(s) from NSE XBRL filings') and rows['ABC'][1] is not None, rows['ABC']
assert rows['ABC'][2] is None and 'EPS history shorter than 5Y' in rows['ABC'][9], '5 years need the quarter before Dec 2021'

# ------------------------------------------------------------------ 9. screener_bridge
src = open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read()
assert "xhist.maybe_start(cfg, api, round_running)" in src and "cmd == 'xbrlhistory'" in src and "cmd == 'xbrlhistcheck'" in src
assert sb.DEFAULTS['xbrl_history'] is True and 'xbrl_data' in sb.DP.BIG and "xbrl=XH.hist_quarters" in src
sb.LOCK_PATH = os.path.join(TMP, 'bridge.lock')
assert sb.round_running() is False
with open(sb.LOCK_PATH, 'w') as f:
    json.dump({'pid': os.getpid(), 'boot': sb._boot_time()}, f)
assert sb.round_running() is True
base, _ = sb.use_data_place({'data_folder': ''})
assert X.DIR == os.path.join(base, 'xbrl_data')
print('OK')
