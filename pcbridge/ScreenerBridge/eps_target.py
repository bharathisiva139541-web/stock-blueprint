# -*- coding: utf-8 -*-
"""EPS Growth Target Lab (owner, 23-Nov-2026, LAURUSLABS: Q1 results 24-Jul-2026, Rs 1,624 on 27-Jul, a target of Rs 2,502
from his own formula - 2,488 on 11-Nov: "It is impressive to see our method is actually working. but i don't know how many
stocks like this reached atmost its target price after Q1 result update ... we don't have Q1 Result date in our sheet. then
only we will have stock price at that time").

The formula (the sheet's TargetPrice, kept exactly):
    TTM EPS       = the EPS of the newest 4 quarters added up
    Previous TTM  = the EPS of the 4 quarters before those
    EPS growth %  = (TTM - Previous TTM) / Previous TTM x 100
    Target        = TTM EPS x EPS growth %          (= a PE equal to the growth rate, a PEG of 1)

For every stock and each of the newest QUARTERS quarter ends this works out, on the laptop's own data:
  * the 8 quarterly EPS - the results table the website shows (NSE's XBRL filings + screener.in's figures, xbrl_history.py;
    EPS on today's share count) or, without one, the EPS history read from screener.in (pe_history.py);
  * WHEN the results came out - NSE's result filing (the corporate announcements, read back for every results season:
    `ann_backfill`) or, without one, the time NSE put in the XBRL file's name;
  * the entry = the close of the first session that could react (the results day itself when they came before 15:30,
    else the next session) and then, from the Kite daily candles (the Backtest Lab cache - adjusted for splits / bonuses
    like the EPS), the first session whose HIGH reached the target, the best high / lowest low / close after 30 / 60 / 90 /
    120 / 180 sessions and NIFTY 50 over the same sessions.
One post per quarter -> the sheet (doPost action 'epst', tab EPS_Target) -> the website's page #epst (api/epstarget).
Standard library only."""
import base64
import bisect
import gzip
import hashlib
import json
import os
import re
import time
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
STATE_PATH = os.path.join(HERE, 'eps_target_state.json')
ANN_PATH = os.path.join(HERE, 'eps_target_ann.json')

ENGINE = 1                  # the rules' version (sent with every post; a change sends every quarter again)
QUARTERS = 8                # quarter ends worked out (config.json eps_target_quarters, 2..16)
WINDOWS = (30, 60, 90, 120, 180)    # sessions after the entry (about 1.5 / 3 / 4.5 / 6 / 9 months)
NEAR_PCT = 2.0              # a best high within this % under the target = a near miss
PATH_STEP = 5               # the chart's path: one point every this many sessions
CLOSE_HHMM = '15:30'        # results filed before this react the same day
ANN_WINDOW_DAYS = 75        # a quarter's results filing is looked for from the day after its end to this many days later
ANN_BLOCK_DAYS = 4          # NSE's announcements read this many days a request (like AnnouncementsNow)
ANN_PER_ROUND = 4           # requests a full round (EpsTargetNow.bat: every one)
ANN_GAP_S = 5.0             # between two of them
XBRL_NEAR_DAYS = 3          # a results filing up to this many days before the XBRL file's own time = the same results
XBRL_MAX_DAYS = 120         # an XBRL file's time later than the quarter end + this = a late / revised filing (not the results day)
READY_SESSIONS = 30         # a quarter is 'ready' when this many sessions passed for READY_SHARE of its targets
READY_SHARE = 0.6
KEEP_ROWS = 5000
COLS = ('sym', 'st', 'why', 'b', 'fl', 'eps', 'ttm', 'prev', 'g', 'tgt', 'ann', 'src', 'ed', 'ep', 'pre', 'o0', 'n', 'hit',
        'hitd', 'mx', 'dd', 'cl', 'ix', 'now', 'ph', 'pc')
WHY = {'loss': 'a loss over the last 4 quarters (TTM EPS 0 or less)',
       'prevloss': 'a loss in the 4 quarters before (no growth % to work out)',
       'fell': 'EPS fell (growth 0 or less - no target)',
       'date': 'no results date found yet',
       'wait': 'no session since the results yet',
       'price': 'no daily candles for it'}
_MON = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
BENCH = 'NIFTY_50'

