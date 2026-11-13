# -*- coding: utf-8 -*-
"""Offline checks of the Backtest Lab (pcbridge/ScreenerBridge/backtest_lab.py; owner, 09-Nov-2026: stop slightly under
the FVG zone, at least 2R, then the stop to the entry and a trail under the lowest low of the last 2 candles; days, stop,
risk and returns all set on the website's page). Prints OK at the end."""
import importlib.util
import json
import os
import random
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
LOGS = []
L.log = lambda m: LOGS.append(m)
TMP = tempfile.mkdtemp()
L.LAB_DIR = os.path.join(TMP, 'lab_cache')
L.CHARTS_DIR = os.path.join(TMP, 'lab_charts')
K.DATA_DIR = os.path.join(TMP, 'intraday_data')
K.STATE_PATH = os.path.join(TMP, 'intraday_state.json')


def P(**kw):
    return L.clean_params(kw)


# ------------------------------------------------------------------ 1. the rules from the page, checked
p = P()
assert p['stop'] == 'zone' and p['stopBuf'] == 0.5 and p['targetR'] == 2 and p['after'] == 'trail' and p['trail'] == 'lows' \
    and p['trailN'] == 2 and p['breakeven'] is True and p['maxDays'] == 60, p
p = P(tf='X', group='nope', stopBuf=-3, trailN=2.6, maxDays=99999, cost='1', breakeven='yes', capital=True, frm='x',
      **{'from': '2020-01-05xx', 'to': 'bad'})
assert p['tf'] == 'D' and p['group'] == 'fvg' and p['stopBuf'] == 0 and p['trailN'] == 3 and p['maxDays'] == 3650, p
assert p['cost'] == 0.2 and p['breakeven'] is True and p['capital'] == 1000000 and p['from'] == '2020-01-05' and p['to'] == '', p
assert 'frm' not in p


# ------------------------------------------------------------------ 2. one trade (handmade candles through the cache)
D0 = date(2026, 1, 5)


def cdl(k, o, h, l, c, tf='D'):
    d = (D0 + timedelta(days=k)).isoformat()
    return {'t': d + (' 13:15' if tf == '4H' else ''), 'day': d, 'o': o, 'h': h, 'l': l, 'c': c, 'v': 1000}


def cache_of(stocks, tf='D'):
    """{sym: (candles, rows)} -> the current cache; returns the Candles of each stock."""
    w = L.CacheWriter(date(2026, 6, 1))
    for sym, (cs, rows) in stocks.items():
        w.add(sym, tf, cs, rows)
    w.close()
    meta, d = L.load_meta()
    out = {}
    with open(os.path.join(d, tf + '.bin'), 'rb') as f:
        for sym in stocks:
            off, n = meta['index'][tf][sym]
            out[sym] = L.Candles(f, off, n)
    return out


# the Spring candle (i = 1): close 96.5, low 94; the FVG zone 95 - 99 (bottom 95): stop = 95 x (1 - 0.5 %) = 94.525
# risk 1.975, 2R target = 100.45
base = [cdl(0, 100, 101, 95.5, 96), cdl(1, 96, 97, 94, 96.5)]
ROW = [1, 'F', 95.0, 99.0, 'b', 1, 0, 50.0]


def run(path, row=ROW, **kw):
    cs = cache_of({'X': (base + path, [row])})['X']
    params = dict(dict(cost=0, lockTarget=False), **kw)      # the exit mechanics; the target lock (12-Nov-2026) below
    pp = P(**params)
    ema = L.ema_series(cs.c, pp['emaN']) if pp['trail'] == 'ema' else None
    return L.simulate(cs, row, pp, ema)


# up to the target on day 3 (high 101), then the trail under the last 2 lows: lows 99, 100.5, 101.5 -> stop 100.5 -> the
# day-6 low 100.2 breaks it -> sold at 100.5 = (100.5 - 96.5) / 1.975 = 2.03R
path = [cdl(2, 96.5, 98, 96, 97.5), cdl(3, 97.5, 101, 99, 100.8), cdl(4, 100.8, 103, 100.5, 102.5), cdl(5, 102.5, 104, 101.5, 103.5),
        cdl(6, 103.5, 104, 100.2, 101)]
t, why = run(path)
assert why is None and t['reason'] == 'trail' and t['exit'] == 100.5 and t['hit'], t   # lows of days 4-5: 100.5, 101.5 -> 100.5
assert abs(t['stop'] - 94.53) < 0.01 and t['riskPct'] == round(1.975 / 96.5 * 100, 2), t
assert t['R'] == round((100.5 - 96.5) / 1.975, 3) and t['days'] == 5 and t['maxR'] == round((104 - 96.5) / 1.975, 2), t
# the stop first: a low under 94.525 before the target -> -1R
t, _ = run([cdl(2, 96.5, 98, 94.4, 95)])
assert t['reason'] == 'stop' and t['exit'] == 94.525 and t['R'] == -1.0 and not t['hit'], t
# a gap down through the stop: sold at the open
t, _ = run([cdl(2, 92, 93, 91, 92.5)])
assert t['reason'] == 'stop' and t['exit'] == 92 and t['R'] == round((92 - 96.5) / 1.975, 3), t
# a candle reaching both the stop and the target: the stop (we cannot know which came first)
t, _ = run([cdl(2, 96.5, 101, 94, 100)])
assert t['reason'] == 'stop' and not t['hit'], t
# the target, then back to the entry: the stop moved there -> 0R ("breakeven")
t, _ = run([cdl(2, 96.5, 101, 96.6, 100), cdl(3, 100, 100.5, 96, 96.2)])
assert t['reason'] == 'be' and t['exit'] == 96.5 and t['R'] == 0.0, t
# no breakeven, no trail: back under the original stop after the target = a loss
t, _ = run([cdl(2, 96.5, 101, 96.6, 100), cdl(3, 100, 100.5, 93, 94)], breakeven=False, trail='none')
assert t['reason'] == 'stop' and t['hit'] and t['R'] == -1.0, t
# THE TARGET LOCK (owner, 12-Nov-2026, SIGNPOST: "The target was hit by price opening gap and price closed below the target
# price, then price closed below the SL. our backtest took this as failed trade. It should be considered as Win"; his answer:
# once the target is reached the stop = the target): back to the entry after the target = sold at the target, a win
t, _ = run([cdl(2, 96.5, 101, 96.6, 100.7), cdl(3, 100.7, 100.9, 96, 96.2)], lockTarget=True)
assert t['reason'] == 'lock' and round(t['exit'], 2) == 100.45 and t['R'] == 2.0, t
t, _ = run([cdl(2, 96.5, 101, 96.6, 100.7), cdl(3, 100.7, 100.9, 93, 94)], lockTarget=True, breakeven=False, trail='none')
assert t['reason'] == 'lock' and t['R'] == 2.0, t
# SIGNPOST: a gap open above the target, a close under it the same day -> sold at the target that day (not a loss later)
t, _ = run([cdl(2, 101.5, 102, 99, 99.5), cdl(3, 99.5, 100, 93, 94)], lockTarget=True)
assert t['reason'] == 'lock' and round(t['exit'], 2) == 100.45 and t['days'] == 1 and t['R'] == 2.0, t
t, _ = run([cdl(2, 101.5, 102, 99, 99.5), cdl(3, 99.5, 100, 93, 94)])           # the old way: breakeven, then 0R
assert t['reason'] == 'be' and t['R'] == 0.0, t
# a gap DOWN under the locked target: sold at the open (below the target)
t, _ = run([cdl(2, 96.5, 101, 96.6, 100), cdl(3, 99, 99.5, 98, 98.2)], lockTarget=True)
assert t['reason'] == 'lock' and t['exit'] == 99, t
# the trail still runs above the target
t, _ = run(path, lockTarget=True)
assert t['reason'] == 'trail' and t['exit'] == 100.5, t
# sell at the target ('fixed')
t, _ = run(path, after='fixed')
assert t['reason'] == 'target' and t['R'] == 2.0 and round(t['exit'], 2) == 100.45, t
t, _ = run(path, after='fixed', targetR=3)
assert t['reason'] == 'trail' or t['R'] == 3.0, t
# an open above the target
t, _ = run([cdl(2, 102, 103, 101.8, 102.5), cdl(3, 102.5, 103, 96, 97)], after='fixed')
assert t['reason'] == 'target' and t['exit'] == 102, t
# the time limit: sold at the close of the last day inside maxDays
flat = [cdl(k, 97, 98, 96, 97.2) for k in range(2, 30)]
t, _ = run(flat, maxDays=10)
assert t['reason'] == 'time' and t['days'] == 10 and t['exit'] == 97.2, t
# the data ends before the days are over: still running
t, _ = run(flat[:5], maxDays=60)
assert t['reason'] == 'open', t
# a too-big risk is skipped; the stop under the Spring low / the lower one / x % under the entry
t, why = run(path, maxRisk=1)
assert t is None and why == 'risk'
t, _ = run(path, stop='spring', stopBuf=0)
assert t['stop'] == 94 and t['risk'] == 2.5, t
row_low = [1, 'F', 93.0, 99.0, 'b', 1, 0, 50.0]
t, _ = run(path, row=row_low, stop='lower', stopBuf=0)
assert t['stop'] == 93, t
t, _ = run(path, stop='pct', stopPct=2)
assert t['stop'] == round(96.5 * 0.98, 2), t
# every Spring (no zone) with the zone stop: under its own low
t, _ = run(path, row=[1, 'S', None, None, '', 0, 0, 50.0])
assert t['stop'] == round(94 * 0.995, 2), t
# the next candle's open as the entry
t, _ = run(path, entry='next_open')
assert t['entry'] == 96.5 and t['reason'] == 'trail', t
t, why = run([cdl(2, 94, 95, 93, 94.5)], entry='next_open')
assert t is None and why == 'gap', (t, why)
# x % under the highest high
t, _ = run(path + [cdl(7, 101, 102, 99, 100)], trail='pct', trailPct=3)
assert t['reason'] == 'trail' and t['exit'] == round(104 * 0.97, 2), t
# a close under the EMA (after the target)
t, _ = run(path + [cdl(7, 101, 101.5, 95, 95.5)], trail='ema', emaN=3)
assert t['reason'] in ('ema', 'be') and t['hit'], t
# costs: 0.2 % of the entry per round trip, in R and %
cs = cache_of({'X': (base + path, [ROW])})['X']
t, _ = L.simulate(cs, ROW, P(cost=0.2))
assert t['R'] == round((100.5 - 96.5 - 0.193) / 1.975, 3) and t['ret'] == round((100.5 - 96.5 - 0.193) / 96.5 * 100, 2), t


# ------------------------------------------------------------------ 3. the groups
rows = [[5, 'S', None, None, '', 0, 0, 10.0], [5, 'F', 1, 2, 't', 1, 0, 10.0], [5, 'G', 1, 2, 'b', 3, 1, 10.0],
        [9, 'S', None, None, '', 0, 0, 2.0], [9, 'G', 1, 2, 'm', 1, 0, 2.0]]
g = lambda **kw: [(r[0], r[1]) for r in L.pick(rows, P(**kw))]
assert g(group='spring') == [(5, 'S'), (9, 'S')]
assert g(group='fvg') == [(5, 'F')] and g(group='fvg_top') == [(5, 'F')] and g(group='fvg_bottom') == []
assert g(group='gap') == [(5, 'G'), (9, 'G')] and g(group='gapin') == [(5, 'G')]
assert g(group='zone') == [(5, 'F'), (5, 'G'), (9, 'G')], 'every row of a candle (run_job takes the first that passes)'
assert g(group='gap', maxTouch=2) == [(9, 'G')] and g(group='gap', minTurnover=5) == [(5, 'G')]


# ------------------------------------------------------------------ 4. the account: risk per trade, at most N at once
def T(sym, ed, xd, entry, risk, exit_, reason='trail'):
    return {'sym': sym, 'ek': (ed, 0), 'xk': (xd, 0), 'entry': entry, 'risk': risk, 'exit': exit_, 'reason': reason,
            'R': (exit_ - entry) / risk}


o = date(2020, 1, 1).toordinal()
ts = [T('A', o, o + 10, 100, 5, 110), T('B', o + 1, o + 5, 50, 2, 48), T('C', o + 2, o + 20, 200, 10, 230),
      T('D', o + 6, o + 30, 100, 4, 96), T('E', o + 7, o + 9, 10, 1, 12, 'open')]
acc = L.portfolio(ts, P(capital=100000, riskPct=1, maxPosPct=25, maxOpen=2, cost=0))
# A: 1000 / 5 = 200 shares (20,000 = 20 %) -> +2,000; B: 1000 / 2 = 500, capped 25,000 / 50 = 500 -> -1,000;
# C: 2 open (A, B) -> skipped; D (day 6: B sold on day 5): 250 -> -1,000; E: A and D open -> skipped
taken = {t['sym']: (t['qty'], t['pnl']) for t in ts if t['taken']}
assert taken == {'A': (200, 2000), 'B': (500, -1000), 'D': (250, -1000)}, taken
assert acc['skipped'] == 2 and acc['final'] == 100000 and acc['returnPct'] == 0 and acc['taken'] == 3, acc
assert [c[1] for c in acc['curve']] == [99000, 101000, 100000], acc['curve']
assert acc['maxDD'] == 1.0, acc   # 100,000 -> 99,000 (1 %) is deeper than 101,000 -> 100,000
acc = L.portfolio([dict(t) for t in ts], P(capital=100000, riskPct=1, maxPosPct=25, maxOpen=10, cost=0))
assert acc['taken'] == 5 and acc['openNow'] == 1 and acc['skipped'] == 0, acc


# ------------------------------------------------------------------ 5. the cache from the backtest pass = the backtest's own signals
def walk(seed, n):
    rnd = random.Random(seed)
    out, px = [], 100.0
    for k in range(n):
        d = (date(2010, 1, 4) + timedelta(days=k)).isoformat()
        o_ = px * (1 + rnd.uniform(-0.03, 0.03))
        c_ = o_ * (1 + rnd.uniform(-0.05, 0.05))
        h_ = max(o_, c_) * (1 + rnd.uniform(0, 0.03))
        l_ = min(o_, c_) * (1 - rnd.uniform(0, 0.03))
        out.append([d, round(o_, 2), round(h_, 2), round(l_, 2), round(c_, 2), rnd.randint(1000, 90000)])
        px = c_
    return out


os.makedirs(K.DATA_DIR, exist_ok=True)
for k, sym in enumerate(('AAA', 'BBB', 'CCC')):
    K.store_save(sym, {'v': 1, 'sym': sym, 'm15': [], 'day': walk(k + 3, 900), 'h4': []})
upto = date(2012, 6, 20)
n, trades, springs = K.backtest_pass(set(), upto, {}, out=lambda m: None)
assert n == 3 and trades and springs, (n, len(trades), len(springs))
meta, d = L.load_meta()
assert meta['upto'] == '2012-06-20' and sorted(meta['index']['D']) == ['AAA', 'BBB', 'CCC'], meta['index']
for tf in ('D', 'W'):
    rows = [r for sym in meta['signals'][tf] for r in meta['signals'][tf][sym]]
    assert sum(1 for r in rows if r[1] == 'S') == sum(1 for s in springs if s[0] == tf), tf
    assert sum(1 for r in rows if r[1] in ('F', 'G')) == sum(1 for t in trades if t['tf'] == tf), tf
# the cached candles = the stored ones
with open(os.path.join(d, 'D.bin'), 'rb') as f:
    off, cnt = meta['index']['D']['BBB']
    cs = L.Candles(f, off, cnt)
day = [r for r in K.store_load('BBB')['day'] if r[0] <= upto.isoformat()]   # finished candles only
assert cs.n == len(day) and date.fromordinal(cs.day[10]).isoformat() == day[10][0] and abs(cs.h[10] - day[10][2]) < 0.01
# a second pass replaces the first build (one build kept)
K.backtest_pass(set(), upto, {}, out=lambda m: None)
builds = [x for x in os.listdir(L.LAB_DIR) if x.startswith('b')]
assert len(builds) == 1 and not any(x.endswith('.tmp') for x in builds), builds

# a whole run on it, every group, both entries
for grp in ('fvg', 'gap', 'zone', 'spring'):
    res = L.run_job({'tf': 'D', 'group': grp, 'maxRisk': 0})
    assert res['params']['group'] == grp and res['tradeCols'] == L.TRADE_COLS
    assert res['tradesTotal'] == len(res['trades']) == res['stats'].get('trades', 0) + res['open'], res['stats']
res = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'stop': 'spring', 'stopBuf': 0})
s = res['stats']
assert s['trades'] > 20 and 0 <= s['winPct'] <= 100 and sum(h['n'] for h in res['hist']) == s['trades'], s
assert sum(res['reasons'].values()) == res['tradesTotal'] and res['account']['taken'] > 0, res['reasons']
assert all(len(r) == len(L.TRADE_COLS) for r in res['trades'])
assert json.loads(json.dumps(res)) and len(json.dumps(res)) < 2000000
# the date range
res2 = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'from': '2011-01-01', 'to': '2011-12-31'})
assert res2['tradesTotal'] and all(r[1].startswith('2011') for r in res2['trades']), res2['trades'][:3]
assert L.headline(res).startswith('%d trades' % s['trades'])


