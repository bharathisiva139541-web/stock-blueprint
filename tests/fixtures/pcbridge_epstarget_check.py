# -*- coding: utf-8 -*-
"""Offline checks of the EPS Growth Target Lab (pcbridge/ScreenerBridge/eps_target.py; owner, 23-Nov-2026: LAURUSLABS -
TTM EPS x EPS growth % = his target, reached after the Q1 results). Prints OK at the end."""
import importlib.util
import json
import os
import random
import sys
import tempfile
import time
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
L.LAB_DIR = os.path.join(TMP, 'lab_cache')
spec = importlib.util.spec_from_file_location('eps_target', os.path.join(HERE, 'eps_target.py'))
E = importlib.util.module_from_spec(spec)
spec.loader.exec_module(E)
E.STATE_PATH = os.path.join(TMP, 'eps_target_state.json')
E.ANN_PATH = os.path.join(TMP, 'eps_target_ann.json')
LOGS = []
E.log = LOGS.append
spec = importlib.util.spec_from_file_location('xbrl_history', os.path.join(HERE, 'xbrl_history.py'))
X = importlib.util.module_from_spec(spec)
spec.loader.exec_module(X)
X.DIR = os.path.join(TMP, 'xbrl_data')
TODAY = date(2026, 11, 23)


def near(a, b, tol=0.01):
    return a is not None and abs(a - b) <= tol


# ------------------------------------------------------------------ 1. quarters
q = E.quarter_ends(TODAY, 8)
assert [E.label_of(m) for m in q] == ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025', 'Sep 2025', 'Jun 2025', 'Mar 2025',
                                      'Dec 2024'], q
assert E.label_of(E.quarter_ends(date(2026, 9, 30), 1)[0]) == 'Jun 2026', 'a quarter is over only after its last day'
assert E.label_of(E.quarter_ends(date(2026, 10, 1), 1)[0]) == 'Sep 2026'
assert [E.fy_words(E.mi_label(x)) for x in ('Jun 2026', 'Sep 2026', 'Dec 2025', 'Mar 2026')] == ['Q1 FY27', 'Q2 FY27', 'Q3 FY26',
                                                                                                   'Q4 FY26']
assert E.end_of(E.mi_label('Jun 2026')) == date(2026, 6, 30) and E.end_of(E.mi_label('Dec 2025')) == date(2025, 12, 31)

# ------------------------------------------------------------------ 2. the formula (the owner's LAURUSLABS numbers)
LAURUS = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026']
EPS = [0.37, 1.71, 4.34, 3.02, 3.61, 4.67, 5.17, 6.81]
eps = {E.mi_label(l): v for l, v in zip(LAURUS, EPS)}
t = E.target_of(eps, E.mi_label('Jun 2026'))
assert t['eps'] == EPS and t['ttm'] == 20.26 and t['prev'] == 9.44, t
assert near(t['g'], 114.62) and near(t['tgt'], 2322.17, 0.02) and t['why'] == '', t
eps2 = dict(eps)
eps2[E.mi_label('Mar 2026')] = 5.71            # the owner's own reading: TTM 20.80 -> growth 120.3 % -> 2,503 (his 2,502)
t2 = E.target_of(eps2, E.mi_label('Jun 2026'))
assert t2['ttm'] == 20.8 and near(t2['g'], 120.34) and abs(t2['tgt'] - 2503.0) < 1, t2
assert E.target_of(eps, E.mi_label('Sep 2026')) is None, 'Sep 2026 not known yet'
mk = lambda vals: {E.mi_label(l): v for l, v in zip(LAURUS, vals)}
assert E.target_of(mk([1, 1, 1, 1, -2, -1, 0.5, 0.4]), E.mi_label('Jun 2026'))['why'] == 'loss'
assert E.target_of(mk([-1, -1, 0.5, 0.2, 1, 1, 1, 1]), E.mi_label('Jun 2026'))['why'] == 'prevloss'
r = E.target_of(mk([2, 2, 2, 2, 1, 1, 1, 1]), E.mi_label('Jun 2026'))
assert r['why'] == 'fell' and r['g'] == -50 and r['tgt'] is None
assert E.target_of(mk([1, 1, 1, 1, 1, 1, 1, 1]), E.mi_label('Jun 2026'))['why'] == 'fell', 'no growth = no target'

