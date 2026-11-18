"""Five years of quarterly and yearly results from NSE's XBRL filings - a table like screener.in's (owner, 18-Nov-2026: "if
we download all XBRL file from NSE for upto 5 years, can we able to build a table like Screener.in in our website?" ->
"yes, முதலில் Quarterly + வருட P&L மட்டும் போதுமா, yes" + "(படித்த பின் அழிக்கவும் செய்யலாம்-- vendam)" = keep the files).

For every Main stock this program reads NSE's two lists of result filings (Integrated Filing - Financials, from 2025, and
the older Financial Results list), picks one file per quarter of the last YEARS years - the CONSOLIDATED one when the
company filed one, else the standalone one (the owner's rule of 01-Nov-2026) - downloads it into xbrl_data\\files\\<SYM>\\
(kept: a later rule change reads them again without NSE), and reads every 3-month and 12-month period in it (a filing
carries its quarter, the quarter before, the same quarter a year before and - in March - the year and the year before).
The table (`build`): per quarter the file whose own quarter it is, else the newest later file that shows it as a
comparison column (marked 'c'); the other basis only when the stock's own basis has nothing for it (marked 's'). Rows
like screener.in's: Sales, Expenses (without interest / depreciation), Operating Profit, OPM %, Other Income, Exceptional
items, Interest, Depreciation, PBT, Tax %, Net Profit (all owners), EPS.

Runs: `Worker` in the background program - one request every GAP_S seconds, never while a round or a results check runs
(they keep NSE for themselves); XbrlHistoryNow.bat = the same in a window, faster; XbrlHistoryCheck.bat SYMBOL ... = a few
stocks with the table printed and compared with screener.in (nothing sent). The tables go to the sheet (action 'xbrlhist'
op 'put' -> hidden tab Financials) and from there to the website's stock window; Historical PE (pe_history.py) uses the
quarterly EPS for exact 3- and 5-year medians.
"""
import hashlib
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, 'xbrl_data')          # set by screener_bridge to the data folder (data_place.py - the D: drive)
VERSION = 1                                    # the reading rules: a change reads the kept files again (no NSE)
YEARS = 5
LISTS = (   # NSE's lists of a company's result filings (both: the integrated one starts in 2025)
    ('integrated filing', 'https://www.nseindia.com/api/integrated-filing-results?index=equities&symbol={s}&period=Quarterly'),
    ('financial results', 'https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol={s}&period=Quarterly'),
)
# the older list again with dates, when its plain answer does not reach back YEARS years (it may give only recent ones)
DATED = ('financial results (dated)', 'https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol={s}'
         '&period=Quarterly&from_date={f}&to_date={t}')
GAP_S = 2.5            # between two NSE requests in the background program
CMD_GAP_S = 1.2        # ... in XbrlHistoryNow.bat
BLOCK_PAUSE_S = 30 * 60    # NSE refused twice in a row: the background program tries again this much later
REST_S = 6 * 3600          # every stock up to date: looked at again this much later
RELIST_DAYS = 45           # a stock's lists read again after this many days (revised filings) ...
RESULTS_LAG_DAYS = 50      # ... or once its next quarter's results are due (quarter end + this) - at most weekly
RELIST_MIN_DAYS = 7
SESSION_REQUESTS = 300     # a fresh NSE session (cookies) after this many requests
POST_N = 50                # tables sent to the sheet in posts of this many ...
POST_EVERY_S = 15 * 60     # ... or at least this often while reading
POST_MAX = 100
SAY_EVERY = 25
LOCK_STALE_S = 10 * 60
COLS = ('rev', 'exp', 'op', 'opm', 'oi', 'exc', 'int', 'dep', 'pbt', 'taxp', 'np', 'eps')
COL_NAMES = ('Sales', 'Expenses', 'Operating Profit', 'OPM %', 'Other Income', 'Exceptional items', 'Interest',
             'Depreciation', 'Profit before tax', 'Tax %', 'Net Profit', 'EPS in Rs')
_MON = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
CRORE = 1e7

log = print
D = {}     # what screener_bridge hands over: session, get, records, facts, texts, page, pid_alive, screener, screener_q


def bind(**kw):
    D.update(kw)


