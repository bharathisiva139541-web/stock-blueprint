# -*- coding: utf-8 -*-
"""Backtest Lab - the owner's own trade rules on the long Kite history (owner, 09-Nov-2026: "I need a platform to backtest
with my customized idea ... I place stoploss slightly below the FVG area ... if I take a trade I have minimum 2R; if the
stoploss hits the trade is a loss; if the trade hits 2R I don't close it, I try to catch the maximum move within weeks. So
days, stoploss, risk, returns all should be customizable ... make a separate page for backtest"; choices: the website /
app page, this laptop computes; after 2R: the stop moves to the entry, then trails under the lowest low of the last 2
candles - a break of it = exit).

How it works:
 - The daily backtest pass (kite_intraday.backtest_now = BacktestNow.bat, and the daily scan) keeps, per timeframe
   (D / W / 4H), every stock's candles in one compact file (lab_cache/<build>/<tf>.bin: float32 open / high / low /
   close + the day + the minute) and every signal with its zone (signals.json.gz): 'F' = FVG+Spring (3-candle FVG
   zone), 'G' = Gap-up FVG + Spring (+ inside FVG), 'S' = every Spring (no zone). 4H: only the 13:15 candle's Springs
   (the owner's 4H rule), like the daily backtest.
 - The website's Backtest Lab page (owner only, behind the PIN) saves a job in the sheet; the background program asks for
   it (LabWorker, every 10 s while the page is open, else every 2 minutes), runs it here on those files (seconds) and
   sends the summary + the trade list back. No candles leave this computer.
 - The rules (run_job / simulate): entry = the Spring candle's close (or the next candle's open); stop = under the zone
   bottom / the Spring low / the lower of the two / x % under the entry, with a buffer %; trades whose risk is more than
   `maxRisk` % are skipped; target = entry + targetR x risk - then 'fixed' (sell there) or 'trail' (stop to the entry,
   then under the lowest low of the last N candles, x % under the highest high, or a close under the N EMA); at most
   `maxDays` calendar days, then sold at that day's close; a candle reaching both the stop and the target = the stop
   (conservative); a gap through the stop = sold at the open. Costs % per round trip. The account: capital, risk % per
   trade, a position at most `maxPosPct` % of the capital, at most `maxOpen` trades at once (later signals skipped).
"""
import array
import bisect
import gzip
import heapq
import json
import os
import shutil
import statistics
import threading
import time
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
LAB_DIR = os.path.join(HERE, 'lab_cache')
TFS = ('D', 'W', '4H')
CACHE_VERSION = 1
MAX_TRADES_OUT = 3000           # the trade list sent to the sheet (newest first); the figures use every trade
CURVE_POINTS = 360              # the equity curve sent (thinned)
POLL_SLOW_S = 120               # the background program asks the sheet for a job this often ...
POLL_FAST_S = 10                # ... and this often while the page is open (the sheet says which)
log = print                     # screener_bridge sets its own