# ------------------------------------------------------------------ 3. the entry session
ords = [date(2026, 7, d).toordinal() for d in (22, 23, 24, 27, 28)]       # Wed .. Fri, Mon, Tue
assert E.entry_index(ords, '2026-07-24 16:05:00') == 3, 'after the close -> the next session (Monday)'
assert E.entry_index(ords, '2026-07-24 15:30:00') == 3, '15:30 = after the close'
assert E.entry_index(ords, '2026-07-24 13:15:00') == 2, 'market hours -> the same day'
assert E.entry_index(ords, '2026-07-24 08:30:00') == 2, 'before the open -> the same day'
assert E.entry_index(ords, '2026-07-25 11:00:00') == 3, 'a Saturday -> Monday'
assert E.entry_index(ords, '2026-07-28 17:00:00') is None, 'no session after it yet'


# ------------------------------------------------------------------ 4. the prices after the entry
class CS:
    def __init__(self, days, o, h, lo, c):
        import array
        self.day = days
        self.o, self.h, self.l, self.c = (array.array('f', x) for x in (o, h, lo, c))


def sessions(start, n):
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.toordinal())
        d += timedelta(days=1)
    return out


days = sessions(date(2026, 7, 20), 100)          # 20-Jul .. ; entry 27-Jul = index 5
k0 = days.index(date(2026, 7, 27).toordinal())
c = [1600.0] * k0 + [1624.1] + [1624.1 + (2322.15 - 1624.1) * k / 75 for k in range(1, 100 - k0)]
h = [x + 0.0 for x in c]
lo = [x - 10 for x in c]
lo[k0 + 10] = 1500.0
cs = CS(days, c, h, lo, c)
NIFTY = {'d': days, 'c': [25000.0 + k * 10 for k in range(len(days))]}
a = E.after(cs, k0, 2322.15, NIFTY)
assert a['ed'] == '2026-07-27' and a['ep'] == 1624.1 and a['pre'] == 1600.0 and a['o0'] == 1624.1, a
assert a['n'] == 100 - 1 - k0 == 94
# the owner's rule (24-Nov-2026): reached = 80 % of the way from the entry to the target (entry 100, target 200 -> 180); then
# 50 / 60 / 70 % too ("give more option like 80% of the way, 70% of the way, 60% of the way, 50% of the way")
assert E.THRESH == (50, 60, 70, 80, 90, 100) and E.MAIN_T == 3
assert a['kp'] == [38, 45, 53, 60, 68, 75], a['kp']
assert a['kd'] == [date.fromordinal(days[k0 + k]).isoformat() for k in (38, 45, 53, 60, 68, 75)], a['kd']
assert all(len(a[k]) == 5 for k in ('pg', 'hh', 'dd', 'cl', 'ix'))
assert near(a['pg'][0], 40.0, 0.11) and near(a['pg'][1], 80.0, 0.11) and near(a['pg'][2], 120.0, 0.11), a['pg']
assert near(a['hh'][0], ((1624.1 + 698.05 * 30 / 75) / 1624.1 - 1) * 100, 0.06), a['hh']
assert a['cl'][2] is not None and a['cl'][3] is None, '94 sessions: the 90-session window is over, 120 not'
assert a['dd'][0] == round((1500 / 1624.1 - 1) * 100, 1), a['dd']
assert near(a['cl'][0], (c[k0 + 30] / 1624.1 - 1) * 100, 0.06) and near(a['ix'][0], (NIFTY['c'][k0 + 30] / NIFTY['c'][k0] - 1) * 100, 0.06)
assert a['cl'][3] is None and a['ix'][3] is None and a['pg'][4] is not None and a['hh'][4] is not None, 'longer windows: so far only'
assert len(a['ph']) == len(a['pc']) == 19 and near(a['pc'][-1], a['now'], 0.06), (len(a['ph']), a['pc'][-1], a['now'])
a90 = E.after(cs, k0, 99999.0, NIFTY)
assert a90['kp'] == [None] * 6 and a90['cl'][2] is not None and a90['cl'][3] is None and a90['pg'][2] < 5
a0 = E.after(cs, len(days) - 1, 2322.15, NIFTY)
assert a0['n'] == 0 and a0['pg'] == [None] * 5 and a0['now'] is None and a0['ph'] == [] and a0['kp'] == [None] * 6
assert a0['wq'] == [None] * 5
# float32: a high of exactly the target counts
c2 = [100.0] * 5 + [2322.15] * 3
cs2 = CS(sessions(date(2026, 1, 5), 8), c2, c2, c2, c2)
assert E.after(cs2, 4, 2322.15)['kp'] == [1] * 6
# a DOWNSIDE target (under the entry - owner: "the market price should hit this downside target"): by the LOWS, 3 a session
dd_days = sessions(date(2026, 7, 20), 70)
lo3 = [1624.1] * 6 + [1624.1 - 3 * k for k in range(1, 65)]
c3 = [x + 1 for x in lo3]
c3[5] = 1624.1
cs3 = CS(dd_days, c3, [x + 1 for x in c3], lo3, c3)
a3 = E.after(cs3, 5, 1500.0)
assert a3['kp'] == [21, 25, 29, 34, 38, 42], a3['kp']   # 80 % of 124.10 = 99.28 -> 3 x 34; 90 % = 111.69 -> 38; 100 % -> 42
assert near(a3['pg'][0], 90 / 124.1 * 100, 0.06) and a3['hh'][0] <= 0.1, (a3['pg'], a3['hh'])
# the window up to the next results (owner, 24-Nov-2026: "reached within next quarterly result date"): nq sessions
aq = E.after(cs, k0, 2322.15, NIFTY, 40)
assert near(aq['wq'][0], 40 / 75 * 100, 0.11) and aq['wq'][3] == round((c[k0 + 40] / 1624.1 - 1) * 100, 1), aq['wq']
assert aq['wq'][4] == round((NIFTY['c'][k0 + 40] / NIFTY['c'][k0] - 1) * 100, 1) and aq['wq'][2] == a['dd'][0], aq['wq']
assert aq['kp'] == a['kp'] and aq['pg'] == a['pg'], 'the other windows unchanged'
assert a['wq'][:3] == [a['pg'][4], a['hh'][4], a['dd'][4]] and a['wq'][3] is None and a['wq'][4] is None, \
    'next results not out yet: so far only'