log = print
D = {}      # what screener_bridge hands over: session() -> opener, fetch(opener, start, end) -> (records, err),
            # rows(records) -> (rows, timed), nse_part(what) -> context manager


def bind(**kw):
    D.update(kw)


# ------------------------------------------------------------------ quarters
def mi_of(y, m):
    return y * 12 + m


def label_of(mi):
    y, m = divmod(mi - 1, 12)
    return '%s %d' % (_MON[m].title(), y)


def mi_label(label):
    m = re.match(r'^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})$', str(label or '').strip())
    if not m or m.group(1).lower() not in _MON:
        return None
    return int(m.group(2)) * 12 + _MON.index(m.group(1).lower()) + 1


def end_of(mi):
    y, m = divmod(mi - 1, 12)
    nxt = date(y + (m == 11), 1 if m == 11 else m + 2, 1)
    return nxt - timedelta(days=1)


def quarter_ends(today, n=QUARTERS):
    """The newest n quarter ends before `today` (month indexes, newest first)."""
    mi = mi_of(today.year, today.month)
    while mi % 3 or end_of(mi) >= today:
        mi -= 1
    return [mi - 3 * k for k in range(max(1, n))]


def fy_words(mi):
    """'Q1 FY27' - India's financial year starts in April."""
    y, m = divmod(mi - 1, 12)
    m += 1
    q = {6: 1, 9: 2, 12: 3, 3: 4}.get(m)
    fy = y + 1 if m >= 4 else y
    return 'Q%d FY%02d' % (q, fy % 100) if q else ''


# ------------------------------------------------------------------ when the results came out
def _ann_load():
    try:
        with open(ANN_PATH, encoding='utf-8') as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict) or d.get('v') != 1:
        d = {'v': 1, 'days': [], 'rows': {}}
    d['days'] = sorted({x for x in d.get('days') or [] if isinstance(x, str)})
    d['rows'] = {k: v for k, v in (d.get('rows') or {}).items() if isinstance(v, list)}
    return d


def _ann_save(d):
    tmp = ANN_PATH + '.%d.tmp' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, separators=(',', ':'))
    os.replace(tmp, ANN_PATH)


def remember(rows, start, end, today=None, d=None):
    """NSE's result filings [[SYM, 'yyyy-mm-dd HH:MM:SS', subject], ...] of the days start .. end -> the archive (the days
    before `today` marked read - today's filings keep coming). The round's own announcement step hands its rows over too."""
    today = today or date.today()
    own = d is None
    d = _ann_load() if own else d
    added = 0
    for r in rows or []:
        try:
            sym, at = str(r[0]).strip().upper(), str(r[1])[:19]
        except (IndexError, TypeError):
            continue
        if not sym or not re.match(r'^\d{4}-\d{2}-\d{2} \d{2}:\d{2}', at):
            continue
        lst = d['rows'].setdefault(sym, [])
        if at not in lst:
            lst.append(at)
            lst.sort()
            added += 1
    days = set(d['days'])
    x = start
    while x <= end:
        if x < today:
            days.add(x.isoformat())
        x += timedelta(days=1)
    grew = len(days) != len(d['days'])
    d['days'] = sorted(days)
    if added:
        d['changed'] = time.time()                 # what the rows are worked out from changed (the round's step looks)
    if own and (added or grew):
        _ann_save(d)
    return d


def _ann_order(qends, today):
    """The quarters whose results are looked for, in the order they are read: a finished results season first (the newest
    one - the owner's Q1), then the season going on, then the older ones newest first."""
    done = [mi for mi in qends if end_of(mi) + timedelta(days=ANN_WINDOW_DAYS) < today]
    going = [mi for mi in qends if mi not in done]
    return done[:1] + going + done[1:]


def ann_todo(qends, today, have, limit):
    """[(first day, last day)] of NSE announcements still to read (requests of up to ANN_BLOCK_DAYS days), at most `limit`."""
    have, out = set(have), []
    for mi in _ann_order(qends, today):
        a = end_of(mi) + timedelta(days=1)
        b = min(end_of(mi) + timedelta(days=ANN_WINDOW_DAYS), today - timedelta(days=1))
        x = a
        while x <= b and len(out) < limit:
            if x.isoformat() in have:
                x += timedelta(days=1)
                continue
            s, n = x, 1
            while n < ANN_BLOCK_DAYS and x + timedelta(days=1) <= b and (x + timedelta(days=1)).isoformat() not in have:
                x += timedelta(days=1)
                n += 1
            out.append((s, x))
            have.update((s + timedelta(days=k)).isoformat() for k in range(n))
            x += timedelta(days=1)
        if len(out) >= limit:
            break
    return out


