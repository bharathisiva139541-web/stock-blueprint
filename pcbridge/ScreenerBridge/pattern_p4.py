# -*- coding: utf-8 -*-
"""Phase 4 detectors of the bullish pattern engine (owner, 13-Nov-2026: "Yes do it" - the classical chart patterns C01-C20,
the last group of the agreed order). The written rules: pattern_registry.SPECS (P4 + COMMON + COMMON4).

Same contract as pattern_detect.py / pattern_p3.py: det(x, p) -> EVENTS [act, conf, occ, trigger, stop_ref, aux], emitted once
when CONFIRMED, using only candles <= the signal candle.

Shapes are drawn through SWINGS (structure.pivots with patSwing candles each side - a swing at candle p is known at candle
p + n). A pattern is complete once its last swing is known; its signal is the BREAKOUT that follows: the first close above
the pattern's level after its last swing, on or after the candle that swing becomes known - a close above the level before
that (the pattern was not visible yet) or a close under the pattern's floor first = no signal. Sizes in ATR(14) of the
pattern's last swing, so the same rule works on daily, weekly and 4-hour candles.
"""
import bisect
from datetime import date

import indicators as ind
import pattern_detect as pd
import pattern_p3 as p3

_piv, _known, _sw, _lo, _hi, _ev = p3._piv, p3._known, p3._sw, p3._lo, p3._hi, p3._ev

# candle counts of the time-based rules per timeframe
TFL = {
    'C04': {'D': 60, 'W': 40, '4H': 120},          # rounding bottom window
    'C05': {'D': 120, 'W': 60, '4H': 240},         # saucer window (longer, shallower)
    'C10min': {'D': 30, 'W': 7, '4H': 60},         # cup length
    'C10max': {'D': 250, 'W': 65, '4H': 500},
    'C17pole': {'D': 40, 'W': 8, '4H': 80},        # high tight flag: the pole at most this long
    'C17flag': {'D': 25, 'W': 5, '4H': 50},        # ... and the flag
    'C18': {'D': 25, 'W': 5, '4H': 50},            # flat base: at least this long
    'C18pre': {'D': 60, 'W': 13, '4H': 120},       # the rise before the base
    'C19': {'D': 250, 'W': 52},                    # IPO base breakout within this many candles of the listing
    'C19min': {'D': 8, 'W': 3},                    # the base after the high since listing at least this long
}
LIST_FROM = date(2008, 1, 1).toordinal()          # the first daily candle after this = the listing (Kite history reaches 2006)
WAIT = 60                                          # a breakout at most this many candles after the pattern's last swing


def _atr(x, j):
    a = x.atr(14)
    return a[j] if 0 <= j < x.n and a[j] else None


def _breakout(x, last, known, lvl, floor=None, wait=WAIT):
    """The first close above lvl(t) after candle `last`, if it comes on or after `known` (the pattern complete) and within
    `wait` candles of `last`; a close under `floor` first ends it -> candle or None."""
    for t in range(last + 1, min(last + wait, x.n - 1) + 1):
        if floor is not None and x.c[t] < floor:
            return None
        if x.c[t] > lvl(t):
            return t if t >= known else None
    return None


def _came_from_above(x, start, level, back=60):
    """A reversal pattern needs a fall into it: some high of the `back` candles before `start` at or above `level`."""
    pre = x.h[max(0, start - back):start]
    return bool(pre) and max(pre) >= level


def _slope(xs):
    n = len(xs)
    if n < 2:
        return 0.0
    mx = (n - 1) / 2.0
    my = sum(xs) / n
    den = sum((k - mx) ** 2 for k in range(n))
    return sum((k - mx) * (v - my) for k, v in enumerate(xs)) / den


