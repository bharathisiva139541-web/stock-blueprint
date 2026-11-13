# -*- coding: utf-8 -*-
"""The TradingView indicator's logic (tradingview/StockBlueprint_CHoCH_FVG.pine) in Python, bar by bar, the way Pine runs
it - only what was known at each bar's close, kept in the same few variables / arrays. tests/tradingview-pine.test.js runs
it on random and made charts and checks that it finds exactly what the laptop finds: structure.py's CHoCH events and the
Backtest Lab's trades (group 'First touch of a zone' - signal candle, entry, stop, target) for the same rules. Change the
.pine and this file together.

Owner, 11-Nov-2026: "i open trading view chart and i go to that trade date. i check how our backtest enter the trade, how
our backtest where it is marked Choch, FVG ... it would be helpful if i got pinescript indicator"; then "give option to copy
the pinescript in this page that works with respect to the current setup" (the Lab page fills the .pine's inputs from its
form - web/lib/pine.js).

The rules come as the Lab's own params (backtest_lab.clean_params): structure ('only' = the market-structure rules),
pivotN, downN, zoneWhen, chochAge, discount, discPart, firstPull, belowChoch, entry ('zone' / 'close'), stop, stopBuf,
stopPct, maxRisk, minPrice, targetMode, targetR, swingMinR, from / to, minTurnover, emaSupport, emaTouch, above10 / 21 / 50,
emaStack - and (owner, 12-Nov-2026: "புதிய structure options-ஐயும் (protected, equal highs, ZigZag) TradingView script வரையும்படி
மாற்றுவது") the structure engine's options of structure.py: swingMode 'zigzag' + zzAtr (ATR ZigZag swings, known when price
turned zzAtr x ATR), swingAtr (a candles-each-side swing must stand out by x ATR), chochMode 'protected' (the CHoCH breaks the
swing high before the lowest swing low since the last CHoCH), eqAtr (highs / lows within x ATR of the one before are not lower).
"""
from datetime import date

GAP_MIN, GAP_MAX, INSIDE_BODY, FVG_K, LOCK_PCT, ZONES_KEPT = 3.0, 5.0, 2.0, 0.70, 0.05, 300
MIT_MAX = 2                                             # = backtest_lab.MIT_MAX
LINK_SPAN = 3          # = kite_intraday.ZONE_LINK_SPAN: a Gap-up zone inside an FVG zone formed at most this many candles apart


def locked(h, l):
    return l > 0 and (h - l) / l * 100 <= LOCK_PCT


def _ord(iso):
    return date.fromisoformat(iso).toordinal() if iso else None


