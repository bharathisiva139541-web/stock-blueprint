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

Version 2 (owner's XbrlHistoryCheck of TCS / HDFCBANK / BSE, 18-Nov-2026): EPS of the periods before a bonus / split
divided to today's share count (net profit / EPS steps, snapped to a clear ratio - BSE's 2:1 bonus of 2025 = 3); a year
with no filing of its own = the sum of its 4 quarters (flag 'q'); the March quarter's year file read too when the quarter
file has no year; a file that cannot be used is remembered with the reason (tried again only when the reason may pass);
banks' figures (interest expended, operating expenses + provisions) in screener.in's bank rows; the check prints the
coverage, the reasons, every kept file's figures of a quarter that differs and the filing's own elements (`facts`).
"""
import math
import hashlib
import json
import os
import re
import threading
import time
from datetime import date, datetime, timedelta

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, 'xbrl_data')          # set by screener_bridge to the data folder (data_place.py - the D: drive)
VERSION = 6                                    # the reading rules: a change reads the kept files again (no NSE)
LIST_VERSION = 3                               # which files a stock reads: a change reads every stock's lists again
YEARS = 5
LISTS = (   # NSE's lists of a company's result filings (both: the integrated one starts in 2025)
    ('integrated filing', 'https://www.nseindia.com/api/integrated-filing-results?index=equities&symbol={s}&period=Quarterly'),
    ('financial results', 'https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol={s}&period=Quarterly'),
)
# the older list again with dates, when its plain answer does not reach back YEARS years (it may give only recent ones)
DATED = ('financial results (dated)', 'https://www.nseindia.com/api/corporates-financial-results?index=equities&symbol={s}'
         '&period=Quarterly&from_date={f}&to_date={t}')
# NSE's integrated list answers with the NEWEST 20 filings only (owner's check, 18-Nov-2026: TCS / HDFCBANK / BSE all exactly
# 20 records, HDFCBANK's 31-Mar-2025 filings - on NSE's page - missing): a full page is asked again half a year at a time,
# from the start of integrated filing up to the oldest filing it gave
INT_DATED = ('integrated filing (dated)', 'https://www.nseindia.com/api/integrated-filing-results?index=equities&symbol={s}'
             '&period=Quarterly&from_date={f}&to_date={t}')
INT_FROM = date(2024, 10, 1)
PAGE_FULL = 20
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
BANK_NAMES = {'rev': 'Revenue', 'op': 'Financing Profit', 'opm': 'Financing Margin %'}   # screener.in's bank rows
# read besides screener_bridge's XBRL_FACTS: the banking format (interest expended, operating expenses, provisions) - names
# from SEBI's banking results format, to be confirmed on a real filing (XbrlHistoryCheck.bat prints every element)
EXTRA_FACTS = (
    ('int_exp', ('InterestExpended', 'InterestExpenses')),
    ('opex', ('OperatingExpenses',)),
    ('provisions', ('ProvisionsOtherThanTaxAndContingencies', 'ProvisionsAndContingencies')),
    ('pbt_ord', ('ProfitLossFromOrdinaryActivitiesBeforeTax',)),
    ('eps_x', ('BasicEarningsPerShareAfterExtraordinaryItems', 'BasicEarningsPerShareBeforeExtraordinaryItems')),
)
# read by the start of the element's name (the full name is long and differs between formats): the share of the profit of
# associates / joint ventures - BSE's 'ShareOfProfitLossOfAssociatesAndJointVentures...', a bank's 'ShareOfProfitLossOfAssociates'
PREFIX_FACTS = (('assoc', ('shareofprofitlossofassociates',)), ('disc', ('profitlossfromdiscontinuedoperationsaftertax',)))
SPLIT_MIN = 1.4        # net profit / EPS (the share count) this many times off the next period = a bonus / split ...
NICE = (1.5, 2, 2.5, 3, 4, 5, 6, 8, 10, 15, 20, 25, 40, 50, 100)
SNAP_TOL = 0.08        # ... when within 8 % of one of these ratios (a merger's odd ratio is left alone)
QUARTER_READS = 3      # at most this many files downloaded for one quarter (the year file of a March quarter included)
YEARS_SHOWN = 12       # the yearly table keeps up to this many years (screener.in's own table has up to 12)
SC_ROWS = (('rev', ('sales', 'revenue')), ('exp', ('expenses',)), ('op', ('operating profit', 'financing profit')),
           ('opm', ('opm %', 'opm', 'financing margin %')), ('oi', ('other income',)), ('int', ('interest',)),
           ('dep', ('depreciation',)), ('pbt', ('profit before tax',)), ('taxp', ('tax %',)), ('np', ('net profit',)),
           ('eps', ('eps in rs', 'eps')))
SC_LABEL = re.compile(r'^([A-Za-z]{3})\s+(\d{4})\s*(?:\((S|C)\))?$')   # 'Mar 2024', 'Mar 2020 (S)' (not 'TTM' / '9m')
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
def _xml(raw, why):
    import xml.etree.ElementTree as ET
    try:
        return ET.fromstring(raw)
    except ET.ParseError as e:
        why.append('not readable as XML (%s)' % str(e)[:80])
        return None


def _local(tag):
    return str(tag).rsplit('}', 1)[-1]


def _contexts(root):
    """-> ({context id: (start | None, end | None, dimension members)} of every context, count of all contexts, an example of
    a dimension member)."""
    ctx, total, member = {}, 0, ''
    for c in root.iter():
        if _local(c.tag) != 'context':
            continue
        total += 1
        start = end = None
        dims = 0
        for e in c.iter():
            n = _local(e.tag)
            if n == 'startDate':
                start = (e.text or '').strip()[:10]
            elif n in ('endDate', 'instant'):
                end = (e.text or '').strip()[:10]
            elif n in ('explicitMember', 'typedMember'):
                dims += 1
                if not member:
                    member = (e.text or '').strip()[:60] or str(e.get('dimension') or '')[:60]
            elif n in ('segment', 'scenario'):
                dims += 0.5           # a segment / scenario with no member counted too (never 0)
        ctx[(c.get('id') or '').strip()] = (start, end, dims)
    return ctx, total, member


# a context without a start date (an instant) whose reporting period the filing states in these elements
PERIOD_FACTS = (('dateofstartofreportingperiod', 'dateofendofreportingperiod'),)


def _iso(t):
    d = _date(t)
    return d.isoformat() if d else None


def _fill_periods(ctx, facts):
    """Older NSE files: a context without a start date gets the reporting period the filing states for it; a context the
    figures name but the file does not define (seen: HDFCBANK 2021-23 / BSE 2021-22 - the figures on 'OneD', the file
    defining only 'One...D'-style dimension contexts) gets that stated period, else the one period every other context
    of the same column (same first word, same last letter) has. -> the ids given a period that way."""
    guessed = []
    for a, b in PERIOD_FACTS:
        starts = {r: _iso(t) for r, t in facts.get(a, [])}
        ends = {r: _iso(t) for r, t in facts.get(b, [])}
        for cid, (s0, e0, dims) in list(ctx.items()):
            if not s0 and starts.get(cid):
                ctx[cid] = (starts[cid], ends.get(cid) or e0, dims)
        for cid in starts:
            if cid not in ctx and starts[cid] and ends.get(cid):
                ctx[cid] = (starts[cid], ends[cid], 0)
                guessed.append(cid)
    refs = {r for v in facts.values() for r, _ in v}
    for r in sorted(refs - set(ctx)):
        m = re.match(r'^([A-Z][a-z]+)(.*?)([A-Za-z])$', r)
        if not m:
            continue
        same = {(s0, e0) for cid, (s0, e0, _) in ctx.items()
                if cid != r and cid.startswith(m.group(1)) and cid.endswith(m.group(3)) and s0 and e0
                and not cid.startswith(m.group(1) + m.group(1))}
        if len(same) == 1:
            s0, e0 = same.pop()
            ctx[r] = (s0, e0, 0)
            guessed.append(r)
    return guessed


def _usable(ctx):
    """The contexts to read: the ones with a period and without a dimension (the company's own figures); a file that
    has none - the older NSE format puts a member on every context - is read through all of them, the fewest members
    first (`older`)."""
    dur = {cid: v for cid, v in ctx.items() if v[0] and v[1]}
    plain = {cid: v for cid, v in dur.items() if not v[2]}
    return (plain, False) if plain else (dur, bool(dur))


def _why_none(facts, allc):
    """Why a file's known figures are in no 3- / 12-month period: the context of the first one found."""
    for name, names in tuple(D.get('facts', ())) + EXTRA_FACTS:
        for n in names:
            for r, t in facts.get(n.lower(), []):
                if r not in allc:
                    ids = sorted(allc)
                    return '%s: its context %s is not in the file; its %d context(s): %s%s' % (
                        n, r, len(ids), ', '.join(ids[:8]), ' ...' if len(ids) > 8 else '')
                s0, e0, dims = allc[r]
                per = ('%s..%s' % (s0, e0)) if s0 else ('instant %s' % e0) if e0 else 'no period'
                return '%s: context %s = %s, %s member(s)' % (n, r, per, dims)
    return ''


def _months(s, e):
    try:
        days = (date.fromisoformat(e) - date.fromisoformat(s)).days
    except ValueError:
        return 0
    return 3 if 80 <= days <= 100 else 12 if 350 <= days <= 380 else 0


def _pick(vals, ids, ctx):
    """Of an element's [(context, text)] in document order -> the number of the context with the fewest dimension members."""
    best = None
    for k, (r, t) in enumerate(vals):
        if r in ids:
            v = _num(t)
            if v is not None:
                key = (ctx[r][2], k)
                if best is None or key < best[0]:
                    best = (key, v)
    return None if best is None else best[1]


def parse_periods(raw, why=None):
    """An XBRL file (bytes) -> {'nature': 'C' | 'S' | '', 'periods': [{'start', 'end', 'm' (3 | 12), 'f': {our name: value}}],
    'older': read through dimension contexts} (amounts in crore, EPS in rupees) or None. Only the company's own figures
    (contexts without a segment; see `_usable`). `why` (a list) gets the reason when nothing usable is in it."""
    why = why if isinstance(why, list) else []
    root = _xml(raw, why)
    if root is None:
        return None
    allc, total, member = _contexts(root)
    facts = {}
    for e in root.iter():
        ref = e.get('contextRef')
        if ref is not None and len(e) == 0:
            facts.setdefault(_local(e.tag).lower(), []).append((ref.strip(), (e.text or '').strip()))
    guessed = _fill_periods(allc, facts)
    ctx, older = _usable(allc)
    if not ctx:
        why.append('no context with a period (%d context(s)%s)' % (total, ', e.g. ' + member if member else ''))
        return None
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
    for cid, (s, e, _) in ctx.items():
        groups.setdefault((s, e), set()).add(cid)
    prefixed = {name: sorted((k for k in facts if any(k.startswith(x) for x in pre)), key=len) for name, pre in PREFIX_FACTS}
    periods, spans = [], []
    for (s, e), ids in sorted(groups.items()):
        m = _months(s, e)
        if s != e:
            spans.append('%s..%s' % (s, e))
        if not m:
            continue
        fig = {}
        for name, names in tuple(D.get('facts', ())) + EXTRA_FACTS + tuple((n, tuple(prefixed[n])) for n, _ in PREFIX_FACTS):
            if name in fig:
                continue
            for n in names:
                v = _pick(facts.get(n.lower(), []), ids, ctx)
                if v is not None:
                    fig[name] = v if name in ('eps', 'eps_x') else round(v / CRORE, 4)
                    break
        if fig:
            periods.append({'start': s, 'end': e, 'm': m, 'f': fig})
    if not periods:
        if any(_months(*x.split('..')) for x in spans):
            why.append('none of the figures we know is in a 3- or 12-month period (%s)' % (_why_none(facts, allc) or
                       'elements: ' + ', '.join(sorted({k for k, v in facts.items() if any(_num(t) is not None for _, t in v)})[:6])))
        else:
            why.append('no 3- or 12-month period in it (periods: %s)' % (', '.join(spans[:4]) or 'none'))
    out = {'nature': nature, 'periods': periods}
    if guessed and periods:
        out['older'] = 'contexts %s not in the file - their period from the file\'s other contexts' % ', '.join(guessed[:6])
    elif older and periods:
        out['older'] = member or 'dimension contexts'
    return out


def facts_dump(raw, end, months=3):
    """Every number a filing gives for one period (the contexts `parse_periods` reads) -> [(element, value)], amounts in
    crore (EPS / shares / ratios as filed) - for XbrlHistoryCheck.bat (which element holds what, e.g. in a bank's filing)."""
    root = _xml(raw, [])
    if root is None:
        return []
    allc = _contexts(root)[0]
    facts = {}
    for e in root.iter():
        if e.get('contextRef') is not None and len(e) == 0:
            facts.setdefault(_local(e.tag).lower(), []).append((e.get('contextRef').strip(), (e.text or '').strip()))
    _fill_periods(allc, facts)
    ctx, _ = _usable(allc)
    ids = {cid for cid, (s, e, _) in ctx.items() if e == end and _months(s, e) == months}
    money = {}
    for u in root.iter():
        if _local(u.tag) == 'unit':
            ms = [(m.text or '').strip().lower() for m in u.iter() if _local(m.tag) == 'measure']
            divide = any(_local(x.tag) == 'divide' for x in u.iter())
            money[u.get('id')] = not divide and len(ms) == 1 and ms[0].endswith(':inr')
    best = {}
    for k, e in enumerate(root.iter()):
        r = (e.get('contextRef') or '').strip()
        if r in ids and len(e) == 0:
            v = _num(e.text)
            name = _local(e.tag)
            if v is None:
                continue
            key = (ctx[r][2], k)
            if name not in best or key < best[name][0]:
                best[name] = (key, round(v / CRORE, 2) if money.get(e.get('unitRef')) else v)
    return [(n, v) for n, (_, v) in sorted(best.items(), key=lambda x: x[1][0][1])]


def main_end(info):
    """A file's own quarter (the latest 3-month period), iso or ''."""
    ends = [p['end'] for p in info.get('periods') or [] if p['m'] == 3]
    return max(ends) if ends else (info.get('end') or '')


# ------------------------------------------------------------------ the table
def _r(v, d=2):
    return None if v is None else round(v, d)


def is_bank(f):
    """The banking results format (interest expended, no total expenses)."""
    return f.get('int_exp') is not None and f.get('expenses') is None


def row_of(f):
    """One period's figures -> the table's values in COLS order (screener.in's rows; a bank's like screener.in's bank table:
    Interest = interest expended, Expenses = operating expenses + provisions, Financing Profit = revenue - both)."""
    rev, dep = f.get('revenue'), f.get('depreciation')
    if is_bank(f):
        fin = f.get('int_exp')
        opex, prov = f.get('opex'), f.get('provisions')
        exp = (opex or 0) + (prov or 0) if opex is not None or prov is not None else None
        op = rev - fin - exp if None not in (rev, fin, exp) else None
    else:
        tot, fin = f.get('expenses'), f.get('finance_costs')
        exp = tot - (fin or 0) - (dep or 0) if tot is not None else None
        op = rev - exp if rev is not None and exp is not None else None
    opm = op / rev * 100 if op is not None and rev else None
    pbt = f.get('pbt') if f.get('pbt') is not None else f.get('pbt_ord')
    tax, pat, oi, exc = f.get('tax'), f.get('pat'), f.get('other_income'), f.get('exceptional')
    if is_bank(f):
        # screener.in leaves a bank's exceptional items out of PBT and Net Profit (owner's HDFCBANK check, 18-Nov-2026:
        # PBT 28,663 = operating profit - provisions, the filing's 27,825 after its 'ExceptionalItems' -837)
        if exc:
            pbt = pbt - exc if pbt is not None else None
            pat = pat - exc if pat is not None else None
    elif None not in (pbt, tax, pat):
        # what the filing adds AFTER tax - the share of associates' profit (BSE: 1,044.87 - 264.87 + 27.52 = 807.52) and the
        # discontinued operations (BSE Jun 2025: + 11.95) - screener.in counts in Other Income and PBT (owner's BSE checks,
        # 18-Nov-2026: 145 / 1,072 and 115 / 713); taken only when it explains the filing's net profit (to 0.2 %)
        a, d = f.get('assoc') or 0, f.get('disc') or 0
        best = min(((abs(pbt - tax + x - pat), x) for x in {a + d, a, d} if x), default=None)
        if best and best[0] <= max(0.1, abs(pat) * 0.002) < abs(pbt - tax - pat):
            pbt += best[1]
            oi = (oi or 0) + best[1]
    taxp = tax / pbt * 100 if tax is not None and pbt else None
    eps = f.get('eps') if f.get('eps') is not None else f.get('eps_x')
    return [_r(rev), _r(exp), _r(op), _r(opm, 1), _r(oi), _r(exc), _r(fin), _r(dep), _r(pbt), _r(taxp, 1), _r(pat), _r(eps)]


def _shares(f):
    """Net profit (owners' share when filed) / EPS - the share count in crore, or None when it cannot be told."""
    e = f.get('eps') if f.get('eps') is not None else f.get('eps_x')
    p = f.get('pat_owners') if f.get('pat_owners') is not None else f.get('pat')
    if e is None or p is None or abs(e) < 0.5 or p * e <= 0:
        return None
    return p / e


def _snap(r):
    """A share-count step (>= 1) -> the clear bonus / split ratio it is, or None."""
    n = min(NICE, key=lambda x: abs(math.log(r / x)))
    return n if abs(math.log(r / n)) <= math.log(1 + SNAP_TOL) else None


def _times(k):
    return ('%.2f' % k).rstrip('0').rstrip('.')


def eps_factors(items):
    """[(kind 'q' | 'y', month index, figures)] -> ({(kind, mi): factor}, note). EPS / factor = EPS on today's share count:
    going back from the newest period, a share count >= SPLIT_MIN times off the next newer one at a clear ratio (a bonus /
    split; the company's own later filings restate it, its earlier ones do not) multiplies the factor of every older period;
    a period whose share count cannot be told takes the newer one's factor."""
    out, F, last, prev, words = {}, 1.0, None, 1.0, []
    for kind, mi, f in sorted(items, key=lambda t: (t[1], t[0] == 'y'), reverse=True):
        s = _shares(f)
        if s is not None:
            if last is not None:
                r = last / s
                k = None
                if r >= SPLIT_MIN:
                    k = _snap(r)
                elif r <= 1 / SPLIT_MIN:
                    n = _snap(1 / r)
                    k = 1 / n if n else None
                if k:
                    F *= k
                    if abs(F - 1) < 1e-9:
                        F = 1.0
            last = s
        if F != prev and F != 1.0:
            words.append('up to %s %s %s' % (label_of(mi), 'divided by' if F > 1 else 'multiplied by', _times(F if F > 1 else 1 / F)))
        prev = F
        out[(kind, mi)] = F
    note = ('EPS adjusted for a bonus / split (today\'s share count): ' + ', '.join(words)) if words else ''
    return out, note[:200]


def _sum_figs(fs):
    """4 quarters' figures -> the year's (a figure only when every quarter has it)."""
    out = {}
    for k in set().union(*[set(f) for f in fs]):
        vals = [f.get(k) for f in fs]
        if all(v is not None for v in vals):
            out[k] = round(sum(vals), 4)
    return out


def year_end_month(mis):
    """The month a stock's years end (the most common among its 12-month periods), March when none."""
    cnt = {}
    for mi in mis:
        m = (mi - 1) % 12 + 1
        cnt[m] = cnt.get(m, 0) + 1
    return max(cnt, key=lambda m: (cnt[m], m == 3)) if cnt else 3


def build(store, today=None, sc=None):
    """The stock's kept files (+ screener.in's tables `sc`, see keep_screener) -> {'b': C|S, 'q': [[label, *COLS values,
    flag], ...] oldest first (the last YEARS years), 'y': [...] (up to YEARS_SHOWN years), 'files': n, 'at', 'note' (EPS
    adjusted), 'k' ('bank')} or None. flag '' = the filing's own period, 'c' = shown as a comparison column of a later
    filing, 's' = the other basis's filing (the stock's own basis has nothing for it), 'q' = a year with no filing read =
    the sum of its 4 quarters (consolidated and standalone quarters together when it has both), 'r' = no NSE filing figures
    for it - screener.in's (owner, 18-Nov-2026, ARSSBL: NSE has filings only since the listing, screener.in shows the years
    before it from the IPO papers)."""
    if sc is None:
        sc = load_sc(store.get('sym') or '')
    files = [f for f in (store.get('files') or {}).values() if f.get('periods')]
    page = (sc or {}).get('C') or (sc or {}).get('S')
    if not files and not page:
        return None
    if files:
        newest = max(main_end(f) for f in files)
        primary = 'C' if any(main_end(f) == newest and f.get('basis') == 'C' for f in files) else 'S'
        page = (sc or {}).get(primary) or page
    else:
        primary = page.get('b') or 'C'
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
    last_q = max(best[3]) if best[3] else mi_of(newest) if files else None
    factors, note = eps_factors([('q', mi, v[1]) for mi, v in best[3].items()] + [('y', mi, v[1]) for mi, v in best[12].items()])

    def row(kind, mi, f):
        r = row_of(f)
        k = factors.get((kind, mi), 1.0)
        if r[11] is not None and k != 1.0:
            r[11] = round(r[11] / k, 2)
        return r
    qrows = {mi: row('q', mi, v[1]) + [v[2]] for mi, v in best[3].items()}
    years = {mi: row('y', mi, v[1]) + [v[2]] for mi, v in best[12].items()}
    ye = year_end_month(best[12]) if best[12] else 3
    first = min(best[3]) if best[3] else last_q
    for mi in (range(first + 9, last_q + 1) if best[3] else ()):
        if (mi - 1) % 12 + 1 != ye:
            continue
        qs = [mi - 9, mi - 6, mi - 3, mi]
        cur = years.get(mi)
        if (cur is not None and cur[-1] != 's') or not all(q in qrows for q in qs):
            continue
        other = {qrows[q][-1] == 's' for q in qs}
        if cur is not None and True in other:
            continue                    # the other basis's own year beats a sum with the other basis's quarters
        r = row_of(_sum_figs([best[3][q][1] for q in qs]))
        eps = [qrows[q][11] for q in qs]
        r[11] = round(sum(eps), 2) if all(e is not None for e in eps) else None
        years[mi] = r + ['q']
    nse_last = last_q
    for kind, have in (('q', qrows), ('y', years)):     # what NSE's filings do not give: screener.in's figures
        for r in (page or {}).get(kind) or []:
            mi = _mi_label(r[0])
            if mi is not None and mi not in have and len(r) >= len(COLS) + 1:
                have[mi] = list(r[1:len(COLS) + 1]) + ['r']
    if not qrows and not years:
        return None
    last_q = max(qrows) if qrows else last_q
    out = {'b': primary, 'q': [], 'y': [], 'files': len(files), 'at': (today or date.today()).isoformat()}
    for mi in sorted(qrows):
        if last_q is None or mi > last_q - 12 * YEARS:
            out['q'].append([label_of(mi)] + qrows[mi])
    for mi in sorted(years)[-YEARS_SHOWN:]:
        out['y'].append([label_of(mi)] + years[mi])
    if note:
        out['note'] = note
    if nse_last in best[3] and is_bank(best[3][nse_last][1]):
        out['k'] = 'bank'
    elif not files and page.get('k') == 'bank':
        out['k'] = 'bank'
    return out if out['q'] or out['y'] else None


# ------------------------------------------------------------------ screener.in's tables (the periods NSE has no filing for)
def _sc_path(sym):
    return os.path.join(DIR, 'screener', re.sub(r'[^A-Za-z0-9&_.-]', '_', sym) + '.json')


def screener_parse(html):
    """A screener.in company page -> {'b': 'C' | 'S' | '', 'k': 'bank' | '', 'q': [[label, *COLS values, mark], ...],
    'y': [...]} from its Quarterly Results and Profit & Loss tables (TTM and odd '9m' columns left out; amounts in crore as
    shown; mark 's' / 'c' = a '(S)' / '(C)' column, '' = the page's own basis) or None."""
    import pe_history as P
    out = {'b': '', 'k': '', 'q': [], 'y': []}
    for key, sid in (('q', 'quarters'), ('y', 'profit-loss')):
        sec = P._section(html or '', sid)
        if not sec:
            continue
        if key == 'q':
            out['b'] = P._basis(sec)
        p = P._Tables()
        try:
            p.feed(sec)
        except Exception:
            pass
        for tb in p.tables:
            if not tb:
                continue
            head = tb[0]
            labs = []
            for k, c in enumerate(head):
                m = SC_LABEL.match(str(c).strip())
                if m and m.group(1).lower() in _MON:
                    labs.append((k, m.group(1).title() + ' ' + m.group(2), (m.group(3) or '').lower()))
            if len(labs) < 1:
                continue
            figs = {}
            for r in tb[1:]:
                if not r:
                    continue
                name = re.sub(r'\s*\+\s*$', '', str(r[0])).strip().lower()
                col = next((c for c, names in SC_ROWS if name in names), None)
                if not col or col in figs:
                    continue
                if name in ('revenue', 'financing profit', 'financing margin %'):
                    out['k'] = 'bank'
                shift = len(r) - len(head)
                figs[col] = {lab: P._num(r[k + shift]) for k, lab, _ in labs if 0 <= k + shift < len(r)}
            if not figs.get('rev') and not figs.get('np'):
                continue
            seen = {}
            for _, lab, mark in labs:
                vals = [figs.get(c, {}).get(lab) for c in COLS]
                if any(v is not None for v in vals):
                    seen[lab] = [lab] + vals + [mark]
            out[key] = sorted(seen.values(), key=lambda r: _mi_label(r[0]))
            break
    return out if out['q'] or out['y'] else None


def load_sc(sym):
    sc = _read_json(_sc_path(sym)) if sym else None
    return sc if isinstance(sc, dict) else {}


def keep_screener(sym, html, now=None):
    """A screener.in page the program read (pe_history.keep_page hands every one over) -> xbrl_data/screener/<SYM>.json
    {C: tables, S: tables} (never raises). The stock's table takes them at the next run_all (refresh_screener)."""
    try:
        rec = screener_parse(html)
        if not rec:
            return
        rec['at'] = now or time.time()
        path = _sc_path(str(sym).upper())
        cur = _read_json(path) or {}
        cur = cur if isinstance(cur, dict) else {}
        cur[rec['b'] or 'C'] = rec
        _write_json(path, cur)
    except Exception as e:                     # a strange page never stops a round
        log('NSE XBRL history: could not keep screener.in\'s tables of %s (%s)' % (sym, e))


def wants_screener(sym):
    """pe_history's backfill reads a page read before this version once more for its tables (none kept yet)."""
    return not os.path.exists(_sc_path(str(sym).upper()))


def refresh_screener(syms, state, today=None):
    """Stocks whose screener.in tables changed since their table was made -> the table made again (no NSE). -> how many."""
    seen = state.setdefault('scSeen', {})
    n = 0
    for sym in syms:
        try:
            at = os.path.getmtime(_sc_path(sym))
        except OSError:
            continue
        if seen.get(sym) == at:
            continue
        st = load_stock(sym)
        t = build(st, today)
        if t != st.get('table'):
            st['table'] = t
            save_stock(st)
            n += 1
        seen[sym] = at
    return n


def eps_quarters(table):
    """A table -> (basis, [[month index, EPS, net profit], ...]) for pe_history (a quarter without EPS left out)."""
    out = []
    for r in (table or {}).get('q') or []:
        m = re.match(r'^([A-Za-z]{3}) (\d{4})$', r[0])
        eps, np_ = r[1 + COLS.index('eps')], r[1 + COLS.index('np')]
        if m and eps is not None and r[-1] != 'r':          # screener.in's own rows: pe_history has them already
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
    """One list -> (records' metas, answered, number of records)."""
    status, raw = nse.get(url)
    if status != 200:
        if say:
            say('   %-18s %s' % (name + ':', 'HTTP %s' % status if status else 'no answer'))
        return [], status is not None, 0
    try:
        obj = json.loads(raw.decode('utf-8', errors='replace'))
    except ValueError:
        if say:
            say('   %-18s a web page came back, not data' % (name + ':'))
        return [], True, 0
    recs = D['records'](obj) or []
    metas = [m for m in (rec_meta(r) for r in recs if isinstance(r, dict)) if m]
    if say:
        ends = sorted(m['end'] for m in metas if m['end'])
        keys = sorted(recs[0].keys())[:20] if recs and isinstance(recs[0], dict) else []
        extra = ''
        if len(recs) >= PAGE_FULL and isinstance(obj, dict):    # a page of a longer list? its other fields may say
            sc = ['%s=%s' % (k, v) for k, v in obj.items() if isinstance(v, (int, float, str)) and len(str(v)) <= 40]
            extra = ('; the answer also has: ' + ', '.join(sc[:8])) if sc else ''
        say('   %-18s %d record(s), %d XBRL file(s)%s%s%s' % (
            name + ':', len(recs), len(metas), (', quarters %s .. %s' % (ends[0], ends[-1])) if ends else '',
            ('; fields: ' + ', '.join(keys)) if keys and (not metas or not ends) else '', extra))
    return metas, True, len(recs)


def half_years(start, end):
    """[(from, to)] half-year windows from `start` until the one holding `end`."""
    out, a = [], start
    while a <= end:
        y, m = a.year + (a.month + 5) // 12, (a.month + 5) % 12 + 1
        b = date(y, m, 1) - timedelta(days=1)
        out.append((a, b))
        a = b + timedelta(days=1)
    return out


def _stamp_day(m):
    s = m.get('stamp') or ''
    try:
        return date(int(s[:4]), int(s[4:6]), int(s[6:8]))
    except ValueError:
        return None


def list_filings(nse, sym, say=None, since=''):
    """Both NSE lists of a stock -> [rec_meta, ...] (one per file name). Raises Blocked when NSE answered neither (no
    internet / NSE down - the stock is not marked as read)."""
    out, seen, answered = [], set(), False
    q = sym.replace('&', '%26')

    def add(metas):
        for m in metas:
            if m['name'] not in seen:
                seen.add(m['name'])
                out.append(m)
    for name, url in LISTS:
        metas, ok, n = _list(nse, name, url.format(s=q), say)
        answered = answered or ok
        add(metas)
        if url == LISTS[0][1] and n >= PAGE_FULL:
            days = [d for d in (_stamp_day(m) for m in metas) if d] or [date.today()]
            for f, t in half_years(INT_FROM, min(days)):
                more, _, _ = _list(nse, '%s %s..%s' % (INT_DATED[0], f.strftime('%d-%m-%y'), t.strftime('%d-%m-%y')),
                                   INT_DATED[1].format(s=q, f=f.strftime('%d-%m-%Y'), t=t.strftime('%d-%m-%Y')), say)
                add(more)
    if not answered:
        raise Blocked('NSE did not answer')
    ends = sorted(m['end'] for m in out if m['end'])
    if since and ends and ends[0] > (date.fromisoformat(since) + timedelta(days=120)).isoformat():
        t = date.today()
        f = date.fromisoformat(since)
        add(_list(nse, DATED[0], DATED[1].format(s=q, f=f.strftime('%d-%m-%Y'), t=t.strftime('%d-%m-%Y')), say)[0])
    return out


def _is_page(raw):
    h = raw[:600].lower()
    return b'<html' in h or b'<!doctype html' in h


def read_file(nse, sym, f):
    """A filing's XML: the kept copy, else downloaded and kept. -> (bytes or None, asked NSE now, why not ('' = got it),
    worth trying again later)."""
    path = os.path.join(_files_dir(sym), f['name'])
    try:
        if os.path.getsize(path) > 0:
            with open(path, 'rb') as fh:
                raw = fh.read()
            if not _is_page(raw):
                return raw, False, '', False
            os.remove(path)            # a web page an earlier version kept by mistake - not a filing
    except OSError:
        pass
    status, raw = nse.get(f['url'], timeout=90)
    if status is None:
        return None, True, 'no answer from NSE', True
    if status != 200:
        return None, True, 'NSE answered HTTP %s' % status, status not in (404, 410)
    if not raw:
        return None, True, 'NSE sent an empty file', True
    if _is_page(raw) or b'<' not in raw[:200]:
        return None, True, 'a web page came back, not the XML file', True
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with open(tmp, 'wb') as fh:
        fh.write(raw)
    os.replace(tmp, path)
    return raw, True, '', False


def since_iso(today):
    return (today - timedelta(days=int(365.25 * YEARS) + 100)).isoformat()


def _info(c, p, why, retry):
    info = {'url': c['url'], 'end': c['end'], 'basis': c['basis'] or (p or {}).get('nature', ''), 'rev': c['rev'],
            'stamp': c['stamp'], 'v': VERSION, 'periods': (p or {}).get('periods') or []}
    if (p or {}).get('older'):
        info['older'] = p['older']
    if why:
        info['fail'], info['retry'] = why[:200], bool(retry)
    if not info['end']:
        info['end'] = main_end(info)
    return info


def process_stock(nse, sym, today=None, say=None):
    """Lists -> the files of the last YEARS years read (kept ones are not downloaded again) -> the stock's table.
    Per quarter the best file first; the next one only when it cannot be used, or - for the year-end quarter - when it has
    no figures of the year (at most QUARTER_READS downloads a quarter). A file that cannot be used is remembered with the
    reason ('fail'; tried again at the next reading only when `retry`). -> (store, files asked from NSE now)."""
    today = today or date.today()
    st = load_stock(sym)
    files = st.setdefault('files', {})
    since = since_iso(today)
    filings = list_filings(nse, sym, say, since)
    ye = year_end_month([m for m in (mi_of(p['end']) for f in files.values() for p in f.get('periods') or [] if p['m'] == 12) if m])
    got, tried = 0, {}
    for cands in pick(filings, since):
        reads, have_q, have_y = 0, False, False
        for c in cands:
            info = files.get(c['name'])
            if not info or info.get('v') != VERSION or (info.get('fail') and info.get('retry')):
                if reads >= QUARTER_READS:
                    break
                raw, fresh, why, retry = read_file(nse, sym, c)
                got += fresh
                reads += fresh
                p = None
                if raw is not None:
                    reasons = []
                    p = parse_periods(raw, reasons)
                    if not p or not p['periods']:
                        why, retry = (reasons[0] if reasons else 'nothing usable in it'), False
                info = files[c['name']] = _info(c, p, why, retry)
            end = c['end'] or info['end']
            tried.setdefault(end or '?', []).append([c['name'], info.get('fail') or 'ok'])
            spans = {(x['end'], x['m']) for x in info.get('periods') or []}
            have_q = have_q or (end, 3) in spans
            have_y = have_y or (end, 12) in spans
            if have_q and (have_y or not end or int(end[5:7]) != ye):
                break
    st['listed'] = time.time()
    st['n'] = len(filings)
    st['tried'] = tried
    st['lv'] = LIST_VERSION
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
                raw = fh.read()
        except OSError:
            continue                   # never downloaded (a failure): read at the next listing
        if _is_page(raw):
            info['v'] = 0              # a web page kept by mistake: downloaded again at the next listing
            continue
        reasons = []
        p = parse_periods(raw, reasons)
        info['periods'], info['v'] = (p or {}).get('periods') or [], VERSION
        for k in ('fail', 'retry', 'older'):
            info.pop(k, None)
        if (p or {}).get('older'):
            info['older'] = p['older']
        if not info['periods']:
            info['fail'], info['retry'] = (reasons[0] if reasons else 'nothing usable in it')[:200], False
        if p and not info.get('basis'):
            info['basis'] = p['nature']
    st['table'] = build(st, today)
    st['v'] = VERSION
    save_stock(st)
    return json.dumps(st.get('table'), sort_keys=True) != old


def due(sym, st_stock, today, now):
    """Is the stock's list to be read now?"""
    listed = float(st_stock.get('listed') or 0)
    if not listed or st_stock.get('lv') != LIST_VERSION:
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
        n = refresh_screener(syms, state, today)
        if n:
            state['changed'] = clock()
            out('NSE XBRL history: %d table(s) made again with screener.in\'s figures for the periods NSE has none.' % n)
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
PCT = ('opm', 'taxp')
CMP = (('rev', 'sales'), ('exp', 'expenses'), ('op', 'op'), ('opm', 'opm'), ('oi', 'other_income'), ('int', 'interest'),
       ('dep', 'depreciation'), ('pbt', 'pbt'), ('np', 'pat'), ('eps', 'eps'))
FLAG_MARK = {'c': '*', 's': '^', 'q': '+'}


def _fmt(v, pct=False):
    if v is None:
        return '-'
    return ('%.1f%%' % v) if pct else ('{:,.2f}'.format(v) if abs(v) < 1000 else '{:,.0f}'.format(v))


def col_names(t):
    bank = (t or {}).get('k') == 'bank'
    return [BANK_NAMES.get(c, n) if bank else n for c, n in zip(COLS, COL_NAMES)]


def end_of(mi):
    y, m = divmod(mi - 1, 12)
    m += 1
    return (date(y + (m == 12), 1 if m == 12 else m + 1, 1) - timedelta(days=1)).isoformat()


def _mi_label(label):
    m = re.match(r'^([A-Za-z]{3}) (\d{4})$', str(label))
    return int(m.group(2)) * 12 + _MON.index(m.group(1).lower()) + 1 if m else None


def print_table(t, out, quarters=8):
    """The table as screener.in shows it: rows = figures, columns = the newest quarters / years."""
    names = col_names(t)
    for key, title, n in (('q', 'Quarterly results', quarters), ('y', 'Profit & Loss (years)', YEARS + 1)):
        rows = (t.get(key) or [])[-n:]
        if not rows:
            out('   %s: none' % title)
            continue
        out('   %s (%s, Rs crore):' % (title, 'consolidated' if t.get('b') == 'C' else 'standalone'))
        out('   %-18s' % '' + ''.join('%12s' % (r[0] + FLAG_MARK.get(r[-1], '')) for r in rows))
        for i, name in enumerate(names):
            vals = [r[1 + i] for r in rows]
            if all(v is None for v in vals):
                continue
            out('   %-18s' % name[:18] + ''.join('%12s' % _fmt(v, COLS[i] in PCT) for v in vals))
    marks = {r[-1] for k in ('q', 'y') for r in t.get(k) or []}
    legend = [w for f, w in (('c', '* = a later filing\'s comparison column'), ('s', '^ = the other basis\'s filing'),
                             ('q', '+ = the sum of its 4 quarters (no yearly figures read)')) if f in marks]
    if legend:
        out('   ' + '; '.join(legend))
    if t.get('note'):
        out('   ' + t['note'])


def coverage(st, t, out):
    """Which quarters of the 5 years the table has; a missing one with the reason its files could not be used."""
    q = t.get('q') or []
    if not q:
        return
    have = {r[0] for r in q}
    last = _mi_label(q[-1][0])
    want = [last - 3 * k for k in range(4 * YEARS)][::-1]
    miss = [mi for mi in want if label_of(mi) not in have]
    out('   quarters: %d of %d in the table (%s .. %s)%s' % (len(want) - len(miss), len(want), label_of(want[0]),
                                                           label_of(want[-1]), '' if miss else ' - none missing'))
    tried = st.get('tried') or {}
    for mi in miss:
        tr = tried.get(end_of(mi)) or []
        why = '; '.join('%s: %s' % (n[-60:], 'read, but no 3-month figures of this quarter in it' if r == 'ok' else r) for n, r in tr)
        out('      %s missing - %s' % (label_of(mi), why or 'no XBRL file for it in NSE\'s lists'))
    ys = t.get('y') or []
    if ys:
        out('   years: ' + ', '.join(r[0] + {'c': ' (comparison column)', 's': ' (other basis)', 'q': ' (sum of its 4 quarters)'}
                                     .get(r[-1], '') for r in ys))


def screener_tables(html):
    """screener.in's page -> (quarterly rows, yearly rows) as {our name: {label: value}}."""
    if not html:
        return {}, {}
    q = (D['screener_q'](html) or {}).get('rows') or {}
    j = max(html.find('id="profit-loss"'), html.find("id='profit-loss'"))
    k = max(html.find('id="balance-sheet"'), html.find("id='balance-sheet'"))
    y = {}
    if j >= 0:
        y = (D['screener_q'](html[j:k] if k > j else html[j:]) or {}).get('rows') or {}
    return q, y


def _agree(k, mine, theirs):
    if k == 'opm':
        return abs(mine - theirs) <= 1.0
    if k == 'eps':
        return abs(mine - theirs) <= max(0.02, abs(theirs) * 0.02)
    return abs(mine - theirs) <= max(0.51, abs(theirs) * 0.01)


def compare_rows(t, rows_t, sc, out):
    """Our periods vs screener.in's: a line per period (how many figures agree + the ones that differ). -> (agree,
    differ, periods with a difference other than EPS, other income agreeing only with the exceptional items added)."""
    names = dict(zip(COLS, col_names(t)))
    ok = bad = oiexc = 0
    diff = []
    for r in rows_t:
        label, agree, diffs, real = r[0], 0, [], False
        for k, sk in CMP:
            i = COLS.index(k)
            mine, theirs = r[1 + i], (sc.get(sk) or {}).get(label)
            if mine is None or theirs is None:
                continue
            good = _agree(k, mine, theirs)
            if not good and k == 'oi' and r[1 + COLS.index('exc')] is not None and _agree(k, mine + r[1 + COLS.index('exc')], theirs):
                good = True
                oiexc += 1
            agree += good
            if not good:
                diffs.append('%s %s (screener.in %s)' % (names[k], _fmt(mine, k in PCT), _fmt(theirs, k in PCT)))
                real = real or k != 'eps'
        if agree or diffs:
            ok += agree
            bad += len(diffs)
            out('   %-9s %d agree%s' % (label + FLAG_MARK.get(r[-1], ''), agree, ''.join(' | ' + d for d in diffs)))
            if real:
                diff.append(label)
    return ok, bad, diff, oiexc


def compare(t, html, out):
    """The table vs screener.in's page: every figure of the quarters and years both have. -> (agree, differ)."""
    sq, sy = screener_tables(html)
    if not sq and not sy:
        out('   screener.in: no table to compare')
        return 0, 0, []
    out('   compared with screener.in (amounts within 1 %, EPS within 2 %, OPM within 1 point):')
    ok, bad, diff, oiexc = compare_rows(t, (t.get('q') or [])[-13:], sq, out)
    yok, ybad, _, yoi = compare_rows(t, t.get('y') or [], sy, out) if sy else (0, 0, [], 0)
    if oiexc + yoi:
        out('   (screener.in counts the exceptional items in Other Income - %d figure(s) agree that way)' % (oiexc + yoi))
    out('   compared with screener.in: %d figure(s) agree, %d differ' % (ok + yok, bad + ybad))
    return ok + yok, bad + ybad, diff


def _when(stamp):
    return '%s-%s-%s %s:%s' % (stamp[:4], stamp[4:6], stamp[6:8], stamp[8:10], stamp[10:12]) if len(stamp or '') >= 12 else '?'


def restated(st, t, label, out):
    """Every kept file's figures of one quarter (its own filing, later filings' comparison columns, the other basis)."""
    mi = _mi_label(label)
    if mi is None:
        return
    end = end_of(mi)
    names = dict(zip(COLS, col_names(t)))
    lines = []
    for name, f in sorted((st.get('files') or {}).items(), key=lambda x: x[1].get('stamp') or ''):
        for p in f.get('periods') or []:
            if p['m'] == 3 and p['end'] == end:
                r = row_of(p['f'])
                lines.append('      %s (%s, %s, filed %s%s): %s' % (
                    name[-60:], 'its own quarter' if main_end(f) == end else 'comparison column',
                    {'C': 'consolidated', 'S': 'standalone'}.get(f.get('basis'), '?'), _when(f.get('stamp')),
                    ', revised' if f.get('rev') else '',
                    ' · '.join('%s %s' % (names[k], _fmt(r[COLS.index(k)], k in PCT)) for k in ('rev', 'exp', 'opm', 'oi', 'exc', 'pbt', 'np', 'eps'))))
    if lines:
        out('   %s in each kept file:' % label)
        for x in lines:
            out(x)


def dump(sym, st, label, out, limit=80):
    """Every number the quarter's own filing gives for that quarter (element = value) - which element holds what."""
    mi = _mi_label(label)
    if mi is None:
        return False
    end = end_of(mi)
    own = [(n, f) for n, f in (st.get('files') or {}).items() if f.get('periods') and main_end(f) == end]
    if not own:
        return False
    tb = (st.get('table') or {}).get('b')
    name, _ = max(own, key=lambda x: (x[1].get('basis') == tb, x[1].get('stamp') or ''))
    try:
        with open(os.path.join(_files_dir(sym), name), 'rb') as fh:
            facts = facts_dump(fh.read(), end)
    except OSError:
        return False
    out('   every figure of %s in %s (Rs crore; EPS / shares / ratios as filed) - %d:' % (label, name[-60:], len(facts)))
    for k in range(0, min(len(facts), limit), 2):
        out('      ' + ''.join('%-62s' % ('%s = %s' % (e[:44], _fmt(v) if abs(v) >= 1000 else v)) for e, v in facts[k:k + 2]).rstrip())
    if len(facts) > limit:
        out('      ... %d more' % (len(facts) - limit))
    return True


def check(cfg, syms, out=print, today=None):
    """XbrlHistoryCheck.bat SYMBOL ... [facts]: each stock's lists, files (kept - not downloaded again later), what could
    not be used and why, the quarters covered, its table and the comparison with screener.in (a differing quarter: every
    kept file's figures of it + the filing's own elements; 'facts' = the newest quarter's elements of every stock).
    Nothing is sent to the sheet."""
    today = today or date.today()
    toks = [s.strip().upper() for s in syms if s.strip()]
    facts = any(x in ('FACTS', '-FACTS', '--FACTS') for x in toks)
    nse = Nse(1.0)
    for sym in [x for x in toks if x not in ('FACTS', '-FACTS', '--FACTS')]:
        out('')
        out('%s - NSE XBRL filings of the last %d years:' % (sym, YEARS))
        try:
            st, got = process_stock(nse, sym, today, say=out)
        except Blocked as e:
            out('   PROBLEM - %s' % e)
            return 1
        t = st.get('table')
        files = st.get('files') or {}
        good = [f for f in files.values() if f.get('periods')]
        out('   %d file(s) asked from NSE now; %d file(s) with figures kept in %s' % (got, len(good), _files_dir(sym)))
        old = sorted(f.get('end') or '' for f in good if f.get('older'))
        if old:
            out('   %d file(s) of NSE\'s older format read through their dimension contexts (%s .. %s) - check those quarters'
                ' against screener.in below' % (len(old), old[0], old[-1]))
        bad = sorted([(f.get('end') or '', n, f) for n, f in files.items() if f.get('fail')], reverse=True)
        if bad:
            out('   %d file(s) could not be used:' % len(bad))
            for end, n, f in bad[:15]:
                out('      %s  %s - %s%s' % (end or '?', n[-60:], f['fail'], ' (tried again at the next reading)' if f.get('retry') else ''))
        if not t:
            out('   no table: NSE gave no readable XBRL file of these years')
            continue
        coverage(st, t, out)
        print_table(t, out)
        html = None
        try:
            kind, html = D['screener'](cfg, sym, True)
            html = html if kind == 'ok' else None
        except Exception as e:
            out('   screener.in: not read (%s)' % e)
        _, _, diff = compare(t, html, out)
        for label in diff[-3:]:
            restated(st, t, label, out)
        done = set()
        newest = (t.get('q') or [[None]])[-1]
        missing = newest[0] and any(newest[1 + COLS.index(k)] is None for k in ('exp', 'pbt', 'eps'))
        for label in ([newest[0]] if facts or missing else []) + diff[-1:]:
            if label and label not in done and dump(sym, st, label, out):
                done.add(label)
    out('')
    out('(nothing was sent to the sheet; the files stay in %s)' % os.path.join(DIR, 'files'))
    return 0
