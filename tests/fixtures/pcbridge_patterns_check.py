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


def ev_at(pid, rows, tf='D', P=None, day=True):
    o, h, l, c, v = lists(rows)
    return [e for e in det.detect(pid, o, h, l, c, v, tf, P, day=list(range(D0P, D0P + len(c))) if day else None)
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
assert sorted(CRAFT) == sorted(p for p in reg.implemented() if p not in ('K08', 'B01', 'B02', 'B03', 'B04', 'I01')), \
    sorted(set(reg.implemented()) - set(CRAFT))

# ------------------------------------------------------------------ 5. CAUSALITY: cut the chart / change what comes after - every
# implemented pattern x D / W / 4H on random charts, and on its made chart (+ random candles after it) cut at every candle near
# its signal; every pattern must have produced events here (no empty check)
DAYS7 = list(range(D0P, D0P + 4000))
seen = {}


def causal(pid, tf, o, h, l, c, v, cuts, seed):
    full = det.detect(pid, o, h, l, c, v, tf, day=DAYS7[:len(c)])
    seen[pid] = seen.get(pid, 0) + len(full)
    for e in full:
        assert e[2] <= e[1] <= e[0] < len(c) and all(x is None or math.isfinite(x) for x in e[3:]), (pid, e)
    for k in cuts:
        want_ = [e for e in full if e[0] <= k]
        cut = det.detect(pid, o[:k + 1], h[:k + 1], l[:k + 1], c[:k + 1], v[:k + 1], tf, day=DAYS7[:k + 1])
        assert cut == want_, (pid, tf, seed, k, [x for x in cut if x not in want_][:2], [x for x in want_ if x not in cut][:2])
        o2, h2, l2, c2, v2 = walk(seed + 1000 + k, len(c) - k - 1, start=c[k])
        alt = det.detect(pid, o[:k + 1] + o2, h[:k + 1] + h2, l[:k + 1] + l2, c[:k + 1] + c2, v[:k + 1] + v2, tf, day=DAYS7[:len(c)])
        assert [e for e in alt if e[0] <= k] == want_, (pid, tf, seed, k, 'changed by later candles')
    assert det.detect(pid, o, h, l, c, v, tf, day=DAYS7[:len(c)]) == full, 'reproducible'


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


wr = L.CacheWriter(D0 + timedelta(days=4000))
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
        evs = det.detect(pid, o, h, l, c, v, 'D', day=[(D0 + timedelta(days=k)).toordinal() for k in range(len(c))])
        want_n += len({e[0] for e in evs})
        mine = sorted((t['signal'], t['entry'], t['stop']) for t in tr if t['sym'] == sym)
        exp = sorted(((D0 + timedelta(days=e[0])).isoformat(), c[e[0]], round(e[4] * 0.995, 2)) for e in evs if e[4] * 0.995 < c[e[0]])
        assert [(a_, b_) for a_, b_, _ in mine] == [(a_, b_) for a_, b_, _ in exp], (pid, sym, mine[:3], exp[:3])
        assert all(abs(x[2] - y[2]) < 0.011 for x, y in zip(mine, exp)), (pid, sym)
    assert (res['tradesTotal'] >= 1 or want_n == 0) and all(t['zone'] == '%s %s' % (pid, name) for t in tr), (pid, res['tradesTotal'])
    assert res['tradesTotal'] <= want_n
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
