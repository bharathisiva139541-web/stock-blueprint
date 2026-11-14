# -*- coding: utf-8 -*-
"""Lower-timeframe candles kept on this computer for the Backtest Lab's confirmation rule (owner, 13-Nov-2026: "i got
BOS+FVG setup in a stock in Daily Timeframe ... i should not enter the trade just by Price touching the FVG Zone. So i
decided to look deeper the price action by switching the timeframe to 15 mins. If any Choch has happened inside the Zone in
15 min, then i decided to buy. but we have limited candles data in 15 min to backtest right?"; answers: keep the 1-hour
candles Kite already sends for the 4H history, and read as many years of 15-minute candles as Kite gives).

One file per stock and timeframe - intraday_data/ltf/<SYM>.1H.bin / <SYM>.15m.bin - outside the stock's json.gz store, so the
daily scan reads no more than before. A file is a run of blocks, each [b'LTF1', n (uint32), day ordinals (int32 x n),
minutes of the day (int16 x n), open / high / low / close / volume (float32 x n each)], in time order: the daily update
appends one block with the new session (append), the deep history rewrites the file (write); more than COMPACT_BLOCKS blocks
-> rewritten as one. Reading = array.frombytes per column (fast; no json). Pure Python (no numpy)."""
import array
import os
import re
import struct
import time
from datetime import date

MAGIC = b'LTF1'
COMPACT_BLOCKS = 48
TFS = ('1H', '15m')
COLS = (('i', 4), ('h', 2), ('f', 4), ('f', 4), ('f', 4), ('f', 4), ('f', 4))     # day, minute, o, h, l, c, v


# Windows will not replace a file another program has open (an antivirus scan, the search indexer, a reader): wait and try
# again (14-Nov-2026: KiteHistoryNow.bat stopped on ASTRAL.15m.bin "being used by another process")
REPLACE_WAITS = (0.2, 0.5, 1, 1, 2, 3, 5, 8)


def replace(tmp, dst, waits=None):
    """os.replace(tmp, dst), tried again for about 20 seconds while Windows says the file is in use."""
    for w in tuple(REPLACE_WAITS if waits is None else waits) + (None,):
        try:
            os.replace(tmp, dst)
            return
        except PermissionError:
            if w is None:
                raise
            time.sleep(w)


def _safe(sym):
    return re.sub(r'[^A-Za-z0-9_-]', lambda m: '%%%02X' % ord(m.group()), sym)


def path(folder, sym, tf):
    return os.path.join(folder, _safe(sym) + '.' + tf + '.bin')


class Series:
    """The candles of one file: o h l c v (float32 arrays), day (day ordinal), minute (minute of the day), n."""
    __slots__ = ('o', 'h', 'l', 'c', 'v', 'day', 'minute', 'n')

    def __init__(self):
        self.day, self.minute = array.array('i'), array.array('h')
        self.o, self.h, self.l, self.c, self.v = (array.array('f') for _ in range(5))
        self.n = 0

    def key(self, k):
        return self.day[k] * 1440 + self.minute[k]


def _key_of(t):
    """'YYYY-MM-DD HH:MM' (or 'YYYY-MM-DD') -> (day ordinal, minute)."""
    d = date.fromisoformat(t[:10]).toordinal()
    m = int(t[11:13]) * 60 + int(t[14:16]) if len(t) >= 16 else 0
    return d, m


def _block(rows):
    """[[key, o, h, l, c, v], ...] -> one block's bytes."""
    n = len(rows)
    days, mins = array.array('i'), array.array('h')
    cols = [array.array('f') for _ in range(5)]
    for r in rows:
        d, m = _key_of(r[0])
        days.append(d)
        mins.append(m)
        for k in range(5):
            cols[k].append(float(r[k + 1] or 0))
    return MAGIC + struct.pack('<I', n) + days.tobytes() + mins.tobytes() + b''.join(c.tobytes() for c in cols)


