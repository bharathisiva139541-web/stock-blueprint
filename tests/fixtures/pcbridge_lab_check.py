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
    params = dict(cost=0, **kw)
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
assert g(group='zone') == [(5, 'F'), (9, 'G')], 'one per candle'
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
assert built and any(c['op'] == 'progress' for c in api.calls) and any(c['op'] == 'result' for c in api.calls), api.calls
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
row = L.run_job({'tf': 'D', 'group': 'spring', 'maxRisk': 0, 'maxOpen': 1})['trades']
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
assert len(P(**{k: DEF for k, DEF in L.DEFAULTS.items()})) == len(L.DEFAULTS) and 'upW' in L.TRADE_COLS and L.TRADE_COLS[-1] == 'acct'
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

print('OK')
