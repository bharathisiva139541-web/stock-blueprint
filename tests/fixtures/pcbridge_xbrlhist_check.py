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
X.MARKET = None                                  # the market-hours rule has its own test (section 12)
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
        if months > 3:                                                   # the 6 / 9-month year-to-date column
            per.append((qstart(e, months), e, year_figs(range(k - months // 3 + 1, k + 1))))
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
    ('2025-09-30', 3), ('2026-06-30', 3), ('2026-09-30', 3), ('2026-09-30', 6)], p['periods']   # + the half year (VERSION 7)
own = [q for q in p['periods'] if q['end'] == '2026-09-30' and q['m'] == 3][0]['f']
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
NOSC = {'url': 'x', 'xbrl_history_screener': False}        # screener.in's pages: section 13
busy = [True, True, False]
res = X.run_all(NOSC, api, round_busy=lambda: busy.pop(0) if busy else False, gap=0, sleep=nap, today=TODAY)
assert res['done'] == 3 and res['blocked'] == '' and res['left'] == 0, res
assert SLEEPS.count(20) == 2, 'waited while a round ran'
assert [c[1]['op'] for c in CALLS] == ['syms', 'put', 'put'], [c[1]['op'] for c in CALLS]
assert [c[1]['items'][0]['sym'] for c in CALLS[1:]] == ['ABC', 'XYZ'] and CALLS[1][1]['items'][0]['fin']['q'][-1][0] == 'Sep 2026'
assert res['files'] == 0, 'every file was kept from before - nothing downloaded again'
assert any('3 of 3 stock(s) to read' in x for x in LOGS) and any('2 table(s) sent to the sheet' in x for x in LOGS), LOGS[-3:]
assert any('waiting - the laptop\'s round is asking NSE right now (just started)' in x for x in LOGS), 'a line when it waits'
assert any('the round is done with NSE - reading again' in x for x in LOGS)
assert X._left_words(30) == '' and X._left_words(150) == ', about 2 min left' and X._left_words(15 * 3600 + 600) == ', about 15 h 10 min left'
assert X.CMD_SAY_EVERY == 5 and 'every=XH.CMD_SAY_EVERY' in open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read()
del CALLS[:]
res = X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY)
assert res['done'] == 0 and [c[1]['op'] for c in CALLS] == [], 'nothing due, nothing new to send (the stocks asked a day ago)'
# NSE refusing: stops, the stock is not marked as read
os.remove(X._stock_path('ABC'))
st_ = X.load_state()
st_['symsAt'] = 0
X.save_state(st_)
STATUS['all'] = 403
del CALLS[:]
res = X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY)
assert res['blocked'] and res['done'] == 0 and not os.path.exists(X._stock_path('ABC')), res
STATUS['all'] = None
STATUS.pop('all')
# no internet: the same
X.bind(get=lambda *a, **k: (_ for _ in ()).throw(OSError('offline')))
res = X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY)
assert res['blocked'] == 'NSE did not answer' and not os.path.exists(X._stock_path('ABC')), res
X.bind(get=fake_get)
# another program at it: this one does nothing
alive = {'p': True}
X.bind(pid_alive=lambda pid: alive['p'])
with open(X._lock_path(), 'w') as f:
    json.dump({'pid': 1, 'what': 'XbrlHistoryNow', 'at': time.time()}, f)
assert X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY) is None
alive['p'] = False
assert X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY) is not None, 'its program has gone'
assert not os.path.exists(X._lock_path()), 'released'
# an older web app: no stocks, a hint once
X.save_state({})
r = X.run_all(NOSC, lambda *a, **k: {'ok': False, 'error': 'unknown action'}, gap=0, sleep=nap, today=TODAY)
assert r['done'] == 0 and any('older version' in x for x in LOGS)

# ------------------------------------------------------------------ 6. the background worker
X.save_state({})
w = X.Worker()
assert w.maybe_start({'url': 'x', 'xbrl_history': False}, api, lambda: False) is False
assert w.maybe_start({'url': 'x', 'xbrl_history_gap_s': 0.001, 'xbrl_history_screener': False}, api, lambda: False) is True
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
assert "xhist.maybe_start(cfg, api, nse_busy, screener_busy=round_running)" in src and "cmd == 'xbrlhistory'" in src and "cmd == 'xbrlhistcheck'" in src
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
NSE[F6M] = xml('Consolidated', [(qstart(QS[19][1], 2), QS[19][1], figs(19))])   # 2 months: no period we read
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
assert fl[F6M]['fail'] == 'no 3- or 12-month period in it (periods: 2025-08-01..2025-09-30)' and fl[F6M]['retry'] is False, fl[F6M]
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

# j) version 4 (the owner's HDFCBANK / BSE check after the dated asks, 18-Nov-2026)
# BSE Jun 2025: discontinued operations (after tax) + associates' share -> screener.in's Other Income / PBT (115 / 713)
jun = {'revenue': 958.39, 'expenses': 359.34, 'finance_costs': 0.0, 'depreciation': 26.88, 'other_income': 86.06,
       'exceptional': 0.0, 'pbt': 685.11, 'tax': 175.18, 'pat': 538.17, 'assoc': 16.29, 'disc': 11.95, 'eps': 13.09}
