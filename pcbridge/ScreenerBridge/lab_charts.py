# -*- coding: utf-8 -*-
"""Backtest Lab trade charts - one PDF per run, two pages per trade (owner, 12-Nov-2026: "when the backtest result comes,
a PDF should come with it - a chart for every trade, with the swings, CHoCH, FVG area, target and stop loss of the
conditions we gave, a snapshot like the TradingView view. We have the historical data, so we can draw the candlesticks
ourselves ... then I need not go to the TradingView link every time"; choices: saved in the laptop folder only
(ScreenerBridge\\lab_charts), every trade, the losing ones first). Then (owner, 12-Nov-2026: "difficult to understand why
picked this trade setup. hence show market structure in the chart according to the setup like LL, LH, HL, HH, BoS, Choch, FVG
Zone, buy. these words should not overwrited on the candle and price movement. Use 2 slides for each setup. one for chart.
2 slide for why you took this trade. reason for hitting stoploss"): page 1 = the chart, every swing tagged against the one
before of its kind, the words placed by `Placer` where no candle is; page 2 = every rule the trade passed with the candle's
own numbers, how it ended (a stop loss: how close it came, the stop candle, the zone, the final low, what price did after).
Then (owner, 12-Nov-2026: "why this trade should not numericals and with chart. it should be readable format like in
sentences"): page 2 is plain sentences only - the story of the setup and of the exit, a few dates, no chart.

Pure Python (no extra package): a small PDF writer (vector drawing, Helvetica, zlib-compressed pages, written page by page
so thousands of pages never sit in memory) and the chart page. backtest_lab.run_job(..., charts=folder) calls
`make_pdf` after a run; the candles come from the Lab's own cache (the run's timeframe), the CHoCH / BOS / swings from
structure.py - the same the run judged.
"""
import math
import os
import re
import zlib
from datetime import date

PAGE_W, PAGE_H = 842.0, 595.0          # A4 landscape, points
MAX_TRADES = 1500                      # trades in one PDF - two pages each (the rest are counted on the cover)
KEEP_FILES = 20                        # older PDFs in the folder are removed
MAX_WINDOW = 260                       # candles on one chart at most
FOLDER = 'lab_charts'
WATCH = None                           # tests: a list that collects every Chart drawn (its words and candle columns)

# Helvetica character widths (1/1000 em) for ASCII 32..126 - for right-aligned labels and label boxes
_HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
      [278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
       778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
       556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]

UP, DOWN, WICK = (0.13, 0.62, 0.45), (0.89, 0.30, 0.30), (0.35, 0.38, 0.45)
GRID, AXIS, MUTED, INK = (0.92, 0.93, 0.95), (0.55, 0.58, 0.64), (0.42, 0.45, 0.52), (0.10, 0.12, 0.18)
ZONE_FVG, ZONE_GAP = (0.86, 0.92, 1.0), (0.93, 0.88, 1.0)
WATCHED = (0.92, 0.92, 0.93)                # the 1st discount zone of the move - only watched (12-Nov-2026)
CHOCH, FIB, BOS = (0.50, 0.33, 0.93), (0.85, 0.62, 0.05), (0.95, 0.45, 0.10)
ENTRY, STOP, TARGET, SWING = (0.15, 0.40, 0.90), (0.88, 0.20, 0.20), (0.10, 0.60, 0.35), (0.98, 0.65, 0.25)
EMA_COL = {10: (0.95, 0.55, 0.10), 21: (0.20, 0.55, 0.85), 50: (0.55, 0.35, 0.75)}
MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']


def text_width(s, size):
    w = 0
    for ch in s:
        o = ord(ch)
        w += _HW[o - 32] if 32 <= o <= 126 else 556
    return w * size / 1000.0


def _pdf_str(s):
    """Text -> a PDF string literal (WinAnsi: the middle dot and the like kept, anything else '?')."""
    s = str(s).replace('\u20b9', 'Rs ').replace('\u2192', '->').replace('\u2013', '-').replace('\u2014', '-')
    b = s.encode('cp1252', errors='replace')
    b = b.replace(b'\\', b'\\\\').replace(b'(', b'\\(').replace(b')', b'\\)').replace(b'\r', b' ').replace(b'\n', b' ')
    return '(' + b.decode('latin-1') + ')'


def money(v):
    """1234567.5 -> '12,34,567.50' (Indian grouping, 2 decimals)."""
    neg = v < 0
    whole, frac = ('%.2f' % abs(v)).split('.')
    if len(whole) > 3:
        head, parts = whole[:-3], []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        whole = ','.join(([head] if head else []) + parts) + ',' + whole[-3:]
    return ('-' if neg else '') + whole + '.' + frac


def day_text(ordinal, minute=0, intraday=False, year=True):
    d = date.fromordinal(int(ordinal))
    s = '%02d %s' % (d.day, MON[d.month - 1]) + (' %d' % d.year if year else '')
    return s + (' %02d:%02d' % divmod(int(minute), 60) if intraday else '')


class Canvas:
    """PDF drawing operators for one page (y from the bottom)."""

    def __init__(self):
        self.ops = []

    def _rgb(self, c, op):
        self.ops.append('%.3f %.3f %.3f %s' % (c[0], c[1], c[2], op))

    def line(self, x1, y1, x2, y2, color=INK, width=0.6, dash=None):
        self._rgb(color, 'RG')
        self.ops.append('%.2f w %s 0 d %.2f %.2f m %.2f %.2f l S' % (width, '[%s]' % ' '.join(str(x) for x in dash) if dash else '[]',
                                                                      x1, y1, x2, y2))

    def polyline(self, pts, color, width=0.7):
        if len(pts) < 2:
            return
        self._rgb(color, 'RG')
        self.ops.append('%.2f w [] 0 d %.2f %.2f m ' % (width, pts[0][0], pts[0][1]) +
                        ' '.join('%.2f %.2f l' % p for p in pts[1:]) + ' S')

    def rect(self, x, y, w, h, fill=None, stroke=None, width=0.5):
        if fill:
            self._rgb(fill, 'rg')
        if stroke:
            self._rgb(stroke, 'RG')
        op = 'B' if fill and stroke else 'f' if fill else 'S'
        self.ops.append('%.2f w [] 0 d %.2f %.2f %.2f %.2f re %s' % (width, x, y, w, h, op))

    def tri(self, x, y, size, up, color):
        h = size if up else -size
        self._rgb(color, 'rg')
        self.ops.append('%.2f %.2f m %.2f %.2f l %.2f %.2f l f' % (x - size * 0.6, y, x + size * 0.6, y, x, y + h))

    def text(self, x, y, s, size=8, color=INK, bold=False, align='left'):
        if align != 'left':
            w = text_width(str(s), size) * (1.06 if bold else 1.0)
            x -= w if align == 'right' else w / 2.0
        self._rgb(color, 'rg')
        self.ops.append('BT /%s %.1f Tf %.2f %.2f Td %s Tj ET' % ('F2' if bold else 'F1', size, x, y, _pdf_str(s)))

    def data(self):
        return '\n'.join(self.ops)


