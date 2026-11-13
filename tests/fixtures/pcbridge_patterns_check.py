# -*- coding: utf-8 -*-
"""Offline checks of the bullish pattern engine, M1 (owner, 13-Nov-2026; docs/PATTERN_ENGINE_PLAN.md): indicators.py (worked
examples + an independent second implementation), pattern_registry.py (the 194 entries), pattern_detect.py (unit, boundary,
CAUSALITY: the chart cut at many points and the candles after the cut changed - the events up to the cut never change,
reproducibility) and the Backtest Lab's Pattern library group. Prints OK at the end.

  --pat PID < candles.json  prints the signal candles of pattern PID on each chart (tests/pcbridge-patterns.test.js compares
                           K08 / K09 / K10 / K12 / K17 with web/lib/patterns.js - the sheet's own column W rules)
  --bench N                times every detector on N random stocks of 3,000 daily candles
"""
import importlib.util
import json
import math
import os
import random
import sys
import tempfile
import time
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
import indicators as ind  # noqa: E402
import pattern_detect as det  # noqa: E402
import pattern_registry as reg  # noqa: E402
import structure  # noqa: E402

if len(sys.argv) > 1 and sys.argv[1] in ('--k08', '--pat'):
    pid = sys.argv[2] if sys.argv[1] == '--pat' else 'K08'
    charts = json.load(sys.stdin)
    out = []
    for cs in charts:
        o, h, l, c = ([x[k] for x in cs] for k in ('o', 'h', 'l', 'c'))
        out.append([e[1] for e in det.detect(pid, o, h, l, c, [1.0] * len(c), 'D')])
    print(json.dumps(out))
    sys.exit(0)


def walk(seed, n, vol=0.03, start=100.0):
    rnd = random.Random(seed)
    o, h, l, c, v = [], [], [], [], []
    px = start
    for _ in range(n):
        a = px * (1 + rnd.uniform(-0.02, 0.02))
        b = a * (1 + rnd.uniform(-vol, vol))
        o.append(round(a, 2))
        c.append(round(b, 2))
        h.append(round(max(a, b) * (1 + rnd.uniform(0, 0.02)), 2))
        l.append(round(min(a, b) * (1 - rnd.uniform(0, 0.02)), 2))
        v.append(float(rnd.randint(1000, 90000)))
        px = b
    return o, h, l, c, v


if len(sys.argv) > 2 and sys.argv[1] == '--bench':
    N = int(sys.argv[2])
    charts = [walk(s, 3000) for s in range(N)]
    tot = sum(len(ch[0]) for ch in charts)
    for pid in reg.implemented():
        t0 = time.time()
        ev = sum(len(det.detect(pid, *ch, 'D')) for ch in charts)
        dt = time.time() - t0
        print('%s  %6.2f s for %d stocks / %.1f M candles  (%.2f s per M candles)  %d events' % (pid, dt, N, tot / 1e6, dt / tot * 1e6, ev))
    sys.exit(0)

near = lambda a, b, e=1e-9: (a is None and b is None) or (a is not None and b is not None and abs(a - b) <= e)

# ------------------------------------------------------------------ 1. indicators: worked examples
a = ind.anatomy(10, 12, 9, 11.5)
assert near(a['range'], 3) and near(a['body'], 1.5) and near(a['upper'], 0.5) and near(a['lower'], 1)
assert near(a['bodyR'], 0.5) and near(a['clv'], (23 - 21) / 3.0) and a['green'] and not a['red']
z = ind.anatomy(5, 5, 5, 5)                                   # a zero-range candle: no division by zero
assert z['range'] == 0 and z['bodyR'] == 0 and z['clv'] == 0 and not z['green'] and not z['red']
assert ind.true_range([10, 12, 11], [9, 10, 8], [9.5, 11, 10]) == [1, 2.5, 3]
assert ind.sma([1, 2, 3, 4], 2) == [None, 1.5, 2.5, 3.5] and ind.sma([1, None, 3, 4, 5], 2) == [None, None, None, 3.5, 4.5]
e = ind.ema([1, 2, 3, 4], 3)                                    # seed = mean(1, 2, 3) = 2, then 2 + 0.5 x (4 - 2) = 3
assert e[:2] == [None, None] and near(e[2], 2) and near(e[3], 3)
w = ind.wilder([3, 6, 9, 12], 3)                                # seed 6, then (6 x 2 + 12) / 3 = 8
assert w[:2] == [None, None] and near(w[2], 6) and near(w[3], 8)
# RSI by hand (the StockCharts sample closes): 14 changes, gains 3.34, losses 1.40 -> avg 0.23857 / 0.1 -> RSI 70.464
C = [44.34, 44.09, 44.15, 43.61, 44.33, 44.83, 45.10, 45.42, 45.84, 46.08, 45.89, 46.03, 45.61, 46.28, 46.28, 46.00]
r = ind.rsi(C, 14)
g, s_ = 3.34 / 14, 1.40 / 14
assert r[13] is None and near(r[14], 100 - 100 / (1 + g / s_), 1e-9) and abs(r[14] - 70.464) < 0.001
g2, s2 = g * 13 / 14, (s_ * 13 + 0.28) / 14                      # the next close falls 0.28
assert near(r[15], 100 - 100 / (1 + g2 / s2), 1e-9)
assert ind.rsi([5] * 20, 14)[14] == 50.0 and ind.rsi(list(range(20)), 14)[14] == 100.0
# ATR(3) by hand: TR 2, 2 (13 - 11), 2, 4 (15 - 11) -> seed (2 + 2 + 2) / 3 = 2, then (2 x 2 + 4) / 3
at = ind.atr([12, 13, 13, 15], [10, 11, 11, 11], [11, 12, 12, 14], 3)
assert at[:2] == [None, None] and near(at[2], 2.0) and near(at[3], 8 / 3.0)

# ------------------------------------------------------------------ 2. indicators: an independent second way, on random data
for seed in range(6):
    o, h, l, c, v = walk(seed, 400)
    for n in (1, 5, 20, 52):
        ph = ind.prior_high(h, n)
        assert ph == [max(h[i - n:i]) if i >= n else None for i in range(len(h))], (seed, n)
    assert ind.prior_high(h, 0) == [max(h[:i]) if i else None for i in range(len(h))]
    rv = ind.rel_volume(v, 20)
    assert all(near(rv[i], v[i] / (sum(v[i - 20:i]) / 20) if i >= 20 else None, 1e-9) for i in range(len(v)))
    for n in (3, 14, 50):
        sm = ind.sma(c, n)
        assert all(near(sm[i], sum(c[i - n + 1:i + 1]) / n if i >= n - 1 else None, 1e-9) for i in range(len(c)))
        # the recursive values = a value worked out from the start for every candle on its own (nothing from later)
        tr = ind.true_range(h, l, c)
        a_ = ind.atr(h, l, c, n)
        for i in range(n - 1, len(c), 37):
            x = sum(tr[:n]) / n
            for j in range(n, i + 1):
                x = (x * (n - 1) + tr[j]) / n
            assert near(a_[i], x, 1e-9), (seed, n, i)
        rs = ind.rsi(c, n)
        for i in range(n, len(c), 41):
            ch = [c[j] - c[j - 1] for j in range(1, i + 1)]
            gg = sum(max(x, 0) for x in ch[:n]) / n
            ll = sum(max(-x, 0) for x in ch[:n]) / n
            for x in ch[n:]:
                gg = (gg * (n - 1) + max(x, 0)) / n
                ll = (ll * (n - 1) + max(-x, 0)) / n
            assert near(rs[i], 100 - 100 / (1 + gg / ll) if ll else (50.0 if not gg else 100.0), 1e-9), (seed, n, i)

# ------------------------------------------------------------------ 3. the registry: all 194 entries of the master prompt
es = reg.entries()
ids = [e['id'] for e in es]
assert len(ids) == len(set(ids)), 'unique ids'
want = {'C': 20, 'K': 27, 'P': 24, 'S': 25, 'V': 16, 'B': 20, 'M': 18, 'I': 24, 'Q': 20}
for cat, n in want.items():
    got = sorted(i for i in ids if i[0] == cat)
    assert got == ['%s%02d' % (cat, k) for k in range(1, n + 1)], (cat, got)
assert sum(want.values()) == 194 == sum(1 for e in es if e['category'] != 'X')
assert all(e['status'] in reg.STATUS_NAMES for e in es) and all(e['name'] for e in es)
assert sorted(reg.implemented()) == sorted(det.DETECTORS), 'every implemented pattern has a detector and every detector an entry'
for pid in reg.implemented():
    sp = reg.SPECS[pid]
    assert sp['rules'] and sp.get('words') and sp['version'] >= 1, pid          # + the shared definitions reg.COMMON
assert len(reg.COMMON) >= 7 and all(len(reg.SPECS[p]['rules']) >= 5 for p in ('K08', 'B01', 'I01'))
assert [e['status'] for e in es if e['id'] in ('B15', 'M16')] == ['data', 'data']
assert json.loads(reg.as_json())['patterns'][0]['id'] == 'C01'

# ------------------------------------------------------------------ 4. detectors: units and boundaries
K = lambda rows: det.detect('K08', *[[r[k] for r in rows] for k in range(4)], [1.0] * len(rows), 'D')
assert [e[:3] for e in K([[10, 10.5, 8.9, 9], [8.9, 10.6, 8.8, 10.2]])] == [[1, 1, 0]]       # engulfs, bigger
ev = K([[10, 10.5, 8.9, 9], [8.9, 10.6, 8.8, 10.2]])[0]
assert ev[3] == 10.6 and ev[4] == 8.8                         # trigger = c2 high, stop reference = the lower low
assert K([[10, 10.5, 8.9, 9], [9, 10.6, 8.8, 10]]) == [], 'equal bodies: not bigger'
assert K([[10, 10.5, 8.9, 9], [9.1, 10.6, 8.8, 10.3]]) == [], 'opens above the red close'
assert K([[10, 10.5, 8.9, 10], [9, 10.6, 8.8, 10.2]]) == [], 'a doji before is not red'
assert K([[10, 10.5, 8.9, 9], [9, 10.6, 8.8, 9]]) == [], 'not green'
assert len(K([[10, 10.5, 8.9, 9], [9, 10.6, 8.8, 10.01]])) == 1, 'the body just bigger'
# engBody: the green body >= x ATR(14) of the candle before
rows = [[100, 101, 99, 100.5]] * 15 + [[101, 101.5, 99.5, 100], [99.9, 101.6, 99.6, 101.2]]
a14 = ind.atr(*[[r[k] for r in rows] for k in (1, 2, 3)], 14)[15]
assert len(det.detect('K08', *[[r[k] for r in rows] for k in range(4)], [1.0] * 17, 'D', {'engBody': 1.3 / a14 - 0.01})) == 1
assert det.detect('K08', *[[r[k] for r in rows] for k in range(4)], [1.0] * 17, 'D', {'engBody': 1.3 / a14 + 0.01}) == []
# B01: the level = the highest high of the 20 candles BEFORE (not the candle itself); only a fresh close above it
h = [10.0] * 20 + [10.5, 10.6, 10.4, 10.0, 10.8]
c = [9.5] * 20 + [10.2, 10.55, 10.3, 9.9, 10.7]
o, l, v = [x - 0.1 for x in c], [x - 0.5 for x in c], [100.0] * 25
b = det.detect('B01', o, h, l, c, v, 'D')
assert [e[1] for e in b] == [20, 24], b                      # 20: 10.2 > 10.0; 21 stays above (no repeat); 24 above 10.6 again
assert b[0][3] == 10.0 and b[0][4] == l[20] and b[1][3] == 10.6
assert [e[1] for e in det.detect('B01', o, h, l, c, v, 'D', {'boBuf': 3.0})] == [], 'close 3 % above: none here'
v2 = v[:24] + [250.0]
assert [e[1] for e in det.detect('B01', o, h, l, c, v2, 'D', {'boVol': 2.0})] == [24], 'volume 2.5x the 20 before'
assert det.detect('B01', o[:20], h[:20], l[:20], c[:20], v[:20], 'D') == [], 'fewer than 20 candles before: no level'
# B03 / B04 lengths per timeframe; B04 waits for its minimum history
assert det.HI_N['B03'] == {'D': 252, 'W': 52, '4H': 504} and det.ATH_MIN == {'D': 252, 'W': 52, '4H': 504}
up = [100 + k * 0.1 for k in range(300)]
assert [e[1] for e in det.detect('B04', up, [x + 0.05 for x in up], [x - 1 for x in up], [x + 0.04 for x in up], [1.0] * 300, 'D')] == [], \
    'a steady rise: above every day (one fresh signal at the start, before the minimum history)'