assert X.row_of(jun)[4] == 114.3 and X.row_of(jun)[8] == 713.35 and X.row_of(jun)[9] == 24.6, X.row_of(jun)
assert X.row_of(dict(jun, disc=0.0, pat=526.22))[4] == 102.35, 'associates only'
assert X.row_of(dict(jun, pat=543.0))[4] == 86.06, 'nothing explains the net profit: nothing added'
disc_doc = xml('Consolidated', [(date(2026, 7, 1), date(2026, 9, 30), dict(figs(23), ProfitLossFromDiscontinuedOperationsAfterTax=1.5e7))])
assert X.parse_periods(disc_doc)['periods'][0]['f']['disc'] == 1.5
# an older file whose figures sit on an instant context, the period stated in DateOfStart / EndOfReportingPeriod
ctxi = ('<xbrli:context id="OneI"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>'
        '<xbrli:period><xbrli:instant>2025-09-30</xbrli:instant></xbrli:period><xbrli:scenario><xbrldi:explicitMember '
        'dimension="a:A">a:One</xbrldi:explicitMember></xbrli:scenario></xbrli:context>')
ctxd = ('<xbrli:context id="Cf"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>'
        '<xbrli:period><xbrli:startDate>2025-07-01</xbrli:startDate><xbrli:endDate>2025-09-30</xbrli:endDate></xbrli:period>'
        '<xbrli:scenario><xbrldi:explicitMember dimension="a:A">a:Two</xbrldi:explicitMember></xbrli:scenario></xbrli:context>')
head = '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:xbrldi="http://xbrl.org/2006/xbrldi" xmlns:a="x">'
old_doc = (head + ctxi + '<a:DateOfStartOfReportingPeriod contextRef="OneI">2025-07-01</a:DateOfStartOfReportingPeriod>'
           '<a:DateOfEndOfReportingPeriod contextRef="OneI">2025-09-30</a:DateOfEndOfReportingPeriod>'
           '<a:RevenueFromOperations contextRef="OneI">1230000000</a:RevenueFromOperations></xbrli:xbrl>').encode()
po = X.parse_periods(old_doc)
assert po['periods'][0]['start'] == '2025-07-01' and po['periods'][0]['f'] == {'revenue': 123.0}, po
assert X.facts_dump(old_doc, '2025-09-30')[-1] == ('RevenueFromOperations', 1230000000.0)
w = []
assert X.parse_periods((head + ctxi + ctxd + '<a:Other contextRef="Cf">5</a:Other>'
                        '<a:RevenueFromOperations contextRef="OneI">1230000000</a:RevenueFromOperations></xbrli:xbrl>').encode(), w)['periods'] == []
assert w == ['none of the figures we know is in a 3- or 12-month period (RevenueFromOperations: context OneI = instant 2025-09-30, '
             '1.5 member(s))'], w

# k) version 5: the owner's older files name 'OneD' for their figures but define only dimension contexts of that column
def octx(cid, s0, e0, mem):
    return ('<xbrli:context id="%s"><xbrli:entity><xbrli:identifier scheme="x">X</xbrli:identifier></xbrli:entity>'
            '<xbrli:period><xbrli:startDate>%s</xbrli:startDate><xbrli:endDate>%s</xbrli:endDate></xbrli:period>'
            '<xbrli:scenario><xbrldi:explicitMember dimension="a:A">a:%s</xbrldi:explicitMember></xbrli:scenario>'
            '</xbrli:context>' % (cid, s0, e0, mem))
odoc = (head + octx('OneOperatingExpenses01D', '2023-07-01', '2023-09-30', 'OneOperatingExpenses01Member')
        + octx('OneOperatingExpenses02D', '2023-07-01', '2023-09-30', 'OneOperatingExpenses02Member')
        + octx('FourOperatingExpenses01D', '2023-04-01', '2023-09-30', 'FourOperatingExpenses01Member')
        + '<a:RevenueFromOperations contextRef="OneD">1230000000</a:RevenueFromOperations>'
        '<a:RevenueFromOperations contextRef="FourD">2400000000</a:RevenueFromOperations>'
        '<a:OtherExpenses contextRef="OneOperatingExpenses01D">10000000</a:OtherExpenses>'
        '<a:BasicEarningsLossPerShare contextRef=" OneD ">1.5</a:BasicEarningsLossPerShare></xbrli:xbrl>').encode()
pk = X.parse_periods(odoc)
assert [(q['start'], q['end'], q['f']) for q in pk['periods']] == [('2023-04-01', '2023-09-30', {'revenue': 240.0}),
                                                                   ('2023-07-01', '2023-09-30', {'revenue': 123.0, 'eps': 1.5})], pk
assert pk['older'] == "contexts FourD, OneD not in the file - their period from the file's other contexts", pk['older']
assert ('RevenueFromOperations', 1230000000.0) in X.facts_dump(odoc, '2023-09-30')
w = []
X.parse_periods((head + octx('Ax', '2023-07-01', '2023-09-30', 'M') + '<a:Other contextRef="Ax">1</a:Other>'
                 '<a:RevenueFromOperations contextRef="OneD">1230000000</a:RevenueFromOperations></xbrli:xbrl>').encode(), w)
