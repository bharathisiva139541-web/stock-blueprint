"""Historical PE of every stock - median PE of 1 / 3 / 5 years and the 5-year peak (owner, 17-Nov-2026: "Oru stock oda Peak
PE ratio, 5 year median, 3 year median, 1 year median PE Ratio ku data enga irunthu kedaikum" ... "intha PE Ratio va nan
first athoda Historical PE Ratio, then industry median PE kooda compare panrathuku useful"; "Okay do as per your
recommendation" = we work it out ourselves: the Kite daily closes on this computer / the EPS of screener.in's tables).

PE of a day = that day's close / the TTM EPS known that day:
  * the TTM EPS = the 4 newest quarters' EPS of screener.in's Quarterly Results table (about 3 years of quarters), known from
    45 days after the quarter's end (60 days for a March quarter - the year's results) - or earlier when this computer read a
    page that already had it;
  * before the quarterly table starts: the yearly EPS of screener.in's Profit & Loss table (about 12 years), known 60 days
    after the year's end (so 3Y is nearly exact, 5Y approximate - a year's EPS stands for 4 quarters);
  * a split / bonus: Kite's old prices are adjusted, a table's old EPS may not be - net profit / EPS (= the shares) of an old
    figure that is 1.4x or more off the newest one is scaled to the newest share count;
  * a day with a loss (TTM EPS <= 0) has no PE; a median needs the EPS history for 90 % of the window's sessions and a
    profit on half of them, else it stays blank with the reason. Peak PE 5Y = the highest daily PE of the 5 years.

EPS history: every screener.in page this program reads (the results rounds + `backfill` - a few pages a round for the stocks
not read yet / read more than 90 days ago), kept in eps_history.json; stocks no page was read for yet get the sheet's stored
quarterly figures first (`seed`, action 'histpe' op 'seed'). Prices: the Backtest Lab cache's daily candles (D.bin, made by
the daily Kite scan). The figures go to the sheet as action 'histpe' op 'put' (Code2.gs ab_histPeFromBridge_ -> tab
PE_History + Main's columns Median PE 1Y / 3Y / 5Y, Peak PE 5Y, PE vs Own Median, PE Check).
"""
import gzip
import json
import os
import re
import statistics
import time
from datetime import date, datetime, timedelta
from html.parser import HTMLParser

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, 'eps_history.json')
STATE_PATH = os.path.join(HERE, 'histpe_state.json')

Q_LAG_DAYS = 45            # a quarter's results: known this many days after the quarter's end
Y_LAG_DAYS = 60            # a year's (and a March quarter's) results
WINDOWS = (('1Y', 365), ('3Y', 1095), ('5Y', 1826))
COVER_MIN = 0.9            # the EPS history must cover this share of the window's sessions
PROFIT_MIN = 0.5           # ... and the company must have made a profit on this share of them
LISTED_SLACK_DAYS = 15     # the first Kite candle within this many days of the window's start = listed long enough
SPLIT_MIN = 1.4            # net profit / EPS this many times off the newest = a split / bonus (the figure is scaled)
SPLIT_EPS_MIN = 0.5        # ... judged only on figures with an EPS at least this big (rounding)
STALE_DAYS = 90            # a page read longer ago than this is read again by the backfill
PAGES_PER_ROUND = 40       # backfill pages a full round (config pe_history_pages_per_run)
BACKFILL_MAX_S = 480       # ... and at most this long
SEED_EVERY_S = 20 * 3600   # the sheet's stored figures asked at most this often
MAX_ROWS = 4000

log = print


