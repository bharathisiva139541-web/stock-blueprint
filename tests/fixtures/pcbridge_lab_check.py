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

print('OK')