def ann_backfill(today, qends, limit=ANN_PER_ROUND, gap=ANN_GAP_S, out=None, sleep=time.sleep):
    """Reads NSE's result filings of the results seasons not read yet -> (requests done, requests left, stopped reason)."""
    out = out or log
    d = _ann_load()
    todo = ann_todo(qends, today, d['days'], limit)
    if not todo:
        return 0, 0, ''
    if not D.get('fetch'):
        return 0, len(todo), 'not bound'
    opener = D['session']()
    done, why, t0 = 0, '', time.time()
    for k, (a, b) in enumerate(todo):
        if k and k % 10 == 0 and len(todo) > 20:          # EpsTargetNow.bat: a line every 10 parts with the time left
            left_s = (time.time() - t0) / k * (len(todo) - k)
            out('EPS target: results dates - %d of %d part(s) read (now %s), about %d min left ...'
                % (k, len(todo), a.strftime('%d-%m-%Y'), max(1, round(left_s / 60))))
        recs, err = D['fetch'](opener, a, b)
        if recs is None:
            why = err or 'NSE did not answer'
            out('EPS target: results dates %s .. %s - could not read NSE (%s) - the next round tries again.'
                % (a.strftime('%d-%m-%Y'), b.strftime('%d-%m-%Y'), why))
            break
        rows, timed = D['rows'](recs)
        if recs and not timed:
            why = 'NSE\'s dates were not recognised'
            out('EPS target: %s - its fields: %s' % (why, ', '.join(sorted(recs[0].keys())[:20])))
            break
        remember(rows, a, b, today, d)
        _ann_save(d)
        done += 1
        if k + 1 < len(todo):
            sleep(gap)
    left = len(ann_todo(qends, today, d['days'], 9999))
    return done, left, why


def stamp_dt(s):
    """'yyyymmddHHMMSS' -> 'yyyy-mm-dd HH:MM:SS' or None."""
    s = str(s or '')
    if not re.match(r'^\d{14}$', s):
        return None
    try:
        return datetime(int(s[:4]), int(s[4:6]), int(s[6:8]), int(s[8:10]), int(s[10:12]), int(s[12:14])).strftime('%Y-%m-%d %H:%M:%S')
    except ValueError:
        return None


def announced(mi, filings, stamps):
    """When the results of quarter `mi` came out -> ('yyyy-mm-dd HH:MM:SS', 'nse' | 'xbrl') or (None, ''). NSE's result
    filing (the earliest in the season's window) first; with an XBRL file of the quarter, the filing must be at most
    XBRL_NEAR_DAYS days before the file's own time (an earlier "outcome of board meeting" was something else) - none =
    the file's time (it can come a few hours after the results PDF)."""
    lo = (end_of(mi) + timedelta(days=1)).isoformat()
    hi = (end_of(mi) + timedelta(days=ANN_WINDOW_DAYS)).isoformat() + ' 99'
    cands = [a for a in filings or [] if lo <= a <= hi]
    x = stamp_dt((stamps or {}).get(end_of(mi).isoformat()))
    if x and lo <= x[:10] <= (end_of(mi) + timedelta(days=XBRL_MAX_DAYS)).isoformat():
        near = (datetime.strptime(x, '%Y-%m-%d %H:%M:%S') - timedelta(days=XBRL_NEAR_DAYS)).strftime('%Y-%m-%d %H:%M:%S')
        ok = [a for a in cands if near <= a <= x]
        return (ok[0], 'nse') if ok else (x, 'xbrl')
    return (cands[0], 'nse') if cands else (None, '')


# ------------------------------------------------------------------ the formula
def eps_of_table(table):
    """A results table (xbrl_history) -> ({month index: EPS}, {month index: flag}, basis)."""
    eps, flags = {}, {}
    for r in (table or {}).get('q') or []:
        if not isinstance(r, list) or len(r) < 14:
            continue
        mi = mi_label(r[0])
        e = r[12]
        if mi and isinstance(e, (int, float)) and not isinstance(e, bool):
            eps[mi], flags[mi] = float(e), str(r[13] or '')
    return eps, flags, (table or {}).get('b', '')