assert w == ["none of the figures we know is in a 3- or 12-month period (RevenueFromOperations: its context OneD is not in the "
             "file; its 1 context(s): Ax)"], w

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

# ------------------------------------------------------------------ 11. screener.in fills what NSE has no filing for
# (owner, 18-Nov-2026, ARSSBL: listed on NSE on 30-09-2025, so its filings start with the Sep 2025 quarter - screener.in
# shows quarters from Jun 2024 and the years from Mar 2020 (S), from the IPO papers; "take that also")
assert sb.PEH.ON_PAGE and sb.PEH.ON_PAGE[-1] is X.keep_screener, 'every screener.in page the program reads is handed over'
QH = ['Jun 2024', 'Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']
SCQ = {'Sales +': [211, 231, 204, 200, 201, 227, 248, 256, 246, 273], 'Expenses +': [135, 145, 127, 127, 126, 135, 147, 145, 149, 173],
       'Operating Profit': [76, 86, 77, 73, 75, 93, 101, 110, 97, 100], 'OPM %': ['36%', '37%', '38%', '37%', '37%', '41%', '41%', '43%', '40%', '37%'],
       'Other Income +': [0, 0, 0, 0, 1, 1, 1, 0, -21, 0], 'Interest': [30, 35, 43, 39, 38, 50, 46, 50, 40, 38],
       'Depreciation': [6, 6, 6, 8, 6, 7, 6, 7, 5, 6], 'Profit before tax': [41, 45, 29, 26, 30, 38, 50, 54, 31, 56],
       'Tax %': ['25%', '27%', '25%', '28%', '25%', '26%', '26%', '23%', '26%', '25%'], 'Net Profit +': [31, 33, 22, 18, 23, 28, 37, 42, 23, 42],
       'EPS in Rs': [4.90, 5.30, 3.45, 2.95, 3.66, 4.45, 5.90, 6.63, 3.70, 6.65]}
YH = ['Mar 2020 (S)', 'Mar 2021 (S)', 'Mar 2022 (S)', 'Mar 2023', 'Mar 2024', 'Mar 2025', 'Mar 2026', 'TTM']
SCY = {'Sales +': [246, 303, 423, 468, 682, 846, 932, '1,023'], 'Expenses +': [201, 253, 309, 353, 451, 534, 553, 615],
       'Operating Profit': [44, 49, 114, 115, 231, 311, 380, 409], 'OPM %': ['18%', '16%', '27%', '25%', '34%', '37%', '41%', '40%'],
       'Other Income +': [4, 0, 0, 1, 1, 1, 2, -19], 'Interest': [27, 21, 37, 49, 97, 147, 184, 174],
       'Depreciation': [11, 10, 13, 15, 20, 25, 26, 25], 'Profit before tax': [10, 19, 64, 51, 115, 140, 172, 191],
       'Tax %': ['31%', '29%', '20%', '26%', '33%', '26%', '25%', ''], 'Net Profit +': [7, 13, 51, 38, 77, 104, 129, 144],
       'EPS in Rs': [1.08, 2.11, 8.20, 6.05, 12.39, 16.60, 20.61, 22.88], 'Dividend Payout %': ['0%'] * 7 + ['']}


def sc_page(basis='Consolidated'):
    def table(head, rows):
        return ('<table class="data-table"><thead><tr><th class="text"></th>%s</tr></thead><tbody>%s</tbody></table>' % (
            ''.join('<th>%s</th>' % h for h in head),
            ''.join('<tr><td class="text"><button>%s</button></td>%s</tr>' % (k, ''.join('<td>%s</td>' % v for v in vs)) for k, vs in rows.items())))
    return ('<html><section id="quarters" class="card"><div><h2>Quarterly Results</h2><p>%s Figures in Rs. Crores / View Standalone</p>'
            '</div>%s</section><section id="profit-loss"><h2>Profit &amp; Loss</h2><p>%s Figures in Rs. Crores</p>%s'
            '<p>(S): Standalone figures, shown where consolidated figures are not available.</p></section>'
            '<section id="balance-sheet"><table><tr><th></th><th>Mar 2026</th></tr><tr><td>Reserves</td><td>1</td></tr></table></section>'
            '</html>' % (basis, table(QH, SCQ), basis, table(YH, SCY)))


p_ = X.screener_parse(sc_page())
assert p_['b'] == 'C' and p_['k'] == '' and [r[0] for r in p_['q']] == QH, p_['q']
assert [r[0] for r in p_['y']] == [h[:8] for h in YH[:-1]], 'TTM left out, the (S) years kept'
assert p_['y'][0] == ['Mar 2020', 246, 201, 44, 18, 4, None, 27, 11, 10, 31, 7, 1.08, 's'], p_['y'][0]
assert p_['q'][-1][1:] == [273, 173, 100, 37, 0, None, 38, 6, 56, 25, 42, 6.65, ''], p_['q'][-1]