# ------------------------------------------------------------------ screener.in's tables
class _Tables(HTMLParser):
    """Every <table> as rows of cell texts."""
    def __init__(self):
        HTMLParser.__init__(self)
        self.tables, self._row, self._cell, self._depth = [], None, None, 0

    def handle_starttag(self, tag, attrs):
        if tag == 'table':
            self._depth += 1
            self.tables.append([])
        elif tag == 'tr' and self._depth:
            self._row = []
        elif tag in ('td', 'th') and self._row is not None:
            self._cell = []

    def handle_endtag(self, tag):
        if tag in ('td', 'th') and self._cell is not None and self._row is not None:
            self._row.append(re.sub(r'\s+', ' ', ''.join(self._cell)).strip())
            self._cell = None
        elif tag == 'tr' and self._row is not None:
            if self._row and self.tables:
                self.tables[-1].append(self._row)
            self._row = None
        elif tag == 'table' and self._depth:
            self._depth -= 1

    def handle_data(self, data):
        if self._cell is not None:
            self._cell.append(data)


_MON = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
_LABEL = re.compile(r'^([A-Za-z]{3})[a-z]*\.?\s+(\d{4})\b')


def month_index(label):
    """'Sep 2026' (also 'Mar 2025 9m') -> 2026 * 12 + 9, else None ('TTM', '')."""
    m = _LABEL.match(str(label or '').strip())
    if not m or m.group(1).lower() not in _MON:
        return None
    return int(m.group(2)) * 12 + _MON.index(m.group(1).lower()) + 1


def label_of(mi):
    y, m = divmod(mi - 1, 12)
    return '%s %d' % (_MON[m].title(), y)


def _num(t):
    t = str(t or '').replace(',', '').replace('%', '').strip()
    if not t or t in ('-', '--'):
        return None
    try:
        v = float(t)
    except ValueError:
        return None
    return v if v == v and abs(v) != float('inf') else None


def _section(html, sid):
    m = re.search(r'<section[^>]*id=["\']%s["\'][\s\S]*?</section>' % re.escape(sid), html or '', re.I)
    return m.group(0) if m else ''


def _table_rows(sec):
    """The section's table -> (column labels, {'eps': [...], 'np': [...]}) or None."""
    p = _Tables()
    try:
        p.feed(sec)
    except Exception:
        pass
    for tb in p.tables:
        if not tb:
            continue
        head = tb[0]
        rows = {}
        for r in tb[1:]:
            if not r:
                continue
            label = re.sub(r'\s*\+\s*$', '', r[0]).strip().lower()
            key = 'eps' if label in ('eps in rs', 'eps') else 'np' if label == 'net profit' else None
            if not key or key in rows:
                continue
            shift = len(r) - len(head)
            rows[key] = [(_num(r[k + shift]) if 0 <= k + shift < len(r) else None) for k in range(1, len(head))]
        if rows.get('eps'):
            return head[1:], rows
    return None


def _basis(sec):
    txt = re.sub(r'<[^>]+>', ' ', sec[:1500])
    if re.search(r'Consolidated Figures', txt, re.I):
        return 'C'
    if re.search(r'Standalone Figures', txt, re.I) or re.search(r'Figures in', txt, re.I):
        return 'S'
    return ''


def parse_eps(html):
    """A screener.in company page -> {'basis': 'C' | 'S' | '', 'q': [[month index, EPS, net profit], ...] (Quarterly
    Results, oldest first), 'y': [...] (Profit & Loss, the yearly columns - not TTM)} or None (no EPS row)."""
    out = {'basis': '', 'q': [], 'y': []}
    for key, sid in (('q', 'quarters'), ('y', 'profit-loss')):
        sec = _section(html, sid)
        if not sec:
            continue
        if key == 'q':
            out['basis'] = _basis(sec)
        got = _table_rows(sec)
        if not got:
            continue
        labels, rows = got
        eps, np_ = rows.get('eps') or [], rows.get('np') or []
        seen = {}
        for k, lab in enumerate(labels):
            mi = month_index(lab)
            e = eps[k] if k < len(eps) else None
            if mi is None or e is None:
                continue
            seen[mi] = [mi, e, np_[k] if k < len(np_) else None]
        out[key] = [seen[m] for m in sorted(seen)]
    return out if out['q'] or out['y'] else None


