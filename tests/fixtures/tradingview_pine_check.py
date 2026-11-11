# -*- coding: utf-8 -*-
"""The TradingView indicator (tradingview/StockBlueprint_CHoCH_FVG.pine) = the laptop's backtest: its bar-by-bar logic
(tradingview/pine_model.py, the .pine's steps in Python) finds exactly the CHoCH events of structure.py and the setups the
Backtest Lab takes with group 'touch' + market structure 'only' (kite_intraday's zones + zone_first_touches, judged by
Structure.judge + backtest_lab.struct_fail), on random charts and a made one; and the .pine's defaults = the Lab's.
Owner, 11-Nov-2026: "i open trading view chart and i go to that trade date. i check how our backtest enter the trade ...
it would be helpful if i got pinescript indicator". Prints OK at the end."""
import importlib.util
import os
import random
import re
import sys
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'tradingview'))
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
S = L.structure
import pine_model as M  # noqa: E402


def walk(seed, n, vol=0.05):
    rnd = random.Random(seed)
    out, px = [], 100.0
    for _ in range(n):
        o = px * (1 + rnd.uniform(-0.03, 0.03))
        c = o * (1 + rnd.uniform(-vol, vol))
        h = max(o, c) * (1 + rnd.uniform(0, 0.03))
        lo = min(o, c) * (1 - rnd.uniform(0, 0.03))
        out.append((round(o, 2), round(h, 2), round(lo, 2), round(c, 2)))
        px = c
    return out


def reference(rows, n, down, when, first, fib, part, below):
    """What the laptop finds: CHoCH events + the Lab's 'touch' setups (one a candle, the first zone that passes)."""
    cs = [{'o': o, 'h': h, 'l': lo, 'c': c} for o, h, lo, c in rows]
    hh, ll, cc = [x['h'] for x in cs], [x['l'] for x in cs], [x['c'] for x in cs]
    st = S.Structure(hh, ll, cc, n)
    zt = K.zone_first_touches(cs, K.spring_zones(cs, K.fvg_gaps(cs)))
    P = {'zoneWhen': when, 'firstPull': first, 'belowChoch': below, 'discount': fib}
    setups = []
    for i in sorted(zt):
        for z in zt[i]:
            j = st.judge(i, z['f'], z['top'], cc[i], cc, down, h=hh, zone_bottom=z['bottom'], part=part, fib=fib or None)
            if j['k'] < 0 or L.struct_fail(j, P):
                continue
            setups.append([i, z['f'], z['bottom'], z['top'], z['kind'], bool(z.get('inside')), j['depth']])
            break
    bos = {}
    for k, e in enumerate(st.events):
        if e[5] >= down:
            b = st.bos_before(k, cc, len(cc))
            if b >= 0 and st.dead_by(k, cc, b) < 0:
                bos[e[0]] = b
    return S.choch_events(hh, ll, cc, n), setups, bos


def model(rows, n, down, when, first, fib, part, below):
    m = M.Model(n, down, when, first, fib, part, below)
    for r in rows:
        m.bar(*r)
    return m


# ------------------------------------------------------------------ 1. random charts, several rule sets
total = 0
combos = [(5, 3, 'both', True, 0.5, 'mid', False), (3, 1, 'both', True, 0.5, 'mid', False), (2, 2, 'leg', True, 0.618, 'top', False),
          (3, 1, 'after', False, 0.0, 'mid', True), (2, 1, 'both', False, 0.382, 'bottom', False), (4, 2, 'both', True, 0.0, 'mid', False)]
for seed in range(10):
    rows = walk(seed, 1200, vol=0.05 if seed % 2 else 0.035)
    for combo in combos:
        ev, ref, bos_ref = reference(rows, *combo)
        m = model(rows, *combo)
        assert m.events == ev, (seed, combo, m.events[:3], ev[:3])
        got = [[a, b, c, d, 'Gap-up' if e == 'Gap-up' else 'FVG', bool(f_), g] for a, b, c, d, e, f_, g in m.setups]
        assert got == ref, (seed, combo, got[:4], ref[:4])
        # a BOS the model saw = the laptop's (for the CHoCH that was current then)
        for b, x in m.bos.items():
            assert bos_ref.get(b) == x, (seed, combo, b, x, bos_ref.get(b))
        total += len(ref)
assert total > 40, 'the random charts give setups to compare: %d' % total