def qfile(end, rev, np_, eps, year=None):
    per = [{'start': end[:8] + '01', 'end': end, 'm': 3, 'f': {'revenue': rev, 'expenses': rev * 0.6, 'finance_costs': 40.0,
           'depreciation': 6.0, 'other_income': 0.5, 'pbt': np_ * 1.35, 'tax': np_ * 0.35, 'pat': np_, 'eps': eps}}]
    if year:
        per.append({'start': '2025-04-01', 'end': end, 'm': 12, 'f': {'revenue': year, 'expenses': year * 0.6, 'finance_costs': 180.0,
                    'depreciation': 26.0, 'other_income': 2.0, 'pbt': 172.0, 'tax': 43.0, 'pat': 129.4, 'eps': 20.6}})
    return {'url': 'u', 'end': end, 'basis': 'C', 'rev': False, 'stamp': end.replace('-', '') + '180000', 'v': X.VERSION, 'periods': per}


X.save_stock({'sym': 'ARS', 'files': {'f%d' % k: qfile(e, r, n, ep, y) for k, (e, r, n, ep, y) in enumerate([
    ('2025-09-30', 227.4, 28.1, 4.46, None), ('2025-12-31', 248.2, 37.0, 5.9, None), ('2026-03-31', 256.0, 42.2, 6.63, 932.4),
    ('2026-06-30', 246.1, 23.0, 3.7, None), ('2026-09-30', 273.3, 42.4, 6.65, None)])}})
t0 = X.build(X.load_stock('ARS'), TODAY)
assert [r[0] for r in t0['q']] == QH[4:] and [r[0] for r in t0['y']] == ['Mar 2026'], 'NSE alone: the 5 quarters since listing'
# + Jun 2025 (VERSION 7): the year Mar 2026 minus its other 3 quarters (no filing of its own - screener.in's way)
j25 = {r[0]: r for r in t0['q']}['Jun 2025']
assert j25[-1] == 'd' and j25[1] == 200.8 and j25[1 + X.COLS.index('np')] == 22.1, j25
X.keep_screener('ARS', sc_page(), 1000.0)
state_ = {}
assert X.refresh_screener(['ARS', 'NOPE'], state_, TODAY) == 1 and X.refresh_screener(['ARS'], state_, TODAY) == 0
t = X.load_stock('ARS')['table']
fl = {r[0]: r[-1] for r in t['q']}
assert [r[0] for r in t['q']] == QH and [fl[q] for q in QH] == ['r'] * 4 + ['d'] + [''] * 5, fl
assert {r[0]: r[1] for r in t['q']}['Sep 2025'] == 227.4, 'NSE\'s own figure where there is one'
fy = {r[0]: r for r in t['y']}
assert list(fy) == ['Mar 2020', 'Mar 2021', 'Mar 2022', 'Mar 2023', 'Mar 2024', 'Mar 2025', 'Mar 2026'], list(fy)
assert fy['Mar 2026'][-1] == '' and fy['Mar 2026'][1] == 932.4 and fy['Mar 2020'][-1] == 'r' and fy['Mar 2020'][1] == 246
assert fy['Mar 2020'][1 + X.COLS.index('eps')] == 1.08 and fy['Mar 2020'][1 + X.COLS.index('taxp')] == 31
assert len(X.eps_quarters(t)[1]) == 6, 'pe_history keeps its own screener.in EPS - only the filings\' quarters (+ worked out) go to it'
# a standalone page read later does not push the consolidated one out; a stock with no filing read yet: screener.in alone
X.keep_screener('ARS', sc_page('Standalone'), 2000.0)
assert sorted(X.load_sc('ARS')) == ['C', 'S']
t2 = X.build({'sym': 'ARS', 'files': {}}, TODAY)
assert t2['b'] == 'C' and t2['files'] == 0 and {r[-1] for r in t2['q'] + t2['y']} == {'r'} and len(t2['y']) == 7
assert X.build({'sym': 'NONE', 'files': {}}, TODAY) is None
X.keep_screener('ARS', '<html>nothing</html>')                # a page without the tables changes nothing
assert sorted(X.load_sc('ARS')) == ['C', 'S']
# years: 12 at most (screener.in's own table has up to 12)
many = {'b': 'C', 'q': [], 'y': [['Mar %d' % y, 100.0 + y] + [None] * 11 + [''] for y in range(2005, 2027)]}
assert [r[0] for r in X.build({'sym': 'ARS', 'files': {}}, TODAY, sc={'C': many})['y']] == ['Mar %d' % y for y in range(2015, 2027)]

# pages Historical PE read before this version: read once more (their tables were not kept), never a stock not on screener.in
P_ = sb.PEH
assert P_.WANT_PAGE is X.wants_screener
saved_store = P_._STORE
P_._STORE = P_.Store(os.path.join(TMP, 'eps_history.json'))
P_._STORE.syms = {s_: {'src': 'page', 'at': time.time(), 'tried': time.time()} for s_ in ('ARS', 'OLD1', 'OLD2')}
P_._STORE.syms['GONE'] = {'src': 'page', 'at': time.time(), 'tried': time.time(), 'none': 1}
P_._STORE.syms['OLD2']['scx'] = 1
assert P_.backfill_order(['ARS', 'OLD1', 'OLD2', 'GONE', 'NEW']) == ['NEW', 'OLD1'], P_.backfill_order(['ARS', 'OLD1', 'OLD2', 'GONE', 'NEW'])
pages_ = []
P_.backfill({}, lambda cfg, sym, cons=True: (pages_.append(sym), ('ok', sc_page()))[1], lambda c: None, RuntimeError, ['OLD1'], pages=5)
assert pages_ == ['OLD1'] and P_._STORE.syms['OLD1'].get('scx') == 1 and X.load_sc('OLD1').get('C')
assert P_.backfill_order(['OLD1']) == [], 'once'
P_._STORE = saved_store