def target_of(eps, mi):
    """The 8 EPS of quarter `mi` (oldest first) and the formula -> dict or None (a quarter missing)."""
    need = [mi - 3 * k for k in range(7, -1, -1)]
    if any(q not in eps for q in need):
        return None
    vals = [round(eps[q], 2) for q in need]
    ttm, prev = round(sum(vals[4:]), 2), round(sum(vals[:4]), 2)
    out = {'eps': vals, 'ttm': ttm, 'prev': prev, 'g': None, 'tgt': None, 'why': ''}
    if ttm <= 0:
        out['why'] = 'loss'
    elif prev <= 0:
        out['why'] = 'prevloss'
    else:
        g = (ttm - prev) / prev * 100
        out['g'] = round(g, 2)
        if g <= 0:
            out['why'] = 'fell'
        else:
            out['tgt'] = round(ttm * g, 2)
    return out


# ------------------------------------------------------------------ the prices after the results
def _r(v, d=1):
    return None if v is None else round(float(v), d)


def entry_index(days, at):
    """The candle of the first session that could react to results filed at `at` ('yyyy-mm-dd HH:MM...'): that day's own
    candle when they came before CLOSE_HHMM (before the open too), else the next one -> index or None."""
    d = date.fromisoformat(at[:10]).toordinal()
    k = bisect.bisect_left(days, d) if at[11:16] < CLOSE_HHMM else bisect.bisect_right(days, d)
    return k if k < len(days) else None


def _index_at(ix, day):
    """NIFTY 50's close on `day` (or the last one before it), else None."""
    if not ix:
        return None
    k = bisect.bisect_right(ix['d'], day) - 1
    return ix['c'][k] if k >= 0 else None


def after(cs, k0, tgt, ix=None):
    """The sessions after the entry candle k0 (Candles: o h l c day) -> the record's price fields."""
    o, h, lo, c, days = cs.o, cs.h, cs.l, cs.c, cs.day
    n = len(c) - 1 - k0
    ep = round(c[k0], 2)
    out = {'ed': date.fromordinal(days[k0]).isoformat(), 'ep': ep, 'pre': round(c[k0 - 1], 2) if k0 > 0 else None,
           'o0': round(o[k0], 2), 'n': n, 'hit': None, 'hitd': '', 'mx': [], 'dd': [], 'cl': [], 'ix': [], 'now': None,
           'ph': [], 'pc': []}
    if ep <= 0:
        return out
    span = min(n, WINDOWS[-1])
    for k in range(1, span + 1):
        if tgt and round(h[k0 + k], 2) >= tgt:      # float32 candles: 2322.15 is 2322.1499...
            out['hit'], out['hitd'] = k, date.fromordinal(days[k0 + k]).isoformat()
            break
    best, low = None, None
    e0 = _index_at(ix, days[k0])
    w = 0
    for k in range(1, span + 1):
        hk, lk = h[k0 + k], lo[k0 + k]
        best = hk if best is None or hk > best else best
        low = lk if low is None or lk < low else low
        while w < len(WINDOWS) and (k == WINDOWS[w] or k == span < WINDOWS[w]):
            out['mx'].append(_r(best / tgt * 100) if tgt else None)
            out['dd'].append(_r((low / ep - 1) * 100))
            full = k == WINDOWS[w]
            out['cl'].append(_r((c[k0 + k] / ep - 1) * 100) if full else None)
            e1 = _index_at(ix, days[k0 + k]) if full else None
            out['ix'].append(_r((e1 / e0 - 1) * 100) if e0 and e1 else None)
            w += 1
    while len(out['mx']) < len(WINDOWS):         # nothing after the entry yet
        out['mx'].append(None)
        out['dd'].append(None)
        out['cl'].append(None)
        out['ix'].append(None)
    if n > 0:
        out['now'] = _r((c[-1] / ep - 1) * 100)
    for j in range(0, span, PATH_STEP):
        a, b = k0 + 1 + j, k0 + min(j + PATH_STEP, span)
        out['ph'].append(_r((max(h[a:b + 1]) / ep - 1) * 100))
        out['pc'].append(_r((c[b] / ep - 1) * 100))
    return out


