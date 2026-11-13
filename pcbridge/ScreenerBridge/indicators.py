# -*- coding: utf-8 -*-
"""Shared candle maths for the pattern engine (owner, 13-Nov-2026, the bullish pattern engine plan - docs/PATTERN_ENGINE_PLAN.md):
one place for the definitions every detector uses, so two patterns never measure "a body" or "ATR" differently.

Standard library only (the laptop has no numpy). Every series function takes plain lists (oldest first) and returns a list
of the same length with None where the value is not known yet - it uses only that candle and the ones before it (no
centred windows, nothing from later candles), so a value never changes when newer candles arrive.

Definitions (master prompt section 4):
  range = high - low, body = |close - open|, upper shadow = high - max(open, close), lower shadow = min(open, close) - low;
  ratios divide by max(range, tick) so a zero-range candle never divides by zero; CLV = (2 close - high - low) / max(range, tick).
  True range = max(high - low, |high - previous close|, |low - previous close|) (the first candle: high - low).
  Wilder smoothing (RMA): the first value = the simple mean of the first n inputs, then (previous x (n - 1) + input) / n.
  ATR = Wilder smoothing of the true range. RSI = 100 - 100 / (1 + Wilder avg gain / Wilder avg loss) on close changes.
  EMA: k = 2 / (n + 1), seeded with the simple mean of the first n values (the Lab's older ema_series seeds with the first
  close - kept there unchanged; new detectors use this one).
"""

TICK = 0.01          # NSE equity tick: the floor of a candle's range in ratios


def anatomy(o, h, l, c, tick=TICK):
    """One candle -> dict range, body, upper, lower (shadows), bodyR, upperR, lowerR (shares of the range), clv, green, red."""
    rng = h - l
    den = rng if rng > tick else tick
    top, bot = (c, o) if c >= o else (o, c)
    body = top - bot
    up = h - top
    lo = bot - l
    return {'range': rng, 'body': body, 'upper': up, 'lower': lo, 'bodyR': body / den, 'upperR': up / den,
            'lowerR': lo / den, 'clv': (2 * c - h - l) / den, 'green': c > o, 'red': c < o}


def true_range(h, l, c):
    out = []
    for i in range(len(h)):
        if i == 0:
            out.append(h[0] - l[0])
        else:
            pc = c[i - 1]
            out.append(max(h[i] - l[i], abs(h[i] - pc), abs(l[i] - pc)))
    return out


def sma(values, n):
    """Simple mean of the last n values (None before n values exist; a None inside the window gives None)."""
    out, tot, bad = [], 0.0, 0
    for i, v in enumerate(values):
        if v is None:
            bad += 1
        else:
            tot += v
        if i >= n:
            old = values[i - n]
            if old is None:
                bad -= 1
            else:
                tot -= old
        out.append(tot / n if i >= n - 1 and not bad else None)
    return out


def ema(values, n):
    """EMA, k = 2 / (n + 1), seeded with the simple mean of the first n values (None before)."""
    out, k, prev, acc = [], 2.0 / (n + 1), None, 0.0
    for i, v in enumerate(values):
        if prev is None:
            acc += v
            if i == n - 1:
                prev = acc / n
            out.append(prev)
        else:
            prev = prev + k * (v - prev)
            out.append(prev)
    return out


def wilder(values, n):
    """Wilder smoothing (RMA) - the simple mean of the first n values, then (prev x (n - 1) + x) / n. None before n."""
    out, prev, acc = [], None, 0.0
    for i, v in enumerate(values):
        if prev is None:
            acc += v
            if i == n - 1:
                prev = acc / n
            out.append(prev)
        else:
            prev = (prev * (n - 1) + v) / n
            out.append(prev)
    return out


def atr(h, l, c, n=14):
    """Wilder ATR(n) (None for the first n - 1 candles)."""
    return wilder(true_range(h, l, c), n)


def rsi(c, n=14):
    """Wilder RSI(n) on closes: None until n changes exist (candle n); 100 when there was no loss, 50 when no move at all."""
    N = len(c)
    out = [None] * N
    if N <= n:
        return out
    g = s = 0.0
    for i in range(1, n + 1):
        d = c[i] - c[i - 1]
        if d > 0:
            g += d
        else:
            s -= d
    g /= n
    s /= n
    out[n] = _rsi_of(g, s)
    for i in range(n + 1, N):
        d = c[i] - c[i - 1]
        g = (g * (n - 1) + (d if d > 0 else 0.0)) / n
        s = (s * (n - 1) + (-d if d < 0 else 0.0)) / n
        out[i] = _rsi_of(g, s)
    return out