# ------------------------------------------------------------------ 6. the background worker: poll -> run -> result
class FakeSheet:
    def __init__(self, jobs):
        self.jobs, self.calls = list(jobs), []

    def __call__(self, cfg, action, payload, tries=1, timeout=60):
        assert action == 'lab'
        self.calls.append(payload)
        if payload['op'] == 'poll':
            return {'ok': True, 'job': self.jobs.pop(0) if self.jobs else None, 'next': 10}
        return {'ok': True}


api = FakeSheet([{'id': 'L1', 'name': 'my idea', 'params': {'tf': 'D', 'group': 'spring', 'maxRisk': 0}}])
w = L.LabWorker()
w.loop({}, api, rounds=2)
ops = [c['op'] for c in api.calls]
assert ops[0] == 'poll' and 'result' in ops and ops[-1] == 'poll', ops
res = next(c for c in api.calls if c['op'] == 'result')
assert res['id'] == 'L1' and res['result']['stats']['trades'] > 0
assert any('"my idea" done' in m for m in LOGS), LOGS[-3:]
# no cache yet: the worker makes it first (the build function), then runs
import shutil
shutil.rmtree(L.LAB_DIR)
built = []
w.build = lambda out: built.append(1) or K.backtest_pass(set(), upto, {}, out=out)[0] > 0
api = FakeSheet([{'id': 'L2', 'params': {'tf': 'W', 'group': 'spring'}}])
w.loop({}, api, rounds=1)
assert built and any(c['op'] == 'result' for c in api.calls), api.calls    # (an older build function: no progress to tell)
# a run that fails tells the sheet
shutil.rmtree(L.LAB_DIR)
w.build = None
api = FakeSheet([{'id': 'L3', 'params': {}}])
w.loop({}, api, rounds=1)
fail = [c for c in api.calls if c['op'] == 'fail']
assert fail and 'BacktestNow' in fail[0]['error'], api.calls
# an older web app: told once, then a long wait
api2 = lambda cfg, action, payload, tries=1, timeout=60: {'ok': False, 'error': 'unknown action'}
LOGS.clear()
w.loop({}, api2, rounds=2)
assert sum('older version' in m for m in LOGS) == 1, LOGS

# ------------------------------------------------------------------ 7. EMA confluence + why a trade was not taken (owner, 09-Nov-2026)
assert [L._rs(x, d) for x, d in ((1234567, 0), (300000, 0), (999.999, 2), (84.5, 2), (10062.93, 2), (-1500, 0))] == \
    ['12,34,567', '3,00,000', '1,000', '84.5', '10,062.93', '-1,500']
p = P(emaSupport=10, above50=True, emaStack=True, emaTouch=2)
assert (p['emaSupport'], p['above50'], p['emaStack'], p['emaTouch']) == (10, True, True, 2.0) and L.ema_lens(p) == [10, 21, 50]
assert L.ema_lens(P()) == [] and L.ema_lens(P(emaSupport=1)) == [10, 21, 50] and L.ema_lens(P(above21=True)) == [21]
assert P(emaSupport=7)['emaSupport'] == 0 and P(emaSupport=True)['emaSupport'] == 0 and P(emaSupport=21.0)['emaSupport'] == 21


class CS:
    def __init__(self, rows):
        self.o, self.h, self.l, self.c = ([r[k] for r in rows] for k in range(4))
        self.n = len(rows)


# a steady rise (10 > 21 > 50 EMA), then a Spring candle whose low dips to the 10 EMA and closes above it
rise = [[100 + k, 101 + k, 99 + k, 100 + k] for k in range(80)]
cs = CS(rise)
emas = {n: L.ema_series(cs.c, n) for n in (10, 21, 50)}
i = 79
e10 = emas[10][i]
cs.l[i] = round(e10 - 0.3, 2)
ok, note = L.ema_check(cs, i, P(emaSupport=10, emaStack=True, above50=True), emas)
assert ok and note.startswith('support 10') and '10>21>50' in note, note
# the low stayed well above every EMA: no support at 10
cs.l[i] = round(e10 * 1.05, 2)
assert not L.ema_check(cs, i, P(emaSupport=10), emas)[0]
assert L.ema_check(cs, i, P(emaSupport=10, emaTouch=6), emas)[0], 'within 6 % above the EMA counts as support'
# closed under the EMA: no support, not above
cs.l[i], cs.c[i] = e10 - 3, round(e10 - 1, 2)
assert not L.ema_check(cs, i, P(emaSupport=10), emas)[0] and not L.ema_check(cs, i, P(above10=True), emas)[0]
assert not L.ema_check(cs, 30, P(above50=True), emas)[0], 'too few candles for the 50 EMA'
# a run with the EMA rules: fewer trades, the others counted as left out, each trade says what the EMAs showed
K.backtest_pass(set(), upto, {}, out=lambda m: None)          # section 6 removed the cache
base_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0})
ema_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'above21': True})
assert 0 < ema_run['tradesTotal'] < base_run['tradesTotal'], (ema_run['tradesTotal'], base_run['tradesTotal'])
assert ema_run['tradesTotal'] + ema_run['skipped']['ema'] == base_run['tradesTotal']
assert all('above' in r[L.TRADE_COLS.index('ema')] or 'support' in r[L.TRADE_COLS.index('ema')] for r in ema_run['trades'])
assert all(r[L.TRADE_COLS.index('ema')] == '' for r in base_run['trades']), 'no EMA rule: no EMA text'

# why a signal was not taken
o = date(2021, 1, 1).toordinal()
ts = [T('A', o, o + 10, 100, 5, 110), T('B', o + 1, o + 9, 100, 5, 104), T('C', o + 2, o + 9, 40000, 900, 41000),
      T('D', o + 3, o + 9, 200, 150, 210), T('E', o + 4, o + 9, 50, 2, 52)]
acc = L.portfolio(ts, P(capital=300000, riskPct=1, maxPosPct=5, maxOpen=3, cost=0))
by = {t['sym']: t for t in ts}
assert by['A']['taken'] and '150 shares' in by['A']['acct'] and 'made smaller by your position limit of 5%' in by['A']['acct'] \
    and 'would be 600 shares' in by['A']['acct'], by['A']['acct']
assert not by['C']['taken'] and 'one share costs Rs 40,000, more than your position limit of Rs 15,000 (5% of the account' in by['C']['acct'], by['C']['acct']
assert by['D']['taken'] and by['D']['acct'] == '20 shares, Rs 4,000 invested, Rs 3,000 at risk.', by['D']['acct']
assert not by['E']['taken'] and '3 trades were already open - your limit is 3 at once' in by['E']['acct'], by['E']['acct']
assert acc['skipReasons'] == {'full': 1, 'cap': 1, 'risk': 0, 'blown': 0} and acc['capped'] == 2, acc
x = T('X', o, o + 5, 500, 400, 600)
acc2 = L.portfolio([x], P(capital=10000, riskPct=1, maxPosPct=100, maxOpen=5, cost=0))
assert acc2['skipReasons']['risk'] == 1 and acc2['skipped'] == 1
assert x['acct'] == 'Not taken: one share risks Rs 400 (entry 500 - stop 100), more than your risk per trade of Rs 100 (1% of the account).', x['acct']
row = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'maxOpen': 1, 'lockTarget': False})['trades']
assert any(r[L.TRADE_COLS.index('taken')] == 0 and r[L.TRADE_COLS.index('acct')].startswith('Not taken: 1 trades were already open')
           for r in row), 'the list carries the reason'

# ------------------------------------------------------------------ 8. market condition: the index's own EMA (owner, 09-Nov-2026)
assert K.index_names(['NIFTY_50', 'NIFTY_IT', 'bad name!', 'NIFTY_IT'])[:3] == ['NIFTY 50', 'NIFTY IT', 'NIFTY NEXT 50']
assert len(K.index_names([])) == len(K.LAB_INDICES)
# Kite's daily index candles: back DEEP_DAY_YEARS in chunks the first time, then a short read, nothing when up to date
idx_rows = []
d0 = date(2008, 1, 1)
for k in range(6400):
    d = d0 + timedelta(days=k)
    if d.weekday() < 5:
        px = 5000 + k if d.year < 2011 else 5000 + 3 * 365 - (k - 3 * 365) * 2    # up until 2011, then down
        idx_rows.append([d.isoformat(), px, px + 5, px - 5, px, 0])
HC = []
orig_hist = K.historical


def fake_idx(cfg, sess, token, interval, frm, to):
    HC.append((token, interval, frm.date(), to.date()))
    return [r for r in idx_rows if frm.date().isoformat() <= r[0] <= to.date().isoformat()]


K.historical = fake_idx
try:
    n = K.update_index({}, {}, 'NIFTY 50', 256265, date(2012, 6, 20))
    assert n >= 2 and all(h[1] == 'day' for h in HC) and K.index_load('NIFTY 50')['day'][0][0] == '2008-01-01', (n, HC[:3])
    HC.clear()
    assert K.update_index({}, {}, 'NIFTY 50', 256265, date(2012, 6, 20)) == 0 and not HC, 'up to date: nothing read'
    assert K.update_index({}, {}, 'NIFTY 50', 256265, date(2012, 6, 29)) == 1 and HC[0][2] == date(2012, 6, 16), HC
    read, missing = K.index_fill({}, {}, {'IDX:NIFTY 50': 256265}, ['NIFTY 50', 'NIFTY XYZ'], date(2012, 6, 29), out=LOGS.append)
    assert (read, missing) == (1, ['NIFTY XYZ']) and any('not on Kite: NIFTY XYZ' in m for m in LOGS[-2:])
finally:
    K.historical = orig_hist
closes = K.index_closes(date(2012, 6, 20))
assert list(closes) == ['NIFTY_50'] and closes['NIFTY_50'][-1][0] == date(2012, 6, 20).toordinal()
# into the cache with the next backtest pass, and the run's filter
K.backtest_pass(set(), upto, {}, out=lambda m: None)
meta, _ = L.load_meta()
assert list(meta['indices']) == ['NIFTY_50'] and len(meta['indices']['NIFTY_50']['d']) == len(closes['NIFTY_50'])
base_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0})
assert base_run['indexNames'] == ['NIFTY_50']
up_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'mktIndex': 'NIFTY_50', 'mktAbove': 50})
assert 0 < up_run['tradesTotal'] < base_run['tradesTotal'] and up_run['tradesTotal'] + up_run['skipped']['mkt'] == base_run['tradesTotal']
assert all(r[1] < '2011-03' for r in up_run['trades']), 'only while NIFTY 50 was above its 50 EMA (the rise up to 2011)'
st_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'mktIndex': 'nifty 50', 'mktStack': True})
assert st_run['params']['mktIndex'] == 'NIFTY_50' and 0 < st_run['tradesTotal'] < base_run['tradesTotal']
assert L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'mktIndex': 'NIFTY_50'})['tradesTotal'] == base_run['tradesTotal'], \
    'an index without a condition changes nothing'
try:
    L.run_job({'tf': 'D', 'group': 'spring', 'mktIndex': 'NIFTY_BANK', 'mktAbove': 21})
    raise AssertionError('no index candles: must refuse')
except L.LabError as e:
    assert 'NIFTY BANK' in str(e) and 'it has: NIFTY_50' in str(e), e
assert L.clean_params({'mktIndex': 'NIFTY 50; drop', 'mktAbove': 7})['mktIndex'] == '' and L.clean_params({'mktAbove': 7})['mktAbove'] == 0

# ------------------------------------------------------------------ 9. hard Spring rules (owner, 10-Nov-2026)
# the rules from the page: every one at its base value = no shape rule; out-of-range / wrong kinds are corrected
d = P()
assert not L.shape_active(d) and d['upWickMax'] == 100 and d['c2Color'] == 'any' and d['undercutMin'] == 0.1 and d['c2BodyMax'] == 30 \
    and d['c1BodyMin'] == 0.5 and d['recover'] is False and d['lowestN'] == 0 and d['fallN'] == 0, d
q = P(upWickMax=-5, loWickMin=250, c2Color='blue', c2BodyMax=80, undercutMin=0.01, recover='yes', lowestN=7.6, fallPct=0, undAtr=9, c1BodyMin=0.1)
assert (q['upWickMax'], q['loWickMin'], q['c2Color'], q['c2BodyMax'], q['undercutMin'], q['recover'], q['lowestN'], q['fallPct'], q['undAtr'], q['c1BodyMin']) \
    == (0, 100, 'any', 30, 0.1, False, 8, 0.5, 5, 0.5), q
assert L.shape_active(P(upWickMax=10)) and L.shape_active(P(c2Color='green')) and L.shape_active(P(recover=True)) and not L.shape_active(P(fallPct=20)), \
    'fallPct alone (fallN = 0) is no rule'
assert len(P(**{k: DEF for k, DEF in L.DEFAULTS.items()})) == len(L.DEFAULTS) and 'upW' in L.TRADE_COLS and L.TRADE_COLS[-8:] == ['acct', 'depth', 'lhll', 'lag', 'zpct', 'pat', 'zn', 'mv']
assert all(len(k) <= 20 and k.isalnum() for k in L.DEFAULTS if k not in ('from', 'to')), 'the sheet keeps keys of <= 20 letters / digits'

# 20 quiet candles (range 2, low 99), then the red candle c1 (O100 H100.4 L96.8 C97 = body 3.0) at i = 20 and c2 at i = 21
quiet = [[100, 101, 99, 100] for _ in range(20)]
C1 = [100, 100.4, 96.8, 97]


def pair(c2, before=quiet):
    return CS(before + [C1, c2]), len(before) + 1


def chk(c2, **kw):
    p = P(**kw)
    s, i = pair(c2)
    f = L.spring_feats(s, i, p, deep=True)
    return L.shape_check(f, p)[1] if not L.shape_check(f, p)[0] else 'ok'


hammer = [96.9, 97.2, 95.8, 97.1]          # lower wick 79 %, upper wick 7 %, body 14 % of its range; dip 1.03 %; closes 0.31 % over c1's low
s, i = pair(hammer)
f = L.spring_feats(s, i, P(), deep=True)
assert abs(f['upW'] - 100 * 0.1 / 1.4) < 1e-6 and abs(f['loW'] - 100 * 1.1 / 1.4) < 1e-6 and f['col'] == 'green' and f['recover'], f
assert abs(f['dip'] - 100 * 1.0 / 96.8) < 1e-6 and abs(f['above'] - 100 * 0.3 / 96.8) < 1e-6 and abs(f['bodyVs'] - 100 * 0.2 / 3.0) < 1e-6, f
assert abs(f['c1Body'] - 3.0) < 1e-6 and abs(f['c1Lo'] - 100 * 0.2 / 3.6) < 1e-6 and f['closePos'] > 92, f
assert chk(hammer) == 'ok' and chk(hammer, upWickMax=10) == 'ok' and chk(hammer, upWickMax=5) == 'upwick', 'upper wick 7 %'
assert chk(hammer, loWickMin=70) == 'ok' and chk(hammer, loWickMin=80) == 'lowick' and chk(hammer, closeMin=90) == 'ok' and chk(hammer, closeMin=95) == 'close'
assert chk([96.9, 97.2, 95.8, 97.2], upWickMax=0) == 'ok', 'no upper wick at all'
assert chk(hammer, upWickMax=0) == 'upwick'
# "looks like a doji": a tiny body with long wicks both sides
doji = [97.0, 97.8, 95.9, 97.05]
assert chk(doji) == 'ok' and chk(doji, c2BodyMin=10) == 'doji' and chk(doji, upWickMax=20) == 'upwick' and chk(hammer, c2BodyMin=10) == 'ok'
# colour
red_h = [97.1, 97.2, 95.8, 96.9]
assert chk(red_h, c2Color='green') == 'color' and chk(red_h, c2Color='red') == 'ok' and chk(hammer, c2Color='green') == 'ok' and chk(hammer, c2Color='red') == 'color'
assert chk(red_h, recover=True) == 'recover' and chk(hammer, recover=True) == 'ok', 'c2 close 96.9 is under c1 close 97'
# body against c1's body (c2 0.2 = 6.7 % of 3.0), the dip (1.03 %), the close above c1's low (0.31 %)
assert chk(hammer, c2BodyMax=10) == 'ok' and chk(hammer, c2BodyMax=5) == 'c2body'
assert chk(hammer, undercutMin=1) == 'ok' and chk(hammer, undercutMin=2) == 'dipmin' and chk(hammer, undercutMax=2) == 'ok' and chk(hammer, undercutMax=0.5) == 'dipmax'
assert chk(hammer, closeAbove=0.25) == 'ok' and chk(hammer, closeAbove=0.5) == 'closeabove'
# the red candle: body 3.0 %, lower wick 0.2 of its 3.6 range = 5.6 %
assert chk(hammer, c1BodyMin=3) == 'ok' and chk(hammer, c1BodyMin=3.5) == 'c1body' and chk(hammer, c1LoWickMax=6) == 'ok' and chk(hammer, c1LoWickMax=5) == 'c1wick'
# ATR(14) at c1 = (13 x 2 + 3.6) / 14 = 2.114: c1's body 3.0 = 1.42 ATR, the dip 1.0 = 0.47 ATR
assert abs(L.atr14(CS(quiet + [C1]), 20) - (13 * 2 + 3.6) / 14) < 1e-9 and L.atr14(CS(quiet[:10] + [C1]), 10) is None
assert chk(hammer, c1Atr=1.4) == 'ok' and chk(hammer, c1Atr=1.5) == 'c1atr' and chk(hammer, undAtr=0.4) == 'ok' and chk(hammer, undAtr=0.5) == 'dipatr'
# the lowest low of the last N candles (the quiet candles' lows are 99, c1's 96.8, c2's 95.8) and the fall before c1
assert chk(hammer, lowestN=20) == 'ok'
low_before = [list(c) for c in quiet]
low_before[12][2] = 95.0
s2 = CS(low_before + [C1, hammer])
assert L.shape_check(L.spring_feats(s2, 21, P(lowestN=20), True), P(lowestN=20)) == (False, 'lowest')
assert L.shape_check(L.spring_feats(s2, 21, P(lowestN=5), True), P(lowestN=5)) == (True, ''), 'the 95.0 low is older than 5 candles'
# the highest high of the last 10 candles is 101: the fall to c1's close 97 is 3.96 %
assert chk(hammer, fallN=10, fallPct=3) == 'ok' and chk(hammer, fallN=10, fallPct=5) == 'fall'
# too few candles before the pair for a rule that looks back
s3 = CS([[100, 101, 99, 100]] * 3 + [C1, hammer])
assert L.shape_check(L.spring_feats(s3, 4, P(lowestN=20), True), P(lowestN=20)) == (False, 'history')
assert L.shape_check(L.spring_feats(s3, 4, P(c1Atr=1), True), P(c1Atr=1)) == (False, 'history')
assert L.shape_check(None, P(upWickMax=1)) == (False, 'data') and L.spring_feats(CS([C1]), 0, P()) is None
assert set(L.SHAPE_WHY) >= {'upwick', 'lowick', 'close', 'doji', 'color', 'c2body', 'dipmin', 'dipmax', 'dipatr', 'closeabove', 'recover',
                            'c1body', 'c1wick', 'c1atr', 'lowest', 'fall', 'history', 'data'}

