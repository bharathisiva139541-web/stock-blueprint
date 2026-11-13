# -*- coding: utf-8 -*-
"""Pattern detectors of the bullish pattern engine (owner, 13-Nov-2026; docs/PATTERN_ENGINE_PLAN.md, the written rules in
pattern_registry.SPECS). One function per pattern FAMILY; they only find patterns - entries, stops, targets and the account
stay in backtest_lab.simulate / portfolio (detection kept apart from execution).

EVENT = [act, conf, occ, trigger, stop_ref, aux]
  occ      the first candle of the pattern
  conf     the candle whose CLOSE confirmed it (a pivot-based pattern: the candle the pivot became known on - never the
           pivot candle itself)
  act      the first candle an entry may use (= conf: its close, or the next open)
  trigger  a price level of the pattern (the breakout level, the pattern's high ...)
  stop_ref the pattern's own stop reference (its low)
  aux      a number for the breakdowns (or None)
LIFECYCLE: a detector follows a pattern through potential / forming inside its own loop and emits it once, when
CONFIRMED (one event per occurrence - a pattern that stays true for several candles is not counted again). Entry eligible /
triggered / expired / invalidated / completed are decided by the entry model in backtest_lab.simulate.

Causal by construction: an event depends only on candles <= its conf candle (tests/fixtures/pcbridge_patterns_check.py cuts
every chart at many points and changes the candles after the cut - the events up to the cut must not change).
"""
import hashlib
import json

import indicators as ind
import pattern_registry as reg
import structure

VERSIONS = {pid: reg.SPECS[pid]['version'] for pid in reg.SPECS}
STATES = ('potential', 'forming', 'confirmed', 'entry eligible', 'triggered', 'expired', 'invalidated', 'completed')

# B01-B04: the level's length per timeframe (B04 = every candle before it, after a minimum history)
HI_N = {'B01': {'D': 20, 'W': 20, '4H': 20}, 'B02': {'D': 50, 'W': 50, '4H': 50}, 'B03': {'D': 252, 'W': 52, '4H': 504},
        'B04': {'D': 0, 'W': 0, '4H': 0}}
ATH_MIN = {'D': 252, 'W': 52, '4H': 504}


def params_for(pid, P):
    """The pattern's own parameters from the Lab's params (the registry's defaults for the rest)."""
    base = dict(reg.SPECS[pid]['params'])
    for k in base:
        if P and k in P and P[k] is not None:
            base[k] = P[k]
    return base


def param_hash(pid, params):
    s = json.dumps([pid, VERSIONS.get(pid), sorted(params.items())], sort_keys=True)
    return hashlib.sha1(s.encode('utf-8')).hexdigest()[:12]


def bullish_engulfing(o, h, l, c, v, tf, p):
    """K08 - see pattern_registry.SPECS['K08']."""
    a14 = ind.atr(h, l, c, 14) if p['engBody'] else None
    out = []
    for i in range(1, len(c)):
        o1, c1, o2, c2 = o[i - 1], c[i - 1], o[i], c[i]
        if not (c1 < o1 and c2 > o2):
            continue
        if not (o2 <= c1 and c2 >= o1 and (c2 - o2) > (o1 - c1)):
            continue
        if p['engBody']:
            a = a14[i - 1]
            if a is None or (c2 - o2) < p['engBody'] * a:
                continue
        out.append([i, i, i - 1, h[i], min(l[i - 1], l[i]), None])
    return out


def high_breakout(pid):
    """B01-B04 - see pattern_registry.SPECS (a fresh close above the highest high of the N candles before)."""
    def det(o, h, l, c, v, tf, p):
        n = HI_N[pid][tf]
        lvl = ind.prior_high(h, n)
        rv = ind.rel_volume(v, 20) if p['boVol'] else None
        k = 1 + p['boBuf'] / 100.0
        need = ATH_MIN[tf] if pid == 'B04' else 0
        out, prev = [], False
        for i in range(len(c)):
            up = lvl[i] is not None and c[i] > lvl[i] * k
            fresh, prev = up and not prev, up
            if not fresh or i < need:
                continue
            if p['boVol']:
                r = rv[i]
                if r is None or r < p['boVol']:
                    continue
            out.append([i, i, i, lvl[i], l[i], round(c[i] / lvl[i] * 100 - 100, 2)])
        return out
    return det


def rsi_divergence(o, h, l, c, v, tf, p):
    """I01 - see pattern_registry.SPECS['I01']: two consecutive confirmed swing lows, price lower low, RSI higher low."""
    n = int(p['divPivot'])
    r = ind.rsi(c, int(p['rsiN']))
    _, pl = structure.pivots(h, l, n)
    out = []
    for a, b in zip(pl, pl[1:]):
        if b - a < n or b - a > p['divMaxGap'] or not l[b] < l[a]:
            continue
        ra, rb = r[a], r[b]
        if ra is None or rb is None or not rb > ra:
            continue
        if p['divRsiMax'] < 100 and ra > p['divRsiMax']:
            continue
        k = b + n                                # the 2nd swing low is known on this candle
        out.append([k, k, a, max(h[b:k + 1]), l[b], round(rb - ra, 2)])
    return out


DETECTORS = {'K08': bullish_engulfing, 'B01': high_breakout('B01'), 'B02': high_breakout('B02'), 'B03': high_breakout('B03'),
             'B04': high_breakout('B04'), 'I01': rsi_divergence}


def detect(pid, o, h, l, c, v, tf, P=None):
    """The events of pattern `pid` on one stock's candles (lists, oldest first) of timeframe tf ('D' / 'W' / '4H')."""
    return DETECTORS[pid](o, h, l, c, v, tf, params_for(pid, P))
