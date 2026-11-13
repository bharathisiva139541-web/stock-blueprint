# -*- coding: utf-8 -*-
"""The TradingView indicator (tradingview/StockBlueprint_CHoCH_FVG.pine) = the laptop's backtest: its bar-by-bar logic
(tradingview/pine_model.py, the .pine's steps in Python) finds exactly the CHoCH events of structure.py and the TRADES the
Backtest Lab's run_job takes with group 'First touch of a zone' (signal candle, entry, stop, target) for the same rules -
market structure only / off, discount levels and zone parts, zone-top / close entry, every stop kind, max risk, min price,
R / swing-high target, dates, turnover, EMA confluence, the structure engine's options (ZigZag swings, swings standing out by
x ATR, the protected-high CHoCH, equal highs / lows - owner, 12-Nov-2026) - on random charts and a made one; the .pine's
defaults = the Lab's;
Pine v5 layout checks. `--lint FILE...` runs only the layout checks (tests/tradingview-pine.test.js lints the scripts the
Lab page writes - web/lib/pine.js).
Owner, 11-Nov-2026: "i open trading view chart and i go to that trade date. i check how our backtest enter the trade ...
it would be helpful if i got pinescript indicator"; "give option to copy the pinescript in this page that works with respect
to the current setup". Prints OK at the end."""
import importlib.util
import os
import random
import re
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')


def lint(path):
    """Pine v5 layout: no tabs, blocks indented by 4 spaces, one statement a line (no wrapped lines), brackets balanced,
    guarded `for k = 0 to x - 1` loops (Pine counts DOWN when x - 1 < 0), no array access beside a size check in one
    `and` (v5 evaluates both sides)."""
    src = open(path, encoding='utf-8').read()
    lines = src.split('\n')
    assert lines[0] == '//@version=5', path
    for k, ln in enumerate(lines, 1):
        assert '\t' not in ln, (path, k)
        lead = len(ln) - len(ln.lstrip(' '))
        assert lead % 4 == 0, (path, k, ln)
        code = re.sub(r'"[^"]*"', '""', ln.split('//')[0] if not ln.lstrip().startswith('//') else '')
        assert code.count('(') == code.count(')') and code.count('[') == code.count(']'), (path, k, ln)
        assert not re.search(r'(\band|\bor|[+\-*/,(])\s*$', code), ('a wrapped line', path, k, ln)
        assert code.count('"') % 2 == 0, (path, k, ln)
    for k, ln in enumerate(lines):
        if re.search(r'for \w+ = 0 to (\w+) - 1', ln):
            var = re.search(r'to (\w+) - 1', ln).group(1)
            assert re.search(r'if %s > 0' % var, lines[k - 1]), ('unguarded loop', path, k + 1, ln)
        if re.search(r'for \w+ = (\w+) - 1 to 0', ln):
            var = re.search(r'= (\w+) - 1 to 0', ln).group(1)
            assert re.search(r'if %s > 0' % var, lines[k - 1]), ('unguarded loop', path, k + 1, ln)
    for k, ln in enumerate(lines, 1):
        assert not re.search(r'(size\(\w+\) > 0|>= 0) and array\.get', ln), ('and is not lazy in v5', path, k, ln)
    return src


if len(sys.argv) > 2 and sys.argv[1] == '--lint':
    for f in sys.argv[2:]:
        lint(f)
    print('OK')
    sys.exit(0)

sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(ROOT, 'tradingview'))
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
S = L.structure
L.log = lambda m: None
L.LAB_DIR = os.path.join(tempfile.mkdtemp(), 'lab_cache')
import pine_model as M  # noqa: E402

D0 = date(2016, 1, 4)


