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
             % nature,
             '<xbrli:unit id="INR"><xbrli:measure>iso4217:INR</xbrli:measure></xbrli:unit>',
             '<xbrli:unit id="INRPerShare"><xbrli:divide><xbrli:unitNumerator><xbrli:measure>iso4217:INR</xbrli:measure>'
             '</xbrli:unitNumerator><xbrli:unitDenominator><xbrli:measure>xbrli:shares</xbrli:measure></xbrli:unitDenominator>'
             '</xbrli:divide></xbrli:unit>']
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
            unit = 'INRPerShare' if el.startswith('Basic') else 'INR'
            parts.append('<in-bse-fin:%s contextRef="%s" unitRef="%s" decimals="-5">%s</in-bse-fin:%s>' % (el, cid, unit, repr(v), el))
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
        if 'integrated' in url and isinstance(obj, dict):       # NSE: the newest 20 filings only, or those of the dates asked
            data = obj['data']
            stamp = lambda r: X.stamp_of(X.file_name(r['xbrl']))
            if 'from_date=' in url:
                f, t = (url.split(k + '=')[1].split('&')[0] for k in ('from_date', 'to_date'))
                iso = lambda d: d[6:10] + d[3:5] + d[0:2]
                data = [r for r in data if iso(f) <= stamp(r)[:8] <= iso(t)]
            obj = dict(obj, data=sorted(data, key=lambda r: (stamp(r), r['xbrl']), reverse=True)[:20], total=len(data))
        return 200, json.dumps(obj).encode()
    if url in NSE:
        return 200, NSE[url]
    return 404, b''


def screener_page(rows, years=()):
    """A trimmed screener.in page: rows / years = [(period, sales, net profit, eps, opm)]."""
    def table(rs, ttm=False):         # the yearly table ends with a TTM column, like screener.in's
        head = ''.join('<th>%s</th>' % r[0] for r in rs) + ('<th>TTM</th>' if ttm else '')
        line = lambda name, i: '<tr><td>%s</td>%s</tr>' % (name, ''.join('<td>%s</td>' % r[i] for r in rs) + ('<td>9</td>' if ttm else ''))
        return '<table><thead><tr><th></th>%s</tr></thead><tbody>%s%s%s%s</tbody></table>' % (
            head, line('Sales +', 1), line('Net Profit +', 2), line('EPS in Rs', 3), line('OPM %', 4))
    return ('<html><section id="quarters">%s</section><section id="profit-loss">%s</section>'
            '<section id="balance-sheet"><table><tr><th></th><th>Mar 2026</th></tr><tr><td>Sales</td><td>1</td></tr></table>'
            '</section></html>' % (table(rows), table(years, True) if years else ''))


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
LV = X.LIST_VERSION
assert not X.due('ABC', {'listed': now, 'table': t, 'lv': LV}, TODAY, now)
assert X.due('ABC', {'listed': now, 'table': t, 'lv': LV - 1}, TODAY, now), 'new listing rules: every stock read again'
assert X.due('ABC', {'listed': now - 46 * 86400, 'table': t, 'lv': LV}, TODAY, now), 'every 45 days (revised filings)'
assert not X.due('ABC', {'listed': now - 8 * 86400, 'table': t, 'lv': LV}, date(2027, 2, 18), now), 'Dec 2026 results not due yet (31-Dec + 50 days)'
assert X.due('ABC', {'listed': now - 8 * 86400, 'table': t, 'lv': LV}, date(2027, 2, 19), now), 'the next quarter\'s results are due'
assert not X.due('ABC', {'listed': now - 3 * 86400, 'table': t, 'lv': LV}, date(2027, 2, 19), now), 'at most once a week'

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
assert '   Jun 2026  4 agree\n' in text, text            # OPM 25 / 122 = 20.5 % vs screener.in's 20 %: agrees
assert 'compared with screener.in:' in text and 'nothing was sent to the sheet' in text, text
assert 'Sep 2026  0 agree | Sales 125.00 (screener.in 130.00)' in text, 'a difference is shown'
assert 'quarters: 20 of 20 in the table (Dec 2021 .. Sep 2026) - none missing' in text, text
assert 'years: Mar 2021 (comparison column), Mar 2022,' in text, text
# a differing quarter: every kept file's figures of it (the revised filing and the original) + its own elements
assert "Sep 2026 in each kept file:" in text and text.count("(its own quarter, consolidated, filed 2026-11-14 18:30, revised): Sales 125.00 · Expenses 98.00") == 1, text
assert 'every figure of Sep 2026 in INTEGRATED_FILING_INDAS_ABC_CR_' in text and 'RevenueFromOperations = 125.0' in text, text
assert 'BasicEarningsLossPerShare = 2.02' in text, 'EPS as filed, not in crore'

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
# ------------------------------------------------------------------ 10. version 2 (the owner's check of TCS / HDFCBANK / BSE)
X.DIR = os.path.join(TMP, 'xbrl_data')        # section 9 pointed it at the program's own folder
X.bind(get=fake_get)
nse = X.Nse(0, nap)


