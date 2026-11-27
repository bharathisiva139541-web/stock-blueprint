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

ENGINE = 3                  # the rules' version (sent with every post; a change sends every quarter again) - 2: 80 / 90 / 100 %
                            # of the way to the target, downside targets, per-stock NSE list dates (24-Nov-2026); 3: 50 / 60 / 70 %
                            # too + the window up to the next quarter's results (24-Nov-2026)
QUARTERS = 32               # quarter ends worked out (config.json eps_target_quarters, 2..QUARTERS_MAX) - owner, 27-Nov-2026:
                            # "backtest ku inum neraya quarterly tables thevapaduthu" -> 10 years of NSE filings (xbrl_history
                            # YEARS) = 40 quarters = 33 quarters with 8 before them; it was 8
QUARTERS_MAX = 36
WINDOWS = (30, 60, 90, 120, 180)    # sessions after the entry (about 1.5 / 3 / 4.5 / 6 / 9 months)
THRESH = (50, 60, 70, 80, 90, 100)  # reached = a daily high (a target under the entry: a daily low) covered this % of the way
                            # from the entry to the target (owner, 24-Nov-2026: "if a stock hit atleast 80% of the target price,
                            # consider as it is target hit" - his answer: 80 % of the way, entry 100 / target 200 -> 180; then
                            # "give more option like ... 70% of the way, 60% of the way, 50% of the way")
MAIN_T = THRESH.index(80)   # his rule (the words of EpsTargetNow.bat)
NEXT = 'next'               # the window up to the next quarter's results (owner, 24-Nov-2026: "add another session, as reached
                            # within next quarterly result date"): the sessions after the entry before the first one that could
                            # react to the next results
NEXT_DUE_DAYS = 45          # no date found for the next results: SEBI's last day (45 days after the quarter end, 60 for the
NEXT_DUE_DAYS_MAR = 60      # March quarter / the year's results) is taken once NEXT_GRACE_DAYS more passed (marked nqa 1)
NEXT_GRACE_DAYS = 15
PATH_MAX = 40               # the chart's path points at most (200 sessions)
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
COLS = ('sym', 'st', 'why', 'b', 'fl', 'eps', 'ttm', 'prev', 'g', 'tgt', 'ann', 'src', 'ed', 'ep', 'pre', 'o0', 'n', 'kp',
        'kd', 'pg', 'hh', 'dd', 'cl', 'ix', 'nq', 'nqa', 'nx', 'wq', 'now', 'ph', 'pc')
XB_PATH = os.path.join(HERE, 'eps_target_xbrl.json')   # the results times read from NSE's per-stock XBRL lists
XB_PER_ROUND = 20           # stocks still without a results date asked a full round (EpsTargetNow.bat: every one)
XB_GAP_S = 6.0              # between two NSE requests (the XBRL history job's pace)
XB_REASK_DAYS = 7           # a stock asked before is asked again after this many days while a date is still missing
XB_NONE_DAYS = 30           # ... and after this many when NSE's lists had no result filing of it at all
WHY = {'loss': 'a loss over the last 4 quarters (TTM EPS 0 or less)',
       'prevloss': 'a loss in the 4 quarters before (no growth % to work out)',
       'fell': 'EPS fell (growth 0 or less - no target)',
       'date': 'no results date found yet',
       'wait': 'no session since the results yet',
       'price': 'no daily candles for it',
       'nofiling': 'NSE has no result filings of it (e.g. listed on BSE only)'}
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