def walk(seed, n, vol=0.05):
    rnd = random.Random(seed)
    out, px = [], 100.0
    for _ in range(n):
        o = px * (1 + rnd.uniform(-0.03, 0.03))
        c = o * (1 + rnd.uniform(-vol, vol))
        h = max(o, c) * (1 + rnd.uniform(0, 0.03))
        lo = min(o, c) * (1 - rnd.uniform(0, 0.03))
        out.append((round(o, 2), round(h, 2), round(lo, 2), round(c, 2), rnd.randint(1000, 90000)))
        px = c
    return out


def candles(rows):
    return [{'t': (D0 + timedelta(days=k)).isoformat(), 'day': (D0 + timedelta(days=k)).isoformat(), 'o': o, 'h': h, 'l': lo, 'c': c, 'v': v}
            for k, (o, h, lo, c, v) in enumerate(rows)]


def build_cache(charts):
    """{sym: rows} -> the Lab's cache (the same rows a backtest pass writes for the daily chart)."""
    w = L.CacheWriter(D0 + timedelta(days=5000))
    for sym, rows in charts.items():
        cs = candles(rows)
        turn = L.turnover_fn([[c['day'], c['o'], c['h'], c['l'], c['c'], c['v']] for c in cs])
        w.add(sym, 'D', cs, K.lab_signal_rows(cs, 'D', {}, None, turn))
    w.close()


def model(rows, P):
    m = M.Model(P)
    for k, (o, h, lo, c, v) in enumerate(rows):
        m.bar(o, h, lo, c, v, (D0 + timedelta(days=k)).toordinal())
    return m


def lab_trades(params):
    res = L.run_job(dict(params, tf='D'))
    cols = res['tradeCols']
    ix = {c: cols.index(c) for c in ('sym', 'signal', 'entry', 'stop', 'target')}
    assert res['tradesTotal'] == len(res['trades']), 'every trade listed'
    return sorted((r[ix['sym']], r[ix['signal']], round(r[ix['entry']], 2), round(r[ix['stop']], 2), round(r[ix['target']], 2)) for r in res['trades'])


def model_trades(charts, params):
    P = L.clean_params(dict(params, tf='D'))
    out = []
    for sym, rows in charts.items():
        for b in model(rows, P).buys:
            out.append((sym, (D0 + timedelta(days=b[0])).isoformat(), round(b[6], 2), round(b[7], 2), round(b[8], 2)))
    return sorted(out)


# ------------------------------------------------------------------ 1. random charts: the model's BUYs = the Lab's trades
charts = {'R%02d' % seed: walk(seed, 1500, vol=0.05 if seed % 2 else 0.035) for seed in range(30)}
build_cache(charts)
SMC = {'group': 'touch', 'structure': 'only', 'pivotN': 5, 'downN': 3, 'zoneWhen': 'both', 'belowChoch': False, 'discount': 0.5,
       'discPart': 'mid', 'firstPull': True, 'chochAge': 0, 'stop': 'zone', 'entry': 'zone'}