# ------------------------------------------------------------------ small helpers
def _date(v):
    """'30-Sep-2026' / '30-SEP-26' / '30/09/2026' / '2026-09-30' (+ a time) -> date, else None."""
    s = str(v or '').strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
    try:
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        m = re.match(r'^(\d{1,2})[-/ ]([A-Za-z]{3})[A-Za-z]*[-/ ](\d{2}|\d{4})\b', s)
        if m and m.group(2).lower() in _MON:
            y = int(m.group(3))
            return date(y + 2000 if y < 100 else y, _MON.index(m.group(2).lower()) + 1, int(m.group(1)))
        m = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})\b', s)
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
    except ValueError:
        return None
    return None


def mi_of(d):
    """date / 'yyyy-mm-dd' -> month index y * 12 + m."""
    if isinstance(d, str):
        d = _date(d)
    return d.year * 12 + d.month if d else None


def label_of(mi):
    y, m = divmod(mi - 1, 12)
    return '%s %d' % (_MON[m].title(), y)


def _norm(k):
    return re.sub(r'[^a-z0-9]', '', str(k).lower())


def _num(t):
    try:
        v = float(str(t).replace(',', '').strip())
    except (TypeError, ValueError):
        return None
    return v if v == v and abs(v) != float('inf') else None


def file_name(url):
    return re.sub(r'[^A-Za-z0-9_.-]', '_', url.rsplit('/', 1)[-1])[:150]


def stamp_of(name):
    """The broadcast time NSE puts in the file name (ddmmyyyyHHMMSS) -> 'yyyymmddHHMMSS', else ''."""
    m = re.search(r'_(\d{14})_', name)
    if not m:
        return ''
    s = m.group(1)
    return s[4:8] + s[2:4] + s[:2] + s[8:]


# ------------------------------------------------------------------ the lists
END_KEYS = ('qedate', 'quarterenddate', 'quarterended', 'quarterend', 'todate', 'periodended', 'periodenddate', 'enddate',
            'toperiod', 'periodto', 'qe')


def rec_meta(rec):
    """One record of NSE's list (field names matched loosely) -> {url, name, end (iso | ''), basis C|S|'', rev, cum, stamp,
    gov} or None (no XBRL link)."""
    flat, url = {}, None
    stack = [rec]
    while stack:
        v = stack.pop()
        if isinstance(v, dict):
            for k, x in v.items():
                if isinstance(x, (dict, list)):
                    stack.append(x)
                else:
                    flat.setdefault(_norm(k), x)
                    if url is None and isinstance(x, str) and re.match(r'(?i)^https?://\S+\.xml$', x.strip()):
                        url = x.strip()
        elif isinstance(v, list):
            stack.extend(v)
    if not url:
        return None
    basis, rev, cum = '', False, False
    for k, x in flat.items():
        t = str(x).strip().lower()
        if 'consol' in k or 'standalone' in k or t in ('consolidated', 'non-consolidated', 'non consolidated', 'standalone'):
            if t in ('consolidated', 'c'):
                basis = 'C'
            elif t in ('non-consolidated', 'non consolidated', 'standalone', 's', 'nc'):
                basis = 'S'
        if t.startswith('revised') or (('revis' in k or 'submission' in k) and t in ('y', 'yes', 'revised')):
            rev = True
        if 'cumulative' in k and t == 'cumulative':
            cum = True
    end = ''
    for key in END_KEYS:
        if key in flat:
            d = _date(flat[key])
            if d:
                end = d.isoformat()
                break
    name = file_name(url)
    return {'url': url, 'name': name, 'end': end, 'basis': basis, 'rev': rev, 'cum': cum, 'stamp': stamp_of(name),
            'gov': 'GOVERNANCE' in name.upper()}


def pick(filings, since):
    """The files to read: per quarter end >= since (iso) the consolidated filing when there is one, else the standalone one
    - Revised before Original, a non-cumulative before a cumulative one, the newest first (the next one only if that one
    cannot be read); a filing whose quarter / basis the list does not say is read to find out. -> [[candidate, ...], ...]
    newest quarter first."""
    groups, unknown = {}, []
    for f in filings:
        if f['gov']:
            continue
        if not f['end']:
            unknown.append([f])
            continue
        if f['end'] < since:
            continue
        groups.setdefault(f['end'], []).append(f)
    out = []
    for end in sorted(groups, reverse=True):
        fs = groups[end]
        cons = [f for f in fs if f['basis'] == 'C']
        use = cons or [f for f in fs if f['basis'] != 'C']
        use.sort(key=lambda f: (not f['cum'], f['rev'], f['stamp']), reverse=True)
        out.append(use)
    return out + unknown


