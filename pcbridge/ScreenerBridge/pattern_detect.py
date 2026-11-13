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


# ------------------------------------------------------------------ PHASE 2 (owner, 13-Nov-2026: "Yes do it" - candlesticks,
# breakouts, moving averages, basic volume patterns). The written rules: pattern_registry.SPECS + COMMON.
LONG, SMALL, DOJI = 0.7, 0.3, 0.1        # a long body >= 0.7 x ATR(14), a small body <= 0.3 x ATR(14), a doji body <= 10 % of its range


class Ctx:
    """One stock's candles + the series the detectors share, worked out once (memo) - only from each candle and earlier ones."""

    def __init__(self, o, h, l, c, v, tf, day=None, bench=None):
        self.o, self.h, self.l, self.c, self.v, self.tf, self.day = o, h, l, c, v, tf, day
        self.bench = bench               # (day ordinals, closes) of the benchmark index (NIFTY 50) - phase 3 RS patterns
        self.n = len(c)
        self._m = {}

    def _get(self, key, fn):
        got = self._m.get(key)
        if got is None:
            got = self._m[key] = fn()
        return got

    def atr(self, n=14):
        return self._get(('atr', n), lambda: ind.atr(self.h, self.l, self.c, n))

    def sma(self, n):
        return self._get(('sma', n), lambda: ind.sma(self.c, n))

    def ema(self, n):
        return self._get(('ema', n), lambda: ind.ema(self.c, n))

    def rv(self, n=20):
        return self._get(('rv', n), lambda: ind.rel_volume(self.v, n))

    def phi(self, n):
        return self._get(('ph', n), lambda: ind.prior_high(self.h, n))

    def plo(self, n):
        return self._get(('pl', n), lambda: ind.prior_low(self.l, n))

    # one candle
    def body(self, i):
        return abs(self.c[i] - self.o[i])

    def rng(self, i):
        return self.h[i] - self.l[i]

    def up(self, i):
        return self.h[i] - max(self.o[i], self.c[i])

    def lo(self, i):
        return min(self.o[i], self.c[i]) - self.l[i]

    def green(self, i):
        return self.c[i] > self.o[i]

    def red(self, i):
        return self.c[i] < self.o[i]

    def doji(self, i):
        r = self.rng(i)
        return r > 0 and self.body(i) <= DOJI * r

    def clv(self, i):
        return ind.clv(self.o[i], self.h[i], self.l[i], self.c[i])

    def a_before(self, j):
        """ATR(14) of the candle before candle j (the pattern's size yardstick, known before the pattern starts)."""
        a = self.atr(14)
        return a[j - 1] if j >= 1 and a[j - 1] else None

    def downtrend(self, j):
        """The trend context of a reversal pattern starting on candle j: the candle before closed under its 20-SMA and that
        SMA fell over the 5 candles before (patCtx 'down')."""
        s = self.sma(20)
        k = j - 1
        return k >= 5 and s[k] is not None and s[k - 5] is not None and self.c[k] < s[k] and s[k] < s[k - 5]

    def uptrend(self, j):
        """A continuation pattern's uptrend before candle j: the close above its 20-SMA, the SMA rising over 5 candles."""
        s = self.sma(20)
        k = j - 1
        return k >= 5 and s[k] is not None and s[k - 5] is not None and self.c[k] > s[k] and s[k] > s[k - 5]

    def fresh_above(self, lvl, i, k=1.0):
        """The close of i above level lvl[i] x k while the close before was not above ITS level (one signal per breakout)."""
        a, b = lvl[i], lvl[i - 1] if i >= 1 else None
        return a is not None and self.c[i] > a * k and not (b is not None and self.c[i - 1] > b * k)


def _ev(x, i, occ, stop=None, trig=None, aux=None):
    """An event on candle i for the pattern x.l / x.h of candles occ..i (stop = their lowest low, trigger = their highest high)."""
    return [i, i, occ, max(x.h[occ:i + 1]) if trig is None else trig, min(x.l[occ:i + 1]) if stop is None else stop, aux]


def _candles(k, test, atr=True):
    """A k-candle pattern (candles i-k+1 .. i) judged by test(x, i, a) with a = ATR(14) before its first candle (atr False:
    a rule without sizes - the sheet's own column W rules - judged from the first candles on)."""
    def det(x, p):
        out = []
        for i in range(max(k, 15) if atr else k - 1, x.n):
            occ = i - k + 1
            a = x.a_before(occ) if atr else 1.0
            if a and test(x, i, a):
                out.append(_ev(x, i, occ))
        return out
    return det