# a run: the hard rules leave out Springs (counted by the first rule they failed), the rest are the same trades
K.backtest_pass(set(), upto, {}, out=lambda m: None)
base_run = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0})
assert base_run['skipped']['shape'] == 0 and base_run['shapeWhy'] == {}, 'no shape rule: nothing left out'
ucol, lcol, dcol = (L.TRADE_COLS.index(c) for c in ('upW', 'loW', 'dip'))
assert all(isinstance(r[ucol], float) and 0 <= r[ucol] <= 100 and 0 <= r[lcol] <= 100 and r[dcol] > 0 for r in base_run['trades']), 'every trade carries its wicks + dip'
hard = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'upWickMax': 10, 'loWickMin': 50})
assert 0 < hard['tradesTotal'] < base_run['tradesTotal'], (hard['tradesTotal'], base_run['tradesTotal'])
assert hard['tradesTotal'] + hard['skipped']['shape'] == base_run['tradesTotal'] and sum(hard['shapeWhy'].values()) == hard['skipped']['shape'], hard['shapeWhy']
assert set(hard['shapeWhy']) <= {'upwick', 'lowick'} and hard['params']['upWickMax'] == 10
assert all(r[ucol] <= 10 and r[lcol] >= 50 for r in hard['trades']), 'every trade passes its own rules'
hard2 = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'upWickMax': 10, 'loWickMin': 50, 'c2Color': 'green', 'recover': True})
assert hard2['tradesTotal'] <= hard['tradesTotal'] and hard2['tradesTotal'] + hard2['skipped']['shape'] == base_run['tradesTotal']
# a rule at its base value changes nothing
same = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'upWickMax': 100, 'undercutMin': 0.1, 'c2BodyMax': 30, 'c1BodyMin': 0.5})
assert same['tradesTotal'] == base_run['tradesTotal'] and same['skipped']['shape'] == 0
# with the EMA rules too: each left-out Spring counted once
both = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'upWickMax': 10, 'above21': True})
assert both['tradesTotal'] + both['skipped']['shape'] + both['skipped']['ema'] == base_run['tradesTotal']

# ------------------------------------------------------------------ 10. market structure: CHoCH / BOS (owner, 10-Nov-2026)
S = L.structure


def leg(a, b, n=6):
    return [a + (b - a) * k / n for k in range(1, n + 1)]


# a downtrend of lower highs (95 / 90 / 85) and lower lows (85 / 80 / 75), then a rally closing above the last lower
# high (85) = CHoCH, a pullback, and a rally above the peak (96) = BOS
path = [100]
for top, bot in ((100, 90), (95, 85), (90, 80), (85, 75)):
    path += (leg(path[-1], top) if path[-1] != top else []) + leg(top, bot)
path += leg(75, 96, 8) + leg(96, 88, 5) + leg(88, 105, 6)
zc = path[1:]
zh = [max(a, b) + 0.2 for a, b in zip(path[:-1], zc)]
zl = [min(a, b) - 0.2 for a, b in zip(path[:-1], zc)]
st = S.Structure(zh, zl, zc, 3)
assert [round(zh[p], 1) for p in st.ph] == [95.2, 90.2, 85.2, 96.2], st.ph
assert len(st.events) == 1, st.events
b, hi_, lvl, li, lf, dd = st.events[0]
assert round(lvl, 1) == 85.2 and round(lf, 1) == 74.8 and dd == 2 and zc[b] > lvl and zc[b - 1] <= lvl, st.events
assert st.dead_by(0, zc, len(zc)) == -1
bos = st.bos_before(0, zc, len(zc))
assert bos > b and zc[bos] > 96.2 >= max(zc[b:bos]) and round(st.peak_before(0, zc, len(zc)), 1) == 96.2, bos
assert st.active(b, 1) == -1 and st.active(b + 1, 1) == 0 and st.active(b + 1, 3) == -1, 'a CHoCH counts from the next candle; d = 2'
# a signal in the pullback (before the BOS) on a zone formed after the final low and under the CHoCH level = the setup
pull = b + 9                                        # inside the 96 -> 88 pullback
j = st.judge(pull, li + 2, 84.0, zc[pull], zc, 2)
assert j['stage'] == 'below' and j['first'] and j['after_low'] and j['leg'] and not j['after'], j
assert st.judge(pull, li + 2, 86.0, zc[pull], zc, 2)['stage'] == 'above'
assert st.judge(pull, li - 3, 84.0, zc[pull], zc, 2)['stage'] == 'old', 'the zone formed before the final low'
assert st.judge(bos + 1, li + 2, 84.0, zc[bos + 1], zc, 2)['stage'] == 'bos', 'after the BOS: already moved'
assert st.judge(pull, li + 2, 84.0, zc[pull], zc, 3)['stage'] == 'none', 'needs 3 lower highs / lows: only 2 here'
assert st.judge(pull, li + 2, 84.0, zc[pull], zc, 2, max_age=3)['stage'] == 'none', 'older than 3 candles'
assert st.judge(pull, b + 3, 84.0, zc[pull], zc, 2)['after'], 'a zone formed after the CHoCH candle'
# a close under the final low kills it
dead_c = zc[:pull] + [74.0] + zc[pull + 1:]
st2 = S.Structure(zh, [min(x, y) for x, y in zip(zl, dead_c)], dead_c, 3)
assert st2.judge(pull + 1, li + 2, 84.0, 80, dead_c, 2)['stage'] == 'none'
# the last swing high above a price (the swing-high target)
assert round(st.last_swing_high(len(zc) - 1, 90)[1], 1) == 96.2 and st.last_swing_high(len(zc) - 1, 200) is None
assert round(st.last_swing_high(b + 5, 80)[1], 1) == 85.2, 'the 96 peak is not confirmed yet at that candle'
# nothing looks ahead: the events of any first part of a random chart = the full chart's events up to there,
# and every signal is judged the same
for seed in range(6):
    w = walk(100 + seed, 700)
    hh, ll, cc = [r[2] for r in w], [r[3] for r in w], [r[4] for r in w]
    full = S.Structure(hh, ll, cc, 5)
    assert full.events, 'a random chart has CHoCH events'
    for cut in (150, 333, 500, 699):
        part = S.Structure(hh[:cut], ll[:cut], cc[:cut], 5)
        assert part.events == [e for e in full.events if e[0] < cut], (seed, cut)
        for i in range(cut - 40, cut):
            a = part.judge(i, i - 5, cc[i] * 0.99, cc[i], cc[:cut], 1)
            bb = full.judge(i, i - 5, cc[i] * 0.99, cc[i], cc, 1)
            assert a == bb, (seed, cut, i, a, bb)
    assert all(e[5] >= 1 and e[3] > e[1] and e[0] > e[1] and cc[e[0]] > e[2] for e in full.events)

# the cache now has the FVG First Touch / Confirmed signals (the same as the sheet's / 4H scan's rule) + the zone's candle
meta, d = L.load_meta()
assert meta["v"] == L.CACHE_VERSION == 6
with open(os.path.join(d, 'D.bin'), 'rb') as f:
    off, cnt = meta['index']['D']['AAA']
    csa = L.Candles(f, off, cnt)
rows_a = meta['signals']['D']['AAA']
fc = [{'o': csa.o[k], 'h': csa.h[k], 'l': csa.l[k], 'c': csa.c[k]} for k in range(csa.n)]
ftx, cfx, _ = K.fvg_touch_events(fc, K.fvg_gaps(fc))
assert sorted(r[0] for r in rows_a if r[1] == 'T') == sorted(ftx) and sorted(r[0] for r in rows_a if r[1] == 'C') == sorted(cfx)
# ... and the first touch of EVERY zone (11-Nov-2026): 'Z' FVG / 'Y' Gap-up = zone_first_touches, highest top first
ztx = K.zone_first_touches(fc, K.spring_zones(fc, K.fvg_gaps(fc)))
assert ztx and sorted((r[0], r[8], r[1]) for r in rows_a if r[1] in ('Z', 'Y')) == \
    sorted((i, z['f'], 'Y' if z['kind'] == 'Gap-up' else 'Z') for i, zs in ztx.items() if i >= 3 for z in zs)
for i, zs in ztx.items():
    assert all(fc[i]['l'] <= z['top'] and all(fc[k]['l'] > z['top'] for k in range(z['f'] + 1, i)) for z in zs), 'the first touch'
    assert [z['top'] for z in zs] == sorted((z['top'] for z in zs), reverse=True)
assert all(len(r) == {'Z': 10, 'Y': 10, 'V': 10, 'P': 11, 'Q': 11}.get(r[1], 9) for r in rows_a) and all(r[8] == -1 for r in rows_a if r[1] == 'S')
assert all(0 <= r[8] <= r[0] - 2 for r in rows_a if r[1] in ('F', 'G')), 'the zone formed before the Spring pair'
assert all(r[8] < r[0] for r in rows_a if r[1] in ('T', 'C'))
for grp in ('ft', 'conf', 'entry'):
    res = L.run_job({'tf': 'D', 'group': grp, 'maxRisk': 0})
    assert res['tradesTotal'] > 0 and res['groupName'] == L.GROUP_NAMES[grp], grp
ent = L.run_job({'tf': 'D', 'group': 'entry', 'maxRisk': 0})
zcol = L.TRADE_COLS.index('zone')
assert {r[zcol] for r in ent['trades']} >= {'FVG', 'FVG first touch'}, {r[zcol] for r in ent['trades']}
# a shape rule leaves the FVG first touches alone (no Spring pair)
ent_shape = L.run_job({'tf': 'D', 'group': 'ft', 'maxRisk': 0, 'upWickMax': 0})
assert ent_shape['tradesTotal'] == L.run_job({'tf': 'D', 'group': 'ft', 'maxRisk': 0})['tradesTotal'] and ent_shape['skipped']['shape'] == 0

# a run: 'show' labels every trade, 'only' keeps the setup; the per-stage figures add up
q = P(structure='only', downN=9, zoneWhen='leg', targetMode='swing', swingMinR=2, pivotN=50)
assert (q['structure'], q['downN'], q['zoneWhen'], q['targetMode'], q['swingMinR'], q['pivotN']) == ('only', 8, 'leg', 'swing', 2, 20), q
assert P()['structure'] == 'off' and P()['belowChoch'] is True and P()['firstPull'] is True and P()['downN'] == 3 and P()['pivotN'] == 5
# the owner's setup on a made chart (DDD, swings of 2 candles): 3 lower highs / lows, a CHoCH rally with an FVG in it,
# the first pullback into that FVG with a Spring - stage 'below'
def craft():
    rows, prev = [], 130.0
    d0 = date(2010, 1, 4)

    def put(o, h, l, c):
        rows.append([(d0 + timedelta(days=len(rows))).isoformat(), round(o, 2), round(h, 2), round(l, 2), round(c, 2), 50000])

    def go(to, k):
        nonlocal prev
        for x in leg(prev, to, k):
            put(prev, max(prev, x) + 0.3, min(prev, x) - 0.3, x)
            prev = x
    for to in (122, 127, 117, 122, 112, 117, 106, 111, 100):    # highs 127 > 122 > 117 > 111, lows 122 > 117 > 112 > 106 > 100
        go(to, 4)
    put(100, 101.3, 99.7, 101)                                  # A
    put(101, 108.3, 100.7, 108)                                 # B (big green)
    put(108, 110.3, 106, 110)                                   # C: low 106 > A's high 101.3 -> FVG 101.3 - 106
    put(110, 113.3, 109.7, 113)                                 # D: closes above the last lower high 111.3 = CHoCH
    prev = 113
    go(117, 2)                                                  # the rally's peak
    go(108, 3)                                                  # the pullback
    put(108, 108.3, 104.8, 105)                                 # c1 red
    put(105.3, 105.6, 103, 105.1)                               # c2 = Spring, low 103 in the FVG
    prev = 105.1
    go(126, 10)
    go(118, 10)
    return rows


K.store_save('DDD', {'v': 1, 'sym': 'DDD', 'm15': [], 'day': craft(), 'h4': []})
K.backtest_pass(set(), upto, {}, out=lambda m: None)
mine = L.run_job({'tf': 'D', 'group': 'fvg', 'maxRisk': 0, 'structure': 'only', 'pivotN': 2, 'downN': 3, 'targetMode': 'swing', 'swingMinR': 1})
symc, scol, tcol, gcol = (L.TRADE_COLS.index(c) for c in ('sym', 'stage', 'struct', 'target'))
dd = [r for r in mine['trades'] if r[symc] == 'DDD']
assert len(dd) == 1 and dd[0][scol] == 'below' and dd[0][tcol].startswith('CHoCH 111.30 on ') and '3 lower highs / lows, final low 99.70' in dd[0][tcol], dd
assert abs(dd[0][gcol] - 117.3) < 0.01, 'target = the rally peak, the last swing high above the entry'
assert L.run_job({'tf': 'D', 'group': 'fvg', 'maxRisk': 0, 'structure': 'only', 'pivotN': 2, 'downN': 4})['trades'] == [] or \
    all(r[symc] != 'DDD' for r in L.run_job({'tf': 'D', 'group': 'fvg', 'maxRisk': 0, 'structure': 'only', 'pivotN': 2, 'downN': 4})['trades']), \
    'only 3 lower highs / lows on DDD'
assert all(r[symc] != 'DDD' for r in L.run_job({'tf': 'D', 'group': 'fvg', 'maxRisk': 0, 'structure': 'only', 'pivotN': 2, 'zoneWhen': 'after'})['trades']), \
    'its FVG formed in the CHoCH move, not after it'