assert E.after(cs, k0, 2322.15, NIFTY, 0)['wq'] == [None] * 5, 'the next results came with these: no session in between'
far = CS(sessions(date(2026, 1, 5), 260), [100.0] * 260, [100.0 + k for k in range(260)], [99.0] * 260, [100.0] * 260)
af = E.after(far, 0, 400.0, None, 230)
assert af['kp'] == [150, 180, 210, None, None, None] and af['wq'][0] == round(230 / 300 * 100, 1) and len(af['ph']) == 40, \
    ('a next-results window over 180 sessions: read to its end', af['kp'], af['wq'], len(af['ph']))
# next_window: when the next quarter's results came -> the sessions before the first one that could react to them
nd = sessions(date(2026, 7, 20), 90)          # .. 20-Nov-2026
JUN = E.mi_label('Jun 2026')
k7 = nd.index(date(2026, 7, 27).toordinal())
ix_ = lambda y, m, d_: nd.index(date(y, m, d_).toordinal())
assert E.next_window(JUN, ['2026-07-24 16:05:00', '2026-10-29 16:30:00'], {}, nd, k7) == \
    (ix_(2026, 10, 29) - k7, 0, '2026-10-29 16:30'), 'after the close: the 29th is still before them'
assert E.next_window(JUN, ['2026-10-29 10:00:00'], {}, nd, k7) == (ix_(2026, 10, 28) - k7, 0, '2026-10-29 10:00'), \
    'during the market: the 29th reacts to them'
assert E.next_window(JUN, [], {'2026-09-30': '20261030211117'}, nd, k7) == (ix_(2026, 10, 30) - k7, 0, '2026-10-30 21:11'), 'XBRL time'
assert E.next_window(JUN, [], {}, nd, k7) == (None, 0, ''), '20-Nov is not past 14-Nov + 15 days yet: still running'
nd2 = sessions(date(2026, 7, 20), 140)
assert E.next_window(JUN, [], {}, nd2, k7) == (nd2.index(date(2026, 11, 13).toordinal()) - k7, 1, ''), \
    'no date found, well past SEBI\'s 45 days: the window ends on 14-Nov (the Friday before)'
DEC = E.mi_label('Dec 2025')
md = sessions(date(2026, 4, 1), 60)           # .. 23-Jun-2026
assert E.next_window(DEC, [], {}, md, 2) == (md.index(date(2026, 5, 29).toordinal()) - 2, 1, ''), \
    'the March quarter (the year\'s results) gets 60 days: 30-May'
assert E.next_window(DEC, [], {}, md[:50], 2) == (None, 0, ''), '9-Jun: 30-May + 15 days not passed yet'
last_open = nd[-1]
assert E.next_window(JUN, ['%s 17:00:00' % date.fromordinal(last_open).isoformat()], {}, nd, k7)[0] == len(nd) - 1 - k7, \
    'filed after the last candle: every session so far is before them'