# --- single candles
def _k01(x, i, a):
    r, b = x.rng(i), x.body(i)
    return r >= 0.5 * a and 0.1 * r < b <= 0.35 * r and x.lo(i) >= 2 * b and x.lo(i) >= 0.55 * r and x.up(i) <= 0.1 * r


def _k02(x, i, a):
    r, b = x.rng(i), x.body(i)
    return r >= 0.5 * a and 0.1 * r < b <= 0.35 * r and x.up(i) >= 2 * b and x.up(i) >= 0.55 * r and x.lo(i) <= 0.1 * r


def _k03(x, i, a):
    r = x.rng(i)
    return r >= 0.5 * a and x.body(i) <= DOJI * r and x.up(i) <= 0.1 * r and x.lo(i) >= 0.7 * r


def _k04(x, i, a):
    r = x.rng(i)
    return x.green(i) and x.body(i) >= LONG * a and x.up(i) <= 0.05 * r and x.lo(i) <= 0.05 * r


def _k05(x, i, a):
    r = x.rng(i)
    return (x.green(i) and x.body(i) >= LONG * a and x.body(i) >= 0.6 * r and x.lo(i) <= 0.03 * r and
            x.o[i] < x.c[i - 1])


def _k06(x, i, a):
    r = x.rng(i)
    return r >= a and x.lo(i) >= 0.6 * r and x.clv(i) >= 0


def _k07(x, i, a):
    r = x.rng(i)
    return (x.green(i) and x.body(i) >= LONG * a and x.body(i) >= 0.6 * r and x.up(i) <= 0.02 * r and
            x.lo(i) > 0.05 * r)


# --- two candles (c1 = i-1, c2 = i)
def _k09(x, i, a):          # = the sheet's column W "Piercing" (web/lib/patterns.js)
    j = i - 1
    return x.c[j] < x.o[j] and x.o[i] < x.l[j] and x.c[i] > (x.o[j] + x.c[j]) / 2 and x.c[i] < x.o[j]


def _k10(x, i, a):          # = the sheet's "Bullish Harami"
    j = i - 1
    return (x.red(j) and x.green(i) and x.o[i] >= x.c[j] and x.c[i] <= x.o[j] and x.l[i] > x.l[j] and
            x.body(i) < x.body(j))


def _k11(x, i, a):
    j = i - 1
    return (x.red(j) and x.body(j) >= LONG * a and x.doji(i) and max(x.o[i], x.c[i]) <= x.o[j] and
            min(x.o[i], x.c[i]) >= x.c[j])


def _k12(x, i, a):          # = the sheet's "Tweezer Bottoms"
    j = i - 1
    if not (x.red(j) and x.green(i)):
        return False
    avg_low = (x.l[j] + x.l[i]) / 2 or 1
    b1, b2, w1, w2 = x.body(j), x.body(i), x.lo(j), x.lo(i)
    return (abs(x.l[j] - x.l[i]) <= avg_low * 0.0125 and abs(b1 - b2) <= max(b1, b2) * 0.25 and
            abs(w1 - w2) <= max(w1, w2) * 0.30 and w1 > 0 and w2 > 0)


def _k13(x, i, a):
    j = i - 1
    return x.red(j) and x.body(j) >= LONG * a and x.red(i) and abs(x.c[i] - x.c[j]) <= 0.001 * x.c[j]


def _k14(x, i, a):
    j = i - 1
    b1 = x.body(j)
    return (x.red(j) and b1 >= LONG * a and x.green(i) and x.body(i) >= LONG * a and x.o[i] <= x.c[j] - 0.3 * b1 and
            abs(x.c[i] - x.c[j]) <= 0.1 * b1)


def _maru(x, k, a):
    r = x.rng(k)
    return x.body(k) >= LONG * a and x.up(k) <= 0.05 * r and x.lo(k) <= 0.05 * r


def _k15(x, i, a):
    j = i - 1
    return x.red(j) and _maru(x, j, a) and x.green(i) and _maru(x, i, a) and x.l[i] > x.h[j]


def _k16(x, i, a):
    j = i - 1
    b1 = x.body(j)
    return (x.uptrend(j) and x.red(j) and b1 >= SMALL * a and x.green(i) and x.body(i) >= LONG * a and
            abs(x.o[i] - x.o[j]) <= 0.1 * b1 and x.lo(i) <= 0.05 * x.rng(i))


# --- three or more candles
def _k17(x, i, a):          # = the sheet's "Morningstar"
    p, q = i - 2, i - 1
    b1, b2, b3 = x.body(p), x.body(q), x.body(i)
    r1 = x.rng(p)
    return (x.red(p) and b1 / x.o[p] >= 0.02 and r1 > 0 and (min(x.o[p], x.c[p]) - x.l[p]) / r1 <= 0.3 and b2 / b1 <= 0.3 and
            x.green(i) and b3 / x.o[i] >= 0.02 and x.c[i] >= (x.o[p] + x.c[p]) / 2)