class Model:
    """Feed it candles with bar(o, h, l, c, v, day_ordinal); read .events (every CHoCH with d >= 1: [b, hi, lvl, li, lf, d]),
    .buys ([i, f, bottom, top, kind, inside, entry, stop, target]) and .bos {CHoCH candle: BOS candle}."""

    def __init__(self, P):
        self.P = P
        self.n, self.down_n = P['pivotN'], P['downN']
        self.struct_only = P['structure'] == 'only'
        self.zz = P.get('swingMode') == 'zigzag'
        self.zz_k = float(P.get('zzAtr') or 2.0)
        self.prom = 0.0 if self.zz else float(P.get('swingAtr') or 0)
        self.prot = P.get('chochMode') == 'protected'
        self.eq = float(P.get('eqAtr') or 0)
        self.o, self.h, self.l, self.c, self.v, self.day = [], [], [], [], [], []
        self.tr, self.tr_tot, self.atr = [], 0.0, []    # ATR(14) like structure.atr_series
        self.zd, self.zhi, self.zlo = 0, 0, 0           # the ZigZag's state (structure.zigzag, bar by bar)
        self.swP, self.swV, self.swH, self.swA = [], [], [], []   # + the ATR at each swing's candle (equal highs / lows)
        self.sw_base = 0                                # protected: the swings after the last CHoCH
        self.phV = []                                   # the swing highs known so far (the swing-high target)
        self.last_used_hi = -1
        self.seg_hi, self.seg_min, self.seg_min_bar = -1, None, -1
        self.chB = -1                                   # the current CHoCH (the latest with d >= down_n)
        self.chHi = self.chLi = -1
        self.chLvl = self.chLf = self.chH = self.chPeak = None
        self.chHBar = -1                                # the move high's candle (the first of equal highs)
        self.chD, self.chDead, self.chBos = 0, True, -1
        self.zF, self.zBot, self.zTop, self.zGap, self.zIn = [], [], [], [], []
        # the Gap-up zone inside an FVG (12-Nov-2026, Lab gapEntry): an FVG zone's 'has a Gap-up zone inside' / a Gap-up zone's
        # widest FVG around it (bottom, candle); recent = the zones of the last LINK_SPAN candles, touched or not
        self.zInner, self.zOutB, self.zOutF = [], [], []
        self.recent = []
        self.gap_entry = P.get('gapEntry', True)
        self.gap_any, self.gap_pct = [], []             # the series Pine keeps for "the bar before"
        self.e = {10: None, 21: None, 50: None}
        self.cv = []                                    # close x volume (the turnover)
        self.lo, self.hi = _ord(P.get('from')), _ord(P.get('to'))
        self.events, self.buys, self.bos = [], [], {}
        # the 2nd-zone rule (12-Nov-2026, the Lab's zonePick): the zones price has touched (f, bottom, top), newest last
        self.second = self.struct_only and P.get('zonePick', 'second') == 'second'
        self.tz = []                                    # (f, bottom, top, gap, inside, inner, outer bottom, outer candle)
        # touchAgain (13-Nov-2026): a zone touched on / before the CHoCH candle comes back on the list at the CHoCH
        self.again = self.struct_only and P.get('touchAgain', True)

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

    def _ema_ok(self, i, h, l, c):
        P, e = self.P, self.e
        sup_n = int(P['emaSupport'])
        need = set()
        if sup_n:
            need.update((10, 21, 50) if sup_n == 1 else (sup_n,))
        need.update(k for k in (10, 21, 50) if P['above%d' % k])
        if P['emaStack']:
            need.update((10, 21, 50))
        if not need:
            return True
        if i < max(need):
            return False
        t = 1 + P['emaTouch'] / 100.0
        sup = {k: l <= e[k] * t and c >= e[k] for k in (10, 21, 50)}
        if sup_n and not any(sup[k] for k in ((10, 21, 50) if sup_n == 1 else (sup_n,))):
            return False
        if any(P['above%d' % k] and not c > e[k] for k in (10, 21, 50)):
            return False
        if P['emaStack'] and not e[10] > e[21] > e[50]:
            return False
        return True

    def _turnover(self, i):
        a = max(0, i + 1 - 20)
        return round(sum(self.cv[a:i + 1]) / (i + 1 - a) / 1e5, 1)

    def _atr_bar(self, i):
        H, L, C = self.h, self.l, self.c
        t = H[i] - L[i] if i == 0 else max(H[i] - L[i], abs(H[i] - C[i - 1]), abs(L[i] - C[i - 1]))
        self.tr.append(t)
        self.tr_tot += t
        if i >= 14:
            self.tr_tot -= self.tr[i - 14]
        self.atr.append(self.tr_tot / min(i + 1, 14))

    def _zigzag(self, i):
        """structure.zigzag on bar i -> (pivot candle, is_high) when a swing is confirmed now, else None."""
        H, L = self.h, self.l
        if i == 0:
            return None
        a = self.zz_k * self.atr[i]
        if self.zd >= 0 and H[i] > H[self.zhi]:
            self.zhi = i
        if self.zd <= 0 and L[i] < L[self.zlo]:
            self.zlo = i
        if self.zd >= 0 and self.zhi < i and H[self.zhi] - L[i] >= a and (self.zd == 1 or self.zhi >= self.zlo):
            self.zd = -1
            lo = i                                       # the lowest low after the high (the latest of equal ones)
            for x in range(i - 1, self.zhi, -1):
                if L[x] < L[lo]:
                    lo = x
            self.zlo = lo
            return self.zhi, True
        if self.zd <= 0 and self.zlo < i and H[i] - L[self.zlo] >= a and (self.zd == -1 or self.zlo > self.zhi):
            self.zd = 1
            hi = i
            for x in range(i - 1, self.zlo, -1):
                if H[x] > H[hi]:
                    hi = x
            self.zhi = hi
            return self.zlo, False
        return None

    def bar(self, o, h, l, c, v=0, day=None):
        self.o.append(o); self.h.append(h); self.l.append(l); self.c.append(c); self.v.append(v); self.day.append(day)
        self.cv.append(c * v)
        i = len(self.c) - 1
        H, L, C, O = self.h, self.l, self.c, self.o
        n, P = self.n, self.P
        self._atr_bar(i)
        # the swings: n candles each side (+ standing out by x ATR) or the ATR ZigZag - `new_sw` = (pivot, is_high) confirmed
        # now; `new_hi` = a swing high known now (the swing-high target and the BOS)
        new_sw = new_hi = None
        ph = pl = False
        if self.zz:
            new_sw = self._zigzag(i)
            if new_sw and new_sw[1]:
                new_hi = new_sw[0]
        else:
            ph, pl = self._pivot_high(i), self._pivot_low(i)
            if self.prom and ph and not H[i - n] - min(L[i - 2 * n:i + 1]) >= self.prom * self.atr[i - n]:
                ph = False
            if self.prom and pl and not max(H[i - 2 * n:i + 1]) - L[i - n] >= self.prom * self.atr[i - n]:
                pl = False
            if ph != pl:
                new_sw = (i - n, ph)
            if ph:
                new_hi = i - n
        if new_hi is not None:
            self.phV.append(H[new_hi])
        for k in (10, 21, 50):
            self.e[k] = c if self.e[k] is None else self.e[k] + 2.0 / (k + 1) * (c - self.e[k])
        ema_ok = self._ema_ok(i, h, l, c)
        turn_ok = not P['minTurnover'] or self._turnover(i) >= P['minTurnover']
        date_ok = (self.lo is None or day >= self.lo) and (self.hi is None or day <= self.hi)
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
        alive_ok = alive and (not P['chochAge'] or i - self.chB <= P['chochAge'])

        # 1b. the bar before's gap between two big green candles (inside FVG - judged now that this bar closed). Added before the
        #     touches (12-Nov-2026: the FVG around it knows it then, like kite_intraday's zones); this bar cannot touch it (its low
        #     is over the gap's top)
        self.recent = [x for x in self.recent if x[0] >= i - LINK_SPAN - 2]
        if i >= 3 and self.gap_any[i - 1] and self.gap_pct[i - 1] <= GAP_MAX:
            big = lambda k: O[k] > 0 and C[k] > O[k] and (C[k] - O[k]) / O[k] * 100 >= INSIDE_BODY
            if big(i - 2) and big(i - 1) and L[i - 1] > H[i - 2] and H[i - 3] < H[i - 2] and l > L[i - 1]:
                if self.gap_pct[i - 1] >= GAP_MIN:
                    for k in range(len(self.zF)):
                        if self.zF[k] == i - 1 and self.zGap[k]:
                            self.zIn[k] = True
                else:
                    self._add(i - 1, H[i - 2], L[i - 1], True, True)

        # 2. the zones this bar touches for the first time (low <= top; a Gap-up zone not on a circuit-locked candle); the
        #    first one (highest top, FVG first, older) that passes every rule = the BUY
        hit = [k for k in range(len(self.zF)) if l <= self.zTop[k] and (not self.zGap[k] or not lock_now)]
        best, bvals = -1, None
        for k in hit:
            if self.gap_entry and not self.zGap[k] and self.zInner[k]:
                continue                                 # the order waits at the Gap-up zone inside this FVG
            if self.struct_only and not (alive_ok and self._passes(k)):
                continue
            if self.second and self._rank(k, i, hit):
                continue                                 # the 1st of two discount zones (watched) / a 3rd / a touched 1st zone
            if self.struct_only and self._mit_fail(self.zF[k], self.zBot[k], self.zTop[k]):
                continue                                 # more than 2 candles in it / a close under its middle before the move high
            if not (date_ok and turn_ok and ema_ok):
                continue
            t = self._trade(k, i, o, l, c, alive_ok)
            if t is None:
                continue
            if best < 0 or self._before(k, best):
                best, bvals = k, t
        if best >= 0:
            self.buys.append([i, self.zF[best], self.zBot[best], self.zTop[best], 'Gap-up' if self.zGap[best] else 'FVG',
                              self.zIn[best]] + list(bvals))
        for k in hit:
            self.tz.append((self.zF[k], self.zBot[k], self.zTop[k], self.zGap[k], self.zIn[k], self.zInner[k], self.zOutB[k], self.zOutF[k]))
        del self.tz[:-ZONES_KEPT]
        for k in reversed(hit):
            for a in (self.zF, self.zBot, self.zTop, self.zGap, self.zIn, self.zInner, self.zOutB, self.zOutF):
                a.pop(k)

        # 3. BOS: a pivot high confirmed now (after the CHoCH candle) raises the peak; a close above the peak = BOS
        if self.chB >= 0 and not self.chDead and self.chBos < 0 and i > self.chB:
            p = new_hi
            if p is not None and p > self.chB and (self.chPeak is None or H[p] > self.chPeak):
                self.chPeak = H[p]
            if self.chPeak is not None and c > self.chPeak:
                self.chBos = i
                self.bos[self.chB] = i

        # 4. the move's high (for the next bars' discount)
        if self.chB >= 0 and not self.chDead and i > self.chB:
            if h > self.chH:
                self.chH, self.chHBar = h, i

        # 5. new zones: a 3-candle FVG on this bar; a Gap-up zone 3 - 5 % on this bar (the inside-FVG gap: 1b)
        if i >= 13:
            avg = sum(H[k] - L[k] for k in range(i - 13, i + 1)) / 14.0
            if l > H[i - 2] and (l - H[i - 2]) >= FVG_K * avg:
                self._add(i, H[i - 2], l, False, False)
        if gap_any and GAP_MIN <= gap_pct <= GAP_MAX:
            self._add(i, H[i - 1], l, True, False)
        while len(self.zF) > ZONES_KEPT:                   # the oldest untouched zones go (Pine keeps 300)
            for a in (self.zF, self.zBot, self.zTop, self.zGap, self.zIn, self.zInner, self.zOutB, self.zOutF):
                a.pop(0)

        # 6. swings (confirmed later, alternating) and the CHoCH (a close above the last swing high - or the protected one)
        if new_sw:
            p, is_h = new_sw
            v_ = H[p] if is_h else L[p]
            if self.swP and self.swH[-1] == is_h:
                if (is_h and v_ > self.swV[-1]) or (not is_h and v_ < self.swV[-1]):
                    self.swP[-1], self.swV[-1], self.swA[-1] = p, v_, self.atr[p]
            else:
                self.swP.append(p); self.swV.append(v_); self.swH.append(is_h); self.swA.append(self.atr[p])
        if self.swP:
            if self.prot:                 # the swing high right before the lowest swing low since the last CHoCH (the latest of equal ones)
                kmin = -1
                for k in range(self.sw_base, len(self.swP)):
                    if not self.swH[k] and (kmin < 0 or self.swV[k] <= self.swV[kmin]):
                        kmin = k
                q = kmin - 1 if kmin >= 0 else -1
            else:
                q = len(self.swP) - 1 if self.swH[-1] else len(self.swP) - 2
            if q >= 0:
                hi_, lvl = self.swP[q], self.swV[q]
                if hi_ != self.seg_hi:
                    self.seg_hi, self.seg_min, self.seg_min_bar = hi_, None, -1
                    for k in range(hi_ + 1, i + 1):          # Pine: the n bars, oldest first
                        if self.seg_min is None or L[k] < self.seg_min:
                            self.seg_min, self.seg_min_bar = L[k], k
                elif l < self.seg_min:
                    self.seg_min, self.seg_min_bar = l, i
                if c > lvl and hi_ > self.last_used_hi:
                    self.last_used_hi = hi_
                    eq, A = self.eq, self.swA
                    dh, k = 0, q
                    while k - 2 >= 0 and self.swV[k] < self.swV[k - 2] - eq * A[k]:
                        dh += 1
                        k -= 2
                    dl, prev, k = 0, self.seg_min, q - 1
                    while k >= 0 and prev < self.swV[k] - eq * A[k]:
                        dl += 1
                        prev = self.swV[k]
                        k -= 2
                    d = min(dh, dl)
                    if d >= 1:
                        self.events.append([i, hi_, lvl, self.seg_min_bar, self.seg_min, d])
                        if self.prot:
                            self.sw_base = len(self.swP)
                    if d >= self.down_n:
                        self.chB, self.chHi, self.chLvl, self.chLi, self.chLf, self.chD = i, hi_, lvl, self.seg_min_bar, self.seg_min, d
                        self.chDead, self.chBos, self.chPeak = False, -1, None
                        seg = H[self.chLi:i + 1]
                        self.chH = max(seg)
                        self.chHBar = self.chLi + seg.index(self.chH)
                        if self.again:          # the zones of this move touched before now that held: back on the list
                            keep = []
                            for z in self.tz:
                                if z[0] >= self.chLi and min(C[z[0] + 1:i + 1]) >= z[1]:
                                    for a, v in zip((self.zF, self.zBot, self.zTop, self.zGap, self.zIn, self.zInner, self.zOutB, self.zOutF), z):
                                        a.append(v)
                                else:
                                    keep.append(z)
                            self.tz = keep

    def _add(self, f, bot, top, gap, inside):
        self.zF.append(f); self.zBot.append(bot); self.zTop.append(top); self.zGap.append(gap); self.zIn.append(inside)
        self.zInner.append(False); self.zOutB.append(None); self.zOutF.append(-1)
        me = len(self.zF) - 1
        # link with the zones of the same move (kite_intraday.link_zones): a Gap-up zone wholly inside an FVG zone
        for (rf, rgap, rbot, rtop) in self.recent:
            if rgap == gap or abs(rf - f) > LINK_SPAN:
                continue
            if gap:
                inner, outer = (bot, top), (rbot, rtop)
            else:
                inner, outer = (rbot, rtop), (bot, top)
            if not (inner[0] >= outer[0] - 1e-9 and inner[1] <= outer[1] + 1e-9):
                continue
            if gap:                                  # this Gap-up zone: the FVG around it; that FVG (if untouched): has one inside
                self._outer(me, rbot, rf)
                k = self._find(rf, False)
                if k >= 0:
                    self.zInner[k] = True
            else:                                    # this FVG: has one inside; that Gap-up zone (if untouched): this FVG around it
                self.zInner[me] = True
                k = self._find(rf, True)
                if k >= 0:
                    self._outer(k, bot, f)
        self.recent.append((f, gap, bot, top))

    def _find(self, f, gap):
        for k in range(len(self.zF)):
            if self.zF[k] == f and self.zGap[k] == gap:
                return k
        return -1

    def _outer(self, k, bot, f):
        if self.zOutB[k] is None or (bot, f) < (self.zOutB[k], self.zOutF[k]):
            self.zOutB[k], self.zOutF[k] = bot, f

    def _before(self, a, b):
        """Zone a comes before zone b on one bar: the higher top (a falling price reaches it first), FVG first, older."""
        return (-self.zTop[a], self.zGap[a], self.zF[a]) < (-self.zTop[b], self.zGap[b], self.zF[b])

    def _depth(self, bot, top):
        part = self.P['discPart']
        x = (bot + top) / 2.0 if part == 'mid' else top if part == 'top' else bot
        return (self.chH - x) / (self.chH - self.chLf) if self.chH > self.chLf else None

    def _rank(self, k, i, hit):
        """backtest_lab.zone_rank on this bar: 'zone1' (an untouched discount zone waits under it - this one only watched) /
        'zone3' (two areas above already) / ''."""
        kb, kt = self.zBot[k], self.zTop[k]
        above = [(b, t, f) for f, b, t in [x[:3] for x in self.tz] + [(self.zF[j], self.zBot[j], self.zTop[j]) for j in hit if j != k]
                 if self.chLi <= f < i and b >= kt - 1e-9 and self._passes_z(f, b, t)]
        areas = []
        for b, t, f in sorted(above):
            if areas and b <= areas[-1][1] + 1e-9:
                a = areas[-1]
                areas[-1] = (a[0], max(a[1], t), min(a[2], f))
            else:
                areas.append((b, t, f))
        if len(areas) >= 2:
            return 'zone3'
        if len(areas) == 1 and self._touches(areas[0][2], areas[0][1])[0] > 0:
            return 'zone1mit'                            # the 1st zone was touched before the move high (13-Nov-2026)
        if not areas and any(j != k and self.chLi <= self.zF[j] < i and self.zTop[j] <= kb + 1e-9 and
                              self._passes_z(self.zF[j], self.zBot[j], self.zTop[j]) for j in range(len(self.zF))):
            return 'zone1'
        return ''

    def _touches(self, f, top, bot=None):
        """backtest_lab.zone_mitigation up to the move high: (candles f+1 .. chHBar touching the zone, a close under its middle)."""
        n, deep, mid = 0, False, (bot + top) / 2.0 if bot is not None else None
        for j in range(f + 1, self.chHBar + 1):
            if self.l[j] <= top + 1e-9:
                n += 1
                if mid is not None and self.c[j] < mid - 1e-9:
                    deep = True
        return n, deep

    def _mit_fail(self, f, bot, top):
        n, deep = self._touches(f, top, bot)
        return deep or n > MIT_MAX

    def _passes(self, k):
        return self._passes_z(self.zF[k], self.zBot[k], self.zTop[k])

    def _passes_z(self, f, bot, top):
        P = self.P
        if f < self.chLi:
            return False
        if P['zoneWhen'] == 'leg' and f > self.chB + 1:
            return False
        if P['zoneWhen'] == 'after' and f <= self.chB:
            return False
        if P['firstPull'] and self.chBos >= 0:
            return False
        if bot >= self.chLvl - 1e-9:                     # wholly above the CHoCH level (13-Nov-2026)
            return False
        if f > self.chHBar:                               # not formed in the swing final low -> move high (13-Nov-2026)
            return False
        if P['belowChoch'] and not top < self.chLvl:
            return False
        if P['discount']:
            dep = self._depth(bot, top)
            if dep is None or dep < P['discount'] - 1e-9:
                return False
        return True

    def _trade(self, k, i, o, l, c, alive_ok=True):
        """(entry, stop, target) of zone k's touch on bar i, or None when the Lab would skip it (gap / risk / price / no
        swing high above)."""
        P = self.P
        at_top = P['entry'] == 'zone'
        entry = min(o, self.zTop[k]) if at_top else c
        mode = P['stop']
        if at_top and mode in ('spring', 'lower'):
            mode = 'zone'
        zb = self.zBot[k]
        if self.gap_entry and self.zGap[k] and self.zOutB[k] is not None:
            zb = self.zOutB[k]                           # a Gap-up zone inside an FVG: the stop under the FVG's bottom
        if mode == 'pct':
            stop = entry * (1 - P['stopPct'] / 100.0)
        elif mode == 'final':                            # under the CHoCH's final low (12-Nov-2026); no live CHoCH = no trade
            if not alive_ok:
                return None
            stop = self.chLf * (1 - P['stopBuf'] / 100.0)
        else:
            base = l if mode == 'spring' else zb if mode == 'zone' else min(l, zb)
            stop = base * (1 - P['stopBuf'] / 100.0)
        risk = entry - stop
        if not (entry > 0 and risk > 0):
            return None
        if P['maxRisk'] and risk / entry * 100 > P['maxRisk']:
            return None
        if entry < P['minPrice']:
            return None
        target = entry + P['targetR'] * risk
        if P['targetMode'] == 'swing':
            above = entry + P['swingMinR'] * risk
            sw = next((self.phV[j] for j in range(len(self.phV) - 1, -1, -1) if self.phV[j] >= above), None)
            if sw is None:
                return None
            target = sw
        return entry, stop, target