# a year with consolidated and standalone quarters: the sum of its 4 quarters all the same (owner: "take that also")
def bfile(end, basis, rev):
    f = qfile(end, rev, 10.0, 1.0)
    f['basis'] = basis
    return f


mix = {'sym': 'MIX', 'files': {'a': bfile('2023-06-30', 'S', 100.0), 'b': bfile('2023-09-30', 'S', 110.0),
                                 'c': bfile('2023-12-31', 'C', 120.0), 'd': bfile('2024-03-31', 'C', 130.0)}}
tm = X.build(mix, TODAY, sc={})
assert tm['b'] == 'C' and [r[-1] for r in tm['q']] == ['s', 's', '', ''] and tm['y'][0][0] == 'Mar 2024' and tm['y'][0][-1] == 'q' \
    and tm['y'][0][1] == 460.0, tm['y']

# ------------------------------------------------------------------ 12. slower and gentler (owner, 18-Nov-2026, NSE's terms:
# "5-10 seconds between requests"; then "Day ku 100 stocks matum. It can run on market hours or anytime")
from datetime import datetime as _dt
assert X.GAP_S == 6.0 and X.CMD_GAP_S == X.GAP_S and X.DAY_STOCKS == 100
assert X.gap_of({}) == 6.0 and X.gap_of({'xbrl_history_gap_s': 2.5}) == 5.0 and X.gap_of({'xbrl_history_gap_s': 8}) == 8.0
assert X.gap_of({'xbrl_history_gap_s': 'x'}) == 6.0 and X.stocks_per_day({'xbrl_history_stocks_per_day': 50}) == 50
assert sb.DEFAULTS['xbrl_history_gap_s'] == 6 and sb.DEFAULTS['xbrl_history_stocks_per_day'] == 100
assert 'xbrl_history_files_per_day' not in sb.DEFAULTS
assert 'XH.gap_of(cfg)' in open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read(), 'XbrlHistoryNow too'
mon10 = _dt(2026, 11, 16, 10, 0, tzinfo=X.IST).timestamp()
assert not X.market_open(mon10), 'any time by default'
X.MARKET = (9 * 60, 15 * 60 + 45)                 # the rule still works when a window is set
assert X.market_open(mon10) and not X.market_open(mon10 + 6 * 3600)
assert not X.market_open(_dt(2026, 11, 21, 11, 0, tzinfo=X.IST).timestamp()), 'Saturday'
X.MARKET = None
assert X.Worker.rest({'paused': 'market'}) == 1800 and X.Worker.rest({'blocked': 'x'}) == X.BLOCK_PAUSE_S
assert X.Worker.rest({'done': 1}) == X.REST_S and X.Worker.rest(None) == X.BLOCK_PAUSE_S
r_ = X.Worker.rest({'paused': 'cap'}, mon10)
assert abs(r_ - (14 * 3600 + 5 * 60)) < 2, 'the next day just after midnight IST: %s' % r_
for s_ in ('ABC', 'XYZ'):
    if os.path.exists(X._stock_path(s_)):
        os.remove(X._stock_path(s_))                  # due again (their files stay kept)
del LOGS[:]
n_req = len(REQ)
st_ = X.load_state()
st_['day'] = {'d': '2026-11-16', 'stocks': 100, 'files': 3}
X.save_state(st_)
res = X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY, clock=lambda: mon10)
assert res['paused'] == 'cap' and res['done'] == 0 and len(REQ) == n_req, res
assert any("today's 100 stocks are done - the rest tomorrow (2 stock(s) left, about 1 more day(s) at 100 a day)" in x
           for x in LOGS), LOGS
assert any('one request every 0 s, at most 100 stocks a day' in x for x in LOGS)
st_['day'] = {'d': '2026-11-16', 'stocks': 99, 'files': 3}
X.save_state(st_)
res = X.run_all(NOSC, api, gap=0, sleep=nap, today=TODAY, clock=lambda: mon10)
assert res['done'] == 1 and res['paused'] == 'cap' and len(REQ) > n_req, 'one more stock in market hours, then the limit'
assert X.load_state()['day']['stocks'] == 100
st_ = {'day': {'d': '2026-11-16', 'stocks': 100, 'files': 9}}
assert X._day_count(st_, mon10 + 86400) == {'d': '2026-11-17', 'stocks': 0, 'files': 0}, 'a new day starts at 0'
assert X._day_count({'day': {'d': '2026-11-16', 'files': 7}}, mon10)['stocks'] == 0, 'the earlier counter (files only)'
# ------------------------------------------------------------------ 13. VERSION 7 (owner, 23-Nov-2026): the quarters NSE has
# no filing for worked out from the year-to-date figures; consolidated and standalone kept apart (MTARTECH: its subsidiaries
# merged into it - the newest quarter is standalone only; TFCILTD / 3MINDIA: consolidated figures end years ago)
T23 = date(2026, 11, 23)