def _k18(x, i, a):
    p, q = i - 2, i - 1
    return (x.red(p) and x.body(p) >= LONG * a and x.doji(q) and max(x.o[q], x.c[q]) < x.c[p] and x.green(i) and
            x.body(i) >= 0.5 * a and x.c[i] > (x.o[p] + x.c[p]) / 2)


def _k19(x, i, a):
    for k in (i - 2, i - 1, i):
        if not (x.green(k) and x.body(k) >= LONG * a and x.up(k) <= 0.25 * x.rng(k)):
            return False
    for k in (i - 1, i):
        if not (x.c[k] > x.c[k - 1] and x.o[k - 1] <= x.o[k] <= x.c[k - 1]):
            return False
    return True


def _k20(x, i, a):
    p, q = i - 2, i - 1
    return (x.red(p) and x.body(p) >= LONG * a and x.green(q) and x.o[q] >= x.c[p] and x.c[q] <= x.o[p] and
            x.body(q) < x.body(p) and x.green(i) and x.c[i] > x.o[p])


def _k21(x, i, a):
    p, q = i - 2, i - 1
    return (x.red(p) and x.green(q) and x.o[q] <= x.c[p] and x.c[q] >= x.o[p] and x.body(q) > x.body(p) and
            x.green(i) and x.c[i] > x.c[q])


def _k22(x, i, a):
    p, q = i - 2, i - 1
    r3 = x.rng(i)
    return (x.red(p) and x.body(p) >= LONG * a and x.lo(p) >= 0.3 * x.rng(p) and
            x.red(q) and x.body(q) < x.body(p) and x.c[p] < x.o[q] < x.o[p] and x.l[q] > x.l[p] and x.lo(q) > 0 and
            x.red(i) and x.body(i) <= SMALL * a and x.up(i) <= 0.1 * r3 and x.lo(i) <= 0.1 * r3 and
            x.h[i] <= x.h[q] and x.l[i] >= x.l[q])


def _k23(x, i, a):
    p, q = i - 2, i - 1
    return (x.red(p) and x.body(p) >= LONG * a and x.doji(q) and x.h[q] < x.l[p] and x.green(i) and x.l[i] > x.h[q] and
            x.c[i] > (x.o[p] + x.c[p]) / 2)


def _k24(x, i, a):
    p, q = i - 2, i - 1
    return (x.red(p) and x.body(p) >= SMALL * a and x.green(q) and x.o[q] >= x.c[p] and x.c[q] > x.o[p] and
            x.red(i) and x.o[i] > x.c[q] and abs(x.c[i] - x.c[p]) <= 0.002 * x.c[p])


def _k25(x, i, a):
    k1, k2, k3 = i - 3, i - 2, i - 1
    return (x.red(k1) and _maru(x, k1, a) and x.red(k2) and _maru(x, k2, a) and
            x.red(k3) and x.o[k3] < x.c[k2] and x.h[k3] > x.c[k2] and
            x.red(i) and x.o[i] >= x.h[k3] and x.c[i] <= x.l[k3])


def _k26(x, i, a):
    k1 = i - 4
    b1 = x.body(k1)
    if not (x.uptrend(k1) and x.green(k1) and b1 >= LONG * a and x.green(i) and x.body(i) >= LONG * a):
        return False
    mid = (i - 3, i - 2, i - 1)
    if not all(x.body(k) <= 0.5 * b1 and x.h[k] <= x.h[k1] and x.l[k] >= x.l[k1] for k in mid):
        return False
    return sum(1 for k in mid if x.red(k)) >= 2 and x.o[i] > x.c[i - 1] and x.c[i] > x.c[k1]


def _k27(x, i, a):
    k1 = i - 4
    b1 = x.body(k1)
    if not (x.uptrend(k1) and x.green(k1) and b1 >= LONG * a and x.green(i)):
        return False
    k2 = i - 3
    if not (min(x.o[k2], x.c[k2]) > x.c[k1] and x.body(k2) <= 0.5 * b1):
        return False
    half = (x.o[k1] + x.c[k1]) / 2
    if not all(x.body(k) <= 0.5 * b1 and x.l[k] >= half for k in (i - 2, i - 1)):
        return False
    return x.c[i] > max(x.h[i - 3:i])