def _rsi_of(g, s):
    if s == 0:
        return 50.0 if g == 0 else 100.0
    return 100.0 - 100.0 / (1.0 + g / s)


def prior_high(h, n):
    """out[i] = the highest high of the n candles BEFORE candle i (i - n .. i - 1); None while fewer than n exist.
    n = 0: every candle before i (None at i = 0) - the high since the data starts."""
    N = len(h)
    out = [None] * N
    if n <= 0:
        m = None
        for i in range(N):
            out[i] = m
            m = h[i] if m is None or h[i] > m else m
        return out
    dq = []          # candle indexes, highs decreasing (a monotonic queue as a list with a moving head)
    head = 0
    for i in range(N):
        if i >= n:
            while head < len(dq) and dq[head] < i - n:
                head += 1
            out[i] = h[dq[head]]
        j = i
        while len(dq) > head and h[dq[-1]] <= h[j]:
            dq.pop()
        dq.append(j)
        if head > 4096:                      # keep the list short
            dq = dq[head:]
            head = 0
    return out


def rel_volume(v, n=20):
    """out[i] = volume[i] / the average volume of the n candles BEFORE i (None while fewer than n, or that average is 0)."""
    N = len(v)
    out = [None] * N
    tot = 0.0
    for i in range(N):
        if i >= n:
            out[i] = v[i] / (tot / n) if tot > 0 else None
            tot -= v[i - n]
        tot += v[i]
    return out


def prior_low(l, n):
    """out[i] = the lowest low of the n candles BEFORE candle i (None while fewer than n exist)."""
    neg = prior_high([-x for x in l], n)
    return [None if x is None else -x for x in neg]


def stdev(values, n):
    """The population standard deviation of the last n values (None before n) - as Bollinger Bands use it."""
    out, s, q = [], 0.0, 0.0
    for i, x in enumerate(values):
        s += x
        q += x * x
        if i >= n:
            y = values[i - n]
            s -= y
            q -= y * y
        if i >= n - 1:
            m = s / n
            out.append(max(0.0, q / n - m * m) ** 0.5)
        else:
            out.append(None)
    return out


def clv(o, h, l, c, tick=TICK):
    """The close location value of one candle: +1 = at the high, -1 = at the low."""
    rng = h - l
    return (2 * c - h - l) / (rng if rng > tick else tick)


# ------------------------------------------------------------------ PHASE 3 (owner, 13-Nov-2026: "Do it") - the momentum /
# volume / quant indicators. Same rules: plain lists in, a list of the same length out, None until known, only that candle and
# earlier ones used.
def _from_first(fn, values, *a):
    """fn applied to the values from the first non-None one on (a series that starts later, e.g. the MACD line), padded."""
    k = next((i for i, x in enumerate(values) if x is not None), len(values))
    tail = fn(values[k:], *a) if k < len(values) else []
    return [None] * k + tail


def ema_from(values, n):
    """EMA (seeded with the mean of the first n known values) of a series with leading Nones."""
    return _from_first(ema, values, n)


def wilder_from(values, n):
    return _from_first(wilder, values, n)


def rolling_max(x, n):
    """The highest of the last n values INCLUDING this one (None before n)."""
    ph = prior_high(x, n - 1) if n > 1 else list(x)
    return [None if i < n - 1 else (x[i] if n == 1 else max(ph[i], x[i])) for i in range(len(x))]


def rolling_min(x, n):
    neg = rolling_max([-v for v in x], n)
    return [None if v is None else -v for v in neg]


def macd(c, fast=12, slow=26, sig=9):
    """(MACD line = EMA fast - EMA slow, signal = EMA(sig) of the line, histogram = line - signal)."""
    ef, es = ema(c, fast), ema(c, slow)
    line = [None if a is None or b is None else a - b for a, b in zip(ef, es)]
    s = ema_from(line, sig)
    return line, s, [None if a is None or b is None else a - b for a, b in zip(line, s)]


def stochastic(h, l, c, k=14, smooth=3, d=3):
    """Slow stochastic (k, smooth, d): raw %K = 100 x (close - lowest low) / (highest high - lowest low) of the last k candles
    incl. this one (50 when that range is 0); %K = SMA(smooth) of the raw, %D = SMA(d) of %K."""
    hh, ll = rolling_max(h, k), rolling_min(l, k)
    raw = [None if hh[i] is None else (50.0 if hh[i] - ll[i] <= 0 else 100.0 * (c[i] - ll[i]) / (hh[i] - ll[i]))
           for i in range(len(c))]
    kk = _from_first(sma, raw, smooth)
    return kk, _from_first(sma, kk, d)


