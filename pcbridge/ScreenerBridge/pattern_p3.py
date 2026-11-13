# -*- coding: utf-8 -*-
"""Phase 3 detectors of the bullish pattern engine (owner, 13-Nov-2026: "Do it" - price action / structure P01-P24, SMC / ICT
S01-S25, the rest of the volume patterns V09 V10 V11 V14 V16, momentum I02-I24, quant Q01-Q20, and the moving-average ones
left from phase 2: Ichimoku M13-M15, anchored VWAP M17, EMA compression M18). The written rules: pattern_registry.SPECS
(P3 + COMMON + COMMON3).

Same contract as pattern_detect.py: det(x, p) -> EVENTS [act, conf, occ, trigger, stop_ref, aux] on the shared Ctx `x`, emitted
once when CONFIRMED, using only candles <= the conf candle (tests/fixtures/pcbridge_patterns_check.py cuts every chart and
changes the candles after the cut).

Swings: structure.pivots(h, l, n) - a swing at candle p is KNOWN at candle p + n. A rule that uses "the latest swing" at candle
i uses the swings known BEFORE it (p + n < i); a pattern whose signal IS the swing becoming known (P01 P04 P05 P24, the
divergences) signals on candle p + n, never on p.
"""
import bisect

import indicators as ind
import pattern_detect as pd
import structure


# ------------------------------------------------------------------ shared helpers
def _piv(x, n):
    return x._get(('piv', n), lambda: structure.pivots(x.h, x.l, n))


def _known(ps, i, n):
    """How many of the pivots ps (sorted) were known before candle i (p + n < i)."""
    return bisect.bisect_left(ps, i - n)


def _sw(p):
    return int(p.get('patSwing', 5))


def _lo(x, a, b):
    return min(x.l[max(0, a):b + 1])


def _hi(x, a, b):
    return max(x.h[max(0, a):b + 1])


def _ev(i, occ, trig, stop, aux=None):
    return [i, i, occ, trig, stop, aux]


def _cross_up(a, b, i):
    """Series a crosses above series (or number) b on candle i."""
    bi = b[i] if isinstance(b, list) else b
    bj = b[i - 1] if isinstance(b, list) else b
    return (i >= 1 and a[i] is not None and a[i - 1] is not None and bi is not None and bj is not None and
            a[i] > bi and a[i - 1] <= bj)


def _rsi(x, n=14):
    return x._get(('rsi', n), lambda: ind.rsi(x.c, n))


def _macd(x):
    return x._get(('macd',), lambda: ind.macd(x.c))


def _bbs(x, n=20, k=2.0):
    """(middle, upper, lower) Bollinger Bands n, k (population standard deviation)."""
    def mk():
        m, s = ind.sma(x.c, n), ind.stdev(x.c, n)
        return (m, [None if a is None else a + k * b for a, b in zip(m, s)],
                [None if a is None else a - k * b for a, b in zip(m, s)])
    return x._get(('bbs', n, k), mk)


def _z(x, n):
    def mk():
        m, s = ind.sma(x.c, n), ind.stdev(x.c, n)
        return [None if a is None or not b else (x.c[i] - a) / b for i, (a, b) in enumerate(zip(m, s))]
    return x._get(('z', n), mk)


def _sig(cond, stop_look=10, occ_back=0):
    """A signal on every candle where cond(x, i) is true (the rule itself says when it is fresh): stop reference = the lowest
    low of the last stop_look candles incl. the signal one."""
    def det(x, p):
        out = []
        for i in range(1, x.n):
            if cond(x, i):
                out.append(_ev(i, max(0, i - occ_back), x.h[i], _lo(x, i - stop_look + 1, i)))
        return out
    return det