# --- breakouts
B_N = {'B05': ({'D': 126, 'W': 26, '4H': 252}, {'D': 63, 'W': 13, '4H': 126}), 'B06': {'D': 60, 'W': 26, '4H': 120},
       'B13': 55, 'B18': {'D': 30, 'W': 8, '4H': 60}}


def _b05(x, p):
    full, recent = B_N['B05'][0][x.tf], B_N['B05'][1][x.tf]
    pf, pr = x.phi(full), x.phi(recent)
    out = []
    for i in range(full, x.n):
        if pf[i] is not None and pr[i] is not None and pr[i] < pf[i] and x.c[i] > pf[i]:
            out.append([i, i, i, pf[i], x.l[i], None])
    return out


def _touch_level(x, i, n, tol=0.01, gap=3):
    """The level = the highest high of the n candles before i and how many separate times (>= gap candles apart) a high came
    within tol of it."""
    lvl = x.phi(n)[i]
    if lvl is None:
        return None, 0
    t, last = 0, -10 ** 9
    for j in range(i - n, i):
        if x.h[j] >= lvl * (1 - tol) and j - last >= gap:
            t, last = t + 1, j
    return lvl, t


def _b06(x, p, rv_min=0.0):
    n = B_N['B06'][x.tf]
    lv = x.phi(n)
    rv = x.rv(20) if rv_min else None
    out = []
    for i in range(n, x.n):
        if not x.fresh_above(lv, i):
            continue
        lvl, t = _touch_level(x, i, n)
        if t >= 3 and (not rv_min or (rv[i] is not None and rv[i] >= rv_min)):
            out.append([i, i, i, lvl, x.l[i], t])
    return out


def _b07(x, p):
    out = []
    for i in range(16, x.n):
        a = x.a_before(i - 1)
        if a and x.rng(i - 1) <= 0.5 * a and x.c[i] > x.h[i - 1]:
            out.append([i, i, i - 1, x.h[i - 1], min(x.l[i - 1], x.l[i]), None])
    return out


def _nr(k):
    def det(x, p):
        out = []
        for i in range(k, x.n):
            r = x.rng(i - 1)
            if all(r <= x.rng(j) for j in range(i - k, i - 1)) and x.c[i] > x.h[i - 1]:
                out.append([i, i, i - 1, x.h[i - 1], min(x.l[i - 1], x.l[i]), None])
        return out
    return det


def _b10(x, p):
    out = []
    for i in range(4, x.n):
        for q in range(2, 11):
            m = i - 1 - q
            if m < 0:
                break
            if all(x.h[j] <= x.h[m] and x.l[j] >= x.l[m] for j in range(m + 1, i)):
                if x.c[i] > x.h[m]:
                    out.append([i, i, m, x.h[m], x.l[m], q])
                break
    return out


def _bb(x, n=20, k=2.0):
    def mk():
        mid, sd = x.sma(n), ind.stdev(x.c, n)
        up = [None if m is None else m + k * d for m, d in zip(mid, sd)]
        lo = [None if m is None else m - k * d for m, d in zip(mid, sd)]
        bw = [None if (m is None or not m) else (u - w) / m for m, u, w in zip(mid, up, lo)]
        return mid, up, lo, bw
    return x._get(('bb', n, k), mk)


def _b11(x, p):
    mid, up, lo, bw = _bb(x)
    out = []
    for i in range(146, x.n):
        if not x.fresh_above(up, i):
            continue
        w = [b for b in bw[i - 126:i] if b is not None]
        if len(w) >= 100 and sum(1 for b in w if b < bw[i - 1]) <= 0.10 * len(w):
            out.append([i, i, i, up[i], x.l[i], round(bw[i - 1] * 100, 2)])
    return out


def _kc(x, n=20, k=1.5):
    def mk():
        e, a = x.ema(n), x.atr(n)
        return ([None if (m is None or b is None) else m + k * b for m, b in zip(e, a)],
                [None if (m is None or b is None) else m - k * b for m, b in zip(e, a)])
    return x._get(('kc', n, k), mk)


def _b12(x, p):
    _, bu, bl, _ = _bb(x)
    ku, kl = _kc(x)
    sq = [bu[j] is not None and ku[j] is not None and bu[j] < ku[j] and bl[j] > kl[j] for j in range(x.n)]
    out = []
    for i in range(23, x.n):
        if sq[i - 1] and sq[i - 2] and sq[i - 3] and x.fresh_above(ku, i):
            out.append([i, i, i, ku[i], x.l[i], None])
    return out


def _b13(x, p):
    lv = x.phi(B_N['B13'])
    return [[i, i, i, lv[i], x.l[i], None] for i in range(1, x.n) if x.fresh_above(lv, i)]