def cci(h, l, c, n=20):
    """CCI(n) = (typical price - its SMA) / (0.015 x the mean absolute deviation from that SMA); 0 when the deviation is 0."""
    tp = [(a + b + d) / 3.0 for a, b, d in zip(h, l, c)]
    m = sma(tp, n)
    out = [None] * len(tp)
    for i in range(n - 1, len(tp)):
        md = sum(abs(tp[j] - m[i]) for j in range(i - n + 1, i + 1)) / n
        out[i] = 0.0 if md <= 0 else (tp[i] - m[i]) / (0.015 * md)
    return out


def mfi(h, l, c, v, n=14):
    """Money Flow Index(n): typical price x volume, positive when the typical price rose, negative when it fell, summed over the
    last n candles: 100 - 100 / (1 + positive / negative) (100 with no negative flow, 50 with none at all)."""
    tp = [(a + b + d) / 3.0 for a, b, d in zip(h, l, c)]
    pos, neg = [0.0], [0.0]
    for i in range(1, len(tp)):
        f = tp[i] * v[i]
        pos.append(f if tp[i] > tp[i - 1] else 0.0)
        neg.append(f if tp[i] < tp[i - 1] else 0.0)
    out = [None] * len(tp)
    sp = sn = 0.0
    for i in range(1, len(tp)):
        sp += pos[i]
        sn += neg[i]
        if i > n:
            sp -= pos[i - n]
            sn -= neg[i - n]
        if i >= n:
            out[i] = (50.0 if sp <= 0 else 100.0) if sn <= 0 else 100.0 - 100.0 / (1.0 + sp / sn)
    return out


def obv(c, v):
    """On-balance volume from 0: + the volume on an up close, - on a down close."""
    out, t = [], 0.0
    for i in range(len(c)):
        if i:
            t += v[i] if c[i] > c[i - 1] else (-v[i] if c[i] < c[i - 1] else 0.0)
        out.append(t)
    return out


def ad_line(h, l, c, v, tick=TICK):
    """Chaikin accumulation / distribution line: the running sum of CLV x volume."""
    out, t = [], 0.0
    for i in range(len(c)):
        t += clv(0, h[i], l[i], c[i], tick) * v[i]
        out.append(t)
    return out


def dmi(h, l, c, n=14):
    """Wilder's (+DI, -DI, ADX) of length n: +DM = the high's rise when bigger than the low's fall (else 0), -DM mirrored;
    DI = 100 x Wilder(DM) / Wilder(true range); DX = 100 x |+DI - -DI| / (+DI + -DI); ADX = Wilder(DX)."""
    N = len(c)
    pdi, mdi, dx = [None] * N, [None] * N, [None] * N
    if N < 2:
        return pdi, mdi, [None] * N
    tr, pdm, mdm = [], [], []
    for i in range(1, N):
        up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
        pdm.append(up if up > dn and up > 0 else 0.0)
        mdm.append(dn if dn > up and dn > 0 else 0.0)
        tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
    st, sp, sm = wilder(tr, n), wilder(pdm, n), wilder(mdm, n)
    for k in range(len(tr)):
        if st[k] is None:
            continue
        i = k + 1
        if st[k] <= 0:
            pdi[i] = mdi[i] = 0.0
        else:
            pdi[i], mdi[i] = 100.0 * sp[k] / st[k], 100.0 * sm[k] / st[k]
        s = pdi[i] + mdi[i]
        dx[i] = 0.0 if s <= 0 else 100.0 * abs(pdi[i] - mdi[i]) / s
    return pdi, mdi, wilder_from(dx, n)


def roc(c, n):
    """Rate of change, % over n candles."""
    return [None if i < n or not c[i - n] else 100.0 * (c[i] / c[i - n] - 1.0) for i in range(len(c))]


def tsi(c, r=25, s=13, sig=7):
    """True Strength Index: 100 x EMA(s, EMA(r, change)) / EMA(s, EMA(r, |change|)), and its signal = EMA(sig) of it."""
    m = [None] + [c[i] - c[i - 1] for i in range(1, len(c))]
    a = [None] + [abs(x) for x in m[1:]]
    num = ema_from(ema_from(m, r), s)
    den = ema_from(ema_from(a, r), s)
    t = [None if x is None or y is None else (0.0 if y <= 0 else 100.0 * x / y) for x, y in zip(num, den)]
    return t, ema_from(t, sig)