def recs(sym, ks, kind='C', urls=None):
    out = []
    for k in ks:
        e = QS[k][1]
        out.append({'xbrl': (urls or {}).get(k) or url_of(k, kind, sym=sym), 'qe_Date': e.strftime('%d-%b-%Y'),
                    'consolidated': 'Consolidated' if kind == 'C' else 'Standalone'})
    return out


# a) BSE's 2:1 bonus (3x shares) from Jun 2025: the filings before it give EPS on 10 crore shares, the later ones (and their
#    comparison columns - restated) on 30 crore -> the table's EPS on today's 30 crore everywhere + a note
def bon_filing(k):
    S = 30.0 if k >= 18 else 10.0

    def f(kk):
        d = figs(kk)
        d['BasicEarningsLossPerShare'] = round(d['ProfitLossForPeriod'] / 1e7 / S, 2)
        return d

    def yf(ks):
        d = year_figs(ks)
        d['BasicEarningsLossPerShare'] = round(sum(f(x)['BasicEarningsLossPerShare'] for x in ks), 2)
        return d
    e = QS[k][1]
    per = [(qstart(e, 3), e, f(k)), (qstart(QS[k - 1][1], 3), QS[k - 1][1], f(k - 1)), (qstart(QS[k - 4][1], 3), QS[k - 4][1], f(k - 4))]
    if e.month == 3:
        per += [(qstart(e, 12), e, yf(range(k - 3, k + 1))), (qstart(QS[k - 4][1], 12), QS[k - 4][1], yf(range(k - 7, k - 3)))]
    return xml('Consolidated', per)


for k in range(8, 24):
    NSE[url_of(k, sym='BON')] = bon_filing(k)
LIST['BON'] = ({'data': recs('BON', range(8, 24))}, [])
tb = X.process_stock(nse, 'BON', TODAY)[0]['table']
qe = {r[0]: r[12] for r in tb['q']}
assert qe['Mar 2025'] == 0.63 and qe['Jun 2025'] == 0.62 and qe['Dec 2022'] == 0.63, qe     # 1.88 / 3 and the filed 0.62
ye_ = {r[0]: r[12] for r in tb['y']}
assert ye_['Mar 2025'] == 2.51 and ye_['Mar 2026'] == 2.48 and ye_['Mar 2022'] == 2.51, ye_      # 7.52 / 3
assert tb['note'] == "EPS adjusted for a bonus / split (today's share count): up to Mar 2025 divided by 3", tb['note']
assert {r[0]: r[11] for r in tb['q']}['Mar 2025'] == 18.75, 'only the EPS changes'
assert X.eps_quarters(tb)[1][0][1] == 0.63, 'Historical PE gets the adjusted EPS'
# the share-count steps: a clear ratio only, a period that cannot tell takes the newer one's factor, offsetting steps
fa, note = X.eps_factors([('q', 100, {'pat': 17.0, 'eps': 1.0}), ('q', 97, {'pat': 10.0, 'eps': 1.0})])
assert fa == {('q', 100): 1.0, ('q', 97): 1.0} and note == '', 'a merger\'s odd ratio (1.7) is left alone'
fa, note = X.eps_factors([('q', 100, {'pat': 10.0, 'eps': 10.0}), ('q', 97, {'pat': 10.0, 'eps': 1.0})])
assert abs(fa[('q', 97)] - 0.1) < 1e-9 and note.endswith('up to Jan 8 multiplied by 10'), (fa, note)   # a reverse split
fa, note = X.eps_factors([('q', 100, {'pat': 30.0, 'eps': 1.0}), ('q', 97, {'pat': 1.0, 'eps': 0.3}),
                          ('q', 94, {'pat': 10.0, 'eps': 1.0}), ('q', 91, {'pat': 30.0, 'eps': 1.0}),
                          ('q', 88, {'pat_owners': 9.0, 'pat': 12.0, 'eps': 0.9})])
