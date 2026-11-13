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
 - the MOVE (11-Nov-2026): from the CHoCH's final low to the highest high since it, up to the candle before a signal (what a
   trader draws the Fibonacci retracement on, at that moment); `depth` = how far down that move a price sits - 0 = at the
   high, 1 = at the final low, 0.5 = the middle (TradingView's Fib levels drawn from the low to the high). The owner's
   discount zone = a zone whose middle is at depth >= 0.5 (owner, 11-Nov-2026 on SUPREMEIND: "we always try to enter with
   low risk, i.e. the zone in discount area. it is ok even the zone have some area slightly above the Choch").
OPTIONS (owner, 12-Nov-2026: "Finish all the remaining updates" - the ChatGPT review's experiments E2 / E3 / E5, each one a
choice in the Backtest Lab next to the frozen baseline above; every option at its default = exactly the baseline):
 - prom (E2, ATR prominence): a swing high counts only when it stands at least prom x ATR(14) above the lowest low of the
   candles around it (n each side); a swing low mirrored.
 - swing 'zigzag' (E3, ATR ZigZag / directional change): a swing high = the highest high since the last swing low, known on
   the first candle whose low is zz x ATR(14) under it (a swing low mirrored) - instead of n candles each side.
 - choch 'protected' (E5): the CHoCH = a close above the PROTECTED high - the swing high right before the lowest swing low of
   the fall (the one that made the last lower low) - not the last (maybe minor) swing high.
 - eq (E5, equal highs / lows): a high within eq x ATR(14) of the one before is not a LOWER high (the same for lows).
 - sweeps (E5): `sweep[k]` = the final low of CHoCH k went under the swing low before it and CLOSED back above it (a sweep
   of the sell-side liquidity, not a breakdown).
Pure Python (no numpy). A Structure keeps only its events and swing highs (small), not the candles: the checks that look
at the candles after a CHoCH (dead / BOS) take the closes as an argument and go forward only as far as asked.
"""
import array
import bisect


def atr_series(h, l, c, n=14):
    """The average true range of the n candles up to each candle (a simple mean; the first candles: of the ones there are)."""
    out, tr, tot = [], [], 0.0
    for i in range(len(h)):
        t = h[i] - l[i] if i == 0 else max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1]))
        tr.append(t)
        tot += t
        if i >= n:
            tot -= tr[i - n]
        out.append(tot / min(i + 1, n))
    return out


def pivots(h, l, n, prom=0.0, atr=None):
    """(swing-high candles, swing-low candles), oldest first: h[p] > the n highs before and >= the n after; l[p] < the n
    lows before and <= the n after. prom > 0 (with `atr`): a high must also stand prom x ATR above the lowest low of the
    candles p-n .. p+n (a low mirrored) - ATR prominence."""
    N = len(h)
    ph, pl = [], []
    for p in range(n, N - n):
        x = h[p]
        if x > h[p - 1] and x >= h[p + 1] and x > max(h[p - n:p]) and x >= max(h[p + 1:p + n + 1]):
            if not prom or x - min(l[p - n:p + n + 1]) >= prom * atr[p]:
                ph.append(p)
        y = l[p]
        if y < l[p - 1] and y <= l[p + 1] and y < min(l[p - n:p]) and y <= min(l[p + 1:p + n + 1]):
            if not prom or max(h[p - n:p + n + 1]) - y >= prom * atr[p]:
                pl.append(p)
    return ph, pl


def zigzag(h, l, atr, k):
    """ATR ZigZag (directional change): [(pivot candle, the candle it is known on, is_high)] alternating, oldest first. A
    swing high = the highest high since the last swing low, known on the first later candle whose low is k x ATR under it
    (the ATR of that candle); a swing low mirrored. Nothing looks ahead."""
    N = len(h)
    out = []
    if N < 2:
        return out
    hi_i = lo_i = 0
    d = 0                                     # 0 = not started, 1 = rising (looking for a high), -1 = falling
    for j in range(1, N):
        a = k * atr[j]
        if d >= 0 and h[j] > h[hi_i]:
            hi_i = j
        if d <= 0 and l[j] < l[lo_i]:
            lo_i = j
        if d >= 0 and hi_i < j and h[hi_i] - l[j] >= a and (d == 1 or hi_i >= lo_i):
            out.append((hi_i, j, True))
            d = -1
            lo_i = min(range(hi_i + 1, j + 1), key=lambda x: (l[x], -x))
        elif d <= 0 and lo_i < j and h[j] - l[lo_i] >= a and (d == -1 or lo_i > hi_i):
            out.append((lo_i, j, False))
            d = 1
            hi_i = max(range(lo_i + 1, j + 1), key=lambda x: (h[x], x))
    return out


def swing_points(h, l, c, n=5, opts=None):
    """The swings the structure is built on -> {'ph', 'pl' (pivot candles), 'phc', 'plc' (the candle each is known on),
    'conf' {candle: [(pivot, is_high), ...]}, 'atr' (or None)}. opts = {'swing': 'fractal' | 'zigzag', 'zz', 'prom',
    'eq', ...} (see the module text); none = the baseline n-candle fractals."""
    o = opts or {}
    zz = o.get('swing') == 'zigzag'
    atr = atr_series(h, l, c) if (zz or o.get('prom') or o.get('eq')) else None
    conf = {}
    if zz:
        sw = zigzag(h, l, atr, float(o.get('zz') or 2.0))
        ph = [p for p, j, hi in sw if hi]
        phc = [j for p, j, hi in sw if hi]
        pl = [p for p, j, hi in sw if not hi]
        plc = [j for p, j, hi in sw if not hi]
        for p, j, hi in sw:
            conf.setdefault(j, []).append((p, hi))
    else:
        ph, pl = pivots(h, l, n, float(o.get('prom') or 0), atr)
        phc, plc = [p + n for p in ph], [p + n for p in pl]
        phs, pls = set(ph), set(pl)
        for p in phs ^ pls:                     # an outside candle that is both is left out
            conf.setdefault(p + n, []).append((p, p in phs))
    return {'ph': ph, 'pl': pl, 'phc': phc, 'plc': plc, 'conf': conf, 'atr': atr}


def choch_events(h, l, c, n, ph=None, pl=None, opts=None, pts=None):
    """The CHoCH events [b, hi, lvl, li, lf, d] in time order: b = the candle that closed above the swing high hi (price
    lvl), li / lf = the final low's candle / price, d = lower highs / lows before (>= 1). opts: see the module text
    (protected CHoCH, equal highs / lows, the swing kind); `pts` = swing_points (made here when missing)."""
    o = opts or {}
    if pts is None:
        if ph is not None and not o:
            phs, pls = set(ph), set(pl)
            pts = {'conf': {}, 'atr': None}
            for p in phs ^ pls:
                pts['conf'].setdefault(p + n, []).append((p, p in phs))
        else:
            pts = swing_points(h, l, c, n, o)
    conf, atr = pts['conf'], pts['atr']
    eq = float(o.get('eq') or 0)
    protected = o.get('choch') == 'protected'

    def tol(k):
        return eq * atr[sw[k][0]] if eq else 0.0
    sw = []                       # alternating confirmed swings [candle, price, is_high]
    used = set()                  # swing highs already broken by a close
    base = 0                      # protected: the swings after the last CHoCH
    ev = []
    for i in range(len(c)):
        for p, is_h in sorted(conf.get(i, ())):
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
        if protected:                 # the swing high right before the lowest swing low of the fall
            lows = [k for k in range(base, len(sw)) if not sw[k][2]]
            if not lows:
                continue
            kmin = min(lows, key=lambda k: (sw[k][1], -k))
            q = kmin - 1
        else:
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
        while k - 2 >= 0 and sw[k][1] < sw[k - 2][1] - tol(k):
            dh += 1
            k -= 2
        dl, prev, k = 0, lf, q - 1
        while k >= 0 and prev < sw[k][1] - tol(k):
            dl += 1
            prev = sw[k][1]
            k -= 2
        d = min(dh, dl)
        if d >= 1:
            ev.append([i, hi, lvl, li, lf, d])
            if protected:
                base = len(sw)
    return ev


class Structure:
    """The structure of one candle series (see the module text). events[k] = [b, hi, lvl, li, lf, d]; `opts` = the options
    of the module text (none = the baseline)."""
    __slots__ = ('n', 'ph', 'phv', 'phc', 'pl', 'plv', 'plc', 'events', 'bs', 'st', 'sweep')

    def __init__(self, h, l, c, n=5, opts=None):
        self.n = n
        pts = swing_points(h, l, c, n, opts)
        ph, pl = pts['ph'], pts['pl']
        self.ph = array.array('i', ph)
        self.phv = array.array('d', [h[p] for p in ph])
        self.phc = array.array('i', pts['phc'])
        self.pl = array.array('i', pl)
        self.plv = array.array('d', [l[p] for p in pl])
        self.plc = array.array('i', pts['plc'])
        self.events = choch_events(h, l, c, n, opts=opts, pts=pts)
        self.bs = array.array('i', [e[0] for e in self.events])
        # sweeps: the final low went under the swing low before the CHoCH's swing high and closed back above it
        self.sweep = []
        for e in self.events:
            k = bisect.bisect_left(self.pl, e[1]) - 1
            self.sweep.append(bool(k >= 0 and l[e[3]] < self.plv[k] < c[e[3]]))
        self.st = {}                  # k -> [next candle to check for 'dead', dead, next candle for BOS, peak, next pivot, bos,
        #                                        next candle for the move high, the move high so far]

    def _state(self, k):
        s = self.st.get(k)
        if s is None:
            b = self.events[k][0]
            s = self.st[k] = [b + 1, -1, b + 1, None, bisect.bisect_right(self.ph, b), -1, self.events[k][3], None, -1]
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
        ph, phv, phc = self.ph, self.phv, self.phc
        j, peak, pj = s[2], s[3], s[4]
        while j < i and j < len(c):
            while pj < len(ph) and phc[pj] <= j:
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

    def move_high(self, k, h, i):
        """The highest high from CHoCH k's final low up to the candle BEFORE i (the top of the move a pullback into candle i
        retraces - known before candle i opens). Candles are asked for in time order (forward, remembered); an earlier
        candle than the last one asked is worked out from the start."""
        return self.move_high_at(k, h, i)[0]

    def move_high_at(self, k, h, i):
        """move_high + the candle it was made on (the first of equal highs): (price, candle) or (None, -1)."""
        s = self._state(k)
        j, mx, mi = s[6], s[7], s[8]
        if i < j:
            li = self.events[k][3]
            seg = h[li:i]
            if not len(seg):
                return None, -1
            m = max(seg)
            return m, li + list(seg).index(m)
        while j < i and j < len(h):
            v = h[j]
            if mx is None or v > mx:
                mx, mi = v, j
            j += 1
        s[6], s[7], s[8] = j, mx, mi
        return mx, mi

    def last_swing_high(self, i, above):
        """The most recent swing high confirmed by candle i (known on a candle <= i) at or above `above`: (candle, price)."""
        k = bisect.bisect_right(self.phc, i) - 1
        while k >= 0:
            if self.phv[k] >= above:
                return self.ph[k], self.phv[k]
            k -= 1
        return None

    def judge(self, i, zone_f, zone_top, price, c, down_n, max_age=0, h=None, zone_bottom=None, part='mid', fib=None):
        """A signal on candle i (zone formed on candle zone_f, top zone_top; no zone: zone_f / zone_top None and `price` =
        the signal candle's close) -> {'k': CHoCH index or -1, 'stage', 'after_low', 'leg', 'after', 'below', 'first',
        'age'}. stage: 'none' (no live CHoCH before it), 'old' (the zone formed before the final low), 'bos' (a BOS came
        before the signal), 'above' (zone / price at or above the CHoCH level), 'below' (zone under the CHoCH level).
        With the highs `h` also 'H' (the move high, move_high) and 'depth' = how far down the move the zone's `part`
        ('mid' / 'top' / 'bottom'; no zone: `price`) sits (see depth()) - the discount rule; with `fib` (e.g. 0.5) the
        stage says 'disc' (depth >= fib = the owner's discount zone, 11-Nov-2026) / 'prem' instead of 'below' / 'above'."""
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
               'below': (zone_top if zone_top is not None else price) < lvl,
               'lvl': lvl, 'ztop': zone_top if zone_top is not None else price}
        out['stage'] = 'old' if not out['after_low'] else 'bos' if not first else 'above' if not out['below'] else 'below'
        if zone_bottom is not None:
            out['zbot'] = zone_bottom
            out['zf'] = zone_f
        if h is not None:
            H, mh = self.move_high_at(k, h, i)
            out['H'], out['mh'] = H, mh
            out['depth'] = depth(H, lf, zone_part(zone_bottom, zone_top, part, price))
            if fib and out['stage'] in ('above', 'below'):
                out['stage'] = 'disc' if out['depth'] is not None and out['depth'] >= fib - 1e-9 else 'prem'
        return out


def last_swing_low(st, j, after):
    """The newest swing low known by candle j whose candle is at or after `after` -> its price, or None (a trail under the
    structure: only the swing lows made since the entry)."""
    k = bisect.bisect_right(st.plc, j) - 1
    return st.plv[k] if k >= 0 and st.pl[k] >= after else None


def zone_part(bottom, top, part, price):
    """The price of a zone that the discount rule judges: its middle (default) / top / bottom; no zone = `price`."""
    if top is None:
        return price
    if bottom is None or part == 'top':
        return top
    return bottom if part == 'bottom' else (bottom + top) / 2.0


def depth(hi, lo, price):
    """How far down the move from `lo` (the final low) to `hi` (the move high) `price` sits: 0 = at the high, 0.5 = the middle,
    1 = at the final low (> 1 under it) - the Fibonacci retracement level as TradingView draws it from the low to the high.
    None for a move without a range."""
    if hi is None or lo is None or not hi > lo:
        return None
    return (hi - price) / float(hi - lo)


def fib_line(hi, lo, level):
    """The price of the Fib `level` line of the move (0.5 = the middle)."""
    return hi - level * (hi - lo)


STAGES = ('disc', 'below', 'prem', 'above', 'bos', 'old', 'none')
STAGE_NAMES = {'none': 'No CHoCH before it', 'old': 'Zone older than the CHoCH low', 'bos': 'After a BOS (already moved)',
               'above': 'At / above the CHoCH level', 'below': 'Below the CHoCH level, first pullback',
               'disc': 'In the discount part of the move (under the Fib line), first pullback - your setup',
               'prem': 'In the premium part of the move (above the Fib line)'}