def aroon(h, l, n=25):
    """(Aroon up, Aroon down) over the last n + 1 candles incl. this one: 100 x (n - candles since the highest high) / n; of equal
    highs the most recent counts (lows mirrored). Monotonic queues - fast on long histories."""
    N = len(h)
    up, dn = [None] * N, [None] * N
    qh, ql = [], []
    hh = hl = 0
    for i in range(N):
        while len(qh) > hh and h[qh[-1]] <= h[i]:
            qh.pop()
        qh.append(i)
        while len(ql) > hl and l[ql[-1]] >= l[i]:
            ql.pop()
        ql.append(i)
        while qh[hh] < i - n:
            hh += 1
        while ql[hl] < i - n:
            hl += 1
        if i >= n:
            up[i] = 100.0 * (n - (i - qh[hh])) / n
            dn[i] = 100.0 * (n - (i - ql[hl])) / n
    return up, dn


def psar(h, l, c, af0=0.02, step=0.02, amax=0.2):
    """Wilder's Parabolic SAR -> (sar, trend +1 / -1) per candle (None at candle 0), as TradingView's ta.sar starts and flips:
    on candle 1 up when its close > candle 0's (SAR = the lower of the two lows, extreme = candle 1's high), else down (the
    higher of the two highs, extreme = its low). Each candle: SAR + af x (extreme - SAR), kept under the two lows before it (over
    the two highs before in a down trend); a low under it (a high over it) flips the trend - the new SAR = the old trend's
    extreme or this candle's low / high if beyond it, af back to af0; a new extreme raises af by step up to amax."""
    N = len(c)
    sar, tr = [None] * N, [None] * N
    if N < 2:
        return sar, tr
    up = c[1] > c[0]
    s = min(l[0], l[1]) if up else max(h[0], h[1])
    ep = h[1] if up else l[1]
    af = af0
    sar[1], tr[1] = s, (1 if up else -1)
    for i in range(2, N):
        s = s + af * (ep - s)
        if up:
            s = min(s, l[i - 1], l[i - 2])
            if l[i] < s:
                up, s, ep, af = False, max(ep, h[i]), l[i], af0
            elif h[i] > ep:
                ep, af = h[i], min(af + step, amax)
        else:
            s = max(s, h[i - 1], h[i - 2])
            if h[i] > s:
                up, s, ep, af = True, min(ep, l[i]), h[i], af0
            elif l[i] < ep:
                ep, af = l[i], min(af + step, amax)
        sar[i], tr[i] = s, (1 if up else -1)
    return sar, tr


def pct_rank(values, n):
    """out[i] = the share (0 - 100) of the n values BEFORE i that are <= value[i] (None while fewer than n or a None among them)
    - a rolling percentile with a sorted window (fast on long histories)."""
    import bisect
    out = [None] * len(values)
    win = []
    for i, x in enumerate(values):
        if i >= n and len(win) == n and x is not None:
            out[i] = 100.0 * bisect.bisect_right(win, x) / n
        if x is not None:
            bisect.insort(win, x)
        if i >= n:
            y = values[i - n]
            if y is not None:
                del win[bisect.bisect_left(win, y)]
    return out


def linreg_slope(values, n):
    """The least-squares slope (per candle) of the last n values incl. this one (None before n or with a None in them).
    Running sums: sum(y) and sum(k x y) with k = 0 .. n-1 (oldest = 0) - moving one candle on = sum(k y) - (sum(y) - oldest)
    + (n - 1) x newest."""
    N = len(values)
    out = [None] * N
    sx = n * (n - 1) / 2.0
    den = n * (n - 1) * (2 * n - 1) / 6.0 * n - sx * sx
    run = sy = sxy = 0
    for i, v in enumerate(values):
        if v is None:
            run = sy = sxy = 0
            continue
        if run < n:
            sxy += run * v
            sy += v
            run += 1
        else:
            old = values[i - n]
            sxy = sxy - (sy - old) + (n - 1) * v
            sy = sy - old + v
        if run == n:
            out[i] = (n * sxy - sx * sy) / den
    return out


def ichimoku(h, l, a=9, b=26, s=52):
    """(tenkan, kijun, span A, span B) as computed ON each candle: tenkan / kijun = the middle of the highest high and lowest
    low of the last a / b candles incl. this one, span A = (tenkan + kijun) / 2, span B = the middle of the last s candles.
    The cloud drawn at candle i is span A / B computed at candle i - b (displaced forward) - see pattern_p3."""
    def mid(n):
        hh, ll = rolling_max(h, n), rolling_min(l, n)
        return [None if x is None else (x + y) / 2.0 for x, y in zip(hh, ll)]
    t, k, sb = mid(a), mid(b), mid(s)
    sa = [None if x is None or y is None else (x + y) / 2.0 for x, y in zip(t, k)]
    return t, k, sa, sb