# ------------------------------------------------------------------ 5. when the results came out
JUN = E.mi_label('Jun 2026')
fil = ['2026-05-20 16:00:00', '2026-07-03 17:00:00', '2026-07-24 16:05:00', '2026-07-25 10:00:00', '2026-10-20 15:00:00']
assert E.announced(JUN, fil, {}) == ('2026-07-03 17:00:00', 'nse'), 'no XBRL file: the season\'s first result filing'
assert E.announced(JUN, fil, {'2026-06-30': '20260724180800'}) == ('2026-07-24 16:05:00', 'nse'), \
    'the filing just before the XBRL file (an earlier one was something else)'
assert E.announced(JUN, ['2026-07-03 17:00:00'], {'2026-06-30': '20260724180800'}) == ('2026-07-24 18:08:00', 'xbrl')
assert E.announced(JUN, [], {'2026-06-30': '20261201100000'}) == (None, ''), 'a file 5 months later = a revision'
assert E.announced(JUN, [], {}) == (None, '')
assert E.stamp_dt('20260724180800') == '2026-07-24 18:08:00' and E.stamp_dt('2026') is None

# ------------------------------------------------------------------ 6. which days of NSE's announcements are read
todo = E.ann_todo(q, TODAY, [], 3)
assert todo == [(date(2026, 7, 1), date(2026, 7, 4)), (date(2026, 7, 5), date(2026, 7, 8)), (date(2026, 7, 9), date(2026, 7, 12))], \
    'the finished season first (the owner\'s Q1)'
have = [(date(2026, 7, 1) + timedelta(days=k)).isoformat() for k in range(75)]
todo = E.ann_todo(q, TODAY, have + ['2026-10-03'], 2)
assert todo == [(date(2026, 10, 1), date(2026, 10, 2)), (date(2026, 10, 4), date(2026, 10, 7))], todo
allq = E.ann_todo(q, TODAY, [], 9999)
last = [b for a, b in allq if a.year == 2026 and a.month >= 10]
assert max(last) == date(2026, 11, 22), 'the season going on: up to yesterday'
assert sum((b - a).days + 1 for a, b in allq) == 75 * 7 + (date(2026, 11, 22) - date(2026, 10, 1)).days + 1

FETCH = []


def fake_fetch(opener, a, b):
    FETCH.append((a, b))
    if a == date(2026, 7, 9):
        return None, 'HTTP 403 from NSE'
    recs = [{'symbol': 'LAURUSLABS', 'an_dt': '24-Jul-2026 16:05:10', 'desc': 'Financial Results'}] if a <= date(2026, 7, 24) <= b else []
    return recs + [{'symbol': 'ABC', 'an_dt': '%s 18:00:00' % a.strftime('%d-%b-%Y'), 'desc': 'Outcome of Board Meeting',
                    'attchmntText': 'approved the financial results'}], None


def fake_rows(recs):
    return [[r['symbol'], _iso(r['an_dt'][:11]) + ' ' + r['an_dt'][12:], r['desc']] for r in recs], len(recs)


def _iso(t):
    from datetime import datetime
    return datetime.strptime(t, '%d-%b-%Y').date().isoformat()


E.bind(session=lambda: 'opener', fetch=fake_fetch, rows=fake_rows)
SLEEPS = []
done, left, why = E.ann_backfill(TODAY, q, 3, 5.0, LOGS.append, SLEEPS.append)
assert done == 2 and why == 'HTTP 403 from NSE' and SLEEPS == [5.0, 5.0], (done, why, SLEEPS)
arch = E._ann_load()
assert arch['rows']['ABC'] == ['2026-07-01 18:00:00', '2026-07-05 18:00:00'] and '2026-07-08' in arch['days'] and '2026-07-09' not in arch['days']
FETCH.clear()
E.bind(fetch=lambda o, a, b: (FETCH.append((a, b)) or fake_fetch(o, a, b)) if a != date(2026, 7, 9) else
       ([{'symbol': 'LAURUSLABS', 'an_dt': '24-Jul-2026 16:05:10', 'desc': 'Financial Results'}], None))