# ------------------------------------------------------------------ the store
class Store:
    """eps_history.json = {'v': 1, 'syms': {SYM: {'at': seconds, 'src': 'page' | 'sheet', 'basis', 'q', 'y'}}}."""

    def __init__(self, path=None):
        self.path = path or STORE_PATH
        self.syms = {}
        self.dirty = False
        self.changed = 0.0
        try:
            with open(self.path, encoding='utf-8') as f:
                d = json.load(f)
            if isinstance(d, dict) and isinstance(d.get('syms'), dict):
                self.syms = d['syms']
                self.changed = float(d.get('changed') or 0)
        except (OSError, ValueError):
            pass

    def save(self):
        if not self.dirty:
            return
        tmp = self.path + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump({'v': 1, 'changed': self.changed, 'syms': self.syms}, f, separators=(',', ':'))
        os.replace(tmp, self.path)
        self.dirty = False

    def put(self, sym, rec, now=None):
        """Keeps the better record of a stock: a page read more than a day after the stored one replaces it (when it has
        quarterly EPS figures); on the same day (the consolidated + standalone page of a round) the one with more quarterly
        EPS figures stays (consolidated first). A page always beats the sheet's figures. -> True when stored."""
        if not rec or not (rec.get('q') or rec.get('y')):
            return False
        now = time.time() if now is None else now
        old = self.syms.get(sym)
        nq = len(rec.get('q') or [])
        if old:
            oq = len(old.get('q') or [])
            if rec.get('src') == 'sheet' and old.get('src') == 'page':
                return False
            if now - float(old.get('at') or 0) <= 86400 and old.get('src') == rec.get('src'):
                if nq <= oq:
                    return False
            elif nq < min(4, oq):
                return False
        rec = dict(rec)
        rec['at'] = round(float(rec.get('at') or now))
        self.syms[sym] = rec
        self.dirty = True
        self.changed = now
        return True


_STORE = None
_SAID = {}                 # what this program said once (no candle cache yet)


def store():
    global _STORE
    if _STORE is None:
        _STORE = Store()
    return _STORE


ON_PAGE = []      # more readers of every page (screener_bridge adds xbrl_history.keep_screener - its yearly / quarterly tables)


def keep_page(sym, html, now=None):
    """A screener.in page this program read -> the stock's EPS history (never raises) + the ON_PAGE readers."""
    for fn in ON_PAGE:
        try:
            fn(sym, html, now)
        except Exception as e:
            log('screener.in page of %s: %s' % (sym, e))
    try:
        rec = parse_eps(html)
        if rec:
            rec['src'] = 'page'
            rec['at'] = now or time.time()
            store().put(str(sym).upper(), rec, now)
    except Exception as e:                      # a strange page never stops a round
        log('Historical PE: could not read the EPS of %s (%s)' % (sym, e))


def save():
    try:
        if _STORE is not None:
            _STORE.save()
    except OSError as e:
        log('Historical PE: eps_history.json could not be saved (%s)' % e)


# ------------------------------------------------------------------ TTM EPS through time
def _mon_end(mi):
    y, m = divmod(mi - 1, 12)
    nxt = date(y + (m == 11), 1 if m == 11 else m + 2, 1)
    return nxt - timedelta(days=1)


def _shares(np_, eps):
    if np_ is None or eps is None or abs(eps) < SPLIT_EPS_MIN or np_ == 0 or (np_ > 0) != (eps > 0):
        return None
    return np_ / eps


def adjusted(rec):
    """-> (quarterly {month index: EPS}, yearly {month index: EPS}, note) with old figures of a split / bonus scaled to
    today's share count (net profit / EPS of the newest quarter, else the newest year)."""
    note = []
    ref = None
    for key in ('q', 'y'):
        for mi, e, n in reversed(rec.get(key) or []):
            ref = _shares(n, e)
            if ref:
                break
        if ref:
            break
    out = []
    for key in ('q', 'y'):
        vals, fac = {}, 1.0
        for mi, e, n in reversed(rec.get(key) or []):          # newest first: an unclear figure takes the newer one's factor
            s = _shares(n, e)
            if ref and s:
                f = ref / s
                fac = f if (f >= SPLIT_MIN or f <= 1 / SPLIT_MIN) else 1.0
            if fac != 1.0 and not note:
                k = fac if fac > 1 else 1 / fac
                note.append('EPS up to %s %s %s (split / bonus)' % (label_of(mi), 'divided by' if fac > 1 else 'multiplied by',
                                                                     ('%.2f' % k).rstrip('0').rstrip('.')))
            vals[mi] = e / fac
        out.append(vals)
    return out[0], out[1], '; '.join(note)