# ------------------------------------------------------------------ 2. the owner's SUPREMEIND case (made chart): the premium FVG's
# touch is not a BUY, the discount FVG's first touch is - also when one candle goes through both
def craft(big=False):
    rows, prev = [], [165.0]

    def put(o, h, lo, c):
        rows.append((round(o, 2), round(h, 2), round(lo, 2), round(c, 2)))

    def go(to, k=6):
        for j in range(1, k + 1):
            x = prev[0] + (to - prev[0]) * j / k
            a = prev[0] + (to - prev[0]) * (j - 1) / k
            put(a, max(a, x) + 0.3, min(a, x) - 0.3, x)
        prev[0] = to
    for to in (150, 160, 142, 152, 134, 144, 126, 136, 120):
        go(to)
    put(120, 121.3, 119.7, 121)
    put(121, 130.3, 120.7, 130)
    put(130, 133.3, 126.5, 133)          # the discount FVG 121.3 - 126.5
    put(133, 138.3, 130.0, 138)          # CHoCH (a close above 136.3)
    put(138, 139.3, 133.0, 139)
    put(139, 148.3, 138.7, 148)
    put(148, 151.3, 145.0, 151)          # the premium FVG 139.3 - 145.0
    prev[0] = 151
    go(156, 3)
    go(147, 3)
    if big:
        put(147, 147.3, 124.8, 125.5)
        prev[0] = 125.5
    else:
        put(147, 147.3, 143.0, 144)
        prev[0] = 144
        go(128, 6)
        put(128, 128.3, 124.8, 125)
        prev[0] = 125
    go(160, 8)
    return rows


for big in (False, True):
    rows = craft(big)
    m = model(rows, 5, 3, 'both', True, 0.5, 'mid', False)
    ev, ref, _ = reference(rows, 5, 3, 'both', True, 0.5, 'mid', False)
    assert m.events == ev and len(m.setups) == 1 and m.setups[0][2:4] == [121.3, 126.5], (big, m.setups)
    assert rows[m.setups[0][0]][2] == 124.8 and round(m.setups[0][6], 2) == 0.89, m.setups
    assert [s[:6] for s in m.setups] == [[a, b, c, d, e, f_] for a, b, c, d, e, f_, _ in ref]
    loose = model(rows, 5, 3, 'both', True, 0.0, 'mid', False)
    assert loose.setups[0][2:4] == [139.3, 145.0], loose.setups   # without the discount rule the premium zone is the BUY (the SUPREMEIND run)

# ------------------------------------------------------------------ 3. the .pine itself: the Lab's defaults, the same numbers, Pine v5 layout
src = open(os.path.join(ROOT, 'tradingview', 'StockBlueprint_CHoCH_FVG.pine'), encoding='utf-8').read()
lines = src.split('\n')
assert lines[0] == '//@version=5'
D = L.DEFAULTS


def default(name):
    mm = re.search(r'^%s = input\.\w+\(([^,]+),' % name, src, re.M)
    assert mm, name
    return mm.group(1).strip().strip('"')


assert int(default('pivN')) == D['pivotN'] == K.CHOCH_PIVOT_N and int(default('downN')) == D['downN'] == K.CHOCH_DOWN_N
assert float(default('fibLvl')) == K.CHOCH_FIB and default('discPart') == 'Middle' and K.CHOCH_PART == 'mid'
assert default('zoneWhen') == 'In the CHoCH move or after it' and D['zoneWhen'] == 'both' and default('firstPull') == 'true'
assert default('belowChoch') == 'false' and float(default('stopBuf')) == D['stopBuf'] and float(default('targetR')) == D['targetR']
assert float(default('gapMin')) == K.GAPUP_MIN_PCT == M.GAP_MIN and float(default('gapMax')) == K.GAPUP_MAX_PCT == M.GAP_MAX
assert float(default('insideBody')) == K.INSIDE_BODY_MIN_PCT == M.INSIDE_BODY and float(default('fvgK')) == M.FVG_K
assert float(default('spBody')) == K.SPRING_CFG['bodyMin'] and float(default('spUnder')) == K.SPRING_CFG['undercut']
assert float(default('spBodyMax')) == K.SPRING_CFG['day2BodyMax'] and float(default('spReclaim')) == K.SPRING_CFG['reclaimMax']
assert '<= 0.05' in src and K.CIRCUIT_LOCK_PCT == M.LOCK_PCT == 0.05 and 'ta.sma(high - low, 14)' in src
assert 'if array.size(zF) > %d' % M.ZONES_KEPT in src
# Pine layout: no tabs, blocks indented by 4 spaces, one statement a line (no wrapped lines), brackets balanced
for k, ln in enumerate(lines, 1):
    assert '\t' not in ln, k
    lead = len(ln) - len(ln.lstrip(' '))
    assert lead % 4 == 0, (k, ln)
    code = re.sub(r'"[^"]*"', '""', ln.split('//')[0] if not ln.lstrip().startswith('//') else '')
    assert code.count('(') == code.count(')') and code.count('[') == code.count(']'), (k, ln)
    assert not re.search(r'(\band|\bor|[+\-*/,(])\s*$', code), ('a wrapped line', k, ln)
# every "for i = 0 to x - 1" has a guard against an empty list (Pine counts DOWN when x - 1 < 0)
for k, ln in enumerate(lines):
    if re.search(r'for \w+ = 0 to (\w+) - 1', ln):
        var = re.search(r'to (\w+) - 1', ln).group(1)
        assert re.search(r'if %s > 0' % var, lines[k - 1]), ('unguarded loop', k + 1, ln)
# no array access beside a size check on one line (Pine v5 evaluates both sides of and / or)
for k, ln in enumerate(lines, 1):
    assert not re.search(r'(size\(\w+\) > 0|>= 0) and array\.get', ln), ('and is not lazy in v5', k, ln)
print('OK')