# ------------------------------------------------------------------ one stock, every quarter
def stock_rows(sym, eps, flags, basis, src, filings, stamps, cs, ix, qends):
    """-> {quarter month index: row dict} for the quarters with their 8 EPS."""
    out = {}
    days = list(cs.day) if cs is not None else []
    for mi in qends:
        t = target_of(eps, mi)
        if not t:
            continue
        need = [mi - 3 * k for k in range(7, -1, -1)]
        fl = ''.join((flags.get(q) or '-') if src == 'nse' else 'p' for q in need)
        row = {'sym': sym, 'st': 'x', 'why': t['why'], 'b': basis or '', 'fl': fl, 'eps': t['eps'], 'ttm': t['ttm'],
               'prev': t['prev'], 'g': t['g'], 'tgt': t['tgt'], 'ann': '', 'src': ''}
        at, how = announced(mi, filings, stamps)
        if at:
            row['ann'], row['src'] = at[:16], how
        if not t['why']:
            if not at:
                row['why'] = 'date'
            elif not days:
                row['why'] = 'price'
            else:
                k0 = entry_index(days, at)
                if k0 is None:
                    row['why'] = 'wait'
                else:
                    row.update(after(cs, k0, t['tgt'], ix))
                    row['st'] = 'ok'
        out[mi] = row
    return out


def _med(vals):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return None
    m = len(v) // 2
    return round(v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2, 1)


def summary(rows):
    """A quarter's figures for the page's list (the targets above the entry price - one already reached is counted apart):
    win {W: [finished, reached, near miss, still running, reached while still running]}."""
    ok = [r for r in rows if r['st'] == 'ok']
    tg = [r for r in ok if r['tgt'] and r['tgt'] > r['ep']]
    why = {}
    for r in rows:
        if r['st'] != 'ok' and r['why']:
            why[r['why']] = why.get(r['why'], 0) + 1
    win = {}
    for i, W in enumerate(WINDOWS):
        # counted only once the whole window is over (an early hit of a result still running would flatter the rate)
        reached = lambda r: r['hit'] is not None and r['hit'] <= W
        full = [r for r in tg if r['n'] >= W]
        hit = sum(1 for r in full if reached(r))
        near = sum(1 for r in full if not reached(r) and (r['mx'][i] or 0) >= 100 - NEAR_PCT)
        early = sum(1 for r in tg if r['n'] < W and reached(r))
        win[str(W)] = [len(full), hit, near, len(tg) - len(full), early]
    srcs = {}
    for r in rows:
        if r['src']:
            srcs[r['src']] = srcs.get(r['src'], 0) + 1
    ready = bool(tg) and sum(1 for r in tg if r['n'] >= READY_SESSIONS) >= READY_SHARE * len(tg)
    return {'stocks': len(rows), 'ok': len(ok), 'target': len(tg), 'above': len(ok) - len(tg), 'why': why, 'win': win,
            'medG': _med(r['g'] for r in tg), 'medUp': _med((r['tgt'] / r['ep'] - 1) * 100 for r in tg),
            'medN': _med(r['n'] for r in tg), 'ready': ready, 'ann': srcs}


def pack(rows):
    """Rows -> base64 of the gzip of {'cols', 'rows'} (the sheet keeps it as text; api/epstarget unpacks it)."""
    body = json.dumps({'cols': list(COLS), 'rows': [[r.get(k) for k in COLS] for r in rows]}, separators=(',', ':'))
    return base64.b64encode(gzip.compress(body.encode('utf-8'), 9, mtime=0)).decode('ascii')


def unpack(blob):
    d = json.loads(gzip.decompress(base64.b64decode(blob)).decode('utf-8'))
    return [dict(zip(d['cols'], r)) for r in d['rows']]