def after(cs, k0, tgt, ix=None, nq=None):
    """The sessions after the entry candle k0 (Candles: o h l c day) -> the record's price fields. Progress = how much of the
    way from the entry to the target a session covered: a target above the entry by its HIGH, one under it (a downside
    target - the owner, 24-Nov-2026: "if target price was below the entry price, the market price should hit this downside
    target ... it should not mingle with long trades") by its LOW. kp / kd = the first session (and its day) reaching
    50 / 60 / 70 / 80 / 90 / 100 % of the way; per window pg = the best progress, hh / dd = the highest high / lowest low vs
    the entry (so far while it runs), cl / ix = the close / NIFTY 50 at its end (only once it is over). `nq` = the sessions
    before the next results (None = not out yet): wq = [pg, hh, dd, cl, ix] of that window (so far while it runs)."""
    o, h, lo, c, days = cs.o, cs.h, cs.l, cs.c, cs.day
    n = len(c) - 1 - k0
    ep = round(c[k0], 2)
    out = {'ed': date.fromordinal(days[k0]).isoformat(), 'ep': ep, 'pre': round(c[k0 - 1], 2) if k0 > 0 else None,
           'o0': round(o[k0], 2), 'n': n, 'kp': [None] * len(THRESH), 'kd': [''] * len(THRESH), 'pg': [], 'hh': [], 'dd': [],
           'cl': [], 'ix': [], 'wq': [None] * 5, 'now': None, 'ph': [], 'pc': []}
    span = min(n, max(WINDOWS[-1], nq or 0)) if ep > 0 and tgt is not None else 0
    qk = nq if nq is not None else span            # where the next-results window is read (so far while it runs)
    up = tgt is not None and tgt > ep
    dist = abs(tgt - ep) if tgt is not None else 0
    best, hi, low = None, None, None
    e0 = _index_at(ix, days[k0])
    w = 0
    for k in range(1, span + 1):
        hk, lk = round(h[k0 + k], 2), round(lo[k0 + k], 2)      # float32 candles: 2322.15 is 2322.1499...
        p = 100.0 if not dist else ((hk - ep) if up else (ep - lk)) / dist * 100
        for t, T in enumerate(THRESH):
            if out['kp'][t] is None and p >= T - 1e-6:
                out['kp'][t], out['kd'][t] = k, date.fromordinal(days[k0 + k]).isoformat()
        best = p if best is None or p > best else best
        hi = hk if hi is None or hk > hi else hi
        low = lk if low is None or lk < low else low
        if k == qk:
            full = nq is not None
            e1 = _index_at(ix, days[k0 + k]) if full else None
            out['wq'] = [_r(best), _r((hi / ep - 1) * 100), _r((low / ep - 1) * 100),
                         _r((c[k0 + k] / ep - 1) * 100) if full else None, _r((e1 / e0 - 1) * 100) if e0 and e1 else None]
        while w < len(WINDOWS) and (k == WINDOWS[w] or k == span < WINDOWS[w]):
            out['pg'].append(_r(best))
            out['hh'].append(_r((hi / ep - 1) * 100))
            out['dd'].append(_r((low / ep - 1) * 100))
            full = k == WINDOWS[w]
            out['cl'].append(_r((c[k0 + k] / ep - 1) * 100) if full else None)
            e1 = _index_at(ix, days[k0 + k]) if full else None
            out['ix'].append(_r((e1 / e0 - 1) * 100) if e0 and e1 else None)
            w += 1
    for k in ('pg', 'hh', 'dd', 'cl', 'ix'):         # nothing after the entry yet
        out[k] += [None] * (len(WINDOWS) - len(out[k]))
    if n > 0 and ep > 0:
        out['now'] = _r((c[-1] / ep - 1) * 100)
    for j in range(0, min(span, PATH_MAX * PATH_STEP), PATH_STEP):
        a, b = k0 + 1 + j, k0 + min(j + PATH_STEP, span)
        out['ph'].append(_r((max(h[a:b + 1]) / ep - 1) * 100))
        out['pc'].append(_r((c[b] / ep - 1) * 100))
    return out


# ------------------------------------------------------------------ one stock, every quarter
def stock_rows(sym, eps, flags, basis, src, filings, stamps, cs, ix, qends, nofiling=False):
    """-> {quarter month index: row dict} for the quarters with their 8 EPS (`nofiling` = NSE's lists of the stock had no
    result filing at all)."""
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
                row['why'] = 'nofiling' if nofiling else 'date'
            elif not days:
                row['why'] = 'price'
            else:
                k0 = entry_index(days, at)
                if k0 is None:
                    row['why'] = 'wait'
                else:
                    nq, nqa, nx = next_window(mi, filings, stamps, days, k0)
                    row.update(after(cs, k0, t['tgt'], ix, nq))
                    row.update({'nq': nq, 'nqa': nqa, 'nx': nx, 'st': 'ok'})
        out[mi] = row
    return out