def vfile(end, basis, quarters, stamp, ytd=None, year=None, prev=None):
    """A kept filing: its quarter (+ the quarter before as a comparison column), a year-to-date period, a year."""
    def f(rev, np_=10.0, eps=1.0):
        return {'revenue': rev, 'expenses': rev * 0.8, 'finance_costs': 1.0, 'depreciation': 1.0, 'other_income': 1.0,
                'pbt': np_ * 1.3, 'tax': np_ * 0.3, 'pat': np_, 'eps': eps}
    e = date.fromisoformat(end)
    per = [{'start': qstart(e, 3).isoformat(), 'end': end, 'm': 3, 'f': f(quarters)}]
    if prev is not None:
        pe_ = qend(e.year - (e.month == 3), 12 if e.month == 3 else e.month - 3)
        per.append({'start': qstart(pe_, 3).isoformat(), 'end': pe_.isoformat(), 'm': 3, 'f': f(prev)})
    if ytd:
        months, rev = ytd
        per.append({'start': qstart(e, months).isoformat(), 'end': end, 'm': months, 'f': f(rev, 10.0 * months / 3, months / 3.0)})
    if year:
        per.append({'start': qstart(e, 12).isoformat(), 'end': end, 'm': 12, 'f': f(year, 40.0, 4.0)})
    return {'url': 'u', 'end': end, 'basis': basis, 'rev': False, 'stamp': stamp, 'v': X.VERSION, 'periods': per}


# a) a quarter with no filing at all (Sep 2025): the 9 months of the Dec filing minus Jun - Sep comes out; Mar = the year minus 9M
drv = {'sym': 'DRV', 'files': {
    'a': vfile('2025-06-30', 'C', 100.0, '20250810180000'),
    'c': vfile('2025-12-31', 'C', 120.0, '20260210180000', ytd=(9, 330.0)),
    'd': vfile('2026-03-31', 'C', 130.0, '20260510180000', year=460.0)}}
td = X.build(drv, T23, sc={})
dq = {r[0]: r for r in td['q']}
assert dq['Sep 2025'][-1] == 'd' and dq['Sep 2025'][1] == 110.0 and dq['Sep 2025'][1 + X.COLS.index('np')] == 10.0, dq['Sep 2025']
assert dq['Jun 2025'][-1] == '' and dq['Dec 2025'][-1] == '' and td['y'][-1][0] == 'Mar 2026' and td['y'][-1][-1] == '', td
d2 = X.build({'sym': 'DRV', 'files': {k: v for k, v in drv['files'].items() if k != 'd'}}, T23, sc={})
assert 'Mar 2026' not in {r[0] for r in d2['q']}, 'nothing to work it out from: left out'
# a bonus between the filings: the 9 months' EPS restated on the new share count, the earlier quarters' not -> no EPS
bon = {'sym': 'BON', 'files': {'a': vfile('2025-06-30', 'C', 100.0, '20250810180000'),
                                'b': vfile('2025-09-30', 'C', 110.0, '20251110180000'),
                                'c': vfile('2025-12-31', 'C', 120.0, '20260210180000')}}
bon['files']['c']['periods'][0]['f']['eps'] = 0.5
bon['files']['c']['periods'].append({'start': '2025-04-01', 'end': '2025-12-31', 'm': 9, 'f': dict(
    bon['files']['c']['periods'][0]['f'], revenue=330.0, pat=30.0, eps=1.5)})
del bon['files']['c']['periods'][0]
tb = {r[0]: r for r in X.build(bon, T23, sc={})['q']}
assert tb['Dec 2025'][-1] == 'd' and tb['Dec 2025'][1] == 120.0 and tb['Dec 2025'][1 + X.COLS.index('eps')] is None, tb['Dec 2025']
neg = X.build({'sym': 'NEG', 'files': {'a': vfile('2025-06-30', 'C', 100.0, '20250810180000'),
                                         'c': vfile('2025-12-31', 'C', 120.0, '20260210180000', ytd=(9, 150.0))}}, T23, sc={})
assert 'Sep 2025' not in {r[0] for r in neg['q']}, 'a worked-out revenue below 0 does not fit - left out'

# b) MTARTECH: consolidated up to Jun 2026, Sep 2026 filed standalone only (17 days ago) -> the standalone table first,
# the consolidated one kept as it was (no standalone figures copied into it), words that it ended - not "missing"
mtr = {'sym': 'MTR', 'files': {
    'c1': vfile('2025-12-31', 'C', 90.0, '20260210180000'), 'c2': vfile('2026-03-31', 'C', 95.0, '20260510180000', year=360.0),
    'c3': vfile('2026-06-30', 'C', 100.0, '20260810180000'),
    's4': vfile('2026-09-30', 'S', 104.0, '20261106180000', prev=97.0, ytd=(6, 201.0))}}
tm7 = X.build(mtr, T23, sc={})
assert tm7['b'] == 'S' and tm7['q'][-1][0] == 'Sep 2026' and tm7['bw'].startswith('Consolidated results end with Jun 2026: the company '
                                                                                 'files only standalone results since Sep 2026'), tm7