assert [fa[('q', m)] for m in (100, 97, 94, 91, 88)] == [1.0, 1.0, 3.0, 1.0, 3.0], fa
assert note.endswith('up to Oct 7 divided by 3, up to Apr 7 divided by 3'), note

# b) a year with no yearly figures read = the sum of its 4 quarters (flag 'q'): QQQ's March files carry the quarter only
def q_filing(k):
    e = QS[k][1]
    return xml('Consolidated', [(qstart(e, 3), e, figs(k)), (qstart(QS[k - 1][1], 3), QS[k - 1][1], figs(k - 1)),
                                (qstart(QS[k - 4][1], 3), QS[k - 4][1], figs(k - 4))])


for k in range(4, 24):
    NSE[url_of(k, sym='QQQ')] = q_filing(k)
LIST['QQQ'] = ({'data': recs('QQQ', range(4, 24))}, [])
tq = X.process_stock(nse, 'QQQ', TODAY)[0]['table']
assert [(r[0], r[-1]) for r in tq['y']] == [('Mar 2022', 'q'), ('Mar 2023', 'q'), ('Mar 2024', 'q'), ('Mar 2025', 'q'),
                                            ('Mar 2026', 'q')], tq['y']        # Mar 2021: its Jun 2020 quarter is not known
yq = {r[0]: r for r in tq['y']}['Mar 2026']
assert yq[1] == sum(100 + k for k in (18, 19, 20, 21)) and yq[10] == 25.0 and yq[11] == 75.0 and yq[12] == 7.52, yq
assert yq[4] == round(100.0 / yq[1] * 100, 1), 'OPM of the year = its operating profit / its sales'

# c) the March quarter: the quarter file has no year -> the year file (cumulative) of the same quarter is read too; then no more
e21 = QS[21][1]
MA = url_of(21, sym='MAR')
NSE[MA] = q_filing(21)
MB = MA.replace('_WEB.xml', '_CUM_WEB.xml').replace('10052026', '12052026')
MC = MA.replace('_WEB.xml', '_CUM_WEB.xml').replace('10052026', '11052026')
NSE[MB] = xml('Consolidated', [(qstart(e21, 12), e21, year_figs(range(18, 22))),
                               (qstart(QS[17][1], 12), QS[17][1], year_figs(range(14, 18)))])
NSE[MC] = NSE[MB]
for k in (22, 23):
    NSE[url_of(k, sym='MAR')] = filing(k)
cum = lambda u, c: {'xbrl': u, 'qe_Date': '31-Mar-2026', 'consolidated': 'Consolidated', 'cumulative': c}
LIST['MAR'] = ({'data': recs('MAR', (22, 23)) + [cum(MC, 'Cumulative'), cum(MA, 'Non-cumulative'), cum(MB, 'Cumulative')]}, [])
before = len(REQ)
tm = X.process_stock(nse, 'MAR', TODAY)[0]['table']
asked = REQ[before:]
assert MA in asked and MB in asked and MC not in asked, asked
assert [(r[0], r[-1]) for r in tm['y']] == [('Mar 2025', 'c'), ('Mar 2026', '')], tm['y']
# at most QUARTER_READS downloads for one quarter
many = [MA.replace('_WEB.xml', '_%d_WEB.xml' % n) for n in range(5)]
for u in many:
    NSE[u] = q_filing(21)
LIST['MR2'] = ({'data': [cum(u, 'Non-cumulative') for u in many]}, [])
before = len(REQ)
X.process_stock(nse, 'MR2', TODAY)
assert len([u for u in REQ[before:] if u in many]) == X.QUARTER_READS == 3

# d) files that cannot be used: remembered with the reason; tried again only when the reason may pass
F404 = url_of(20, sym='FAIL')
FHTML = url_of(21, sym='FAIL')
NSE[FHTML] = b'<!DOCTYPE html><html><body>Access Denied</body></html>'
FDIM = url_of(22, sym='FAIL')
NSE[FDIM] = filing(22).replace(b'<xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>',
                               b'<xbrli:identifier scheme="x">X</xbrli:identifier><xbrli:segment><xbrldi:explicitMember '
                               b'dimension="in-bse-fin:NatureAxis">in-bse-fin:ConsolidatedMember</xbrldi:explicitMember>'
                               b'</xbrli:segment></xbrli:entity>')