SETS = [SMC,
        dict(SMC, pivotN=3, downN=1),
        dict(SMC, pivotN=2, downN=1, zoneWhen='leg', discount=0.618, discPart='top', entry='close', stop='lower', stopBuf=1),
        dict(SMC, pivotN=3, downN=1, zoneWhen='after', firstPull=False, discount=0, belowChoch=True, entry='close', stop='spring'),
        dict(SMC, pivotN=2, downN=1, discount=0.382, discPart='bottom', stop='pct', stopPct=4, maxRisk=6, targetMode='swing', swingMinR=1.5),
        dict(SMC, pivotN=3, downN=1, chochAge=40, targetR=3, minPrice=95, maxRisk=0, **{'from': '2017-06-01', 'to': '2018-12-31'}),
        dict(SMC, pivotN=3, downN=1, emaSupport=1, emaTouch=2, above50=True, minTurnover=46),
        dict(SMC, pivotN=2, downN=1, emaSupport=21, emaStack=True, entry='close'),
        dict(SMC, structure='off', maxRisk=8),
        dict(SMC, structure='off', entry='close', stop='lower', targetMode='swing', swingMinR=1, maxRisk=0),
        # the structure engine's options (owner, 12-Nov-2026: "புதிய structure options-ஐயும் (protected, equal highs, ZigZag)
        # TradingView script வரையும்படி மாற்றுவது")
        dict(SMC, swingMode='zigzag', zzAtr=2, downN=1),
        dict(SMC, swingMode='zigzag', zzAtr=1, downN=2, discount=0.382, targetMode='swing', swingMinR=1),
        dict(SMC, pivotN=3, downN=1, swingAtr=1),
        dict(SMC, pivotN=2, downN=2, swingAtr=0.5, targetMode='swing', swingMinR=1.5, firstPull=False, discount=0),
        dict(SMC, pivotN=3, downN=1, chochMode='protected'),
        dict(SMC, pivotN=2, downN=1, chochMode='protected', eqAtr=0.25, discount=0.618),
        dict(SMC, pivotN=3, downN=1, eqAtr=0.5),
        dict(SMC, swingMode='zigzag', zzAtr=1.5, downN=1, chochMode='protected', eqAtr=0.1, entry='close', stop='lower'),
        # the owner's refinements of 12-Nov-2026 the script draws: the Gap-up zone entry inside an FVG (on by default above - and
        # off here), the stop under the CHoCH's final low
        dict(SMC, pivotN=3, downN=1, gapEntry=False), dict(SMC, pivotN=2, downN=1, gapEntry=False, entry='close', stop='lower'),
        dict(SMC, pivotN=3, downN=1, stop='final', maxRisk=0), dict(SMC, structure='off', pivotN=3, downN=1, stop='final', entry='close', maxRisk=0),
        # the 2nd-zone rule (owner, 12-Nov-2026: on by default above) - off, and with every zone counting (no discount rule)
        dict(SMC, pivotN=3, downN=1, zonePick='every'), dict(SMC, pivotN=2, downN=1, discount=0, zoneWhen='leg'),
        dict(SMC, pivotN=3, downN=1, discount=0.382, discPart='top', entry='close', stop='lower'),
        # a zone touched before the CHoCH counts again (owner, 13-Nov-2026: on by default above) - off, and with every zone
        dict(SMC, pivotN=3, downN=1, touchAgain=False), dict(SMC, pivotN=2, downN=1, touchAgain=False, zonePick='every'),
        dict(SMC, pivotN=2, downN=2, zonePick='every', discount=0.382),
        # the owner's stop / target options (13-Nov-2026): the ATR stop with every stop kind, the move-high and % targets
        dict(SMC, pivotN=3, downN=1, stopAtr=1.5), dict(SMC, pivotN=2, downN=1, stop='pct', stopPct=3, stopAtr=2, maxRisk=10, entry='close'),
        dict(SMC, pivotN=3, downN=1, stop='final', stopAtr=1, maxRisk=0), dict(SMC, pivotN=2, downN=1, stop='lower', entry='close', stopAtr=0.5),
        dict(SMC, pivotN=3, downN=1, targetMode='mh'), dict(SMC, structure='off', pivotN=3, downN=1, targetMode='mh', swingMinR=0, entry='close', maxRisk=0),
        dict(SMC, pivotN=2, downN=1, targetMode='pct', targetPct=25, stopAtr=1, stop='lower', entry='close')]
counts = []
for params in SETS:
    lab, mod = lab_trades(params), model_trades(charts, params)
    assert mod == lab, (params, [x for x in mod if x not in lab][:3], [x for x in lab if x not in mod][:3])
    counts.append(len(lab))