# 'show' labels every trade, 'only' keeps the setup; the per-stage figures add up
other = lambda r: sum(v for k, v in r['skipped'].items() if k != 'struct')
show = L.run_job({'tf': 'D', 'group': 'entry', 'maxRisk': 0, 'structure': 'show', 'downN': 1, 'pivotN': 2})
base_e = L.run_job({'tf': 'D', 'group': 'entry', 'maxRisk': 0})
assert show['tradesTotal'] == base_e['tradesTotal'] and show['skipped']['struct'] == 0, 'show = label only'
assert {r[scol] for r in show['trades']} <= set(S.STAGES) and {'below', 'none'} <= {r[scol] for r in show['trades']}
assert all((r[tcol] == '') == (r[scol] == 'none') for r in show['trades'])
assert sum(x['trades'] + x['open'] for x in show['stages']) == show['tradesTotal'], show['stages']
assert [x['stage'] for x in show['stages']] == [k for k in S.STAGES if any(x['stage'] == k for x in show['stages'])]
assert show['stages'][0]['name'].startswith('Below the CHoCH level')
only = L.run_job({'tf': 'D', 'group': 'entry', 'maxRisk': 0, 'structure': 'only', 'downN': 1, 'pivotN': 2})
assert 0 < only['tradesTotal'] < show['tradesTotal'] and only['tradesTotal'] + only['skipped']['struct'] + other(only) == show['tradesTotal'] + other(show)
assert {r[scol] for r in only['trades']} == {'below'} and sum(only['structWhy'].values()) == only['skipped']['struct']
assert set(only['structWhy']) <= set(L.STRUCT_WHY), only['structWhy']
n_below = sum(x['trades'] + x['open'] for x in show['stages'] if x['stage'] == 'below')
assert only['tradesTotal'] == n_below, (only['tradesTotal'], n_below)
loose = L.run_job({'tf': 'D', 'group': 'entry', 'maxRisk': 0, 'structure': 'only', 'downN': 1, 'pivotN': 2, 'belowChoch': False, 'firstPull': False})
assert loose['tradesTotal'] >= only['tradesTotal'] and {r[scol] for r in loose['trades']} <= {'below', 'above', 'bos'}
# the swing-high target: the most recent swing high at least swingMinR R above the entry, the trade's target
sw = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'targetMode': 'swing', 'swingMinR': 1, 'after': 'fixed', 'cost': 0})
ecol, stc, rc = L.TRADE_COLS.index('entry'), L.TRADE_COLS.index('stop'), L.TRADE_COLS.index('reason')
assert sw['tradesTotal'] > 0 and sw['skipped']['noswing'] > 0, sw['skipped']
assert all(r[gcol] >= r[ecol] + (r[ecol] - r[stc]) * 0.999 for r in sw['trades']), 'at least 1R above'
assert all(abs(r[L.TRADE_COLS.index('exit')] - r[gcol]) < 0.011 for r in sw['trades'] if r[rc] == 'target')
assert len(L._STRUCT['map']) == 4, 'one structure per stock, kept for the next run'

# ------------------------------------------------------------------ 11. the daily scan's live CHoCH + FVG rows (owner, 10-Nov-2026)
def craft5(after=()):
    """3 lower highs / lows with 5-candle swings, a CHoCH rally with an FVG in it, the first pullback with a Spring in it."""
    rows, prev = [], 165.0
    d0 = date(2026, 3, 2)

    def put(o, h, l, c):
        rows.append([(d0 + timedelta(days=len(rows))).isoformat(), round(o, 2), round(h, 2), round(l, 2), round(c, 2), 900000])

    def go(to, k=6):
        nonlocal prev
        for x in leg(prev, to, k):
            put(prev, max(prev, x) + 0.3, min(prev, x) - 0.3, x)
            prev = x
    for to in (150, 160, 142, 152, 134, 144, 126, 136, 120):   # highs 160 > 152 > 144 > 136, lows 150 > 142 > 134 > 126 > 120
        go(to)
    put(120, 121.3, 119.7, 121)                                 # A
    put(121, 130.3, 120.7, 130)                                 # B
    put(130, 133.3, 126.5, 133)                                 # C: FVG 121.3 - 126.5
    put(133, 138.3, 132.7, 138)                                 # D: closes above the last lower high 136.3 = CHoCH
    prev = 138
    go(146, 3)
    go(128, 6)                                                  # the first pullback
    put(128, 128.3, 124.8, 125)                                 # c1 red
    put(125.3, 125.6, 123, 125.1)                               # c2 = the Spring, low 123 in the FVG
    prev = 125.1
    for o, h, l, c in after:
        put(o, h, l, c)
        prev = c
    go(150, 8)
    return rows


rows5 = craft5()
spring_day = rows5[-9][0]
upto5 = date.fromisoformat(rows5[-1][0])
since5 = (date.fromisoformat(spring_day) - timedelta(days=1)).isoformat()
res5 = K.analyse({'sym': 'EEE', 'day': rows5, 'm15': [], 'h4': []}, since5, upto5, set(), ('D',), ())
ch_items = [x for x in res5['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert len(ch_items) == 1 and ch_items[0]['candle'] == spring_day, [(x['pattern'], x['candle']) for x in res5['items']]
it5 = ch_items[0]
assert it5['note'].startswith('Spring · CHoCH ') and 'after 3 lower highs / lows · first pullback' in it5['note'], it5['note']
assert it5['zone'][:2] == [121.3, 126.5] and it5['zone'][3] == 'FVG', it5['zone']
import re
assert not re.search(r'\d\.\d', re.sub(r' · zone [\d.]+% tall$', '', it5['note'])), 'no prices in the note (the website shows it): ' + it5['note']
assert re.search(r' · zone [\d.]+% tall$', it5['note']), 'the zone size (a %, not a price) for the website\'s size rule'
assert any(x['pattern'] == 'Spring in FVG' and x['candle'] == spring_day for x in res5['items']), 'the plain Spring in FVG row stays too'
# only from the new sessions: a later scan does not send it again
assert not [x for x in K.analyse({'sym': 'EEE', 'day': rows5, 'm15': [], 'h4': []}, spring_day, upto5, set(), ('D',), ())['items']
            if x['pattern'] == K.CHOCH_PATTERN]
# a later close under the Spring candle's low (123): not sent, and listed as invalid for the sheet (within KEEP_DAYS)
rows_b = craft5(after=[(125.1, 125.5, 121.8, 122.0)])
res_b = K.analyse({'sym': 'EEE', 'day': rows_b, 'm15': [], 'h4': []}, since5, date.fromisoformat(rows_b[-1][0]), set(), ('D',), ())
assert not [x for x in res_b['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert {'tf': 'D', 'candle': spring_day, 'pattern': K.CHOCH_PATTERN} in res_b['invalid'], res_b['invalid']
# the PC's rule = the Lab's default setup (the same structure.py)
assert (K.CHOCH_PIVOT_N, K.CHOCH_DOWN_N) == (L.DEFAULTS['pivotN'], L.DEFAULTS['downN']) and K.RULES_VERSION == 6

# ------------------------------------------------------------------ 12. the candle cache after an update (owner, 11-Nov-2026:
# "backtest for some setups is loading only. sheet feed error" - the first run after the update built the cache for 20+
# minutes without a word, the sheet called it stopped and refused every other run meanwhile)
K.backtest_pass(set(), upto, {}, out=lambda m: None)
full_meta, _ = L.load_meta()
ticks = []
K.backtest_pass(set(), upto, {}, out=lambda m: None, lab_only=True, tick=lambda k, t: ticks.append((k, t)))
fast_meta, _ = L.load_meta()
assert fast_meta['signals'] == full_meta['signals'] and fast_meta['index'] == full_meta['index'], 'the Lab-only build = the full pass'
assert ticks and ticks[-1][0] == ticks[-1][1] == len(ticks), ticks
# the worker makes a missing / outdated cache right away, before taking a run, and tells the page how far it is
shutil.rmtree(L.LAB_DIR)
L.BUILD_SAY_S = 0
made = []


def build_new(out, tick=None):
    made.append(1)
    return K.lab_build_cache(out, set(), tick=tick)


w = L.LabWorker()
w.build = build_new
api = FakeSheet([{'id': 'L9', 'name': 'after the update', 'params': {'tf': 'D', 'group': 'spring', 'maxRisk': 0}}])
w.loop({}, api, rounds=1)
ops = [c['op'] for c in api.calls]
assert made == [1] and ops[0] == 'hello' and ops.index('poll') > ops.index('hello'), ops
hellos = [c for c in api.calls if c['op'] == 'hello']
assert 'preparing the candles on the laptop after an update' in hellos[0]['note'] and ' of ' in hellos[0]['note'], hellos[0]
assert hellos[-1]['note'] == '', 'the note is cleared when the cache is ready'
assert any(c['op'] == 'result' and c['id'] == 'L9' for c in api.calls) and not any(c['op'] == 'fail' for c in api.calls)
w.loop({}, FakeSheet([]), rounds=1)
assert made == [1], 'a cache is there: not made again'
# a run taken while there is no cache: the build's progress goes to the run (it keeps the run alive on the sheet)
shutil.rmtree(L.LAB_DIR)
api = FakeSheet([])
w.run_one({}, api, {'id': 'L10', 'params': {'tf': 'D', 'group': 'spring', 'maxRisk': 0}})
prog = [c for c in api.calls if c['op'] == 'progress']
assert prog and 'can take 10-30 minutes' in prog[0]['note'] and any(' of ' in c['note'] for c in prog), prog
assert all(1 <= c['pct'] <= 99 for c in prog) and any(c['op'] == 'result' for c in api.calls), api.calls
# an older kind of build function (no progress): still works
shutil.rmtree(L.LAB_DIR)
w.build = lambda out: K.lab_build_cache(out, set())
w.loop({}, FakeSheet([]), rounds=1)
assert L.load_meta()[0], 'the cache is made'

# ------------------------------------------------------------------ 13. the discount zone + every zone's first touch + the zone-top
# entry (owner, 11-Nov-2026, SUPREMEIND: "instead of taking the trade in FVG zone below the Choch, our backtest took the trade
# above the choch. we always try to enter with low risk, i.e. the zone in discount area. it is ok even the zone have some
# area slightly above the Choch"; answers: under the 50 % line of the move, the first return to that zone = the signal even
# when a newer FVG formed above it, the entry at the zone top or the touch candle's close - both)
# the move high: = max(high[final low .. i-1]) whichever order the candles are asked in
for seed in range(4):
    w = walk(300 + seed, 600)
    hh, ll, cc = [r[2] for r in w], [r[3] for r in w], [r[4] for r in w]
    stw = S.Structure(hh, ll, cc, 3)
    rnd = random.Random(seed)
    for k, e in enumerate(stw.events):
        asks = sorted(rnd.sample(range(e[0] + 1, len(cc)), min(12, len(cc) - e[0] - 1)))
        asks = asks + [asks[0]] if asks else asks        # an earlier candle again: from the start
        for i in asks:
            assert stw.move_high(k, hh, i) == max(hh[e[3]:i]), (seed, k, i)
assert S.depth(150, 100, 125) == 0.5 and S.depth(150, 100, 150) == 0 and S.depth(150, 100, 100) == 1 and S.depth(100, 100, 90) is None
assert S.fib_line(150, 100, 0.618) == 150 - 0.618 * 50 and S.zone_part(10, 20, 'mid', 0) == 15 and S.zone_part(10, 20, 'top', 0) == 20 \
    and S.zone_part(10, 20, 'bottom', 0) == 10 and S.zone_part(None, None, 'mid', 7) == 7


def craft6(big=False):
    """SUPREMEIND-like: 3 lower highs / lows (5-candle swings), the CHoCH move with an FVG low in it (121.3 - 126.5, the
    discount), the rally on with a second FVG ABOVE the CHoCH level (139.3 - 145.0, the premium), the peak 156.3, then the
    pullback: first into the premium FVG, on into the discount FVG (big = one red candle through both at once), a Spring."""
    rows, prev = [], 165.0
    d0 = date(2026, 3, 2)

    def put(o, h, l, c):
        rows.append([(d0 + timedelta(days=len(rows))).isoformat(), round(o, 2), round(h, 2), round(l, 2), round(c, 2), 900000])

    def go(to, k=6):
        nonlocal prev
        for x in leg(prev, to, k):
            put(prev, max(prev, x) + 0.3, min(prev, x) - 0.3, x)
            prev = x
    for to in (150, 160, 142, 152, 134, 144, 126, 136, 120):
        go(to)
    put(120, 121.3, 119.7, 121)                                 # A
    put(121, 130.3, 120.7, 130)                                 # B
    put(130, 133.3, 126.5, 133)                                 # C: FVG 121.3 - 126.5 (in the CHoCH move, the discount)
    put(133, 138.3, 130.0, 138)                                 # D: closes above the last lower high 136.3 = CHoCH
    put(138, 139.3, 133.0, 139)                                 # E
    put(139, 148.3, 138.7, 148)                                 # F
    put(148, 151.3, 145.0, 151)                                 # G: FVG 139.3 - 145.0 above the CHoCH level (premium)
    prev = 151
    go(156, 3)                                                  # the move high 156.3: the 50 % line = 138.0
    go(147, 3)
    if big:
        put(147, 147.3, 124.8, 125.5)                           # one candle through the premium FVG into the discount FVG
        prev = 125.5
    else:
        put(147, 147.3, 143.0, 144)                             # the first touch of the premium FVG
        prev = 144
        go(128, 6)
        put(128, 128.3, 124.8, 125)                             # the first touch of the discount FVG
        prev = 125
    put(125.3, 125.6, 123, 125.1)                               # a Spring in it
    prev = 125.1
    go(160, 8)
    return rows


r6, r6b = craft6(), craft6(big=True)
day6 = {r[0]: k for k, r in enumerate(r6)}
t_prem = next(k for k, r in enumerate(r6) if r[3] == 143.0)
t_disc = next(k for k, r in enumerate(r6) if r[3] == 124.8)
K.store_save('SUP', {'v': 1, 'sym': 'SUP', 'm15': [], 'day': r6, 'h4': []})
K.store_save('SUB', {'v': 1, 'sym': 'SUB', 'm15': [], 'day': r6b, 'h4': []})
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)
meta6, _ = L.load_meta()
zrows = [r for r in meta6['signals']['D']['SUP'] if r[1] == 'Z']
assert [(r[0], r[2], r[3]) for r in zrows if r[0] in (t_prem, t_disc)] == [(t_prem, 139.3, 145.0), (t_disc, 121.3, 126.5)], zrows
assert not [r for r in meta6['signals']['D']['SUP'] if r[1] == 'T' and r[0] == t_disc], 'not the newest FVG: no FVG First Touch there'
big_rows = [r for r in meta6['signals']['D']['SUB'] if r[1] == 'Z' and r[3] in (145.0, 126.5)]
assert len(big_rows) == 2 and big_rows[0][0] == big_rows[1][0] and big_rows[0][3] == 145.0, 'one candle, both zones, the higher top first'
SMC6 = {'tf': 'D', 'group': 'touch', 'maxRisk': 0, 'structure': 'only', 'pivotN': 5, 'downN': 3, 'zoneWhen': 'both', 'belowChoch': False,
        'firstPull': True, 'discount': 0.5, 'discPart': 'mid', 'stop': 'zone', 'cost': 0}
sym6, sig6, ent6, st6, stage6, struct6, zone6 = (L.TRADE_COLS.index(c) for c in ('sym', 'signal', 'entry', 'stop', 'stage', 'struct', 'zone'))
lab6 = lambda **kw: [r for r in L.run_job(dict(SMC6, **kw))['trades'] if r[sym6] in ('SUP', 'SUB')]
mine6 = lab6(entry='zone')
sup = [r for r in mine6 if r[sym6] == 'SUP']
assert len(sup) == 1 and sup[0][sig6] == r6[t_disc][0] and sup[0][ent6] == 126.5 and abs(sup[0][st6] - round(121.3 * 0.995, 2)) < 0.006, sup
assert sup[0][stage6] == 'disc' and sup[0][zone6] == 'FVG zone touch', sup
assert 'CHoCH 136.30 on ' in sup[0][struct6] and 'move high 156.30' in sup[0][struct6] and 'zone middle 89% down the move (50% line 138.00)' in sup[0][struct6], sup[0][struct6]
assert lab6(entry='close')[0][ent6] == 125.0, 'the touch candle\'s close'
# one candle through both zones: the premium one fails the discount rule, the discount one is the trade (one a candle)
sub = [r for r in mine6 if r[sym6] == 'SUB']
assert len(sub) == 1 and sub[0][ent6] == 126.5 and abs(sub[0][st6] - round(121.3 * 0.995, 2)) < 0.006, sub
# no discount rule: the premium zone's touch is taken first (what the SUPREMEIND run did); 'show' labels it premium
loose6 = [r for r in lab6(discount=0, zonePick='every') if r[sym6] == 'SUP']
assert [r[sig6] for r in loose6][-1] == r6[t_prem][0] and len(loose6) == 2, loose6
# the owner's 2nd-zone rule (12-Nov-2026: "No trade only on 2nd FVG. 1st FVG can be watched but not to be traded"): with both
# zones counting (no discount rule) the higher one is only watched, the trade is the 2nd; with the discount rule only one counts
zn6 = L.TRADE_COLS.index('zn')
run2 = L.run_job(dict(SMC6, discount=0))
two6 = [r for r in run2['trades'] if r[sym6] == 'SUP']
assert len(two6) == 1 and two6[0][sig6] == r6[t_disc][0] and two6[0][zn6] == 2 and run2['structWhy'].get('zone1', 0) >= 1, (two6, run2['structWhy'])
assert sup[0][zn6] == 1 and L.DEFAULTS['zonePick'] == 'second', 'the premium zone does not count - the discount one is the only one'
show6 = L.run_job(dict(SMC6, structure='show'))
lab_st = {r[sig6]: r[stage6] for r in show6['trades'] if r[sym6] == 'SUP'}
assert lab_st[r6[t_prem][0]] == 'prem' and lab_st[r6[t_disc][0]] == 'disc', lab_st
assert {x['stage'] for x in show6['stages']} >= {'disc', 'prem'} and show6['stages'][0]['stage'] == 'disc'
only6 = L.run_job(dict(SMC6))
assert only6['structWhy'].get('premium', 0) >= 1, only6['structWhy']
# discPart top: the whole zone under the line; bottom: any part
assert [r[sym6] for r in lab6(discount=0.95, discPart='bottom')] == [] or all(r[sym6] != 'SUP' for r in lab6(discount=0.95, discPart='mid'))
# the zone-top entry: first-touch signals only; a Spring row is skipped ('zoneentry')
zs = L.run_job({'tf': 'D', 'group': 'fvg', 'maxRisk': 0, 'entry': 'zone'})
assert zs['tradesTotal'] == 0 and zs['skipped']['zoneentry'] > 0, zs['skipped']

# simulate with the zone-top entry (handmade): the zone 95 - 99, stop 95 x 0.995 = 94.525
ZROW = [1, 'Z', 95.0, 99.0, 't', 1, 0, 50.0, 0]
zbase = [cdl(0, 100, 101, 99.5, 100.5)]


def zrun(c1, path=(), row=ZROW, **kw):
    cs = cache_of({'X': (zbase + [c1] + list(path), [row])})['X']
    return L.simulate(cs, row, P(cost=0, entry='zone', **kw))


t, _ = zrun(cdl(1, 101, 101.5, 97, 98), [cdl(2, 98, 112, 97.5, 111)], after='fixed')
assert t['entry'] == 99 and t['reason'] == 'target' and t['R'] == 2.0, t          # bought at the top 99, 2R = 107.95
t, _ = zrun(cdl(1, 98, 98.5, 96, 97))
assert t['entry'] == 98, 'opened under the top: filled at the open'
t, _ = zrun(cdl(1, 101, 101.5, 94, 95))
assert t['reason'] == 'stop' and t['exit'] == 94.525 and t['days'] == 0 and t['R'] == -1.0, 'the entry candle went under the stop after the fill'
t, why = zrun(cdl(1, 94, 96, 93, 95))
assert t is None and why == 'gap', 'opened under the stop: no trade'
t, _ = zrun(cdl(1, 101, 101.5, 97, 109), after='fixed')
assert t['reason'] == 'target' and t['days'] == 0 and round(t['exit'], 2) == 107.95, 'closed above the target on the entry candle'
t, _ = zrun(cdl(1, 101, 101.5, 97, 98), stop='spring', stopBuf=0)
assert t['stop'] == 95, 'with the zone-top entry the stop goes under the zone (the candle\'s low is not known at the fill)'
t, why = zrun(cdl(1, 101, 101.5, 97, 98), row=[1, 'F', 95.0, 99.0, 't', 1, 0, 50.0, 0])
assert t is None and why == 'zoneentry'
assert P(entry='zone')['entry'] == 'zone' and P(discount=0.5, discPart='top')['discount'] == 0.5 and P(discount=7)['discount'] == 1 \
    and P(discPart='x')['discPart'] == 'mid' and P(group='touch')['group'] == 'touch'

# the daily scan's live CHoCH + FVG rows follow the same rule: the discount zone's first touch (and the Spring in it),
# never the premium one
res6 = K.analyse({'sym': 'SUP', 'day': r6, 'm15': [], 'h4': []}, r6[t_prem - 1][0], date.fromisoformat(r6[-1][0]), set(), ('D',), ())
ch6 = [x for x in res6['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert [x['candle'] for x in ch6] == [r6[t_disc][0], r6[t_disc + 1][0]], [(x['candle'], x['note']) for x in ch6]
assert ch6[0]['note'].startswith('Zone first touch · CHoCH ') and '· first pullback · zone middle 89% down the move · zone ' in ch6[0]['note'], ch6[0]['note']
assert ch6[1]['note'].startswith('Spring · CHoCH ') and ch6[0]['zone'][:2] == [121.3, 126.5], ch6
assert not re.search(r'\d\.\d', re.sub(r' · zone [\d.]+% tall$', '', ch6[0]['note']))
# ... and while price has not come back yet the setup is WAITING (owner, 12-Nov-2026, IREDA: the CHoCH formed, the
# discount zone below, no touch yet): the discount FVG (not the premium one above the 50 % line), until its first touch
full6 = K.daily_candles(r6)
for upto6, dist6 in ((t_prem - 1, 13.95), (t_prem, 12.15), (t_disc - 1, 1.17)):
    w6 = K.choch_waiting(full6[:upto6 + 1], full6[:upto6 + 1], 'D')
    assert w6 and w6['zone'] == [121.3, 126.5, next(r[0] for r in r6 if r[3] == 126.5), 'FVG'], w6
    assert (w6['level'], w6['d'], w6['low'], w6['high'], w6['fib'], w6['depth'], w6['dist'], w6['more']) == (136.3, 3, 119.7, 156.3, 138.0, 89, dist6, 0), w6
    assert w6['choch'] == r6[next(k for k, r in enumerate(r6) if r[3] == 130.0 and r[4] == 138)][0] and w6['last'] == r6[upto6][0]
assert K.choch_waiting(full6[:t_disc + 1], full6[:t_disc + 1], 'D') is None, 'touched: now a CHoCH + FVG row, no longer waiting'
assert K.choch_waiting(full6, full6, 'D') is None, 'after the BOS: nothing waiting'
# the daily scan sends it (analyse 'waiting') - the scan of the session before the premium touch
res6w = K.analyse({'sym': 'SUP', 'day': r6[:t_prem], 'm15': [], 'h4': []}, r6[t_prem - 2][0], date.fromisoformat(r6[t_prem - 1][0]), set(), ('D',), ())
assert [(x['tf'], x['zone'][:2], x['dist']) for x in res6w['waiting']] == [('D', [121.3, 126.5], 13.95)], res6w['waiting']
sent6 = []
K.send_waiting({}, lambda cfg, action, body, **kw: sent6.append((action, body)) or {'ok': True, 'kept': len(body['rows'])},
               date.fromisoformat(r6[t_prem - 1][0]), [dict(res6w['waiting'][0], sym='SUP'), dict(res6w['waiting'][0], sym='AAA', dist=2.5)])
assert sent6[0][0] == 'intraday' and sent6[0][1]['op'] == 'waiting' and [r['sym'] for r in sent6[0][1]['rows']] == ['AAA', 'SUP'], sent6
assert sent6[0][1]['fib'] == 0.5 and sent6[0][1]['pivotN'] == 5 and sent6[0][1]['downN'] == 3
NEW6 = {'zoneMin': 0.0, 'zoneMax': 0.0, 'lineTol': 0.5, 'fibLevel': 0.618, 'fibTol': 1.0, 'gapEntry': True, 'lineOk': False,
        'darkCloud': 'any', 'fibPat': 'off', 'zonePick': 'second', 'touchAgain': True}       # the 12-Nov-2026 refinements' defaults
assert sent6[0][1]['choch'] == dict({'pivotN': 5, 'downN': 3, 'fib': 0.5, 'part': 'mid', 'zoneWhen': 'both'}, **NEW6)
# the daily scan's CHoCH rules from config.json (owner, 12-Nov-2026: "Build 2" - ChochRules.bat, the same as his Lab / TradingView)
D6 = K.choch_rules()
assert D6 == dict({'pivotN': 5, 'downN': 3, 'fib': 0.5, 'part': 'mid', 'zoneWhen': 'both'}, **NEW6) and K.choch_rules({}) == D6
mine6r = K.choch_rules({'choch_swing_candles': 10, 'choch_lower_highs': 4, 'choch_fib': 0.382, 'choch_zone_part': 'top', 'choch_zone_when': 'leg'})
assert mine6r == dict({'pivotN': 10, 'downN': 4, 'fib': 0.382, 'part': 'top', 'zoneWhen': 'leg'}, **NEW6), mine6r
assert K.choch_rules({'choch_swing_candles': 99, 'choch_lower_highs': True, 'choch_fib': 1.5, 'choch_zone_part': 'x', 'choch_zone_when': 2}) == D6
assert K.choch_rules_words(D6) == "swings of 5 candles, at least 3 lower highs / lows, the zone's middle at least 50% down the move, the zone formed in the CHoCH move or after it, the 2nd discount zone when the move has two (the 1st only watched)"
assert K.choch_rules_words(mine6r) == "swings of 10 candles, at least 4 lower highs / lows, the zone's top at least 38.2% down the move, the zone formed only in the CHoCH move, the 2nd discount zone when the move has two (the 1st only watched)"
w_at = full6[:t_prem]
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, part='top'))['depth'] == 81, 'the zone top 126.50: 81% down the move'
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, downN=4)) is None, 'only 3 lower highs / lows on this chart'
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, fib=0.9)) is None, 'the zone middle is 89% down: not 90%'
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, zoneWhen='after')) is None, 'the zone formed before the CHoCH candle'
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, zoneWhen='leg'))['zone'][:2] == [121.3, 126.5], 'in the CHoCH move'
for rr6, n6 in ((dict(D6, part='top'), 2), (dict(D6, downN=4), 0), (dict(D6, fib=0.9), 0), (dict(D6, zoneWhen='after'), 0)):
    got6 = [x for x in K.analyse({'sym': 'SUP', 'day': r6, 'm15': [], 'h4': []}, r6[t_prem - 1][0], date.fromisoformat(r6[-1][0]), set(), ('D',), (),
                                 choch=rr6)['items'] if x['pattern'] == K.CHOCH_PATTERN]
    assert len(got6) == n6, (rr6, [(x['candle'], x['note']) for x in got6])
    if n6:
        assert '· first pullback · zone top 81% down the move · zone ' in got6[0]['note'], got6[0]['note']