def next_window(mi, filings, stamps, days, k0):
    """The window up to the next quarter's results -> (nq, nqa, nx): nq = the sessions after the entry k0 before the first
    session that could react to them (all of them when that session has not come yet; None = the next results are not out
    yet), nqa 1 = no date was found for them - the window ends on SEBI's last day for them instead, nx = when they came
    ('yyyy-mm-dd HH:MM', '' none)."""
    n = len(days) - 1 - k0
    at, _how = announced(mi + 3, filings, stamps)
    if at:
        kn = entry_index(days, at)
        return (n if kn is None else max(0, kn - 1 - k0)), 0, at[:16]
    due = end_of(mi + 3) + timedelta(days=NEXT_DUE_DAYS_MAR if (mi + 3) % 12 == 3 else NEXT_DUE_DAYS)
    if days and date.fromordinal(days[-1]) > due + timedelta(days=NEXT_GRACE_DAYS):
        return max(0, bisect.bisect_right(days, due.toordinal()) - 1 - k0), 1, ''
    return None, 0, ''


def _med(vals):
    v = sorted(x for x in vals if x is not None)
    if not v:
        return None
    m = len(v) // 2
    return round(v[m] if len(v) % 2 else (v[m - 1] + v[m]) / 2, 1)


def _wins(group):
    """{W: [finished (the window over), still running, reached 50 / 60 / 70 / 80 / 90 / 100 % of the way among the finished,
    the same among the ones still running]} for W = 30 .. 180 sessions and 'next' (up to the next results) - a result counts
    in a window only once the whole window is over (an early hit alone would flatter the rate)."""
    out = {}
    nt = len(THRESH)
    for W in WINDOWS + (NEXT,):
        done, hits, early = 0, [0] * nt, [0] * nt
        for r in group:
            if W == NEXT:
                fin = r.get('nq') is not None
                lim = r['nq'] if fin else r['n']
            else:
                fin, lim = r['n'] >= W, W
            done += fin
            for t in range(nt):
                k = r['kp'][t]
                if k is not None and k <= lim:
                    if fin:
                        hits[t] += 1
                    else:
                        early[t] += 1
        out[str(W)] = [done, len(group) - done] + hits + early
    return out


def summary(rows):
    """A quarter's figures for the page's list: the targets above the entry (long) and the ones under it (downside, apart)."""
    ok = [r for r in rows if r['st'] == 'ok']
    ups = [r for r in ok if r['tgt'] > r['ep']]
    downs = [r for r in ok if r['tgt'] <= r['ep']]
    why = {}
    for r in rows:
        if r['st'] != 'ok' and r['why']:
            why[r['why']] = why.get(r['why'], 0) + 1
    srcs = {}
    for r in rows:
        if r['src']:
            srcs[r['src']] = srcs.get(r['src'], 0) + 1
    ready = bool(ups) and sum(1 for r in ups if r['n'] >= READY_SESSIONS) >= READY_SHARE * len(ups)
    return {'stocks': len(rows), 'ok': len(ok), 'target': len(ups), 'down': len(downs), 'why': why, 'win': _wins(ups),
            'dwin': _wins(downs), 'medG': _med(r['g'] for r in ups), 'medUp': _med((r['tgt'] / r['ep'] - 1) * 100 for r in ups),
            'medN': _med(r['n'] for r in ups), 'ready': ready, 'ann': srcs}


def pack(rows):
    """Rows -> base64 of the gzip of {'cols', 'rows'} (the sheet keeps it as text; api/epstarget unpacks it)."""
    body = json.dumps({'cols': list(COLS), 'rows': [[r.get(k) for k in COLS] for r in rows]}, separators=(',', ':'))
    return base64.b64encode(gzip.compress(body.encode('utf-8'), 9, mtime=0)).decode('ascii')


def unpack(blob):
    d = json.loads(gzip.decompress(base64.b64decode(blob)).decode('utf-8'))
    return [dict(zip(d['cols'], r)) for r in d['rows']]


# ------------------------------------------------------------------ every stock
def eps_for(sym, inputs, screener, qends):
    """A stock's quarterly EPS -> (eps {month index: EPS}, flags, basis, src 'nse' | 'screener', XBRL stamps): the results
    table when it has the 8 quarters of one of the quarters, else pe_history's screener.in record."""
    table, stamps = inputs.get(sym) or (None, {})
    eps, flags, basis = eps_of_table(table)
    src = 'nse'
    if not any(all((mi - 3 * k) in eps for k in range(8)) for mi in qends):
        rec = screener.get(sym)
        if rec:
            basis, eps = rec[0] or '', dict(rec[1] or {})
            flags, src = {}, 'screener'
    return eps, flags, basis, src, dict(stamps or {})