h4 = [100.0] * 260 + [99.0] * 10 + [101.0]
c4 = [99.0] * 270 + [100.5]
assert [e[1] for e in det.detect('B04', c4, h4, [x - 1 for x in c4], c4, [1.0] * 271, 'D')] == [270]
assert det.detect('B04', c4, h4, [x - 1 for x in c4], c4, [1.0] * 271, 'W')[0][1] == 270
# I01: a made chart - 20 quiet candles, a sharp fall to a swing low (RSI very low), a bounce, a slow drift to a LOWER swing low
# (RSI higher - the fall lost speed), then a rise
cl = [100 + (k % 2) * 0.5 for k in range(20)] + [98 - k * 2 for k in range(10)] + [81 + k for k in range(5)] + \
    [85 - (k + 1) * 0.36 for k in range(15)] + [80 + k for k in range(10)]
hi = [x + 0.5 for x in cl]
lo = [x - 0.5 for x in cl]
_, pl = structure.pivots(hi, lo, 5)
rr = ind.rsi(cl, 14)
pa, pb = 29, 49
assert pl[-2:] == [pa, pb] and lo[pb] < lo[pa] and rr[pb] > rr[pa], (pl, lo[pa], lo[pb], rr[pa], rr[pb])
d1 = det.detect('I01', cl, hi, lo, cl, [1.0] * len(cl), 'D')
assert [e[:3] for e in d1] == [[pb + 5, pb + 5, pa]] and d1[0][4] == lo[pb] and d1[0][3] == max(hi[pb:pb + 6]), d1
assert det.detect('I01', cl, hi, lo, cl, [1.0] * len(cl), 'D', {'divMaxGap': 19}) == [], '20 candles apart > 19'
assert det.detect('I01', cl, hi, lo, cl, [1.0] * len(cl), 'D', {'divRsiMax': rr[pa] - 0.1}) == []
assert len(det.detect('I01', cl, hi, lo, cl, [1.0] * len(cl), 'D', {'divRsiMax': rr[pa] + 0.1})) == 1
assert det.detect('I01', cl[:pb + 5], hi[:pb + 5], lo[:pb + 5], cl[:pb + 5], [1.0] * (pb + 5), 'D') == [], \
    'the 2nd low is not confirmed yet on the candle before'

# ------------------------------------------------------------------ 4b. PHASE 2 (owner, 13-Nov-2026: "Yes do it"): every new pattern on a
# made chart - where it must come (the event on the made candle, its first candle, stop reference) and a changed copy where it
# must not. The yardstick ATR(14) of the calm base = 2 (every true range 2), so a long body >= 1.4, a small one <= 0.6.
CRAFT = {}                       # pid -> the made chart (the causality test below runs on these too)


def base(n=30, kind='calm', v=1000.0):
    rows = []
    for k in range(n):
        if kind == 'calm':
            o, c = 100.0, (100.2 if k % 2 == 0 else 99.8)
            rows.append([o, 101.0, 99.0, c, v])
        elif kind == 'up':
            c = round(100 + 0.3 * k + 0.1, 2)
            o = round(c - 0.2, 2)
            rows.append([o, round(c + 0.9, 2), round(o - 0.9, 2), c, v])
        else:                                  # 'down'
            c = round(110 - 0.3 * k - 0.1, 2)
            o = round(c + 0.2, 2)
            rows.append([o, round(o + 0.9, 2), round(c - 0.9, 2), c, v])
    return rows


def lists(rows):
    rows = [list(r) + [1000.0] * (5 - len(r)) for r in rows]
    return tuple([r[k] for r in rows] for k in range(5))


D0P = date(2015, 1, 5).toordinal()               # a Monday
BENCH = (list(range(D0P, D0P + 4000)), walk(4242, 4000, vol=0.01, start=10000.0)[3])   # a NIFTY 50 stand-in (I23 I24 Q13)


def ev_at(pid, rows, tf='D', P=None, day=True):
    o, h, l, c, v = lists(rows)
    return [e for e in det.detect(pid, o, h, l, c, v, tf, P, day=list(range(D0P, D0P + len(c))) if day else None, bench=BENCH)
            if e[0] == len(c) - 1]


def yes(pid, rows, occ=None, stop=None, P=None):
    got = ev_at(pid, rows, P=P)
    assert len(got) == 1, (pid, 'expected on the last candle', det.detect(pid, *lists(rows), 'D', P)[-3:])
    if occ is not None:
        assert got[0][2] == occ, (pid, 'first candle', got[0])
    if stop is not None:
        assert abs(got[0][4] - stop) < 1e-9, (pid, 'stop reference', got[0])
    CRAFT.setdefault(pid, rows)
    return got[0]


def no(pid, rows, P=None):
    assert ev_at(pid, rows, P=P) == [], (pid, 'not expected on the last candle')


B = base()
N = len(B)                                       # the made candles start at index 30; the base ends red (99.8)
assert ind.atr(*[[r[k] for r in B] for k in (1, 2, 3)], 14)[-1] == 2.0
# single candles
yes('K01', B + [[99, 99.5, 96.5, 99.4]], occ=N, stop=96.5); no('K01', B + [[99, 99.9, 96.5, 99.4]])      # upper shadow too long
yes('K02', B + [[99, 101.6, 98.95, 99.4]]); no('K02', B + [[99, 101.6, 98.5, 99.4]])                     # lower shadow too long
yes('K03', B + [[99.4, 99.45, 96.4, 99.42]]); no('K03', B + [[99.4, 99.9, 96.4, 99.42]])
yes('K04', B + [[99.0, 101.55, 98.95, 101.5]]); no('K04', B + [[99.0, 101.55, 98.5, 101.5]])
yes('K05', B + [[99.0, 101.8, 98.98, 101.5]]); no('K05', B + [[100.0, 102.8, 99.98, 102.5]])            # opened above the close before
yes('K06', B + [[99.5, 100.2, 97.0, 100.0]]); no('K06', B + [[99.5, 100.2, 97.0, 98.0]])
yes('K07', B + [[99.0, 101.5, 98.7, 101.5]]); no('K07', B + [[99.0, 101.6, 98.7, 101.5]])
# two candles
yes('K09', B + [[100, 100.3, 97.9, 98.0], [97.5, 99.6, 97.4, 99.5]], occ=N, stop=97.4)
no('K09', B + [[100, 100.3, 97.9, 98.0], [97.5, 99.6, 97.4, 98.8]])
yes('K10', B + [[100.5, 100.7, 97.8, 98.0], [98.3, 99.5, 98.1, 99.2]]); no('K10', B + [[100.5, 100.7, 97.8, 98.0], [98.3, 99.5, 97.7, 99.2]])
yes('K11', B + [[100.5, 100.7, 97.8, 98.0], [99.0, 99.6, 98.6, 99.05]]); no('K11', B + [[100.5, 100.7, 97.8, 98.0], [97.9, 99.6, 97.85, 97.95]])
yes('K12', B + [[100, 100.3, 98.5, 99.0], [99.0, 100.1, 98.5, 100.0]]); no('K12', B + [[100, 100.3, 98.5, 99.0], [98.5, 100.1, 98.5, 100.0]])
yes('K13', B + [[100.8, 101, 98.9, 99.0], [99.8, 100, 98.8, 99.05]]); no('K13', B + [[100.8, 101, 98.9, 99.0], [99.8, 100, 98.7, 98.8]])
yes('K14', B + [[101, 101.2, 98.9, 99.0], [97.5, 99.2, 97.4, 99.05]]); no('K14', B + [[101, 101.2, 98.9, 99.0], [97.5, 99.4, 97.4, 99.3]])
yes('K15', B + [[101.0, 101.05, 99.0, 99.05], [101.2, 103.25, 101.15, 103.2]]); no('K15', B + [[101.0, 101.05, 99.0, 99.05], [101.05, 103.25, 101.0, 103.2]])
U = base(kind='up')                              # a rising base (close above its rising 20-SMA)
yes('K16', U + [[109.6, 109.8, 108.5, 108.8], [109.62, 111.6, 109.6, 111.5]]); no('K16', U + [[109.6, 109.8, 108.5, 108.8], [109.3, 111.6, 109.28, 111.5]])
no('K16', B + [[100.6, 100.8, 99.5, 99.8], [100.62, 102.6, 100.6, 102.5]])                               # no uptrend before
# three or more candles
RED = [102, 102.2, 99.4, 99.5]
yes('K17', B + [RED, [99.3, 99.6, 98.9, 99.2], [99.3, 101.5, 99.2, 101.4]], occ=N); no('K17', B + [RED, [99.3, 99.6, 98.9, 99.2], [99.3, 101.5, 99.2, 100.5]])
yes('K18', B + [RED, [99.0, 99.3, 98.6, 99.02], [99.3, 101.5, 99.2, 101.4]]); no('K18', B + [RED, [99.6, 99.8, 99.2, 99.62], [99.3, 101.5, 99.2, 101.4]])
yes('K19', B + [[99.9, 101.7, 99.8, 101.6], [101.0, 102.8, 100.9, 102.7], [102.0, 103.8, 101.9, 103.7]])
no('K19', B + [[99.9, 101.7, 99.8, 101.6], [101.0, 102.8, 100.9, 102.7], [103.0, 104.8, 102.9, 104.7]])
yes('K20', B + [RED, [99.8, 100.9, 99.6, 100.7], [100.8, 102.6, 100.7, 102.5]]); no('K20', B + [RED, [99.8, 100.9, 99.6, 100.7], [100.8, 102, 100.7, 101.8]])
yes('K21', B + [[100.5, 100.7, 99.3, 99.5], [99.4, 101.0, 99.2, 100.8], [100.9, 101.8, 100.8, 101.6]])
no('K21', B + [[100.5, 100.7, 99.3, 99.5], [99.4, 101.0, 99.2, 100.8], [100.5, 101, 100.4, 100.7]])
yes('K22', B + [[102, 102.1, 98.5, 99.6], [100.8, 100.9, 99.0, 99.8], [99.7, 99.72, 99.38, 99.4]])
no('K22', B + [[102, 102.1, 98.5, 99.6], [100.8, 100.9, 98.4, 99.8], [99.7, 99.72, 99.38, 99.4]])
yes('K23', B + [RED, [98.8, 99.2, 98.4, 98.82], [99.5, 101.2, 99.3, 101.0]]); no('K23', B + [RED, [98.8, 99.2, 98.4, 98.82], [99.5, 101.2, 99.1, 101.0]])
yes('K24', B + [[100.5, 100.7, 99.3, 99.5], [99.6, 101.0, 99.5, 100.8], [101.0, 101.2, 99.4, 99.55]])
no('K24', B + [[100.5, 100.7, 99.3, 99.5], [99.6, 101.0, 99.5, 100.8], [101.0, 101.2, 98.9, 99.0]])
yes('K25', B + [[102, 102.05, 99.95, 100.0], [100.0, 100.05, 97.95, 98.0], [97.5, 98.3, 97.0, 97.2], [98.4, 98.5, 96.5, 96.8]], occ=N)
no('K25', B + [[102, 102.05, 99.95, 100.0], [100.0, 100.05, 97.95, 98.0], [97.5, 98.3, 97.0, 97.2], [98.4, 98.5, 96.9, 97.1]])
C1 = [108.8, 111.4, 108.7, 111.2]
yes('K26', U + [C1, [111.0, 111.2, 110.0, 110.3], [110.3, 110.6, 109.6, 109.9], [109.9, 110.5, 109.5, 110.2], [110.3, 112.2, 110.2, 112.0]], occ=N)
no('K26', U + [C1, [111.0, 111.2, 110.0, 110.3], [110.3, 110.6, 108.5, 109.9], [109.9, 110.5, 109.5, 110.2], [110.3, 112.2, 110.2, 112.0]])
yes('K27', U + [C1, [111.6, 112.0, 111.3, 111.9], [111.8, 111.9, 110.8, 111.0], [111.0, 111.3, 110.4, 110.6], [110.7, 112.5, 110.6, 112.3]])
no('K27', U + [C1, [111.6, 112.0, 111.3, 111.9], [111.8, 111.9, 110.8, 111.0], [111.0, 111.3, 109.8, 110.6], [110.7, 112.5, 110.6, 112.3]])
# the trend context: "after a fall" keeps a hammer after a falling base, not after the calm one
DN = base(kind='down')
HAM = [[DN[-1][3] - 0.8, DN[-1][3] - 0.3, DN[-1][3] - 3.3, DN[-1][3] - 0.4]]
yes('K01', DN + HAM, P={'patCtx': 'down'}); no('K01', B + [[99, 99.5, 96.5, 99.4]], P={'patCtx': 'down'})
assert reg.SPECS['K01']['ctx'] and not reg.SPECS['K16'].get('ctx') and not reg.SPECS['B01'].get('ctx')
# breakouts
flat = lambda n, hi=101.0, lo=99.0, v=1000.0: [[100.0, hi, lo, 100.2 if k % 2 == 0 else 99.8, v] for k in range(n)]
r5 = flat(140)
r5[20] = [100.0, 105.0, 99.0, 104.0, 1000.0]                     # the old high (index 20)
yes('B05', r5 + [[100.0, 106.0, 99.9, 105.5]], stop=99.9)
r5b = [list(r) for r in r5]
r5b[100] = [100.0, 105.2, 99.0, 104.0, 1000.0]                   # a newer high: not an old resistance
no('B05', r5b + [[100.0, 106.0, 99.9, 105.5]])
r6 = flat(70)
for k in (20, 35, 50):
    r6[k] = [100.0, 103.0, 99.0, 102.0, 1000.0]