# ChochRules.bat: Enter keeps a value, a bad answer is asked again; config.json gets the five keys
answers = iter(['', '4', '0.6', '0.618', '9', '2', '2'] + [''] * 8)
saved6 = {}
assert K.choch_setup({'url': 'x'}, lambda c: saved6.update(c), ask=lambda q: next(answers)) == 0
assert K.choch_rules(saved6) == dict({'pivotN': 5, 'downN': 4, 'fib': 0.618, 'part': 'top', 'zoneWhen': 'leg'}, **NEW6) and saved6['url'] == 'x', saved6
# ... and the refinements of 12-Nov-2026: zone size 2 - 8 %, the FVG top, the CHoCH-line rule (+1 %), dark clouds left out,
# the Fib + pattern entry in big zones at the 61.8 % line +/- 1.5 %
answers = iter([''] * 5 + ['2', '2', '2', '8', '2', '2', '1', '2', '2', '', '1.5'])
saved7 = {}
assert K.choch_setup({}, lambda c: saved7.update(c), ask=lambda q: next(answers)) == 0
r7 = K.choch_rules(saved7)
assert (r7['zoneMin'], r7['zoneMax'], r7['gapEntry'], r7['lineOk'], r7['lineTol'], r7['darkCloud'], r7['fibPat'], r7['fibLevel'], r7['fibTol'],
        r7['zonePick'], r7['touchAgain']) == (2.0, 8.0, False, True, 1.0, 'exclude', 'big', 0.618, 1.5, 'every', False), r7
assert saved7['choch_zone_pick'] == 'every'
assert saved7['choch_zone_max_pct'] == 8.0 and saved7['choch_dark_cloud'] == 'exclude' and saved7['choch_gap_entry'] is False
assert K.choch_rules_words(r7).endswith(", zone size 2 - 8%, the whole FVG (not the Gap-up zone inside it), or the zone top at / under the CHoCH level (+1%), "
                                        "dark-cloud FVGs left out, big zones: a Spring / Harami + Inverted Hammer at the zone's 61.8% line, "
                                        "every discount zone, a zone touched before the CHoCH does not count again"), K.choch_rules_words(r7)
assert K.choch_rules({'choch_zone_max_pct': 500, 'choch_dark_cloud': 'x', 'choch_gap_entry': 1, 'choch_fib_pattern': 'some'}) == D6
# the zone size rule in the daily scan: the SUPREMEIND chart's zone is 4.3 % tall
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, zoneMax=3)) is None and K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, zoneMin=5)) is None
wz = K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, zoneMin=2, zoneMax=8))
assert wz and wz['pct'] == 4.29 and wz['buy'] == 126.5 and wz['stopAt'] == 121.3 and wz['how'] == 'buy order at the zone top', wz
assert K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, darkCloud='only')) is None, 'not a dark-cloud FVG'
wf = K.choch_waiting(w_at, w_at, 'D', rules=dict(D6, fibPat='all'))
assert wf and wf['buy'] == round(126.5 - 0.618 * 5.2, 2) and 'at the zone\'s 61.8% line' in wf['how'], wf
# the scan is due again when the rules change (and rescans the last sessions), not when they stay
up6 = date.fromisoformat(r6[-1][0])
st6 = {'scanned': '2999-01-01', 'tfs': K.chosen_tfs({}), 'slots': K.chosen_slots({}), 'rules': K.RULES_VERSION}
kc6 = {'kite_api_key': 'abcdef', 'kite_api_secret': 'abcdefghijkl'}
assert K.due(kc6, set(), state=dict(st6))[0] is False, 'an older state (no choch) = the defaults'
assert K.due(dict(kc6, choch_lower_highs=4), set(), state=dict(st6))[0] is True
assert K.due(dict(kc6, choch_lower_highs=4), set(), state=dict(st6, choch=K.choch_rules({'choch_lower_highs': 4})))[0] is False

# ------------------------------------------------------------------ 14. the charts PDF (owner, 12-Nov-2026: "a PDF should come with
# it - a chart for every trade, with the swings, CHoCH, FVG area, target and stop loss ... like the TradingView view";
# choices: the laptop folder only, every trade, the losing ones first). Then two pages a trade (owner, 12-Nov-2026: "show market
# structure in the chart according to the setup like LL, LH, HL, HH, BoS, Choch, FVG Zone, buy. these words should not
# overwrited on the candle and price movement. Use 2 slides for each setup. one for chart. 2 slide for why you took this
# trade. reason for hitting stoploss")
import lab_charts as LC
import zlib


def pdf_pages(path):
    """-> [[texts of the page] ...] in page order (Kids of object 2), after checking the xref offsets."""
    raw = open(path, 'rb').read()
    assert raw.startswith(b'%PDF-1.4') and raw.rstrip().endswith(b'%%EOF'), path
    start = int(raw.rsplit(b'startxref', 1)[1].split()[0])
    assert raw[start:start + 4] == b'xref'
    head, body = raw[start:].split(b'\n', 2)[1], raw[start:].split(b'\n', 2)[2]
    count = int(head.split()[1])
    offs = {}
    for k in range(count):
        row = body[k * 20:(k + 1) * 20]
        if row[17:18] == b'n':
            offs[k] = int(row[:10])
            assert raw[offs[k]:].startswith(b'%d 0 obj' % k), ('xref offset', k)

    def obj(k):
        return raw[offs[k]:raw.index(b'endobj', offs[k])]
    kids = [int(x) for x in re.findall(rb'(\d+) 0 R', obj(2).split(b'/Kids')[1].split(b']')[0])]
    pages = []
    for p in kids:
        c = int(re.search(rb'/Contents (\d+) 0 R', obj(p)).group(1))
        o = obj(c)
        data = zlib.decompress(o[o.index(b'stream\n') + 7:o.rindex(b'\nendstream')])
        pages.append([t.replace(b'\\(', b'(').replace(b'\\)', b')').decode('latin-1') for t in re.findall(rb'\(((?:\\.|[^\\)])*)\) Tj', data)])
    return pages


assert LC.money(1234567.5) == '12,34,567.50' and LC.money(-12.3) == '-12.30' and LC.money(999) == '999.00'
assert LC._pdf_str('a(b)c\\') == '(a\\(b\\)c\\\\)' and LC._pdf_str('x · y') == '(x \xb7 y)' and LC._pdf_str('₹ 5') == '(Rs  5)'
assert LC.safe_name('My/run: "x"') == 'My_run_ _x' and LC.safe_name('') == 'run'
# the owner's setup on the made SUPREMEIND chart: the discount FVG's first touch, its chart with the CHoCH and the 50 % line
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)     # (section 13's handmade cache replaced it)
smc_res = L.run_job(dict(SMC6, entry='zone'), charts=L.CHARTS_DIR, name='My (test) run')
info = smc_res['pdf']
assert info['file'].endswith(' My (test) run.pdf') and info['folder'] == 'lab_charts', info
assert info['pages'] == 2 * info['shown'] + 1 == 2 * smc_res['tradesTotal'] + 1 and info['trades'] == smc_res['tradesTotal'], (info, smc_res['tradesTotal'])
pages = pdf_pages(os.path.join(L.CHARTS_DIR, info['file']))
assert pages[0][0] == 'Backtest Lab - trade charts' and pages[0][1] == 'My (test) run' and any(t.startswith('Market structure: swings of 5') for t in pages[0])
assert any(t.startswith('Two pages a trade: 1 = the chart') for t in pages[0])
def head(pg):
    """(the page's title 'SYM  -  Daily  -  signal ...', its result text '-1.00R   Stop loss' / 'still open ...')."""
    k = next(k for k, t in enumerate(pg) if '  -  Daily  -  signal ' in t)
    return pg[k], pg[k + 1]