done, left, why = E.ann_backfill(TODAY, q, 9999, 0, LOGS.append, lambda s: None)
assert left == 0 and why == '' and E._ann_load()['rows']['LAURUSLABS'] == ['2026-07-24 16:05:10'], E._ann_load()['rows'].get('LAURUSLABS')
assert E.ann_backfill(TODAY, q, 3)[0:2] == (0, 0), 'nothing left'
# the round's own announcement step: today's day is not marked read
d0 = E.remember([['XYZ', '2026-11-23 10:00:00', 'Financial Results']], date(2026, 11, 20), TODAY, TODAY)
assert '2026-11-22' in d0['days'] and '2026-11-23' not in d0['days'] and d0['rows']['XYZ'] == ['2026-11-23 10:00:00']

# ------------------------------------------------------------------ 7. the XBRL files' times (xbrl_history.eps_inputs)
os.makedirs(os.path.join(X.DIR, 'stocks'))
ROW = lambda l, e, f='': [l, 100, 80, 20, 20, 5, None, 2, 3, 20, 25, 15, e, f]
TABLE = {'b': 'C', 'q': [ROW(l, v, 'r' if l == 'Sep 2024' else '') for l, v in zip(LAURUS, EPS)], 'y': [], 'files': 6, 'at': '2026-11-20'}
X._write_json(os.path.join(X.DIR, 'stocks', 'LAURUSLABS.json'), {
    'sym': 'LAURUSLABS', 'table': TABLE,
    'files': {'INTEGRATED_FILING_INDAS_1_24072026180800_X.xml': {'end': '2026-06-30', 'stamp': '20260724180800'},
              'INTEGRATED_FILING_INDAS_2_25072026090000_X.xml': {'end': '2026-06-30', 'stamp': '20260725090000'},
              'GOVERNANCE_3_01072026100000_X.xml': {'end': '2026-06-30', 'stamp': '20260701100000'}},
    'newest': [['2026-09-30', 'C', 'F', '20261028', 'INTEGRATED_FILING_INDAS_9_28102026171500_X.xml'],
               ['2026-09-30', '?', 'G', '20261001', 'GOVERNANCE_9_01102026100000_X.xml']]})
inp = X.eps_inputs()
assert inp['LAURUSLABS'][1] == {'2026-06-30': '20260724180800', '2026-09-30': '20261028171500'}, inp['LAURUSLABS'][1]
eps_t, flags, basis = E.eps_of_table(TABLE)
assert eps_t == eps and basis == 'C' and flags[E.mi_label('Sep 2024')] == 'r'


# ------------------------------------------------------------------ 8. every stock: a made candle cache
def candles(days, closes, highs=None):
    return [{'t': date.fromordinal(d).isoformat(), 'day': date.fromordinal(d).isoformat(), 'o': cl, 'h': (highs or closes)[k],
             'l': cl * 0.98, 'c': cl, 'v': 1} for k, (d, cl) in enumerate(zip(days, closes))]


ALL = sessions(date(2024, 1, 1), 0)
d = date(2024, 1, 1)
while d <= date(2026, 11, 20):
    if d.weekday() < 5:
        ALL.append(d.toordinal())
    d += timedelta(days=1)
ik = ALL.index(date(2026, 7, 27).toordinal())
lau = [1500.0] * ik + [1624.1 + (2400 - 1624.1) * k / (len(ALL) - 1 - ik) for k in range(len(ALL) - ik)]
lau_h = list(lau)
lau_h[ik + 75] = 2488.0
w = L.CacheWriter(TODAY - timedelta(days=3))
w.add('LAURUSLABS', 'D', candles(ALL, lau, lau_h), [])
w.add('FLAT', 'D', candles(ALL, [100.0] * len(ALL)), [])
w.add('NOEPS', 'D', candles(ALL, [50.0] * len(ALL)), [])
w.indices = {'NIFTY_50': [[x, 25000.0 + k] for k, x in enumerate(ALL)]}
w.close()
E._ann_save({'v': 1, 'days': [], 'rows': {'LAURUSLABS': ['2026-07-24 16:05:10'], 'FLAT': ['2026-07-30 12:00:00']}})
SCREENER = {'FLAT': ('S', mk([1, 1, 1, 1, 1, 1, 1, 2]))}       # TTM 5 vs 4 = 25 % -> target 125 (a screener.in record)
upto, per_q, counts = E.compute(L, inp, SCREENER, TODAY, 8)
assert upto == (TODAY - timedelta(days=3)).isoformat() and counts['stocks'] == 2 and counts['noEps'] == 1, (upto, counts)
rows = {r['sym']: r for r in per_q[JUN]}
r = rows['LAURUSLABS']
assert r['st'] == 'ok' and r['ann'] == '2026-07-24 16:05' and r['src'] == 'nse' and r['ed'] == '2026-07-27' and r['ep'] == 1624.1, r
def first_k(highs, ep, tgt, T):
    for k in range(1, len(highs) - ik):
        if round(highs[ik + k], 2) >= ep + T / 100.0 * (tgt - ep) - 1e-6:
            return k
    return None