# ------------------------------------------------------------------ every stock
def compute(lab, inputs, screener, today=None, n=QUARTERS, only=None):
    """lab = backtest_lab (its daily candle cache), inputs = {SYM: (results table, {quarter end iso: XBRL stamp})},
    screener = {SYM: (basis, {month index: EPS})} (pe_history's records, a split / bonus already on today's share count)
    -> (upto, {quarter month index: [rows]}, counts)."""
    today = today or date.today()
    qends = quarter_ends(today, n)
    meta, d = lab.load_meta()
    idx = ((meta or {}).get('index') or {}).get('D') or {}
    ix = ((meta or {}).get('indices') or {}).get(BENCH)
    upto = str((meta or {}).get('upto') or '')
    filings = _ann_load()['rows']
    syms = set(idx) | set(inputs) | set(screener)
    if only:
        syms &= set(only)
    out = {mi: [] for mi in qends}
    counts = {'stocks': 0, 'noEps': 0, 'noPrices': 0}
    f = open(os.path.join(d, 'D.bin'), 'rb') if d and idx else None
    try:
        for sym in sorted(syms):
            table, stamps = inputs.get(sym) or (None, {})
            eps, flags, basis = eps_of_table(table)
            src = 'nse'
            if not any(all((mi - 3 * k) in eps for k in range(8)) for mi in qends):
                rec = screener.get(sym)
                if rec:
                    basis, eps = rec[0] or '', dict(rec[1] or {})
                    flags, src = {}, 'screener'
            cs = None
            if f is not None and sym in idx and idx[sym][1] > 0:
                cs = lab.Candles(f, idx[sym][0], idx[sym][1])
            rows = stock_rows(sym, eps, flags, basis, src, filings.get(sym), stamps, cs, ix, qends)
            if not rows:
                counts['noEps'] += 1
                continue
            counts['stocks'] += 1
            if cs is None:
                counts['noPrices'] += 1
            for mi, r in rows.items():
                out[mi].append(r)
    finally:
        if f:
            f.close()
    return upto, out, counts


# ------------------------------------------------------------------ the round's step
def _load_state():
    try:
        with open(STATE_PATH, encoding='utf-8') as f:
            st = json.load(f)
    except (OSError, ValueError):
        st = {}
    return st if isinstance(st, dict) else {}


def _save_state(st):
    try:
        tmp = STATE_PATH + '.%d.tmp' % os.getpid()
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(st, f)
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def _signature(lab, xbrl_changed, peh_changed):
    d = lab.current_dir() or ''
    am = float(_ann_load().get('changed') or 0)
    return '%s|%s|%s|%s|%d|%d' % (os.path.basename(d.rstrip('/\\')), round(xbrl_changed or 0), round(peh_changed or 0),
                                  round(am), ENGINE, date.today().toordinal())


def step(cfg, api, lab, inputs, screener, xbrl_changed=0.0, peh_changed=0.0, force=False, backfill=None, today=None,
         out=None, gap=ANN_GAP_S, sleep=time.sleep):
    """The round's step (never raises): the results dates of a few more days from NSE, then - when anything changed -
    every quarter's rows worked out and the quarters that changed sent to the sheet. -> quarters sent or None."""
    out = out or log
    if not cfg.get('eps_target', True):
        return None
    try:
        today = today or date.today()
        n = max(2, min(16, int(cfg.get('eps_target_quarters') or QUARTERS)))
        qends = quarter_ends(today, n)
        limit = ANN_PER_ROUND if backfill is None else backfill
        if limit > 0 and cfg.get('announcements', True):
            with (D['nse_part']('EPS target results dates') if D.get('nse_part') else _Null()):
                done, left, why = ann_backfill(today, qends, limit, gap, out, sleep)
            if done:
                out('EPS target: read %d more part(s) of NSE\'s result filings (the results dates)%s.'
                    % (done, (' - %d part(s) left, the next rounds read them (EpsTargetNow.bat: all at once)' % left) if left else
                       ' - every results season read'))
        if not lab.current_dir():
            out('EPS target: no Kite daily candles on this computer yet (they come with the daily Kite scan).')
            return None
        st = _load_state()
        sig = _signature(lab, xbrl_changed, peh_changed)
        if not force and st.get('sig') == sig:
            return 0
        t0 = time.time()
        upto, per_q, counts = compute(lab, inputs() if callable(inputs) else inputs, screener() if callable(screener) else screener,
                                      today, n)
        sent_md5 = st.get('sent') or {}
        sent, refused = 0, ''
        made = datetime.now().isoformat(timespec='seconds')
        for mi in qends:
            rows = per_q.get(mi) or []
            if not rows:
                continue
            rows = rows[:KEEP_ROWS]
            blob = pack(rows)
            q = label_of(mi)
            md5 = hashlib.md5(('%s|%s|%d' % (blob, upto, ENGINE)).encode('ascii')).hexdigest()
            if not force and sent_md5.get(q) == md5:
                continue
            body = {'op': 'put', 'q': q, 'end': end_of(mi).isoformat(), 'fy': fy_words(mi), 'made': made, 'upto': upto,
                    'sum': summary(rows), 'blob': blob, 'engine': ENGINE}
            try:
                ans = api(cfg, 'epst', body, tries=2, timeout=240)
            except RuntimeError as e:
                refused = 'could not send (%s)' % e
                break
            if not ans.get('ok'):
                err = str(ans.get('error') or 'unknown error')
                refused = ('the sheet does not know the EPS Target Lab yet - the laptop\'s updater puts the new sheet code in '
                           '(UpdateNow.bat), then it is sent' if 'unknown action' in err else 'the sheet refused - %s' % err)
                break
            sent_md5[q] = md5
            sent += 1
        st['sent'] = sent_md5
        if not refused:
            st['sig'] = sig
        _save_state(st)
        if refused:
            out('EPS target: %s - the next round tries again.' % refused)
            return None
        if sent or force:
            q = label_of(qends[1] if len(qends) > 1 and not summary(per_q.get(qends[0]) or []).get('ready') else qends[0])
            out('EPS target (prices up to %s): %d stock(s) with 8 quarters of EPS, %d quarter(s) sent to the sheet (%.1f s)%s.'
                % (upto, counts['stocks'], sent, time.time() - t0, ('; ' + quarter_words(per_q, q)) if q else ''))
        return sent
    except Exception as e:          # never stops a round
        out('EPS target: %s' % e)
        return None