chart_pages, why_pages = pages[1::2], pages[2::2]
assert all(any(t.endswith('why this trade') for t in pg) for pg in why_pages) and not any(any(t.endswith('why this trade') for t in pg) for pg in chart_pages)
sup_k = [k for k, pg in enumerate(chart_pages) if head(pg)[0].startswith('SUP  -  Daily  -  signal ')]
assert len(sup_k) == 1, [head(pg)[0] for pg in chart_pages]
sup = [chart_pages[sup_k[0]]]
want = ['Entry 126.50', 'Stop %s' % LC.money(round(121.3 * 0.995, 2)), 'Zone top 126.50', 'Zone bottom 121.30', 'CHoCH 136.30', '50% 138.00', 'BUY', 'CHoCH',
        'FVG zone']
assert all(w in sup[0] for w in want), [w for w in want if w not in sup[0]]
assert any(w in sup[0] for w in LC.EXIT_WORD.values()), (head(sup[0]), sup[0])
assert any(t.endswith('final low') for t in sup[0]) and any(t.startswith('LL') for t in sup[0]) and any(t.startswith('LH') for t in sup[0]), sup[0]
assert any(t.startswith('CHoCH 136.30 on ') and '50% line 138.00' in t for t in sup[0]), 'the Lab\'s own structure words'
assert sup[0][-1].startswith('page ') and sup[0][-1].endswith(' of %d' % info['pages'])
# its page 2: plain sentences, no chart, no price list (owner, 12-Nov-2026: "why this trade should not numericals and with chart. it
# should be readable format like in sentences")
why = why_pages[sup_k[0]]
assert why[0].startswith('SUP  -  Daily  -  signal ') and why[0].endswith('why this trade') and why[-1] == 'page %d of %d' % (2 * sup_k[0] + 3, info['pages'])
for w in ('Why the backtest took this trade', 'How it ended', '1.', '2.', '3.', '4.', '5.', '6.', '7.'):
    assert w in why, (w, why)
joined = ' '.join(why)
for w in ('The stock was falling. It made 3 lower highs and 3 lower lows in a row', 'The fall ended at the final low on 24 Apr 2026. Your setup asks for at least 3.',
          'Then the trend changed. On 28 Apr 2026 the price closed above the last swing high. This is the CHoCH (change of character)',
          'the price left an FVG zone (a fair value gap', 'The rise went up to its high on 04 May 2026.', 'The zone sat in the cheaper lower part of that rise',
          'Your setup buys only when it is at least 50% down (the discount part)', 'On 15 May 2026 the price came back down to the zone for the first time since it formed.',
          'No new higher high (BOS) had come yet, so this was the first pullback after the CHoCH', 'The CHoCH was about 2 weeks before this trade.',
          'The plan: buy with an order waiting at the zone top, put the stop loss just under the zone bottom, and take the target at 2 times the risk (2R).'):
    assert w in joined, (w, joined)
body = ' '.join(why[2:-2])                         # not the title / result / footer
assert not re.search(r'\d+\.\d\d', body), ('no prices on page 2', re.findall(r'\d+\.\d\d', body))
assert not set(why) & {'H', 'LH', 'LL', 'BUY', 'zone', 'CHoCH'}, 'no chart on page 2'
# the swings the pages show = the ones the structure counted (choch_events' own list): for every CHoCH of random charts, the
# swings known by its candle give back its swing high and its count d - with every structure option
import random as _rnd
for seed in range(8):
    rr = _rnd.Random(seed)
    px, hh, ll, cc = 100.0, [], [], []
    for _ in range(900):
        o = px * (1 + rr.uniform(-0.03, 0.03)); c = o * (1 + rr.uniform(-0.05, 0.05))
        hh.append(round(max(o, c) * (1 + rr.uniform(0, 0.03)), 2)); ll.append(round(min(o, c) * (1 - rr.uniform(0, 0.03)), 2)); cc.append(round(c, 2)); px = c
    for n_, opts in ((2, None), (5, None), (3, {'prom': 1.0}), (3, {'swing': 'zigzag', 'zz': 2.0}), (3, {'choch': 'protected'})):
        st_ = S.Structure(hh, ll, cc, n_, opts)
        assert st_.events, (seed, n_, opts)
        for e in st_.events:
            b_, hi_, lvl_, li_, lf_, d_ = e
            sb = LC.swing_seq(st_, upto=b_)
            q = max(x for x in range(len(sb)) if sb[x][2] and sb[x][0] == hi_)
            assert sb[q][1] == lvl_
            dh, k_ = 0, q
            while k_ - 2 >= 0 and sb[k_][1] < sb[k_ - 2][1]:
                dh, k_ = dh + 1, k_ - 2
            dl, prev, k_ = 0, lf_, q - 1
            while k_ >= 0 and prev < sb[k_][1]:
                dl, prev, k_ = dl + 1, sb[k_][1], k_ - 2
            assert min(dh, dl) == d_, (seed, n_, opts, e, dh, dl)
        tags = LC.swing_tags(LC.swing_seq(st_))
        assert set(tags) <= {'H', 'L', 'HH', 'LH', 'HL', 'LL', 'EQH', 'EQL'} and {'HH', 'LH', 'HL', 'LL'} <= set(tags)
assert LC.swing_tags([[1, 10, True, 2], [3, 5, False, 4], [5, 12, True, 6], [7, 4, False, 8], [9, 11.9, True, 10], [11, 4.05, False, 12]],
                     lambda p: 0.1) == ['H', 'L', 'HH', 'LL', 'EQH', 'EQL']

# every trade of a bigger run, the losing ones first, newest first in each group, the open ones last
LC.WATCH = []
big = L.run_job({'tf': 'D', 'group': 'touch', 'maxRisk': 0, 'structure': 'off'}, charts=L.CHARTS_DIR, name='every touch')
watched, LC.WATCH = LC.WATCH, None
allpg = pdf_pages(os.path.join(L.CHARTS_DIR, big['pdf']['file']))[1:]
pg = allpg[0::2]
assert len(pg) == big['tradesTotal'] > 20 and len(allpg) == 2 * len(pg), (len(pg), big['tradesTotal'])
# no word on a candle, none on another word (owner: "these words should not overwrited on the candle and price movement")
assert len(watched) == len(pg)
nw, kinds = 0, set()
for ch_ in watched:
    xl, slot, spans = ch_.place.cols
    for k_, (txt, xa, xb, ya, yb, free) in enumerate(ch_.words):
        nw += 1
        kinds.add(txt.split(' ')[0])
        assert free, (txt, 'no free place')
        assert ch_.x0 <= xa and xb <= ch_.x1 and ch_.y0 <= ya and yb <= ch_.y1, (txt, 'inside the chart')
        for j in range(max(0, int((xa - xl) / slot)), min(len(spans) - 1, int((xb - xl) / slot)) + 1):
            assert not (spans[j][0] < yb and spans[j][1] > ya), (txt, 'on a candle', j)
        for txt2, xa2, xb2, ya2, yb2, _ in ch_.words[:k_]:
            assert not (xa < xb2 and xb > xa2 and ya < yb2 and yb > ya2), (txt, txt2, 'on another word')
assert nw > 10 * len(pg) and {'HH', 'HL', 'LH', 'LL', 'BUY', 'CHoCH', 'BOS', 'FVG', 'STOP'} <= kinds, (nw, len(pg), kinds)
# the stop-loss pages say why in sentences: how far it went up, a wick or a close under the stop, the candle, the zone, what
# price did after
stops = [w_ for c_, w_ in zip(allpg[0::2], allpg[1::2]) if head(c_)[1].endswith('Stop loss')]
sj = ' '.join(' '.join(w_) for w_ in stops)
assert stops and sj.count('The stop loss was hit on ') == len(stops) and 'a loss of about 1R' in sj
for alts in (('It did not go up at all after buying.', 'It went up only a little', 'not even one time the risk', 'It first went up about'),
             ('Only the wick went below the stop', 'The candle closed below the stop - a real break'),
             ('The fall came in one big candle', 'the volume was heavy', 'It was a normal-sized candle'),
             ('The zone did not hold', 'The price never closed below the zone before the stop.'),
             ('After the stop, the price turned up and reached the target on', 'After the stop, the price did not reach the target')):
    assert any(a_ in sj for a_ in alts), alts
groups = []
for p_ in pg:
    r = head(p_)[1]
    groups.append(2 if r.startswith('still open') else 0 if r.startswith('-') else 1)
assert groups == sorted(groups) and groups[0] == 0 and 1 in groups, groups
day = lambda p_: date(int(head(p_)[0].split()[-1]), ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'].index(head(p_)[0].split()[-2]) + 1,
                       int(head(p_)[0].split()[-3]))
for g in (0, 1):
    ds = [day(p_) for p_, gg in zip(pg, groups) if gg == g]
    assert ds == sorted(ds, reverse=True), (g, ds[:5])
# a page limit keeps the PDF small; the cover says how many
LC.MAX_TRADES, keep_max = 5, LC.MAX_TRADES
few = L.run_job({'tf': 'D', 'group': 'touch', 'maxRisk': 0, 'structure': 'off'}, charts=L.CHARTS_DIR, name='five')
LC.MAX_TRADES = keep_max
assert few['pdf']['pages'] == 11 and few['pdf']['shown'] == 5 and few['pdf']['trades'] == big['tradesTotal']
assert any('The first 5 of %d.' % big['tradesTotal'] in t for t in pdf_pages(os.path.join(L.CHARTS_DIR, few['pdf']['file']))[0])
# pdftoppm (when there) reads it - a real PDF reader
import shutil, subprocess
if shutil.which('pdftoppm'):
    out = os.path.join(TMP, 'pg')
    r = subprocess.run(['pdftoppm', '-r', '20', '-png', '-f', '1', '-l', '3', os.path.join(L.CHARTS_DIR, info['file']), out], capture_output=True)
    assert r.returncode == 0 and not r.stderr, r.stderr
# the folder keeps the newest KEEP_FILES PDFs
for k in range(LC.KEEP_FILES + 3):
    open(os.path.join(L.CHARTS_DIR, 'old %02d.pdf' % k), 'w').close()
LC.tidy(L.CHARTS_DIR)
assert len([f for f in os.listdir(L.CHARTS_DIR) if f.endswith('.pdf')]) == LC.KEEP_FILES
# the background worker makes it with every run (config "lab_charts": false = no PDF); a failure never stops the result
api = FakeSheet([{'id': 'L20', 'name': 'with charts', 'params': dict(SMC6)}])
L.LabWorker().loop({}, api, rounds=1)
sent = [c for c in api.calls if c['op'] == 'result'][0]['result']
assert sent['pdf']['file'].endswith(' with charts.pdf') and os.path.isfile(os.path.join(L.CHARTS_DIR, sent['pdf']['file']))
api = FakeSheet([{'id': 'L21', 'name': 'no charts', 'params': dict(SMC6)}])
L.LabWorker().loop({'lab_charts': False}, api, rounds=1)
assert 'pdf' not in [c for c in api.calls if c['op'] == 'result'][0]['result']
real = LC.trade_page
LC.trade_page = lambda *a, **k: 1 / 0
broken = L.run_job(dict(SMC6), charts=L.CHARTS_DIR, name='broken')
LC.trade_page = real
assert broken['pdf'].get('error') and broken['stats'] and not [f for f in os.listdir(L.CHARTS_DIR) if f.endswith('.tmp')]

# ------------------------------------------------------------------ 15. "real or chance?", the breakdowns, the dev / test split
# (owner, 12-Nov-2026, after a ChatGPT review of his run: zone depth 60-70 % weak / 70-90 % strong, 4 lower highs / lows better
# than 3, the CHoCH-to-signal lag; "yes do it")
import statistics
assert L._range([1.0]) == (None, None)
lo_, hi_ = L._range([1.0, -1.0, 2.0, 0.5])
m_, e_ = 0.625, 1.645 * statistics.stdev([1.0, -1.0, 2.0, 0.5]) / 2
assert abs(lo_ - (m_ - e_)) < 0.001 and abs(hi_ - (m_ + e_)) < 0.001
assert L._edge(29, 0.1, 0.5) == 'few' and L._edge(30, 0.1, 0.5) == 'real' and L._edge(30, -0.5, -0.1) == 'losing' and L._edge(30, -0.1, 0.3) == 'chance'
assert L._vs_rest([2.0, 2.5] * 20, [-1.0, -0.5] * 20) == 'better' and L._vs_rest([-1.0, -0.5] * 20, [2.0, 2.5] * 20) == 'worse'
assert L._vs_rest([1.0, -1.0] * 20, [1.1, -0.9] * 20) == 'chance' and L._vs_rest([2.0] * 29, [0.0, 1.0]) == 'few'


def ft(R, day, **kw):
    t = {'R': R, 'sigDay': date.fromisoformat(day).toordinal(), 'code': 'Z', 'inside': 0, 'where': 'b', 'touch': 1, 'riskPct': 3.0,
         'turn': 100.0, 'hit': R >= 2, 'ret': R * 3, 'days': 5, 'maxR': max(R, 0), 'ek': (date.fromisoformat(day).toordinal(), 0)}
    t.update(kw)
    return t


rnd15 = random.Random(15)
deep = [ft(rnd15.choice([2.5, 3.0, -1.0]), '20%02d-03-01' % (10 + k % 16), depth=0.8, lhll=4, lag=30) for k in range(60)]
shallow = [ft(rnd15.choice([-1.0, -1.0, 0.5]), '20%02d-06-01' % (10 + k % 16), depth=0.65, lhll=3, lag=5, where='t') for k in range(60)]
bd = {b['key']: b for b in L.breakdowns(deep + shallow, L.clean_params({}))}
assert 'zone' not in bd and 'touch' not in bd, 'one group only: no comparison'
dep = {r['label']: r for r in bd['depth']['rows']}
assert set(dep) == {'61.8 - 70.5%', '78.6 - 90%'} and dep['78.6 - 90%']['verdict'] == 'better' and dep['61.8 - 70.5%']['verdict'] == 'worse', dep
assert dep['78.6 - 90%']['trades'] == 60 and 'dev' not in dep['78.6 - 90%']
assert [r['label'] for r in bd['lhll']['rows']] == ['3', '4'] and [r['label'] for r in bd['lag']['rows']] == ['0 - 5 days', '21 - 40 days']
assert [r['label'] for r in bd['where']['rows']] == ['top half', 'to / under the bottom']
# with the split: each group in both periods, 'held' = it beat (trailed) the rest in both
P15 = L.clean_params({'testFrom': '2020-01-01'})
assert P15['testFrom'] == '2020-01-01' and L.clean_params({'testFrom': 'x'})['testFrom'] == ''
bd2 = {b['key']: b for b in L.breakdowns(deep + shallow, P15)}
d2 = {r['label']: r for r in bd2['depth']['rows']}
assert d2['78.6 - 90%']['held'] == 'yes' and d2['61.8 - 70.5%']['held'] == 'yes', d2
assert d2['78.6 - 90%']['dev']['trades'] + d2['78.6 - 90%']['test']['trades'] == 60 and d2['78.6 - 90%']['test']['trades'] == 20
flip = [ft(2.0 if day < '2020' else -1.0, day + '-03-01', depth=0.8) for day in ('2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2021', '2022', '2023', '2024')] * 3
flip2 = [ft(-1.0 if day < '2020' else 2.0, day + '-03-01', depth=0.65) for day in ('2012', '2013', '2014', '2015', '2016', '2017', '2018', '2019', '2021', '2022', '2023', '2024')] * 3
d3 = {r['label']: r for r in [b for b in L.breakdowns(flip + flip2, P15) if b['key'] == 'depth'][0]['rows']}
assert d3['78.6 - 90%']['held'] == 'no', 'better before 2020, worse after: it did not hold'
sp = L._split(deep + shallow, P15)
assert sp['at'] == '2020-01-01' and sp['dev']['trades'] + sp['test']['trades'] == 120 and sp['dev']['to'] < '2020-01-01' <= sp['test']['from']
assert sp['dev']['edge'] in ('real', 'chance', 'losing') and L._split(deep, L.clean_params({})) is None
# a real run: the structure features on every trade, the breakdowns and the split in the result
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)
rr = L.run_job({'tf': 'D', 'group': 'touch', 'maxRisk': 0, 'structure': 'show', 'discount': 0.5, 'testFrom': '2011-01-01'})
cols15 = rr['tradeCols']
assert rr['stats']['edge'] in ('real', 'chance', 'losing', 'few') and rr['stats']['avgRLo'] <= rr['stats']['avgR'] <= rr['stats']['avgRHi']
assert {b['key'] for b in rr['breakdowns']} >= {'where', 'risk'} and rr['split']['at'] == '2011-01-01', [b['key'] for b in rr['breakdowns']]
sup15 = [r for r in rr['trades'] if r[cols15.index('sym')] == 'SUP' and r[cols15.index('stage')] == 'disc'][0]
assert (sup15[cols15.index('depth')], sup15[cols15.index('lhll')]) == (89, 3) and sup15[cols15.index('lag')] > 0, sup15
off15 = L.run_job({'tf': 'D', 'group': 'touch', 'maxRisk': 0})
assert not {b['key'] for b in off15['breakdowns']} & {'depth', 'lhll', 'lag'} and off15['split'] is None, 'no structure: those need it'