def _stamps_of(sym, stamps, xb):
    """The XBRL history job's stamps + the ones read from NSE's lists for the results dates (the earliest per quarter end)."""
    out = dict(stamps or {})
    for e, st in ((xb.get(sym) or {}).get('stamps') or {}).items():
        if e not in out or st < out[e]:
            out[e] = st
    return out


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
    xb = _xb_load()['syms']
    syms = set(idx) | set(inputs) | set(screener)
    if only:
        syms &= set(only)
    out = {mi: [] for mi in qends}
    counts = {'stocks': 0, 'noEps': 0, 'noPrices': 0}
    f = open(os.path.join(d, 'D.bin'), 'rb') if d and idx else None
    try:
        for sym in sorted(syms):
            eps, flags, basis, src, stamps = eps_for(sym, inputs, screener, qends)
            cs = None
            if f is not None and sym in idx and idx[sym][1] > 0:
                cs = lab.Candles(f, idx[sym][0], idx[sym][1])
            x = xb.get(sym) or {}
            rows = stock_rows(sym, eps, flags, basis, src, filings.get(sym), _stamps_of(sym, stamps, xb), cs, ix, qends,
                              nofiling=bool(x) and not x.get('n'))
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


# ------------------------------------------------------------------ the results dates from NSE's per-stock XBRL lists
# Owner, 24-Nov-2026: "in no target section, i have found some stocks without resultout date, but in NSE integrated filing
# page, their results date with XBRL is available. example SYRMA ... First try to get maximum result date". A stock whose
# quarter still has no results time after the announcements archive and the XBRL history job's files: NSE's integrated
# filing list of the stock (the page the owner showed - each result file's broadcast date / time), the same list half a
# year at a time when the plain answer (the newest 20) does not reach the quarter, then the older financial results list.
def _xb_load():
    try:
        with open(XB_PATH, encoding='utf-8') as f:
            d = json.load(f)
    except (OSError, ValueError):
        d = {}
    if not isinstance(d, dict) or d.get('v') != 1:
        d = {'v': 1, 'syms': {}}
    d['syms'] = {k: v for k, v in (d.get('syms') or {}).items() if isinstance(v, dict)}
    return d


def _xb_save(d):
    tmp = XB_PATH + '.%d.tmp' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, separators=(',', ':'))
    os.replace(tmp, XB_PATH)


def missing_dates(inputs, screener, qends, now=None):
    """[(SYM, [quarter month indexes with 8 EPS but no results time])] still to ask NSE's lists for: stocks with a missing
    quarter that has a target first, the newest missing quarter first; a stock asked within XB_REASK_DAYS (XB_NONE_DAYS
    when its lists had nothing) left alone."""
    now = time.time() if now is None else now
    filings = _ann_load()['rows']
    xb = _xb_load()['syms']
    out = []
    for sym in sorted(set(inputs) | set(screener)):
        eps, _f, _b, _s, stamps = eps_for(sym, inputs, screener, qends)
        st = _stamps_of(sym, stamps, xb)
        miss, tgt = [], False
        for mi in qends:
            t = target_of(eps, mi)
            if t and announced(mi, filings.get(sym), st)[0] is None:
                miss.append(mi)
                tgt = tgt or bool(t['tgt'])
        if not miss:
            continue
        x = xb.get(sym)
        if x and now - float(x.get('at') or 0) < (XB_REASK_DAYS if x.get('n') else XB_NONE_DAYS) * 86400:
            continue
        out.append((not tgt, -max(miss), sym, miss))
    out.sort()
    return [(sym, miss) for _t, _m, sym, miss in out]


def _windows(miss, today):
    """The half-open filing windows of the missing quarters (quarter end + 1 .. + XBRL_MAX_DAYS, to today), merged."""
    spans = sorted((end_of(mi) + timedelta(days=1), min(end_of(mi) + timedelta(days=XBRL_MAX_DAYS), today)) for mi in miss)
    out = []
    for a, b in spans:
        if out and a <= out[-1][1] + timedelta(days=1):
            out[-1] = (out[-1][0], max(out[-1][1], b))
        else:
            out.append((a, b))
    return out