def _b14(x, p):
    """Darvas box: a top = a high above the 10 highs before it and not exceeded by the next 3 candles (known 3 candles later);
    then a bottom = the lowest low since the top, not broken by the next 3 candles while no high reached the top; the
    breakout = the first close above the top after that (a low under the bottom first = the box is void)."""
    h, l, c = x.h, x.l, x.c
    out, st, t, top, bot = [], 0, None, None, None
    for i in range(x.n):
        if st == 0:
            k = i - 3
            if k >= 10 and h[k] >= max(h[k - 10:k]) and max(h[k + 1:i + 1]) < h[k]:
                st, t, top = 1, k, h[k]
            continue
        if st == 1:
            if h[i] >= top:
                st = 0
                continue
            seg = l[t + 1:i + 1]
            m = min(seg)
            b = t + 1 + seg.index(m)
            if i - b >= 3 and min(l[b + 1:i + 1]) > m:
                st, bot = 2, m
            continue
        if c[i] > top:
            out.append([i, i, t, top, bot, round((top - bot) / bot * 100, 2) if bot else None])
            st = 0
        elif l[i] < bot:
            st = 0
    return out


def _b16(x, p):
    lv = x.phi(20)
    pl = x.plo(20)
    out, wait = [], []
    for i in range(21, x.n):
        keep = []
        for k, lvl in wait:
            if i - k > 10 or x.c[i] < lvl * 0.98:
                continue
            if x.l[i] <= lvl * 1.01 and x.c[i] > lvl:
                out.append([i, i, k, lvl, x.l[i], i - k])
                continue
            keep.append((k, lvl))
        wait = keep
        if x.fresh_above(lv, i) and pl[i] and (lv[i] - pl[i]) / pl[i] <= 0.15:
            wait.append((i, lv[i]))
    return out


def _b17(x, p):
    a = x.atr(14)
    out = []
    for i in range(22, x.n):
        a1, a21 = a[i - 1], a[i - 21]
        if a1 is None or a21 is None or a1 > 0.75 * a21:
            continue
        if any(a[j] is None or a[j] < a1 for j in range(i - 20, i - 1)):
            continue
        if x.rng(i) >= 2 * a1 and x.green(i) and x.clv(i) >= 0.5:
            out.append([i, i, i, x.h[i], x.l[i], round(x.rng(i) / a1, 2)])
    return out


def _b18(x, p):
    n = B_N['B18'][x.tf]
    hi, lo = x.phi(n), x.plo(n)
    out = []
    for i in range(n, x.n):
        if hi[i] is not None and lo[i] and (hi[i] - lo[i]) / lo[i] <= 0.15 and x.fresh_above(hi, i):
            out.append([i, i, i - n, hi[i], x.l[i], round((hi[i] - lo[i]) / lo[i] * 100, 2)])
    return out


def _b19(x, p):
    lv = x.phi(40)
    out = []
    for i in range(41, x.n):
        if not x.fresh_above(lv, i):
            continue
        lvl = lv[i]
        tests = sum(1 for j in range(i - 10, i) if x.h[j] >= lvl * 0.985)
        if tests >= 3 and min(x.l[i - 5:i]) > min(x.l[i - 15:i - 5]):
            out.append([i, i, i, lvl, x.l[i], tests])
    return out


def _b20(x, p):
    s20, s50, s200 = x.sma(20), x.sma(50), x.sma(200)
    out = []
    for i in range(201, x.n):
        m0 = (s20[i], s50[i], s200[i])
        m1 = (s20[i - 1], s50[i - 1], s200[i - 1])
        if None in m0 or None in m1:
            continue
        if (max(m1) - min(m1)) / x.c[i - 1] <= 0.03 and x.c[i] > max(m0) * 1.01 and not x.c[i - 1] > max(m1) * 1.01:
            out.append([i, i, i, max(m0), x.l[i], None])
    return out


# --- moving averages
def _ma_pull(n):
    def det(x, p):
        e = x.ema(n)
        out = []
        for i in range(n + 10, x.n):
            if e[i] is None or e[i - 10] is None or not e[i] > e[i - 10]:
                continue
            if not (x.l[i] <= e[i] * 1.005 and x.c[i] > e[i] and x.green(i)):
                continue
            if all(x.c[j] > e[j] for j in range(i - 5, i)) and all(x.l[j] > e[j] * 1.005 for j in range(i - 3, i)):
                out.append([i, i, i, x.h[i], x.l[i], None])
        return out
    return det