# ------------------------------------------------------------------ reading a file
def parse_periods(raw):
    """An XBRL file (bytes) -> {'nature': 'C' | 'S' | '', 'periods': [{'start', 'end', 'm' (3 | 12), 'f': {our name: value}}]}
    (amounts in crore, EPS in rupees) or None. Only contexts without segments (the company's own figures)."""
    import xml.etree.ElementTree as ET
    try:
        root = ET.fromstring(raw)
    except ET.ParseError:
        return None
    local = lambda tag: str(tag).rsplit('}', 1)[-1]
    ctx = {}
    for c in root.iter():
        if local(c.tag) != 'context':
            continue
        start = end = None
        dim = False
        for e in c.iter():
            n = local(e.tag)
            if n == 'startDate':
                start = (e.text or '').strip()[:10]
            elif n in ('endDate', 'instant'):
                end = (e.text or '').strip()[:10]
            elif n in ('segment', 'scenario'):
                dim = True
        if not dim and start and end:
            ctx[c.get('id')] = (start, end)
    if not ctx:
        return None
    facts = {}
    for e in root.iter():
        ref = e.get('contextRef')
        if ref is not None and len(e) == 0:
            facts.setdefault(local(e.tag).lower(), []).append((ref, (e.text or '').strip()))
    nature = ''
    for _, names in [t for t in D.get('texts', ()) if t[0] == 'nature'] or [('nature', ('NatureOfReportStandaloneConsolidated', 'NatureOfReport'))]:
        for n in names:
            for _, t in facts.get(n.lower(), []):
                t = t.lower()
                if t:
                    nature = 'S' if ('standalone' in t or 'non' in t) else 'C' if 'consol' in t else ''
                    break
            if nature:
                break
    groups = {}
    for cid, (s, e) in ctx.items():
        groups.setdefault((s, e), set()).add(cid)
    periods = []
    for (s, e), ids in sorted(groups.items()):
        try:
            days = (date.fromisoformat(e) - date.fromisoformat(s)).days
        except ValueError:
            continue
        m = 3 if 80 <= days <= 100 else 12 if 350 <= days <= 380 else 0
        if not m:
            continue
        fig = {}
        for name, names in D.get('facts', ()):
            for n in names:
                v = next((_num(t) for r, t in facts.get(n.lower(), []) if r in ids and _num(t) is not None), None)
                if v is not None:
                    fig[name] = v if name == 'eps' else round(v / CRORE, 4)
                    break
        if fig:
            periods.append({'start': s, 'end': e, 'm': m, 'f': fig})
    return {'nature': nature, 'periods': periods}


def main_end(info):
    """A file's own quarter (the latest 3-month period), iso or ''."""
    ends = [p['end'] for p in info.get('periods') or [] if p['m'] == 3]
    return max(ends) if ends else (info.get('end') or '')


# ------------------------------------------------------------------ the table
def _r(v, d=2):
    return None if v is None else round(v, d)


def row_of(f):
    """One period's figures -> the table's values in COLS order (screener.in's rows)."""
    rev, tot, fin, dep = f.get('revenue'), f.get('expenses'), f.get('finance_costs'), f.get('depreciation')
    exp = tot - (fin or 0) - (dep or 0) if tot is not None else None
    op = rev - exp if rev is not None and exp is not None else None
    opm = op / rev * 100 if op is not None and rev else None
    pbt, tax = f.get('pbt'), f.get('tax')
    taxp = tax / pbt * 100 if tax is not None and pbt else None
    return [_r(rev), _r(exp), _r(op), _r(opm, 1), _r(f.get('other_income')), _r(f.get('exceptional')), _r(fin), _r(dep),
            _r(pbt), _r(taxp, 1), _r(f.get('pat')), _r(f.get('eps'))]