yes('B06', r6 + [[102.0, 104.0, 101.9, 103.5]])
r6b = [list(r) for r in r6]
r6b[35] = [100.0, 101.0, 99.0, 100.2, 1000.0]
no('B06', r6b + [[102.0, 104.0, 101.9, 103.5]])
NARROW = [100.0, 100.4, 99.6, 100.1]
for pid in ('B07', 'B08', 'B09'):
    yes(pid, B + [NARROW, [100.1, 101, 99.9, 100.8]], occ=N, stop=99.6)
    no(pid, B + [NARROW, [100.1, 101, 99.9, 100.3]])
no('B08', B + [[100.0, 101.3, 98.8, 100.1], [100.1, 102, 99.9, 101.4]])                                # the widest, not the narrowest
yes('B10', B + [[100, 103, 97, 101], [100.5, 102, 98, 101], [101, 102.5, 99, 100], [100.5, 104, 100, 103.5]], occ=N, stop=97)
no('B10', B + [[100, 103, 97, 101], [100.5, 102, 98, 101], [101, 102.5, 99, 100], [100.5, 103.1, 100, 102.8]])
noisy = [[100.0, 101.5, 98.5, 101.0 if k % 2 == 0 else 99.0, 1000.0] for k in range(140)]
quiet = [[100.0, 100.3, 99.7, 100.05 if k % 2 == 0 else 99.95, 1000.0] for k in range(20)]
yes('B11', noisy + quiet + [[100.0, 102.0, 99.9, 101.5]]); no('B11', noisy + noisy[:21])
yes('B12', noisy + quiet + [[100.0, 104.2, 99.9, 104.0]]); no('B12', noisy + noisy[:21])
yes('B13', flat(60) + [[100.0, 102.0, 99.9, 101.5]]); no('B13', flat(60) + [[100.0, 102.0, 99.9, 100.9]])
dv = [[99.0, 100.0, 98.0, 99.5, 1000.0] for _ in range(15)] + [[100.0, 105.0, 99.5, 104.0], [103.0, 104.0, 101.0, 102.0],
                                                               [102.0, 103.0, 101.0, 102.0], [101.5, 102.5, 100.8, 101.0],
                                                               [101.0, 101.5, 100.0, 100.5], [100.6, 101.5, 100.5, 101.0],
                                                               [101.0, 102.0, 100.5, 101.5], [101.5, 103.0, 100.6, 102.5]]
yes('B14', dv + [[102.5, 106.0, 102.4, 105.5]], occ=15, stop=100.0)
dvb = [list(r) for r in dv]
dvb[21] = [101.0, 102.0, 99.5, 101.5]                            # a new low: the box is not known yet when price breaks out
no('B14', dvb + [[102.5, 106.0, 102.4, 105.5]])
yes('B16', flat(25) + [[100.5, 101.8, 100.4, 101.5], [101.3, 101.4, 101.0, 101.2]], stop=101.0)
no('B16', flat(25) + [[100.5, 101.8, 100.4, 101.5], [100.0, 100.2, 98.0, 98.5], [101.3, 101.4, 101.0, 101.2]])
wide = [[100.0, 102.0, 98.0, 100.5 if k % 2 == 0 else 99.5, 1000.0] for k in range(40)]
tight = [[100.0, 100.5, 99.5, 100.1 if k % 2 == 0 else 99.9, 1000.0] for k in range(25)]
a17 = ind.atr(*[[r[k] for r in wide + tight] for k in (1, 2, 3)], 14)
assert a17[-1] <= 0.75 * a17[-21] and a17[-1] == min(a17[-20:])
yes('B17', wide + tight + [[100.0, 100.0 + 2.2 * a17[-1], 99.95, 100.0 + 2.1 * a17[-1]]])
no('B17', wide + tight + [[100.0, 100.0 + 1.5 * a17[-1], 99.95, 100.0 + 1.4 * a17[-1]]])
yes('B18', flat(30) + [[100.5, 102.0, 100.4, 101.5]], occ=0)
b18 = flat(30)
b18[5] = [100.0, 101.0, 85.0, 99.8, 1000.0]
no('B18', b18 + [[100.5, 102.0, 100.4, 101.5]])
r19 = [[100.0, 100.0, 98.0, 99.5, 1000.0] for _ in range(45)]
r19[10] = [100.0, 103.0, 98.0, 99.5, 1000.0]
for k in (37, 40, 43):
    r19[k] = [100.0, 102.0, 98.0, 99.5, 1000.0]
for k in range(40, 45):
    r19[k][2] = 99.0
yes('B19', r19 + [[100.0, 104.0, 99.5, 103.5]])
r19b = [list(r) for r in r19]
r19b[40][1] = 100.0
no('B19', r19b + [[100.0, 104.0, 99.5, 103.5]])
yes('B20', flat(250) + [[100.0, 102.0, 99.9, 101.5]]); no('B20', flat(250) + [[100.0, 102.0, 99.9, 100.8]])
# moving averages: a rising chart, a pullback, a candle whose low comes to the rising EMA (worked out from the EMA itself)


def pull_chart(n, slope=0.2, tail=None):
    rows = []
    for k in range(3 * n):
        c = 100 + slope * k
        rows.append([c - 0.1, c + 0.3, c - 0.4, c, 1000.0])
    last = rows[-1][3]
    for k in range(1, 4):                       # three lower closes, lows still clearly above the EMA
        c = last - 0.15 * k
        rows.append([c + 0.05, c + 0.2, c - 0.05, c, 1000.0])
    closes = [r[3] for r in rows]
    c_new = closes[-1] + 0.1
    e = ind.ema(closes + [c_new], n)[-1]
    return rows + [[e * 1.001, c_new + 0.1, e * (1.0 if tail is None else tail), c_new, 1000.0]]


for n_, pid in ((20, 'M01'), (50, 'M02'), (100, 'M03'), (200, 'M04')):
    rows = pull_chart(n_)
    e_ = ind.ema([r[3] for r in rows], n_)
    assert all(rows[j][2] > e_[j] * 1.005 for j in range(len(rows) - 4, len(rows) - 1)), (pid, 'the lows before stay above')
    yes(pid, rows)
    no(pid, pull_chart(n_, tail=1.01))                           # the low did not come to the EMA
# crosses / states / reclaim / Supertrend: the signal candle = an independent count of the definition on made trends
wave = [100 + 15 * math.sin(k / 40.0) + 0.02 * k for k in range(700)]
WAVE = [[c - 0.2, c + 0.6, c - 0.6, c, 1000.0 + 300 * math.sin(k / 7.0)] for k, c in enumerate(wave)]
wo, wh, wl, wc, wv = lists(WAVE)
s50, s200, e20, e50 = ind.sma(wc, 50), ind.sma(wc, 200), ind.ema(wc, 20), ind.ema(wc, 50)
x5 = [i for i in range(1, 700) if None not in (s50[i], s200[i], s50[i - 1], s200[i - 1]) and s50[i] > s200[i] and s50[i - 1] <= s200[i - 1]]
assert x5 and [e[0] for e in det.detect('M05', wo, wh, wl, wc, wv, 'D')] == x5
x6 = [i for i in range(1, 700) if None not in (e20[i], e50[i], e20[i - 1], e50[i - 1]) and e20[i] > e50[i] and e20[i - 1] <= e50[i - 1]]
assert x6 and [e[0] for e in det.detect('M06', wo, wh, wl, wc, wv, 'D')] == x6
for pid in ('M05', 'M06', 'M07', 'M08', 'M09', 'M10', 'M12'):
    got = det.detect(pid, wo, wh, wl, wc, wv, 'D')
    assert got, pid
    CRAFT.setdefault(pid, WAVE)
e200 = ind.ema(wc, 200)
st7 = [i >= 5 and None not in (e50[i], e200[i], e50[i - 5], e200[i - 5]) and wc[i] > e50[i] > e200[i] and e50[i] > e50[i - 5] and
       e200[i] > e200[i - 5] for i in range(700)]
assert [e[0] for e in det.detect('M07', wo, wh, wl, wc, wv, 'D')] == [i for i in range(1, 700) if st7[i] and not st7[i - 1]]
assert [e[0] for e in det.detect('M09', wo, wh, wl, wc, wv, 'D')] == \
    [i for i in range(10, 700) if e50[i] is not None and wc[i] > e50[i] and all(e50[j] is not None and wc[j] < e50[j] for j in range(i - 10, i))]
# Supertrend by hand: a fall then a jump - the trend turns up on the first close above the carried upper band
ST = [[100 - 0.5 * k, 100.5 - 0.5 * k, 99.2 - 0.5 * k, 99.6 - 0.5 * k, 1000.0] for k in range(40)] + [[80.0, 92.0, 79.9, 91.5, 1000.0]]
a10 = ind.atr(*[[r[k] for r in ST] for k in (1, 2, 3)], 10)
fu = None
for k in range(9, 40):
    bu = (ST[k][1] + ST[k][2]) / 2 + 3 * a10[k]
    fu = bu if (fu is None or bu < fu or ST[k - 1][3] > fu) else fu
    assert k == 9 or ST[k][3] <= fu, 'no close above the carried band before'
bu = (ST[40][1] + ST[40][2]) / 2 + 3 * a10[40]
fu40 = bu if (bu < fu or ST[39][3] > fu) else fu
assert ST[40][3] > fu40 == fu, 'the jump closes above the carried band (the new band is higher - not taken)'
yes('M12', ST)
assert [e[0] for e in det.detect('M12', *lists(ST[:-1]), 'D')] == []
# M11: weekly (finished weeks only) + daily; worked out a second way - the weekly closes of the weeks BEFORE the day's week
DAYS = []
d_ = date(2015, 1, 5)
while len(DAYS) < 700:
    if d_.weekday() < 5:
        DAYS.append(d_.toordinal())
    d_ += timedelta(days=1)