def ttm_points(rec, today=None):
    """[(day ordinal from which it is known, TTM EPS, 'q' | 'y', period month index)] oldest first."""
    q, y, _ = adjusted(rec)
    pts = []
    newest = max(q) if q else None
    read = date.fromtimestamp(float(rec.get('at') or 0)) if rec.get('at') else None
    for mi in sorted(q):
        if all((mi - 3 * k) in q for k in range(4)):
            lag = Y_LAG_DAYS if mi % 12 == 3 else Q_LAG_DAYS
            known = _mon_end(mi) + timedelta(days=lag)
            if mi == newest and read and _mon_end(mi) < read < known:
                known = read                         # the page already had it
            pts.append((known.toordinal(), sum(q[mi - 3 * k] for k in range(4)), 'q', mi))
    first_q = pts[0][0] if pts else None
    for mi in sorted(y):
        known = (_mon_end(mi) + timedelta(days=Y_LAG_DAYS)).toordinal()
        if first_q is None or known < first_q:
            pts.append((known, y[mi], 'y', mi))
    pts.sort()
    return pts


def _r2(v):
    return None if v is None else round(v, 2)


def stats(days, closes, rec, upto=None, first=None):
    """One stock's daily candles (day ordinals + closes, oldest first; `first` = its first candle's day when `days` is only
    the newer part) -> {'m': {'1Y': median | None, ...}, 'why': {'1Y': reason, ...}, 'peak', 'peakDay', 'now', 'ttm',
    'qShare' (share of the 5 years' sessions on quarterly TTM EPS, %), 'note'} or None (no candles / EPS)."""
    if not days or not rec:
        return None
    pts = ttm_points(rec)
    _, _, note = adjusted(rec)
    if not pts:
        return None
    upto = upto or days[-1]
    start5 = upto - WINDOWS[-1][1]
    lo = 0
    while lo < len(days) and days[lo] <= start5:
        lo += 1
    j = -1
    ser = []                                   # (day, PE | None loss | False no EPS, source)
    for k in range(lo, len(days)):
        d = days[k]
        if d > upto:
            break
        while j + 1 < len(pts) and pts[j + 1][0] <= d:
            j += 1
        if j < 0:
            ser.append((d, False, ''))
            continue
        e = pts[j][1]
        c = closes[k]
        ser.append((d, (c / e) if e > 0 and c > 0 else None, pts[j][2]))
    out = {'m': {}, 'why': {}, 'peak': None, 'peakDay': '', 'now': None, 'ttm': None, 'qShare': None, 'note': note}
    j = -1
    while j + 1 < len(pts) and pts[j + 1][0] <= upto:
        j += 1
    if j >= 0:
        out['ttm'] = _r2(pts[j][1])
        if ser and ser[-1][1]:
            out['now'] = _r2(ser[-1][1])
    first = days[0] if first is None else first
    for name, span in WINDOWS:
        frm = upto - span
        win = [x for x in ser if x[0] > frm]
        if first > frm + LISTED_SLACK_DAYS:
            out['why'][name] = 'listed less than %s ago' % name.replace('Y', ' year' + ('s' if span > 400 else ''))
            continue
        n = len(win)
        known = sum(1 for x in win if x[1] is not False)
        vals = [x[1] for x in win if x[1]]
        if not n or known < COVER_MIN * n:
            out['why'][name] = 'EPS history shorter than %s' % name
            continue
        if len(vals) < PROFIT_MIN * n:
            out['why'][name] = 'a loss on most days'
            continue
        out['m'][name] = _r2(statistics.median(vals))
        if name == '5Y':
            k = max(range(len(win)), key=lambda i: win[i][1] or 0)
            out['peak'] = _r2(win[k][1])
            out['peakDay'] = date.fromordinal(win[k][0]).isoformat()
            out['qShare'] = round(100.0 * sum(1 for x in win if x[2] == 'q') / n)
    return out