assert min(counts) >= 2 and sum(counts) > 900, counts   # (13-Nov-2026: the owner's setup rules leave fewer trades)
assert lab_trades(dict(SMC, pivotN=3, downN=1)) != lab_trades(dict(SMC, pivotN=3, downN=1, gapEntry=False)), 'the Gap-up zone entry changes some trades on these charts'
assert lab_trades(dict(SMC, pivotN=3, downN=1)) != lab_trades(dict(SMC, pivotN=3, downN=1, zonePick='every')), 'the 2nd-zone rule changes trades'
assert lab_trades(dict(SMC, pivotN=3, downN=1)) != lab_trades(dict(SMC, pivotN=3, downN=1, touchAgain=False)), 'touchAgain changes trades'
assert lab_trades(dict(SMC, pivotN=3, downN=1)) != lab_trades(dict(SMC, pivotN=3, downN=1, stopAtr=1.5)), 'the ATR stop changes stops'
assert lab_trades(dict(SMC, pivotN=3, downN=1)) != lab_trades(dict(SMC, pivotN=3, downN=1, targetMode='mh')), 'the move-high target'
# the CHoCH events of every chart = structure.py's - the baseline and every structure option
OPTS = [{}, {'swingMode': 'zigzag', 'zzAtr': 2}, {'swingMode': 'zigzag', 'zzAtr': 1}, {'swingMode': 'zigzag', 'zzAtr': 3, 'chochMode': 'protected'},
        {'swingAtr': 1}, {'swingAtr': 0.5, 'eqAtr': 0.25}, {'chochMode': 'protected'}, {'chochMode': 'protected', 'eqAtr': 0.5}, {'eqAtr': 0.1},
        {'swingMode': 'zigzag', 'zzAtr': 1.5, 'eqAtr': 0.25, 'swingAtr': 2}]
seen = {}
for sym, rows in charts.items():
    hh, ll, cc = [r[1] for r in rows], [r[2] for r in rows], [r[3] for r in rows]
    for n in (2, 3, 5):
        for opt in OPTS:
            P = L.clean_params(dict(opt, pivotN=n, downN=1, structure='only'))
            so = L.struct_opts(P)
            m = model(rows, P)
            assert m.events == S.choch_events(hh, ll, cc, n, opts=so or None), (sym, n, opt)
            seen[str(opt)] = seen.get(str(opt), 0) + len(m.events)
            st = S.Structure(hh, ll, cc, n, so or None)
            assert m.phV == [hh[p] for p in st.ph], (sym, n, opt)        # the swing highs the target / BOS use
            for b, x in m.bos.items():                 # a BOS the model saw = the laptop's (the CHoCH current then)
                k = next(k for k, e in enumerate(st.events) if e[0] == b)
                assert st.bos_before(k, cc, len(cc)) == x, (sym, n, opt, b, x)
assert min(seen.values()) > 50, seen
# the options change what is found (not the baseline under another name)
base = seen[str({})]
assert all(v != base for k, v in seen.items() if k != str({})), seen


# ------------------------------------------------------------------ 2. the owner's SUPREMEIND case (made chart): the premium FVG's
# touch is not a BUY, the discount FVG's first touch is - also when one candle goes through both
def craft(big=False):
    rows, prev = [], [165.0]

    def put(o, h, lo, c):
        rows.append((round(o, 2), round(h, 2), round(lo, 2), round(c, 2), 900000))

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


made = {'SUP': craft(), 'SUB': craft(big=True)}
build_cache(made)
P0 = L.clean_params(dict(SMC, tf='D'))
for sym, rows in made.items():
    m = model(rows, P0)
    assert len(m.buys) == 1 and m.buys[0][2:4] == [121.3, 126.5] and rows[m.buys[0][0]][2] == 124.8, (sym, m.buys)
    assert m.buys[0][6] == 126.5 and abs(m.buys[0][7] - 121.3 * 0.995) < 1e-9, m.buys     # an order at the zone top, stop under the zone
    loose = model(rows, L.clean_params(dict(SMC, tf='D', discount=0, zonePick='every')))
    # without the discount rule the premium zone was the BUY (the SUPREMEIND run) - since 13-Nov-2026 it lies wholly above the CHoCH
    # level, so it is no zone of the setup
    assert loose.buys[0][2:4] == [121.3, 126.5], loose.buys
    # the owner's 2nd-zone rule (12-Nov-2026): both zones count without the discount rule - the higher one is only watched
    two = model(rows, L.clean_params(dict(SMC, tf='D', discount=0)))
    assert [b[2:4] for b in two.buys][:1] == [[121.3, 126.5]], two.buys