assert r['fl'] == 'r-------' and r['b'] == 'C' and near(r['tgt'], 2322.17, 0.02) and r['kp'][5] == 75, r['kp']
assert r['kp'] == [first_k(lau_h, r['ep'], r['tgt'], T) for T in E.THRESH] and r['kp'][3] < 75, r['kp']
assert r['kd'][5] == date.fromordinal(ALL[ik + 75]).isoformat()
# the next results (Sep 2026) = the XBRL file in NSE's lists, 28-Oct 17:15 -> the sessions up to 28-Oct are before them
assert r['nx'] == '2026-10-28 17:15' and r['nqa'] == 0 and r['nq'] == ALL.index(date(2026, 10, 29).toordinal()) - 1 - ik, r['nq']
assert r['ix'][0] == round(((25000.0 + ik + 30) / (25000.0 + ik) - 1) * 100, 1) and r['ix'][4] is None, r['ix']
f = rows['FLAT']
assert f['src'] == 'nse' and f['b'] == 'S' and f['fl'] == 'pppppppp' and f['tgt'] == 125.0 and f['ep'] == 100.0 and f['kp'] == [None] * 6
assert f['ed'] == '2026-07-30', 'filed at 12:00 = the same day'
assert f['nq'] is None and f['nx'] == '' and f['wq'][3] is None, 'FLAT: no next results yet (14-Nov + 15 days not passed)'
assert per_q[E.mi_label('Sep 2026')] == [], 'Sep 2026: no 8th quarter yet'
s = E.summary(per_q[JUN])
nL = r['n']
assert s['target'] == 2 and s['down'] == 0 and s['win']['30'][:2] == [2, 0] and s['ready'] is True, s
assert s['win']['180'][1] == 2 - s['win']['180'][0] and s['ann'] == {'nse': 2}
# win[W] = [finished, still running, reached 50 .. 100 % among the finished, reached 50 .. 100 % among the ones running]:
# LAURUSLABS has ~83 sessions - finished at 30 / 60, still running at 90 (reached early)
by_k = lambda W: [int(k is not None and k <= W) for k in r['kp']]
assert s['win']['60'] == [2, 0] + by_k(60) + [0] * 6, (s['win']['60'], r['kp'])
assert nL < 90 and s['win']['90'] == [0, 2] + [0] * 6 + by_k(90), s['win']
# 'next': LAURUSLABS finished (its next results came), FLAT still running
assert s['win']['next'] == [1, 1] + by_k(r['nq']) + [0] * 6, (s['win']['next'], r['nq'], r['kp'])
assert len(s['dwin']['30']) == 14 and s['dwin']['30'][0] == 0 and len(s['dwin']['next']) == 14
assert E.unpack(E.pack(per_q[JUN])) == per_q[JUN], 'the packed rows come back the same'
words = E.stock_words(per_q, 'LAURUSLABS')
assert any('Jun 2026 (Q1 FY27): EPS Sep 2025 3.61, Dec 2025 4.67, Mar 2026 5.17, Jun 2026 6.81 = TTM 20.26' in x and 'target 2322.1' in x
           and 'entry 2026-07-27 close 1624.10' in x and '100% of the way up after 75 session(s)' in x and
           'next results 2026-10-28 17:15: %d session(s) after the entry before them - 80%% of the way %s' % (
               r['nq'], 'reached before them' if r['kp'][3] <= r['nq'] else 'not reached before them') in x for x in words), words
qw = E.quarter_words(per_q, 'Jun 2026')
assert qw.startswith('Jun 2026 (Q1 FY27): 2 target(s) above the entry price, 0 under it - 80% of the way reached within 30 sessions') \
    and 'before the next results: %d of 1 finished' % by_k(r['nq'])[3] in qw, qw
# no XBRL table, no screener record: no rows; a results date older than the candles' end, no filing -> 'date'
E._ann_save({'v': 1, 'days': [], 'rows': {}})
_u, pq2, _c = E.compute(L, {'LAURUSLABS': (TABLE, {})}, {}, TODAY, 8)
assert pq2[JUN][0]['why'] == 'date' and pq2[JUN][0]['st'] == 'x' and pq2[JUN][0]['tgt'] is not None