sq = {r[0]: r for r in tm7['q']}
assert sq['Jun 2026'][1] == 97.0 and sq['Jun 2026'][-1] == 'c', 'the standalone table: the filing\'s own comparison column'
assert tm7['o']['b'] == 'C' and tm7['o']['q'][-1][0] == 'Jun 2026' and tm7['o']['q'][-1][1] == 100.0, tm7['o']
assert 'Sep 2026' not in {r[0] for r in tm7['o']['q']}, 'no standalone figures in the consolidated table after it ended'
assert all(r[-1] != 's' for r in tm7['o']['q'] + tm7['q']), tm7
# filed yesterday: perhaps the consolidated file just has not come - the consolidated table stays first
mtr['files']['s4']['stamp'] = '20261122180000'
tf7 = X.build(mtr, T23, sc={})
assert tf7['b'] == 'C' and tf7['q'][-1][0] == 'Jun 2026' and tf7['bw'] == ('Sep 2026: only the standalone results are on NSE so '
                                                                           'far - the consolidated ones have not come yet.'), tf7
assert tf7['o']['b'] == 'S' and tf7['o']['q'][-1][0] == 'Sep 2026'

# c) TFCILTD: screener.in's consolidated page ends with Dec 2022, its standalone page goes on to Sep 2026; NSE's files
# could not be read -> the standalone table (screener.in's standalone figures only), the consolidated one apart
def sc_rows_(labels, base, mark=''):
    return [[l, base + k] + [None] * 10 + [1.0, mark] for k, l in enumerate(labels)]


qc = ['Mar 2022', 'Jun 2022', 'Sep 2022', 'Dec 2022']
qs = [X.label_of(m) for m in range(2023 * 12 + 3, 2026 * 12 + 10, 3)]
sc_t = {'C': {'b': 'C', 'k': '', 'q': sc_rows_(qc, 50.0) + sc_rows_(['Mar 2023'], 70.0, 's'), 'y': sc_rows_(['Mar 2022'], 200.0)},
        'S': {'b': 'S', 'k': '', 'q': sc_rows_(qc + qs, 40.0), 'y': sc_rows_(['Mar 2022', 'Mar 2023', 'Mar 2024'], 160.0)}}
tt = X.build({'sym': 'TFC', 'files': {}}, T23, sc=sc_t)
assert tt['b'] == 'S' and tt['q'][-1][0] == 'Sep 2026' and tt['files'] == 0 and {r[-1] for r in tt['q']} == {'r'}, tt
assert tt['bw'].startswith('Consolidated results end with Dec 2022: the company files only standalone results since Mar 2023'), tt
assert {r[0]: r[1] for r in tt['q']}['Dec 2022'] == 43.0, 'standalone figures in the standalone table'
assert tt['o']['b'] == 'C' and [r[0] for r in tt['o']['q']] == qc, 'its "(S)" column after the consolidated ones is not taken'
# a '(S)' column BEFORE the first consolidated period is screener.in's own way: kept
sc_p = {'C': {'b': 'C', 'k': '', 'q': sc_rows_(['Sep 2021'], 30.0, 's') + sc_rows_(qc, 50.0), 'y': []}}
assert [r[0] for r in X.build({'sym': 'PRE', 'files': {}}, T23, sc=sc_p)['q']] == ['Sep 2021'] + qc
# both bases up to the same quarter: consolidated first, standalone to switch to
both = X.build(mtr, T23, sc={'S': {'b': 'S', 'k': '', 'q': sc_rows_(['Jun 2026'], 9.0), 'y': []},
                             'C': {'b': 'C', 'k': '', 'q': sc_rows_(['Sep 2026'], 9.0), 'y': []}})
assert both['b'] == 'C' and 'bw' not in both and both['o']['b'] == 'S', both
assert 'o' not in tm, 'standalone only before the first consolidated period: no second table'

# d) screener.in's pages read by this job: the consolidated page behind -> the standalone page too; kept, the table made
assert X.due_quarter(T23) == 2026 * 12 + 6 and X.due_quarter(date(2026, 11, 30)) == 2026 * 12 + 9
FETCH = []


def sc_fetch(cfg, sym, cons=True):
    FETCH.append((sym, cons))
    if sym == 'GONE':
        return '404', None
    if cons:
        return 'ok', sc_page('Consolidated').replace('Sep 2026', 'Sep 2026').replace('Jun 2026', 'Jun 2026')
    return 'ok', sc_page('Standalone')


QH_OLD = ['Mar 2022', 'Jun 2022', 'Sep 2022', 'Dec 2022', 'Mar 2023', 'Jun 2023', 'Sep 2023', 'Dec 2023', 'Mar 2024', 'Jun 2024']


def sc_page_old():
    return sc_page('Consolidated').replace('<th>%s</th>' % QH[0], '<th>__0</th>')


X.bind(screener=sc_fetch)
assert X.fetch_screener({}, 'NRM', T23) == 1 and FETCH == [('NRM', True)], 'up to date: the consolidated page alone'
del FETCH[:]
old_qh = list(QH)
QH[:] = QH_OLD
try:
    assert X.fetch_screener({}, 'BEH', T23) == 2 and FETCH == [('BEH', True), ('BEH', False)], FETCH
finally:
    QH[:] = old_qh