m11 = det.detect('M11', wo, wh, wl, wc, wv, 'D', day=DAYS)
assert m11 and det.detect('M11', wo, wh, wl, wc, wv, 'D') == [], 'no day ordinals = nothing (never a guess)'
wk = {}
for i, dd in enumerate(DAYS):
    wk[dd - (dd - 1) % 7] = wc[i]                # the last close of each week
keys = sorted(wk)
hc = [wk[k_] for k_ in keys]
h10, h20 = ind.ema(hc, 10), ind.ema(hc, 20)


def both11(i):
    kk = keys.index(DAYS[i] - (DAYS[i] - 1) % 7) - 1
    return (kk >= 0 and h20[kk] is not None and e50[i] is not None and hc[kk] > h10[kk] > h20[kk] and wc[i] > e20[i] > e50[i])


assert [e[0] for e in m11] == [i for i in range(1, 700) if both11(i) and not both11(i - 1)]
CRAFT['M11'] = WAVE
# volume
V = base()
yes('V01', V + [[100, 100.2, 98.0, 98.5, 3000], [98.6, 99.8, 98.5, 99.5, 1000]], occ=N)
no('V01', V + [[100, 100.2, 98.0, 98.5, 2000], [98.6, 99.8, 98.5, 99.5, 1000]])
yes('V02', V + [[99.5, 100.4, 97.5, 99.6, 4000]]); no('V02', V + [[99.5, 100.4, 97.5, 98.5, 4000]])
fall6 = [[c + 0.3, c + 0.5, c - 0.2, c, 1000.0] for c in (99.5, 99.0, 98.5, 98.0, 97.5, 97.0)]
yes('V03', V + fall6 + [[97.1, 98.8, 97.0, 98.6, 2500]]); no('V03', V + fall6 + [[97.1, 98.8, 97.0, 98.6, 1500]])
dry = flat(60) + flat(10, v=400.0)
yes('V04', dry + [[100.5, 102.0, 100.4, 101.8, 1000]]); no('V04', flat(60) + flat(10, v=800.0) + [[100.5, 102.0, 100.4, 101.8, 1000]])
yes('V05', V + [[100.0, 100.8, 99.5, 100.3, 1100], [100.3, 100.9, 99.8, 100.5, 1300], [100.5, 102.0, 100.4, 101.5, 1800]])
no('V05', V + [[100.0, 100.8, 99.5, 100.3, 1100], [100.3, 100.9, 99.8, 100.5, 900], [100.5, 102.0, 100.4, 101.5, 1800]])
yes('V06', flat(55) + [[100.5, 102.0, 100.4, 101.5, 3500]]); no('V06', flat(55) + [[100.5, 102.0, 100.4, 101.5, 2500]])
yes('V07', V + [[100.0, 100.8, 99.9, 100.5, 1100], [100.5, 101.2, 100.4, 101.0, 1200], [101.0, 101.7, 100.9, 101.5, 1300]])
no('V07', V + [[100.0, 100.8, 99.9, 100.5, 1100], [100.5, 101.2, 100.4, 101.0, 1300], [101.0, 101.7, 100.9, 101.5, 1200]])
UP8 = base(80, 'up')
top8 = UP8[-1][3]
pb = [[top8 - 0.3 * k + 0.1, top8 - 0.3 * k + 0.3, top8 - 0.3 * k - 0.3, top8 - 0.3 * k, 300.0] for k in range(1, 5)]
yes('V08', UP8 + pb + [[pb[-1][3], pb[-1][2] + 1.5, pb[-1][3] - 0.1, pb[-1][2] + 1.4, 1200]])
pb9 = [r[:4] + [900.0] for r in pb]
no('V08', UP8 + pb9 + [[pb[-1][3], pb[-1][2] + 1.5, pb[-1][3] - 0.1, pb[-1][2] + 1.4, 1200]])
UP12 = base(70, 'up')
P12 = UP12[-1][3]
yes('V12', UP12 + [[P12, P12 + 0.3, P12 - 0.7, P12 - 0.2, 800]]); no('V12', UP12 + [[P12, P12 + 0.3, P12 - 0.7, P12 - 0.2, 1200]])
DN13 = base(30, 'down')
P13 = DN13[-1][3]
yes('V13', DN13 + [[P13 - 0.5, P13 + 0.2, P13 - 3.0, P13 + 0.1, 2500]]); no('V13', DN13 + [[P13 - 0.5, P13 + 0.2, P13 - 3.0, P13 + 0.1, 1500]])
yes('V15', r6 + [[102.0, 104.0, 101.9, 103.5, 1600]]); no('V15', r6 + [[102.0, 104.0, 101.9, 103.5, 1300]])
assert sorted(CRAFT) == sorted(reg.P2), sorted(set(reg.P2) - set(CRAFT))

# ------------------------------------------------------------------ 4c. PHASE 3 (owner, 13-Nov-2026: "Do it"): the new indicators an
# independent second way (brute force / another smoothing / properties), the patterns built on indicator crosses recounted from
# those series, made charts for the structure / SMC / rare patterns (the event where it must come, a changed copy where it must
# not), and properties of every phase-3 event on random charts.
import pattern_p3 as p3  # noqa: E402

P3_IDS = sorted(p3.DETECTORS)
assert len(P3_IDS) == 102 and all(p in reg.SPECS for p in P3_IDS), [p for p in P3_IDS if p not in reg.SPECS]
assert set(reg.implemented()) == set(det.DETECTORS) and len(reg.implemented()) == 192
o3, h3, l3, c3, v3 = walk(303, 400, vol=0.04)
n3 = len(c3)


def brute_max(x, n, i):
    return max(x[i - n + 1:i + 1])


rmx, rmn = ind.rolling_max(h3, 9), ind.rolling_min(l3, 9)
assert all(rmx[i] is None for i in range(8)) and all(rmx[i] == brute_max(h3, 9, i) and rmn[i] == min(l3[i - 8:i + 1])
                                                   for i in range(8, n3))


def ema_ref(xs, n):                       # seeded with the mean of the first n KNOWN values
    out, prev, buf = [], None, []
    for x in xs:
        if x is None:
            out.append(None)
            continue
        if prev is None:
            buf.append(x)
            if len(buf) == n:
                prev = sum(buf) / n
            out.append(prev)
        else:
            prev = prev + 2.0 / (n + 1) * (x - prev)
            out.append(prev)
    return out


ml, ms, mh = ind.macd(c3)
e12, e26 = ema_ref(c3, 12), ema_ref(c3, 26)
line = [None if a is None or b is None else a - b for a, b in zip(e12, e26)]
sig = ema_ref(line, 9)
assert all(near(a, b, 1e-9) for a, b in zip(ml, line)) and all(near(a, b, 1e-9) for a, b in zip(ms, sig))
assert ml[24] is None and ml[25] is not None and ms[32] is None and ms[33] is not None
assert all(near(a, (b - s) if b is not None and s is not None else None, 1e-9) for a, b, s in zip(mh, ml, ms))

sk, sd = ind.stochastic(h3, l3, c3)
raw = [None] * n3
for i in range(13, n3):
    hh, ll = max(h3[i - 13:i + 1]), min(l3[i - 13:i + 1])
    raw[i] = 50.0 if hh == ll else 100.0 * (c3[i] - ll) / (hh - ll)
for i in range(n3):
    k_ = None if i < 15 else sum(raw[i - 2:i + 1]) / 3
    d_ = None if i < 17 else sum(sum(raw[j - 2:j + 1]) / 3 for j in range(i - 2, i + 1)) / 3
    assert near(sk[i], k_, 1e-9) and near(sd[i], d_, 1e-9), i
assert ind.stochastic([5.0] * 20, [5.0] * 20, [5.0] * 20)[0][-1] == 50.0      # no range = 50

cc = ind.cci(h3, l3, c3, 20)
for i in range(19, n3):
    tp = [(h3[j] + l3[j] + c3[j]) / 3 for j in range(i - 19, i + 1)]
    m_ = sum(tp) / 20
    md = sum(abs(t - m_) for t in tp) / 20
    assert near(cc[i], (tp[-1] - m_) / (0.015 * md), 1e-7), i
assert ind.cci([2.0] * 25, [1.0] * 25, [1.5] * 25, 20)[-1] == 0.0

mf = ind.mfi(h3, l3, c3, v3, 14)
tp3 = [(a + b + d) / 3 for a, b, d in zip(h3, l3, c3)]
for i in range(n3):
    if i < 14:
        assert mf[i] is None
        continue
    pos = sum(tp3[j] * v3[j] for j in range(i - 13, i + 1) if tp3[j] > tp3[j - 1])
    neg = sum(tp3[j] * v3[j] for j in range(i - 13, i + 1) if tp3[j] < tp3[j - 1])
    assert near(mf[i], 100 - 100 / (1 + pos / neg) if neg else 100.0, 1e-7), i

ob3, ad3 = ind.obv(c3, v3), ind.ad_line(h3, l3, c3, v3)
for i in range(1, n3):
    assert ob3[i] == sum(v3[j] * ((c3[j] > c3[j - 1]) - (c3[j] < c3[j - 1])) for j in range(1, i + 1))
    rng_ = h3[i] - l3[i]
    assert near(ad3[i] - ad3[i - 1], (2 * c3[i] - h3[i] - l3[i]) / max(rng_, 0.01) * v3[i], 1e-6)

# +DI / -DI / ADX with Wilder's SUM smoothing (first = the sum of n, then s - s / n + x) - the ratios equal the mean form's
pdi, mdi, adx = ind.dmi(h3, l3, c3, 14)
trs, pps, mms = [], [], []
for i in range(1, n3):
    up_, dn_ = h3[i] - h3[i - 1], l3[i - 1] - l3[i]
    pps.append(up_ if up_ > dn_ and up_ > 0 else 0.0)
    mms.append(dn_ if dn_ > up_ and dn_ > 0 else 0.0)
    trs.append(max(h3[i] - l3[i], abs(h3[i] - c3[i - 1]), abs(l3[i] - c3[i - 1])))


def wsum(xs, n):
    out, s = [], None
    for k, x in enumerate(xs):
        if k == n - 1:
            s = sum(xs[:n])
        elif k >= n:
            s = s - s / n + x
        out.append(s)
    return out


st_, sp_, sm_ = wsum(trs, 14), wsum(pps, 14), wsum(mms, 14)
dxs = []
for k in range(len(trs)):
    if st_[k] is None:
        continue
    p_, m_ = 100 * sp_[k] / st_[k], 100 * sm_[k] / st_[k]
    assert near(pdi[k + 1], p_, 1e-7) and near(mdi[k + 1], m_, 1e-7)
    dxs.append((k + 1, 100 * abs(p_ - m_) / (p_ + m_)))
a_ = sum(d for _, d in dxs[:14]) / 14
assert near(adx[dxs[13][0]], a_, 1e-7) and adx[dxs[12][0]] is None
for idx, d in dxs[14:]:
    a_ = (a_ * 13 + d) / 14
    assert near(adx[idx], a_, 1e-7)

rc = ind.roc(c3, 12)
assert all(rc[i] is None for i in range(12)) and all(near(rc[i], 100 * (c3[i] / c3[i - 12] - 1), 1e-9) for i in range(12, n3))
ts, tss = ind.tsi(c3)
mo = [None] + [c3[i] - c3[i - 1] for i in range(1, n3)]
num, den = ema_ref(ema_ref(mo, 25), 13), ema_ref(ema_ref([None] + [abs(x) for x in mo[1:]], 25), 13)
tref = [None if a is None else 100 * a / b for a, b in zip(num, den)]
assert all(near(a, b, 1e-7) for a, b in zip(ts, tref)) and all(near(a, b, 1e-7) for a, b in zip(tss, ema_ref(tref, 7)))
au, adn = ind.aroon(h3, l3, 25)
for i in range(25, n3):
    w_ = list(range(i - 25, i + 1))
    bh_ = max(w_, key=lambda j: (h3[j], j))
    bl_ = min(w_, key=lambda j: (l3[j], -j))
    assert au[i] == 100.0 * (25 - (i - bh_)) / 25 and adn[i] == 100.0 * (25 - (i - bl_)) / 25