# ------------------------------------------------------------------ the rules a run may set (and their limits)
DEFAULTS = {
    'tf': 'D', 'group': 'fvg', 'from': '', 'to': '', 'minPrice': 0.0, 'minTurnover': 0.0, 'maxTouch': 0,
    'entry': 'close',
    'stop': 'zone', 'stopBuf': 0.5, 'stopPct': 5.0, 'maxRisk': 15.0,
    'targetR': 2.0, 'after': 'trail', 'breakeven': True, 'trail': 'lows', 'trailN': 2, 'trailPct': 8.0, 'emaN': 20,
    'maxDays': 60, 'cost': 0.2,
    'capital': 1000000.0, 'riskPct': 1.0, 'maxPosPct': 25.0, 'maxOpen': 10, 'compound': False,
    # EMA confluence (owner, 09-Nov-2026: "I don't enter the trade blindly seeing FVG+Spring ... I see EMA (10, 21, 50) -
    # if price is taking support at 10 EMA, I believe the stock will go upward"): on the Spring candle -
    # emaSupport 0 off / 10 / 21 / 50 / 1 = any of them: its low came to (or within emaTouch % above) that EMA and it
    # closed at / above it; aboveNN = it closed above that EMA; emaStack = 10 EMA > 21 EMA > 50 EMA (an uptrend)
    'emaSupport': 0, 'emaTouch': 1.0, 'above10': False, 'above21': False, 'above50': False, 'emaStack': False,
}
EMA_LENS = (10, 21, 50)
BOOLS = ('breakeven', 'compound', 'above10', 'above21', 'above50', 'emaStack')
CHOICES = {
    'tf': TFS, 'group': ('fvg', 'fvg_top', 'fvg_middle', 'fvg_bottom', 'gap', 'gapin', 'zone', 'spring'),
    'entry': ('close', 'next_open'), 'stop': ('zone', 'spring', 'lower', 'pct'), 'after': ('trail', 'fixed'),
    'trail': ('lows', 'pct', 'ema', 'none'), 'emaSupport': (0, 10, 21, 50, 1),
}
LIMITS = {   # key: (min, max, integer)
    'minPrice': (0, 1e6, False), 'minTurnover': (0, 1e6, False), 'maxTouch': (0, 50, True), 'stopBuf': (0, 20, False),
    'stopPct': (0.1, 50, False), 'maxRisk': (0, 100, False), 'targetR': (0.25, 50, False), 'trailN': (1, 50, True),
    'trailPct': (0.5, 60, False), 'emaN': (2, 200, True), 'maxDays': (1, 3650, True), 'cost': (0, 5, False),
    'capital': (1000, 1e10, False), 'riskPct': (0.05, 100, False), 'maxPosPct': (1, 100, False), 'maxOpen': (1, 1000, True),
    'emaTouch': (0, 10, False),
}
GROUP_NAMES = {
    'fvg': 'FVG+Spring', 'fvg_top': 'FVG+Spring - zone top', 'fvg_middle': 'FVG+Spring - zone middle',
    'fvg_bottom': 'FVG+Spring - zone bottom', 'gap': 'Gap-up FVG + Spring', 'gapin': 'Gap-up FVG + Spring - inside FVG',
    'zone': 'FVG+Spring or Gap-up FVG + Spring', 'spring': 'Every Spring',
}
REASONS = ('stop', 'target', 'be', 'trail', 'ema', 'time', 'open')
TRADE_COLS = ['sym', 'signal', 'zone', 'where', 'touch', 'entry', 'stop', 'riskPct', 'exit', 'exitOn', 'reason', 'R', 'ret',
              'days', 'maxR', 'qty', 'pnl', 'taken', 'ema', 'acct']


def _iso_date(s):
    try:
        return date.fromisoformat(str(s)[:10]).isoformat()
    except ValueError:
        return ''


def clean_params(p):
    """The run's rules from the page, checked: unknown keys left out, numbers kept within LIMITS, choices from CHOICES."""
    p = p if isinstance(p, dict) else {}
    out = dict(DEFAULTS)
    for k, opts in CHOICES.items():
        v = p.get(k)
        if not isinstance(v, bool) and v in opts:
            out[k] = int(v) if isinstance(v, float) else v
    for k, (lo, hi, integer) in LIMITS.items():
        v = p.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
            continue
        v = min(max(v, lo), hi)
        out[k] = int(round(v)) if integer else float(v)
    for k in BOOLS:
        if isinstance(p.get(k), bool):
            out[k] = p[k]
    for k in ('from', 'to'):
        out[k] = _iso_date(p.get(k) or '')
    return out


# ------------------------------------------------------------------ the cache (written by the backtest pass)
def _minute(t):
    return int(t[11:13]) * 60 + int(t[14:16]) if len(t) >= 16 else 0


def _label(tf, day_ord, minute):
    d = date.fromordinal(day_ord).isoformat()
    return d + ' %02d:%02d' % divmod(minute, 60) if tf == '4H' else d


