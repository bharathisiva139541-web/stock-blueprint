# -*- coding: utf-8 -*-
"""Offline checks of the bullish pattern engine, M1 (owner, 13-Nov-2026; docs/PATTERN_ENGINE_PLAN.md): indicators.py (worked
examples + an independent second implementation), pattern_registry.py (the 194 entries), pattern_detect.py (unit, boundary,
CAUSALITY: the chart cut at many points and the candles after the cut changed - the events up to the cut never change,
reproducibility) and the Backtest Lab's Pattern library group. Prints OK at the end.

  --k08 < candles.json     prints the K08 signal candles of each chart (tests/pcbridge-patterns.test.js compares them with
                           web/lib/patterns.js - the sheet's own "Bullish Engulfing")
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

if len(sys.argv) > 1 and sys.argv[1] == '--k08':
    charts = json.load(sys.stdin)
    out = []
    for cs in charts:
        o, h, l, c = ([x[k] for x in cs] for k in ('o', 'h', 'l', 'c'))
        out.append([e[1] for e in det.detect('K08', o, h, l, c, [1.0] * len(c), 'D')])
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
    assert sp['rules'] and len(sp['rules']) >= 5 and sp['version'] >= 1, pid
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

# ------------------------------------------------------------------ 5. CAUSALITY: cut the chart / change what comes after
for pid in reg.implemented():
    for tf in ('D', 'W', '4H'):
        for seed in range(4):
            o, h, l, c, v = walk(seed * 7 + 1, 700, vol=0.05 if seed % 2 else 0.03)
            full = det.detect(pid, o, h, l, c, v, tf)
            for e in full:
                assert e[2] <= e[1] <= e[0] < len(c) and all(x is None or math.isfinite(x) for x in e[3:]), (pid, e)
            for k in range(30, 700, 23):
                want_ = [e for e in full if e[0] <= k]
                cut = det.detect(pid, o[:k + 1], h[:k + 1], l[:k + 1], c[:k + 1], v[:k + 1], tf)
                assert cut == want_, (pid, tf, seed, k, [x for x in cut if x not in want_][:2], [x for x in want_ if x not in cut][:2])
                o2, h2, l2, c2, v2 = walk(seed + 1000 + k, 700 - k - 1, start=c[k])
                alt = det.detect(pid, o[:k + 1] + o2, h[:k + 1] + h2, l[:k + 1] + l2, c[:k + 1] + c2, v[:k + 1] + v2, tf)
                assert [e for e in alt if e[0] <= k] == want_, (pid, tf, seed, k, 'changed by later candles')
            assert det.detect(pid, o, h, l, c, v, tf) == full, 'reproducible'

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
        evs = det.detect(pid, o, h, l, c, v, 'D')
        want_n += len({e[0] for e in evs})
        mine = sorted((t['signal'], t['entry'], t['stop']) for t in tr if t['sym'] == sym)
        exp = sorted(((D0 + timedelta(days=e[0])).isoformat(), c[e[0]], round(e[4] * 0.995, 2)) for e in evs if e[4] < c[e[0]])
        assert [(a_, b_) for a_, b_, _ in mine] == [(a_, b_) for a_, b_, _ in exp], (pid, sym, mine[:3], exp[:3])
        assert all(abs(x[2] - y[2]) < 0.011 for x, y in zip(mine, exp)), (pid, sym)
    assert res['tradesTotal'] >= 1 and all(t['zone'] == '%s %s' % (pid, name) for t in tr), (pid, res['tradesTotal'])
    assert res['tradesTotal'] <= want_n
# the next open, the ATR stop, a weekly run (turnover from the daily candles), the turnover filter, the charts PDF
r1 = L.run_job({'group': 'pattern', 'pattern': 'B01', 'tf': 'D', 'entry': 'next_open', 'maxRisk': 0})
assert r1['tradesTotal'] > 0
rw = L.run_job({'group': 'pattern', 'pattern': 'B02', 'tf': 'W', 'maxRisk': 0})
assert rw['tradesTotal'] > 0 and rw['groupName'].startswith('Pattern library: B02')
t_all = L.run_job({'group': 'pattern', 'pattern': 'K08', 'maxRisk': 0})['tradesTotal']
t_big = L.run_job({'group': 'pattern', 'pattern': 'K08', 'maxRisk': 0, 'minTurnover': 30})['tradesTotal']
assert 0 < t_big < t_all, (t_big, t_all)              # volume 1,000-90,000 x price ~100 = 1-90 lakh a day
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