# Parabolic SAR: under the lows in an up trend, over the highs in a down trend; a flip puts the SAR on the other trend's extreme
sar, tr3 = ind.psar(h3, l3, c3)
t0, flips = 1, 0
for i in range(2, n3):
    assert (sar[i] <= l3[i] + 1e-9) if tr3[i] == 1 else (sar[i] >= h3[i] - 1e-9), i
    if tr3[i] != tr3[i - 1]:
        flips += 1
        ext = min(l3[t0:i + 1]) if tr3[i] == 1 else max(h3[t0:i + 1])
        assert near(sar[i], ext, 1e-9), (i, sar[i], ext)
        t0 = i
assert flips > 10
pr = ind.pct_rank(c3, 50)
assert all(pr[i] is None for i in range(50)) and all(near(pr[i], 100.0 * sum(1 for x in c3[i - 50:i] if x <= c3[i]) / 50, 1e-9)
                                                     for i in range(50, n3))
ls = ind.linreg_slope(c3, 20)
for i in range(19, n3, 7):
    w_ = c3[i - 19:i + 1]
    my_ = sum(w_) / 20
    assert near(ls[i], sum((k - 9.5) * (w_[k] - my_) for k in range(20)) / sum((k - 9.5) ** 2 for k in range(20)), 1e-7)
tk, kj, sa, sb = ind.ichimoku(h3, l3)
for i in range(51, n3):
    assert near(tk[i], (max(h3[i - 8:i + 1]) + min(l3[i - 8:i + 1])) / 2, 1e-9)
    assert near(kj[i], (max(h3[i - 25:i + 1]) + min(l3[i - 25:i + 1])) / 2, 1e-9)
    assert near(sb[i], (max(h3[i - 51:i + 1]) + min(l3[i - 51:i + 1])) / 2, 1e-9) and near(sa[i], (tk[i] + kj[i]) / 2, 1e-9)

# the patterns that are an indicator cross: recounted from the series checked above (signal candles + stop references)
rs3 = ind.rsi(c3, 14)
mid3 = ind.sma(c3, 20)
sd3 = ind.stdev(c3, 20)
up3 = [None if m is None else m + 2 * s for m, s in zip(mid3, sd3)]
lo3 = [None if m is None else m - 2 * s for m, s in zip(mid3, sd3)]
pb3 = [None if u is None or u == q else (c3[i] - q) / (u - q) for i, (u, q) in enumerate(zip(up3, lo3))]
z50 = [None if m is None or not s else (c3[i] - m) / s for i, (m, s) in enumerate(zip(ind.sma(c3, 50), ind.stdev(c3, 50)))]


def cu(a, b, i):
    bi, bj = (b[i], b[i - 1]) if isinstance(b, list) else (b, b)
    return i >= 1 and None not in (a[i], a[i - 1], bi, bj) and a[i] > bi and a[i - 1] <= bj


grn = lambda i: c3[i] > o3[i]  # noqa: E731
CROSS = {
    'I04': (lambda i: cu(rs3, 50.0, i) and i >= 10 and any(x is not None and x < 40 for x in rs3[i - 10:i]), 10),
    'I05': (lambda i: cu(rs3, 30.0, i), 10),
    'I06': (lambda i: cu(ml, ms, i) and ml[i] < 0 and ms[i] < 0, 10),
    'I07': (lambda i: cu(ml, 0.0, i), 20),
    'I09': (lambda i: cu(sk, sd, i) and sk[i - 1] < 20 and sd[i - 1] < 20, 10),
    'I10': (lambda i: cu(sk, 20.0, i), 10),
    'I11': (lambda i: cu(cc, -100.0, i), 10),
    'I15': (lambda i: cu(adx, 25.0, i) and pdi[i] > mdi[i], 10),
    'I16': (lambda i: cu(rc, 0.0, i) and i >= 20 and any(x is not None and x <= -5 for x in rc[i - 20:i]), 20),
    'I17': (lambda i: cu(ts, tss, i) and ts[i] < 0, 10),
    'I18': (lambda i: cu(au, adn, i) and au[i] >= 50, 10),
    'I20': (lambda i: lo3[i - 1] is not None and c3[i - 1] < lo3[i - 1] and c3[i] > lo3[i] and grn(i), 2),
    'I21': (lambda i: i >= 25 and mid3[i] is not None and up3[i] > c3[i] > mid3[i] and all(c3[j] < mid3[j] for j in range(i - 5, i)), 6),
    'M14': (lambda i: cu(tk, kj, i), 10),
    'M15': (lambda i: cu(sa, sb, i), 10),
    'Q02': (lambda i: cu(z50, -2.0, i), 5),
    'Q03': (lambda i: cu(pb3, 0.5, i) and i >= 5 and any(x is not None and x < 0 for x in pb3[i - 5:i]), 6),
}
for pid, (cond, look) in CROSS.items():
    want = [[i, i, i, h3[i], min(l3[max(0, i - look + 1):i + 1])] for i in range(1, n3) if cond(i)]
    got = [e[:5] for e in det.detect(pid, o3, h3, l3, c3, v3, 'D')]
    assert got == want, (pid, got[:3], want[:3])
    assert want or pid in ('I15', 'Q02', 'Q03', 'I09', 'I16', 'I20'), pid
fl = [i for i in range(2, n3) if tr3[i] == 1 and tr3[i - 1] == -1]
assert [e[0] for e in det.detect('I19', o3, h3, l3, c3, v3, 'D')] == fl and fl

# made charts (zig = straight legs through the given (candle, close) points: open = the close before, high / low 0.2 beyond
# the body, so the turning points are clean swings)


def zig(points, vu=1000.0, vd=1000.0, w=0.2):
    rows, prev = [], points[0][1]
    for (a, pa), (b, pb) in zip(points, points[1:]):
        for k in range(a + (1 if rows else 0), b + 1):
            c = round(pa + (pb - pa) * (k - a) / float(b - a), 2)
            o = prev if rows else c
            rows.append([o, round(max(o, c) + w, 2), round(min(o, c) - w, 2), c, vu if c > o else vd])
            prev = c
    return rows


def calm3(n=30, v=1000.0, w=1.0):
    return [[100.0, 100.0 + w, 100.0 - w, 100.2 if k % 2 == 0 else 99.8, v] for k in range(n)]


def on(pid, rows, at, occ=None, stop=None):
    """The pattern exactly on candle `at` of the made chart (cut there) - via yes(), so the chart joins CRAFT."""
    return yes(pid, rows[:at + 1], occ=occ, stop=stop)


Z1 = zig([(0, 105), (6, 112), (12, 100), (18, 115), (24, 104), (32, 110)])
on('P01', Z1, 29, occ=12, stop=103.8)
no('P01', zig([(0, 105), (6, 112), (12, 100), (18, 115), (24, 98), (32, 110)])[:30])                    # a lower low
Z2 = zig([(0, 105), (6, 110), (12, 100), (18, 106), (22, 102)])
yes('P02', Z2 + [[101.5, 101.8, 99.0, 99.5], [99.6, 100.5, 99.4, 100.2], [100.2, 102.0, 100.1, 101.9]], occ=23, stop=99.0)
no('P02', Z2 + [[101.5, 101.8, 99.0, 99.5], [99.6, 100.5, 99.4, 100.2], [100.2, 102.0, 100.1, 101.7]])
yes('P03', zig([(0, 100), (6, 115), (12, 104), (18, 111), (24, 103), (30, 112)]), occ=18)
no('P03', zig([(0, 100), (6, 115), (12, 104), (18, 111), (24, 103), (30, 111.0)]))
on('P04', zig([(0, 100), (6, 120), (12, 105), (18, 115), (24, 100), (30, 118), (36, 110)]), 35, stop=99.8)
no('P04', zig([(0, 100), (6, 120), (12, 105), (18, 115), (24, 100), (30, 114), (36, 110)])[:36])
on('P05', zig([(0, 120), (6, 125), (12, 110), (18, 118), (24, 105), (30, 112), (36, 108), (42, 115)]), 41, stop=107.8)
no('P05', zig([(0, 120), (6, 125), (12, 110), (18, 118), (24, 105), (30, 112), (36, 103), (42, 115)])[:42])
Z6 = zig([(0, 100), (6, 130), (12, 115), (18, 125), (24, 110), (30, 120), (36, 104), (44, 124)])
e6 = on('P06', Z6, 43, occ=36, stop=103.8)
assert e6[3] == 120.2 and e6[5] == 2 and not ev_at('P07', Z6[:44])                     # an ordinary candle: no MSS
on('P07', Z6[:42] + [[119.0, 124.0, 118.9, 123.9]], 42)
on('P08', zig([(0, 100), (6, 108), (12, 103), (18, 112), (24, 106), (30, 113)]), 30, stop=105.8)
no('P08', zig([(0, 100), (6, 108), (12, 103), (18, 112), (24, 102), (30, 113)]))                         # a lower low: no uptrend
Z9 = zig([(0, 105), (6, 110), (12, 100), (18, 106), (22, 103)])
e9 = yes('P09', Z9 + [[103, 103.2, 99.5, 100.5]], occ=12, stop=99.5)
assert e9[5] == 0.3
no('P09', Z9 + [[103, 103.2, 99.5, 99.7]])
yes('S06', Z9 + [[103, 103.2, 98.9, 100.5]]); no('S06', Z9 + [[103, 103.2, 99.5, 100.5]])              # 0.5 x ATR deep
yes('P10', Z9 + [[102.5, 102.7, 99.6, 99.7], [99.7, 100.5, 99.5, 100.3]], occ=23, stop=99.5)
no('P10', Z9 + [[102.5, 102.7, 99.6, 99.7], [99.7, 100.5, 99.5, 99.75]])
C3 = calm3()
yes('P11', C3 + [[99.5, 99.8, 98.0, 98.5], [98.5, 99.6, 98.4, 99.3]], occ=30, stop=98.0)
no('P11', C3 + [[99.5, 99.8, 98.0, 98.5], [98.5, 99.6, 98.4, 98.9]])
Z12 = zig([(0, 106), (6, 112), (12, 100), (18, 108), (24, 100.5), (30, 107), (34, 103)])
e12_ = yes('P12', Z12 + [[101.0, 101.8, 100.1, 101.6]], occ=12, stop=100.1)
assert e12_[5] == 99.8
no('P12', Z12 + [[100.3, 101.8, 100.1, 101.6]])                                                           # no long lower shadow
Z13 = zig([(0, 100), (6, 110), (12, 104), (18, 110.2), (24, 105), (29, 111.6)]) + [[111.6, 111.8, 111.0, 111.2]]
yes('P13', Z13 + [[111.2, 111.5, 110.9, 111.4]], occ=29); no('P13', Z13 + [[111.2, 111.5, 110.0, 110.3]])
Z14 = zig([(0, 100), (6, 110), (12, 104), (17, 111)])
yes('P14', Z14 + [[111.0, 111.3, 110.5, 110.9]], occ=17, stop=110.5); no('P14', Z14 + [[111.0, 111.3, 110.0, 110.1]])
yes('P15', Z14 + [[111.0, 111.3, 110.5, 110.9], [110.9, 111.6, 110.8, 111.5]], occ=18, stop=110.5)
no('P15', Z14 + [[111.0, 111.3, 110.5, 110.9], [110.9, 111.6, 110.8, 111.2]])
yes('P18', zig([(0, 100), (6, 120), (12, 110), (18, 116), (24, 108), (30, 113)]), occ=18)
no('P18', zig([(0, 100), (6, 120), (12, 110), (18, 116), (24, 108), (30, 111)]))
P19B = zig([(0, 100), (10, 110), (20, 100), (30, 108), (40, 104.5)]) + [[104.5, 104.8, 104.2, 104.6]] * 10
yes('P19', P19B + [[104.6, 105.5, 104.5, 105.3]], occ=41); no('P19', P19B + [[104.6, 104.9, 104.5, 104.7]])
yes('P20', C3 + [[100, 103, 98, 102.5], [102, 102.8, 99, 101], [101, 104, 100.8, 103.5]], occ=30, stop=99)
no('P20', C3 + [[100, 103, 98, 102.5], [102, 102.8, 99, 101], [101, 104, 100.8, 102.9]])
DN3 = base(30, 'down')
PD3 = DN3[-1][3]
yes('P21', DN3 + [[PD3 - 0.3, PD3 + 1.5, PD3 - 1.2, PD3 + 1.3]]); no('P21', DN3 + [[PD3 - 0.3, PD3 + 1.5, PD3 - 1.2, PD3 + 1.0]])
R22 = C3 + [[99.8, 100.2, 99.6, 100.0], [100.0, 100.5, 99.8, 100.3], [100.3, 100.8, 100.1, 100.6], [100.6, 101.1, 100.4, 100.9]]
yes('P22', R22, occ=30, stop=99.6); no('P22', R22 + [[100.9, 101.3, 100.7, 101.1]])                       # only the first
yes('P23', C3 + [[100, 103.5, 99.9, 103.4]], occ=20); no('P23', C3 + [[100, 102.5, 99.9, 102.4]])
on('P24', zig([(0, 110), (6, 118), (12, 100), (18, 108), (24, 98), (30, 103)]), 29, occ=12, stop=97.8)
no('P24', zig([(0, 110), (6, 118), (12, 100), (18, 108), (24, 92), (30, 103)])[:30])                       # a full-size fall
# SMC
ZS1 = zig([(0, 110), (6, 116), (12, 102), (18, 112), (24, 104), (30, 114), (36, 106), (42, 112), (46, 108)])
yes('S01', ZS1 + [[108, 108.2, 101.0, 102.5]], occ=12, stop=101.0); no('S01', ZS1 + [[108, 108.2, 101.7, 102.5]])
ZS2 = zig([(0, 108), (6, 112), (12, 100), (18, 108), (24, 100.2), (30, 107), (34, 104)])
yes('S02', ZS2 + [[104, 104.2, 99.5, 100.4]], occ=12); no('S02', ZS2 + [[104, 104.2, 99.5, 99.7]])
yes('S03', C3 + [[100, 100.5, 98.8, 100.3]]); no('S03', C3 + [[100.5, 100.6, 98.8, 100.3]])               # red
yes('S04', calm3(35) + [[100, 100.5, 99.2, 100.2], [100.0, 100.4, 98.8, 100.3]])
no('S04', calm3(35) + [[100, 100.5, 98.9, 98.95], [100.0, 100.4, 98.8, 100.3]])                          # the week's 1st dip closed under
yes('S05', calm3(27) + [[100, 100.5, 99.5, 100.2], [100, 100.4, 98.7, 100.3]])
no('S05', calm3(27) + [[100, 100.5, 99.5, 100.2], [100, 100.4, 98.7, 98.8]])                              # closed under it
assert det.detect('S03', *lists(C3 + [[100, 100.5, 98.8, 100.3]]), 'D') == [] and not ev_at('S03', C3 + [[100, 100.5, 98.8, 100.3]], 'W')
ZS7 = zig([(0, 110), (6, 115), (12, 100), (18, 108), (21, 104), (24, 107), (30, 102)])
yes('S07', ZS7 + [[102, 102.2, 99.5, 100.5]], occ=12)
no('S07', zig([(0, 110), (6, 115), (12, 100), (24, 107), (30, 102)]) + [[102, 102.2, 99.5, 100.5]])     # no inducement low
OB = zig([(0, 100), (6, 106), (12, 101), (16, 103)]) + [[103, 103.2, 101.8, 102.0], [102.0, 108.0, 101.9, 107.8],
                                                         [107.8, 108.2, 105.5, 106.0], [106.0, 106.2, 104.0, 104.5]]