def _cross(fast, slow, kind='sma', look=20):
    def det(x, p):
        f = x.sma(fast) if kind == 'sma' else x.ema(fast)
        s = x.sma(slow) if kind == 'sma' else x.ema(slow)
        out = []
        for i in range(1, x.n):
            if None in (f[i], s[i], f[i - 1], s[i - 1]):
                continue
            if f[i] > s[i] and f[i - 1] <= s[i - 1]:
                out.append([i, i, i, x.h[i], min(x.l[max(0, i - look + 1):i + 1]), None])
        return out
    return det


def _state(test, look=10):
    """A signal on the first candle where test(x, j) is true after a candle where it was not."""
    def det(x, p):
        out, prev = [], False
        for i in range(x.n):
            now = test(x, i)
            if now and not prev and i >= 1:
                out.append([i, i, i, x.h[i], min(x.l[max(0, i - look + 1):i + 1]), None])
            prev = now
        return out
    return det


def _m07(x, j):
    e50, e200 = x.ema(50), x.ema(200)
    if j < 5 or None in (e50[j], e200[j], e50[j - 5], e200[j - 5]):
        return False
    return x.c[j] > e50[j] > e200[j] and e50[j] > e50[j - 5] and e200[j] > e200[j - 5]


RIBBON = (10, 20, 30, 40, 50, 60)


def _m08(x, p):
    es = [x.ema(n) for n in RIBBON]

    def aligned(j):
        v = [e[j] for e in es]
        return None not in v and all(v[k] > v[k + 1] for k in range(len(v) - 1))

    def spread(j):
        return (es[0][j] - es[-1][j]) / x.c[j]
    out = []
    for i in range(6, x.n):
        if aligned(i) and not aligned(i - 1) and es[-1][i - 5] is not None and spread(i) > spread(i - 5):
            out.append([i, i, i, x.h[i], min(x.l[max(0, i - 9):i + 1]), None])
    return out


def _reclaim(line, below):
    def det(x, p):
        m = x.ema(50) if line == 'ema50' else x.sma(200)
        out = []
        for i in range(below, x.n):
            if m[i] is None or not x.c[i] > m[i]:
                continue
            if all(m[j] is not None and x.c[j] < m[j] for j in range(i - below, i)):
                out.append([i, i, i - below, x.h[i], min(x.l[i - below:i + 1]), None])
        return out
    return det


def _htf_key(tf, d):
    """The higher timeframe's candle a candle belongs to: D -> its week (Monday), W -> its month, 4H -> its day."""
    if tf == 'D':
        return d - (d - 1) % 7          # date.toordinal(): 1 = Monday 01-01-0001 -> the week's Monday
    if tf == 'W':
        from datetime import date as _date
        x = _date.fromordinal(d)
        return x.year * 12 + x.month
    return d


def _m11(x, p):
    """Higher-timeframe close above its 10 EMA above its 20 EMA (only FINISHED higher candles - the one the candle is in is
    not used) and the candle's own close above its 20 EMA above its 50 EMA."""
    if not x.day:
        return []
    keys = [_htf_key(x.tf, d) for d in x.day]
    gidx, hc = [], []
    for i in range(x.n):
        if i == 0 or keys[i] != keys[i - 1]:
            hc.append(x.c[i])
        else:
            hc[-1] = x.c[i]
        gidx.append(len(hc) - 1)
    # the higher EMAs of the finished candles: computed on the finished closes only (the last close of each group); a group's
    # value becomes known when the NEXT group starts
    h10, h20 = ind.ema(hc, 10), ind.ema(hc, 20)
    e20, e50 = x.ema(20), x.ema(50)

    def both(j):
        g = gidx[j] - 1                  # the last finished higher candle
        if g < 0 or h20[g] is None or e50[j] is None:
            return False
        return hc[g] > h10[g] > h20[g] and x.c[j] > e20[j] > e50[j]
    out, prev = [], False
    for i in range(x.n):
        now = both(i)
        if now and not prev and i >= 1:
            out.append([i, i, i, x.h[i], min(x.l[max(0, i - 9):i + 1]), None])
        prev = now
    return out


def _m12(x, p, n=10, k=3.0):
    a = x.atr(n)
    out = []
    fu = fl = None
    trend = 0
    for i in range(x.n):
        if a[i] is None:
            continue
        mid = (x.h[i] + x.l[i]) / 2
        bu, bl = mid + k * a[i], mid - k * a[i]
        if fu is None:
            fu, fl, trend = bu, bl, -1
            continue
        pc = x.c[i - 1]
        nfu = bu if (bu < fu or pc > fu) else fu
        nfl = bl if (bl > fl or pc < fl) else fl
        was = trend
        if trend <= 0 and x.c[i] > nfu:
            trend = 1
        elif trend > 0 and x.c[i] < nfl:
            trend = -1
        fu, fl = nfu, nfl
        if was <= 0 and trend > 0:
            out.append([i, i, i, x.h[i], min(fl, x.l[i]), None])
    return out