# ------------------------------------------------------------------ 8b. results dates from NSE's per-stock XBRL lists
# (owner, 24-Nov-2026: SYRMA's results are on NSE's integrated filing page - 30-Oct-2026 21:10 / 29-Jul-2026 17:35 - but had
# no results date; RAJAPALAYAM has no filing on NSE at all)
def rec(sym, end, basis, stamp, gov=False):
    kind = 'GOVERNANCE' if gov else 'INTEGRATED_FILING_INDAS'
    return {'symbol': sym, 'qe_Date': end, 'consolidated': basis,
            'xbrl': 'https://nsearchives.nseindia.com/corporate/xbrl/%s_%s_%s_WEB.xml' % (kind, random.randint(1, 99999), stamp)}


LISTS_ANS = {
    'SYRMA': [rec('SYRMA', '30-SEP-2026', 'Consolidated', '30102026211117'), rec('SYRMA', '30-SEP-2026', 'Standalone', '30102026211026'),
              rec('SYRMA', '30-JUN-2026', 'Consolidated', '29072026173518'), rec('SYRMA', '30-JUN-2026', 'Standalone', '29072026173516'),
              rec('SYRMA', '30-JUN-2026', '', '01072026100000', gov=True)],
    'RAJAPALAYAM': [],
    # a full page of the newest 20 (5 quarters x 2 bases x 2): the missing Jun 2025 asked again by date
    'FULL': [rec('FULL', e, bs, day + '14%04d' % (k * 10 + j)) for k, (e, day) in enumerate((
        ('30-SEP-2026', '01112026'), ('30-JUN-2026', '01082026'), ('31-MAR-2026', '20052026'), ('31-DEC-2025', '01022026'),
        ('30-SEP-2025', '01112025'))) for j, bs in enumerate(('Consolidated', 'Standalone', 'Consolidated', 'Standalone'))],
}
URLS = []


def fake_get(opener, url, referer=None, timeout=30):
    URLS.append(url)
    sym = url.split('symbol=')[1].split('&')[0]
    if 'from_date' in url:
        return 200, json.dumps({'data': [rec(sym, '31-DEC-2024', 'Consolidated', '04022025160000')]}).encode()
    if 'integrated' in url:
        return 200, json.dumps({'data': LISTS_ANS.get(sym, [])}).encode()
    return 200, json.dumps({'data': []}).encode()


X.bind(session=lambda: 'opener', get=fake_get, records=lambda obj: obj.get('data') if isinstance(obj, dict) else obj)
E.bind(xh=X)
E.XB_PATH = os.path.join(TMP, 'eps_target_xbrl.json')
E._ann_save({'v': 1, 'days': [], 'rows': {}})
Q8 = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']
TAB2 = {'b': 'C', 'q': [ROW(l, 1.0 + k) for k, l in enumerate(Q8)], 'y': []}
TAB_OLD = {'b': 'C', 'q': [ROW(l, 1.0 + k) for k, l in enumerate(['Sep 2023', 'Dec 2023', 'Mar 2024', 'Jun 2024'] + Q8)], 'y': []}
INP = {'SYRMA': (TAB2, {}), 'RAJAPALAYAM': (TAB2, {}), 'FULL': (TAB_OLD, {}), 'DONE': (TAB2, {'2026-06-30': '20260801100000',
                                                                                                   '2026-09-30': '20261101100000'})}
todo = E.missing_dates(INP, {}, q)
assert [t[0] for t in todo] == ['FULL', 'RAJAPALAYAM', 'SYRMA'], todo           # DONE has its dates from its XBRL files
assert todo[2][1] == [E.mi_label('Sep 2026'), E.mi_label('Jun 2026')], todo
SL = []
asked, found, left, why = E.xbrl_dates(TODAY, todo, 99, 6.0, LOGS.append, SL.append)
assert asked == 3 and left == 0 and why == '' and all(x == 6.0 for x in SL), (asked, left, why, SL)
xb = E._xb_load()['syms']
assert xb['SYRMA']['stamps'] == {'2026-09-30': '20261030211026', '2026-06-30': '20260729173516'}, xb['SYRMA']
assert xb['RAJAPALAYAM']['n'] == 0 and xb['RAJAPALAYAM']['stamps'] == {}
assert xb['FULL']['stamps'].get('2024-12-31') == '20250204160000', 'a full page: the missing quarter asked by date'
assert sum(1 for u in URLS if 'symbol=SYRMA' in u) == 1, 'SYRMA: one request (the integrated list had both quarters)'
assert sum(1 for u in URLS if 'symbol=RAJAPALAYAM' in u) == 2, 'RAJAPALAYAM: both lists asked'
assert E.missing_dates(INP, {}, q) == [], 'found ones have dates; RAJAPALAYAM / FULL not asked again so soon'
assert [t[0] for t in E.missing_dates(INP, {}, q, now=time.time() + 8 * 86400)] == ['FULL'], \
    'after a week: only a stock still missing a date that has filings (FULL: Jun 2025, past its lists) - RAJAPALAYAM waits 30 days'