yes('S08', OB + [[104.5, 104.8, 103.0, 103.6]], occ=17, stop=101.8); no('S08', OB + [[104.5, 104.8, 103.3, 103.6]])
yes('S19', OB + [[104.5, 104.8, 103.0, 103.6]], occ=17)
OBN = OB[:19] + [[107.8, 108.2, 102.5, 106.0]] + OB[20:]                                                 # the candle after fills the gap
assert not ev_at('S19', OBN + [[104.5, 104.8, 103.0, 103.6]]) and not ev_at('S19', OBN)
yes('S24', OB + [[104.5, 104.8, 103.0, 103.6], [103.6, 103.7, 101.0, 101.2], [101.2, 103.6, 101.1, 103.5]], occ=17, stop=101.0)
no('S24', OB + [[104.5, 104.8, 103.0, 103.6], [103.6, 103.7, 101.0, 101.2], [101.2, 103.6, 101.1, 103.1]])
on('S09', zig([(0, 110), (6, 116), (12, 104), (18, 112), (24, 100), (32, 114)]), 32, occ=18)
on('S10', zig([(0, 110), (6, 116), (12, 104), (18, 112), (24, 106), (32, 114)]) + [[114, 114.2, 112.0, 113.0]], 33, occ=18)
assert not ev_at('S09', zig([(0, 110), (6, 116), (12, 104), (18, 112), (24, 106), (32, 114)]) + [[114, 114.2, 112.0, 113.0]])
ZS20 = zig([(0, 110), (6, 116), (12, 104), (18, 112), (23, 105)]) + [[105, 105.2, 102.5, 104.5]] + zig([(0, 104.5), (8, 114)])[1:]
yes('S20', ZS20 + [[114, 114.2, 112.0, 113.0]], occ=18)
no('S20', zig([(0, 110), (6, 116), (12, 104), (18, 112), (24, 100), (32, 114)])[:33])                   # a plain lower low: no sweep
ZS11 = zig([(0, 112), (8, 118), (14, 110), (20, 104)]) + [[104, 104.3, 100.5, 104.2]] + zig([(0, 104.2), (6, 110), (12, 104.5)])[1:]
yes('S11', ZS11 + [[104.5, 104.8, 103.8, 104.6]], occ=21, stop=100.5); no('S11', ZS11 + [[104.5, 104.8, 104.1, 104.6]])
F12 = C3 + [[100, 101, 99.5, 100.8], [100.8, 104, 100.7, 103.8], [103.8, 105, 102.5, 104.5], [104.5, 104.8, 103.2, 103.5]]
e_ = yes('S12', F12 + [[103.5, 103.6, 102.2, 102.8]], occ=30, stop=101)
assert e_[3] == 102.5 and e_[5] == 1.49
no('S12', F12 + [[103.5, 103.6, 100.5, 100.9]])                                                           # closed under the bottom
yes('S13', F12 + [[103.5, 103.6, 102.2, 102.8], [102.8, 103, 101.6, 102.0]], occ=30)
no('S13', F12 + [[103.5, 103.6, 102.2, 102.8], [102.8, 103, 101.8, 102.0]])                              # middle = 101.75 not reached
F16 = C3 + [[100, 101, 99.5, 100.8], [100.8, 105, 100.7, 104.6], [104.6, 105.5, 102.5, 105.2], [105.2, 105.4, 103.2, 103.5]]
yes('S16', F16 + [[103.5, 103.6, 102.2, 102.8]])
no('S16', C3 + [[100, 101, 99.5, 100.8], [100.8, 103.2, 100.7, 102.8], [102.8, 104, 102.5, 103.5], [103.5, 103.6, 102.2, 102.8]])  # small middle
yes('S25', C3 + [[100, 101, 99.5, 100.8], [100.8, 105, 100.7, 104.6], [104.6, 106, 103.5, 105.5]], occ=30, stop=101)
no('S25', C3 + [[100, 101, 99.5, 100.8], [100.8, 105, 100.7, 104.6], [104.6, 106, 102.5, 105.5]])        # gap under 1 x ATR
B14 = C3 + [[100, 100.5, 98, 98.2], [98.2, 98.3, 95, 95.2], [95.2, 96.5, 94, 96], [96, 97.5, 95.8, 97.2]]
yes('S14', B14 + [[97.2, 98.6, 97, 98.4]], occ=30, stop=96.5); no('S14', B14 + [[97.2, 98.6, 97, 97.9]])
yes('S15', C3 + [[100, 104.6, 99.9, 104.5]]); no('S15', C3 + [[100, 103.6, 99.9, 103.5]])
on('S17', zig([(0, 100), (6, 130), (12, 115), (18, 125), (24, 110), (30, 120), (35, 112)]) + [[112, 112.2, 108.5, 110.5]] +
   zig([(0, 110.5), (6, 122)])[1:], 42, occ=36, stop=108.5)
assert not ev_at('S17', Z6[:44])                                                                          # P06's chart: no sweep
ZS18 = zig([(0, 100), (6, 108), (12, 103), (18, 112), (24, 106), (30, 110)]) + [[110, 110.2, 105.5, 106.5], [106.5, 109, 106.4, 108.8]]
yes('S18', ZS18 + [[108.8, 112.6, 108.7, 112.5]], occ=31, stop=105.5); no('S18', ZS18 + [[108.8, 112.1, 108.7, 112.0]])
ZS21 = zig([(0, 105), (10, 100), (20, 120), (30, 100.5)])
yes('S21', ZS21 + [[100.5, 103, 100, 102.8]], occ=20, stop=100); no('S21', ZS21 + [[100.5, 102, 100, 101.9]])
e_ = on('S22', zig([(0, 100), (6, 130), (12, 115), (18, 125), (24, 110), (30, 120), (36, 104), (44, 124), (52, 110)]), 50, occ=36)
assert e_[5] >= 50
BP = C3 + [[100, 100.5, 99, 99.2], [99.2, 99.3, 96, 96.2], [96.2, 97.5, 95.8, 97.3], [97.3, 97.6, 96.5, 97.4], [97.4, 101, 97.3, 100.8],
           [100.8, 102, 98.5, 101.5]]
