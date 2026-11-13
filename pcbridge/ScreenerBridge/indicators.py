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