# ------------------------------------------------------------------ prices: the Backtest Lab cache
TAIL = 1400               # the newest daily candles kept per stock (5 years ~ 1,240 sessions)


def closes_from_cache(lab, syms=None):
    """{SYM: (first candle's day, day ordinals, closes)} of the newest TAIL daily candles in the Backtest Lab cache (arrays -
    1,800 stocks ~ 20 MB), and its 'upto' (iso) - ({}, '') when there is no cache yet."""
    meta, d = lab.load_meta()
    if not meta:
        return {}, ''
    idx = (meta.get('index') or {}).get('D') or {}
    out = {}
    with open(os.path.join(d, 'D.bin'), 'rb') as f:
        for sym, (off, n) in idx.items():
            if syms is not None and sym not in syms:
                continue
            if n <= 0:
                continue
            cs = lab.Candles(f, off, n)
            out[sym] = (cs.day[0], cs.day[-TAIL:], cs.c[-TAIL:])
    return out, str(meta.get('upto') or '')


def merge_xbrl(rec, xq):
    """A stock's screener.in EPS history + the quarters of NSE's XBRL filings (xbrl_history.py, 18-Nov-2026: 5 years of
    quarterly EPS) of the same basis -> one record. The screener.in quarters stay (Main's TTM EPS comes from them); the
    filings add the older quarters (exact 3- / 5-year medians) and a newer one screener.in does not show yet."""
    if not xq or not xq[1]:
        return rec
    basis, qs = xq
    if rec and rec.get('basis') and basis and rec['basis'] != basis:
        return rec
    out = dict(rec or {'src': 'xbrl', 'basis': basis, 'q': [], 'y': [], 'at': 0})
    have = {r[0] for r in out.get('q') or []}
    add = [list(r) for r in qs if r[0] not in have]
    if not add:
        return rec
    out['q'] = sorted([list(r) for r in out.get('q') or []] + add)
    out['xbrl'] = len(add)
    return out


def compute(prices, recs, upto_iso='', xq=None):
    """-> {SYM: [Median PE 1Y, 3Y, 5Y, Peak PE 5Y, peak day, PE now, TTM EPS, quarterly share %, EPS from, note]}.
    xq = {SYM: (basis, [[month index, EPS, net profit], ...])} of NSE's XBRL filings (merge_xbrl)."""
    upto = None
    try:
        upto = date.fromisoformat(upto_iso[:10]).toordinal() if upto_iso else None
    except ValueError:
        upto = None
    rows = {}
    for sym in sorted(prices):
        rec = recs.get(sym)
        if xq:
            rec = merge_xbrl(rec, xq.get(sym))
        if not rec:
            continue
        first, days, closes = prices[sym]
        st = stats(days, closes, rec, upto, first)
        if not st:
            continue
        why = '; '.join('%s: %s' % (k, v) for k, v in st['why'].items())
        note = '; '.join(x for x in (st['note'], why) if x)
        src = ('screener.in page %s' % datetime.fromtimestamp(float(rec.get('at') or 0)).strftime('%d-%m-%Y')
               if rec.get('src') == 'page' else 'NSE XBRL filings' if rec.get('src') == 'xbrl'
               else 'the sheet (quarterly figures only)')
        if rec.get('xbrl') and rec.get('src') != 'xbrl':
            src += ' + %d quarter(s) from NSE XBRL filings' % rec['xbrl']
        rows[sym] = [st['m'].get('1Y'), st['m'].get('3Y'), st['m'].get('5Y'), st['peak'], st['peakDay'], st['now'],
                     st['ttm'], st['qShare'], src, note[:300]]
        if len(rows) >= MAX_ROWS:
            break
    return rows