F6M = url_of(19, sym='FAIL')
NSE[F6M] = xml('Consolidated', [(qstart(QS[19][1], 6), QS[19][1], figs(19))])
FNOP = url_of(18, sym='FAIL')
NSE[FNOP] = xml('Consolidated', [])                      # an instant context only - no period at all
NSE[url_of(23, sym='FAIL')] = filing(23)
LIST['FAIL'] = ({'data': recs('FAIL', (18, 19, 20, 21, 22, 23))}, [])
sf = X.process_stock(nse, 'FAIL', TODAY)[0]
fl = {u: sf['files'][X.file_name(u)] for u in (F404, FHTML, FDIM, F6M, FNOP)}
assert (fl[F404]['fail'], fl[F404]['retry']) == ('NSE answered HTTP 404', False), fl[F404]
assert fl[FHTML]['fail'] == 'a web page came back, not the XML file' and fl[FHTML]['retry'] is True
assert not os.path.exists(os.path.join(X.DIR, 'files', 'FAIL', X.file_name(FHTML))), 'a web page is not kept as a filing'
# NSE's older format (owner's HDFCBANK 2021-2023 / BSE 2021-22 files): a member on every context -> read through them
assert 'fail' not in fl[FDIM] and fl[FDIM]['older'] == 'in-bse-fin:ConsolidatedMember', fl[FDIM]
assert fl[FNOP]['fail'] == 'no context with a period (1 context(s))' and fl[FNOP]['retry'] is False, fl[FNOP]
assert os.path.exists(os.path.join(X.DIR, 'files', 'FAIL', X.file_name(FNOP))), 'the filing itself is kept (a later rule may read it)'
assert fl[F6M]['fail'] == 'no 3- or 12-month period in it (periods: 2025-04-01..2025-09-30)' and fl[F6M]['retry'] is False, fl[F6M]
bq = {r[0]: r for r in sf['table']['q']}
assert bq['Jun 2026'][-1] == '' and bq['Jun 2026'][1] == 122.0, 'read from the older-format file (the segment value 999 not taken)'
assert [bq.get(l, [''])[-1] for l in ('Mar 2026', 'Sep 2025', 'Jun 2025')] == ['c', 'c', 'c'] and 'Dec 2025' not in bq, bq.keys()
assert sf['tried']['2025-12-31'] == [[X.file_name(F404), 'NSE answered HTTP 404']], sf['tried']
before = len(REQ)
X.process_stock(nse, 'FAIL', TODAY)
assert [u for u in REQ[before:] if u.endswith('.xml')] == [FHTML], 'only the web page is asked again'
NSE[FHTML] = filing(21)
sf = X.process_stock(nse, 'FAIL', TODAY)[0]
assert 'fail' not in sf['files'][X.file_name(FHTML)] and 'Mar 2026' in {r[0] for r in sf['table']['q']}
# a web page an earlier version kept as a filing: read again from NSE
with open(os.path.join(X.DIR, 'files', 'FAIL', X.file_name(F6M)), 'wb') as fh:
    fh.write(b'<html><body>Access Denied</body></html>')
X.reread('FAIL', TODAY)
assert X.load_stock('FAIL')['files'][X.file_name(F6M)]['v'] == 0
before = len(REQ)
X.process_stock(nse, 'FAIL', TODAY)
assert F6M in REQ[before:]
out = []
LIST.setdefault('NOPE', ({'data': []}, []))
X.check({}, ['fail'], out=out.append, today=TODAY)
text = '\n'.join(out)
assert 'could not be used:' in text and '2025-12-31  ' + X.file_name(F404) + ' - NSE answered HTTP 404' in text, text
assert '2025-06-30  ' + X.file_name(FNOP) + ' - no context with a period (1 context(s))' in text, text
assert "1 file(s) of NSE's older format read through their dimension contexts (2026-06-30 .. 2026-06-30)" in text, text
assert 'quarters: 7 of 20 in the table (Dec 2021 .. Sep 2026)' in text and 'Dec 2024 missing - no XBRL file for it in NSE\'s lists' in text, text
o3 = []
labels = [X.label_of(2026 * 12 + 3 - 3 * k) for k in range(20)][::-1]
X.coverage({'tried': {'2025-12-31': [['A_WEB.xml', 'NSE answered HTTP 404']], '2025-09-30': [['B_WEB.xml', 'ok']]}},
           {'q': [[l] + [None] * 12 + [''] for l in labels if l not in ('Sep 2025', 'Dec 2025')], 'y': []}, o3.append)