def read(folder, sym, tf):
    """The file's candles (Series; n = 0 when there is none). A damaged tail is left out."""
    s = Series()
    try:
        with open(path(folder, sym, tf), 'rb') as f:
            raw = f.read()
    except OSError:
        return s
    p, size = 0, len(raw)
    while p + 8 <= size and raw[p:p + 4] == MAGIC:
        n = struct.unpack('<I', raw[p + 4:p + 8])[0]
        need = n * (4 + 2 + 5 * 4)
        if p + 8 + need > size:
            break
        q = p + 8
        parts = []
        for code, w in COLS:
            a = array.array(code)
            a.frombytes(raw[q:q + n * w])
            parts.append(a)
            q += n * w
        s.day.extend(parts[0])
        s.minute.extend(parts[1])
        for a, b in zip((s.o, s.h, s.l, s.c, s.v), parts[2:]):
            a.extend(b)
        p = q
    s.n = len(s.day)
    return s


def _scan(fp):
    """[(offset, n), ...] of the file's blocks (headers only - the candles are not read)."""
    out = []
    try:
        size = os.path.getsize(fp)
        with open(fp, 'rb') as f:
            p = 0
            while p + 8 <= size:
                f.seek(p)
                head = f.read(8)
                if head[:4] != MAGIC:
                    break
                n = struct.unpack('<I', head[4:8])[0]
                if p + 8 + n * 26 > size:
                    break
                out.append((p, n))
                p += 8 + n * 26
    except OSError:
        pass
    return out


def blocks(folder, sym, tf):
    """How many blocks the file has (0 = none)."""
    return len(_scan(path(folder, sym, tf)))


def rows_of(s):
    """A Series back to rows [[key, o, h, l, c, v], ...] (key 'YYYY-MM-DD HH:MM')."""
    out = []
    for k in range(s.n):
        m = s.minute[k]
        out.append(['%s %02d:%02d' % (date.fromordinal(s.day[k]).isoformat(), m // 60, m % 60),
                     s.o[k], s.h[k], s.l[k], s.c[k], s.v[k]])
    return out


def write(folder, sym, tf, rows):
    """The file = these rows (sorted, one per key) as one block; no rows = the file removed."""
    os.makedirs(folder, exist_ok=True)
    fp = path(folder, sym, tf)
    by = {}
    for r in rows:
        by[r[0]] = r
    rows = [by[k] for k in sorted(by)]
    if not rows:
        remove(folder, sym, tf)
        return 0
    tmp = fp + '.tmp'
    with open(tmp, 'wb') as f:
        f.write(_block(rows))
    replace(tmp, fp)
    return len(rows)


def last_key(folder, sym, tf):
    """(day ordinal, minute) of the file's newest candle, or None - from the last block only (cheap: the daily update)."""
    fp = path(folder, sym, tf)
    bl = [b for b in _scan(fp) if b[1]]
    if not bl:
        return None
    off, n = bl[-1]
    with open(fp, 'rb') as f:
        f.seek(off + 8 + (n - 1) * 4)
        d = struct.unpack('<i', f.read(4))[0]
        f.seek(off + 8 + n * 4 + (n - 1) * 2)
        m = struct.unpack('<h', f.read(2))[0]
    return d, m


def first_day(folder, sym, tf):
    """The day ordinal of the file's oldest candle, or None."""
    fp = path(folder, sym, tf)
    bl = [b for b in _scan(fp) if b[1]]
    if not bl:
        return None
    with open(fp, 'rb') as f:
        f.seek(bl[0][0] + 8)
        return struct.unpack('<i', f.read(4))[0]


def append(folder, sym, tf, rows):
    """Adds the rows newer than the file's newest candle as one block (none = nothing written) -> how many. The file must
    exist (the deep history makes it). More than COMPACT_BLOCKS blocks -> rewritten as one."""
    fp = path(folder, sym, tf)
    if not os.path.exists(fp):
        return 0
    last = last_key(folder, sym, tf) or (-1, -1)
    new = sorted((r for r in rows if _key_of(r[0]) > last), key=lambda r: r[0])
    if not new:
        return 0
    if blocks(folder, sym, tf) + 1 > COMPACT_BLOCKS:
        write(folder, sym, tf, rows_of(read(folder, sym, tf)) + new)
        return len(new)
    with open(fp, 'ab') as f:
        f.write(_block(new))
    return len(new)


def remove(folder, sym, tf=None):
    """The stock's files (tf None = both) removed - a split / bonus changes the older prices (read again)."""
    for t in ((tf,) if tf else TFS):
        try:
            os.remove(path(folder, sym, t))
        except OSError:
            pass


def span_days(folder, sym, tf):
    """(first day ordinal, last day ordinal) of the file, or None."""
    s = read(folder, sym, tf)
    return (s.day[0], s.day[-1]) if s.n else None