for extra in ({}, {'discount': 0}, {'discount': 0, 'zonePick': 'every'}):
    assert lab_trades(dict(SMC, **extra)) == model_trades(made, dict(SMC, **extra)), extra

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
assert float(default('stopPct')) == D['stopPct'] and float(default('maxRisk')) == D['maxRisk'] and float(default('minPrice')) == D['minPrice']
assert float(default('swingMinR')) == D['swingMinR'] and int(default('chochAge')) == D['chochAge'] and float(default('emaTouch')) == D['emaTouch']
assert default('structOnly') == 'true' and default('entryMode') == 'Order at the zone top' and default('stopMode') == 'Under the zone bottom'
assert default('targetMode') == 'R multiple' and default('emaSup') == 'Off' and float(default('minTurn')) == D['minTurnover'] == 0
# the structure options (owner, 12-Nov-2026): the Lab's defaults and limits, and the script's own steps = the model's
assert default('swMode') == 'Candles each side' and D['swingMode'] == 'fractal' and default('chMode') == 'The last swing high' and D['chochMode'] == 'last'
assert float(default('zzAtr')) == D['zzAtr'] and float(default('swAtr')) == D['swingAtr'] == 0 and float(default('eqAtr')) == D['eqAtr'] == 0
assert default('gapEntry') == 'true' and D['gapEntry'] is True and 'linkZone(' in src and 'bool waitsInside = gapEntry and not zg and array.get(zInner, k)' in src
assert '"Under the CHoCH\'s final low"' in src and M.LINK_SPAN == K.ZONE_LINK_SPAN
assert default('zonePick') == 'Trade the 2nd (the 1st only watched)' and D['zonePick'] == 'second' and 'zPass(fj, bj, tj, chLi' in src
assert default('touchAgain') == 'true' and D['touchAgain'] is True and 'if structOnly and touchAgain' in src and 'while array.size(tzF) > 300' in src
for name, key in (('zzAtr', 'zzAtr'), ('swAtr', 'swingAtr'), ('eqAtr', 'eqAtr')):
    mm = re.search(r'^%s = input\.float\([^\n]*minval=([\d.]+), maxval=([\d.]+)' % name, src, re.M)
    assert mm and (float(mm.group(1)), float(mm.group(2))) == L.LIMITS[key][:2], (name, L.LIMITS[key])
assert src.count('- eqAtr * array.get(swA, kk)') == 2 and 'swBase := sz6' in src and 'float zA = zzAtr * atrS' in src
assert 'high[pivN] - loWin >= swAtr * atrS[pivN]' in src and 'hiWin - low[pivN] >= swAtr * atrS[pivN]' in src
assert 'if hiNew and hiNewP > chB' in src and 'if array.get(phV, j) >= above' in src
# the stop / target options (owner, 13-Nov-2026)
assert float(default('stopAtr')) == D['stopAtr'] == 0 and float(default('targetPct')) == D['targetPct']
mm = re.search(r'^stopAtr = input\.float\([^\n]*minval=([\d.]+), maxval=([\d.]+)', src, re.M)
assert mm and (float(mm.group(1)), float(mm.group(2))) == L.LIMITS['stopAtr'][:2]
assert 'stop := math.min(stop, entry - stopAtr * (atTop ? atrS[1] : atrS))' in src and 'tgt := chH' in src
assert '"The move high (HH)", "% above the entry"]' in src and set(L.CHOICES['targetMode']) == {'R', 'swing', 'mh', 'pct'}
lint(os.path.join(ROOT, 'tradingview', 'StockBlueprint_CHoCH_FVG.pine'))
print('OK')
