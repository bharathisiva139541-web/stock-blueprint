# -*- coding: utf-8 -*-
"""Market structure - swing highs / lows, CHoCH after a downtrend, the BOS after it (owner, 10-Nov-2026: "when market
structure formed Choch in downtrend, i check is there any FVG formed in this move ... if the price mitigated the FVG with
FVG pattern or spring candlestick pattern, i enter the trade ... i always check the market structure where this pattern
formed whether below the area of BOS or below the area of Choch. if FVG formed above the BOS means it is already moved
heavily"; answers: a swing = 5 candles each side, at least 3 lower lows and lower highs before, the CHoCH candle must
CLOSE above, the FVG formed in that move or after it, zone below the CHoCH level AND only the first pullback (no BOS
yet), no order blocks, target R multiple or the last swing high).

Rules (one timeframe's candles, oldest first; nothing looks ahead):
 - swing high = a candle whose high is above the `n` highs before it and not below the `n` after it (a swing low the
   mirror) - known only `n` candles later (when it is "confirmed"); swings alternate high / low: a second high before a
   low keeps the higher one, a second low the lower one.
 - CHoCH = the first candle that CLOSES above the last confirmed swing high, where before it the swing highs fell `d`
   times in a row (lower highs) and so did the lows that followed each of them, the last one being the lowest low
   between that swing high and the breaking candle (the "final low"). d = the smaller of the two counts.
 - after the CHoCH: BOS = the first close above the highest swing high confirmed after the CHoCH candle (a new higher
   high - "already moved"); the CHoCH is DEAD from the first close under its final low.
Pure Python (no numpy). A Structure keeps only its events and swing highs (small), not the candles: the checks that look
at the candles after a CHoCH (dead / BOS) take the closes as an argument and go forward only as far as asked.
"""
import array
import bisect


def pivots(h, l, n):
    """(swing-high candles, swing-low candles), oldest first: h[p] > the n highs before and >= the n after; l[p] < the n
    lows before and <= the n after."""
    N = len(h)
    ph, pl = [], []
    for p in range(n, N - n):
        x = h[p]
        if x > h[p - 1] and x >= h[p + 1] and x > max(h[p - n:p]) and x >= max(h[p + 1:p + n + 1]):
            ph.append(p)
        y = l[p]
        if y < l[p - 1] and y <= l[p + 1] and y < min(l[p - n:p]) and y <= min(l[p + 1:p + n + 1]):
            pl.append(p)
    return ph, pl


def choch_events(h, l, c, n, ph=None, pl=None):
    """The CHoCH events [b, hi, lvl, li, lf, d] in time order: b = the candle that closed above the swing high hi (price
    lvl), li / lf = the final low's candle / price, d = lower highs / lows before (>= 1)."""
    if ph is None:
        ph, pl = pivots(h, l, n)
    phs, pls = set(ph), set(pl)
    sw = []                       # alternating confirmed swings [candle, price, is_high]
    used = set()                  # swing highs already broken by a close
    ev = []
    for i in range(len(c)):
        p = i - n
        if p >= n:
            is_h, is_l = p in phs, p in pls
            if is_h != is_l:                      # an outside candle that is both is left out
                if is_h:
                    if sw and sw[-1][2]:
                        if h[p] > sw[-1][1]:
                            sw[-1] = [p, h[p], True]
                    else:
                        sw.append([p, h[p], True])
                else:
                    if sw and not sw[-1][2]:
                        if l[p] < sw[-1][1]:
                            sw[-1] = [p, l[p], False]
                    else:
                        sw.append([p, l[p], False])
        if not sw:
            continue
        q = len(sw) - 1 if sw[-1][2] else len(sw) - 2
        if q < 0:
            continue
        hi, lvl = sw[q][0], sw[q][1]
        if not c[i] > lvl or hi in used:
            continue
        used.add(hi)
        seg = l[hi + 1:i + 1]
        if not len(seg):
            continue
        lf = min(seg)
        li = hi + 1 + list(seg).index(lf)
        dh, k = 0, q
        while k - 2 >= 0 and sw[k][1] < sw[k - 2][1]:
            dh += 1
            k -= 2
        dl, prev, k = 0, lf, q - 1
        while k >= 0 and prev < sw[k][1]:
            dl += 1
            prev = sw[k][1]
            k -= 2
        d = min(dh, dl)
        if d >= 1:
            ev.append([i, hi, lvl, li, lf, d])
    return ev