class PdfWriter:
    """Pages written one by one (compressed), the page order fixed at close() (`order` = their sort keys)."""

    def __init__(self, path):
        self.path = path
        self.f = open(path + '.tmp', 'wb')
        self.pos = 0
        self.offsets = {}
        self.next = 5
        self.pages = []                      # (sort key, page object number)
        self._raw(b'%PDF-1.4\n%\xe2\xe3\xcf\xd3\n')
        self._obj(1, b'<< /Type /Catalog /Pages 2 0 R >>')
        self._obj(3, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>')
        self._obj(4, b'<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>')

    def _raw(self, b):
        self.f.write(b)
        self.pos += len(b)

    def _obj(self, num, body):
        self.offsets[num] = self.pos
        self._raw(b'%d 0 obj\n' % num + body + b'\nendobj\n')

    def page(self, canvas, key):
        data = zlib.compress(canvas.data().encode('latin-1'), 6)
        c, p = self.next, self.next + 1
        self.next += 2
        self._obj(c, b'<< /Length %d /Filter /FlateDecode >>\nstream\n' % len(data) + data + b'\nendstream')
        self._obj(p, b'<< /Type /Page /Parent 2 0 R /MediaBox [0 0 %d %d] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> '
                     b'/Contents %d 0 R >>' % (int(PAGE_W), int(PAGE_H), c))
        self.pages.append((key, p))

    def close(self):
        kids = [p for _, p in sorted(self.pages, key=lambda x: x[0])]
        self._obj(2, b'<< /Type /Pages /Kids [' + b' '.join(b'%d 0 R' % k for k in kids) + b'] /Count %d >>' % len(kids))
        xref = self.pos
        n = self.next
        rows = [b'0000000000 65535 f \n'] + [(b'%010d 00000 n \n' % self.offsets[k]) if k in self.offsets else b'0000000000 65535 f \n'
                                             for k in range(1, n)]
        self._raw(b'xref\n0 %d\n' % n + b''.join(rows))
        self._raw(b'trailer\n<< /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (n, xref))
        self.f.close()
        os.replace(self.path + '.tmp', self.path)
        return len(kids)

    def abort(self):
        try:
            self.f.close()
            os.remove(self.path + '.tmp')
        except OSError:
            pass


# ------------------------------------------------------------------ one trade's chart
def _nice_step(span, ticks=6):
    """A round price step giving about `ticks` grid lines."""
    if not span > 0:
        return 1.0
    raw = span / float(ticks)
    mag = 10 ** math.floor(math.log10(raw))
    for m in (1, 2, 2.5, 5, 10):
        if m * mag >= raw:
            return m * mag
    return 10 * mag


def _labels_apart(items, lo, hi, gap=10.0):
    """[(y, text, color)] -> the same with y moved apart (at least `gap`), kept between lo and hi."""
    items = sorted(items, key=lambda x: x[0])
    for k in range(1, len(items)):
        if items[k][0] - items[k - 1][0] < gap:
            items[k] = (items[k - 1][0] + gap,) + items[k][1:]
    if items and items[-1][0] > hi:
        shift = items[-1][0] - hi
        items = [(y - shift,) + tuple(rest) for y, *rest in items]
        for k in range(len(items) - 2, -1, -1):
            if items[k + 1][0] - items[k][0] < gap:
                items[k] = (items[k + 1][0] - gap,) + items[k][1:]
    return [(max(lo, y),) + tuple(rest) for y, *rest in items]


# ------------------------------------------------------------------ words that keep off the candles
class Placer:
    """Puts the chart's words where they cover no candle (owner, 12-Nov-2026: "these words should not overwrited on the
    candle and price movement"): a word starts next to its point and moves up (or down, or a little sideways) past every
    candle, mark and earlier word in the way; lines (levels) are kept clear too when there is room. `cols` = (x of the first
    column, column width, [(y bottom, y top) of each column's candle]) - a word never sits in a column's candle range."""

    def __init__(self, box, cols=None):
        self.x0, self.y0, self.x1, self.y1 = box
        self.cols = cols
        self.hard = []                       # words and marks already placed: (x0, x1, y0, y1)
        self.soft = []                       # lines

    def block(self, xa, xb, ya, yb, soft=False):
        (self.soft if soft else self.hard).append((min(xa, xb), max(xa, xb), min(ya, yb), max(ya, yb)))

    def _hit(self, xa, xb, ya, yb, soft):
        if self.cols:
            xl, slot, spans = self.cols
            j0 = max(0, int((xa - xl) / slot))
            j1 = min(len(spans) - 1, int((xb - xl) / slot))
            for j in range(j0, j1 + 1):
                ca, cb = spans[j]
                if ca < yb and cb > ya:
                    return ca, cb
        for a, b, c, d in self.hard:
            if a < xb and b > xa and c < yb and d > ya:
                return c, d
        if soft:
            for a, b, c, d in self.soft:
                if a < xb and b > xa and c < yb and d > ya:
                    return c, d
        return None

    def _free(self, cx, w, h, y, up, soft):
        xa, xb = cx - w / 2.0, cx + w / 2.0
        for _ in range(300):
            if y < self.y0 + 1 or y + h > self.y1 - 1:
                return None
            hit = self._hit(xa, xb, y, y + h, soft)
            if hit is None:
                return y
            y = hit[1] + 0.8 if up else hit[0] - h - 0.8
        return None

    def place(self, ax, ay, w, h, up=True, gap=3.0):
        """A w x h box for a word belonging to the point (ax, ay) -> (centre x, bottom y, free = it covers nothing)."""
        best = None
        for soft in (True, False):
            for side in (up, not up):
                for dx in (0.0, -0.6 * w, 0.6 * w, -1.2 * w, 1.2 * w):
                    cx = min(max(ax + dx, self.x0 + w / 2.0 + 1), self.x1 - w / 2.0 - 1)
                    y_0 = ay + gap if side else ay - gap - h
                    y = self._free(cx, w, h, y_0, side, soft)
                    if y is None:
                        continue
                    cost = abs(y - y_0) + abs(cx - ax) * 0.8 + (0 if side == up else 30)
                    if best is None or cost < best[0]:
                        best = (cost, cx, y)
            if best:
                break
        if best is None:
            cx, y = ax, (ay + gap if up else ay - gap - h)
        else:
            cx, y = best[1], best[2]
        self.hard.append((cx - w / 2.0 - 1.2, cx + w / 2.0 + 1.2, y - 1.2, y + h + 1.2))
        return cx, y, best is not None


def _short(v):
    """A volume in few characters: 2.3 Cr / 45.1 L / 8,200."""
    return '%.1f Cr' % (v / 1e7) if v >= 1e7 else '%.1f L' % (v / 1e5) if v >= 1e5 else '{:,}'.format(int(round(v)))


class Chart:
    """Candles of cs[a .. b] in a box (several candles a bar when `max_bars` is smaller - the overview), the scales, and
    marks / words / lines placed with a Placer."""

    def __init__(self, cv, cs, a, b, box, levels=(), max_bars=0, intraday=False, pad=0.12, font=6.5):
        self.cv, self.cs, self.a, self.b, self.intraday, self.font = cv, cs, a, b, intraday, font
        self.x0, self.y0, self.x1, self.y1 = box
        n = b - a + 1
        self.m = m = 1 if not max_bars or n <= max_bars else -(-n // max_bars)
        f2 = lambda v: round(float(v), 2)
        bars = []
        for s0 in range(a, b + 1, m):
            s1 = min(b, s0 + m - 1)
            bars.append((s0, s1, f2(cs.o[s0]), max(f2(cs.h[k]) for k in range(s0, s1 + 1)),
                         min(f2(cs.l[k]) for k in range(s0, s1 + 1)), f2(cs.c[s1])))
        self.bars = bars
        self.slot = (self.x1 - self.x0) / float(len(bars))
        vals = [x for x in [r[3] for r in bars] + [r[4] for r in bars] + [v for v in levels if v is not None] if x == x]
        lo, hi = min(vals), max(vals)
        sp = (hi - lo) or hi * 0.04 or 1
        self.lo, self.hi = lo - sp * pad, hi + sp * pad
        bw = max(0.6, self.slot * 0.62)
        self.bw = bw
        spans = []
        for r in bars:
            spans.append((self.Y(r[4]) - 1.5, self.Y(r[3]) + 1.5))
        self.place = Placer(box, (self.x0, self.slot, spans))
        self.words = []                      # (text, x0, x1, y0, y1, placed free)
        if WATCH is not None:
            WATCH.append(self)

    def X(self, k):
        k = min(max(k, self.a), self.b)
        return self.x0 + ((k - self.a) // self.m + 0.5) * self.slot

    def Y(self, p):
        return self.y0 + (p - self.lo) / (self.hi - self.lo) * (self.y1 - self.y0)

    def inside(self, k):
        return self.a <= k <= self.b

    def frame(self, dates=9, dates_y=None):
        cv = self.cv
        dy = self.y0 if dates_y is None else dates_y      # the date axis (under the volume panel when there is one)
        cv.rect(self.x0, self.y0, self.x1 - self.x0, self.y1 - self.y0, fill=(1, 1, 1), stroke=(0.85, 0.87, 0.9))
        step = _nice_step(self.hi - self.lo, 8 if self.y1 - self.y0 > 300 else 5)
        p = (int(self.lo / step) + 1) * step
        while p < self.hi:
            cv.line(self.x0, self.Y(p), self.x1, self.Y(p), GRID, 0.4)
            cv.text(self.x0 - 4, self.Y(p) - 2.5, money(p) if step < 1 else money(p)[:-3], self.font, AXIS, align='right')
            p += step
        nb = len(self.bars)
        every = max(1, int(round(nb / float(dates))))
        for j in range(0, nb, every):
            k = self.bars[j][0]
            x = self.x0 + (j + 0.5) * self.slot
            cv.line(x, dy, x, dy - 3, AXIS, 0.4)
            cv.text(x, dy - 11, day_text(self.cs.day[k], self.cs.minute[k], self.intraday and self.m == 1,
                                              year=not (self.intraday and self.m == 1)), self.font, AXIS, align='center')

    def volume(self, y0, y1, mark=None, note=''):
        """The volume of every bar in a panel under the chart (y0 .. y1, owner, 12-Nov-2026: "Add volumes in our backtest
        chart too"): green / red like the candles, the CHoCH move's bars (`mark` = candle range) darker, the 20-bar average
        as a line, `note` written in the panel."""
        cv, cs = self.cv, self.cs
        cv.rect(self.x0, y0, self.x1 - self.x0, y1 - y0, fill=(1, 1, 1), stroke=(0.85, 0.87, 0.9))
        v = getattr(cs, 'v', None)
        vols = [sum(float(v[k]) for k in range(r[0], r[1] + 1)) if v is not None else 0.0 for r in self.bars]
        top = max(vols) if vols else 0.0
        if not top > 0:
            cv.text(self.x0 + 4, y1 - 9, 'Volume - not in the data of this stock', 6.5, AXIS)
            return
        sc = (y1 - y0 - 12) / top
        for j, (s0, s1, o, h, l, c) in enumerate(self.bars):
            x = self.x0 + (j + 0.5) * self.slot
            col = UP if c >= o else DOWN
            strong = mark is not None and s0 <= mark[1] and s1 >= mark[0]
            fill = tuple(1 - (1 - q) * (0.95 if strong else 0.45) for q in col)
            cv.rect(x - self.bw / 2, y0, self.bw, max(0.3, vols[j] * sc), fill=fill)
        pts = []
        for j in range(len(vols)):
            w = vols[max(0, j - 20):j]
            if len(w) >= 10:
                pts.append((self.x0 + (j + 0.5) * self.slot, y0 + sum(w) / len(w) * sc))
        if len(pts) > 1:
            cv.polyline(pts, AXIS, 0.6)
        cv.text(self.x0 + 4, y1 - 8, 'Volume (grey line = 20-candle average%s)%s' % (
            '; the CHoCH move darker' if mark is not None else '', ('  -  ' + note) if note else ''), 6.5, MUTED)
        cv.text(self.x0 - 4, y0 + top * sc - 2.5, _short(top), self.font, AXIS, align='right')

    def candles(self):
        cv, bw = self.cv, self.bw
        for j, (s0, s1, o, h, l, c) in enumerate(self.bars):
            x = self.x0 + (j + 0.5) * self.slot
            col = UP if c >= o else DOWN
            cv.line(x, self.Y(l), x, self.Y(h), WICK if self.slot < 3 else col, 0.5)
            top, bot = max(o, c), min(o, c)
            cv.rect(x - bw / 2, self.Y(bot), bw, max(0.5, self.Y(top) - self.Y(bot)), fill=col)

    def zone(self, k1, k2, zb, zt, fill):
        xa = self.X(k1) - self.slot / 2
        xb = self.X(k2) + self.slot / 2
        self.cv.rect(xa, self.Y(zb), xb - xa, max(0.6, self.Y(zt) - self.Y(zb)), fill=fill, stroke=(0.62, 0.72, 0.9), width=0.5)

    def hline(self, k1, k2, p, color, width=1.0, dash=None, half=True):
        xa = self.X(k1) - (self.slot / 2 if half else 0)
        xb = self.X(k2) + (self.slot / 2 if half else 0)
        self.cv.line(xa, self.Y(p), xb, self.Y(p), color, width, dash)
        self.place.block(xa, xb, self.Y(p) - 1.5, self.Y(p) + 1.5, soft=True)

    def tri(self, k, p, up, color, size=3.2, off=4.0):
        """A triangle under (up = pointing up) / over a price - returns the y next to it for a word."""
        x, y = self.X(k), self.Y(p) + (-off if up else off)
        self.cv.tri(x, y, size, up, color)
        ya, yb = (y - size, y) if up else (y, y + size)
        self.place.block(x - size * 0.7, x + size * 0.7, min(ya, yb) - 0.5, max(ya, yb) + 0.5)
        return y - size if up else y + size

    def word(self, k, ay, text, color, up=True, size=None, bold=True, gap=2.5, leader=True):
        """A word next to the point (X(k), ay) - moved off the candles; a thin line back to the point when moved away."""
        size = size or self.font
        w = text_width(text, size) * (1.06 if bold else 1.0)
        h = size * 0.95
        ax = self.X(k)
        cx, y, free = self.place.place(ax, ay, w, h, up, gap)
        self.words.append((text, cx - w / 2.0, cx + w / 2.0, y, y + h, free))
        far = (y - (ay + gap)) if up else ((ay - gap - h) - y)
        if leader and (far > 4 or abs(cx - ax) > w / 2.0 + 2):
            ty = y if y > ay else y + h
            tx = min(max(ax, cx - w / 2.0), cx + w / 2.0)
            self.cv.line(ax, ay, tx, ty, color, 0.35, dash=(1, 1))
        self.cv.text(cx, y + size * 0.2, text, size, color, bold=bold, align='center')
        return cx, y


# ------------------------------------------------------------------ the swings as the structure saw them
def swing_seq(s, upto=None):
    """The alternating swings structure.choch_events works on (a second high before a low keeps the higher one, a second
    low the lower one), known by candle `upto` (None = all): [[candle, price, is_high, known on], ...]."""
    if s is None:
        return []
    both = set(s.ph) & set(s.pl)
    items = sorted([(c, p, True, v) for p, c, v in zip(s.ph, s.phc, s.phv) if p not in both] +
                   [(c, p, False, v) for p, c, v in zip(s.pl, s.plc, s.plv) if p not in both])
    sw = []
    for c, p, is_h, v in items:
        if upto is not None and c > upto:
            break
        if sw and sw[-1][2] == is_h:
            if (is_h and v > sw[-1][1]) or (not is_h and v < sw[-1][1]):
                sw[-1] = [p, v, is_h, c]
        else:
            sw.append([p, v, is_h, c])
    return sw


def swing_tags(sw, tol=None):
    """Each swing against the one before of its kind: 'HH' / 'LH' (highs), 'HL' / 'LL' (lows), 'EQH' / 'EQL' within the
    run's equal-highs tolerance (`tol(candle)` -> price); the first high / low of the list: 'H' / 'L'."""
    out = []
    for k, (p, v, is_h, c) in enumerate(sw):
        prev = sw[k - 2][1] if k >= 2 else None
        t = tol(p) if tol else 0.0
        if prev is None:
            out.append('H' if is_h else 'L')
        elif v > prev + t:
            out.append('HH' if is_h else 'HL')
        elif v < prev - t:
            out.append('LH' if is_h else 'LL')
        else:
            out.append('EQH' if is_h else 'EQL')
    return out


def context(t, cs, s, P, extra=None):
    """What both pages of a trade need: the CHoCH, the swings it counted, the BOS, the move high, the Fib line."""
    extra = extra or {}
    f2 = lambda v: round(float(v), 2)
    c = {'ev': None, 'highs': [], 'lows': [], 'seq': extra.get('seq') or [], 'atr': extra.get('atr')}
    k = t.get('k', -1)
    i = t['i']
    if s is None or k is None or k < 0 or k >= len(s.events):
        return c
    ev = s.events[k]
    b, hi_c, lvl, li, lf, d = ev
    c['ev'] = ev
    sb = swing_seq(s, upto=b)
    q = next((x for x in range(len(sb) - 1, -1, -1) if sb[x][2] and sb[x][0] == hi_c), None)
    if q is not None and q - 2 * d >= 0:
        c['highs'] = [sb[x] for x in range(q - 2 * d, q + 1, 2)]
    if q is not None and q - 1 - 2 * (d - 1) >= 0:
        c['lows'] = [sb[x] for x in range(q - 1 - 2 * (d - 1), q, 2)]
    # the BOS (any time after the CHoCH) and the BOS level known at the signal
    bos = s.bos_before(k, cs.c, cs.n)
    c['bos'] = bos
    c['bosPeak'] = s.st[k][3] if k in s.st else None
    peak_i = None
    for p_, v_, kc in zip(s.ph, s.phv, s.phc):
        if p_ > b and kc <= i - 1 and (peak_i is None or v_ > peak_i):
            peak_i = v_
    c['peakAtSignal'] = peak_i
    c['dead'] = s.dead_by(k, cs.c, cs.n - 1)
    H = t.get('H')
    if H is None and li < i:
        H = max(f2(cs.h[x]) for x in range(li, i))
    c['H'] = H
    c['mh'] = None
    if H is not None and li < i:
        c['mh'] = max(range(li, i), key=lambda x: (f2(cs.h[x]), -x))
    fib = P.get('discount') or 0
    c['fib'] = fib
    c['fibLine'] = H - fib * (H - lf) if (H is not None and fib) else None
    c['half'] = H - 0.5 * (H - lf) if H is not None else None
    return c


EXIT_WORD = {'stop': 'STOP HIT', 'target': 'TARGET', 'be': 'BREAKEVEN', 'trail': 'TRAIL EXIT', 'lock': 'TARGET LOCKED', 'ema': 'EMA EXIT', 'time': 'TIME EXIT',
             'tstop': 'TIME STOP', 'open': 'STILL OPEN'}
TAG_COL = {'HH': (0.10, 0.55, 0.30), 'HL': (0.10, 0.55, 0.30), 'LH': (0.80, 0.22, 0.22), 'LL': (0.80, 0.22, 0.22),
           'EQH': MUTED, 'EQL': MUTED, 'H': MUTED, 'L': MUTED}


def window(t, cs, s, cx=None):
    """The candles a trade's chart shows: from before the counted lower highs / the CHoCH's swing high / the zone (else 60
    candles before the signal) to 15 candles after the exit, at most MAX_WINDOW."""
    i, jx = t['i'], t.get('jx', t['i'])
    start = i - 60
    zf = t.get('zf')
    if zf is not None and zf >= 0:
        start = min(start, zf - 8)
    if s is not None and t.get('k', -1) is not None and t.get('k', -1) >= 0:
        b, hi, lvl, li, lf, d = s.events[t['k']]
        start = min(start, hi - 15)
    if cx and cx.get('highs'):
        start = min(start, cx['highs'][0][0] - 5)
    end = min(cs.n - 1, max(jx, i) + 15)
    start = max(0, start, end - MAX_WINDOW + 1)
    return start, end


def chart_page(pdf, key, t, cs, s, P, page_no, pages, run_name, cx, emas=None):
    """Page 1 of a trade: its chart - every swing tagged HH / HL / LH / LL, the CHoCH, the final low, the move high, the
    BOS, the zone, BUY and the exit, each word off the candles; the levels in the right-hand column."""
    cv = Canvas()
    tf = P.get('tf', 'D')
    intraday = tf == '4H'
    start, end = window(t, cs, s, cx)
    i, jx = t['i'], min(end, t.get('jx', t['i']))
    f2 = lambda v: round(float(v), 2)
    ev = cx['ev']
    zb, zt, zf = t.get('zb'), t.get('zt'), t.get('zf')
    levels = [t['entry'], t['stop'], t.get('tgt'), zb, zt, t.get('fibLine')] + ([t['fz'][0], t['fz'][1]] if t.get('fz') else [])
    z1 = t.get('z1')                          # the 1st discount zone of the move, only watched (the 2nd-zone rule)
    if z1 and z1[2] is not None and z1[2] >= start:
        levels += [z1[0], z1[1]]
    if ev:
        levels += [ev[2], ev[4]]
    if cx.get('fibLine') is not None:
        levels.append(cx['fibLine'])
    x0, x1, y0, y1 = 46.0, PAGE_W - 128.0, 98.0, PAGE_H - 96.0
    ch = Chart(cv, cs, start, end, (x0, y0, x1, y1), levels, intraday=intraday)
    ch.frame(dates_y=40.0)
    mark = (ev[3], ev[0]) if ev else None
    ch.volume(40.0, 92.0, mark, ('the CHoCH move\'s biggest volume = %s the 20 candles before it' % _times_x(t['mv'])) if t.get('mv') else '')
    gap_zone = t.get('code') in ('G', 'Y')
    za = None
    if zb is not None and zt is not None and zf is not None and zf >= 0:
        za = max(start, zf - (1 if gap_zone else 2))
        fz = t.get('fz')
        if fz:                                # the FVG around the Gap-up zone the order waited in (12-Nov-2026)
            ch.zone(max(start, fz[2] - 2), max(za, jx), fz[0], fz[1], ZONE_FVG)
        ch.zone(za, max(za, jx), zb, zt, ZONE_GAP if gap_zone else ZONE_FVG)
    if z1 and z1[2] is not None and z1[2] >= start:
        z1a = max(start, z1[2] - 2)
        ch.zone(z1a, max(z1a, i), z1[0], z1[1], WATCHED)
    for ln, series in sorted((emas or {}).items()):
        cv.polyline([(ch.X(k), ch.Y(series[k])) for k in range(start, end + 1) if ch.lo < series[k] < ch.hi], EMA_COL.get(ln, MUTED), 0.6)
    ch.candles()
    right = []
    # lines first (words keep clear of them when there is room)
    if ev:
        b, hi_c, lvl, li, lf, d = ev
        if b >= start:
            ch.hline(max(start, hi_c), b, lvl, CHOCH, 1.0, dash=(4, 2))
        right.append((ch.Y(lvl), 'CHoCH %s' % money(lvl), CHOCH))
        if cx.get('bos', -1) >= 0 and start <= cx['bos'] <= end and cx.get('bosPeak') is not None:
            ch.hline(max(start, cx['bos'] - 12), cx['bos'], cx['bosPeak'], BOS, 0.8)
        if cx.get('fibLine') is not None:
            ch.hline(max(start, li), i, cx['fibLine'], FIB, 0.9, dash=(1.5, 1.5))
            right.append((ch.Y(cx['fibLine']), '%g%% %s' % (cx['fib'] * 100, money(cx['fibLine'])), FIB))
    if t.get('fibLine') is not None and za is not None:        # the zone's Fib line the pattern held (12-Nov-2026)
        ch.hline(za, i, t['fibLine'], FIB, 0.8, dash=(3, 1.5))
        right.append((ch.Y(t['fibLine']), 'Zone %g%% %s' % (P.get('fibLevel', 0.618) * 100, money(t['fibLine'])), FIB))
    if str(t.get('pid') or '').startswith('B') and t.get('trig') is not None:      # the breakout level (Pattern library)
        ch.hline(max(start, i - 20), i, t['trig'], MUTED, 0.8, dash=(3, 1.5))
        right.append((ch.Y(t['trig']), 'Breakout level %s' % money(t['trig']), MUTED))
    ch.hline(i, jx, t['entry'], ENTRY, 1.1)
    ch.hline(i, jx, t['stop'], STOP, 1.1)
    if t.get('tgt') is not None:
        ch.hline(i, jx, t['tgt'], TARGET, 1.1, dash=(4, 2))
        right.append((ch.Y(t['tgt']), 'Target %s' % money(t['tgt']), TARGET))
    right.append((ch.Y(t['entry']), 'Entry %s' % money(t['entry']), ENTRY))
    right.append((ch.Y(t['stop']), 'Stop %s' % money(t['stop']), STOP))
    if zb is not None:
        right.append((ch.Y(zt), 'Zone top %s' % money(zt), (0.35, 0.45, 0.7)))
        right.append((ch.Y(zb), 'Zone bottom %s' % money(zb), (0.35, 0.45, 0.7)))
    if t.get('fz'):
        right.append((ch.Y(t['fz'][0]), 'FVG bottom %s' % money(t['fz'][0]), (0.35, 0.45, 0.7)))
    # the trade's own marks first (they matter most), then the structure words
    ya = ch.tri(i, f2(cs.l[i]), True, ENTRY, 4.2, 3.0)
    ch.word(i, ya, 'BUY', ENTRY, up=False, size=7.5)
    ex = t.get('xr', t['exit'])               # the rest's exit (with a part sold at the target, t['exit'] is the average)
    ecol = TARGET if t['R'] > 0 else STOP if t['R'] < 0 else MUTED
    xx, yx = ch.X(jx), ch.Y(ex)
    if t.get('part') is not None:
        right.append((ch.Y(t['part']), '%g%% sold %s' % (t.get('partPct', 50), money(t['part'])), TARGET))
    cv.line(xx - 3, yx - 3, xx + 3, yx + 3, ecol, 1.4)
    cv.line(xx - 3, yx + 3, xx + 3, yx - 3, ecol, 1.4)
    ch.place.block(xx - 3.5, xx + 3.5, yx - 3.5, yx + 3.5)
    right.append((yx, 'Exit %s' % money(ex), ecol))
    ch.word(jx, yx + (3 if t['R'] > 0 else -3), EXIT_WORD.get(t['reason'], t['reason'].upper()), ecol, up=t['R'] > 0, size=7)
    if z1 and z1[2] is not None and z1[2] >= start:
        ch.word(max(start, z1[2] - 2), ch.Y(z1[1]), '1st zone (watched only)', MUTED, up=True, size=6.5)
    if za is not None:
        name = 'Gap-up zone' + (' (inside FVG)' if t.get('inside') or t.get('fz') else '') if gap_zone else 'FVG zone'
        ch.word(za, ch.Y(zt), name, (0.30, 0.42, 0.75), up=True, size=7)
    # swings: a triangle + HH / HL / LH / LL (the final low and the move high named too)
    seq = cx.get('seq') or []
    atr = cx.get('atr')
    eq = P.get('eqAtr') or 0
    tags = swing_tags(seq, (lambda p: eq * atr[p]) if eq and atr else None)
    li = ev[3] if ev else None
    mh = cx.get('mh')
    for (p, v, is_h, kc), tag in zip(seq, tags):
        if not start <= p <= end:
            continue
        name = tag
        if not is_h and li is not None and p == li:
            name += ' - final low'
        if is_h and mh is not None and p == mh:
            name += ' - move high'
        col = TAG_COL.get(tag, MUTED)
        if is_h:
            yy = ch.tri(p, v, False, SWING)
            ch.word(p, yy, name, col, up=True, size=6.5)
        else:
            yy = ch.tri(p, v, True, SWING)
            ch.word(p, yy, name, col, up=False, size=6.5)
    seq_lows = set(p for p, v, h_, kc in seq if not h_)
    seq_highs = set(p for p, v, h_, kc in seq if h_)
    if ev:
        b, hi_c, lvl, li, lf, d = ev
        if b >= start:
            ch.word(b, ch.Y(f2(cs.h[b])) + 1.5, 'CHoCH', CHOCH, up=True, size=7.5)
        if start <= li <= end and li not in seq_lows:
            ch.word(li, ch.Y(lf) - 1.5, 'final low', CHOCH, up=False, size=6.5)
        if mh is not None and start <= mh <= end and mh not in seq_highs:
            ch.word(mh, ch.Y(f2(cs.h[mh])) + 1.5, 'move high', MUTED, up=True, size=6.5)
        if cx.get('bos', -1) >= 0 and start <= cx['bos'] <= end and cx.get('bosPeak') is not None:
            ch.word(cx['bos'], ch.Y(cx['bosPeak']) + 1.5, 'BOS', BOS, up=True, size=7.5)
        if b < start:
            cv.text(x0, y1 + 5, 'The CHoCH (%s) is before this chart - it came %s before this trade (page 2 tells the story).' % (
                day_text(cs.day[b], cs.minute[b], intraday), _span(cs.day[t['i']] - cs.day[b])), 7, CHOCH, bold=True)
    for y, txt, col in _labels_apart(right, y0 + 2, y1 - 6):
        cv.text(x1 + 6, y - 2.5, txt, 7, col, bold=True)
    # header + footer
    reason = REASON.get(t['reason'], t['reason'])
    r_txt = '%+.2fR' % t['R'] if t['reason'] != 'open' else 'still open (%+.2fR now)' % t['R']
    cv.text(x0, PAGE_H - 34, '%s  -  %s  -  signal %s' % (t['sym'], TF_NAME.get(tf, tf), day_text(cs.day[i], cs.minute[i], intraday)),
            14, INK, bold=True)
    cv.text(PAGE_W - 30, PAGE_H - 34, '%s   %s' % (r_txt, reason), 14, ecol, bold=True, align='right')
    jx_full = t.get('jx', t['i'])
    ex_txt = money(ex) if t.get('part') is None else '%s (%g%% at %s, the rest %s)' % (
        money(t['exit']), t.get('partPct', 50), money(t['part']), money(ex))
    line2 = '%s - entry %s - stop %s%s (risk %.2f%%) - target %s - exit %s on %s after %d day%s - best %.2fR - %s' % (
        (t.get('pname') or ZONE_NAME.get(t['code'], t['code'])) + (' (%s)' % WHERE.get(t.get('where'), '') if t.get('where') in WHERE else ''),
        money(t['entry']), money(t['stop']), ' (%g x ATR)' % P.get('stopAtr') if t.get('stopBy') == 'atr' else '', t['riskPct'],
        money(t['tgt']) if t.get('tgt') is not None else '-', ex_txt,
        day_text(cs.day[jx_full], cs.minute[jx_full], intraday), t['days'], '' if t['days'] == 1 else 's', t['maxR'],
        'in the account' if t.get('taken') else 'not taken by the account')
    cv.text(x0, PAGE_H - 52, line2, 8, MUTED)
    if t.get('struct'):
        cv.text(x0, PAGE_H - 65, t['struct'][:190], 7.5, CHOCH)
    if t.get('ema'):
        cv.text(x0, PAGE_H - 77, 'EMA: ' + t['ema'], 7.5, MUTED)
    if emas:
        lx = x1 - 4
        for ln in sorted(emas, reverse=True):
            cv.text(lx, y1 + 5, '%d EMA' % ln, 6.5, EMA_COL.get(ln, MUTED), align='right')
            lx -= 34
    cv.text(x0, 18, 'Stock Blueprint Backtest Lab - %s - page 1 of 2 of this trade: the chart (next page: why this trade, how it ended)' % run_name[:60],
            6.5, AXIS)
    cv.text(PAGE_W - 30, 18, 'page %d of %d' % (page_no, pages), 6.5, AXIS, align='right')
    pdf.page(cv, key)


# ------------------------------------------------------------------ page 2: why this trade, how it ended
def _wrap(s, width, size, bold=False):
    out, line = [], ''
    k = 1.06 if bold else 1.0
    for word in str(s).split(' '):
        cand = (line + ' ' + word) if line else word
        if line and text_width(cand, size) * k > width:
            out.append(line)
            line = word
        else:
            line = cand
    if line:
        out.append(line)
    return out


def _check(cv, x, y, color):
    cv.line(x, y + 3, x + 2.2, y + 0.6, color, 1.3)
    cv.line(x + 2.2, y + 0.6, x + 6, y + 6, color, 1.3)


def _cross(cv, x, y, color):
    cv.line(x, y, x + 5.5, y + 5.5, color, 1.3)
    cv.line(x, y + 5.5, x + 5.5, y, color, 1.3)


def _list(words):
    words = [w for w in words if w]
    if len(words) < 2:
        return ''.join(words)
    return ', '.join(words[:-1]) + ' and ' + words[-1]


def _span(days):
    if days >= 730:
        return 'about %d years' % round(days / 365.25)
    if days >= 365:
        return 'more than a year'
    if days >= 60:
        return 'about %d months' % round(days / 30.44)
    if days >= 14:
        return 'about %d weeks' % round(days / 7.0)
    return '%d day%s' % (days, '' if days == 1 else 's')


def _times(x):
    """1.0 -> 'one time', 2 -> '2 times', 1.5 -> '1.5 times'."""
    return 'one time' if abs(x - 1) < 1e-9 else '%g times' % x


def why_story(t, cs, s, P, cx):
    """Why the backtest took this trade, in plain sentences (owner, 12-Nov-2026: "why this trade should not numericals and
    with chart. it should be readable format like in sentences") -> [paragraph, ...] in the order a trader reads the chart."""
    tf = P.get('tf', 'D')
    intraday = tf == '4H'
    dt = lambda k: day_text(cs.day[k], cs.minute[k], intraday)
    i = t['i']
    out = []
    ev = cx.get('ev')
    only = P.get('structure') == 'only'
    zb, zt, zf = t.get('zb'), t.get('zt'), t.get('zf')
    gap = t.get('code') in ('G', 'Y')
    zone_name = ('a gap-up zone (the price jumped up and left a gap between two candles%s)' % (
        ', in the middle of two big green candles - an "inside FVG"' if t.get('inside') else '')) if gap else \
        'an FVG zone (a fair value gap: the price moved up so fast that it skipped this price area)'
    has_zone = zb is not None and zt is not None and zf is not None and zf >= 0
    if ev:
        b, hi_c, lvl, li, lf, d = ev
        lh = '%d lower high%s and %d lower low%s' % (d, '' if d == 1 else 's', d, '' if d == 1 else 's')
        out.append('The stock was falling. It made %s in a row - every bounce stopped lower than the one before, and every fall '
                   'went lower. The fall ended at the final low on %s.%s' % (lh, dt(li), (' Your setup asks for at least %d.' % P.get('downN', 1)) if only else ''))
        prot = P.get('chochMode') == 'protected'
        out.append('Then the trend changed. On %s the price closed above %s. This is the CHoCH (change of character): the first sign '
                   'that the fall is over and buyers are taking control.' % (dt(b), 'the protected high (the high that started the last '
                                                                             'fall to the lowest low)' if prot else 'the last swing high'))
        if has_zone:
            when = 'In the rise that followed' if zf > b + 1 else 'In the same rise that made the CHoCH'
            out.append('%s, the price left %s. It formed on %s, after the final low - so it belongs to the new up-move.' % (when, zone_name, dt(zf)))
        mh = cx.get('mh')
        if cx.get('H') is not None and mh is not None:
            dep = t.get('depth')
            fib = cx.get('fib') or 0
            txt = 'The rise went up to its high on %s.' % dt(mh)
            if dep is not None:
                part = {'mid': 'middle', 'top': 'top', 'bottom': 'bottom'}.get(P.get('discPart'), 'middle')
                where = 'the cheaper lower part' if dep >= 0.5 else 'the upper part'
                txt += ' The zone sat in %s of that rise - its %s about %d%% of the way down from the high.' % (where, part, round(dep * 100))
                if fib and only:
                    txt += ' Your setup buys only when it is at least %g%% down (the discount part), where the risk is smaller.' % (fib * 100)
            out.append(txt)
    else:
        out.append('Market structure was not part of this run, and there was no live CHoCH before this signal.' if not only else
                   'The market structure rules of this run were met.')
        if has_zone:
            out.append('Before the signal the price left %s on %s.' % (zone_name, dt(zf)))
    if ev and t.get('mit') is not None:
        m = t['mit']
        out.append(('Before the rise reached its high, no candle touched this zone - it was fresh.' if not m else
                    'Before the rise reached its high, %s touched this zone with a wick and none closed under its middle - '
                    'your rule allows at most 2.' % ('one candle' if m == 1 else '%d candles' % m)))
    if ev and t.get('again'):
        out.append('Price had already touched this zone once while the rise was forming (before the CHoCH). Your rule counts '
                   'its first touch after the CHoCH again - this one.')
    if ev and t.get('zn') == 2:
        out.append('Price had already come down to a higher discount zone of the same rise. Your rule only watches that 1st '
                   'zone; the trade is taken in the 2nd zone under it - this one.')
    if ev and t.get('mv'):
        mv = P.get('moveVol') or 0
        out.append('Volume in the rise that made the CHoCH: its biggest candle traded %s the normal volume (the 20 candles '
                   'before the rise).%s' % (_times_x(t['mv']), (' Your rule asks for at least %s on %d candle%s.' % (
                       _times_x(mv), P.get('moveVolN', 1), '' if P.get('moveVolN', 1) == 1 else 's')) if mv and only else ''))
    code = t.get('code')
    if t.get('fz'):
        out.append('Inside that move\'s FVG there was a smaller gap-up zone, so your order waited at the top of the gap-up zone '
                   'instead of the top of the whole FVG - the stop stays under the FVG\'s bottom.')
    if code in ('P', 'Q'):
        lvl = P.get('fibLevel', 0.618)
        big = P.get('fibPat') == 'big'
        txt = ('On %s a %s formed with its low right at the zone\'s %g%% Fibonacci line (drawn from the zone bottom to its top) '
               'and closed above it - buyers defended that line.%s' % (dt(i), t.get('pat') or 'pattern', lvl * 100,
               ' The zone was bigger than your size limit, so the backtest waited for this pattern instead of buying at the zone top.' if big else ''))
    elif code in ('Z', 'Y', 'T'):
        txt = 'On %s the price came back down to the zone for the first time since it formed.' % dt(i)
    elif code == 'C':
        txt = 'On %s the price came back to the zone for the first time and the candle closed back up (a confirmed first touch).' % dt(i)
    elif code in ('S', 'F', 'G'):
        txt = ('On %s a Spring candle formed%s: the price dipped below the red candle before it and closed back above its low - '
               'sellers pushed down, buyers pushed back.' % (dt(i), ' on the zone' if has_zone else ''))
    elif code == 'K':
        txt = 'On %s the backtest found %s (Pattern library). %s' % (dt(i), t.get('pname') or 'a pattern', pat_words(t.get('pid')))
    else:
        txt = 'The signal came on %s.' % dt(i)
    if ev:
        bos = cx.get('bos', -1)
        if 0 <= bos < i:
            txt += ' A new higher high (BOS) had already come on %s, so it was not the first pullback - this run allowed that.' % dt(bos)
        else:
            txt += ' No new higher high (BOS) had come yet, so this was the first pullback after the CHoCH - the moment your setup waits for.'
    out.append(txt)
    if ev:
        b = ev[0]
        lag = cs.day[i] - cs.day[b]
        txt = 'The CHoCH was %s before this trade.' % _span(lag)
        if lag > 365 and not P.get('chochAge'):
            txt += (' That is an old CHoCH - a lot can change in that time. The rule "The signal at most N candles after the CHoCH" '
                    '(More rules > Market structure) would leave such trades out.')
        out.append(txt)
    extra = []
    if t.get('ema'):
        extra.append('the EMA rule (%s)' % t['ema'])
    if P.get('mktIndex') and (P.get('mktAbove') or P.get('mktStack')):
        extra.append('%s was %s' % (str(P['mktIndex']).replace('_', ' '), ('above its %s EMA' % P['mktAbove']) if P.get('mktAbove') else 'in an up-trend (EMAs 10 > 21 > 50)'))
    if P.get('wkAbove'):
        extra.append("the stock's weekly trend was up (above its %s-week EMA)" % P['wkAbove'])
    if P.get('minTurnover'):
        extra.append('the stock trades enough every day')
    if P.get('minPrice'):
        extra.append('the price was not too low')
    if extra:
        out.append('It also passed your other rules: %s.' % _list(extra))
    # the plan
    ent = {'zone': 'with an order waiting at the %s top' % ('gap-up zone\'s' if t.get('fz') else 'zone'),
           'close': 'at the close of that candle', 'next_open': "at the next candle's open"}.get(P.get('entry'), '')
    if code in ('P', 'Q'):
        ent = 'at the close of the pattern candle'
    mode = P.get('stop')
    if P.get('entry') == 'zone' and mode in ('spring', 'lower') and code not in ('P', 'Q'):
        mode = 'zone'
    if code == 'K':                          # a Pattern library trade: there is no zone - the pattern's own low (13-Nov-2026)
        stop = {'zone': "just under the pattern's low (the lowest point of its candles)", 'lower': "just under the pattern's low",
                'spring': "just under the signal candle's low"}.get(mode)
    else:
        stop = None
    stop = stop or {'zone': 'just under the %s bottom' % ('FVG\'s' if t.get('fz') else 'zone'), 'spring': "just under that candle's low",
                    'lower': 'under the lower of the zone bottom and the candle low', 'pct': '%g%% under the buy price' % P.get('stopPct', 0),
                    'final': 'just under the final low (the lowest point before the CHoCH)'}.get(mode, '')
    if P.get('stopAtr'):
        stop += ' or %s times the ATR (the usual candle size) under the buy price, whichever is lower' % ('%g' % P['stopAtr'])
    tgt = target_words(P)
    txt = 'The plan: buy %s, put the stop loss %s, and take the target %s.' % (ent, stop, tgt)
    if t.get('stopBy') == 'atr':
        txt += ' Here the ATR stop was the lower one, so it was used.'
    elif t.get('stopBy') == 'rule':
        txt += ' Here the %s stop was the lower one, so the ATR stop was not needed.' % ('percentage' if mode == 'pct' else 'rule\'s')
    if P.get('beAt') and not (P.get('after') == 'fixed' and P['beAt'] >= P.get('targetR', 2) and P.get('targetMode') == 'R'):
        txt += ' Once the price is %s the risk up, the stop moves to the buy price.' % _times(P['beAt'])
    if P.get('timeN'):
        txt += ' If the price has not gone %s the risk up within %d candles, it is sold at that candle\'s close (a time stop).' % (
            _times(P.get('timeR', 1)), P['timeN'])
    if P.get('partialPct') and P.get('after') != 'fixed':
        txt += ' At the target %g%% of the shares are sold.' % P['partialPct']
    if P.get('after') != 'fixed':
        trail = {'lows': 'under the lowest low of the last %s candles' % P.get('trailN'), 'pct': '%g%% under the highest price' % P.get('trailPct', 0),
                 'ema': 'until a close under the %s EMA' % P.get('emaN'), 'atr': '%s x ATR under the highest price' % P.get('atrK'),
                 'swing': 'under each new swing low'}.get(P.get('trail'))
        lock = P.get('lockTarget')
        if trail:
            txt += ' After the target the %s stays open%s and the stop follows the price %s.' % ('rest' if P.get('partialPct') else 'trade',
                ', the stop moves up to the target' if lock else ', the stop moves to the buy price' if P.get('breakeven') else '', trail)
        elif lock:
            txt += ' After the target the trade stays open and the stop moves up to the target.'
    out.append(txt)
    if t.get('zpct') is not None and (P.get('zoneMin') or P.get('zoneMax')):
        out.append('The zone was %s tall - inside your size range.' % _pct_words(t['zpct']))
    return out


def target_words(P):
    """The run's target in words (page 2 - no prices)."""
    m = P.get('targetMode')
    if m == 'swing':
        return 'at the last swing high above'
    if m == 'mh':
        return 'at the high of the CHoCH move (the HH - move high)'
    if m == 'pct':
        return 'when the price is %s%% above the buy price' % ('%g' % P.get('targetPct', 20))
    return 'at %s the risk (%gR)' % (_times(P.get('targetR', 2)), P.get('targetR', 2))


def pat_words(pid):
    """The Pattern library's pattern in plain words (page 2 - no prices): pattern_registry.SPECS 'words' (owner, 13-Nov-2026)."""
    try:
        import pattern_registry
        return (pattern_registry.SPECS.get(pid) or {}).get('words', '')
    except ImportError:
        return ''


def _times_x(x):
    """2 -> 'twice', 3.4 -> '3.4 times'."""
    return 'twice' if abs(x - 2) < 0.05 else ('%g times' % round(x, 1))


def _pct_words(x):
    return 'about %g%%' % (round(x, 1) if x < 10 else round(x))


def end_story(t, cs, s, P, cx):
    """How the trade ended, in plain sentences -> (headline, [sentence, ...], won). For a stop loss: what happened around it."""
    tf = P.get('tf', 'D')
    intraday = tf == '4H'
    dt = lambda k: day_text(cs.day[k], cs.minute[k], intraday)
    f2 = lambda v: round(float(v), 2)
    i, jx, n = t['i'], t.get('jx', t['i']), cs.n
    why, R = t['reason'], t['R']
    days = '%d day%s' % (t['days'], '' if t['days'] == 1 else 's')
    res = ('a loss of about %gR' % round(abs(R), 1)) if R < -0.05 else ('a profit of about %gR' % round(R, 1)) if R > 0.05 else 'about no profit or loss'
    hit_k = None
    if t.get('tgt') is not None:
        for j in range(i, jx + 1):
            if f2(cs.h[j]) >= t['tgt'] - 1e-9 and (j > i or P.get('entry') == 'zone'):
                hit_k = j
                break
    lines = []
    if t.get('part') is not None:
        lines.append('%g%% of the shares were sold at the target%s; the numbers here are for the whole position.' % (
            t.get('partPct', 50), ' (it opened above it - sold at the open)' if t.get('tgt') is not None and t['part'] > t['tgt'] + 1e-9 else ''))
    if why == 'stop':
        head = 'The stop loss was hit on %s, %s after buying - %s.' % (dt(jx), days, res)
        if jx > i and f2(cs.o[jx]) < t['stop'] - 1e-9:
            lines.append('The price opened below the stop (a gap down), so it was sold at the open, a little below the stop.')
        if t.get('hit'):
            lines.append('It had reached the target first; the trade was kept open, but the stop that followed was still below the buy price when the price turned.')
        else:
            m = t['maxR']
            lines.append('It did not go up at all after buying.' if m < 0.1 else
                         'It went up only a little (less than half of the risk) and then fell.' if m < 0.5 else
                         'It went up, but not even one time the risk, and then fell.' if m < 1 else
                         'It first went up about %.1f times the risk, but did not reach the target, and then turned down.' % m)
        if f2(cs.c[jx]) >= t['stop']:
            lines.append('Only the wick went below the stop - the same candle closed back above it. A short dip like this is often a shake-out.')
        else:
            lines.append('The candle closed below the stop - a real break, not just a wick.')
        atr = cx.get('atr')
        if atr and jx < len(atr) and atr[jx] > 0:
            rng = (f2(cs.h[jx]) - f2(cs.l[jx])) / atr[jx]
            vs = [float(x) for x in cs.v[max(0, jx - 20):jx] if x > 0] if hasattr(cs, 'v') else []
            vol = float(cs.v[jx]) / (sum(vs) / len(vs)) if len(vs) >= 10 and cs.v[jx] > 0 else None
            if rng >= 1.8:
                lines.append('The fall came in one big candle - about %d times the usual candle size%s.' % (
                    round(rng), (', with heavy volume (about %d times the usual)' % round(vol)) if vol and vol >= 1.5 else ''))
            elif vol and vol >= 1.5:
                lines.append('That day the volume was heavy - about %d times the usual.' % round(vol))
            else:
                lines.append('It was a normal-sized candle with normal volume - a slow slide, not a crash.')
        zb = t.get('zb')
        if zb is not None:
            under = next((j for j in range(i, jx + 1) if f2(cs.c[j]) < zb), None)
            lines.append(('The zone did not hold: the price closed below it on %s.' % dt(under)) if under is not None else
                         'The price never closed below the zone before the stop.')
        ev = cx.get('ev')
        if ev:
            dead = cx.get('dead', -1)
            if 0 <= dead <= jx:
                lines.append('The trend change failed: the price closed below the final low (where the new up-move started) on %s.' % dt(dead))
            elif dead > jx:
                lines.append('Later, on %s, the price also broke the final low - the new up-move failed.' % dt(dead))
            else:
                lines.append('The final low (where the new up-move started) was never broken afterwards.')
        a, z = jx + 1, min(n - 1, jx + 30)
        if a <= z and t.get('tgt') is not None:
            tk = next((j for j in range(a, z + 1) if f2(cs.h[j]) >= t['tgt']), None)
            if tk is not None:
                lines.append('After the stop, the price turned up and reached the target on %s - the idea was right, but the stop came first.' % dt(tk))
            else:
                lines.append('After the stop, the price did not reach the target in the next %d candles.' % (z - a + 1))
    elif why == 'target':
        head = 'The target was reached on %s, %s after buying - %s.' % (dt(jx), days, res)
        lines.append('The price went straight up to the target and the trade was closed there.')
    elif why == 'lock':
        head = 'The trade was closed on %s, %s after buying - %s.' % (dt(jx), days, res)
        if hit_k is not None:
            lines.append('The price reached the target on %s%s, so the stop moved up to the target.' % (
                dt(hit_k), ' with a gap up at the open' if hit_k > i and f2(cs.o[hit_k]) >= t['tgt'] else ''))
        lines.append('On %s the price fell back to the target and the trade was sold there - a win, as you trade it.' % dt(jx))
    elif why in ('trail', 'be'):
        head = 'The trade was closed on %s, %s after buying - %s.' % (dt(jx), days, res)
        if hit_k is not None:
            lines.append('The price reached the target on %s. The trade was kept open and the stop followed the price up.' % dt(hit_k))
        if why == 'be' and not t.get('hit') and P.get('beAt'):
            lines.append('The price went %s the risk up, so the stop moved to the buy price.' % _times(P['beAt']))
        lines.append(('On %s the price fell back to the buy price, where the stop had moved, so the trade closed at about breakeven.' % dt(jx)) if why == 'be' else
                     'On %s the price fell below that following stop, and the trade was closed.' % dt(jx))
        if t['maxR'] >= 1:
            lines.append('At its best the trade was about %.1f times the risk up.' % t['maxR'])
    elif why == 'tstop':
        head = 'The trade was closed on %s by your time stop - %s.' % (dt(jx), res)
        lines.append('In %d candles after the signal the price had not gone %s the risk up, so it was sold at that candle\'s close.' % (
            P.get('timeN', 0), _times(P.get('timeR', 1))))
    elif why == 'time':
        head = 'The trade was closed on %s because of your time limit (%s days) - %s.' % (dt(jx), P.get('maxDays'), res)
        lines.append('It reached neither the stop nor the target in that time.')
    elif why == 'ema':
        head = 'The trade was closed on %s when the price closed below the %s EMA - %s.' % (dt(jx), P.get('emaN'), res)
    else:
        head = 'The trade is still open.'
        lines.append('So far it is %s.' % (('up about %.1f times the risk' % R) if R > 0.05 else ('down about %.1f times the risk' % abs(R)) if R < -0.05 else 'about where it was bought'))
    return head, lines, R > 0


def why_page(pdf, key, t, cs, s, P, page_no, pages, run_name, cx):
    """Page 2 of a trade (owner, 12-Nov-2026: "2 slide for why you took this trade. reason for hitting stoploss"; then "why
    this trade should not numericals and with chart. it should be readable format like in sentences"): the story of the
    setup and of how the trade ended in plain sentences - the prices are on page 1."""
    cv = Canvas()
    tf = P.get('tf', 'D')
    intraday = tf == '4H'
    i = t['i']
    ecol = TARGET if t['R'] > 0 else STOP if t['R'] < 0 else MUTED
    r_txt = '%+.2fR' % t['R'] if t['reason'] != 'open' else 'still open (%+.2fR now)' % t['R']
    cv.text(40, PAGE_H - 36, '%s  -  %s  -  signal %s  -  why this trade' % (t['sym'], TF_NAME.get(tf, tf), day_text(cs.day[i], cs.minute[i], intraday)),
            15, INK, bold=True)
    cv.text(PAGE_W - 30, PAGE_H - 36, '%s   %s' % (r_txt, REASON.get(t['reason'], t['reason'])), 15, ecol, bold=True, align='right')
    cv.line(40, PAGE_H - 50, PAGE_W - 30, PAGE_H - 50, (0.85, 0.87, 0.9), 0.6)
    top, floor = PAGE_H - 78, 44.0
    SIZE, LINE, BODY = 10.4, 14.4, (0.20, 0.22, 0.28)
    cols = [[40.0, 425.0, top], [490.0, PAGE_W - 490.0 - 30.0, top]]

    def para(col, text, mark=None, color=BODY, bold=False, size=SIZE):
        """A paragraph in a column (after a number / bullet `mark`); False when it does not fit."""
        x, w, y = col
        ind = 18 if mark is not None else 0
        lines = _wrap(text, w - ind, size, bold)
        if y - len(lines) * LINE < floor and y < top - 20:
            return False
        if mark is not None:
            if isinstance(mark, str):
                cv.text(x, y, mark, size, ecol if mark == '-' else (0.35, 0.45, 0.7), bold=True)
            else:
                mark(cv, x + 2, y - 1, color)
        for ln in lines:
            cv.text(x + ind, y, ln, size, color, bold=bold)
            y -= LINE
        col[2] = y - 6
        return True

    def heading(col, text):
        cv.text(col[0], col[2], text, 12.5, INK, bold=True)
        col[2] -= 22
    heading(cols[0], 'Why the backtest took this trade')
    story = why_story(t, cs, s, P, cx)
    rest = []
    for k, txt in enumerate(story):
        if not para(cols[0], txt, '%d.' % (k + 1)):
            rest = list(enumerate(story))[k:]
            break
    head, lines, won = end_story(t, cs, s, P, cx)
    heading(cols[1], 'How it ended')
    para(cols[1], head, _check if won else _cross if t['R'] < 0 else None, ecol, bold=True)
    for txt in lines:
        para(cols[1], txt, '-')
    if t.get('acct'):
        cols[1][2] -= 6
        heading(cols[1], 'In your account' if t.get('taken') else 'Not in your account')
        acct = t['acct'].replace('\u20b9', 'Rs ').replace(' - ', '. ').strip()
        para(cols[1], acct if acct.endswith('.') else acct + '.')
    if rest:
        cols[1][2] -= 6
        heading(cols[1], 'Why it was taken (continued)')
        for k, txt in rest:
            if not para(cols[1], txt, '%d.' % (k + 1)):
                break
    cv.text(40, 18, 'Stock Blueprint Backtest Lab - %s - page 2 of 2 of this trade: why it was taken and how it ended (the prices are on page 1; '
                    'facts from the candles, not advice)' % run_name[:60], 6.5, AXIS)
    cv.text(PAGE_W - 30, 18, 'page %d of %d' % (page_no, pages), 6.5, AXIS, align='right')
    pdf.page(cv, key)


def trade_page(pdf, key, t, cs, s, P, page_no, pages, run_name, piv=None, emas=None, extra=None):
    """A trade's two pages (owner, 12-Nov-2026: "Use 2 slides for each setup. one for chart. 2 slide for why you took this
    trade. reason for hitting stoploss"): `key` / `page_no` = the first; the second follows."""
    cx = context(t, cs, s, P, extra)
    chart_page(pdf, key, t, cs, s, P, page_no, pages, run_name, cx, emas)
    why_page(pdf, tuple(key) + (1,), t, cs, s, P, page_no + 1, pages, run_name, cx)


REASON = {'stop': 'Stop loss', 'target': 'Target', 'be': 'Breakeven', 'trail': 'Trailing stop', 'lock': 'Target locked',
          'ema': 'Close under EMA', 'tstop': 'Time stop', 'time': 'Time limit', 'open': ''}
TF_NAME = {'D': 'Daily', 'W': 'Weekly', '4H': '4 hour'}
ZONE_NAME = {'F': 'FVG + Spring', 'G': 'Gap-up FVG + Spring', 'S': 'Spring', 'T': 'FVG first touch', 'C': 'FVG first touch confirmed',
             'Z': 'FVG zone touch', 'Y': 'Gap-up zone touch', 'P': 'Pattern at the Fib line of an FVG zone',
             'Q': 'Pattern at the Fib line of a Gap-up zone'}
WHERE = {'t': 'top', 'm': 'middle', 'b': 'bottom'}


def cover_page(pdf, run_name, P, res, shown, total, made):
    cv = Canvas()
    s = res.get('stats') or {}
    y = PAGE_H - 70
    cv.text(50, y, 'Backtest Lab - trade charts', 22, INK, bold=True)
    y -= 26
    cv.text(50, y, run_name, 13, CHOCH, bold=True)
    y -= 20
    cv.text(50, y, 'Made %s on your laptop from its Kite candles - %s chart - %s' % (made, TF_NAME.get(P.get('tf'), P.get('tf')),
                                                                                 res.get('groupName', '')), 9, MUTED)
    y -= 26
    if s.get('trades'):
        cv.text(50, y, '%d trades finished: win %.1f%%, average %.2fR, total %.1fR%s' % (
            s['trades'], s.get('winPct', 0), s.get('avgR', 0), s.get('totalR', 0), (', %d still open' % res['open']) if res.get('open') else ''),
            11, INK, bold=True)
        y -= 18
    cv.text(50, y, 'This PDF: %d trade%s - the losing ones first (newest first), then the rest (newest first), then the open ones.%s' % (
        shown, '' if shown == 1 else 's', ' The first %d of %d.' % (shown, total) if shown < total else ''), 9, MUTED)
    y -= 13
    cv.text(50, y, 'Two pages a trade: 1 = the chart with the market structure, 2 = why it was taken, how it ended (the reason for a stop loss) and the whole move.',
            9, MUTED)
    y -= 34
    cv.text(50, y, 'The rules of this run', 11, INK, bold=True)
    y -= 16
    for line in rule_lines(P):
        cv.text(60, y, line, 8.5, INK)
        y -= 13
    y -= 18
    cv.text(50, y, 'How to read a chart', 11, INK, bold=True)
    y -= 18
    legend = [(ENTRY, 'Entry line + BUY mark (the signal candle)'), (STOP, 'Stop loss line'), (TARGET, 'Target line (dashed)'),
              (CHOCH, 'CHoCH level (dashed) from the swing high it broke to the CHoCH candle, (n) = lower highs / lows; final low'),
              (FIB, 'The Fib line of the move (your discount level), from the final low to the signal'),
              (BOS, 'BOS: a close above the highest swing high after the CHoCH'),
              (SWING, 'Swing highs / lows (triangles) - known only after them; HH / LH = higher / lower high, HL / LL = higher / lower low'),
              (ZONE_FVG, 'The FVG / Gap-up zone (light box), from its first candle to the exit; X = the exit')]
    for col, txt in legend:
        cv.rect(60, y - 1, 16, 7, fill=col)
        cv.text(84, y, txt, 8.5, INK)
        y -= 14
    cv.text(50, 30, 'Research only - a backtest on past candles, not a buy recommendation. Prices: Kite candles (2 decimals).', 7.5, AXIS)
    pdf.page(cv, (-1,))


def rule_lines(P):
    out = []
    if P.get('structure') == 'only':
        w = {'both': 'in the CHoCH move or after it', 'leg': 'only in the CHoCH move', 'after': 'only after the CHoCH candle'}
        out.append('Market structure: swings of %s candles each side, at least %s lower highs and lower lows, zone %s%s%s%s' % (
            P.get('pivotN'), P.get('downN'), w.get(P.get('zoneWhen'), ''), ', first pullback (no BOS)' if P.get('firstPull') else '',
            ', zone top below the CHoCH level' if P.get('belowChoch') else '',
            (', zone %s at least %g%% down the move' % ({'mid': 'middle', 'top': 'top', 'bottom': 'bottom'}.get(P.get('discPart'), 'middle'),
                                                        P['discount'] * 100)) if P.get('discount') else ''))
    else:
        out.append('Market structure: not a rule in this run (the charts still show the swings and any CHoCH)')
    out.append('Buy: %s' % {'zone': 'an order waiting at the zone top', 'close': "the signal candle's close",
                            'next_open': "the next candle's open"}.get(P.get('entry'), P.get('entry')))
    if P.get('gapEntry'):
        out.append('An FVG with a gap-up zone inside it: the order waits at the gap-up zone top, the stop under the FVG bottom')
    if P.get('zoneMin') or P.get('zoneMax'):
        out.append('Zone size: %s' % ('%g%% to %g%%' % (P.get('zoneMin') or 0, P['zoneMax']) if P.get('zoneMax') else 'at least %g%%' % P['zoneMin']))
    if P.get('fibPat') in ('big', 'all'):
        out.append('%s: a Spring or Bullish Harami + Inverted Hammer at the zone\'s %g%% Fib line (+/- %g%%), bought at its close' % (
            'Zones bigger than the size limit' if P['fibPat'] == 'big' else 'Every zone', P.get('fibLevel', 0.618) * 100, P.get('fibTol', 1)))
    if P.get('lineOk'):
        out.append('A zone short of the discount line counts when its top is at / under the CHoCH level (+%g%%)' % P.get('lineTol', 0))
    if P.get('darkCloud') in ('exclude', 'only'):
        out.append('Dark-cloud FVGs (a red 3rd candle closing under the middle of the green one): %s' % (
            'left out' if P['darkCloud'] == 'exclude' else 'only these'))
    if P.get('structure') == 'only':
        out.append('Two discount zones in the CHoCH move: %s' % ('every zone traded' if P.get('zonePick') == 'every' else
                                                               'the 2nd traded, the 1st only watched'))
        if P.get('moveVol'):
            out.append('Volume in the CHoCH move: at least %d candle%s with %gx the volume of the 20 candles before it' % (
                P.get('moveVolN', 1), '' if P.get('moveVolN', 1) == 1 else 's', P['moveVol']))
    stop = {'zone': 'under the zone bottom', 'spring': "under the signal candle's low", 'lower': 'under the lower of the two',
            'pct': '%g%% under the entry' % P.get('stopPct', 0), 'final': 'under the CHoCH\'s final low (LL)'}.get(P.get('stop'), P.get('stop'))
    if P.get('group') == 'pattern' and P.get('stop') in ('zone', 'lower'):
        stop = "under the pattern's low"                 # a Pattern library run has no zone (13-Nov-2026)
    stop += '' if P.get('stop') == 'pct' else ' by %g%%' % P.get('stopBuf', 0)
    if P.get('stopAtr'):
        stop += ', or %g x ATR(14) under the entry - whichever is lower' % P['stopAtr']
    out.append('Stop loss: %s; trades risking more than %g%% skipped' % (stop, P.get('maxRisk', 0)) if P.get('maxRisk') else 'Stop loss: %s' % stop)
    tgt = {'swing': 'the last swing high (at least %gR above)' % P.get('swingMinR', 0),
           'mh': 'the CHoCH move high - HH (at least %gR above)' % P.get('swingMinR', 0),
           'pct': '%g%% above the entry' % P.get('targetPct', 20)}.get(P.get('targetMode'), '%gR' % P.get('targetR', 2))
    if P.get('after') == 'fixed':
        out.append('Target: %s - sold there' % tgt)
    else:
        trail = {'lows': 'under the lowest low of the last %s candles' % P.get('trailN'), 'pct': '%g%% under the highest price' % P.get('trailPct', 0),
                 'ema': 'a close under the %s EMA' % P.get('emaN'), 'atr': '%g x ATR under the highest price' % P.get('atrK', 3),
                 'swing': 'under each new swing low', 'none': 'no trail'}.get(P.get('trail'), '')
        out.append('Target: %s - %sthen %s%s' % (tgt, ('%g%% sold there, ' % P['partialPct']) if P.get('partialPct') else '',
                                                  'the stop to the target, ' if P.get('lockTarget') else 'the stop to the entry, ' if P.get('breakeven') else '', trail))
    if P.get('beAt'):
        out.append('Before the target: the stop to the entry once the price is %gR up' % P['beAt'])
    if P.get('timeN'):
        out.append('Time stop: sold at the close when the price has not gone %gR up within %d candles' % (P.get('timeR', 1), P['timeN']))
    out.append('Sold after %s days at the latest; costs %g%% a trade' % (P.get('maxDays'), P.get('cost', 0)))
    if P.get('from') or P.get('to'):
        out.append('Signals %s%s' % ('from %s ' % P['from'] if P.get('from') else '', 'to %s' % P['to'] if P.get('to') else ''))
    return out


def safe_name(name):
    s = re.sub(r'[^A-Za-z0-9 ._+()-]+', '_', str(name or 'run')).strip(' ._') or 'run'
    return s[:60]


def tidy(folder, keep=KEEP_FILES):
    """Only the newest `keep` PDFs stay in the folder."""
    try:
        files = sorted((f for f in os.listdir(folder) if f.lower().endswith('.pdf')),
                       key=lambda f: os.path.getmtime(os.path.join(folder, f)), reverse=True)
    except OSError:
        return
    for f in files[keep:]:
        try:
            os.remove(os.path.join(folder, f))
        except OSError:
            pass


def sort_key(t):
    """Losing trades first (newest first), then the rest (newest first), then the open ones (owner, 12-Nov-2026)."""
    group = 2 if t['reason'] == 'open' else 0 if t['R'] < 0 else 1
    return (group, -t['sigDay'], -t['sigMin'], t['sym'])