# ------------------------------------------------------------------ the round's step
def _load_state():
    try:
        with open(STATE_PATH, encoding='utf-8') as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def _save_state(st):
    tmp = STATE_PATH + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(st, f)
    os.replace(tmp, STATE_PATH)


def seed(api, cfg, st, syms, now=None):
    """The sheet's stored quarterly figures (Screener_Bridge) of the stocks no page was read for -> the store. -> how many."""
    now = time.time() if now is None else now
    S = store()
    want = sorted(s for s in syms if s not in S.syms)
    if not want or now - float(st.get('seeded') or 0) < SEED_EVERY_S:
        return 0
    st['seeded'] = now
    try:
        ans = api(cfg, 'histpe', {'op': 'seed', 'want': want[:MAX_ROWS]}, tries=2, timeout=180)
    except RuntimeError as e:
        log('Historical PE: could not ask the sheet for its stored EPS (%s)' % e)
        return 0
    if not ans.get('ok'):
        err = str(ans.get('error') or '')
        log('Historical PE: the sheet refused - %s%s' % (err, ' (after the New version deploy of the web app it works - see '
                                                         'README)' if 'unknown action' in err else ''))
        return 0
    n = 0
    for sym, v in (ans.get('series') or {}).items():
        try:
            basis, qs, eps, nps, at = v
            q = []
            for k, lab in enumerate(qs):
                mi = month_index(lab)
                e = eps[k] if k < len(eps) else None
                if mi is not None and isinstance(e, (int, float)):
                    q.append([mi, float(e), nps[k] if k < len(nps) and isinstance(nps[k], (int, float)) else None])
            if q and S.put(str(sym).upper(), {'src': 'sheet', 'at': float(at or now), 'basis': basis or '',
                                              'q': sorted(q), 'y': []}, now):
                n += 1
        except (TypeError, ValueError):
            continue
    if n:
        log('Historical PE: the sheet\'s stored quarterly EPS for %d stock(s) (no screener.in page read here yet).' % n)
    return n


def backfill_order(syms, now=None):
    """The stocks whose page the backfill reads: never tried and nothing stored, then the sheet's figures only, then pages
    read more than STALE_DAYS ago (oldest first) - a stock tried within STALE_DAYS is left alone (not on screener.in / no
    EPS row)."""
    now = time.time() if now is None else now
    S = store()
    none, sheet, old = [], [], []
    for s in sorted(syms):
        r = S.syms.get(s)
        if r and now - float(r.get('tried') or 0) <= STALE_DAYS * 86400:
            continue
        if not r:
            none.append(s)
        elif r.get('src') != 'page':
            sheet.append(s)
        elif now - float(r.get('at') or 0) > STALE_DAYS * 86400:
            old.append((float(r.get('at') or 0), s))
    return none + sheet + [s for _, s in sorted(old)]


def backfill(cfg, fetch, sleep, blocked, syms, pages=None, max_s=None, clock=time.time):
    """Reads up to `pages` screener.in pages (consolidated first; a 404 / a page without 4 quarterly EPS -> the standalone
    page too) of backfill_order(syms); stops when screener.in blocks. -> (pages read, stocks still to read)."""
    pages = PAGES_PER_ROUND if pages is None else pages
    max_s = BACKFILL_MAX_S if max_s is None else max_s
    todo = backfill_order(syms, clock())
    if not todo or pages <= 0:
        return 0, len(todo)
    S = store()
    t0, read, done = clock(), 0, 0
    for sym in todo:
        if read >= pages or clock() - t0 > max_s:
            break
        try:
            kind, html = fetch(cfg, sym, True)
            read += 1
            rec = parse_eps(html) if kind == 'ok' else None
            if rec:
                keep_page(sym, html, clock())
            if not rec or len(rec.get('q') or []) < 4:
                sleep(cfg)
                kind2, html2 = fetch(cfg, sym, False)
                read += 1
                if kind2 == 'ok':
                    keep_page(sym, html2, clock())
        except blocked as e:
            log('Historical PE: screener.in stopped the extra pages (%s) - the rest next round.' % e)
            break
        r = S.syms.get(sym)
        if r is None:                          # not on screener.in / no EPS row: a marker, so it is not asked every round
            r = S.syms[sym] = {'src': 'page', 'at': round(clock()), 'basis': '', 'q': [], 'y': [], 'none': 1}
        r['tried'] = round(clock())
        S.dirty = True
        done += 1
        if done % 10 == 0:
            save()
        sleep(cfg)
    save()
    return read, max(0, len(todo) - done)