# --- volume
def _v01(x, p):
    rv, pl = x.rv(20), x.plo(20)
    out = []
    for i in range(21, x.n):
        j = i - 1
        if (x.red(j) and rv[j] is not None and rv[j] >= 2.5 and pl[j] is not None and x.l[j] < pl[j] and
                x.green(i) and x.c[i] > (x.h[j] + x.l[j]) / 2):
            out.append([i, i, j, max(x.h[j], x.h[i]), min(x.l[j], x.l[i]), round(rv[j], 2)])
    return out


def _v02(x, p):
    rv, pl = x.rv(20), x.plo(20)
    return [[i, i, i, x.h[i], x.l[i], round(rv[i], 2)] for i in range(20, x.n)
            if rv[i] is not None and rv[i] >= 3 and pl[i] is not None and x.l[i] < pl[i] and x.clv(i) >= 0]


def _v03(x, p):
    rv = x.rv(20)
    return [[i, i, i - 1, x.h[i], min(x.l[i - 1], x.l[i]), round(rv[i], 2)] for i in range(20, x.n)
            if x.c[i - 1] < x.c[i - 6] and x.green(i) and rv[i] is not None and rv[i] >= 2 and x.c[i] > x.h[i - 1]]


def _vsum(x):
    def mk():
        pre = [0.0]
        for q in x.v:
            pre.append(pre[-1] + q)
        return pre
    return x._get(('vsum',), mk)


def _v04(x, p):
    pre, lv = _vsum(x), x.phi(20)
    out = []
    for i in range(60, x.n):
        if not x.fresh_above(lv, i):
            continue
        recent = (pre[i] - pre[i - 10]) / 10.0
        before = (pre[i - 10] - pre[i - 60]) / 50.0
        if before > 0 and recent <= 0.6 * before:
            out.append([i, i, i - 10, lv[i], x.l[i], round(recent / before, 2)])
    return out


def _v05(x, p):
    rv, lv = x.rv(20), x.phi(20)
    return [[i, i, i - 2, lv[i], x.l[i], round(rv[i], 2)] for i in range(20, x.n)
            if x.fresh_above(lv, i) and x.v[i] > x.v[i - 1] > x.v[i - 2] and rv[i] is not None and rv[i] >= 1.5]


def _v06(x, p):
    rv, lv = x.rv(20), x.phi(50)
    return [[i, i, i, lv[i], x.l[i], round(rv[i], 2)] for i in range(50, x.n)
            if x.fresh_above(lv, i) and rv[i] is not None and rv[i] >= 3]


def _v07(x, p):
    rv = x.rv(20)

    def ok(j):
        return (j >= 22 and all(x.green(k) for k in (j - 2, j - 1, j)) and x.c[j] > x.c[j - 1] > x.c[j - 2] and
                x.v[j] > x.v[j - 1] > x.v[j - 2] and rv[j] is not None and rv[j] >= 1.2)
    return [[i, i, i - 2, x.h[i], min(x.l[i - 2:i + 1]), round(rv[i], 2)] for i in range(22, x.n) if ok(i) and not ok(i - 1)]


def _v08(x, p):
    s50, pre = x.sma(50), _vsum(x)
    out = []
    for i in range(60, x.n):
        if s50[i] is None or s50[i - 10] is None or not (x.c[i] > s50[i] and s50[i] > s50[i - 10]):
            continue
        k = 0
        while k < 7 and x.c[i - 1 - k] < x.c[i - 2 - k]:
            k += 1
        if not 3 <= k <= 6:
            continue
        a = i - k                        # the pullback = candles a .. i-1
        run = (pre[i] - pre[a]) / k
        before = (pre[a] - pre[a - 20]) / 20.0
        if before > 0 and run < 0.7 * before and x.green(i) and x.c[i] > x.h[i - 1]:
            out.append([i, i, a, x.h[i], min(x.l[a:i + 1]), round(run / before, 2)])
    return out


def _v12(x, p):
    s50 = x.sma(50)
    out = []
    for i in range(60, x.n):
        a = x.a_before(i)
        if not a or s50[i] is None or s50[i - 10] is None:
            continue
        if (x.c[i] < x.c[i - 1] and x.rng(i) < 0.7 * a and x.v[i] < x.v[i - 1] and x.v[i] < x.v[i - 2] and
                x.clv(i) >= -0.5 and x.c[i] > s50[i] and s50[i] > s50[i - 10]):
            out.append([i, i, i, x.h[i], x.l[i], None])
    return out


