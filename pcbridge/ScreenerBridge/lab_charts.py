# -*- coding: utf-8 -*-
"""Backtest Lab trade charts - one PDF per run, a chart page per trade (owner, 12-Nov-2026: "when the backtest result comes,
a PDF should come with it - a chart for every trade, with the swings, CHoCH, FVG area, target and stop loss of the
conditions we gave, a snapshot like the TradingView view. We have the historical data, so we can draw the candlesticks
ourselves ... then I need not go to the TradingView link every time"; choices: saved in the laptop folder only
(ScreenerBridge\\lab_charts), every trade, the losing ones first).

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
MAX_PAGES = 3000                       # trade pages in one PDF (the rest are counted on the cover)
KEEP_FILES = 20                        # older PDFs in the folder are removed
MAX_WINDOW = 260                       # candles on one chart at most
FOLDER = 'lab_charts'

# Helvetica character widths (1/1000 em) for ASCII 32..126 - for right-aligned labels and label boxes
_HW = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278] + [556] * 10 + \
      [278, 278, 584, 584, 584, 556, 1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667,
       778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556, 333, 556, 556, 500, 556, 556, 278, 556,
       556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584]

UP, DOWN, WICK = (0.13, 0.62, 0.45), (0.89, 0.30, 0.30), (0.35, 0.38, 0.45)
GRID, AXIS, MUTED, INK = (0.92, 0.93, 0.95), (0.55, 0.58, 0.64), (0.42, 0.45, 0.52), (0.10, 0.12, 0.18)
ZONE_FVG, ZONE_GAP = (0.86, 0.92, 1.0), (0.93, 0.88, 1.0)
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


def window(t, cs, s):
    """The candles a trade's chart shows: from before the CHoCH's swing high / the zone (else 60 candles before the
    signal) to 15 candles after the exit, at most MAX_WINDOW."""
    i, jx = t['i'], t.get('jx', t['i'])
    start = i - 60
    zf = t.get('zf')
    if zf is not None and zf >= 0:
        start = min(start, zf - 8)
    if s is not None and t.get('k', -1) >= 0:
        b, hi, lvl, li, lf, d = s.events[t['k']]
        start = min(start, hi - 15)
    end = min(cs.n - 1, max(jx, i) + 15)
    start = max(0, start, end - MAX_WINDOW + 1)
    return start, end


def trade_page(pdf, key, t, cs, s, P, page_no, pages, run_name, piv, emas=None):
    """Draws one trade (a backtest_lab trade dict + its chart extras) on a new page."""
    cv = Canvas()
    tf = P.get('tf', 'D')
    intraday = tf == '4H'
    start, end = window(t, cs, s)
    n = end - start + 1
    x0, x1, y0, y1 = 46.0, PAGE_W - 128.0, 52.0, PAGE_H - 92.0
    slot = (x1 - x0) / float(n)

    def X(k):
        return x0 + (k - start + 0.5) * slot
    f2 = lambda v: round(float(v), 2)
    lows = [f2(cs.l[k]) for k in range(start, end + 1)]
    highs = [f2(cs.h[k]) for k in range(start, end + 1)]
    levels = [t['entry'], t['stop'], t.get('tgt')]
    ev = s.events[t['k']] if s is not None and t.get('k', -1) >= 0 else None
    zb, zt, zf = t.get('zb'), t.get('zt'), t.get('zf')
    if zb is not None:
        levels += [zb, zt]
    if ev:
        levels += [ev[2], ev[4]]
    fib = P.get('discount') or 0
    fib_line = None
    if ev and t.get('H') is not None and fib:
        fib_line = t['H'] - fib * (t['H'] - ev[4])
        levels.append(fib_line)
    lo = min([x for x in lows + levels if x is not None])
    hi = max([x for x in highs + levels if x is not None])
    pad = (hi - lo) * 0.05 or hi * 0.02 or 1
    lo, hi = lo - pad, hi + pad

    def Y(p):
        return y0 + (p - lo) / (hi - lo) * (y1 - y0)

    # frame, grid, price axis
    cv.rect(x0, y0, x1 - x0, y1 - y0, fill=(1, 1, 1), stroke=(0.85, 0.87, 0.9))
    step = _nice_step(hi - lo, 8)
    p = (int(lo / step) + 1) * step
    while p < hi:
        cv.line(x0, Y(p), x1, Y(p), GRID, 0.4)
        cv.text(x0 - 4, Y(p) - 2.5, money(p) if step < 1 else money(p)[:-3], 6.5, AXIS, align='right')
        p += step
    # date axis
    every = max(1, int(round(n / 9.0)))
    for k in range(start, end + 1, every):
        cv.line(X(k), y0, X(k), y0 - 3, AXIS, 0.4)
        cv.text(X(k), y0 - 12, day_text(cs.day[k], cs.minute[k], intraday, year=not intraday), 6.5, AXIS, align='center')
    # the zone (from its first candle to the exit)
    if zb is not None and zt is not None and zf is not None and zf >= 0:
        za = max(start, zf - (1 if t['code'] in ('G', 'Y') else 2))
        zx2 = X(min(end, t.get('jx', t['i']))) + slot / 2
        cv.rect(X(za) - slot / 2, Y(zb), zx2 - (X(za) - slot / 2), max(0.6, Y(zt) - Y(zb)),
                fill=ZONE_GAP if t['code'] in ('G', 'Y') else ZONE_FVG, stroke=(0.62, 0.72, 0.9), width=0.5)
    # EMAs (when the run used EMA rules)
    for ln, series in sorted((emas or {}).items()):
        cv.polyline([(X(k), Y(series[k])) for k in range(start, end + 1) if lo < series[k] < hi], EMA_COL.get(ln, MUTED), 0.6)
    # candles
    bw = max(0.6, slot * 0.62)
    for k in range(start, end + 1):
        o, h, l, c = f2(cs.o[k]), f2(cs.h[k]), f2(cs.l[k]), f2(cs.c[k])
        col = UP if c >= o else DOWN
        cv.line(X(k), Y(l), X(k), Y(h), WICK if slot < 3 else col, 0.5)
        top, bot = max(o, c), min(o, c)
        cv.rect(X(k) - bw / 2, Y(bot), bw, max(0.5, Y(top) - Y(bot)), fill=col)
    # swings (the pivots of the run's swing size; known only n candles after them)
    for k in piv[0]:
        if start <= k <= end:
            cv.tri(X(k), Y(f2(cs.h[k])) + 4, 3.2, False, SWING)
    for k in piv[1]:
        if start <= k <= end:
            cv.tri(X(k), Y(f2(cs.l[k])) - 4, 3.2, True, SWING)
    right = []                                # level labels in the right-hand column
    # market structure: the CHoCH level, its candle, the final low, the BOS, the Fib line
    if ev:
        b, hi_c, lvl, li, lf, d = ev
        if b >= start:
            cv.line(X(max(start, hi_c)), Y(lvl), X(b), Y(lvl), CHOCH, 1.0, dash=(4, 2))
            cv.text(X(b), Y(f2(cs.h[b])) + 7, 'CHoCH (%d)' % d, 7, CHOCH, bold=True, align='center')
        right.append((Y(lvl), 'CHoCH %s' % money(lvl), CHOCH))
        if li >= start:
            cv.text(X(li), Y(lf) - 16, 'final low', 6.5, CHOCH, align='center')
        st = s.st.get(t['k'])
        if st and st[5] >= 0 and start <= st[5] <= end and st[3] is not None:
            peak = st[3]
            cv.line(X(max(start, st[5] - 12)), Y(peak), X(st[5]), Y(peak), BOS, 0.8)
            cv.text(X(st[5]), Y(peak) + 4, 'BOS', 7, BOS, bold=True, align='center')
        if fib_line is not None:
            cv.line(X(max(start, li)), Y(fib_line), X(t['i']), Y(fib_line), FIB, 0.9, dash=(1.5, 1.5))
            right.append((Y(fib_line), '%g%% %s' % (fib * 100, money(fib_line)), FIB))
    # the trade: entry / stop / target from the signal to the exit, the entry and exit marks
    i, jx = t['i'], min(end, t.get('jx', t['i']))
    xa, xb = X(i) - slot / 2, X(jx) + slot / 2
    cv.line(xa, Y(t['entry']), xb, Y(t['entry']), ENTRY, 1.1)
    cv.line(xa, Y(t['stop']), xb, Y(t['stop']), STOP, 1.1)
    if t.get('tgt') is not None:
        cv.line(xa, Y(t['tgt']), xb, Y(t['tgt']), TARGET, 1.1, dash=(4, 2))
        right.append((Y(t['tgt']), 'Target %s' % money(t['tgt']), TARGET))
    right.append((Y(t['entry']), 'Entry %s' % money(t['entry']), ENTRY))
    right.append((Y(t['stop']), 'Stop %s' % money(t['stop']), STOP))
    if zb is not None:
        right.append((Y(zt), 'Zone top %s' % money(zt), (0.35, 0.45, 0.7)))
        right.append((Y(zb), 'Zone bottom %s' % money(zb), (0.35, 0.45, 0.7)))
    cv.tri(X(i), Y(f2(cs.l[i])) - 12, 4.5, True, ENTRY)
    cv.text(X(i), Y(f2(cs.l[i])) - 21, 'BUY', 7, ENTRY, bold=True, align='center')
    ex = t['exit']
    won = t['R'] > 0
    ecol = TARGET if won else STOP if t['R'] < 0 else MUTED
    cv.line(X(jx) - 3, Y(ex) - 3, X(jx) + 3, Y(ex) + 3, ecol, 1.4)
    cv.line(X(jx) - 3, Y(ex) + 3, X(jx) + 3, Y(ex) - 3, ecol, 1.4)
    right.append((Y(ex), 'Exit %s' % money(ex), ecol))
    for y, txt, col in _labels_apart(right, y0 + 2, y1 - 6):
        cv.text(x1 + 6, y - 2.5, txt, 7, col, bold=True)
    # header + footer
    reason = REASON.get(t['reason'], t['reason'])
    r_txt = '%+.2fR' % t['R'] if t['reason'] != 'open' else 'still open (%+.2fR now)' % t['R']
    cv.text(x0, PAGE_H - 34, '%s  -  %s  -  signal %s' % (t['sym'], TF_NAME.get(tf, tf), day_text(cs.day[i], cs.minute[i], intraday)),
            14, INK, bold=True)
    cv.text(PAGE_W - 30, PAGE_H - 34, '%s   %s' % (r_txt, reason), 14, ecol, bold=True, align='right')
    line2 = '%s - entry %s - stop %s (risk %.2f%%) - target %s - exit %s on %s after %d day%s - best %.2fR - %s' % (
        ZONE_NAME.get(t['code'], t['code']) + (' (%s)' % WHERE.get(t.get('where'), '') if t.get('where') in WHERE else ''),
        money(t['entry']), money(t['stop']), t['riskPct'], money(t['tgt']) if t.get('tgt') is not None else '-', money(ex),
        day_text(cs.day[jx], cs.minute[jx], intraday), t['days'], '' if t['days'] == 1 else 's', t['maxR'],
        'in the account' if t.get('taken') else 'not taken by the account')
    cv.text(x0, PAGE_H - 52, line2, 8, MUTED)
    if t.get('struct'):
        cv.text(x0, PAGE_H - 65, t['struct'][:190], 7.5, CHOCH)
    if t.get('ema'):
        cv.text(x0, PAGE_H - 77, 'EMA: ' + t['ema'], 7.5, MUTED)
    if emas:
        lx = x1 - 4
        for ln in sorted(emas, reverse=True):
            cv.text(lx, y1 - 10, '%d EMA' % ln, 6.5, EMA_COL.get(ln, MUTED), align='right')
            lx -= 34
    cv.text(x0, 22, 'Stock Blueprint Backtest Lab - %s - losing trades first, then the rest, newest first' % run_name[:60], 6.5, AXIS)
    cv.text(PAGE_W - 30, 22, 'page %d of %d' % (page_no, pages), 6.5, AXIS, align='right')
    pdf.page(cv, key)


REASON = {'stop': 'Stop loss', 'target': 'Target', 'be': 'Breakeven', 'trail': 'Trailing stop', 'ema': 'Close under EMA',
          'time': 'Time limit', 'open': ''}
TF_NAME = {'D': 'Daily', 'W': 'Weekly', '4H': '4 hour'}
ZONE_NAME = {'F': 'FVG + Spring', 'G': 'Gap-up FVG + Spring', 'S': 'Spring', 'T': 'FVG first touch', 'C': 'FVG first touch confirmed',
             'Z': 'FVG zone touch', 'Y': 'Gap-up zone touch'}
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
    y -= 30
    if s.get('trades'):
        cv.text(50, y, '%d trades finished: win %.1f%%, average %.2fR, total %.1fR%s' % (
            s['trades'], s.get('winPct', 0), s.get('avgR', 0), s.get('totalR', 0), (', %d still open' % res['open']) if res.get('open') else ''),
            11, INK, bold=True)
        y -= 18
    cv.text(50, y, 'This PDF: %d trade%s - the losing ones first (newest first), then the rest (newest first), then the open ones.%s' % (
        shown, '' if shown == 1 else 's', ' The first %d of %d.' % (shown, total) if shown < total else ''), 9, MUTED)
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
              (SWING, 'Swing highs / lows (triangles) - known only N candles after them'),
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
    stop = {'zone': 'under the zone bottom', 'spring': "under the signal candle's low", 'lower': 'under the lower of the two',
            'pct': '%g%% under the entry' % P.get('stopPct', 0)}.get(P.get('stop'), P.get('stop'))
    out.append('Stop loss: %s%s; trades risking more than %g%% skipped' % (
        stop, '' if P.get('stop') == 'pct' else ' by %g%%' % P.get('stopBuf', 0), P.get('maxRisk', 0)) if P.get('maxRisk') else
        'Stop loss: %s%s' % (stop, '' if P.get('stop') == 'pct' else ' by %g%%' % P.get('stopBuf', 0)))
    tgt = 'the last swing high (at least %gR above)' % P.get('swingMinR', 0) if P.get('targetMode') == 'swing' else '%gR' % P.get('targetR', 2)
    if P.get('after') == 'fixed':
        out.append('Target: %s - sold there' % tgt)
    else:
        trail = {'lows': 'under the lowest low of the last %s candles' % P.get('trailN'), 'pct': '%g%% under the highest price' % P.get('trailPct', 0),
                 'ema': 'a close under the %s EMA' % P.get('emaN'), 'none': 'no trail'}.get(P.get('trail'), '')
        out.append('Target: %s - then %s%s' % (tgt, 'the stop to the entry, ' if P.get('breakeven') else '', trail))
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