_u, pq3, _c = E.compute(L, INP, {}, TODAY, 8)
by = {(x['sym'], x['why']) for x in pq3[JUN]}
assert ('RAJAPALAYAM', 'nofiling') in by and ('SYRMA', 'price') in by, by     # SYRMA has its date now (no candles here)
sy = [x for x in pq3[JUN] if x['sym'] == 'SYRMA'][0]
assert sy['ann'] == '2026-07-29 17:35' and sy['src'] == 'xbrl', sy
# NSE refusing twice: the pass stops, the stock stays to do
def refuse(opener, url, referer=None, timeout=30):
    return 403, b''


X.bind(get=refuse)
os.remove(E.XB_PATH)
asked, found, left, why = E.xbrl_dates(TODAY, [('SYRMA', [JUN])], 5, 6.0, LOGS.append, lambda s: None)
assert asked == 0 and left == 1 and 'twice' in why, (asked, left, why)
X.bind(get=fake_get)
os.remove(E.XB_PATH) if os.path.exists(E.XB_PATH) else None

# ------------------------------------------------------------------ 9. the round's step: posts per quarter, once
E._ann_save({'v': 1, 'days': [], 'rows': {'LAURUSLABS': ['2026-07-24 16:05:10'], 'FLAT': ['2026-07-30 12:00:00']}})
CALLS = []
REPLY = {'ok': True}


def api(cfg, action, payload=None, tries=3, timeout=120):
    CALLS.append((action, json.loads(json.dumps(payload))))
    return dict(REPLY)


E.bind(fetch=lambda o, a, b: ([], None))
cfg = {'url': 'x', 'token': 'y'}
n = E.step(cfg, api, L, inp, SCREENER, today=TODAY, gap=0, sleep=lambda s: None)
posted = [p for a, p in CALLS if a == 'epst']
assert n == len(posted) and {p['q'] for p in posted} >= {'Jun 2026'}, (n, [p['q'] for p in posted])
p = [x for x in posted if x['q'] == 'Jun 2026'][0]
assert p['op'] == 'put' and p['end'] == '2026-06-30' and p['fy'] == 'Q1 FY27' and p['engine'] == E.ENGINE == 3 and p['sum']['target'] == 2
assert E.unpack(p['blob'])[0]['sym'] == 'FLAT'
CALLS.clear()
assert E.step(cfg, api, L, inp, SCREENER, today=TODAY, gap=0, sleep=lambda s: None) == 0 and not CALLS, 'nothing changed: no post'
assert E.step(cfg, api, L, inp, SCREENER, today=TODAY, force=True, gap=0, sleep=lambda s: None) == n and len(CALLS) == n
os.remove(E.STATE_PATH)
CALLS.clear()
REPLY = {'ok': False, 'error': 'unknown action'}
LOGS.clear()
assert E.step(cfg, api, L, inp, SCREENER, today=TODAY, gap=0, sleep=lambda s: None) is None
assert any('updater' in x for x in LOGS) and not json.load(open(E.STATE_PATH)).get('sent'), LOGS
REPLY = {'ok': True}
assert E.step(dict(cfg, eps_target=False), api, L, inp, SCREENER, today=TODAY) is None, 'config eps_target false = off'

# ------------------------------------------------------------------ 10. size: 1,800 stocks fit the sheet comfortably
random.seed(4)
big = []
for k in range(1800):
    rr = E.after(cs, k0, 1624.1 * random.uniform(1.05, 3), NIFTY)
    rr.update({'sym': 'S%04d' % k, 'st': 'ok', 'why': '', 'b': 'C', 'fl': '--------', 'eps': [round(random.uniform(-5, 50), 2) for _ in range(8)],
               'ttm': 20.26, 'prev': 9.44, 'g': 114.62, 'tgt': 2322.17, 'ann': '2026-07-24 16:05', 'src': 'nse'})
    big.append(rr)
blob = E.pack(big)
assert len(blob) < 900000, len(blob)
print('blob for 1,800 stocks: %d characters' % len(blob))
print('OK')