def build(store, today=None):
    """The stock's kept files -> {'b': C|S, 'q': [[label, *COLS values, flag], ...] oldest first (the last YEARS years),
    'y': [...] (the last YEARS + 1 years), 'files': n, 'at'} or None. flag '' = the filing's own period, 'c' = shown as a
    comparison column of a later filing, 's' = the other basis's filing (the stock's own basis has nothing for it)."""
    files = [f for f in (store.get('files') or {}).values() if f.get('periods')]
    if not files:
        return None
    newest = max(main_end(f) for f in files)
    primary = 'C' if any(main_end(f) == newest and f.get('basis') == 'C' for f in files) else 'S'
    best = {3: {}, 12: {}}
    for f in files:
        own = main_end(f)              # a 12-month period is the filing's own only when it ends with its quarter (March)
        for p in f['periods']:
            mi = mi_of(p['end'])
            if mi is None:
                continue
            mine = p['end'] == own
            rank = (f.get('basis') == primary, mine, f.get('stamp') or '', bool(f.get('rev')))
            cur = best[p['m']].get(mi)
            if cur is None or rank > cur[0]:
                flag = '' if rank[0] and mine else 'c' if rank[0] else 's'
                best[p['m']][mi] = (rank, p['f'], flag)
    last_q = max(best[3]) if best[3] else mi_of(newest)
    out = {'b': primary, 'q': [], 'y': [], 'files': len(files), 'at': (today or date.today()).isoformat()}
    for mi in sorted(best[3]):
        if mi > last_q - 12 * YEARS:
            out['q'].append([label_of(mi)] + row_of(best[3][mi][1]) + [best[3][mi][2]])
    ys = sorted(best[12])[-(YEARS + 1):]
    for mi in ys:
        out['y'].append([label_of(mi)] + row_of(best[12][mi][1]) + [best[12][mi][2]])
    return out if out['q'] or out['y'] else None


def eps_quarters(table):
    """A table -> (basis, [[month index, EPS, net profit], ...]) for pe_history (a quarter without EPS left out)."""
    out = []
    for r in (table or {}).get('q') or []:
        m = re.match(r'^([A-Za-z]{3}) (\d{4})$', r[0])
        eps, np_ = r[1 + COLS.index('eps')], r[1 + COLS.index('np')]
        if m and eps is not None:
            out.append([int(m.group(2)) * 12 + _MON.index(m.group(1).lower()) + 1, eps, np_])
    return (table or {}).get('b', ''), out


# ------------------------------------------------------------------ the store (one file a stock + the kept XML files)
def _stock_path(sym):
    return os.path.join(DIR, 'stocks', re.sub(r'[^A-Za-z0-9&_.-]', '_', sym) + '.json')


def _files_dir(sym):
    return os.path.join(DIR, 'files', re.sub(r'[^A-Za-z0-9&_.-]', '_', sym))