# ------------------------------------------------------------------ bottoms
def _bottoms(k3):
    """C01 double (k3 False) / C02 triple bottom: 2 / 3 consecutive known swing lows within 1 x ATR of each other, none lower
    between them, the neckline = the highest high between the first and the last, at least 2 x ATR above the higher low, a
    fall into the pattern; the breakout above the neckline (a close under the lowest low first = failed)."""
    def det(x, p):
        n = _sw(p)
        _, pl = _piv(x, n)
        cnt = 3 if k3 else 2
        out = []
        for k in range(cnt - 1, len(pl)):
            qs = pl[k - cnt + 1:k + 1]
            p1, pz = qs[0], qs[-1]
            A = _atr(x, pz)
            if not A or pz - p1 < 2 * n or pz - p1 > (150 if k3 else 120):
                continue
            lows = [x.l[q] for q in qs]
            lo = min(lows)
            if max(lows) - lo > A or min(x.l[p1:pz + 1]) < lo:
                continue
            neck = max(x.h[p1:pz + 1])
            if neck - max(lows) < 2 * A or not _came_from_above(x, p1, neck):
                continue
            t = _breakout(x, pz, pz + n, lambda _t, v=neck: v, lo)
            if t is not None:
                out.append(_ev(t, p1, neck, lo, round(100.0 * (neck - lo) / lo, 2)))
        out.sort()
        return out
    return det


def _c03(x, p):
    n = _sw(p)
    _, pl = _piv(x, n)
    out = []
    for k in range(2, len(pl)):
        p1, p2, p3_ = pl[k - 2], pl[k - 1], pl[k]
        A = _atr(x, p3_)
        if not A or p3_ - p1 > 150 or p2 - p1 < 2 or p3_ - p2 < 2:
            continue
        LS, H, RS = x.l[p1], x.l[p2], x.l[p3_]
        if not (H <= LS - 0.5 * A and H <= RS - 0.5 * A and abs(LS - RS) <= 1.5 * A):
            continue
        q1 = max(range(p1 + 1, p2), key=lambda t: (x.h[t], t))
        q2 = max(range(p2 + 1, p3_), key=lambda t: (x.h[t], t))
        N1, N2 = x.h[q1], x.h[q2]
        if abs(N2 - N1) > 2 * A or N1 - LS < A or N2 - RS < A or not _came_from_above(x, p1, max(N1, N2)):
            continue
        slope = (N2 - N1) / float(q2 - q1)

        def neck(t, N2=N2, q2=q2, slope=slope):
            return N2 + slope * (t - q2)
        t = _breakout(x, p3_, p3_ + n, neck, H)
        if t is not None:
            out.append(_ev(t, p1, neck(t), _lo(x, p3_, t), round(100.0 * (min(LS, RS) - H) / H, 2)))
    out.sort()
    return out