class CacheWriter:
    """Collects the candles + signals of every stock during a backtest pass; close() makes them the current cache."""

    def __init__(self, upto, base=None):
        self.base = base or LAB_DIR
        self.name = 'b' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        self.dir = os.path.join(self.base, self.name + '.tmp')
        os.makedirs(self.dir, exist_ok=True)
        self.upto = upto.isoformat() if hasattr(upto, 'isoformat') else str(upto)
        self.files = {tf: open(os.path.join(self.dir, tf + '.bin'), 'wb') for tf in TFS}
        self.pos = {tf: 0 for tf in TFS}
        self.index = {tf: {} for tf in TFS}
        self.signals = {tf: {} for tf in TFS}
        self.done = False

    def add(self, sym, tf, candles, rows):
        """One stock's candles of a timeframe (oldest first, {'t','day','o','h','l','c'}) and its signal rows
        [i, code, zone bottom, zone top, where, touch, inside, turnover lakh]."""
        if tf not in self.files or not candles or self.done:
            return
        try:
            self._add(sym, tf, candles, rows)
        except OSError as e:                  # a full disk: no cache this time - the scan itself carries on
            log('Backtest Lab: the cache could not be written - %s' % e)
            self.abort()

    def _add(self, sym, tf, candles, rows):
        n = len(candles)
        parts = [array.array('f', [c[k] for c in candles]) for k in ('o', 'h', 'l', 'c')]
        parts.append(array.array('i', [date.fromisoformat(c['day'][:10]).toordinal() for c in candles]))
        parts.append(array.array('h', [_minute(c['t']) if tf == '4H' else 0 for c in candles]))
        f = self.files[tf]
        self.index[tf][sym] = [self.pos[tf], n]
        for a in parts:
            b = a.tobytes()
            f.write(b)
            self.pos[tf] += len(b)
        if self.pos[tf] % 4:
            pad = 4 - self.pos[tf] % 4
            f.write(b'\0' * pad)
            self.pos[tf] += pad
        if rows:
            self.signals[tf][sym] = rows

    def abort(self):
        for f in self.files.values():
            f.close()
        self.done = True
        shutil.rmtree(self.dir, ignore_errors=True)

    def close(self):
        if self.done:
            return
        for f in self.files.values():
            f.close()
        meta = {'v': CACHE_VERSION, 'upto': self.upto, 'built': datetime.now().isoformat(timespec='seconds'),
                'index': self.index, 'signals': self.signals}
        with gzip.open(os.path.join(self.dir, 'signals.json.gz'), 'wt', encoding='utf-8') as f:
            json.dump(meta, f, separators=(',', ':'))
        final = os.path.join(self.base, self.name)
        os.replace(self.dir, final)
        tmp = os.path.join(self.base, 'current.txt.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(self.name)
        os.replace(tmp, os.path.join(self.base, 'current.txt'))
        self.done = True
        for d in os.listdir(self.base):   # older builds (a file still open on Windows: left for the next build)
            if d != self.name and d.startswith('b') and os.path.isdir(os.path.join(self.base, d)):
                shutil.rmtree(os.path.join(self.base, d), ignore_errors=True)


def turnover_fn(day_rows, days=20):
    """day ISO -> the average daily turnover (close x volume) of the `days` sessions up to that day, in lakh rupees."""
    keys = [r[0][:10] for r in day_rows]
    pre = [0.0]
    for r in day_rows:
        try:
            pre.append(pre[-1] + float(r[4]) * float(r[5] or 0))
        except (TypeError, ValueError):
            pre.append(pre[-1])

    def at(day):
        k = bisect.bisect_right(keys, day[:10])
        if k == 0:
            return 0.0
        a = max(0, k - days)
        return round((pre[k] - pre[a]) / (k - a) / 1e5, 1)
    return at


def signal_rows(candles, i, zones, turn):
    """The cache rows of a Spring on candle i: 'S' (every Spring) + one per zone it sits on ('F' FVG / 'G' Gap-up)."""
    t = turn(candles[i]['day']) if turn else 0.0
    rows = [[i, 'S', None, None, '', 0, 0, t]]
    for z in zones or ():
        rows.append([i, 'G' if z['kind'] == 'Gap-up' else 'F', round(z['bottom'], 4), round(z['top'], 4),
                     (z.get('where') or '')[:1], int(z.get('touch') or 0), 1 if z.get('inside') else 0, t])
    return rows


def current_dir(base=None):
    base = base or LAB_DIR
    try:
        with open(os.path.join(base, 'current.txt'), encoding='utf-8') as f:
            name = f.read().strip()
    except OSError:
        return None
    d = os.path.join(base, name)
    return d if name and os.path.isfile(os.path.join(d, 'signals.json.gz')) else None


def load_meta(base=None):
    d = current_dir(base)
    if not d:
        return None, None
    try:
        with gzip.open(os.path.join(d, 'signals.json.gz'), 'rt', encoding='utf-8') as f:
            meta = json.load(f)
    except (OSError, ValueError, EOFError):
        return None, None
    return (meta, d) if meta.get('v') == CACHE_VERSION else (None, None)


class Candles:
    __slots__ = ('o', 'h', 'l', 'c', 'day', 'minute', 'n')

    def __init__(self, f, off, n):
        self.n = n
        f.seek(off)
        raw = f.read(n * 22 + 4)
        vals = []
        p = 0
        for code, size in (('f', 4), ('f', 4), ('f', 4), ('f', 4), ('i', 4), ('h', 2)):
            a = array.array(code)
            a.frombytes(raw[p:p + n * size])
            vals.append(a)
            p += n * size
        self.o, self.h, self.l, self.c, self.day, self.minute = vals


# ------------------------------------------------------------------ one trade
def ema_series(closes, n):
    out, k, e = [], 2.0 / (n + 1), None
    for x in closes:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


def _f(x):
    """float32 -> a price with 2 decimals (what the chart shows)."""
    return round(float(x), 2)


def ema_lens(P):
    """The EMA lengths the run's confluence rules need (none = no EMA filter)."""
    need = set()
    if P['emaSupport']:
        need.update(EMA_LENS if P['emaSupport'] == 1 else (int(P['emaSupport']),))
    need.update(n for n in EMA_LENS if P['above%d' % n])
    if P['emaStack']:
        need.update(EMA_LENS)
    return sorted(need)


def ema_check(cs, i, P, emas):
    """EMA confluence on the Spring candle i -> (ok, text). text = what the EMAs show there ('support 10 EMA ·
    above 21 / 50 · 10>21>50'). The first candles of a stock (shorter than the EMA) never pass."""
    lens = sorted(emas)
    if not lens or i < max(lens):
        return False, ''
    c, l = _f(cs.c[i]), _f(cs.l[i])
    e = {n: emas[n][i] for n in lens}
    touch = 1 + P['emaTouch'] / 100.0
    sup = [n for n in lens if l <= e[n] * touch and c >= e[n]]
    above = [n for n in lens if c > e[n]]
    stack = len(lens) == 3 and e[10] > e[21] > e[50]
    ok = True
    if P['emaSupport']:
        want = EMA_LENS if P['emaSupport'] == 1 else (int(P['emaSupport']),)
        ok = ok and any(n in sup for n in want)
    for n in EMA_LENS:
        if P['above%d' % n]:
            ok = ok and n in above
    if P['emaStack']:
        ok = ok and stack
    parts = []
    if sup:
        parts.append('support ' + ' / '.join(str(n) for n in sup) + ' EMA')
    rest = [n for n in above if n not in sup]
    if rest:
        parts.append('above ' + ' / '.join(str(n) for n in rest))
    if stack:
        parts.append('10>21>50')
    return ok, ' · '.join(parts)


def simulate(cs, row, P, ema=None):
    """One signal row -> the trade under the rules P (see the module text), or (None, why skipped)."""
    i, code, zb = row[0], row[1], row[2]
    n = cs.n
    if i >= n:
        return None, 'data'
    if P['entry'] == 'close':
        entry = _f(cs.c[i])
    else:
        if i + 1 >= n:
            return None, 'notyet'
        entry = _f(cs.o[i + 1])
    j0 = i + 1
    low = _f(cs.l[i])
    mode = P['stop']
    if mode == 'zone' and zb is None:
        mode = 'spring'                       # every Spring has no zone: under its own low
    if mode == 'pct':
        stop = entry * (1 - P['stopPct'] / 100.0)
    else:
        base = low if mode == 'spring' else zb if mode == 'zone' else min(low, zb if zb is not None else low)
        stop = base * (1 - P['stopBuf'] / 100.0)
    risk = entry - stop
    if not (entry > 0 and risk > 0):
        return None, 'gap' if P['entry'] == 'next_open' else 'risk'
    risk_pct = risk / entry * 100
    if P['maxRisk'] and risk_pct > P['maxRisk']:
        return None, 'risk'
    if entry < P['minPrice']:
        return None, 'price'
    target = entry + P['targetR'] * risk
    end = cs.day[i] + P['maxDays']
    trail, fixed, be = P['trail'], P['after'] == 'fixed', P['breakeven']
    hit, cur, best = False, stop, entry
    ex, why, jx = None, None, None

    def trail_up(j, cur):
        if trail == 'lows':
            a = max(0, j - P['trailN'] + 1)
            cur = max(cur, min(_f(cs.l[k]) for k in range(a, j + 1)))
        elif trail == 'pct':
            cur = max(cur, best * (1 - P['trailPct'] / 100.0))
        return cur

    for j in range(j0, n):
        if cs.day[j] > end:
            ex, why, jx = _f(cs.c[j - 1]), 'time', j - 1
            break
        o, h, l, c = _f(cs.o[j]), _f(cs.h[j]), _f(cs.l[j]), _f(cs.c[j])
        if not hit:
            if o >= target:                       # opened above the target
                hit = True
                best = max(best, o)
                if fixed:
                    ex, why, jx = o, 'target', j
                    break
                if be:
                    cur = max(cur, entry)
                if l < cur:
                    ex, why, jx = cur, 'be' if cur >= entry else 'stop', j
                    break
                best = max(best, h)
                cur = trail_up(j, cur)
                continue
            if l < stop:
                ex, why, jx = min(o, stop), 'stop', j
                break
            best = max(best, h)
            if h >= target:
                hit = True
                if fixed:
                    ex, why, jx = target, 'target', j
                    break
                if be:
                    cur = max(cur, entry)
                cur = trail_up(j, cur)
            continue
        if l < cur:
            ex = min(o, cur)
            why = 'trail' if cur > entry * (1 + 1e-9) else 'be' if cur >= entry * (1 - 1e-9) else 'stop'
            jx = j
            break
        if trail == 'ema' and ema is not None and c < ema[j]:
            ex, why, jx = c, 'ema', j
            break
        best = max(best, h)
        cur = trail_up(j, cur)
    else:
        jx = n - 1
        ex, why = _f(cs.c[jx]), 'open'        # the window is not over yet: still running (shown, not counted)
    if jx <= i:                               # no candle inside the window: sold where bought
        jx, ex = i, entry
    cost = P['cost'] / 100.0 * entry
    R = (ex - entry - cost) / risk
    best_r = (best - entry) / risk
    return {'i': i, 'code': code, 'where': row[4], 'touch': row[5], 'inside': row[6], 'turn': row[7],
            'entry': entry, 'stop': round(stop, 2), 'risk': risk, 'riskPct': round(risk_pct, 2), 'exit': round(ex, 4), 'reason': why,
            'R': round(R, 3), 'ret': round((ex - entry - cost) / entry * 100, 2), 'days': cs.day[jx] - cs.day[i],
            'maxR': round(max(0.0, best_r), 2), 'hit': hit,
            'ek': (cs.day[i if P['entry'] == 'close' else min(i + 1, n - 1)], cs.minute[i if P['entry'] == 'close' else min(i + 1, n - 1)]),
            'xk': (cs.day[jx], cs.minute[jx]), 'sigDay': cs.day[i], 'sigMin': cs.minute[i]}, None


def pick(rows, P):
    """The signal rows of the chosen group (and touch / turnover filters); one per candle."""
    g = P['group']
    out, seen = [], set()
    for r in rows:
        code, where, touch, inside = r[1], r[4], r[5], r[6]
        ok = ((g == 'spring' and code == 'S') or
              (g == 'fvg' and code == 'F') or
              (g.startswith('fvg_') and code == 'F' and where == g[4]) or
              (g == 'gap' and code == 'G') or
              (g == 'gapin' and code == 'G' and inside) or
              (g == 'zone' and code in ('F', 'G')))
        if not ok or r[0] in seen:
            continue
        if P['maxTouch'] and code != 'S' and touch > P['maxTouch']:
            continue
        if P['minTurnover'] and (r[7] or 0) < P['minTurnover']:
            continue
        seen.add(r[0])
        out.append(r)
    return out


# ------------------------------------------------------------------ the account + figures
def _rs(v, d=0):
    """Rupees with Indian grouping (12,34,567); d decimals at most (trailing zeros dropped)."""
    neg = v < 0
    whole, _, frac = ('%.*f' % (d, abs(v))).partition('.')
    if len(whole) > 3:
        head, parts = whole[:-3], []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        whole = ','.join(([head] if head else []) + parts) + ',' + whole[-3:]
    frac = frac.rstrip('0')
    return ('-' if neg else '') + whole + ('.' + frac if frac else '')


def portfolio(trades, P):
    """Trades in time order -> each taken one gets qty / pnl (rupees); at most maxOpen at once. -> summary dict."""
    cap = P['capital']
    eq = cap
    heap, still, realized, skipped, seq, blown, capped = [], [], [], 0, 0, None, 0
    why = {'full': 0, 'cap': 0, 'risk': 0, 'blown': 0}
    order = sorted(trades, key=lambda t: (t['ek'], t['sym']))
    for t in order:
        while heap and heap[0][0] <= t['ek']:    # positions sold before (or when) this one is bought
            o = heapq.heappop(heap)[2]
            eq += o['pnl']
            realized.append(o)
        t['qty'], t['pnl'], t['taken'], t['acct'] = 0, 0, 0, ''
        # why a signal is not taken (owner, 09-Nov-2026: "more trades were skipped in the account, I don't know why -
        # show the reason when I place the cursor on the word skipped")
        if eq <= 0:                              # the account is gone: no more trades
            blown = blown or date.fromordinal(t['ek'][0]).isoformat()
            skipped += 1
            why['blown'] += 1
            t['acct'] = 'Not taken: the account had run out (Rs %s).' % _rs(eq)
            continue
        if len(heap) + len(still) >= P['maxOpen']:
            skipped += 1
            why['full'] += 1
            t['acct'] = ('Not taken: %d trades were already open - your limit is %d at once (Money: "Trades open at once, '
                         'at most").' % (len(heap) + len(still), P['maxOpen']))
            continue
        base = eq if P['compound'] else cap
        risk_amt = base * P['riskPct'] / 100.0
        pos_amt = base * P['maxPosPct'] / 100.0
        qty_r = int(risk_amt // t['risk'])
        qty_c = int(pos_amt // t['entry'])
        qty = min(qty_r, qty_c)
        if qty_r < 1:
            skipped += 1
            why['risk'] += 1
            t['acct'] = ('Not taken: one share risks Rs %s (entry %s - stop %s), more than your risk per trade of Rs %s '
                         '(%g%% of the account).' % (_rs(t['risk'], 2), _rs(t['entry'], 2), _rs(t.get('stop', t['entry'] - t['risk']), 2),
                                                     _rs(risk_amt), P['riskPct']))
            continue
        if qty_c < 1:
            skipped += 1
            why['cap'] += 1
            t['acct'] = ('Not taken: one share costs Rs %s, more than your position limit of Rs %s (%g%% of the account, '
                         'Money: "One position at most").' % (_rs(t['entry'], 2), _rs(pos_amt), P['maxPosPct']))
            continue
        t['acct'] = '%d shares, Rs %s invested, Rs %s at risk' % (qty, _rs(qty * t['entry']), _rs(qty * t['risk']))
        if qty_c < qty_r:
            capped += 1
            t['acct'] += (' - made smaller by your position limit of %g%% (the full %g%% risk would be %d shares)'
                          % (P['maxPosPct'], P['riskPct'], qty_r))
        t['acct'] += '.'
        t['qty'] = qty
        t['pnl'] = round(qty * (t['exit'] - t['entry']) - P['cost'] / 100.0 * qty * t['entry'], 2)
        t['taken'] = 1
        if t['reason'] == 'open':
            still.append(t)                      # still running: never sold, so it keeps its place
        else:
            seq += 1
            heapq.heappush(heap, (t['xk'], seq, t))
    while heap:
        o = heapq.heappop(heap)[2]
        eq += o['pnl']
        realized.append(o)
    realized.sort(key=lambda o: o['xk'])
    curve, peak, dd, e = [], cap, 0.0, cap
    for o in realized:
        e += o['pnl']
        peak = max(peak, e)
        dd = min(100.0, max(dd, (peak - e) / peak * 100 if peak > 0 else 0))
        curve.append([date.fromordinal(o['xk'][0]).isoformat(), round(e)])
    if len(curve) > CURVE_POINTS:            # thinned, keeping the last point of each step
        step = len(curve) / float(CURVE_POINTS)
        curve = [curve[min(len(curve) - 1, int((k + 1) * step) - 1)] for k in range(CURVE_POINTS)]
    first = min((o['ek'][0] for o in realized), default=None)
    last = max((o['xk'][0] for o in realized), default=None)
    years = (last - first) / 365.25 if first and last and last > first else 0
    final = e
    cagr = ((final / cap) ** (1 / years) - 1) * 100 if years >= 0.25 and final > 0 else None
    return {'capital': cap, 'final': round(final), 'pnl': round(final - cap), 'returnPct': round((final - cap) / cap * 100, 2),
            'cagr': round(cagr, 2) if cagr is not None else None, 'maxDD': round(dd, 2), 'taken': len(realized) + len(still),
            'skipped': skipped, 'openNow': len(still), 'openPnl': round(sum(o['qty'] * (o['exit'] - o['entry']) for o in still)),
            'years': round(years, 1), 'curve': curve, 'blown': blown, 'skipReasons': why, 'capped': capped}


def _stats(ts):
    rs = [t['R'] for t in ts]
    n = len(rs)
    if not n:
        return {'trades': 0}
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    streak = worst = 0
    for t in sorted(ts, key=lambda t: t['ek']):
        streak = streak + 1 if t['R'] <= 0 else 0
        worst = max(worst, streak)
    gain, loss = sum(wins), -sum(losses)
    return {'trades': n, 'winPct': round(len(wins) * 100.0 / n, 1), 'avgR': round(sum(rs) / n, 3),
            'medR': round(statistics.median(rs), 3), 'totalR': round(sum(rs), 1),
            'pf': round(gain / loss, 2) if loss > 0 else None,
            'avgWinR': round(gain / len(wins), 2) if wins else None, 'avgLossR': round(-loss / len(losses), 2) if losses else None,
            'hitPct': round(sum(1 for t in ts if t['hit']) * 100.0 / n, 1),
            'avgRet': round(sum(t['ret'] for t in ts) / n, 2), 'medRet': round(statistics.median([t['ret'] for t in ts]), 2),
            'avgDays': round(sum(t['days'] for t in ts) / n, 1), 'bestR': round(max(rs), 2), 'worstR': round(min(rs), 2),
            'avgMaxR': round(sum(t['maxR'] for t in ts) / n, 2), 'maxLosingStreak': worst}


HIST_EDGES = [(-1e9, -1, '< -1R'), (-1, 0, '-1R to 0'), (0, 1, '0 to 1R'), (1, 2, '1R to 2R'), (2, 3, '2R to 3R'),
              (3, 5, '3R to 5R'), (5, 10, '5R to 10R'), (10, 1e9, '10R +')]


def summarise(trades, P, skips, meta, secs):
    closed = [t for t in trades if t['reason'] != 'open']
    acct = portfolio(trades, P)
    by_year = {}
    for t in closed:
        y = date.fromordinal(t['sigDay']).year
        a = by_year.setdefault(y, [])
        a.append(t)
    years = []
    for y in sorted(by_year):
        s = _stats(by_year[y])
        taken = [t for t in by_year[y] if t['taken']]
        years.append({'year': y, 'trades': s['trades'], 'winPct': s['winPct'], 'avgR': s['avgR'], 'totalR': s['totalR'],
                      'pnl': round(sum(t['pnl'] for t in taken)), 'taken': len(taken)})
    hist = [{'label': lab, 'n': sum(1 for t in closed if lo <= t['R'] < hi)} for lo, hi, lab in HIST_EDGES]
    reasons = {r: sum(1 for t in trades if t['reason'] == r) for r in REASONS}
    zone_name = {'F': 'FVG', 'G': 'Gap-up', 'S': 'Spring'}
    where_name = {'t': 'top', 'm': 'middle', 'b': 'bottom'}
    rows = []
    for t in sorted(trades, key=lambda t: (t['sigDay'], t['sigMin'], t['sym']), reverse=True)[:MAX_TRADES_OUT]:
        rows.append([t['sym'], _label(P['tf'], t['sigDay'], t['sigMin']),
                     zone_name[t['code']] + (' inside FVG' if t['code'] == 'G' and t['inside'] else ''),
                     where_name.get(t['where'], ''), t['touch'] or '', t['entry'], t['stop'], t['riskPct'], round(t['exit'], 2),
                     _label(P['tf'], t['xk'][0], t['xk'][1]), t['reason'], t['R'], t['ret'], t['days'], t['maxR'],
                     t['qty'], t['pnl'], t['taken'], t.get('ema', ''), t.get('acct', '')])
    first = min((t['sigDay'] for t in trades), default=None)
    last = max((t['sigDay'] for t in trades), default=None)
    return {'v': 1, 'params': P, 'groupName': GROUP_NAMES[P['group']], 'cacheUpto': meta.get('upto'),
            'from': date.fromordinal(first).isoformat() if first else '', 'to': date.fromordinal(last).isoformat() if last else '',
            'stats': _stats(closed), 'open': len(trades) - len(closed), 'skipped': skips, 'account': acct, 'years': years,
            'hist': hist, 'reasons': reasons, 'tradeCols': TRADE_COLS, 'trades': rows, 'tradesTotal': len(trades),
            'secs': round(secs, 1)}


def run_job(params, base=None, progress=None):
    """One Backtest Lab run on the cache -> the result (summarise). Raises LabError when there is no cache yet."""
    t0 = time.time()
    P = clean_params(params)
    meta, d = load_meta(base)
    if not meta:
        raise LabError('no backtest cache on this computer yet')
    tf = P['tf']
    sigs = meta['signals'].get(tf) or {}
    index = meta['index'].get(tf) or {}
    lo = date.fromisoformat(P['from']).toordinal() if P['from'] else None
    hi = date.fromisoformat(P['to']).toordinal() if P['to'] else None
    trades, skips = [], {'risk': 0, 'gap': 0, 'price': 0, 'notyet': 0, 'data': 0, 'ema': 0}
    lens = ema_lens(P)
    syms = sorted(sigs)
    with open(os.path.join(d, tf + '.bin'), 'rb') as f:
        for k, sym in enumerate(syms):
            rows = pick(sigs[sym], P)
            if not rows or sym not in index:
                continue
            cs = Candles(f, index[sym][0], index[sym][1])
            ema = ema_series(cs.c, P['emaN']) if P['after'] == 'trail' and P['trail'] == 'ema' else None
            emas = {n: ema_series([_f(x) for x in cs.c], n) for n in lens}
            for r in rows:
                if r[0] >= cs.n or (lo and cs.day[r[0]] < lo) or (hi and cs.day[r[0]] > hi):
                    continue
                note = ''
                if lens:
                    ok, note = ema_check(cs, r[0], P, emas)
                    if not ok:
                        skips['ema'] = skips.get('ema', 0) + 1
                        continue
                t, why = simulate(cs, r, P, ema)
                if t is not None:
                    t['ema'] = note
                if t is None:
                    skips[why] = skips.get(why, 0) + 1
                    continue
                t['sym'] = sym
                trades.append(t)
            if progress and (k + 1) % 300 == 0:
                progress(int((k + 1) * 90 / max(1, len(syms))))
    return summarise(trades, P, skips, meta, time.time() - t0)


class LabError(Exception):
    pass


def headline(res):
    s, a = res.get('stats') or {}, res.get('account') or {}
    if not s.get('trades'):
        return 'no trades'
    return ('%d trades, win %.1f%%, avg %.2fR, total %.0fR; account %+.1f%% (max drawdown %.1f%%)'
            % (s['trades'], s['winPct'], s['avgR'], s['totalR'], a.get('returnPct') or 0, a.get('maxDD') or 0))


# ------------------------------------------------------------------ the background worker
class LabWorker:
    """Asks the sheet for a Backtest Lab job (the website's page) and runs it here. One thread per program."""

    def __init__(self):
        self.thread = None
        self.build = None            # fn(out) -> True when it built the cache (kite_intraday.lab_build_cache)

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_start(self, cfg, api, build=None):
        if cfg.get('backtest_lab') is False or self.busy():
            return False
        self.build = build
        self.thread = threading.Thread(target=self.loop, args=(cfg, api), daemon=True)
        self.thread.start()
        return True

    def loop(self, cfg, api, rounds=None):
        old_app_said = False
        k = 0
        while rounds is None or k < rounds:
            k += 1
            wait = POLL_SLOW_S
            try:
                res = api(cfg, 'lab', {'op': 'poll'}, tries=1, timeout=60)
                if not res.get('ok'):
                    if 'unknown action' in str(res.get('error')):
                        if not old_app_said:
                            log('Backtest Lab: the sheet\'s web app is an older version - deploy a New version of the '
                                'existing web app (Deploy > Manage deployments > Edit > New version).')
                            old_app_said = True
                        wait = 1800
                    else:
                        wait = 300
                else:
                    wait = min(max(int(res.get('next') or POLL_SLOW_S), 5), 900)
                    job = res.get('job')
                    if job:
                        self.run_one(cfg, api, job)
                        wait = 5
            except Exception as e:            # no internet / the sheet busy: try again later
                log('Backtest Lab: %s' % e)
                wait = 300
            if rounds is None:
                time.sleep(wait)

    def run_one(self, cfg, api, job):
        jid = job.get('id')
        name = job.get('name') or ''

        def progress(pct, note=''):
            try:
                api(cfg, 'lab', {'op': 'progress', 'id': jid, 'pct': pct, 'note': note}, tries=1, timeout=30)
            except Exception:
                pass
        log('Backtest Lab: running "%s" ...' % (name or jid))
        try:
            meta, _ = load_meta()
            if not meta:
                if not self.build:
                    raise LabError('no backtest cache yet - run BacktestNow.bat once')
                progress(1, 'first run: preparing the candles on the laptop (about 3 minutes, only once)')
                if not self.build(lambda m: log('Backtest Lab: ' + m)):
                    raise LabError('no Kite candles on this laptop yet - run KiteHistoryNow.bat')
            res = run_job(job.get('params') or {}, progress=lambda p: progress(p))
            reply = api(cfg, 'lab', {'op': 'result', 'id': jid, 'result': res}, tries=3, timeout=180)
            if not reply.get('ok'):
                raise LabError('the sheet refused the result - %s' % reply.get('error'))
            log('Backtest Lab: "%s" done in %.0f s - %s.' % (name or jid, res['secs'], headline(res)))
        except Exception as e:
            log('Backtest Lab: "%s" failed - %s' % (name or jid, e))
            try:
                api(cfg, 'lab', {'op': 'fail', 'id': jid, 'error': str(e)[:300]}, tries=2, timeout=60)
            except Exception:
                pass