class _Null:
    def __enter__(self):
        return self

    def __exit__(self, *a):
        return False


def quarter_words(per_q, q):
    """'Jun 2026 (Q1 FY27): target for 812 stocks above the entry price - reached within 30 sessions 96 of 790 finished
    (12%), 60: ...'."""
    mi = mi_label(q)
    rows = per_q.get(mi) or []
    s = summary(rows)
    parts = []
    for W in WINDOWS:
        done, hit = s['win'][str(W)][:2]
        if done:
            parts.append('%d sessions: %d of %d finished (%d%%)' % (W, hit, done, round(hit * 100.0 / done)))
    return '%s (%s): a target above the entry price for %d stock(s)%s' % (
        q, fy_words(mi), s['target'], (' - reached within ' + ', '.join(parts)) if parts else ' - none finished yet')


def stock_words(per_q, sym):
    """EpsTargetNow.bat SYMBOL: every quarter of one stock in plain words (the owner checks a stock he knows)."""
    lines = []
    for mi in sorted(per_q, reverse=True):
        for r in per_q[mi]:
            if r['sym'] != sym:
                continue
            labs = [label_of(mi - 3 * k) for k in range(7, -1, -1)]
            e = ', '.join('%s %g' % (labs[k], r['eps'][k]) for k in range(4, 8))
            p = ', '.join('%s %g' % (labs[k], r['eps'][k]) for k in range(4))
            s = '%s %s (%s): EPS %s = TTM %g; before: %s = %g' % (sym, label_of(mi), fy_words(mi), e, r['ttm'], p, r['prev'])
            if r['g'] is not None:
                s += ' -> growth %.1f%%' % r['g']
            if r['tgt']:
                s += ' -> target %.2f' % r['tgt']
            if r['ann']:
                s += '; results %s (%s)' % (r['ann'], 'NSE result filing' if r['src'] == 'nse' else 'XBRL file time')
            if r['st'] == 'ok':
                s += ' -> entry %s close %.2f (upside %.1f%%)' % (r['ed'], r['ep'], (r['tgt'] / r['ep'] - 1) * 100)
                if r['tgt'] <= r['ep']:
                    s += ' - already above the target'
                elif r['hit']:
                    s += ' - target reached after %d session(s) on %s' % (r['hit'], r['hitd'])
                else:
                    best = next((m for m in reversed(r['mx']) if m is not None), None)
                    s += ' - not reached in %d session(s) so far%s' % (r['n'], (' (best high %.1f%% of it)' % best) if best else '')
            elif r['why']:
                s += ' - %s' % WHY.get(r['why'], r['why'])
            lines.append(s)
    return lines