def stock_dates(nse, sym, miss, today):
    """NSE's result files of one stock -> ({quarter end iso: the earliest broadcast stamp}, records NSE listed). Raises the
    XBRL history module's Blocked when NSE answered none of the lists."""
    XH = D['xh']
    q = sym.replace('&', '%26')
    got, total, answered = {}, 0, False

    def take(metas):
        for m in metas:
            e, stp = m.get('end') or '', m.get('stamp') or ''
            if m.get('gov') or not e or len(stp) != 14:
                continue
            if e not in got or stp < got[e]:
                got[e] = stp

    def left():
        return [mi for mi in miss if end_of(mi).isoformat() not in got]
    for k, (name, url) in enumerate(XH.LISTS):
        if k and not left():
            break
        metas, ok, nrec = XH._list(nse, name, url.format(s=q), None)
        answered = answered or ok
        total += nrec
        take(metas)
        if left() and nrec >= XH.PAGE_FULL:          # a full page: the rest of the missing quarters' windows asked by date
            dated = XH.INT_DATED if k == 0 else XH.DATED
            for a, b in _windows(left(), today):
                more, ok2, n2 = XH._list(nse, dated[0], dated[1].format(s=q, f=a.strftime('%d-%m-%Y'), t=b.strftime('%d-%m-%Y')), None)
                total += n2
                take(more)
    if not answered:
        raise XH.Blocked('NSE did not answer')
    return got, total


def xbrl_dates(today, todo, limit=XB_PER_ROUND, gap=XB_GAP_S, out=None, sleep=time.sleep, now=None):
    """Asks NSE's per-stock lists for the stocks in `todo` ([(SYM, missing quarters)]) -> (stocks asked, dates found,
    stocks left, stopped reason)."""
    out = out or log
    if not todo or limit <= 0:
        return 0, 0, len(todo or []), ''
    if not D.get('xh'):
        return 0, 0, len(todo), 'not bound'
    XH = D['xh']
    nse = XH.Nse(max(gap, getattr(XH, 'MIN_GAP_S', 5.0)), sleep)
    d = _xb_load()
    asked, found, why, t0 = 0, 0, '', time.time()
    part = todo[:limit]
    for k, (sym, miss) in enumerate(part):
        if k and k % 10 == 0 and len(part) > 20:
            left_s = (time.time() - t0) / k * (len(part) - k)
            out('EPS target: results dates from NSE\'s XBRL lists - %d of %d stock(s) asked (%d date(s) found so far), about %d min '
                'left ...' % (k, len(part), found, max(1, round(left_s / 60))))
        try:
            got, total = stock_dates(nse, sym, miss, today)
        except XH.Blocked as e:
            why = str(e)
            out('EPS target: NSE\'s XBRL lists - %s (the next round goes on).' % why)
            break
        old = (d['syms'].get(sym) or {}).get('stamps') or {}
        new = dict(old)
        new.update(got)
        found += sum(1 for mi in miss if end_of(mi).isoformat() in got)
        d['syms'][sym] = {'at': round(time.time() if now is None else now), 'stamps': new, 'n': total}
        if new != old:
            d['changed'] = time.time()
        asked += 1
        if asked % 10 == 0:
            _xb_save(d)
    if asked:
        _xb_save(d)
    return asked, found, len(todo) - asked, why


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
    xm = float(_xb_load().get('changed') or 0)
    return '%s|%s|%s|%s|%s|%d|%d' % (os.path.basename(d.rstrip('/\\')), round(xbrl_changed or 0), round(peh_changed or 0),
                                     round(am), round(xm), ENGINE, date.today().toordinal())