# ------------------------------------------------------------------ P. price action / market structure
def _p01(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out = []
    for k in range(1, len(pl)):
        p1, p2 = pl[k - 1], pl[k]
        i = p2 + n
        if i >= x.n or not x.l[p2] > x.l[p1]:
            continue
        a, b = bisect.bisect_right(ph, p1), bisect.bisect_left(ph, p2)
        if a >= b or a == 0:
            continue
        h2 = max(x.h[q] for q in ph[a:b])
        h1 = x.h[ph[a - 1]]
        if h2 > h1:
            out.append(_ev(i, p1, h2, x.l[p2]))
    return out


def _p02(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out, used, j = [], set(), None
    for i in range(1, x.n):
        if j is not None:
            if x.l[i] < x.l[j]:
                j = None                          # a lower low again - this failure is off
            elif x.c[i] > x.h[j]:
                out.append(_ev(i, j, x.h[j], x.l[j]))
                j = None
            elif i - j >= 5:
                j = None
        k = _known(pl, i, n)
        if k and j is None:
            q = pl[k - 1]
            if q not in used and x.l[i] < x.l[q]:
                used.add(q)
                j = i
    return out


def _p03(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    out, done = [], set()
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if k < 2:
            continue
        q, q0 = ph[k - 1], ph[k - 2]
        if q in done or not x.h[q] < x.h[q0] or i - q > 100:
            continue
        if x.c[i] > x.h[q]:
            done.add(q)
            out.append(_ev(i, q, x.h[q], _lo(x, q, i)))
    return out


def _p04(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out = []
    for k in range(2, len(ph)):
        q = ph[k]
        i = q + n
        if i >= x.n or not (x.h[ph[k - 2]] > x.h[ph[k - 1]] and x.h[q] > x.h[ph[k - 1]]):
            continue
        m = bisect.bisect_left(pl, q)
        if m < 2 or not x.l[pl[m - 2]] > x.l[pl[m - 1]]:
            continue
        out.append(_ev(i, ph[k - 1], x.h[q], _lo(x, ph[k - 1], i)))
    return out


def _p05(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out = []
    for k in range(2, len(pl)):
        q = pl[k]
        i = q + n
        if i >= x.n or not (x.l[pl[k - 2]] > x.l[pl[k - 1]] and x.l[q] > x.l[pl[k - 1]]):
            continue
        m = bisect.bisect_left(ph, q)
        if m < 2 or not x.h[ph[m - 2]] > x.h[ph[m - 1]]:
            continue
        out.append(_ev(i, pl[k - 1], _hi(x, q, i), x.l[q]))
    return out


def _choch(x, n):
    return x._get(('choch', n), lambda: structure.choch_events(x.h, x.l, x.c, n))


def _p06(x, p):
    return [_ev(b, li, lvl, lf, d) for b, hi, lvl, li, lf, d in _choch(x, _sw(p)) if d >= 2]


def _p07(x, p):
    out = []
    for b, hi, lvl, li, lf, d in _choch(x, _sw(p)):
        a = x.a_before(b)
        if d >= 2 and a and x.green(b) and x.body(b) >= 1.2 * a and x.clv(b) >= 0.5:
            out.append(_ev(b, li, lvl, lf, d))
    return out


def _p08(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out, done = [], set()
    for i in range(1, x.n):
        k, m = _known(ph, i, n), _known(pl, i, n)
        if k < 2 or m < 2:
            continue
        q = ph[k - 1]
        if q in done or i - q > 100 or not (x.h[q] > x.h[ph[k - 2]] and x.l[pl[m - 1]] > x.l[pl[m - 2]]):
            continue
        if x.c[i] > x.h[q]:
            done.add(q)
            out.append(_ev(i, pl[m - 1], x.h[q], x.l[pl[m - 1]]))
    return out


def _sweep(depth_atr=0.0):
    """P09 / S06: a candle's low under the latest known swing low (by at least depth_atr x ATR) and its close back above it -
    the first candle that takes that swing low decides (a close below = taken, no signal)."""
    def det(x, p):
        n = _sw(p)
        _, pl = _piv(x, n)
        out, taken = [], set()
        for i in range(1, x.n):
            k = _known(pl, i, n)
            if not k:
                continue
            q = pl[k - 1]
            L = x.l[q]
            if q in taken or not x.l[i] < L:
                continue
            taken.add(q)
            a = x.a_before(i)
            if x.c[i] > L and (not depth_atr or (a and L - x.l[i] >= depth_atr * a)):
                out.append(_ev(i, q, x.h[i], x.l[i], round(100.0 * (L - x.l[i]) / L, 2)))
        return out
    return det


def _failed_break(level_fn, look=3):
    """P10 / P11: a close under a support level, then within `look` candles a close back above it."""
    def det(x, p):
        out, j, lv, used = [], None, None, set()
        for i in range(1, x.n):
            if j is not None:
                if x.c[i] > lv:
                    out.append(_ev(i, j, lv, _lo(x, j, i)))
                    j = None
                elif i - j >= look:
                    j = None
                continue
            key, lvl = level_fn(x, p, i)
            if lvl is not None and key not in used and x.c[i] < lvl:
                used.add(key)
                j, lv = i, lvl
        return out
    return det


def _lvl_swing(x, p, i):
    n = _sw(p)
    _, pl = _piv(x, n)
    k = _known(pl, i, n)
    return (pl[k - 1], x.l[pl[k - 1]]) if k else (None, None)


def _lvl_range(x, p, i):
    pl = x.plo(20)
    if pl[i] is None or i < 21 or pl[i - 1] is None or x.c[i - 1] < pl[i - 1]:
        return None, None               # fresh only: the close before was not already under ITS range low
    return ('r', i), pl[i]


def _p12(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out, used = [], set()
    for i in range(1, x.n):
        k = _known(pl, i, n)
        if k < 2:
            continue
        q1 = pl[k - 1]
        if q1 in used:
            continue
        q0 = next((q for q in pl[max(0, k - 3):k - 1][::-1] if q1 - q <= 60 and abs(x.l[q] - x.l[q1]) <= 0.01 * x.l[q1]), None)
        if q0 is None:
            continue
        S = min(x.l[q0], x.l[q1])
        if x.c[i] < S:
            used.add(q1)                       # the support broke
            continue
        r = x.rng(i)
        if x.l[i] <= S * 1.005 and x.c[i] > S and x.green(i) and r > 0 and x.lo(i) >= 0.4 * r:
            used.add(q1)
            out.append(_ev(i, q0, x.h[i], x.l[i], round(S, 4)))
    return out


def _p13(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    out, used, st = [], set(), None          # st = (key, level, breakout candle)
    for i in range(1, x.n):
        if st is not None:
            key, R, j = st
            if x.c[i] < R or i - j > 20:
                st = None
            elif x.l[i] <= R * 1.01 and x.green(i):
                out.append(_ev(i, j, R, x.l[i]))
                st = None
            continue
        k = _known(ph, i, n)
        if k < 2:
            continue
        q1 = ph[k - 1]
        if q1 in used:
            continue
        q0 = next((q for q in ph[max(0, k - 3):k - 1][::-1] if q1 - q <= 120 and abs(x.h[q] - x.h[q1]) <= 0.01 * x.h[q1]), None)
        if q0 is None:
            continue
        R = max(x.h[q0], x.h[q1])
        if x.c[i] > R:
            used.add(q1)
            st = (q1, R, i)
    return out


def _retests(x, p):
    """P14 / P15: [(breakout candle j, retest candle r, P15 candle or None)] - the first close above the latest known swing high,
    a candle back to within 1 % of it (or under it) closing above it within 15 candles, then a close above that candle's high
    within 3 more candles."""
    def mk():
        n = _sw(p)
        ph, _ = _piv(x, n)
        out, used = [], set()
        st = None
        for i in range(1, x.n):
            if st is not None:
                H, j, r = st
                if r is None:
                    if x.c[i] < H or i - j > 15:
                        st = None
                    elif x.l[i] <= H * 1.01:
                        out.append([j, i, None])
                        st = (H, j, i)
                    continue
                if x.c[i] > x.h[r]:
                    out[-1][2] = i
                    st = None
                elif i - r >= 3 or x.c[i] < H:
                    st = None
                continue
            k = _known(ph, i, n)
            if k and ph[k - 1] not in used and x.c[i] > x.h[ph[k - 1]]:
                used.add(ph[k - 1])
                st = (x.h[ph[k - 1]], i, None)
        return out
    return x._get(('retest', _sw(p)), mk)


def _p14(x, p):
    return [_ev(r, j, x.h[r], x.l[r]) for j, r, f in _retests(x, p)]


def _p15(x, p):
    return [_ev(f, r, x.h[r], _lo(x, r, f)) for j, r, f in _retests(x, p) if f is not None]


def _p16(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    s50 = x.sma(50)
    out, used = [], set()
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if k < 2:
            continue
        q1, q2 = ph[k - 2], ph[k - 1]
        H1 = x.h[q1]
        if q2 in used or not x.h[q2] > H1 or i - (q2 + n) > 40:
            continue
        if x.c[i] < H1:
            used.add(q2)
            continue
        if (x.l[i] <= H1 * 1.01 and s50[i] is not None and s50[i - 10] is not None and x.c[i] > s50[i] and
                s50[i] > s50[i - 10]):
            used.add(q2)
            out.append(_ev(i, q2, x.h[i], x.l[i]))
    return out


def _tl(x, p):
    """P17 / P18: [(break candle j, retest candle or None, line value at j)] for the descending line through the two latest known
    swing highs (the 2nd lower): the first close above the line within 60 candles of the 2nd high (the close before not above
    it), then a candle back to within 1 % of the line closing above it within 15 candles."""
    def mk():
        n = _sw(p)
        ph, _ = _piv(x, n)
        out, used, st = [], set(), None
        for i in range(1, x.n):
            if st is not None:
                f, j = st
                if x.c[i] < f(i) or i - j > 15:
                    st = None
                elif x.l[i] <= f(i) * 1.01:
                    out[-1][1] = i
                    st = None
                continue
            k = _known(ph, i, n)
            if k < 2:
                continue
            q1, q2 = ph[k - 2], ph[k - 1]
            if q2 in used or not x.h[q2] < x.h[q1] or i - q2 > 60:
                continue
            slope = (x.h[q2] - x.h[q1]) / float(q2 - q1)

            def f(t, q1=q1, slope=slope):
                return x.h[q1] + slope * (t - q1)
            if x.c[i] > f(i) and not x.c[i - 1] > f(i - 1):
                used.add(q2)
                out.append([i, None, f(i), q2])
                st = (f, i)
        return out
    return x._get(('tl', _sw(p)), mk)


def _p17(x, p):
    return [_ev(r, j, x.h[r], x.l[r]) for j, r, lv, q2 in _tl(x, p) if r is not None]


def _p18(x, p):
    return [_ev(j, q2, lv, _lo(x, q2, j)) for j, r, lv, q2 in _tl(x, p)]


def _p19(x, p):
    lv, lo, p30h, p30l = x.phi(10), x.plo(10), x.phi(30), x.plo(30)
    out = []
    for i in range(41, x.n):
        if lv[i] is None or p30h[i - 10] is None:
            continue
        if (lv[i] - lo[i]) <= 0.5 * (p30h[i - 10] - p30l[i - 10]) and x.fresh_above(lv, i):
            out.append(_ev(i, i - 10, lv[i], min(lo[i], x.l[i])))
    return out


def _p20(x, p):
    out = []
    for i in range(3, x.n):
        inside = x.h[i - 1] <= x.h[i - 2] and x.l[i - 1] >= x.l[i - 2]
        mother_in = x.h[i - 2] <= x.h[i - 3] and x.l[i - 2] >= x.l[i - 3]
        if inside and not mother_in and x.c[i] > x.h[i - 2]:
            out.append(_ev(i, i - 2, x.h[i - 2], min(x.l[i - 1], x.l[i])))
    return out


def _p21(x, p):
    return [_ev(i, i - 1, x.h[i], x.l[i]) for i in range(6, x.n)
            if x.h[i] > x.h[i - 1] and x.l[i] < x.l[i - 1] and x.green(i) and x.c[i] > x.h[i - 1] and x.c[i - 1] < x.c[i - 6]]


def _p22(x, p):
    def up(i):
        return i >= 4 and all(x.c[j] > x.c[j - 1] for j in range(i - 3, i + 1))
    return [_ev(i, i - 3, x.h[i], _lo(x, i - 3, i)) for i in range(5, x.n) if up(i) and not up(i - 1)]


def _p23(x, p):
    hi, lo = x.phi(10), x.plo(10)
    out = []
    for i in range(26, x.n):
        a = x.a_before(i - 10)
        if a and hi[i] is not None and hi[i] - lo[i] <= 2 * a and x.rng(i) >= 1.5 * a and x.c[i] > hi[i] and x.green(i):
            out.append(_ev(i, i - 10, hi[i], x.l[i]))
    return out


def _p24(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out = []
    for k in range(1, len(pl)):
        p1, p2 = pl[k - 1], pl[k]
        i = p2 + n
        if i >= x.n or not x.l[p2] < x.l[p1]:
            continue
        a = bisect.bisect_left(ph, p1)
        if not a:
            continue
        leg1 = x.h[ph[a - 1]] - x.l[p1]
        top = _hi(x, p1 + 1, p2 - 1) if p2 - p1 > 1 else x.h[p1]
        leg2 = top - x.l[p2]
        if leg1 > 0 and leg2 < 0.7 * leg1:
            out.append(_ev(i, p1, top, x.l[p2], round(leg2 / leg1, 2)))
    return out


# ------------------------------------------------------------------ S. smart money / ICT
def _s01(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out, taken = [], set()
    for i in range(1, x.n):
        k = _known(pl, i, n)
        if k < 3:
            continue
        q = min(pl[k - 3:k], key=lambda t: (x.l[t], -t))
        L = x.l[q]
        if q in taken or not x.l[i] < L:
            continue
        taken.add(q)
        a = x.a_before(i)
        if a and x.c[i] > L and L - x.l[i] >= 0.1 * a:
            out.append(_ev(i, q, x.h[i], x.l[i], round(100.0 * (L - x.l[i]) / L, 2)))
    return out


def _s02(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    at = x.atr(14)
    out, taken = [], set()
    for i in range(1, x.n):
        k = _known(pl, i, n)
        if k < 2:
            continue
        last = pl[max(0, k - 3):k]
        pair = None
        for b in range(len(last) - 1, 0, -1):
            for a_ in range(b - 1, -1, -1):
                qa, qb = last[a_], last[b]
                if at[qb] and abs(x.l[qa] - x.l[qb]) <= 0.25 * at[qb]:
                    pair = (qa, qb)
                    break
            if pair:
                break
        if not pair or pair in taken:
            continue
        L = min(x.l[pair[0]], x.l[pair[1]])
        if x.l[i] < L:
            taken.add(pair)
            if x.c[i] > L:
                out.append(_ev(i, pair[0], x.h[i], x.l[i]))
    return out


def _wk(d):
    return d - (d - 1) % 7


def _mo(d):
    from datetime import date as _date
    y = _date.fromordinal(d)
    return y.year * 12 + y.month


_PERIOD = {'S03': (lambda d: d, ('D', '4H')), 'S04': (_wk, ('D', '4H', 'W')), 'S05': (_mo, ('D', '4H', 'W'))}


def _period_sweep(pid):
    """S03 / S04 / S05: the first candle of a day / week / month whose low goes under the previous one's low decides - closing
    back above it (green) = the signal; closing under it = taken. Needs the candles' day ordinals; a period shorter than the
    candle (a day on weekly candles) has none."""
    keyf, tfs = _PERIOD[pid]

    def det(x, p):
        if not x.day or x.tf not in tfs:
            return []
        out = []
        prev = cur = ck = None
        done = False
        for i in range(x.n):
            k = keyf(x.day[i])
            if k != ck:
                prev, cur, ck, done = cur, None, k, False
            if prev is not None and not done and x.l[i] < prev:
                done = True
                if x.c[i] > prev and x.green(i):
                    out.append(_ev(i, i, x.h[i], x.l[i], round(prev, 4)))
            cur = x.l[i] if cur is None else min(cur, x.l[i])
        return out
    return det


def _s07(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    _, ml = _piv(x, 2)
    out, taken = [], set()
    for i in range(1, x.n):
        k = _known(pl, i, n)
        if not k:
            continue
        q = pl[k - 1]
        L = x.l[q]
        if q in taken or not x.l[i] < L:
            continue
        taken.add(q)
        if not x.c[i] > L:
            continue
        # an inducement: a minor (2-candle) swing low above L, after q, known before i and taken out before i
        a, b = bisect.bisect_right(ml, q), _known(ml, i, 2)
        if any(x.l[m] > L and m + 3 < i and min(x.l[m + 3:i]) < x.l[m] for m in ml[a:b]):
            out.append(_ev(i, q, x.h[i], x.l[i]))
    return out


def _obs(x, p):
    """S08 / S19 / S24: the order blocks [(OB candle, displacement candle)] - a green displacement candle (body >= 1.5 x ATR)
    whose close breaks the latest known swing high (the close before not above it), OB = the last red candle of the 10 before."""
    def mk():
        n = _sw(p)
        ph, _ = _piv(x, n)
        out, used = [], set()
        for d in range(16, x.n):
            a = x.a_before(d)
            if not a or not x.green(d) or x.body(d) < 1.5 * a:
                continue
            k = _known(ph, d, n)
            if not k or not (x.c[d] > x.h[ph[k - 1]] >= x.c[d - 1]):
                continue
            ob = next((j for j in range(d - 1, max(0, d - 11), -1) if x.red(j)), None)
            if ob is not None and ob not in used:
                used.add(ob)
                out.append((ob, d))
        return out
    return x._get(('obs', _sw(p)), mk)


def _first_touch(x, start, bottom, top, until):
    """The first candle i in start..until whose low reaches the zone top -> (i, held = close above the bottom); a close under
    the bottom before any touch cannot happen (a close under the bottom is a touch). None = no touch."""
    for i in range(start, min(until, x.n - 1) + 1):
        if x.l[i] <= top:
            return i, x.c[i] > bottom
    return None


def _ob_touch(fvg):
    def det(x, p):
        out = []
        for ob, d in _obs(x, p):
            if fvg and not (d + 1 < x.n and x.l[d + 1] > x.h[d - 1]):
                continue
            t = _first_touch(x, d + (2 if fvg else 1), x.l[ob], x.h[ob], d + 50)
            if t and t[1]:
                i = t[0]
                out.append(_ev(i, ob, x.h[ob], min(x.l[ob], x.l[i]), round(100.0 * (x.h[ob] - x.l[ob]) / x.l[ob], 2)))
        out.sort()
        return out
    return det


def _s24(x, p):
    out = []
    for ob, d in _obs(x, p):
        j = next((t for t in range(d + 1, min(x.n, d + 51)) if x.c[t] < x.l[ob]), None)
        if j is None:
            continue
        i = next((t for t in range(j + 1, min(x.n, j + 31)) if x.c[t] > x.h[ob]), None)
        if i is not None:
            out.append(_ev(i, ob, x.h[ob], _lo(x, j, i)))
    out.sort()
    return out


def _blocks(kind):
    """S09 breaker (the 2nd low lower) / S10 mitigation (the 2nd low higher) / S20 breaker whose lower low was a sweep (closed
    back above the 1st low): the last green candle of the 5 up to the highest candle between two known swing lows; price closes
    above its high after the 2nd low, then (once the 2nd low is known) the first candle back to that high, closing above the
    block's low, within 30 candles of the break (the break within 60 candles of the 2nd low; a close under the block's
    low ends it)."""
    def det(x, p):
        n = _sw(p)
        _, pl = _piv(x, n)
        out = []
        for k in range(1, len(pl)):
            p1, p2 = pl[k - 1], pl[k]
            if p2 - p1 < 2:
                continue
            if kind == 'mit':
                if not x.l[p2] > x.l[p1]:
                    continue
            elif not x.l[p2] < x.l[p1] or (kind == 'sweep' and not x.c[p2] > x.l[p1]):
                continue
            sh = max(range(p1 + 1, p2), key=lambda t: (x.h[t], t))
            bk = next((j for j in range(sh, max(p1, sh - 5), -1) if x.green(j)), None)
            if bk is None:
                continue
            j = next((t for t in range(p2 + 1, min(x.n, p2 + 61)) if x.c[t] > x.h[bk]), None)
            if j is None:
                continue
            for i in range(j + 1, min(x.n, j + 31)):
                if x.c[i] < x.l[bk]:
                    break
                if i >= p2 + n and x.l[i] <= x.h[bk]:
                    out.append(_ev(i, bk, x.h[bk], min(x.l[bk], x.l[i])))
                    break
        out.sort()
        return out
    return det


def _s11(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out = []
    for w in pl:
        a, r = x.a_before(w), x.rng(w)
        if not a or r < a or x.lo(w) < 0.6 * r:
            continue
        top = min(x.o[w], x.c[w])
        t = _first_touch(x, w + n, x.l[w], top, w + 50)
        if t and t[1]:
            out.append(_ev(t[0], w, top, min(x.l[w], x.l[t[0]])))
    out.sort()
    return out


def _fvgs(x, min_atr=0.1):
    """Bullish 3-candle FVGs [(k = 3rd candle, bottom = high of candle k-2, top = low of candle k)], gap >= min_atr x ATR(14)
    before the first candle."""
    def mk():
        out = []
        for k in range(17, x.n):
            a = x.a_before(k - 2)
            if a and x.l[k] > x.h[k - 2] and x.l[k] - x.h[k - 2] >= min_atr * a:
                out.append((k, x.h[k - 2], x.l[k]))
        return out
    return x._get(('fvgs', min_atr), mk)


def _zone_touch(zones_fn, level='top', age=100):
    """The first candle after each zone that reaches it (level 'top' = the zone top, 'mid' = its middle) closing above its
    bottom; a close under the bottom first ends the zone. stop reference = the lower of the bottom and that candle's low."""
    def det(x, p):
        out = []
        for z in zones_fn(x, p):
            k, b, t = z[0], z[1], z[2]
            lv = t if level == 'top' else (b + t) / 2.0
            for i in range(k + 1, min(x.n, k + age + 1)):
                if x.c[i] < b:
                    break
                if x.l[i] <= lv:
                    out.append(_ev(i, z[3] if len(z) > 3 else k - 2, t, min(b, x.l[i]), round(100.0 * (t - b) / b, 2)))
                    break
        out.sort()
        return out
    return det


def _z_fvg(x, p):
    return _fvgs(x)


def _z_disp_fvg(x, p):
    return [z for z in _fvgs(x) if x.green(z[0] - 1) and x.a_before(z[0] - 1) and x.body(z[0] - 1) >= 1.5 * x.a_before(z[0] - 1)]


def _bear_fvgs(x):
    def mk():
        out = []
        for k in range(17, x.n):
            a = x.a_before(k - 2)
            if a and x.h[k] < x.l[k - 2] and x.l[k - 2] - x.h[k] >= 0.1 * a:
                out.append((k, x.h[k], x.l[k - 2]))
        return out
    return x._get(('bfvgs',), mk)


def _s14(x, p):
    out = []
    for k, b, t in _bear_fvgs(x):
        i = next((j for j in range(k + 1, min(x.n, k + 51)) if x.c[j] > t), None)
        if i is not None:
            out.append(_ev(i, k - 2, t, min(b, x.l[i])))
    out.sort()
    return out


def _s15(x, i):
    a = x.a_before(i)
    return a and x.green(i) and x.body(i) >= 2 * a and x.clv(i) >= 0.6


def _s17(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out = []
    for b, hi, lvl, li, lf, d in _choch(x, n):
        if d < 2 or b - li > 10:
            continue
        m = _known(pl, li, n)
        if not m:
            continue
        L = x.l[pl[m - 1]]
        if x.l[li] < L and any(x.c[t] > L for t in range(li, min(li + 2, b) + 1)):
            out.append(_ev(b, li, lvl, lf, d))
    return out


def _s18(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out, taken, st = [], set(), None
    for i in range(1, x.n):
        if st is not None:
            s, H = st
            if x.l[i] < x.l[s] or i - s > 10:
                st = None
            elif x.c[i] > H:
                out.append(_ev(i, s, H, x.l[s]))
                st = None
                continue
        k, m = _known(ph, i, n), _known(pl, i, n)
        if not k or m < 2:
            continue
        q = pl[m - 1]
        if q in taken or not x.l[i] < x.l[q]:
            continue
        taken.add(q)
        H = x.h[ph[k - 1]]
        if x.c[i] > x.l[q] and x.l[q] > x.l[pl[m - 2]] and H > x.c[i]:
            st = (i, H)
    return out


def _s21(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    out, used = [], set()
    cur, low = None, None
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if not k:
            continue
        q = ph[k - 1]
        if q != cur:
            cur, low = q, min(x.l[q + 1:i]) if i > q + 1 else None
        if low is not None and q not in used:
            a = x.a_before(q)
            H = x.h[q]
            if a and H - low >= 3 * a:
                mid, deep = low + 0.5 * (H - low), low + 0.25 * (H - low)
                if x.green(i) and x.c[i] > x.h[i - 1] and x.c[i] <= mid and min(x.l[i - 1], x.l[i]) <= deep:
                    used.add(q)
                    out.append(_ev(i, q, x.h[i], min(x.l[i - 1], x.l[i]), round(100.0 * (H - x.c[i]) / (H - low), 1)))
        low = x.l[i] if low is None else min(low, x.l[i])
    return out


def _s22(x, p):
    n = _sw(p)
    zs = _fvgs(x)
    ks = [z[0] for z in zs]
    out = []
    for b, hi, lvl, li, lf, d in _choch(x, n):
        if d < 2:
            continue
        cand = [z for z in zs[bisect.bisect_left(ks, li + 2):bisect.bisect_right(ks, b + 20)] if z[1] > lf]
        if not cand:
            continue
        touched = set()
        M = x.h[li]
        for i in range(li + 1, min(x.n, b + 61)):
            if i > b and x.c[i] < lf:
                break
            hit = None
            for z in cand:
                k, zb, zt = z
                if k >= i or k in touched or x.l[i] > zt:
                    continue
                touched.add(k)
                mid = (zb + zt) / 2.0
                if hit is None and i > b and x.c[i] > zb and M > lf and (M - mid) >= 0.5 * (M - lf):
                    hit = z
            if hit:
                out.append(_ev(i, li, hit[2], min(hit[1], x.l[i]), round(100.0 * (M - (hit[1] + hit[2]) / 2.0) / (M - lf), 1)))
                break
            M = max(M, x.h[i])
    out.sort()
    return out


def _s23(x, p):
    bears = _bear_fvgs(x)
    bk = [z[0] for z in bears]
    out = []
    for k2, b2, t2 in _fvgs(x):
        for k1, b1, t1 in bears[bisect.bisect_left(bk, k2 - 20):bisect.bisect_left(bk, k2)][::-1]:
            lo, hi = max(b1, b2), min(t1, t2)
            if hi > lo:
                t = _first_touch(x, k2 + 1, lo, hi, k2 + 50)
                if t and t[1]:
                    out.append(_ev(t[0], k1 - 2, hi, min(lo, x.l[t[0]])))
                break
    out.sort()
    return out


def _s25(x, p):
    return [_ev(k, k - 2, x.h[k], b, round(100.0 * (t - b) / b, 2)) for k, b, t in _fvgs(x, 1.0) if x.c[k] > x.c[k - 1]]


# ------------------------------------------------------------------ V. volume (the rest)
def _v09(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    ob = x._get(('obv',), lambda: ind.obv(x.c, x.v))
    out = []
    for k in range(2, len(pl)):
        a, b, c = pl[k - 2], pl[k - 1], pl[k]
        i = c + n
        if i < x.n and c - a <= 120 and x.l[a] < x.l[b] < x.l[c] and ob[a] < ob[b] < ob[c]:
            out.append(_ev(i, a, _hi(x, c, i), x.l[c]))
    return out


def _v10(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    rv = x.rv(20)
    out, used = [], set()
    for i in range(1, x.n):
        k = _known(pl, i, n)
        a = x.a_before(i)
        if not k or not a or rv[i] is None:
            continue
        q = pl[k - 1]
        S = x.l[q]
        if q not in used and rv[i] >= 2 and x.rng(i) <= 0.7 * a and x.l[i] <= S * 1.01 and x.c[i] >= S and x.clv(i) >= 0:
            used.add(q)
            out.append(_ev(i, q, x.h[i], x.l[i], round(rv[i], 2)))
    return out


def _div(series, hidden=False, extra=None):
    """A divergence between price's two latest swing lows (divPivot candles each side, divPivot .. divMaxGap candles apart) and
    an indicator at those candles: regular = price lower low + indicator higher low; hidden = price higher low + indicator lower
    low. Signal on the candle the 2nd low becomes known."""
    def det(x, p):
        n, gap = int(p.get('divPivot', 5)), int(p.get('divMaxGap', 60))
        s = series(x)
        _, pl = _piv(x, n)
        out = []
        for k in range(1, len(pl)):
            p1, p2 = pl[k - 1], pl[k]
            i = p2 + n
            if i >= x.n or not n <= p2 - p1 <= gap or s[p1] is None or s[p2] is None:
                continue
            ok = (x.l[p2] > x.l[p1] and s[p2] < s[p1]) if hidden else (x.l[p2] < x.l[p1] and s[p2] > s[p1])
            if ok and (extra is None or extra(x, s, p1, p2, i)):
                out.append(_ev(i, p1, _hi(x, p2, i), x.l[p2], round(s[p2] - s[p1], 4)))
        return out
    return det


def _v14(x, p):
    s20, rv = x.sma(20), x.rv(20)
    out = []
    for j in range(20, x.n - 1):
        a = x.a_before(j)
        i = j + 1
        if (a and s20[j] is not None and rv[j] is not None and x.c[j] < s20[j] and x.c[j] < x.c[j - 5] and rv[j] >= 2 and
                x.rng(j) <= 0.6 * a and x.c[i] > x.h[j]):
            out.append(_ev(i, j, x.h[j], min(x.l[j], x.l[i]), round(rv[j], 2)))
    return out


def _v16(x, p):
    rv = x.rv(20)
    out = []
    for j in range(20, x.n):
        a = x.a_before(j)
        if not (a and rv[j] is not None and x.red(j) and x.body(j) >= 0.7 * a and rv[j] >= 2):
            continue
        i = next((t for t in range(j + 1, min(x.n, j + 4)) if x.c[t] > x.h[j]), None)
        if i is not None:
            out.append(_ev(i, j, x.h[j], _lo(x, j, i), round(rv[j], 2)))
    out.sort()
    return out


# ------------------------------------------------------------------ I. momentum
def _i03(x, p):
    r = _rsi(x)
    out = []
    st, A, B, C, cs = 0, None, None, None, None
    for i in range(x.n):
        v = r[i]
        if v is None:
            continue
        if st and i - A > 40:
            st = 0
        if st == 0:
            if v < 30:
                st, A = 1, i
        elif st == 1:
            if v > 30:
                st, B = 2, v
        elif st == 2:
            if v >= B:
                B = v
            else:
                st, C, cs = 3, v, i
        elif st == 3:
            if v < 30:
                st, A = 1, i
            elif v > B:
                out.append(_ev(i, A, x.h[i], _lo(x, cs, i), round(C, 1)))
                st = 0
            elif v < C:
                C = v
    return out


def _rsi_cross_from(level, low=None):
    def cond(x, i):
        r = _rsi(x)
        if not _cross_up(r, level, i):
            return False
        return low is None or (i >= 10 and any(v is not None and v < low for v in r[i - 10:i]))
    return cond


def _i06(x, i):
    m, s, _ = _macd(x)
    return _cross_up(m, s, i) and m[i] < 0 and s[i] < 0


def _i07(x, i):
    m, _, _ = _macd(x)
    return _cross_up(m, 0.0, i)


def _stoch(x):
    return x._get(('stoch',), lambda: ind.stochastic(x.h, x.l, x.c))


def _i09(x, i):
    k, d = _stoch(x)
    return _cross_up(k, d, i) and k[i - 1] < 20 and d[i - 1] < 20


def _i10(x, i):
    k, _ = _stoch(x)
    return _cross_up(k, 20.0, i)


def _i11(x, i):
    c = x._get(('cci',), lambda: ind.cci(x.h, x.l, x.c, 20))
    return _cross_up(c, -100.0, i)


def _obv(x):
    return x._get(('obv',), lambda: ind.obv(x.c, x.v))


def _i13(x, p):
    ob = _obv(x)
    pm = x._get(('obvph',), lambda: ind.prior_high(ob, 50))
    e20 = x.ema(20)
    return [_ev(i, i, x.h[i], x.l[i]) for i in range(51, x.n)
            if pm[i] is not None and ob[i] > pm[i] and not ob[i - 1] > pm[i - 1] and e20[i] is not None and x.c[i] > e20[i]]


def _i15(x, i):
    pdi, mdi, adx = x._get(('dmi',), lambda: ind.dmi(x.h, x.l, x.c, 14))
    return _cross_up(adx, 25.0, i) and pdi[i] > mdi[i]


def _roc(x, n):
    return x._get(('roc', n), lambda: ind.roc(x.c, n))


def _i16(x, i):
    r = _roc(x, 12)
    return _cross_up(r, 0.0, i) and i >= 20 and any(v is not None and v <= -5 for v in r[i - 20:i])


def _i17(x, i):
    t, s = x._get(('tsi',), lambda: ind.tsi(x.c))
    return _cross_up(t, s, i) and t[i] < 0


def _i18(x, i):
    u, d = x._get(('aroon',), lambda: ind.aroon(x.h, x.l, 25))
    return _cross_up(u, d, i) and u[i] >= 50


def _i19(x, p):
    sar, tr = x._get(('psar',), lambda: ind.psar(x.h, x.l, x.c))
    return [_ev(i, i, x.h[i], min(sar[i], x.l[i])) for i in range(2, x.n) if tr[i] == 1 and tr[i - 1] == -1]


def _i20(x, i):
    m, u, lo = _bbs(x)
    return lo[i - 1] is not None and x.c[i - 1] < lo[i - 1] and x.c[i] > lo[i] and x.green(i)


def _i21(x, i):
    m, u, lo = _bbs(x)
    return (i >= 25 and m[i] is not None and x.c[i] > m[i] and x.c[i] < u[i] and
            all(m[j] is not None and x.c[j] < m[j] for j in range(i - 5, i)))


def _i22(x, i):
    m, u, lo = _bbs(x)

    def on(j):
        return j >= 0 and u[j] is not None and x.c[j] >= u[j]
    return on(i) and on(i - 1) and on(i - 2) and not on(i - 3)


def _ratio(x):
    """The stock's close / the benchmark's (NIFTY 50) close of the same day (D / W: the day of the candle or the last before it;
    4H: the session BEFORE - the index has daily candles only). None without the benchmark."""
    def mk():
        if not x.bench or not x.day:
            return None
        days, closes = x.bench
        out = []
        for i in range(x.n):
            d = x.day[i]
            k = (bisect.bisect_left(days, d) if x.tf == '4H' else bisect.bisect_right(days, d)) - 1
            out.append(x.c[i] / closes[k] if k >= 0 and closes[k] else None)
        return out
    return x._get(('ratio',), mk)


def _rs_hi(x, n):
    r = _ratio(x)
    return None if r is None else x._get(('rsph', n), lambda: ind.prior_high([v if v is not None else -1e18 for v in r], n))


def _i23(x, p):
    r, rh = _ratio(x), _rs_hi(x, 50)
    if r is None:
        return []
    h20 = x.phi(20)
    return [_ev(i, i, x.h[i], x.l[i], round(r[i] / rh[i], 4)) for i in range(51, x.n)
            if r[i] is not None and r[i - 1] is not None and rh[i] is not None and rh[i] > 0 and r[i] > rh[i] and
            not r[i - 1] > rh[i - 1] and h20[i] is not None and x.c[i] > h20[i]]


def _i24(x, p):
    n = pd.HI_N['B03'][x.tf]
    r, rh = _ratio(x), _rs_hi(x, n)
    if r is None:
        return []
    ph = x.phi(n)
    return [_ev(i, i, x.h[i], _lo(x, i - 9, i)) for i in range(n + 1, x.n)
            if r[i] is not None and r[i - 1] is not None and rh[i] is not None and rh[i] > 0 and r[i] > rh[i] and
            not r[i - 1] > rh[i - 1] and ph[i] is not None and x.c[i] < ph[i]]


# ------------------------------------------------------------------ Q. quantitative / statistical
def _q01(x, i):
    z, s200 = _z(x, 20), x.sma(200)
    return z[i - 1] is not None and z[i - 1] <= -2 and x.green(i) and x.c[i] > x.h[i - 1] and s200[i] is not None and x.c[i] > s200[i]


def _q02(x, i):
    return _cross_up(_z(x, 50), -2.0, i)


def _pctb(x):
    def mk():
        m, u, lo = _bbs(x)
        return [None if u[i] is None or u[i] - lo[i] <= 0 else (x.c[i] - lo[i]) / (u[i] - lo[i]) for i in range(x.n)]
    return x._get(('pctb',), mk)


def _q03(x, i):
    b = _pctb(x)
    return _cross_up(b, 0.5, i) and i >= 5 and any(v is not None and v < 0 for v in b[i - 5:i])


def _q04(x, p):
    sp = x._get(('lrp',), lambda: ind.linreg_slope(x.c, 20))
    sr = x._get(('lrr',), lambda: ind.linreg_slope(_rsi(x), 20))
    r = _rsi(x)

    def div(i):
        return sp[i] is not None and sr[i] is not None and sp[i] < 0 and sr[i] > 0
    return [_ev(i, i - 19, x.h[i], _lo(x, i - 19, i)) for i in range(1, x.n) if div(i) and not div(i - 1) and r[i] < 50]


def _q05(x, i):
    a = x.atr(14)
    pr = x._get(('atrpr',), lambda: ind.pct_rank(a, 126))
    tr = max(x.h[i] - x.l[i], abs(x.h[i] - x.c[i - 1]), abs(x.l[i] - x.c[i - 1]))
    return pr[i - 1] is not None and pr[i - 1] <= 10 and tr >= 2 * a[i - 1] and x.green(i) and x.clv(i) >= 0


def _rets(x):
    return x._get(('rets',), lambda: [0.0] + [x.c[i] / x.c[i - 1] - 1.0 if x.c[i - 1] else 0.0 for i in range(1, x.n)])


def _q06(x, i):
    sd = x._get(('rsd',), lambda: ind.stdev(_rets(x), 20))
    pr = x._get(('rsdpr',), lambda: ind.pct_rank(sd, 126))
    return pr[i - 1] is not None and pr[i - 1] <= 20 and x.fresh_above(x.phi(20), i)


def _q07(x, p):
    return [_ev(i, i - 5, x.h[i - 1], _lo(x, i - 5, i)) for i in range(6, x.n)
            if all(x.c[j] < x.c[j - 1] for j in range(i - 5, i)) and x.c[i] > x.h[i - 1]]


def _q08(x, p):
    out = []
    for j in range(16, x.n):
        a = x.a_before(j)
        if not (a and x.red(j) and x.body(j) >= 2 * a):
            continue
        mid = (x.o[j] + x.c[j]) / 2.0
        i = next((t for t in range(j + 1, min(x.n, j + 4)) if x.c[t] > mid), None)
        if i is not None:
            out.append(_ev(i, j, x.o[j], _lo(x, j, i)))
    out.sort()
    return out


def _q09(x, i):
    a, r = x.a_before(i), x.rng(i)
    return (a and r >= a and x.green(i) and (x.o[i] - x.l[i]) <= 0.3 * r and x.clv(i) >= 0.6 and x.c[i] > x.c[i - 1])


def _q10(x, p):
    r = _roc(x, 10)

    def acc(i):
        return i >= 5 and r[i] is not None and r[i - 5] is not None and r[i - 5] > 0 and r[i] - r[i - 5] >= 5
    return [_ev(i, i - 5, x.h[i], _lo(x, i - 9, i)) for i in range(16, x.n) if acc(i) and not acc(i - 1)]


def _q11(x, i):
    r = _roc(x, 10)
    if i < 13 or None in r[i - 3:i + 1]:
        return False
    return r[i - 2] < r[i - 3] and r[i - 1] > r[i - 2] and r[i] > r[i - 1] and r[i - 2] <= -5


def _htf(x):
    """(the higher candle each candle is in, the higher closes) - as M11: D -> weeks, W -> months, 4H -> days."""
    def mk():
        keys = [pd._htf_key(x.tf, d) for d in x.day]
        gidx, hc = [], []
        for i in range(x.n):
            if i == 0 or keys[i] != keys[i - 1]:
                hc.append(x.c[i])
            else:
                hc[-1] = x.c[i]
            gidx.append(len(hc) - 1)
        return gidx, hc
    return x._get(('htf',), mk)


def _q12(x, p):
    if not x.day:
        return []
    gidx, hc = _htf(x)
    hr = ind.rsi(hc, 14)
    r = _rsi(x)
    out = []
    for i in range(1, x.n):
        g = gidx[i] - 1                       # the last FINISHED higher candle (its RSI is known; the open one's is not)
        if g >= 0 and hr[g] is not None and hr[g] > 50 and _cross_up(r, 50.0, i):
            out.append(_ev(i, i, x.h[i], _lo(x, i - 9, i), round(hr[g], 1)))
    return out


def _q13(x, p):
    r = _ratio(x)
    if r is None:
        return []
    lv = x.phi(50)
    return [_ev(i, i - 63, lv[i], x.l[i], round(r[i] / r[i - 63], 3)) for i in range(64, x.n)
            if r[i] is not None and r[i - 63] and r[i] / r[i - 63] >= 1.10 and x.fresh_above(lv, i)]


def _q14(x, p):
    lv = x.phi(20)
    out, last = [], None
    for i in range(21, x.n):
        if lv[i] is not None and x.c[i] > lv[i]:
            if x.fresh_above(lv, i) and (last is None or i - last > 60):
                out.append(_ev(i, i, lv[i], x.l[i]))
            last = i
    return out


def _q15(x, i):
    s50, s200, z = x.sma(50), x.sma(200), _z(x, 20)
    return (i >= 10 and s200[i] is not None and s50[i - 10] is not None and z[i - 1] is not None and x.c[i] > s50[i] > s200[i] and
            s50[i] > s50[i - 10] and z[i - 1] <= -1.5 and x.c[i] > x.h[i - 1])


def _q16(x, i):
    r, rv = _rets(x), x.rv(20)
    sd = x._get(('rsd',), lambda: ind.stdev(r, 20))
    return i >= 21 and sd[i - 1] and r[i] > 0 and r[i] >= 2 * sd[i - 1] and rv[i] is not None and rv[i] >= 2


def _q17(x, i):
    def mk():
        nr = [(x.h[j] - x.l[j]) / x.c[j] if x.c[j] else 0.0 for j in range(x.n)]
        av = ind.sma(nr, 10)
        return av, ind.pct_rank(av, 126)
    av, pr = x._get(('nrpr',), mk)
    h10 = x.phi(10)
    return (pr[i - 1] is not None and pr[i - 1] <= 10 and x.c[i] and x.rng(i) / x.c[i] >= 2 * av[i - 1] and x.green(i) and
            x.clv(i) >= 0.33 and h10[i] is not None and x.c[i] > h10[i])


def _q18(x, i):
    s50, s200, r63 = x.sma(50), x.sma(200), _roc(x, 63)
    return (s200[i] is not None and r63[i] is not None and x.c[i] > s50[i] > s200[i] and r63[i] >= 20 and
            x.fresh_above(x.phi(10), i))


def _q19(x, p):
    r = _rsi(x)
    out = []
    for j in range(1, x.n):
        if r[j] is None or r[j - 1] is None or not (r[j] < 30 <= r[j - 1]):
            continue
        i = next((t for t in range(j + 1, min(x.n, j + 4)) if r[t] > 40), None)
        if i is not None:
            out.append(_ev(i, j, x.h[i], _lo(x, j, i)))
    out.sort()
    return out


def _score(x, i):
    s50, s200, r, rv = x.sma(50), x.sma(200), _rsi(x), x.rv(20)
    m, s, _ = _macd(x)
    if None in (s200[i], r[i], s[i], rv[i]):
        return None
    return (int(x.c[i] > s50[i]) + int(s50[i] > s200[i]) + int(r[i] > 50) + int(m[i] > s[i]) + int(rv[i] >= 1.2))


def _q20(x, p):
    out = []
    for i in range(1, x.n):
        a, b = _score(x, i), _score(x, i - 1)
        if a is not None and a >= 4 and (b is None or b < 4):
            out.append(_ev(i, i, x.h[i], _lo(x, i - 9, i), a))
    return out


# ------------------------------------------------------------------ M. moving averages (the rest)
def _ich(x):
    return x._get(('ich',), lambda: ind.ichimoku(x.h, x.l))


def _m13(x, p):
    t, k, sa, sb = _ich(x)

    def top(i):
        j = i - 26
        return None if j < 0 or sa[j] is None or sb[j] is None else max(sa[j], sb[j])
    out = []
    for i in range(27, x.n):
        a, b = top(i), top(i - 1)
        if a is not None and b is not None and x.c[i] > a and not x.c[i - 1] > b:
            out.append(_ev(i, i, a, x.l[i]))
    return out


def _m14(x, i):
    t, k, _, _ = _ich(x)
    return _cross_up(t, k, i)


def _m15(x, i):
    _, _, sa, sb = _ich(x)
    return _cross_up(sa, sb, i)


def _m17(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    out, done = [], set()
    cur, pv, vv, prev = None, 0.0, 0.0, None
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if not k:
            continue
        q = ph[k - 1]
        if q != cur:
            cur, pv, vv, prev = q, 0.0, 0.0, None
            for j in range(q, i):
                tp = (x.h[j] + x.l[j] + x.c[j]) / 3.0
                pv, vv = pv + tp * x.v[j], vv + x.v[j]
            prev = pv / vv if vv > 0 else None
        tp = (x.h[i] + x.l[i] + x.c[i]) / 3.0
        pv, vv = pv + tp * x.v[i], vv + x.v[i]
        av = pv / vv if vv > 0 else None
        if (av is not None and prev is not None and q not in done and i - q <= 60 and x.c[i] > av and
                x.c[i - 1] <= prev):
            done.add(q)
            out.append(_ev(i, q, av, _lo(x, q, i)))
        prev = av
    return out


def _m18(x, p):
    e10, e20, e50 = x.ema(10), x.ema(20), x.ema(50)

    def tight(j):
        v = (e10[j], e20[j], e50[j])
        return None not in v and (max(v) - min(v)) / x.c[j] <= 0.015

    def ok(i):
        return (i >= 53 and all(tight(j) for j in range(i - 3, i)) and x.c[i] > max(e10[i], e20[i], e50[i]) and x.green(i) and
                x.c[i] > _hi(x, i - 3, i - 1))
    return [_ev(i, i - 3, _hi(x, i - 3, i - 1), _lo(x, i - 3, i)) for i in range(54, x.n) if ok(i) and not ok(i - 1)]


DETECTORS = {
    'P01': _p01, 'P02': _p02, 'P03': _p03, 'P04': _p04, 'P05': _p05, 'P06': _p06, 'P07': _p07, 'P08': _p08,
    'P09': _sweep(0.0), 'P10': _failed_break(_lvl_swing), 'P11': _failed_break(_lvl_range), 'P12': _p12, 'P13': _p13,
    'P14': _p14, 'P15': _p15, 'P16': _p16, 'P17': _p17, 'P18': _p18, 'P19': _p19, 'P20': _p20, 'P21': _p21, 'P22': _p22,
    'P23': _p23, 'P24': _p24,
    'S01': _s01, 'S02': _s02, 'S03': _period_sweep('S03'), 'S04': _period_sweep('S04'), 'S05': _period_sweep('S05'),
    'S06': _sweep(0.5), 'S07': _s07, 'S08': _ob_touch(False), 'S09': _blocks('breaker'), 'S10': _blocks('mit'), 'S11': _s11,
    'S12': _zone_touch(_z_fvg), 'S13': _zone_touch(_z_fvg, 'mid'), 'S14': _s14, 'S15': _sig(_s15, 1),
    'S16': _zone_touch(_z_disp_fvg), 'S17': _s17, 'S18': _s18, 'S19': _ob_touch(True), 'S20': _blocks('sweep'), 'S21': _s21,
    'S22': _s22, 'S23': _s23, 'S24': _s24, 'S25': _s25,
    'V09': _v09, 'V10': _v10, 'V11': _div(lambda x: x._get(('ad',), lambda: ind.ad_line(x.h, x.l, x.c, x.v))), 'V14': _v14,
    'V16': _v16,
    'I02': _div(_rsi, hidden=True, extra=lambda x, s, p1, p2, i: x.sma(50)[i] is not None and x.c[i] > x.sma(50)[i]),
    'I03': _i03, 'I04': _sig(_rsi_cross_from(50.0, 40.0)), 'I05': _sig(_rsi_cross_from(30.0)), 'I06': _sig(_i06),
    'I07': _sig(_i07, 20), 'I08': _div(lambda x: _macd(x)[0], extra=lambda x, s, p1, p2, i: s[p1] < 0),
    'I09': _sig(_i09), 'I10': _sig(_i10), 'I11': _sig(_i11),
    'I12': _div(lambda x: x._get(('mfi',), lambda: ind.mfi(x.h, x.l, x.c, x.v, 14))), 'I13': _i13, 'I14': _div(_obv),
    'I15': _sig(_i15), 'I16': _sig(_i16, 20), 'I17': _sig(_i17), 'I18': _sig(_i18), 'I19': _i19, 'I20': _sig(_i20, 2),
    'I21': _sig(_i21, 6), 'I22': _sig(_i22, 3), 'I23': _i23, 'I24': _i24,
    'Q01': _sig(_q01, 2), 'Q02': _sig(_q02, 5), 'Q03': _sig(_q03, 6), 'Q04': _q04, 'Q05': _sig(_q05, 1), 'Q06': _sig(_q06, 1),
    'Q07': _q07, 'Q08': _q08, 'Q09': _sig(_q09, 1), 'Q10': _q10, 'Q11': _sig(_q11, 10), 'Q12': _q12, 'Q13': _q13, 'Q14': _q14,
    'Q15': _sig(_q15, 2), 'Q16': _sig(_q16, 1), 'Q17': _sig(_q17, 1), 'Q18': _sig(_q18, 5), 'Q19': _q19, 'Q20': _q20,
    'M13': _m13, 'M14': _sig(_m14), 'M15': _sig(_m15), 'M17': _m17, 'M18': _m18,
}
NEEDS_BENCH = ('I23', 'I24', 'Q13')
pd.DETECTORS.update(DETECTORS)        # also when this module is imported first (pattern_detect imports it at its end)