assert sorted(X.load_sc('BEH')) == ['C', 'S']
del FETCH[:]
assert X.fetch_screener({}, 'GONE', T23) == 2 and FETCH == [('GONE', True), ('GONE', False)]
now_ = time.time()
assert X.screener_wants('NEWSTOCK', {}, T23, now_) and not X.screener_wants('NRM', {}, T23, now_)
assert not X.screener_wants('BEH', {}, T23, now_, {'BEH': now_ - 3600}), 'not again within 2 days'
# the whole job: a stock NSE has nothing for gets screener.in's tables; none while a round runs
CALLS2 = []


def api2(cfg, action, payload=None, tries=3, timeout=120):
    CALLS2.append(payload)
    if payload['op'] == 'syms':
        return {'ok': True, 'syms': ['SCO']}
    return {'ok': True, 'stored': len(payload['items'])}


X.save_state({})
del FETCH[:]
r13 = X.run_all({'url': 'x'}, api2, gap=0, sleep=nap, today=T23, screener_busy=lambda: True)
assert r13['pages'] == 0 and FETCH == [], 'no screener.in page while the round runs'
X.save_state({})
r13 = X.run_all({'url': 'x'}, api2, gap=0, sleep=nap, today=T23)
assert r13['pages'] == 1 and FETCH == [('SCO', True)] and X.load_stock('SCO')['table']['files'] == 0, r13
assert [p_['items'][0]['sym'] for p_ in CALLS2 if p_['op'] == 'put'] == ['SCO'], CALLS2
assert X.load_state()['scTry'].get('SCO'), 'remembered'
del FETCH[:]
assert X.run_all({'url': 'x'}, api2, gap=0, sleep=nap, today=T23)['pages'] == 0 and FETCH == [], 'not again'
# a stock read from NSE in the same run whose new filing (Sep 2026) is newer than its kept page: both pages read now
QH[:] = QH_OLD[:-1] + ['Jun 2026']
X.keep_screener('MTN', sc_page('Consolidated'), time.time())            # a page of today, ending Jun 2026
QH[:] = old_qh
X.save_stock({'sym': 'MTN', 'files': {'s4': vfile('2026-09-30', 'S', 104.0, '20261106180000')}, 'listed': time.time()})
assert not X.screener_wants('MTN', {}, T23, time.time()), 'before the NSE read: the page is up to date'
real_ps, real_due = X.process_stock, X.due
X.process_stock = lambda nse, sym, today=None, say=None: (dict(X.load_stock(sym), table=X.build(X.load_stock(sym), today)), 0)
X.due = lambda sym, st, today, now: sym == 'MTN'
try:
    CALLS2[:] = []
    del FETCH[:]
    X.save_state({})
    api_mtn = lambda cfg, action, payload=None, tries=3, timeout=120: (
        {'ok': True, 'syms': ['MTN']} if payload['op'] == 'syms' else {'ok': True, 'stored': len(payload['items'])})
    QH[:] = QH_OLD[:-1] + ['Jun 2026']                                  # screener.in still shows Jun 2026
    r13 = X.run_all({'url': 'x'}, api_mtn, gap=0, sleep=nap, today=T23)
finally:
    X.process_stock, X.due = real_ps, real_due
    QH[:] = old_qh
assert r13['done'] == 1 and FETCH == [('MTN', True), ('MTN', False)], (r13, FETCH)
X.bind(screener=lambda cfg, sym, cons=True: ('ok', screener_page([('Jun 2026', 122, 18.75, 1.88, 20), ('Sep 2026', 130, 18.75, 1.88, 19)])))

# e) the round's NSE steps only: nse_busy.json while they run
sb.NSE_BUSY_PATH = os.path.join(TMP, 'nse_busy.json')
assert sb.nse_busy() is False
with sb.nse_part('round: NSE files'):
    assert sb.nse_busy() is True
assert sb.nse_busy() is False and not os.path.exists(sb.NSE_BUSY_PATH)
with open(sb.NSE_BUSY_PATH, 'w') as f:
    json.dump({'pid': os.getpid(), 'at': time.time() - 3600}, f)
assert sb.nse_busy() is False, 'an old mark (a program that died in the middle)'
os.remove(sb.NSE_BUSY_PATH)
src = open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read()
assert "with nse_part('round: NSE files'):" in src and "with nse_part('results check: XBRL filings'):" in src
assert "XH.run_all(dict(cfg, xbrl_history=True), api, nse_busy," in src and 'screener_busy=round_running)' in src

# f) a file Windows holds a moment (owner's QUESS, WinError 32): put in place once it lets go
real = os.replace
tries = []


def flaky(a, b):
    tries.append(a)
    if len(tries) < 3:
        raise PermissionError(32, 'The process cannot access the file because it is being used by another process')
    return real(a, b)


X.ltf_data.REPLACE_WAITS, saved_w = (0, 0, 0), X.ltf_data.REPLACE_WAITS
os.replace = flaky
try:
    X._put_file(os.path.join(TMP, 'held', 'a.xml'), b'<x/>')
finally:
    os.replace = real
    X.ltf_data.REPLACE_WAITS = saved_w
assert len(tries) == 3 and tries[0].endswith('.%d.tmp' % os.getpid()), tries
assert open(os.path.join(TMP, 'held', 'a.xml'), 'rb').read() == b'<x/>' and os.listdir(os.path.join(TMP, 'held')) == ['a.xml']
print('OK')