def _write_json(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def _read_json(path, default=None):
    try:
        with open(path, encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return default


def load_stock(sym):
    st = _read_json(_stock_path(sym))
    return st if isinstance(st, dict) else {'sym': sym, 'files': {}}


def save_stock(st):
    _write_json(_stock_path(st['sym']), st)


def load_state():
    st = _read_json(os.path.join(DIR, 'state.json'), {})
    return st if isinstance(st, dict) else {}


def save_state(st):
    _write_json(os.path.join(DIR, 'state.json'), st)


def tables():
    """Every stock's table kept here -> {SYM: table}."""
    out = {}
    d = os.path.join(DIR, 'stocks')
    try:
        names = os.listdir(d)
    except OSError:
        return out
    for n in names:
        if n.endswith('.json'):
            st = _read_json(os.path.join(d, n))
            if isinstance(st, dict) and st.get('table'):
                out[st.get('sym') or n[:-5]] = st['table']
    return out


def changed_at():
    return float(load_state().get('changed') or 0)


def hist_quarters():
    """For pe_history: (when the tables last changed, {SYM: (basis, [[month index, EPS, net profit], ...])})."""
    return changed_at(), {s: eps_quarters(t) for s, t in tables().items()}


# ------------------------------------------------------------------ one program at a time
def _lock_path():
    return os.path.join(DIR, 'xbrl_history.lock')


def lock_holder():
    """Another program's lock that is alive, or None."""
    info = _read_json(_lock_path())
    if not isinstance(info, dict) or info.get('pid') == os.getpid():
        return None
    alive = D.get('pid_alive', lambda p: False)(info.get('pid'))
    if alive and time.time() - float(info.get('at') or 0) < LOCK_STALE_S:
        return info
    return None


def lock_take(what):
    if lock_holder():
        return False
    _write_json(_lock_path(), {'pid': os.getpid(), 'what': what, 'at': time.time()})
    return True


def lock_beat(what):
    try:
        _write_json(_lock_path(), {'pid': os.getpid(), 'what': what, 'at': time.time()})
    except OSError:
        pass


def lock_drop():
    info = _read_json(_lock_path())
    if isinstance(info, dict) and info.get('pid') == os.getpid():
        try:
            os.remove(_lock_path())
        except OSError:
            pass


# ------------------------------------------------------------------ NSE
class Blocked(Exception):
    pass


class Nse:
    """One NSE session with the pace (gap s between requests) and a fresh session every SESSION_REQUESTS requests."""

    def __init__(self, gap, sleep=time.sleep):
        self.gap, self.sleep, self.n, self.opener, self.refused = gap, sleep, 0, None, 0

    def get(self, url, timeout=60):
        for attempt in range(2):
            if self.opener is None or self.n >= SESSION_REQUESTS:
                self.opener, self.n = D['session'](), 0
            self.sleep(self.gap)
            self.n += 1
            try:
                status, raw = D['get'](self.opener, url, referer=D.get('page', 'https://www.nseindia.com/'), timeout=timeout)
            except Exception:              # network: not a refusal, the caller skips this one
                return None, b''
            if status in (401, 403, 429):
                self.opener = None             # new cookies, then once more
                if attempt == 0:
                    continue
                self.refused += 1
                if self.refused >= 2:
                    raise Blocked('NSE answered HTTP %s twice' % status)
                return status, b''
            self.refused = 0
            return status, raw
        return None, b''


def _list(nse, name, url, say):
    """One list -> (records' metas, answered)."""
    status, raw = nse.get(url)
    if status != 200:
        if say:
            say('   %-18s %s' % (name + ':', 'HTTP %s' % status if status else 'no answer'))
        return [], status is not None
    try:
        obj = json.loads(raw.decode('utf-8', errors='replace'))
    except ValueError:
        if say:
            say('   %-18s a web page came back, not data' % (name + ':'))
        return [], True
    recs = D['records'](obj) or []
    metas = [m for m in (rec_meta(r) for r in recs if isinstance(r, dict)) if m]
    if say:
        ends = sorted(m['end'] for m in metas if m['end'])
        keys = sorted(recs[0].keys())[:20] if recs and isinstance(recs[0], dict) else []
        say('   %-18s %d record(s), %d XBRL file(s)%s%s' % (
            name + ':', len(recs), len(metas), (', quarters %s .. %s' % (ends[0], ends[-1])) if ends else '',
            ('; fields: ' + ', '.join(keys)) if keys and (not metas or not ends) else ''))
    return metas, True


def list_filings(nse, sym, say=None, since=''):
    """Both NSE lists of a stock -> [rec_meta, ...] (one per file name). Raises Blocked when NSE answered neither (no
    internet / NSE down - the stock is not marked as read)."""
    out, seen, answered = [], set(), False
    q = sym.replace('&', '%26')
    for name, url in LISTS:
        metas, ok = _list(nse, name, url.format(s=q), say)
        answered = answered or ok
        for m in metas:
            if m['name'] not in seen:
                seen.add(m['name'])
                out.append(m)
    if not answered:
        raise Blocked('NSE did not answer')
    ends = sorted(m['end'] for m in out if m['end'])
    if since and ends and ends[0] > (date.fromisoformat(since) + timedelta(days=120)).isoformat():
        t = date.today()
        f = date.fromisoformat(since)
        metas, _ = _list(nse, DATED[0], DATED[1].format(s=q, f=f.strftime('%d-%m-%Y'), t=t.strftime('%d-%m-%Y')), say)
        for m in metas:
            if m['name'] not in seen:
                seen.add(m['name'])
                out.append(m)
    return out


def read_file(nse, sym, f):
    """A filing's XML: the kept copy, else downloaded and kept. -> (bytes or None, downloaded now)."""
    path = os.path.join(_files_dir(sym), f['name'])
    try:
        if os.path.getsize(path) > 0:
            with open(path, 'rb') as fh:
                return fh.read(), False
    except OSError:
        pass
    status, raw = nse.get(f['url'], timeout=90)
    if status != 200 or not raw or b'<' not in raw[:200]:
        return None, True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(raw)
    os.replace(tmp, path)
    return raw, True


def since_iso(today):
    return (today - timedelta(days=int(365.25 * YEARS) + 100)).isoformat()


def process_stock(nse, sym, today=None, say=None):
    """Lists -> the files of the last YEARS years read (kept ones are not downloaded again) -> the stock's table.
    -> (store, files downloaded now)."""
    today = today or date.today()
    st = load_stock(sym)
    files = st.setdefault('files', {})
    since = since_iso(today)
    filings = list_filings(nse, sym, say, since)
    got = 0
    for cands in pick(filings, since):
        for c in cands:                  # the best one first; one already read (with figures) ends the quarter
            have = files.get(c['name'])
            if have and have.get('v') == VERSION:
                if have.get('periods'):
                    break
                continue
            raw, fresh = read_file(nse, sym, c)
            got += fresh
            p = parse_periods(raw) if raw else None
            if not p:
                continue
            info = {'url': c['url'], 'end': c['end'], 'basis': c['basis'] or p['nature'], 'rev': c['rev'], 'stamp': c['stamp'],
                    'v': VERSION, 'periods': p['periods']}
            if not c['end']:
                info['end'] = main_end(info)
            files[c['name']] = info
            if p['periods']:
                break
    st['listed'] = time.time()
    st['n'] = len(filings)
    st['table'] = build(st, today)
    st['v'] = VERSION
    save_stock(st)
    return st, got


def reread(sym, today=None):
    """A stock's kept files read again with this version's rules (no NSE) -> its table changed?"""
    st = load_stock(sym)
    old = json.dumps(st.get('table'), sort_keys=True)
    for name, info in list((st.get('files') or {}).items()):
        try:
            with open(os.path.join(_files_dir(sym), name), 'rb') as fh:
                p = parse_periods(fh.read())
        except OSError:
            continue
        if p:
            info['periods'], info['v'] = p['periods'], VERSION
            if not info.get('basis'):
                info['basis'] = p['nature']
    st['table'] = build(st, today)
    st['v'] = VERSION
    save_stock(st)
    return json.dumps(st.get('table'), sort_keys=True) != old


def due(sym, st_stock, today, now):
    """Is the stock's list to be read now?"""
    listed = float(st_stock.get('listed') or 0)
    if not listed:
        return True
    age = (now - listed) / 86400
    if age >= RELIST_DAYS:
        return True
    q = (st_stock.get('table') or {}).get('q') or []
    if q and age >= RELIST_MIN_DAYS:
        m = re.match(r'^([A-Za-z]{3}) (\d{4})$', q[-1][0])
        if m:
            mi = int(m.group(2)) * 12 + _MON.index(m.group(1).lower()) + 1
            y, mm = divmod(mi + 3 - 1, 12)
            nxt_end = date(y + (mm == 11), 1 if mm == 11 else mm + 2, 1) - timedelta(days=1)   # the next quarter's end
            return today >= nxt_end + timedelta(days=RESULTS_LAG_DAYS)
    return False


# ------------------------------------------------------------------ the sheet
def _hash(t):
    return hashlib.md5(json.dumps(t, sort_keys=True).encode('utf-8')).hexdigest()[:16] if t else ''


def get_syms(cfg, api, state, now):
    """Main's symbols from the sheet (asked at most once a day; the last list when the sheet does not answer)."""
    if state.get('syms') and now - float(state.get('symsAt') or 0) < 86400:
        return state['syms']
    try:
        ans = api(cfg, 'xbrlhist', {'op': 'syms'}, tries=2, timeout=120)
    except RuntimeError as e:
        log('NSE XBRL history: could not ask the sheet for its stocks (%s)' % e)
        return state.get('syms') or []
    if not ans.get('ok'):
        err = str(ans.get('error') or '')
        if 'unknown action' in err and not state.get('saidOld'):
            log('NSE XBRL history: the sheet\'s web app is an older version - it starts after the New version deploy (README).')
            state['saidOld'] = 1
        return state.get('syms') or []
    syms = sorted({str(s).strip().upper() for s in ans.get('syms') or [] if str(s).strip()})
    state['syms'], state['symsAt'] = syms, now
    return syms


def post(cfg, api, state, syms=None):
    """The tables not sent yet (or changed since) -> the sheet. -> how many sent, or None (the sheet refused)."""
    sent = state.setdefault('sent', {})
    items = []
    for sym in sorted(syms if syms is not None else [s for s in state.get('syms') or []]):
        t = load_stock(sym).get('table')
        h = _hash(t)
        if t and sent.get(sym) != h:
            items.append((sym, t, h))
    n = 0
    for k in range(0, len(items), POST_MAX):
        part = items[k:k + POST_MAX]
        try:
            ans = api(cfg, 'xbrlhist', {'op': 'put', 'items': [{'sym': s, 'fin': t} for s, t, _ in part]}, tries=2, timeout=240)
        except RuntimeError as e:
            log('NSE XBRL history: could not send the tables (%s) - next time.' % e)
            return n or None
        if not ans.get('ok'):
            err = str(ans.get('error') or '')
            log('NSE XBRL history: the sheet refused the tables - %s%s' % (err, ' (do the New version deploy - README)'
                                                                          if 'unknown action' in err else ''))
            return n or None
        for s, _, h in part:
            sent[s] = h
        n += len(part)
    return n


# ------------------------------------------------------------------ the whole job
def run_all(cfg, api, round_busy=lambda: False, gap=GAP_S, out=None, stop=None, today=None, clock=time.time,
            sleep=time.sleep, every=SAY_EVERY, what='background'):
    """Every Main stock that is due: lists + files of the last YEARS years -> tables -> the sheet. Never while a round
    runs (round_busy). -> {'done', 'files', 'left', 'blocked', 'sent'} or None (another program is at it)."""
    out = out or log
    today = today or date.today()
    if not lock_take(what):
        h = lock_holder() or {}
        out('NSE XBRL history: another program is reading NSE\'s XBRL files right now (%s) - not this one.' % h.get('what', '?'))
        return None
    state = load_state()
    res = {'done': 0, 'files': 0, 'left': 0, 'blocked': '', 'sent': 0}
    try:
        now = clock()
        syms = get_syms(cfg, api, state, now)
        if state.get('v') != VERSION:                       # new reading rules: the kept files read again first
            n = 0
            for sym in syms:
                if os.path.exists(_stock_path(sym)):
                    reread(sym, today)
                    n += 1
            state['v'] = VERSION
            if n:
                state['changed'] = clock()
                out('NSE XBRL history: %d stock(s) read again from the kept files (new reading rules).' % n)
            save_state(state)
        todo = [s for s in syms if due(s, load_stock(s) if os.path.exists(_stock_path(s)) else {}, today, now)]
        res['left'] = len(todo)
        if not todo:
            sent = post(cfg, api, state, syms)
            res['sent'] = sent or 0
            save_state(state)
            return res
        out('NSE XBRL history: %d of %d stock(s) to read (5 years of quarterly results, one file a quarter)%s.'
            % (len(todo), len(syms), '' if what != 'background' else ' - a little at a time, never while a round runs'))
        nse = Nse(gap, sleep)
        last_post, pend = clock(), 0
        for k, sym in enumerate(todo):
            while round_busy():
                if stop is not None and stop.is_set():
                    break
                sleep(20)
            if stop is not None and stop.is_set():
                break
            try:
                st, got = process_stock(nse, sym, today)
            except Blocked as e:
                res['blocked'] = str(e)
                out('NSE XBRL history: NSE stopped answering (%s) - the rest later.' % e)
                break
            except Exception as e:                        # one strange stock never stops the job
                out('NSE XBRL history: %s skipped (%s)' % (sym, e))
                continue
            res['done'] += 1
            res['files'] += got
            res['left'] = len(todo) - k - 1
            if st.get('table'):
                pend += 1
            state['changed'] = clock()
            lock_beat(what)
            if (k + 1) % every == 0:
                save_state(state)
                out('NSE XBRL history: %d of %d stock(s) read (%d file(s) downloaded so far).' % (k + 1, len(todo), res['files']))
            if pend >= POST_N or (pend and clock() - last_post >= POST_EVERY_S):
                res['sent'] += post(cfg, api, state) or 0
                last_post, pend = clock(), 0
                save_state(state)
        res['sent'] += post(cfg, api, state) or 0
        save_state(state)
        out('NSE XBRL history: %d stock(s) read now, %d file(s) downloaded, %d table(s) sent to the sheet%s.'
            % (res['done'], res['files'], res['sent'], (', %d still to read' % res['left']) if res['left'] else ''))
        return res
    finally:
        lock_drop()


class Worker:
    """The background program's part: started at a tick when work may be due; paced, pauses while a round runs."""

    def __init__(self):
        self.thread, self.next_at, self.stop = None, 0.0, threading.Event()

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_start(self, cfg, api, round_busy, now=None):
        if not cfg.get('xbrl_history', True) or not cfg.get('url') or not D:
            return False
        now = time.time() if now is None else now
        if self.busy() or now < self.next_at:
            return False

        def go():
            try:
                res = run_all(cfg, api, round_busy, float(cfg.get('xbrl_history_gap_s') or GAP_S), stop=self.stop)
            except Exception as e:
                log('NSE XBRL history: stopped - %s' % e)
                res = {'blocked': 'error'}
            self.next_at = time.time() + (REST_S if res and not res.get('blocked') else BLOCK_PAUSE_S)
        self.thread = threading.Thread(target=go, name='xbrl-history', daemon=True)
        self.thread.start()
        return True


# ------------------------------------------------------------------ XbrlHistoryCheck.bat
def _fmt(v, pct=False):
    if v is None:
        return '-'
    return ('%.1f%%' % v) if pct else ('{:,.2f}'.format(v) if abs(v) < 1000 else '{:,.0f}'.format(v))


def print_table(t, out, quarters=8):
    """The table as screener.in shows it: rows = figures, columns = the newest quarters / years."""
    for key, title, n in (('q', 'Quarterly results', quarters), ('y', 'Profit & Loss (years)', YEARS + 1)):
        rows = (t.get(key) or [])[-n:]
        if not rows:
            out('   %s: none' % title)
            continue
        out('   %s (%s, Rs crore):' % (title, 'consolidated' if t.get('b') == 'C' else 'standalone'))
        out('   %-18s' % '' + ''.join('%12s' % (r[0] + ('*' if r[-1] else '')) for r in rows))
        for i, name in enumerate(COL_NAMES):
            vals = [r[1 + i] for r in rows]
            if all(v is None for v in vals):
                continue
            out('   %-18s' % name[:18] + ''.join('%12s' % _fmt(v, COLS[i] in ('opm', 'taxp')) for v in vals))
    if any(r[-1] for k in ('q', 'y') for r in t.get(k) or []):
        out('   * = from a later filing\'s comparison column (c) or the other basis (s)')


def compare(t, html, out):
    """The table vs screener.in's page: Sales / Net Profit / EPS / OPM of the quarters both have."""
    sc = D['screener_q'](html) if html else None
    rows = (sc or {}).get('rows') or {}
    if not rows:
        out('   screener.in: no quarterly table to compare')
        return 0, 0
    ok = bad = 0
    for r in (t.get('q') or [])[-8:]:
        q = r[0]
        line = []
        for key, sk, i, tol in (('Sales', 'sales', 0, 0.01), ('Net Profit', 'pat', 10, 0.01), ('EPS', 'eps', 11, 0.02),
                                ('OPM %', 'opm', 3, 1.0)):
            mine, theirs = r[1 + i], (rows.get(sk) or {}).get(q)
            if mine is None or theirs is None:
                continue
            gap = abs(mine - theirs)
            good = gap <= max(tol if key in ('OPM %', 'EPS') else 0.51, abs(theirs) * tol if key not in ('OPM %', 'EPS') else 0)
            ok += good
            bad += not good
            line.append('%s %s%s' % (key, _fmt(mine, key == 'OPM %'), '' if good else ' (screener.in %s)' % _fmt(theirs, key == 'OPM %')))
        if line:
            out('   %-9s %s' % (q, ' | '.join(line)))
    out('   compared with screener.in: %d figure(s) agree, %d differ' % (ok, bad))
    return ok, bad


def check(cfg, syms, out=print, today=None):
    """XbrlHistoryCheck.bat SYMBOL ...: each stock's lists, files (kept - not downloaded again later), its table and the
    comparison with screener.in. Nothing is sent to the sheet."""
    today = today or date.today()
    nse = Nse(1.0)
    for sym in [s.strip().upper() for s in syms if s.strip()]:
        out('')
        out('%s - NSE XBRL filings of the last %d years:' % (sym, YEARS))
        try:
            st, got = process_stock(nse, sym, today, say=out)
        except Blocked as e:
            out('   PROBLEM - %s' % e)
            return 1
        t = st.get('table')
        out('   %d file(s) downloaded now, %d kept in %s' % (got, len(st.get('files') or {}), _files_dir(sym)))
        if not t:
            out('   no table: NSE gave no readable XBRL file of these years')
            continue
        print_table(t, out)
        html = None
        try:
            kind, html = D['screener'](cfg, sym, True)
            html = html if kind == 'ok' else None
        except Exception as e:
            out('   screener.in: not read (%s)' % e)
        compare(t, html, out)
    out('')
    out('(nothing was sent to the sheet; the files stay in %s)' % os.path.join(DIR, 'files'))
    return 0