def _v13(x, p):
    s20, rv = x.sma(20), x.rv(20)
    out = []
    for i in range(20, x.n):
        r = x.rng(i)
        if (s20[i] is not None and x.c[i] < s20[i] and x.c[i] < x.c[i - 5] and rv[i] is not None and rv[i] >= 2 and
                x.clv(i) >= 0 and r > 0 and x.lo(i) >= 0.4 * r):
            out.append([i, i, i, x.h[i], x.l[i], round(rv[i], 2)])
    return out


def _v15(x, p):
    return _b06(x, p, rv_min=1.5)


def _ctxwrap(det):
    """Phase-1 detectors take the lists; phase-2 ones the shared Ctx."""
    def run(x, p):
        return det(x.o, x.h, x.l, x.c, x.v, x.tf, p)
    return run


DETECTORS = {'K08': _ctxwrap(bullish_engulfing), 'B01': _ctxwrap(high_breakout('B01')), 'B02': _ctxwrap(high_breakout('B02')),
             'B03': _ctxwrap(high_breakout('B03')), 'B04': _ctxwrap(high_breakout('B04')), 'I01': _ctxwrap(rsi_divergence),
             'K01': _candles(1, _k01), 'K02': _candles(1, _k02), 'K03': _candles(1, _k03), 'K04': _candles(1, _k04),
             'K05': _candles(1, _k05), 'K06': _candles(1, _k06), 'K07': _candles(1, _k07),
             'K09': _candles(2, _k09, False), 'K10': _candles(2, _k10, False), 'K11': _candles(2, _k11), 'K12': _candles(2, _k12, False),
             'K13': _candles(2, _k13), 'K14': _candles(2, _k14), 'K15': _candles(2, _k15), 'K16': _candles(2, _k16),
             'K17': _candles(3, _k17, False), 'K18': _candles(3, _k18), 'K19': _candles(3, _k19), 'K20': _candles(3, _k20),
             'K21': _candles(3, _k21), 'K22': _candles(3, _k22), 'K23': _candles(3, _k23), 'K24': _candles(3, _k24),
             'K25': _candles(4, _k25), 'K26': _candles(5, _k26), 'K27': _candles(5, _k27),
             'B05': _b05, 'B06': _b06, 'B07': _b07, 'B08': _nr(4), 'B09': _nr(7), 'B10': _b10, 'B11': _b11, 'B12': _b12,
             'B13': _b13, 'B14': _b14, 'B16': _b16, 'B17': _b17, 'B18': _b18, 'B19': _b19, 'B20': _b20,
             'M01': _ma_pull(20), 'M02': _ma_pull(50), 'M03': _ma_pull(100), 'M04': _ma_pull(200),
             'M05': _cross(50, 200, 'sma', 20), 'M06': _cross(20, 50, 'ema', 10), 'M07': _state(_m07), 'M08': _m08,
             'M09': _reclaim('ema50', 10), 'M10': _reclaim('sma200', 20), 'M11': _m11, 'M12': _m12,
             'V01': _v01, 'V02': _v02, 'V03': _v03, 'V04': _v04, 'V05': _v05, 'V06': _v06, 'V07': _v07, 'V08': _v08,
             'V12': _v12, 'V13': _v13, 'V15': _v15}


def detect(pid, o, h, l, c, v, tf, P=None, day=None, bench=None):
    """The events of pattern `pid` on one stock's candles (lists, oldest first) of timeframe tf ('D' / 'W' / '4H'); `day` = the
    candles' day ordinals (the multi-timeframe patterns M11 / Q12 and the period sweeps S03-S05 need them); `bench` = the
    benchmark's (day ordinals, closes) for the relative-strength patterns I23 / I24 / Q13 (none = no events). P['patCtx'] 'down'
    keeps a reversal pattern (registry 'ctx') only after a fall: the candle before it closed under its falling 20-SMA."""
    x = Ctx(o, h, l, c, v, tf, day, bench)
    ev = DETECTORS[pid](x, params_for(pid, P))
    if P and P.get('patCtx') == 'down' and reg.SPECS[pid].get('ctx'):
        ev = [e for e in ev if x.downtrend(e[2])]
    return ev


# ------------------------------------------------------------------ PHASE 3 (owner, 13-Nov-2026: "Do it") - pattern_p3.py adds its
# detectors to DETECTORS (it also does that itself when it is imported first)
import pattern_p3  # noqa: E402,F401
DETECTORS.update(getattr(pattern_p3, 'DETECTORS', {}))
