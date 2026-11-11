# -*- coding: utf-8 -*-
"""The TradingView indicator's logic (tradingview/StockBlueprint_CHoCH_FVG.pine) in Python, bar by bar, the way Pine runs
it - only what was known at each bar's close, kept in the same few variables / arrays. tests/tradingview-pine.test.js runs
it on random and made charts and checks that it finds exactly what the laptop's backtest finds (structure.py's CHoCH
events, kite_intraday's FVG / Gap-up zones and their first touches, the Backtest Lab's discount rule). Change the .pine and
this file together.

Owner, 11-Nov-2026: "i have runned a backtest ... i open trading view chart and i go to that trade date. i check how our
backtest enter the trade, how our backtest where it is marked Choch, FVG. i do this with bare eyes. it would be helpful if
i got pinescript indicator to apply in trading view chart."
"""

GAP_MIN, GAP_MAX, INSIDE_BODY, FVG_K, LOCK_PCT, ZONES_KEPT = 3.0, 5.0, 2.0, 0.70, 0.05, 300


def locked(h, l):
    return l > 0 and (h - l) / l * 100 <= LOCK_PCT


class Model:
    """Feed it candles with bar(o, h, l, c); read .events (every CHoCH with d >= 1: [b, hi, lvl, li, lf, d]), .setups
    ([i, f, bottom, top, kind, inside, depth] - the first touch of a zone that passed the rules), .bos {b: bar}."""

    def __init__(self, n=5, down_n=3, zone_when='both', first_pull=True, fib=0.5, part='mid', below_choch=False):
        self.n, self.down_n, self.zone_when, self.first_pull = n, down_n, zone_when, first_pull
        self.fib, self.part, self.below_choch = fib, part, below_choch
        self.o, self.h, self.l, self.c = [], [], [], []
        self.swP, self.swV, self.swH = [], [], []
        self.last_used_hi = -1
        self.seg_hi, self.seg_min, self.seg_min_bar = -1, None, -1
        self.chB = -1                                   # the current CHoCH (the latest with d >= down_n)
        self.chHi = self.chLi = -1
        self.chLvl = self.chLf = self.chH = self.chPeak = None
        self.chD, self.chDead, self.chBos = 0, True, -1
        self.zF, self.zBot, self.zTop, self.zGap, self.zIn = [], [], [], [], []
        self.gap_any, self.gap_pct = [], []             # the series Pine keeps for "the bar before"
        self.events, self.setups, self.bos = [], [], {}

    # ---- the helpers Pine computes on every bar
    def _pivot_high(self, i):
        n, h = self.n, self.h
        if i < 2 * n:
            return False
        x = h[i - n]
        return all(x > h[i - n - k] and x >= h[i - n + k] for k in range(1, n + 1))

    def _pivot_low(self, i):
        n, l = self.n, self.l
        if i < 2 * n:
            return False
        y = l[i - n]
        return all(y < l[i - n - k] and y <= l[i - n + k] for k in range(1, n + 1))

    def bar(self, o, h, l, c):
        self.o.append(o); self.h.append(h); self.l.append(l); self.c.append(c)
        i = len(self.c) - 1
        H, L, C, O = self.h, self.l, self.c, self.o
        n = self.n
        ph, pl = self._pivot_high(i), self._pivot_low(i)
        lock_now = locked(h, l)
        lock_prev = i >= 1 and locked(H[i - 1], L[i - 1])
        gap_any = i >= 1 and not lock_now and not lock_prev and H[i - 1] > 0 and l > H[i - 1]
        gap_pct = (l - H[i - 1]) / H[i - 1] * 100 if gap_any else None
        self.gap_any.append(gap_any); self.gap_pct.append(gap_pct)

        # 1. a close under the final low kills the CHoCH (this bar too)
        alive = self.chB >= 0 and not self.chDead and self.chB < i
        if alive and c < self.chLf:
            self.chDead = True
            alive = False

        # 2. the zones this bar touches for the first time (low <= top; a Gap-up zone not on a circuit-locked candle)
        hit, best = [], -1
        for k in range(len(self.zF)):
            if l <= self.zTop[k] and (not self.zGap[k] or not lock_now):
                hit.append(k)
                if alive and self._passes(k, i):
                    if best < 0 or self._before(k, best):
                        best = k
        if best >= 0:
            f, bot, top = self.zF[best], self.zBot[best], self.zTop[best]
            self.setups.append([i, f, bot, top, 'Gap-up' if self.zGap[best] else 'FVG', self.zIn[best], self._depth(bot, top)])
        for k in reversed(hit):
            for a in (self.zF, self.zBot, self.zTop, self.zGap, self.zIn):
                a.pop(k)

        # 3. BOS: a pivot high confirmed now (after the CHoCH candle) raises the peak; a close above the peak = BOS
        if self.chB >= 0 and not self.chDead and self.chBos < 0 and i > self.chB:
            p = i - n
            if ph and p > self.chB and (self.chPeak is None or H[p] > self.chPeak):
                self.chPeak = H[p]
            if self.chPeak is not None and c > self.chPeak:
                self.chBos = i
                self.bos[self.chB] = i

        # 4. the move's high (for the next bars' discount)
        if self.chB >= 0 and not self.chDead and i > self.chB:
            self.chH = max(self.chH, h)

        # 5. new zones: a 3-candle FVG on this bar; a Gap-up zone 3 - 5 % on this bar; the bar before's gap inside an FVG
        #    (two big green candles, judged now that its next candle closed)
        if i >= 13:
            avg = sum(H[k] - L[k] for k in range(i - 13, i + 1)) / 14.0
            if l > H[i - 2] and (l - H[i - 2]) >= FVG_K * avg:
                self._add(i, H[i - 2], l, False, False)
        if gap_any and GAP_MIN <= gap_pct <= GAP_MAX:
            self._add(i, H[i - 1], l, True, False)
        if i >= 3 and self.gap_any[i - 1] and self.gap_pct[i - 1] <= GAP_MAX:
            big = lambda k: O[k] > 0 and C[k] > O[k] and (C[k] - O[k]) / O[k] * 100 >= INSIDE_BODY
            if big(i - 2) and big(i - 1) and L[i - 1] > H[i - 2] and H[i - 3] < H[i - 2] and l > L[i - 1]:
                if self.gap_pct[i - 1] >= GAP_MIN:
                    for k in range(len(self.zF)):
                        if self.zF[k] == i - 1 and self.zGap[k]:
                            self.zIn[k] = True
                else:
                    self._add(i - 1, H[i - 2], L[i - 1], True, True)
        while len(self.zF) > ZONES_KEPT:                   # the oldest untouched zones go (Pine keeps 300)
            for a in (self.zF, self.zBot, self.zTop, self.zGap, self.zIn):
                a.pop(0)

        # 6. swings (confirmed n bars later, alternating) and the CHoCH (a close above the last swing high)
        p = i - n
        if p >= n and ph != pl:
            v = H[p] if ph else L[p]
            if self.swP and self.swH[-1] == ph:
                if (ph and v > self.swV[-1]) or (not ph and v < self.swV[-1]):
                    self.swP[-1], self.swV[-1] = p, v
            else:
                self.swP.append(p); self.swV.append(v); self.swH.append(ph)
        if self.swP:
            q = len(self.swP) - 1 if self.swH[-1] else len(self.swP) - 2
            if q >= 0:
                hi, lvl = self.swP[q], self.swV[q]
                if hi != self.seg_hi:
                    assert i - hi == n, 'the swing high changes only when one is confirmed (n bars back)'
                    self.seg_hi, self.seg_min, self.seg_min_bar = hi, None, -1
                    for k in range(hi + 1, i + 1):          # Pine: the n bars, oldest first
                        if self.seg_min is None or L[k] < self.seg_min:
                            self.seg_min, self.seg_min_bar = L[k], k
                elif l < self.seg_min:
                    self.seg_min, self.seg_min_bar = l, i
                if c > lvl and hi > self.last_used_hi:
                    self.last_used_hi = hi
                    dh, k = 0, q
                    while k - 2 >= 0 and self.swV[k] < self.swV[k - 2]:
                        dh += 1
                        k -= 2
                    dl, prev, k = 0, self.seg_min, q - 1
                    while k >= 0 and prev < self.swV[k]:
                        dl += 1
                        prev = self.swV[k]
                        k -= 2
                    d = min(dh, dl)
                    if d >= 1:
                        self.events.append([i, hi, lvl, self.seg_min_bar, self.seg_min, d])
                    if d >= self.down_n:
                        self.chB, self.chHi, self.chLvl, self.chLi, self.chLf, self.chD = i, hi, lvl, self.seg_min_bar, self.seg_min, d
                        self.chDead, self.chBos, self.chPeak = False, -1, None
                        self.chH = max(H[self.chLi:i + 1])

    def _add(self, f, bot, top, gap, inside):
        self.zF.append(f); self.zBot.append(bot); self.zTop.append(top); self.zGap.append(gap); self.zIn.append(inside)

    def _before(self, a, b):
        """Zone a comes before zone b on one bar: the higher top (a falling price reaches it first), FVG first, older."""
        ka = (-self.zTop[a], self.zGap[a], self.zF[a])
        kb = (-self.zTop[b], self.zGap[b], self.zF[b])
        return ka < kb

    def _depth(self, bot, top):
        part = (bot + top) / 2.0 if self.part == 'mid' else top if self.part == 'top' else bot
        return (self.chH - part) / (self.chH - self.chLf) if self.chH > self.chLf else None

    def _passes(self, k, i):
        f = self.zF[k]
        if f < self.chLi:
            return False
        if self.zone_when == 'leg' and f > self.chB + 1:
            return False
        if self.zone_when == 'after' and f <= self.chB:
            return False
        if self.first_pull and self.chBos >= 0:
            return False
        if self.below_choch and not self.zTop[k] < self.chLvl:
            return False
        if self.fib:
            dep = self._depth(self.zBot[k], self.zTop[k])
            if dep is None or dep < self.fib - 1e-9:
                return False
        return True