assert o3 == ['   quarters: 18 of 20 in the table (Jun 2021 .. Mar 2026)',
              '      Sep 2025 missing - B_WEB.xml: read, but no 3-month figures of this quarter in it',
              '      Dec 2025 missing - A_WEB.xml: NSE answered HTTP 404'], o3

# e) a bank (the banking format): Interest = interest expended, Expenses = operating expenses + provisions, Financing Profit
def bank_figs(k):
    cr = 1e7
    rev, intx, opex, prov, oi = 1000.0 + k, 600.0, 200.0, 50.0, 100.0
    pbt = rev - intx - opex - prov + oi
    tax = pbt * 0.25
    pat = pbt - tax
    return {'InterestEarned': rev * cr, 'InterestExpended': intx * cr, 'OperatingExpenses': opex * cr,
            'ProvisionsOtherThanTaxAndContingencies': prov * cr, 'OtherIncome': oi * cr,
            'ProfitLossFromOrdinaryActivitiesBeforeTax': pbt * cr, 'TaxExpense': tax * cr, 'ProfitLossForThePeriod': pat * cr,
            'BasicEarningsPerShareAfterExtraordinaryItems': round(pat / 100, 2)}


for k in (22, 23):
    e = QS[k][1]
    NSE[url_of(k, sym='BNK')] = xml('Consolidated', [(qstart(e, 3), e, bank_figs(k)), (qstart(QS[k - 1][1], 3), QS[k - 1][1], bank_figs(k - 1))])
LIST['BNK'] = ({'data': recs('BNK', (22, 23))}, [])
tk = X.process_stock(nse, 'BNK', TODAY)[0]['table']
rk = {r[0]: r for r in tk['q']}['Sep 2026']
assert tk['k'] == 'bank' and rk[1:13] == [1023.0, 250.0, 173.0, 16.9, 100.0, None, 600.0, None, 273.0, 25.0, 204.75, 2.05], rk
out = []
X.check({}, ['BNK', 'facts'], out=out.append, today=TODAY)
text = '\n'.join(out)
assert 'Financing Profit' in text and '   Revenue ' in text and 'Financing Margin %' in text, text
assert 'every figure of Sep 2026 in' in text and 'InterestExpended = 600.0' in text, 'facts: the newest quarter\'s elements'
assert 'FACTS - NSE' not in text, '"facts" is not a symbol'

# f) the comparison: years too, Other Income with the exceptional items (screener.in's way), EPS within 2 %
X.bind(screener=lambda cfg, sym, cons=True: ('ok', screener_page(
    [('Jun 2026', 122, 18.75, 1.86, 20), ('Sep 2026', 125, 20.25, 2.02, 22)],
    [('Mar 2025', 462, 75, 7.52, 22), ('Mar 2026', 478, 80, 7.52, 21)])))
out = []
X.check({}, ['abc'], out=out.append, today=TODAY)
text = '\n'.join(out)
assert '   Jun 2026  4 agree\n' in text, 'EPS 1.88 vs 1.86: within 2 %'
assert '   Mar 2025  4 agree\n' in text and 'Mar 2026  3 agree | Net Profit 75.00 (screener.in 80.00)' in text, text
row = ['Sep 2026', 100.0, 80.0, 20.0, 20.0, 5.0, -2.0, 1.0, 1.0, 22.0, 25.0, 16.5, 1.65, '']
o2 = []
assert X.compare_rows({}, [row], {'other_income': {'Sep 2026': 3.0}}, o2.append) == (1, 0, [], 1), o2
assert X.parse_periods(b'<a>', why=[]) is None
w = []
X.parse_periods(b'<x', w)
assert w and w[0].startswith('not readable as XML'), w

# h) version 3 (the owner's HDFCBANK / BSE check with 'facts', 18-Nov-2026)
# the older format: the context with the fewest members wins, wherever it stands in the file
seg = ('<xbrli:context id="S"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier><xbrli:segment>'
       '<xbrldi:explicitMember dimension="a:A">a:One</xbrldi:explicitMember><xbrldi:explicitMember dimension="a:B">a:Seg1'
       '</xbrldi:explicitMember></xbrli:segment></xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate>'
       '<xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>')
main = seg.replace('id="S"', 'id="M"').replace('<xbrldi:explicitMember dimension="a:B">a:Seg1</xbrldi:explicitMember>', '')
doc = ('<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:a="x">'
       + seg + main + '<a:RevenueFromOperations contextRef="S">5000000000</a:RevenueFromOperations>'
       '<a:RevenueFromOperations contextRef="M">1230000000</a:RevenueFromOperations></xbrli:xbrl>').encode()