yes('S23', BP + [[101.5, 101.8, 98.3, 99.0]], occ=30, stop=97.6); no('S23', BP + [[101.5, 101.8, 98.6, 99.0]])
# volume
ZV = [(0, 100), (6, 108), (12, 102), (18, 110), (24, 104), (30, 112), (36, 106), (42, 110)]
on('V09', zig(ZV, vu=2000.0), 41, occ=12, stop=105.8); no('V09', zig(ZV)[:42])                           # OBV flat at the lows
ZV10 = zig([(0, 106), (6, 110), (12, 100), (18, 106), (24, 101)])
yes('V10', ZV10 + [[100.5, 100.9, 100.0, 100.6, 2500.0]]); no('V10', ZV10 + [[100.5, 100.9, 100.0, 100.6, 1500.0]])
yes('V14', DN3 + [[PD3, PD3 + 0.4, PD3 - 0.4, PD3 - 0.1, 2500.0], [PD3 - 0.1, PD3 + 0.8, PD3 - 0.2, PD3 + 0.6]], occ=30)
no('V14', DN3 + [[PD3, PD3 + 0.4, PD3 - 0.4, PD3 - 0.1, 2500.0], [PD3 - 0.1, PD3 + 0.8, PD3 - 0.2, PD3 + 0.3]])
V16R = C3 + [[100.5, 100.7, 98.0, 98.3, 2500.0], [98.3, 99.5, 98.2, 99.3]]
yes('V16', V16R + [[99.3, 101, 99.2, 100.9]], occ=30, stop=98.0); no('V16', V16R + [[99.3, 101, 99.2, 100.6]])
# quant
UP3 = base(210, 'up')
T3 = UP3[-1][3]
Q1 = UP3 + [[T3, T3 + 0.2, T3 - 3.2, T3 - 3.0], [T3 - 12.0, T3 - 11.8, T3 - 13.2, T3 - 13.0]]
yes('Q01', Q1 + [[T3 - 13.0, T3 - 11.4, T3 - 13.1, T3 - 11.6]]); no('Q01', Q1 + [[T3 - 13.0, T3 - 11.4, T3 - 13.1, T3 - 11.9]])
Q5 = zig([(k * 10, 100 + (10 if k % 2 else 0)) for k in range(14)]) + calm3(30, w=0.5)
yes('Q05', Q5 + [[100, 102.5, 99.9, 102.4]]); no('Q05', Q5 + [[100, 101.5, 99.9, 101.4]])
Q7 = C3 + [[100, 100.2, 99.3, 99.5], [99.5, 99.6, 98.9, 99.0], [99, 99.1, 98.4, 98.5], [98.5, 98.6, 97.9, 98.0], [98, 98.1, 97.4, 97.5]]
yes('Q07', Q7 + [[97.5, 98.4, 97.4, 98.3]], occ=30); no('Q07', Q7 + [[97.5, 98.4, 97.4, 98.0]])
yes('Q08', C3 + [[101, 101.2, 96.8, 97], [97, 99.5, 96.9, 99.2]], occ=30, stop=96.8)
no('Q08', C3 + [[101, 101.2, 96.8, 97], [97, 99.5, 96.9, 98.9]])
yes('Q09', C3 + [[99.0, 101.5, 98.9, 101.4]]); no('Q09', C3 + [[99.9, 101.5, 98.9, 101.4]])               # opened mid-range
yes('Q16', calm3(30, w=0.5) + [[100, 103, 99.9, 102.9, 2500.0]]); no('Q16', calm3(30, w=0.5) + [[100, 103, 99.9, 102.9, 1500.0]])
Q19 = C3 + [[100, 100.1, 98.9, 99.0], [99, 99.1, 97.9, 98.0], [98, 98.1, 96.9, 97.0], [97, 97.1, 95.9, 96.0]]
yes('Q19', Q19 + [[96, 100.1, 95.9, 100.0]]); no('Q19', Q19 + [[96, 97.1, 95.9, 96.9]])
for pid in ('P07', 'Q05', 'Q08', 'S08', 'S11', 'S15', 'S16', 'S17', 'S19', 'S22', 'S24', 'V10', 'P06', 'Q16', 'Q19', 'S06'):
    assert pid in CRAFT, pid                    # the ones rare on random charts have a made chart (section 5 needs events)

# every phase-3 event on random charts: its candles in order, numbers finite, the stop reference under the signal close; the
# patterns with an indicator series of their own are recounted above; a swing-based one never signals before its swing is known
BENCH3 = (list(range(D0P, D0P + 2000)), walk(9191, 2000, vol=0.01, start=10000.0)[3])
for seed in range(3):
    o_, h_, l_, c_, v_ = walk(seed * 13 + 5, 900, vol=0.05 if seed % 2 else 0.03)
    for pid in P3_IDS:
        for tf in ('D', 'W', '4H'):
            for e in det.detect(pid, o_, h_, l_, c_, v_, tf, day=list(range(D0P, D0P + 900)), bench=BENCH3):
                assert e[0] == e[1] and 0 <= e[2] <= e[1] and all(x is None or math.isfinite(x) for x in e[3:]), (pid, e)
                assert e[4] <= c_[e[1]] + 1e-9, (pid, tf, e, c_[e[1]])
assert det.detect('I23', o3, h3, l3, c3, v3, 'D') == [] and det.detect('Q12', o3, h3, l3, c3, v3, 'D') == []   # no benchmark / dates
# patSwing changes the structure patterns (and the memo key); divPivot the divergences
o_, h_, l_, c_, v_ = walk(77, 900, vol=0.04)
assert det.detect('P09', o_, h_, l_, c_, v_, 'D', {'patSwing': 3}) != det.detect('P09', o_, h_, l_, c_, v_, 'D')
assert det.detect('I08', o_, h_, l_, c_, v_, 'D', {'divPivot': 3}) != det.detect('I08', o_, h_, l_, c_, v_, 'D')
assert det.param_hash('P09', det.params_for('P09', {'patSwing': 3})) != det.param_hash('P09', det.params_for('P09', {}))

# ------------------------------------------------------------------ 4d. PHASE 4 (owner, 13-Nov-2026: "Yes do it"): the classical chart
# patterns C01-C20 on made charts - the breakout candle where it must come, a changed copy where it must not - and the properties
# of every event on random charts
import pattern_p4 as p4  # noqa: E402

P4_IDS = sorted(p4.DETECTORS)
assert len(P4_IDS) == 20 and all(p in reg.SPECS for p in P4_IDS)
assert [e['id'] for e in reg.entries() if e['status'] != 'implemented' and e['category'] != 'X'] == ['B15', 'M16']
C30 = calm3(30)
on('C01', zig([(0, 120), (10, 100), (20, 112), (30, 100.5), (40, 114)]), 39, occ=10, stop=99.8)
no('C01', zig([(0, 120), (10, 100), (20, 112), (30, 97), (40, 114)])[:40])                               # the lows not equal
on('C02', zig([(0, 125), (10, 100), (20, 112), (30, 100.5), (40, 112), (50, 100.2), (60, 115)]), 59, occ=10, stop=99.8)
no('C02', zig([(0, 125), (10, 100), (20, 112), (30, 100.5), (40, 112), (50, 96), (60, 115)])[:60])
e_ = on('C03', zig([(0, 125), (10, 104), (18, 112), (28, 96), (38, 112.5), (46, 104.5), (56, 116)]), 54, occ=10, stop=104.3)
assert abs(e_[3] - 113.075) < 1e-9                                                                       # the sloped neckline there
no('C03', zig([(0, 125), (10, 104), (18, 112), (28, 104), (38, 112.5), (46, 104.5), (56, 116)])[:55])    # no head
on('C04', zig([(0, 98), (6, 100), (24, 80), (36, 80.5), (59, 99.5)]) + [[99.5, 101.2, 99.4, 101.0]], 60, occ=0)
no('C04', zig([(0, 98), (6, 100), (30, 96), (33, 80), (36, 96), (59, 99.5)]) + [[99.5, 101.2, 99.4, 101.0]])   # a V, not a U
on('C05', zig([(0, 98), (12, 100), (48, 88), (72, 88.3), (119, 99.5)]) + [[99.5, 100.4, 99.4, 100.3]], 120, occ=0)
no('C05', zig([(0, 98), (12, 100), (48, 70), (72, 70.3), (119, 99.5)]) + [[99.5, 100.4, 99.4, 100.3]])   # too deep for a saucer
W6 = zig([(0, 95), (8, 120), (16, 104), (24, 114), (32, 101.5), (40, 109), (48, 99.5), (58, 112)])
on('C06', W6, 53, occ=16, stop=99.3)
no('C06', W6[:53] + [[104.5, 105.3, 104.3, 105.0]])                                                       # stays under the line
on('C07', zig([(0, 110), (6, 104), (12, 112), (18, 101), (24, 115), (30, 108), (40, 118)]), 38, occ=6)
no('C07', zig([(0, 110), (6, 104), (12, 112), (18, 106), (24, 115), (30, 108), (40, 118)])[:39])          # not expanding
FL = C30 + zig([(0, 100), (8, 112), (11, 110), (13, 111), (17, 108.5), (20, 110), (24, 109)])[1:]
yes('C08', FL + [[109, 111.2, 108.9, 111.0]], occ=22, stop=108.3)
no('C08', C30 + zig([(0, 100), (8, 112), (11, 110), (13, 111), (17, 105), (20, 110), (24, 109)])[1:] + [[109, 111.2, 108.9, 111.0]])
no('C09', FL + [[109, 111.2, 108.9, 111.0]])                                                             # a flag, not a pennant
yes('C09', C30 + zig([(0, 100), (8, 112), (11, 108), (14, 111), (17, 109.5), (19, 110.5), (21, 110)])[1:] + [[110, 111.6, 109.9, 111.4]],
    occ=22, stop=107.8)
CH = zig([(0, 100), (10, 120), (25, 95), (35, 95.5), (50, 119.5), (54, 116), (58, 118)])
e_ = yes('C10', CH + [[118, 120.3, 117.9, 120.1]], occ=10, stop=115.8)
assert e_[5] == 21.1
no('C10', zig([(0, 100), (10, 120), (25, 95), (35, 95.5), (50, 119.5), (54, 106), (58, 118)]) + [[118, 120.3, 117.9, 120.1]])
ASC = zig([(0, 100), (8, 110), (16, 100), (24, 110.2), (32, 104), (40, 112)])
REC = zig([(0, 100), (8, 110), (16, 100), (24, 110.2), (32, 100.3), (40, 112)])
on('C11', ASC, 39, occ=8, stop=103.8); no('C11', REC[:40])
on('C13', REC, 39, occ=8, stop=100.1); no('C13', ASC[:40])
SYM = zig([(0, 100), (8, 116), (16, 100), (24, 112), (32, 104), (46, 114)])
on('C12', SYM, 39, occ=8, stop=103.8); no('C12', ASC[:40])
CHN = zig([(0, 100), (6, 108), (12, 103), (18, 111), (24, 106), (30, 114), (36, 109.2)])
yes('C14', CHN + [[109.2, 110, 108.9, 109.8]], occ=12, stop=108.9); no('C14', CHN + [[109.8, 110, 108.9, 109.2]])   # red
on('C15', zig([(0, 100), (6, 108), (12, 104), (18, 112), (24, 108), (30, 116), (36, 112), (46, 120)]), 42, occ=12, stop=111.8)
no('C15', zig([(0, 100), (6, 108), (12, 104), (18, 112), (24, 104.5), (30, 116), (36, 112), (46, 120)])[:43])   # a deep pullback
on('C16', zig([(0, 110), (6, 100), (16, 120), (24, 110), (34, 124)]), 32, occ=6, stop=109.8)
no('C16', zig([(0, 110), (6, 100), (16, 120), (24, 104), (34, 124)])[:34])                                  # gave back 80 %
yes('C17', zig([(0, 52), (10, 50), (40, 100), (46, 90), (52, 96)]) + [[96, 101, 95.9, 100.6]], occ=10, stop=89.8)
no('C17', zig([(0, 62), (10, 60), (40, 100), (46, 90), (52, 96)]) + [[96, 101, 95.9, 100.6]])            # rose 68 %, not 90 %
FB = zig([(0, 90), (60, 118)]) + [[118, 119.5, 116.5, 118.2 if k % 2 else 117.8, 1000.0] for k in range(25)]
yes('C18', FB + [[118, 120.5, 117.9, 120.3, 2000.0]], occ=61, stop=116.5); no('C18', FB + [[118, 120.5, 117.9, 120.3, 1300.0]])
IPO = [[100, 110, 98, 108]] + zig([(0, 108), (4, 120), (12, 104), (18, 119)])[1:]
e_ = yes('C19', IPO + [[119, 121, 118.8, 120.8]], occ=0, stop=103.8)
assert e_[3] == 120.2 and e_[5] == 13.6
no('C19', IPO + [[119, 120.1, 118.8, 120.0]])
o_, h_, l_, c_, v_ = lists(IPO + [[119, 121, 118.8, 120.8]])
assert det.detect('C19', o_, h_, l_, c_, v_, 'D', day=list(range(date(2005, 1, 3).toordinal(), date(2005, 1, 3).toordinal() + 20))) == []
assert det.detect('C19', o_, h_, l_, c_, v_, '4H', day=list(range(D0P, D0P + 20))) == []                  # D / W only
VCP = zig([(0, 80), (12, 100), (20, 80), (30, 99), (38, 89.5), (46, 99.5), (52, 94.5), (58, 98.5)], vu=3000.0, vd=3000.0)
for k_, row_ in enumerate(VCP):
    row_[4] = 3000.0 if k_ < 30 else (2000.0 if k_ < 46 else 1000.0)