class Structure:
    """The structure of one candle series (see the module text). events[k] = [b, hi, lvl, li, lf, d]."""
    __slots__ = ('n', 'ph', 'phv', 'events', 'bs', 'st')

    def __init__(self, h, l, c, n=5):
        self.n = n
        ph, pl = pivots(h, l, n)
        self.ph = array.array('i', ph)
        self.phv = array.array('d', [h[p] for p in ph])
        self.events = choch_events(h, l, c, n, ph, pl)
        self.bs = array.array('i', [e[0] for e in self.events])
        self.st = {}                  # k -> [next candle to check for 'dead', dead, next candle for BOS, peak, next pivot, bos]

    def _state(self, k):
        s = self.st.get(k)
        if s is None:
            b = self.events[k][0]
            s = self.st[k] = [b + 1, -1, b + 1, None, bisect.bisect_right(self.ph, b), -1]
        return s

    def dead_by(self, k, c, i):
        """The first candle after CHoCH k (up to candle i) that closed under its final low, else -1."""
        s = self._state(k)
        if s[1] >= 0:
            return s[1] if s[1] <= i else -1
        lf, j = self.events[k][4], s[0]
        while j <= i and j < len(c):
            if c[j] < lf:
                s[1] = j
                return j
            j += 1
        s[0] = j
        return -1

    def bos_before(self, k, c, i):
        """The first close above the highest swing high confirmed after CHoCH k, before candle i, else -1."""
        s = self._state(k)
        if s[5] >= 0:
            return s[5] if s[5] < i else -1
        ph, phv, n = self.ph, self.phv, self.n
        j, peak, pj = s[2], s[3], s[4]
        while j < i and j < len(c):
            while pj < len(ph) and ph[pj] + n <= j:
                v = phv[pj]
                peak = v if peak is None or v > peak else peak
                pj += 1
            if peak is not None and c[j] > peak:
                s[5] = j
                s[2], s[3], s[4] = j, peak, pj
                return j
            j += 1
        s[2], s[3], s[4] = j, peak, pj
        return -1

    def peak_before(self, k, c, i):
        """The highest swing high confirmed after CHoCH k by candle i (the BOS level), or None."""
        self.bos_before(k, c, i)
        s = self.st[k]
        return s[3]

    def active(self, i, down_n):
        """The index of the latest CHoCH before candle i with at least down_n lower highs / lows (-1 = none)."""
        k = bisect.bisect_left(self.bs, i) - 1
        while k >= 0:
            if self.events[k][5] >= down_n:
                return k
            k -= 1
        return -1

    def last_swing_high(self, i, above):
        """The most recent swing high confirmed by candle i (its candle <= i - n) at or above `above`: (candle, price)."""
        k = bisect.bisect_right(self.ph, i - self.n) - 1
        while k >= 0:
            if self.phv[k] >= above:
                return self.ph[k], self.phv[k]
            k -= 1
        return None

    def judge(self, i, zone_f, zone_top, price, c, down_n, max_age=0):
        """A signal on candle i (zone formed on candle zone_f, top zone_top; no zone: zone_f / zone_top None and `price` =
        the signal candle's close) -> {'k': CHoCH index or -1, 'stage', 'after_low', 'leg', 'after', 'below', 'first',
        'age'}. stage: 'none' (no live CHoCH before it), 'old' (the zone formed before the final low), 'bos' (a BOS came
        before the signal), 'above' (zone / price at or above the CHoCH level), 'below' (= the owner's setup)."""
        k = self.active(i, down_n)
        if k < 0:
            return {'k': -1, 'stage': 'none'}
        b, hi, lvl, li, lf, d = self.events[k]
        age = i - b
        if (max_age and age > max_age) or self.dead_by(k, c, i) >= 0:
            return {'k': -1, 'stage': 'none'}
        first = self.bos_before(k, c, i) < 0
        out = {'k': k, 'age': age, 'first': first,
               'after_low': zone_f is None or zone_f >= li,
               'leg': zone_f is None or li <= zone_f <= b + 1,
               'after': zone_f is None or zone_f > b,
               'below': (zone_top if zone_top is not None else price) < lvl}
        out['stage'] = 'old' if not out['after_low'] else 'bos' if not first else 'above' if not out['below'] else 'below'
        return out


STAGES = ('below', 'above', 'bos', 'old', 'none')
STAGE_NAMES = {'none': 'No CHoCH before it', 'old': 'Zone older than the CHoCH low', 'bos': 'After a BOS (already moved)',
               'above': 'At / above the CHoCH level', 'below': 'Below the CHoCH level, first pullback (your setup)'}