def _round(pid, dmin, dmax):
    """C04 rounding bottom / C05 saucer: over the window of W candles before the signal - the left rim = the highest high of its
    first fifth, the bottom = its lowest low, in the middle (not in the first or last third), depth dmin..dmax of the rim,
    closes falling into the bottom and rising out of it (regression slopes), a rounded floor (at least 20 % of the window's
    closes in the lowest third of the depth); the signal = the first close above the rim (no close of the window above it).
    Stop reference = the lowest low of the last fifth of the window (the right side)."""
    def det(x, p):
        W = TFL[pid][x.tf]
        f5 = max(2, W // 5)
        pmc = x._get(('pmc', W), lambda: ind.prior_high(x.c, W))
        out, used = [], set()
        for i in range(W, x.n):
            A = i - W
            if pmc[i] is None or not x.c[i] > pmc[i]:
                continue                              # the close above every close of the window (a cheap first test)
            R = max(x.h[A:A + f5])
            if not x.c[i] > R or pmc[i] > R:
                continue
            b = min(range(A, i), key=lambda t: (x.l[t], t))
            B = x.l[b]
            if b in used or not (A + W // 3 <= b <= i - W // 3) or not B > 0:
                continue
            depth = (R - B) / R
            if not dmin <= depth <= dmax:
                continue
            third = B + (R - B) / 3.0
            if sum(1 for t in range(A, i) if x.c[t] <= third) < 0.2 * W:
                continue
            if not (_slope(x.c[A:b + 1]) < 0 < _slope(x.c[b:i])):
                continue
            used.add(b)
            out.append(_ev(i, A, R, _lo(x, i - f5, i), round(100.0 * depth, 1)))
        return out
    return det


# ------------------------------------------------------------------ lines through swings (wedges, triangles, rectangles, channels)
def _two_two(x, i, n):
    """The two latest known swing highs and lows at candle i -> (q1, q2, r1, r2) or None."""
    ph, pl = _piv(x, n)
    k, m = _known(ph, i, n), _known(pl, i, n)
    if k < 2 or m < 2:
        return None
    return ph[k - 2], ph[k - 1], pl[m - 2], pl[m - 1]


def _lines(kind):
    """C06 falling wedge, C11 ascending triangle, C12 symmetrical triangle, C13 rectangle: the upper line through the two latest
    known swing highs, the lower through the two latest known swing lows, the four swings interleaved (each line's swings
    on both sides of the other's first one) within 150 candles; the signal = the first close above the upper line (the close
    before not above it) within 40 candles of the last swing becoming known, once per pair of swings, the lines not crossed.
    Stop reference = the lowest low since the latest swing low."""
    def det(x, p):
        n = _sw(p)
        out, done = [], set()
        for i in range(1, x.n):
            s = _two_two(x, i, n)
            if s is None:
                continue
            q1, q2, r1, r2 = s
            key = (q2, r2)
            last = max(q2, r2)
            if key in done or i - (last + n) > 40 or last - min(q1, r1) > 150 or not (q1 < r2 and r1 < q2):
                continue
            A = _atr(x, last)
            if not A:
                continue
            h1, h2, l1, l2 = x.h[q1], x.h[q2], x.l[r1], x.l[r2]
            su, sl = (h2 - h1) / float(q2 - q1), (l2 - l1) / float(r2 - r1)
            if kind == 'wedge':
                ok = h2 < h1 and l2 < l1 and su < sl < 0
            elif kind == 'asc':
                ok = abs(h2 - h1) <= 0.5 * A and l2 > l1 + 0.5 * A and max(h1, h2) - l1 >= 2 * A
                su = 0.0
            elif kind == 'sym':
                ok = h2 < h1 - 0.5 * A and l2 > l1 + 0.5 * A
            else:                                       # rectangle
                ok = abs(h2 - h1) <= 0.5 * A and abs(l2 - l1) <= 0.5 * A and max(h1, h2) - min(l1, l2) >= 2 * A
                su = 0.0
            if not ok:
                continue
            top = max(h1, h2)

            def up(t):
                return top if su == 0.0 else h2 + su * (t - q2)
            if up(i) <= l2 + sl * (i - r2):
                done.add(key)                           # the lines crossed - the pattern is over
                continue
            if x.c[i] > up(i) and not x.c[i - 1] > up(i - 1):
                done.add(key)
                out.append(_ev(i, min(q1, r1), up(i), _lo(x, r2, i), round(100.0 * (top - min(l1, l2)) / min(l1, l2), 2)))
        return out
    return det


def _c07(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out, done = [], set()
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if k < 2:
            continue
        q1, q2 = ph[k - 2], ph[k - 1]
        m = bisect.bisect_left(pl, q2)                  # the two swing lows before the 2nd high
        if m < 2 or q2 in done or i - (q2 + n) > WAIT:
            continue
        r1, r2 = pl[m - 2], pl[m - 1]
        if q2 - r1 > 150 or not (r1 < q1 < r2 < q2) or not (x.h[q2] > x.h[q1] and x.l[r2] < x.l[r1]):
            continue
        if x.c[i] > x.h[q2] and not x.c[i - 1] > x.h[q2]:
            done.add(q2)
            out.append(_ev(i, r1, x.h[q2], _lo(x, r2, i)))
    return out


def _c14(x, p):
    n = _sw(p)
    out, done = [], set()
    for i in range(1, x.n):
        s = _two_two(x, i, n)
        if s is None:
            continue
        q1, q2, r1, r2 = s
        if r2 in done or i - r2 > WAIT or not (q1 < r2 and r1 < q2) or max(q2, r2) - min(q1, r1) > 150:
            continue
        A = _atr(x, r2)
        if not A:
            continue
        su = (x.h[q2] - x.h[q1]) / float(q2 - q1)
        sl = (x.l[r2] - x.l[r1]) / float(r2 - r1)
        if not (su > 0 and sl > 0 and abs(su - sl) <= 0.3 * max(su, sl)):
            continue

        def lower(t, r2=r2, sl=sl):
            return x.l[r2] + sl * (t - r2)
        if x.h[q2] + su * (i - q2) - lower(i) < 2 * A:
            continue
        if any(x.c[t] < lower(t) for t in range(r2 + 1, i)):
            done.add(r2)                               # closed under the channel - it broke
            continue
        if x.l[i] <= lower(i) + 0.25 * A and x.c[i] > lower(i) and x.green(i):
            done.add(r2)
            out.append(_ev(i, min(q1, r1), x.h[i], x.l[i], round(100.0 * sl / x.c[i], 3)))
    return out


# ------------------------------------------------------------------ poles: flags, pennants, high tight flags
def _flags(kind):
    """C08 bull flag / C09 bull pennant: a pole = the latest known swing high t at least 4 x ATR above the lowest low of the 15
    candles before it; the flag = the candles after t (4 to 20 of them), its low not under the pole's middle and its highs
    under t's; split in two halves - the upper line through each half's highest high: flag = that line flat or falling and
    the lows not rising, pennant = the line falling and the lows rising (converging). Signal: the first close above the upper
    line (the close before not above it), once per pole. Stop reference = the flag's lowest low."""
    def det(x, p):
        n = _sw(p)
        ph, _ = _piv(x, n)
        out, done = [], set()
        for i in range(1, x.n):
            k = _known(ph, i, n)
            if not k:
                continue
            t = ph[k - 1]
            L = i - t - 1
            if t in done or L < 4 or L > 20 or t < 16:
                continue
            s = min(range(t - 15, t), key=lambda j: (x.l[j], j))
            A = _atr(x, s)
            P = x.h[t] - x.l[s]
            if not A or P < 4 * A or t - s < 2:
                continue
            fl = min(x.l[t + 1:i])
            if fl < x.h[t] - 0.5 * P or max(x.h[t + 1:i]) > x.h[t]:
                continue
            m = t + 1 + L // 2
            a1 = max(range(t + 1, m), key=lambda j: (x.h[j], -j))
            b1 = max(range(m, i), key=lambda j: (x.h[j], j))
            lo1, lo2 = min(x.l[t + 1:m]), min(x.l[m:i])
            ok = (x.h[b1] <= x.h[a1] and lo2 <= lo1 + 0.25 * A) if kind == 'flag' else (x.h[b1] < x.h[a1] and lo2 > lo1)
            if not ok or b1 == a1:
                continue
            sl = (x.h[b1] - x.h[a1]) / float(b1 - a1)

            def line(j, a1=a1, sl=sl):
                return x.h[a1] + sl * (j - a1)
            if x.c[i] > line(i) and not x.c[i - 1] > line(i - 1):
                done.add(t)
                out.append(_ev(i, s, line(i), min(fl, x.l[i]), round(P / A, 1)))
        return out
    return det


def _c17(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    T, F = TFL['C17pole'][x.tf], TFL['C17flag'][x.tf]
    out, done, poles = [], set(), {}
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if not k:
            continue
        t = ph[k - 1]
        L = i - t - 1
        if t in done or L < 3 or L > F or t < 2:
            continue
        if t not in poles:
            poles[t] = min(range(max(0, t - T), t), key=lambda j: (x.l[j], j))
        s = poles[t]
        top = x.h[t]
        if not x.l[s] > 0 or top / x.l[s] - 1 < 0.9:
            continue
        fl = min(x.l[t + 1:i])
        if fl < top * 0.75 or max(x.c[t + 1:i]) > top:
            continue
        if x.c[i] > top:
            done.add(t)
            out.append(_ev(i, s, top, min(fl, x.l[i]), round(100.0 * (top / x.l[s] - 1), 1)))
    return out


# ------------------------------------------------------------------ cups, staircases, measured moves, bases
def _c10(x, p):
    n = _sw(p)
    ph, _ = _piv(x, n)
    cmin, cmax = TFL['C10min'][x.tf], TFL['C10max'][x.tf]
    out, done = [], set()
    for i in range(1, x.n):
        k = _known(ph, i, n)
        if not k:
            continue
        p2 = ph[k - 1]
        R2 = x.h[p2]
        if p2 in done or max(x.c[p2 + 1:i]) > R2 or not x.c[i] > R2:
            continue
        cup = None
        for j in range(k - 2, -1, -1):
            p1 = ph[j]
            ln = p2 - p1
            if ln > cmax:
                break
            R1 = x.h[p1]
            if ln < cmin or not (0.95 * R1 <= R2 <= 1.05 * R1) or max(x.h[p1 + 1:p2]) > max(R1, R2):
                continue
            b = min(range(p1, p2 + 1), key=lambda t: (x.l[t], t))
            B = x.l[b]
            depth = (R1 - B) / R1
            if 0.12 <= depth <= 0.5 and p1 + 0.15 * ln <= b <= p2 - 0.15 * ln:
                cup = (p1, B, depth, ln)
                break
        if cup is None:
            continue
        p1, B, depth, ln = cup
        hl = min(x.l[p2 + 1:i + 1])
        if i - p2 - 1 > max(n, ln // 4) or hl < B + 0.5 * (R2 - B) or hl < 0.85 * R2:
            continue
        done.add(p2)
        out.append(_ev(i, p1, R2, hl, round(100.0 * depth, 1)))
    return out


def _alternating(x, n, i, cnt):
    """The latest `cnt` known swing highs and lows at candle i, alternating in time (high, low, high ... or low, high ...) ->
    (highs, lows) oldest first, or None."""
    ph, pl = _piv(x, n)
    k, m = _known(ph, i, n), _known(pl, i, n)
    if k < cnt or m < cnt:
        return None
    hs, ls = ph[k - cnt:k], pl[m - cnt:m]
    seq = sorted([(q, 'H') for q in hs] + [(q, 'L') for q in ls])
    if any(seq[j][1] == seq[j + 1][1] for j in range(len(seq) - 1)):
        return None
    return hs, ls


def _c15(x, p):
    n = _sw(p)
    out, done = [], set()
    for i in range(1, x.n):
        s = _alternating(x, n, i, 3)
        if s is None:
            continue
        hs, ls = s
        q3 = hs[-1]
        if q3 in done or i - (q3 + n) > WAIT:
            continue
        if not (x.h[hs[0]] < x.h[hs[1]] < x.h[hs[2]] and x.l[ls[0]] < x.l[ls[1]] < x.l[ls[2]]):
            continue
        # every pullback (a swing high to the swing low after it) gives back at most 60 % of the rise into that high
        ok = True
        for q in hs:
            before = [r for r in ls if r < q]
            after = [r for r in ls if r > q]
            if before and after:
                rise = x.h[q] - x.l[before[-1]]
                if rise <= 0 or x.h[q] - x.l[after[0]] > 0.6 * rise:
                    ok = False
        if not ok:
            continue
        if x.c[i] > x.h[q3] and not x.c[i - 1] > x.h[q3]:
            done.add(q3)
            out.append(_ev(i, ls[0], x.h[q3], x.l[ls[-1]]))
    return out


def _c16(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out, done = [], set()
    for i in range(1, x.n):
        m = _known(pl, i, n)
        if not m:
            continue
        C = pl[m - 1]
        if C in done or i - (C + n) > 40:
            continue
        kb = bisect.bisect_left(ph, C)
        if not kb:
            continue
        B = ph[kb - 1]
        ma = bisect.bisect_left(pl, B)
        if not ma:
            continue
        Ai = pl[ma - 1]
        At = _atr(x, B)
        AB = x.h[B] - x.l[Ai]
        if not At or AB < 3 * At or not x.l[C] > x.l[Ai]:
            continue
        ret = (x.h[B] - x.l[C]) / AB
        if not 0.382 <= ret <= 0.618 or max(x.c[C + 1:i]) > x.h[B]:
            continue
        if x.c[i] > x.h[B]:
            done.add(C)
            out.append(_ev(i, Ai, x.h[B], x.l[C], round(100.0 * (x.l[C] + AB - x.c[i]) / x.c[i], 1)))
    return out


def _c18(x, p):
    L, pre = TFL['C18'][x.tf], TFL['C18pre'][x.tf]
    hi, lo, rv = x.phi(L), x.plo(L), x.rv(20)
    out = []
    for i in range(L + pre, x.n):
        if hi[i] is None or not lo[i] or (hi[i] - lo[i]) / hi[i] > 0.15 or not x.fresh_above(hi, i):
            continue
        if rv[i] is None or rv[i] < 1.4:
            continue
        before = min(x.l[i - L - pre:i - L])
        if before > 0 and x.c[i - L] >= 1.2 * before:
            out.append(_ev(i, i - L, hi[i], lo[i], round(100.0 * (hi[i] - lo[i]) / hi[i], 1)))
    return out


def _c19(x, p):
    if x.tf not in TFL['C19'] or not x.day or x.day[0] < LIST_FROM:
        return []
    top, mn = TFL['C19'][x.tf], TFL['C19min'][x.tf]
    H, a = x.h[0], 0
    for i in range(1, min(x.n, top + 1)):
        if x.c[i] > H:
            depth = (H - min(x.l[a:i])) / H if H > 0 else 0
            if i - a >= mn and 0.10 <= depth <= 0.5:
                return [_ev(i, 0, H, min(x.l[a:i + 1]), round(100.0 * depth, 1))]
        if x.h[i] >= H:                                 # a close above a short / shallow pause = a new high; the base starts again
            H, a = x.h[i], i
    return []


def _c20(x, p):
    n = _sw(p)
    ph, pl = _piv(x, n)
    out, done = [], set()
    for i in range(1, x.n):
        k, m = _known(ph, i, n), _known(pl, i, n)
        if k < 3 or not m:
            continue
        qs = ph[k - 3:k]
        if qs[-1] in done:
            continue
        rs = []
        for j, q in enumerate(qs):
            nxt = qs[j + 1] if j + 1 < len(qs) else i - n
            a = bisect.bisect_right(pl, q)
            if a >= m or pl[a] >= nxt:
                rs = None
                break
            rs.append(pl[a])
        if not rs or i - (rs[-1] + n) > 30:
            continue
        hs = [x.h[q] for q in qs]
        ds = [(x.h[q] - x.l[r]) / x.h[q] for q, r in zip(qs, rs)]
        if not (ds[0] > ds[1] > ds[2] and ds[0] <= 0.5 and ds[2] <= 0.15):
            continue
        if max(hs[1], hs[2]) > 1.03 * hs[0] or not (x.l[rs[0]] < x.l[rs[1]] < x.l[rs[2]]):
            continue
        v1 = sum(x.v[qs[0]:rs[0] + 1]) / (rs[0] - qs[0] + 1)
        v3 = sum(x.v[qs[2]:rs[2] + 1]) / (rs[2] - qs[2] + 1)
        if not v3 < v1:
            continue
        piv = hs[2]
        if max(x.c[qs[2] + 1:i]) > piv or not x.c[i] > piv:
            continue
        done.add(qs[-1])
        out.append(_ev(i, qs[0], piv, x.l[rs[2]], round(100.0 * ds[2], 1)))
    return out


DETECTORS = {
    'C01': _bottoms(False), 'C02': _bottoms(True), 'C03': _c03, 'C04': _round('C04', 0.12, 0.5), 'C05': _round('C05', 0.06, 0.25),
    'C06': _lines('wedge'), 'C07': _c07, 'C08': _flags('flag'), 'C09': _flags('pennant'), 'C10': _c10, 'C11': _lines('asc'),
    'C12': _lines('sym'), 'C13': _lines('rect'), 'C14': _c14, 'C15': _c15, 'C16': _c16, 'C17': _c17, 'C18': _c18, 'C19': _c19,
    'C20': _c20,
}
pd.DETECTORS.update(DETECTORS)        # also when this module is imported first (pattern_detect imports it at its end)