def step(cfg, api, lab, fetch=None, sleep=None, blocked=Exception, pages=None, max_s=None, force=False, now=None, xbrl=None):
    """The full round's step: the sheet's stored EPS for stocks not read yet, a few more screener.in pages, then - when the
    Kite cache was rebuilt (the daily scan) or the EPS changed since the last post - every stock's figures to the sheet.
    -> rows sent or None."""
    if not cfg.get('pe_history', True):
        return None
    now = time.time() if now is None else now
    d = lab.current_dir()
    if not d:
        if not _SAID.get('nocache'):
            log('Historical PE: no Kite daily candles on this computer yet (the Backtest Lab cache comes with the daily Kite '
                'scan) - it starts after that.')
            _SAID['nocache'] = 1
        return None
    st = _load_state()
    build = os.path.basename(d.rstrip('/\\'))
    S = store()
    prices, upto = None, ''
    syms = set(st.get('syms') or [])
    if force or not syms or st.get('build') != build:
        prices, upto = closes_from_cache(lab)
        syms = set(prices)
        st['syms'] = sorted(syms)
    if not syms:
        _save_state(st)
        return None
    seed(api, cfg, st, syms, now)
    if fetch is not None:
        n = int(cfg.get('pe_history_pages_per_run', PAGES_PER_ROUND) if pages is None else pages)
        if n > 0:
            read, left = backfill(cfg, fetch, sleep, blocked, syms, n, max_s)
            if read:
                log('Historical PE: read %d more screener.in page(s) for the EPS history - %s'
                    % (read, ('%d stock(s) still to read' % left) if left else 'every stock read'))
    save()
    xch, xq = 0.0, None
    if xbrl is not None:                       # NSE's XBRL quarters (xbrl_history.hist_quarters)
        try:
            xch, xq = xbrl()
        except Exception as e:
            log('Historical PE: the NSE XBRL quarters could not be read (%s)' % e)
    if not force and st.get('build') == build and float(st.get('posted') or 0) >= max(S.changed, xch):
        _save_state(st)
        return None
    if prices is None:
        prices, upto = closes_from_cache(lab)
    recs = {s: r for s, r in S.syms.items() if not r.get('none')}
    t0 = time.time()
    rows = compute(prices, recs, upto, xq)
    try:
        ans = api(cfg, 'histpe', {'op': 'put', 'upto': upto, 'rows': rows,
                                  'made': datetime.now().isoformat(timespec='seconds')}, tries=2, timeout=240)
    except RuntimeError as e:
        log('Historical PE: could not send (%s) - next round.' % e)
        _save_state(st)
        return None
    if not ans.get('ok'):
        err = str(ans.get('error') or '')
        log('Historical PE: the sheet refused - %s%s' % (err, ' (do the New version deploy of the web app - see README)'
                                                         if 'unknown action' in err else ''))
        _save_state(st)
        return None
    st['build'], st['upto'], st['posted'] = build, upto, max(now, S.changed, xch)
    _save_state(st)
    log('Historical PE (prices up to %s): %d stock(s) -> the sheet - 1Y median for %d, 3Y %d, 5Y %d (%.1f s); Main got %s.'
        % (upto, len(rows), sum(1 for r in rows.values() if r[0] is not None),
           sum(1 for r in rows.values() if r[1] is not None), sum(1 for r in rows.values() if r[2] is not None),
           time.time() - t0, ans.get('main', '?')))
    return len(rows)