# ------------------------------------------------------------------ 16. the rest of the review's experiments (owner, 12-Nov-2026:
# "Finish all the remaining updates") - each one an option next to the frozen baseline
# E5 protected CHoCH: after the final low a minor high / higher low; the baseline sees no lower low there (no CHoCH), the
# protected high (the lower high before the lowest low) is broken = a CHoCH
pp = [100]
for top, bot in ((100, 90), (95, 85), (90, 80), (85, 75)):
    pp += (leg(pp[-1], top) if pp[-1] != top else []) + leg(top, bot)
pp += leg(75, 79, 4) + leg(79, 76, 4) + leg(76, 92, 8) + leg(92, 86, 4) + leg(86, 100, 6)
pc_ = pp[1:]
ph_ = [max(a, b) + 0.2 for a, b in zip(pp[:-1], pc_)]
pl_ = [min(a, b) - 0.2 for a, b in zip(pp[:-1], pc_)]
assert S.Structure(ph_, pl_, pc_, 3).events == [], 'the baseline: no CHoCH on this chart'
prot = S.Structure(ph_, pl_, pc_, 3, {'choch': 'protected'})
assert [(round(e[2], 1), round(e[4], 1), e[5]) for e in prot.events] == [(85.2, 74.8, 2)] and prot.sweep == [False], prot.events
li_ = prot.events[0][3]
swc = list(pc_)
swc[li_] = 80.5                                   # the final low candle closes back above the swing low before it (79.8)
assert S.Structure(ph_, pl_, swc, 3, {'choch': 'protected'}).sweep == [True], 'a sweep of that low'
# E5 equal highs: 94.9 after 95 is not a lower high with a 0.3 x ATR tolerance
pq = [100]
for top, bot in ((100, 90), (95, 85), (94.9, 80), (85, 75)):
    pq += (leg(pq[-1], top) if pq[-1] != top else []) + leg(top, bot)
pq += leg(75, 96, 8)
qc = pq[1:]
qh = [max(a, b) + 0.2 for a, b in zip(pq[:-1], qc)]
ql = [min(a, b) - 0.2 for a, b in zip(pq[:-1], qc)]
assert [e[5] for e in S.Structure(qh, ql, qc, 3).events] == [2] and [e[5] for e in S.Structure(qh, ql, qc, 3, {'eq': 0.3}).events] == [1]
# E3 ZigZag + E2 prominence on random charts: alternating swings, each known only after the turn, nothing looks ahead
for seed in range(5):
    w = walk(500 + seed, 900)
    hh, ll, cc = [r[2] for r in w], [r[3] for r in w], [r[4] for r in w]
    atr_ = S.atr_series(hh, ll, cc)
    zz = S.zigzag(hh, ll, atr_, 2.0)
    assert zz and all(zz[k][2] != zz[k + 1][2] for k in range(len(zz) - 1)), 'highs and lows alternate'
    for p_, j_, is_h in zz:
        assert j_ > p_ and (hh[p_] - ll[j_] >= 2 * atr_[j_] - 1e-9 if is_h else hh[j_] - ll[p_] >= 2 * atr_[j_] - 1e-9), (p_, j_)
    php, plp = S.pivots(hh, ll, 5, 3.0, atr_)
    ph0, pl0 = S.pivots(hh, ll, 5)
    assert set(php) <= set(ph0) and set(plp) <= set(pl0) and len(php) + len(plp) < len(ph0) + len(pl0)
    assert all(hh[p_] - min(ll[p_ - 5:p_ + 6]) >= 3 * atr_[p_] for p_ in php)
    for o in ({'swing': 'zigzag', 'zz': 2.0}, {'prom': 1.0}, {'choch': 'protected'}, {'eq': 0.25}):
        full = S.Structure(hh, ll, cc, 5, o)
        for cut in (300, 640):
            assert S.Structure(hh[:cut], ll[:cut], cc[:cut], 5, o).events == [e for e in full.events if e[0] < cut], (seed, o, cut)
    stz = S.Structure(hh, ll, cc, 5, {'swing': 'zigzag', 'zz': 2.0})
    assert list(stz.ph) == [p_ for p_, j_, h_ in zz if h_] and list(stz.phc) == [j_ for p_, j_, h_ in zz if h_]
    assert S.last_swing_low(stz, len(cc) - 1, 0) == stz.plv[-1] and S.last_swing_low(stz, len(cc) - 1, len(cc)) is None
# the Lab: the new rules from the page, checked; struct_opts only for the ones away from the baseline
q16 = P(swingMode='zigzag', zzAtr=99, swingAtr=-1, chochMode='protected', eqAtr=0.2, sweep=True, discountMax=0.9, lagMin=5.6, dispAtr=1,
        dispVol=2, whereIn='tm', wkAbove=21, trail='atr', atrK=2, valFrom='2015-01-01', testFrom='2020-01-01', rollYears=2)
assert (q16['zzAtr'], q16['swingAtr'], q16['lagMin'], q16['whereIn'], q16['wkAbove'], q16['trail'], q16['valFrom']) == (10, 0, 6, 'tm', 21, 'atr', '2015-01-01')
assert L.struct_opts(q16) == {'swing': 'zigzag', 'zz': 10, 'choch': 'protected', 'eq': 0.2} and L.struct_opts(P()) == {}
assert P(valFrom='2021-01-01', testFrom='2020-01-01')['valFrom'] == '' and P(valFrom='2015-01-01')['valFrom'] == '', 'needs a later test part'
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)
meta16, d16 = L.load_meta()
with open(os.path.join(d16, 'D.bin'), 'rb') as f:
    o16, n16 = meta16['index']['D']['AAA']
    v16 = list(L.Candles(f, o16, n16).v)
assert v16 == [float(r[5]) for r in walk(3, 900)][:n16] and max(v16) > 0, 'the cache keeps the volume (version 4)'
base16 = {'tf': 'D', 'group': 'touch', 'maxRisk': 0}
b0 = L.run_job(base16)
# E9: how deep the touch candle went - with the close entry only the top half; with the zone-top order the rule is not used
w16 = L.run_job(dict(base16, whereIn='t'))
wi16 = w16['tradeCols'].index('where')
assert w16['skipped']['where'] > 0 and {r[wi16] for r in w16['trades']} <= {'top', ''} and w16['tradesTotal'] < b0['tradesTotal']
assert L.run_job(dict(base16, whereIn='t', entry='zone'))['skipped']['where'] == 0
# E11: the stock's last finished weekly close above its 21-week EMA
k16 = L.run_job(dict(base16, wkAbove=21))
assert k16['skipped']['wk'] > 0 and k16['tradesTotal'] + k16['skipped']['wk'] >= b0['tradesTotal'] - 5 and k16['tradesTotal'] < b0['tradesTotal']
assert L.run_job(dict(base16, tf='W', wkAbove=21))['skipped']['wk'] == 0, 'a weekly run: not used'
# the structure rules (market structure 'only'): each one leaves signals out with its own reason
s16 = dict(base16, structure='only', discount=0)
for extra, why in (({'dispAtr': 5}, 'disp'), ({'dispVol': 9}, 'vol'), ({'lagMin': 2000}, 'early'), ({'discountMax': 0.05}, 'deep'),
                   ({'sweep': True}, 'sweep')):
    rr16 = L.run_job(dict(s16, **extra))
    assert rr16['structWhy'].get(why, 0) > 0, (extra, rr16['structWhy'])
# the structure engines run and label every trade (zigzag / prominence / protected / equal highs)
for extra in ({'swingMode': 'zigzag', 'zzAtr': 2}, {'swingAtr': 1}, {'chochMode': 'protected'}, {'eqAtr': 0.3}):
    rr16 = L.run_job(dict(base16, structure='show', discount=0.5, **extra))
    assert rr16['stages'] and all(r[rr16['tradeCols'].index('stage')] for r in rr16['trades']), extra
# E15 / E16: the stop trails under the highest high - 2 x ATR, or under the newest swing low since the signal
for tr in ('atr', 'swing'):
    rr16 = L.run_job(dict(base16, trail=tr, atrK=2, targetR=1, structure='show', lockTarget=False))
    ci = rr16['tradeCols']
    rows16 = [dict(zip(ci, r)) for r in rr16['trades']]
    assert any(r['reason'] == 'trail' for r in rows16), tr
    assert all(r['exit'] >= r['stop'] - 0.01 or r['reason'] in ('stop', 'gap') for r in rows16)
assert L.run_job(dict(base16, trail='atr', targetR=1, lockTarget=False))['reasons'] != L.run_job(dict(base16, trail='swing', targetR=1, lockTarget=False))['reasons']
# validation: development / validation / test, and every 2-year block
v16r = L.run_job(dict(base16, structure='show', discount=0.5, valFrom='2010-12-01', testFrom='2011-06-01', rollYears=1))
assert v16r['split']['val'] == '2010-12-01' and {'dev', 'valid', 'test'} <= set(v16r['split']), v16r['split']
assert sum(v16r['split'][k].get('trades', 0) for k in ('dev', 'valid', 'test')) == v16r['stats']['trades']
assert any('val' in r for b_ in v16r['breakdowns'] for r in b_['rows'])
assert v16r['rolling'] and [x['from'] for x in v16r['rolling']] == sorted(x['from'] for x in v16r['rolling']) and \
    sum(x['trades'] for x in v16r['rolling']) == v16r['stats']['trades']
assert L.run_job(dict(base16, rollYears=0))['rolling'] is None
assert 'before 2011-06-01' in L.headline(v16r)
# the charts PDF draws the run's own swings (a ZigZag run here)
zz16 = L.run_job(dict(base16, structure='show', swingMode='zigzag'), charts=L.CHARTS_DIR, name='zigzag')
assert zz16['pdf'].get('file') and not zz16['pdf'].get('error'), zz16['pdf']

# ------------------------------------------------------------------ 17. the owner's refinements after his first charts PDF (12-Nov-2026)
# hand-made candles + rows: an FVG zone 100 - 110 (formed on candle 3) with a Gap-up zone 104 - 108 inside it (same move)
def r17(rows, dark=False, extra=None):
    cs = [cdl(0, 98, 99, 97, 98.5), cdl(1, 98.5, 100, 98, 99.5), cdl(2, 99.5, 112, 99.4, 111.5),
          cdl(3, 112.5, 113, 110, 111) if not dark else cdl(3, 112.5, 113, 110, 104.5),   # dark: red, opens over 111.5, closes < 105.45
          cdl(4, 111, 115, 110.5, 114), cdl(5, 114, 116, 112, 113), cdl(6, 113, 113.5, 109, 109.5),   # 6: touches 110, not 108
          cdl(7, 108.5, 109, 106, 107), cdl(8, 107, 107.5, 103.5, 105), cdl(9, 105, 112, 104.8, 111),
          cdl(10, 111, 121, 110.5, 120), cdl(11, 120, 130, 119, 129), cdl(12, 129, 131, 127, 130)] + (extra or [])
    cache_of({'X': (cs, rows)})


Z17 = [6, 'Z', 100.0, 110.0, 't', 1, 0, 50.0, 3, [104.0, 108.0, 3]]
Y17 = [7, 'Y', 104.0, 108.0, 't', 1, 1, 50.0, 3, [100.0, 110.0, 3]]
P17 = [8, 'P', 100.0, 110.0, 'm', 0, 0, 50.0, 3, None, 'S']
T17 = dict(tf='D', group='touch', entry='zone', maxRisk=0, cost=0, lockTarget=False)
r17([Z17, Y17])
g1 = L.run_job(dict(T17))                                   # gapEntry (default): the order at the Gap-up zone top
c17 = g1['tradeCols']
tr = [dict(zip(c17, r)) for r in g1['trades']]
assert len(tr) == 1 and tr[0]['signal'] == (D0 + timedelta(days=7)).isoformat() and tr[0]['entry'] == 108.0, tr
assert tr[0]['stop'] == round(100 * 0.995, 2) and tr[0]['zone'] == 'Gap-up zone touch inside FVG' and tr[0]['zpct'] == 10.0, tr
assert g1['skipped']['gapin'] == 1 and L.DEFAULTS['gapEntry'] is True
g0 = L.run_job(dict(T17, gapEntry=False))                   # the old way: the FVG's own touch on candle 6
tr0 = sorted((dict(zip(c17, r)) for r in g0['trades']), key=lambda x: x['signal'])
assert tr0[0]['signal'] == (D0 + timedelta(days=6)).isoformat() and tr0[0]['entry'] == 110.0 and tr0[0]['stop'] == 99.5, tr0
assert len(tr0) == 2 and tr0[1]['stop'] == round(104 * 0.995, 2), 'and the Gap-up zone on its own (its own stop)'
# the FVG's size (10 %): 2 - 8 % leaves it out, 2 - 12 % keeps it; the Gap-up zone inside is judged by its FVG
assert L.run_job(dict(T17, zoneMin=2, zoneMax=8))['skipped']['zsize'] >= 1 and not L.run_job(dict(T17, zoneMin=2, zoneMax=8))['trades']
assert len(L.run_job(dict(T17, zoneMin=2, zoneMax=12))['trades']) == 1 and not L.run_job(dict(T17, zoneMin=11))['trades']
assert L.zone_pct(100, 110) == 10.0 and L.size_zone(Y17, P()) == (100.0, 110.0) and L.size_zone(Y17, P(gapEntry=False)) == (104.0, 108.0)
# the dark-cloud FVG (its 3rd candle red, opening over the green candle's close, closing under the middle of its body)
r17([Z17, Y17], dark=True)
assert L.run_job(dict(T17, darkCloud='exclude'))['skipped']['dcloud'] >= 1 and not L.run_job(dict(T17, darkCloud='exclude'))['trades']
assert len(L.run_job(dict(T17, darkCloud='only'))['trades']) == 1 and len(L.run_job(dict(T17))['trades']) == 1
r17([Z17, Y17])
assert not L.run_job(dict(T17, darkCloud='only'))['trades'] and len(L.run_job(dict(T17, darkCloud='exclude'))['trades']) == 1
fc17 = [{'o': 99.5, 'h': 112, 'l': 99.4, 'c': 111.5}, {'o': 112.5, 'h': 113, 'l': 110, 'c': 104.5}]
assert K.is_dark_cloud(fc17, 1) and not K.is_dark_cloud(fc17[:1] + [{'o': 112.5, 'h': 113, 'l': 110, 'c': 106}], 1)
# Fib + pattern (FINOPB): the Spring on candle 8 - low 103.5 at the zone's 61.8 % line (110 - 0.618 x 10 = 103.82, +/- 1 %),
# closing above it - bought at its close, the stop under the zone bottom
r17([Z17, Y17, P17])
fa = L.run_job(dict(T17, fibPat='all'))
tra = [dict(zip(c17, r)) for r in fa['trades']]
assert len(tra) == 1 and tra[0]['signal'] == (D0 + timedelta(days=8)).isoformat() and tra[0]['entry'] == 105.0 and tra[0]['stop'] == 99.5, tra
assert tra[0]['pat'] == 'Spring' and tra[0]['zone'] == 'FVG zone - pattern at the Fib line', tra
assert not L.run_job(dict(T17, fibPat='all', fibLevel=0.5))['trades'] and L.run_job(dict(T17, fibPat='all', fibLevel=0.5))['skipped']['fiblevel'] == 1
assert not L.run_job(dict(T17, fibPat='all', fibLevel=0.5, fibTol=3))['trades'], 'the 50 % line 105: the close (105) is not above it'
assert len(L.run_job(dict(T17, fibPat='all', fibLevel=0.55))['trades']) == 1     # the 55 % line 104.5: low within 1 %, close above
# 'big': the 10 % zone is bigger than the 8 % limit -> the pattern; under a 12 % limit -> the zone-top (Gap-up) entry
fb = [dict(zip(c17, r)) for r in L.run_job(dict(T17, fibPat='big', zoneMax=8))['trades']]
assert len(fb) == 1 and fb[0]['pat'] == 'Spring', fb
fs = [dict(zip(c17, r)) for r in L.run_job(dict(T17, fibPat='big', zoneMax=12))['trades']]
assert len(fs) == 1 and fs[0]['entry'] == 108.0 and fs[0]['pat'] == '', fs
assert not L.run_job(dict(T17, fibPat='off', zoneMax=8))['trades']
# the target lock in a run (default on): the 2R target 125 reached on candle 11, the trade sold at 125 when price falls back
r17([Z17, Y17], extra=[cdl(13, 130, 130.5, 124, 124.5), cdl(14, 124.5, 125, 120, 121)])
lk = [dict(zip(c17, r)) for r in L.run_job(dict(T17, lockTarget=True, trail='none'))['trades']]
assert lk[0]['reason'] == 'lock' and lk[0]['exit'] == 125.0 and lk[0]['R'] == 2.0, lk
# the CHoCH-line rule (SWIGGY): a zone short of the discount line counts when its top is at / just above the CHoCH level
sj17 = {'k': 0, 'after_low': True, 'leg': True, 'after': True, 'first': True, 'below': False, 'depth': 0.3, 'lvl': 100.0, 'ztop': 100.4}
assert L.struct_fail(sj17, P(belowChoch=False, discount=0.382)) == 'premium' and L.struct_fail(sj17, P(belowChoch=False, discount=0.382, lineOk=True, lineTol=0.5)) == ''
assert L.struct_fail(dict(sj17, ztop=100.6), P(belowChoch=False, discount=0.382, lineOk=True, lineTol=0.5)) == 'premium'
assert L.struct_fail(dict(sj17, ztop=99.0), P(belowChoch=False, discount=0.382, lineOk=True, lineTol=0)) == ''
# the stop under the CHoCH's final low (LL): every trade of the owner's setup on the made SUPREMEIND chart + random charts
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)
fl = L.run_job(dict(SMC6, stop='final', stopBuf=0.5))
ci = fl['tradeCols']
assert fl['tradesTotal'] > 0
for r in fl['trades']:
    t_ = dict(zip(ci, r))
    low = float(re.search(r'final low ([\d.]+)', t_['struct']).group(1))
    assert abs(t_['stop'] - round(low * 0.995, 2)) <= 0.011, (t_['stop'], low)