e_ = yes('C20', VCP + [[98.5, 100.2, 98.4, 100.1]], occ=12, stop=94.3)
assert e_[3] == 99.7 and e_[5] == 5.4
no('C20', [r[:4] + [3000.0] for r in VCP] + [[98.5, 100.2, 98.4, 100.1, 3000.0]])                        # no volume dry-up
assert all(p in CRAFT for p in P4_IDS)
for seed in range(3):
    o_, h_, l_, c_, v_ = walk(seed * 17 + 9, 1200, vol=0.05 if seed % 2 else 0.03)
    for pid in P4_IDS:
        for tf in ('D', 'W', '4H'):
            for e in det.detect(pid, o_, h_, l_, c_, v_, tf, day=list(range(D0P, D0P + 1200))):
                assert e[0] == e[1] and 0 <= e[2] <= e[1] and all(x is None or math.isfinite(x) for x in e[3:]), (pid, e)
                assert e[4] <= c_[e[1]] + 1e-9 and c_[e[1]] > e[3] - 1e-9 or pid == 'C14', (pid, tf, e)   # a breakout: close >= trigger

# ------------------------------------------------------------------ 5. CAUSALITY: cut the chart / change what comes after - every
# implemented pattern x D / W / 4H on random charts, and on its made chart (+ random candles after it) cut at every candle near
# its signal; every pattern must have produced events here (no empty check)
DAYS7 = list(range(D0P, D0P + 4000))
seen = {}


def causal(pid, tf, o, h, l, c, v, cuts, seed):
    full = det.detect(pid, o, h, l, c, v, tf, day=DAYS7[:len(c)], bench=BENCH)
    seen[pid] = seen.get(pid, 0) + len(full)
    for e in full:
        assert e[2] <= e[1] <= e[0] < len(c) and all(x is None or math.isfinite(x) for x in e[3:]), (pid, e)
    for k in cuts:
        want_ = [e for e in full if e[0] <= k]
        cut = det.detect(pid, o[:k + 1], h[:k + 1], l[:k + 1], c[:k + 1], v[:k + 1], tf, day=DAYS7[:k + 1], bench=BENCH)
        assert cut == want_, (pid, tf, seed, k, [x for x in cut if x not in want_][:2], [x for x in want_ if x not in cut][:2])
        o2, h2, l2, c2, v2 = walk(seed + 1000 + k, len(c) - k - 1, start=c[k])
        alt = det.detect(pid, o[:k + 1] + o2, h[:k + 1] + h2, l[:k + 1] + l2, c[:k + 1] + c2, v[:k + 1] + v2, tf, day=DAYS7[:len(c)],
                         bench=BENCH)
        assert [e for e in alt if e[0] <= k] == want_, (pid, tf, seed, k, 'changed by later candles')
    assert det.detect(pid, o, h, l, c, v, tf, day=DAYS7[:len(c)], bench=BENCH) == full, 'reproducible'


RAND = [walk(seed * 7 + 1, 700, vol=0.05 if seed % 2 else 0.03) for seed in range(3)]
for pid in reg.implemented():
    for tf in ('D', 'W', '4H'):
        for seed, ch in enumerate(RAND):
            causal(pid, tf, *ch, range(30 + seed * 11, 700, 47), seed)
    if pid in CRAFT:
        o, h, l, c, v = lists(CRAFT[pid])
        o2, h2, l2, c2, v2 = walk(77, 60, start=c[-1])
        n0 = len(c)
        causal(pid, 'D', o + o2, h + h2, l + l2, c + c2, v + v2, range(max(0, n0 - 8), n0 + 5), 9)
assert all(seen.get(p, 0) > 0 for p in reg.implemented()), [p for p in reg.implemented() if not seen.get(p)]

# ------------------------------------------------------------------ 6. the Backtest Lab's Pattern library group
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
KI = importlib.util.module_from_spec(spec)
spec.loader.exec_module(KI)
L = KI.backtest_lab
L.log = lambda m: None
L.LAB_DIR = os.path.join(tempfile.mkdtemp(), 'lab_cache')
D0 = date(2010, 1, 4)
charts = {'R%02d' % s: walk(s + 50, 1500, vol=0.04) for s in range(12)}


def day_candles(ch):
    o, h, l, c, v = ch
    return [{'t': (D0 + timedelta(days=k)).isoformat(), 'day': (D0 + timedelta(days=k)).isoformat(), 'o': o[k], 'h': h[k],
             'l': l[k], 'c': c[k], 'v': v[k]} for k in range(len(c))]


def week_candles(ds):
    out = []
    for x in ds:
        d = date.fromisoformat(x['day'])
        key = (d - timedelta(days=d.weekday())).isoformat()
        if out and out[-1]['day'] == key:
            w_ = out[-1]
            w_['h'], w_['l'], w_['c'], w_['v'] = max(w_['h'], x['h']), min(w_['l'], x['l']), x['c'], w_['v'] + x['v']
        else:
            out.append({'t': key, 'day': key, 'o': x['o'], 'h': x['h'], 'l': x['l'], 'c': x['c'], 'v': x['v']})
    return out


LBENCH = walk(5151, 1500, vol=0.01, start=10000.0)[3]
LDAYS = [(D0 + timedelta(days=k)).toordinal() for k in range(1500)]
wr = L.CacheWriter(D0 + timedelta(days=4000))
wr.indices = {'NIFTY_50': [[d_, c_] for d_, c_ in zip(LDAYS, LBENCH)]}
for sym, ch in charts.items():
    ds = day_candles(ch)
    wr.add(sym, 'D', ds, [])
    wr.add(sym, 'W', week_candles(ds), [])
wr.close()
assert L.DEFAULTS['group'] == 'fvg' and 'pattern' in L.CHOICES['group'] and L.CHOICES['pattern'] == tuple(reg.implemented())
for pid in reg.implemented():
    for k_, v_ in reg.SPECS[pid]['params'].items():
        assert L.DEFAULTS[k_] == v_, (pid, k_)
cols = L.TRADE_COLS
for pid in reg.implemented():
    res = L.run_job({'group': 'pattern', 'pattern': pid, 'tf': 'D', 'entry': 'close', 'stop': 'zone', 'maxRisk': 0, 'cost': 0})
    tr = [dict(zip(cols, r)) for r in res['trades']]
    name = reg.by_id()[pid]['name']
    assert res['groupName'] == 'Pattern library: %s %s' % (pid, name) and res['warnings'] == [L.SURVIVORSHIP]
    want_n = 0
    for sym, (o, h, l, c, v) in charts.items():
        evs = det.detect(pid, o, h, l, c, v, 'D', day=[(D0 + timedelta(days=k)).toordinal() for k in range(len(c))],
                         bench=(LDAYS, LBENCH))
        want_n += len({e[0] for e in evs})
        mine = sorted((t['signal'], t['entry'], t['stop']) for t in tr if t['sym'] == sym)
        first = {}                     # the Lab takes one trade a candle: the first event of that candle that passes (stop < entry)
        for e in evs:
            if e[4] * 0.995 < c[e[0]] and e[0] not in first:
                first[e[0]] = e
        exp = sorted(((D0 + timedelta(days=e[0])).isoformat(), c[e[0]], round(e[4] * 0.995, 2)) for e in first.values())
        assert [(a_, b_) for a_, b_, _ in mine] == [(a_, b_) for a_, b_, _ in exp], (pid, sym, mine[:3], exp[:3])
        assert all(abs(x[2] - y[2]) < 0.011 for x, y in zip(mine, exp)), (pid, sym)
    assert (res['tradesTotal'] >= 1 or want_n == 0) and all(t['zone'] == '%s %s' % (pid, name) for t in tr), (pid, res['tradesTotal'])
    assert res['tradesTotal'] <= want_n
# phase 3: the relative-strength patterns need NIFTY 50 on the laptop; the swing size reaches the detectors (and the memo key)
try:
    L._PatRows('nocache', 'D', {'index': {}, 'indices': {}}, dict(L.DEFAULTS, pattern='I23'))
    raise AssertionError('I23 ran without NIFTY 50')
except L.LabError as ex:
    assert 'NIFTY 50' in str(ex), ex
rs_ = L.run_job({'group': 'pattern', 'pattern': 'I23', 'maxRisk': 0})
assert rs_['tradesTotal'] > 0 and rs_['groupName'].startswith('Pattern library: I23')
t5 = L.run_job({'group': 'pattern', 'pattern': 'P09', 'maxRisk': 0})['tradesTotal']
t3 = L.run_job({'group': 'pattern', 'pattern': 'P09', 'maxRisk': 0, 'patSwing': 3})['tradesTotal']
assert t5 > 0 and t3 > t5, (t5, t3)                   # smaller swings = more swing lows to sweep
assert L.clean_params({'patSwing': 40})['patSwing'] == 10 and L.clean_params({'patSwing': 1})['patSwing'] == 2
# the next open, the ATR stop, a weekly run (turnover from the daily candles), the turnover filter, the charts PDF
r1 = L.run_job({'group': 'pattern', 'pattern': 'B01', 'tf': 'D', 'entry': 'next_open', 'maxRisk': 0})
assert r1['tradesTotal'] > 0
rw = L.run_job({'group': 'pattern', 'pattern': 'B02', 'tf': 'W', 'maxRisk': 0})
assert rw['tradesTotal'] > 0 and rw['groupName'].startswith('Pattern library: B02')
t_all = L.run_job({'group': 'pattern', 'pattern': 'K08', 'maxRisk': 0})['tradesTotal']
t_big = L.run_job({'group': 'pattern', 'pattern': 'K08', 'maxRisk': 0, 'minTurnover': 30})['tradesTotal']
assert 0 < t_big < t_all, (t_big, t_all)              # volume 1,000-90,000 x price ~100 = 1-90 lakh a day
# the trend context (phase 2): "after a fall" keeps fewer reversal signals; a pattern without it ignores the setting
k_any = L.run_job({'group': 'pattern', 'pattern': 'K10', 'maxRisk': 0})['tradesTotal']
k_dn = L.run_job({'group': 'pattern', 'pattern': 'K10', 'maxRisk': 0, 'patCtx': 'down'})['tradesTotal']
assert 0 < k_dn < k_any, (k_dn, k_any)
assert L.run_job({'group': 'pattern', 'pattern': 'B05', 'maxRisk': 0, 'patCtx': 'down'})['tradesTotal'] == \
    L.run_job({'group': 'pattern', 'pattern': 'B05', 'maxRisk': 0})['tradesTotal']
assert L.clean_params({'patCtx': 'up'})['patCtx'] == 'any'
ra = L.run_job({'group': 'pattern', 'pattern': 'I01', 'maxRisk': 0, 'stopAtr': 3})
assert any(dict(zip(cols, x))['stopBy'] == 'atr' for x in ra['trades'])
cdir = os.path.join(tempfile.mkdtemp(), 'charts')
rp = L.run_job({'group': 'pattern', 'pattern': 'B01', 'maxRisk': 0}, charts=cdir, name='pattern pdf')
assert rp['pdf'].get('pages', 0) > 2 and os.path.isfile(os.path.join(cdir, rp['pdf']['file'])), rp['pdf']
import re as _re  # noqa: E402
import zlib as _zlib  # noqa: E402
_raw = open(os.path.join(cdir, rp['pdf']['file']), 'rb').read()
_txt = ' '.join(_zlib.decompressobj().decompress(m.group(1)).decode('latin-1') for m in _re.finditer(rb'stream\r?\n(.*?)\r?\nendstream', _raw, _re.S)
                if m.group(1)[:1] == b'x')
for _w in ('Breakout level', 'B01 20-Day High Breakout', 'the backtest found B01 20-Day High Breakout'):
    assert _w in _txt, _w
# the same run twice = the same result (memo or not)
L._PAT_MEMO.clear()
x1 = L.run_job({'group': 'pattern', 'pattern': 'I01', 'maxRisk': 0})
x2 = L.run_job({'group': 'pattern', 'pattern': 'I01', 'maxRisk': 0})
assert x1['trades'] == x2['trades'] and x1['stats'] == x2['stats']
# the other groups still read their own signal rows (and every result carries the survivorship note)
r0 = L.run_job({'group': 'fvg'})
assert r0['tradesTotal'] == 0 and r0['warnings'] == [L.SURVIVORSHIP]
print('OK')