pp = X.parse_periods(doc)
assert pp['periods'][0]['f'] == {'revenue': 123.0} and pp['older'] == 'a:One', pp
assert X.facts_dump(doc, '2026-09-30') == [('RevenueFromOperations', 1230000000.0)], 'no unit: as filed'
# BSE: the share of associates' profit added after tax -> screener.in's Other Income and PBT (145 / 1,072)
bse = {'revenue': 1432.66, 'expenses': 505.67, 'finance_costs': 0.0, 'depreciation': 46.07, 'other_income': 117.88,
       'exceptional': 0.0, 'pbt': 1044.87, 'tax': 264.87, 'pat': 807.52, 'assoc': 27.52, 'eps': 19.64}
assert X.row_of(bse) == [1432.66, 459.6, 973.06, 67.9, 145.4, 0.0, 0.0, 46.07, 1072.39, 24.7, 807.52, 19.64], X.row_of(bse)
above = dict(bse, pbt=1072.39)                         # a filing whose PBT already has it: nothing added
assert X.row_of(above)[4] == 117.88 and X.row_of(above)[8] == 1072.39
assoc_doc = xml('Consolidated', [(date(2026, 7, 1), date(2026, 9, 30), dict(figs(23), ShareOfProfitLossOfAssociatesAndJointVenturesAccountedForUsingEquityMethod=2.5e7))])
assert X.parse_periods(assoc_doc)['periods'][0]['f']['assoc'] == 2.5, 'read by the start of its long name'
# HDFCBANK: screener.in leaves the bank's ExceptionalItems out of PBT and Net Profit (28,663 / 21,537)
hdfc = {'revenue': 95131.63, 'int_exp': 50667.0, 'opex': 45820.0, 'provisions': 4209.0, 'other_income': 34227.06,
        'exceptional': -837.06, 'pbt_ord': 27825.0, 'tax': 7125.0, 'pat': 20700.03, 'eps_x': 13.43, 'assoc': 0.0}
assert X.row_of(hdfc) == [95131.63, 50029.0, -5564.37, -5.8, 34227.06, -837.06, 50667.0, None, 28662.06, 24.9, 21537.09, 13.43], X.row_of(hdfc)

# i) NSE's integrated list gives the newest 20 filings only (owner's HDFCBANK Mar 2025, on NSE's page but not read):
#    a full page is asked again half a year at a time, back to the start of integrated filing
CAPR = []
for k in range(17, 24):
    for kind in ('C', 'S'):
        u = url_of(k, kind, sym='CAP')
        NSE[u] = filing(k, 'Consolidated' if kind == 'C' else 'Standalone')
        CAPR.append({'xbrl': u, 'qe_Date': QS[k][1].strftime('%d-%b-%Y'), 'consolidated': 'Consolidated' if kind == 'C' else 'Standalone'})
    CAPR.append({'xbrl': 'https://nsearchives.nseindia.com/corporate/xbrl/INTEGRATED_FILING_GOVERNANCE_CAP_%s_WEB.xml'
                 % (QS[k][1] + timedelta(days=60)).strftime('%d%m%Y183000'), 'qe_Date': QS[k][1].strftime('%d-%b-%Y')})
LIST['CAP'] = ({'data': CAPR}, [])                     # 21 filings: Mar 2025's consolidated one is the 21st
before = len(REQ)
out = []
sc = X.process_stock(nse, 'CAP', TODAY, say=out.append)[0]
asked = [u for u in REQ[before:] if 'from_date=' in u and 'integrated' in u]
assert [u.split('from_date=')[1] for u in asked] == ['01-10-2024&to_date=31-03-2025', '01-04-2025&to_date=30-09-2025'], asked
assert {r[0]: r[-1] for r in sc['table']['q']}['Mar 2025'] == '', 'the consolidated Mar 2025 filing found by the dated ask'
text = '\n'.join(out)
assert 'integrated filing: 20 record(s)' in text and 'the answer also has: total=21' in text, text
assert 'integrated filing (dated) 01-04-25..30-09-25: 6 record(s)' in text, text
assert X.due('CAP', dict(X.load_stock('CAP'), lv=2), TODAY, time.time()), 'every stock read once more (LIST_VERSION 3)'

# g) the background job reads every stock's lists again once (LIST_VERSION) and the kept files with the new rules
st_ = X.load_stock('ABC')
st_['lv'] = 1
X.save_stock(st_)
assert X.due('ABC', st_, TODAY, time.time())
print('OK')