assert not L.run_job(dict(SMC6, structure='off', stop='final', minPrice=1e5))['trades']
# the cache: every Gap-up zone row's FVG link / FVG zone row's Gap-up link is a zone of the same move, inside it, formed
# before the touch; 'P' / 'Q' rows = a Spring / Bullish Harami + Inverted Hammer inside a zone that held
meta17, d17 = L.load_meta()
nlink = npq = 0
for sym, rows in meta17['signals']['D'].items():
    for r in rows:
        if r[1] in ('Z', 'Y') and r[9]:
            nlink += 1
            inner, outer = (r[9], r[2:4]) if r[1] == 'Z' else (r[2:4], r[9])
            assert inner[0] >= outer[0] - 1e-6 and inner[1] <= outer[1] + 1e-6 and abs(r[9][2] - r[8]) <= K.ZONE_LINK_SPAN and r[9][2] < r[0], r
        if r[1] in ('P', 'Q'):
            npq += 1
            assert r[10] in ('S', 'H') and r[8] <= r[0] - 2 and r[9] is None, r
assert npq > 0, 'Fib-pattern rows in the cache'
# the Python Bullish Harami + Inverted Hammer (tests/pcbridge-intraday.test.js compares it with the website's on random pairs)
assert K.is_hih_pair({'o': 100, 'h': 100.5, 'l': 91, 'c': 92}, {'o': 92, 'h': 97.5, 'l': 91.9, 'c': 93})
assert not K.is_hih_pair({'o': 100, 'h': 100.5, 'l': 91, 'c': 92}, {'o': 92, 'h': 94, 'l': 91.9, 'c': 93}), 'the wick must reach 60 % up'
# the charts PDF tells the new rules in words
pdf17 = L.run_job(dict(SMC6, stop='final', lineOk=True), charts=L.CHARTS_DIR, name='refined')
assert pdf17['pdf'].get('file') and not pdf17['pdf'].get('error'), pdf17['pdf']
w17 = ' '.join(' '.join(pg) for pg in pdf_pages(os.path.join(L.CHARTS_DIR, pdf17['pdf']['file'])))
assert 'just under the final low (the lowest point before the CHoCH)' in w17 and 'under the CHoCH\'s final low (LL)' in w17

# ------------------------------------------------------------------ 18. the 2nd discount zone + the CHoCH move's volume (owner, 12-Nov-2026:
# "No trade only on 2nd FVG. 1st FVG can be watched but not to be traded"; "In the move of Choch, volumes are at least twice")
ok18, nb18 = (lambda f, b, t: True), (lambda f, b: False)
zs18 = [(10, 140.0, 145.0, 30), (12, 121.0, 126.0, None), (14, 100.0, 105.0, None)]
assert L.zone_rank(zs18, 40, 140.0, 145.0, 5, ok18, nb18)[:2] == ('zone1', 1), 'the higher of two: only watched'
assert L.zone_rank(zs18, 40, 121.0, 126.0, 5, ok18, nb18)[:3] == ('', 2, (140.0, 145.0, 10)), 'the 2nd: the trade'
assert L.zone_rank(zs18, 50, 100.0, 105.0, 5, ok18, nb18)[:2] == ('zone3', 3), 'a 3rd: not traded'
assert L.zone_rank(zs18[:1], 40, 140.0, 145.0, 5, ok18, nb18)[:2] == ('', 1), 'one zone: traded as before'
assert L.zone_rank(zs18[:2], 40, 140.0, 145.0, 5, ok18, lambda f, b: True)[0] == '', 'a broken lower zone does not count'
assert L.zone_rank([zs18[0], (12, 121.0, 126.0, 35)], 40, 140.0, 145.0, 5, ok18, nb18)[0] == '', 'nor one already reached'
assert L.zone_rank(zs18[:2], 40, 140.0, 145.0, 5, lambda f, b, t: b > 130, nb18)[0] == '', 'nor one the rules leave out'
assert L.zone_rank(zs18[:2], 40, 140.0, 145.0, 13, ok18, nb18)[0] == '', 'nor one older than the final low'
assert L.zone_rank([(8, 130.0, 135.0, 20), (9, 133.0, 138.0, 22), (12, 121.0, 126.0, None)], 40, 121.0, 126.0, 5, ok18, nb18)[:2] == ('', 2), \
    'overlapping zones above = one area'
assert L.zone_rank([(10, 120.0, 130.0, None), (11, 124.0, 126.0, None)], 40, 120.0, 130.0, 5, ok18, nb18)[:2] == ('', 1), \
    'a Gap-up zone inside the FVG is the same area'
# the CHoCH move's volume: each candle from the final low to the CHoCH candle vs the 20 candles before the final low


class _V18:
    def __init__(self, v):
        self.v, self.n = v, len(v)


assert L.move_volumes(_V18([100.0] * 20 + [100, 250, 90, 300]), 20, 23) == [1.0, 2.5, 0.9, 3.0]
assert L.move_volumes(_V18([0.0] * 20 + [100, 250]), 20, 21) is None, 'no volume to compare with'
mvc = L.TRADE_COLS.index('mv')
base18 = L.run_job(dict(SMC6))
assert base18['tradesTotal'] > 0 and all(isinstance(r[mvc], float) and r[mvc] > 0 for r in base18['trades']), [r[mvc] for r in base18['trades']]
hi18 = L.run_job(dict(SMC6, moveVol=20))
assert hi18['tradesTotal'] < base18['tradesTotal'] and hi18['structWhy'].get('mvol', 0) >= 1, hi18['structWhy']
assert L.run_job(dict(SMC6, moveVol=0.01))['tradesTotal'] == base18['tradesTotal']
assert L.run_job(dict(SMC6, moveVol=0.01, moveVolN=500))['tradesTotal'] < base18['tradesTotal'], 'N candles at least'
assert P(moveVol=50, moveVolN=0, zonePick='x') ['moveVol'] == 20 and P(moveVolN=0)['moveVolN'] == 1 and P(zonePick='x')['zonePick'] == 'second'
# the daily scan + the waiting list follow it (the made SUPREMEIND chart: the premium zone 139.30 - 145.00 above the discount one)
loose18 = dict(D6, fib=0.2)
got18 = [x for x in K.analyse({'sym': 'SUP', 'day': r6, 'm15': [], 'h4': []}, r6[t_prem - 1][0], date.fromisoformat(r6[-1][0]), set(), ('D',), (),
                              choch=loose18)['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert got18[0]['candle'][:10] == r6[t_disc][0] and r6[t_prem][0] not in [x['candle'][:10] for x in got18] and \
    all('· 2nd discount zone (the 1st only watched)' in x['note'] for x in got18), \
    [(x['candle'], x['note']) for x in got18]
every18 = [x for x in K.analyse({'sym': 'SUP', 'day': r6, 'm15': [], 'h4': []}, r6[t_prem - 1][0], date.fromisoformat(r6[-1][0]), set(), ('D',), (),
                                choch=dict(loose18, zonePick='every'))['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert every18[0]['candle'][:10] == r6[t_disc][0] and not any('2nd discount zone' in x['note'] for x in every18), [(x['candle'], x['note']) for x in every18]
pre18 = [dict(zip(('day', 'o', 'h', 'l', 'c', 'v'), r)) for r in r6[:t_prem]]
cs18 = [{'t': r['day'], 'day': r['day'], 'o': r['o'], 'h': r['h'], 'l': r['l'], 'c': r['c']} for r in pre18]
wt18 = K.choch_waiting(cs18, cs18, 'D', rules=loose18)
assert wt18 and wt18['zone'][:2] == [121.3, 126.5] and 'the 2nd discount zone (the 1st, 139.30 - 145.00, only watched)' in wt18['how'], wt18
assert K.choch_waiting(cs18, cs18, 'D', rules=dict(loose18, zonePick='every'))['zone'][:2] == [139.3, 145.0]
# the charts PDF: volume under every chart, the watched 1st zone + the sentence
pdf18 = L.run_job(dict(SMC6, discount=0, moveVol=0.01), charts=L.CHARTS_DIR, name='second zone')
w18 = ' '.join(' '.join(pg) for pg in pdf_pages(os.path.join(L.CHARTS_DIR, pdf18['pdf']['file'])))
for txt in ('Volume (grey line = 20-candle average; the CHoCH move darker)', '1st zone (watched only)', 'Your rule only watches that 1st',
            'the 2nd traded, the 1st only watched', 'Volume in the rise that made the CHoCH', 'Volume in the CHoCH move: at least 1 candle'):
    assert txt in w18, txt

# ------------------------------------------------------------------ 19. a zone touched before the CHoCH counts again (owner, 13-Nov-2026,
# SWIGGY: "Here 2 FVG under 50% line. 1st one is already mitigated before Choch move, we can take in this FVG even if this FVG
# mitigated before the Choch Move")
def craft19():
    """SWIGGY-like: 3 lower highs / lows, FVG1 121.3 - 126.5 in the CHoCH move TOUCHED before the CHoCH candle, the CHoCH, FVG2
    139.3 - 145.0 (discount: the move high 175.3), the pullback into FVG2 (the 1st, watched), then into FVG1 (its first touch
    since the CHoCH = the trade), the rally."""
    rows, prev = [], 165.0
    d0 = date(2026, 3, 2)

    def put(o, h, l, c):
        rows.append([(d0 + timedelta(days=len(rows))).isoformat(), round(o, 2), round(h, 2), round(l, 2), round(c, 2), 900000])

    def go(to, k=6):
        nonlocal prev
        for x in leg(prev, to, k):
            put(prev, max(prev, x) + 0.3, min(prev, x) - 0.3, x)
            prev = x
    for to in (150, 160, 142, 152, 134, 144, 126, 136, 120):
        go(to)
    put(120, 121.3, 119.7, 121)                                 # A
    put(121, 130.3, 120.7, 130)                                 # B
    put(130, 133.3, 126.5, 133)                                 # C: FVG1 121.3 - 126.5
    put(133, 133.3, 125.8, 131)                                 # a dip into FVG1 BEFORE the CHoCH (it holds)
    put(131, 138.3, 130.0, 138)                                 # the CHoCH (a close above 136.3)
    put(138, 139.3, 133.0, 139)
    put(139, 148.3, 138.7, 148)
    put(148, 151.3, 145.0, 151)                                 # FVG2 139.3 - 145.0
    prev = 151
    go(175, 4)                                                  # the move high 175.3: the 50 % line 147.5
    go(147, 4)
    put(147, 147.3, 143.0, 144)                                 # the first touch of FVG2
    prev = 144
    go(128, 6)
    put(128, 128.3, 124.8, 125)                                 # FVG1 again - the first touch since the CHoCH
    prev = 125
    go(190, 8)
    return rows


r19 = craft19()
t19a = next(k for k, r in enumerate(r19) if r[3] == 143.0)
t19b = next(k for k, r in enumerate(r19) if r[3] == 124.8)
K.store_save('SWG', {'v': 1, 'sym': 'SWG', 'm15': [], 'day': r19, 'h4': []})
K.backtest_pass(set(), date.fromisoformat(r6[-1][0]), {}, out=lambda m: None)
assert L.LOCK_PCT == K.CIRCUIT_LOCK_PCT and L.DEFAULTS['touchAgain'] is True
c19 = L.TRADE_COLS
swg = lambda **kw: [dict(zip(c19, r)) for r in L.run_job(dict(SMC6, **kw))['trades'] if r[0] == 'SWG']
mine19 = swg(entry='zone')
assert [(t['signal'], t['entry'], t['zn']) for t in mine19] == [(r19[t19b][0], 126.5, 2)], mine19
assert mine19[0]['zone'] == 'FVG zone touch (again after the CHoCH)' and mine19[0]['R'] > 0, mine19
off19 = swg(entry='zone', touchAgain=False)                    # before: FVG1 used up before the CHoCH -> FVG2 is the trade
assert [(t['signal'], t['entry']) for t in off19] == [(r19[t19a][0], 145.0)], off19
both19 = swg(entry='zone', zonePick='every')
assert [t['entry'] for t in sorted(both19, key=lambda t: t['signal'])] == [145.0, 126.5], both19
# the rule itself: rearm_touches on the made chart
st19 = L.structure.Structure([r[2] for r in r19], [r[3] for r in r19], [r[4] for r in r19], 5)
k19 = st19.active(t19b, 3)
assert (r19[56][3], r19[57][3]) == (126.5, 125.8)
zk19 = [(('FVG', 56), 56, 121.3, 126.5, 57, False)]
got19 = L.rearm_touches(st19.events, 3, zk19, [r[3] for r in r19], [r[4] for r in r19])
assert got19.get(k19) == {('FVG', 56): t19b}, (got19, k19, st19.events)
assert L.rearm_touches(st19.events, 3, zk19, [r[3] for r in r19], [99.0 if j == 57 else r[4] for j, r in enumerate(r19)]) \
    .get(k19, {}) == {}, 'a zone a close went under before the CHoCH is not counted again'
# the daily scan: the setup on FVG1's touch (none on FVG2's), the waiting list's order at FVG1 with FVG2 watched
store19 = {'sym': 'SWG', 'day': r19, 'm15': [], 'h4': []}
it19 = [x for x in K.analyse(store19, r19[t19a - 1][0], date.fromisoformat(r19[-1][0]), set(), ('D',), ())['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert it19 and it19[0]['candle'][:10] == r19[t19b][0] and r19[t19a][0] not in [x['candle'][:10] for x in it19], [(x['candle'], x['note']) for x in it19]
assert it19[0]['note'].startswith('Zone touch (the first since the CHoCH - touched before it) · CHoCH ') and '· 2nd discount zone (the 1st only watched)' in it19[0]['note'], it19[0]['note']
# on FVG2's day (before the later fall that undoes it): without the rule FVG2 is the setup, with it FVG2 is only watched
day19 = lambda **kw: [x for x in K.analyse(dict(store19, day=r19[:t19a + 1]), r19[t19a - 1][0], date.fromisoformat(r19[t19a][0]), set(), ('D',), (),
                                           choch=dict(D6, **kw))['items'] if x['pattern'] == K.CHOCH_PATTERN]
assert [x['candle'][:10] for x in day19(touchAgain=False)] == [r19[t19a][0]] and day19() == [], (day19(touchAgain=False), day19())
pre19 = [{'t': r[0], 'day': r[0], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4]} for r in r19[:t19a]]
w19 = K.choch_waiting(pre19, pre19, 'D')
assert w19 and w19['buy'] == 126.5 and 'the 2nd discount zone (the 1st, 139.30 - 145.00, only watched)' in w19['how'], w19
assert K.choch_waiting(pre19, pre19, 'D', rules=dict(D6, touchAgain=False))['buy'] == 145.0
# the charts PDF says it
pdf19 = L.run_job(dict(SMC6, entry='zone'), charts=L.CHARTS_DIR, name='touch again')
w19p = ' '.join(' '.join(pg) for pg in pdf_pages(os.path.join(L.CHARTS_DIR, pdf19['pdf']['file'])))
assert 'Price had already touched this zone once while the rise was forming' in w19p, 'the sentence'

print('OK')