def step(cfg, api, lab, inputs, screener, xbrl_changed=0.0, peh_changed=0.0, force=False, backfill=None, today=None,
         out=None, gap=ANN_GAP_S, sleep=time.sleep, xbrl_limit=None, xbrl_gap=XB_GAP_S):
    """The round's step (never raises): the results dates of a few more days from NSE, then - when anything changed -
    every quarter's rows worked out and the quarters that changed sent to the sheet. -> quarters sent or None."""
    out = out or log
    if not cfg.get('eps_target', True):
        return None
    try:
        today = today or date.today()
        n = max(2, min(QUARTERS_MAX, int(cfg.get('eps_target_quarters') or QUARTERS)))
        qends = quarter_ends(today, n)
        limit = ANN_PER_ROUND if backfill is None else backfill
        if limit > 0 and cfg.get('announcements', True):
            with (D['nse_part']('EPS target results dates') if D.get('nse_part') else _Null()):
                done, left, why = ann_backfill(today, qends, limit, gap, out, sleep)
            if done:
                out('EPS target: read %d more part(s) of NSE\'s result filings (the results dates)%s.'
                    % (done, (' - %d part(s) left, the next rounds read them (EpsTargetNow.bat: all at once)' % left) if left else
                       ' - every results season read'))
        inputs = inputs() if callable(inputs) else inputs
        screener = screener() if callable(screener) else screener
        xl = XB_PER_ROUND if xbrl_limit is None else xbrl_limit
        if xl > 0 and D.get('xh'):
            todo = missing_dates(inputs, screener, qends)
            if todo:
                with (D['nse_part']('EPS target results dates (XBRL lists)') if D.get('nse_part') else _Null()):
                    asked, found, left, why = xbrl_dates(today, todo, xl, xbrl_gap, out, sleep)
                if asked:
                    out('EPS target: NSE\'s XBRL lists of %d stock(s) without a results date read - %d date(s) found%s.'
                        % (asked, found, (' - %d stock(s) left for the next rounds (EpsTargetNow.bat: all at once)' % left) if left
                                         else ''))
        if not lab.current_dir():
            out('EPS target: no Kite daily candles on this computer yet (they come with the daily Kite scan).')
            return None
        st = _load_state()
        sig = _signature(lab, xbrl_changed, peh_changed)
        if not force and st.get('sig') == sig:
            return 0
        t0 = time.time()
        upto, per_q, counts = compute(lab, inputs, screener, today, n)
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
    """'Jun 2026 (Q1 FY27): 812 targets above the entry, 400 under it - 80 % of the way reached within 30 sessions 96 of 790
    finished (12%), ...'."""
    mi = mi_label(q)
    rows = per_q.get(mi) or []
    s = summary(rows)
    parts = []
    for W in WINDOWS + (NEXT,):
        w = s['win'][str(W)]
        done, hit = w[0], w[2 + MAIN_T]
        if done:
            parts.append('%s: %d of %d finished (%d%%)' % ('before the next results' if W == NEXT else '%d sessions' % W, hit, done,
                                                           round(hit * 100.0 / done)))
    return '%s (%s): %d target(s) above the entry price, %d under it%s' % (
        q, fy_words(mi), s['target'], s['down'], (' - %d%% of the way reached within ' % THRESH[MAIN_T] + ', '.join(parts))
        if parts else ' - none finished yet')


def next_words(r):
    """The window up to the next results of one row, in words."""
    nq, k = r.get('nq'), r['kp'][MAIN_T]
    if nq is None:
        return 'the next results are not out yet (%d session(s) so far%s)' % (
            r['n'], ', %d%% of the way already' % THRESH[MAIN_T] if k is not None else '')
    when = ('next results %s' % r['nx']) if r.get('nx') else 'no date found for the next results - taken as their last day allowed'
    return '%s: %d session(s) after the entry before them - %d%% of the way %s' % (
        when, nq, THRESH[MAIN_T], 'reached before them' if k is not None and k <= nq else 'not reached before them')


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
                up = r['tgt'] > r['ep']
                s += ' -> entry %s close %.2f (target %+.1f%%%s)' % (r['ed'], r['ep'], (r['tgt'] / r['ep'] - 1) * 100,
                                                                    '' if up else ', a DOWNSIDE target')
                way = 'up' if up else 'down'
                got = ['%d%% of the way %s after %d session(s) (%s)' % (T, way, r['kp'][t], r['kd'][t])
                       for t, T in enumerate(THRESH) if r['kp'][t] is not None]
                if got:
                    s += ' - ' + '; '.join(got)
                else:
                    best = next((m for m in reversed(r['pg']) if m is not None), None)
                    s += ' - not %d%% of the way in %d session(s) so far%s' % (
                        THRESH[0], r['n'], (' (best %.0f%% of the way)' % best) if best is not None else '')
                s += '; ' + next_words(r)
            elif r['why']:
                s += ' - %s' % WHY.get(r['why'], r['why'])
            lines.append(s)
    return lines
