# -*- coding: utf-8 -*-
"""Analyst targets (owner, 24-Nov-2026, JLHL: Prabhudas Lilladher's "Buy Jupiter Life Line Hospitals; target of Rs 330"
(27-Oct) - the price touched 330.50 on 24-Nov: "If i know for which stocks which analyst give recommendations to buy with
target price from october 2026, it will be helpful to strengthen for our analysis ... it can be our daily check ... cover
maximum Analysts recommendations"; then the research houses (Motilal Oswal, JM Financial, Emkay, ICICI Securities, HDFC
Securities, Nuvama, Elara, Antique, Geojit, Nirmal Bang, Sharekhan, SBI Securities, PhillipCapital, Centrum ...) and three
websites - Moneycontrol brokerage research, Business Standard research reports, DSIJ broker reports - "maintain a historical
database ... 30-day, 60-day and 90-day returns, maximum favourable excursion and maximum adverse excursion ... which
brokerage has historically been better").

Every full round reads the newest page or two of each website's list (AnalystNow.bat: back to 1-Oct-2026), finds the
recommendations in it (the headline "Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher", the same
words in the link's address, or a table with Stock / Broker / Recommendation / Target columns), matches the company to
your Main stocks (their names come from the sheet) and keeps every one in analyst_recos.json. What the price did after
each one comes from the Kite daily candles (the Backtest Lab cache), worked out exactly like the EPS Target Lab
(eps_target.after): the entry = the close of the day of the recommendation, then the first session reaching 50 .. 100 % of
the way to the target, the best / worst move and the close after 30 / 60 / 90 / 120 / 180 sessions. Sent to the sheet
(doPost action 'recos', hidden tab Analyst_Recos) -> the website's page "Analyst Targets" (api/recos).

The pages were not seen from the program's own computer when this was written (the websites could not be reached from
it) - AnalystCheck.bat prints what each page gave, so the patterns can be fixed from what it shows. Standard library
only; one page every GAP_S seconds."""
import base64
import bisect
import gzip
import hashlib
import html
import json
import os
import re
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from http.cookiejar import CookieJar

import eps_target as ET

HERE = os.path.dirname(os.path.abspath(__file__))
STORE_PATH = os.path.join(HERE, 'analyst_recos.json')
STATE_PATH = os.path.join(HERE, 'analyst_recos_state.json')
CHECK_DIR = os.path.join(HERE, 'analyst_check')

ENGINE = 1
FROM_DAY = '2026-10-01'      # the owner: "from october 2026"
GAP_S = 5.0                  # between two pages of the same website
PAGES_PER_ROUND = 2          # pages of each list a full round reads (the newest ones)
BACK_PAGES = 300             # AnalystNow.bat: at most this many pages of a list, back to FROM_DAY
NAMES_EVERY_S = 20 * 3600    # Main's company names asked again after this
DUP_DAYS = 3                 # the same broker, stock, call and target within this many days = one recommendation
KEEP = 20000
UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36')

# (code, website, [(list name, first page, page n with {n})]) - several lists a website: every one that gives
# recommendations is read (the same one found twice is kept once)
# Owner's AnalystCheck (24-Nov-2026): Moneycontrol's recommendations list 25 dated calls, Business Standard's research reports
# a table of 2,430 (Dec 2024 .. 23-Nov-2026) on page 1; Moneycontrol's broker-research tag moved to its news home (dropped);
# Moneycontrol's stock ideas (page data only) and DSIJ (rows without a <table>) gave none - `json_recos` / `text_rows` for them.
SOURCES = (
    ('mc', 'Moneycontrol', (
        ('recommendations', 'https://www.moneycontrol.com/news/tags/recommendations.html',
         'https://www.moneycontrol.com/news/tags/recommendations.html/page-{n}/'),
        ('stock ideas', 'https://www.moneycontrol.com/markets/stock-ideas/', ''),
        ('stocks news', 'https://www.moneycontrol.com/news/business/stocks/',
         'https://www.moneycontrol.com/news/business/stocks/page-{n}/'),
    )),
    ('bs', 'Business Standard', (
        ('research reports', 'https://www.business-standard.com/markets/research-report',
         'https://www.business-standard.com/markets/research-report/page-{n}'),
        ('stock recommendations', 'https://www.business-standard.com/topic/stock-recommendations',
         'https://www.business-standard.com/topic/stock-recommendations/page-{n}'),
    )),
    ('dsij', 'DSIJ', (
        ('broker reports', 'https://insights.dsij.in/markets/reports/broker-reports/stock-tips',
         'https://insights.dsij.in/markets/reports/broker-reports/stock-tips?page={n}'),
    )),
)
SOURCE_NAMES = {s[0]: s[1] for s in SOURCES}
URL_HOSTS = ('moneycontrol.com', 'business-standard.com', 'dsij.in')

# the recommendation words; 'buy' kinds = a long call
CALLS = ('strong buy', 'buy', 'accumulate', 'add', 'outperform', 'overweight', 'positive', 'hold', 'neutral', 'market perform',
         'equal weight', 'reduce', 'underperform', 'underweight', 'sell', 'negative')
CALL_CODE = {'strong buy': 'BUY', 'buy': 'BUY', 'accumulate': 'ACCUMULATE', 'add': 'ADD', 'outperform': 'OUTPERFORM',
             'overweight': 'OUTPERFORM', 'positive': 'BUY', 'hold': 'HOLD', 'neutral': 'NEUTRAL', 'market perform': 'NEUTRAL',
             'equal weight': 'NEUTRAL', 'reduce': 'REDUCE', 'underperform': 'SELL', 'underweight': 'SELL', 'sell': 'SELL',
             'negative': 'SELL'}
CALL_RE = r'(?P<call>' + '|'.join(re.escape(c).replace(r'\ ', r'\s+') for c in CALLS) + r')'

# research houses: the name shown + the words that find it (lower case)
BROKERS = (
    ('Prabhudas Lilladher', ('prabhudas', 'pl capital', 'prabhudaas')), ('Motilal Oswal', ('motilal',)),
    ('ICICI Securities', ('icici securities', 'icicidirect', 'icici direct', 'i-sec', 'isec')),
    ('HDFC Securities', ('hdfc securities', 'hdfc sec')), ('Kotak Securities', ('kotak',)), ('Sharekhan', ('sharekhan',)),
    ('Geojit', ('geojit',)), ('Emkay Global', ('emkay',)), ('JM Financial', ('jm financial', 'jmfl')),
    ('Nuvama', ('nuvama', 'edelweiss')), ('Elara Capital', ('elara',)), ('Antique', ('antique',)), ('Nirmal Bang', ('nirmal bang',)),
    ('SBI Securities', ('sbi securities', 'sbicap')), ('PhillipCapital', ('phillip',)), ('Centrum', ('centrum',)),
    ('Anand Rathi', ('anand rathi',)), ('Axis Securities', ('axis securities', 'axis direct', 'axisdirect', 'axis capital')),
    ('Choice', ('choice institutional', 'choice broking', 'choice equity', 'choice')), ('KR Choksey', ('choksey',)),
    ('Ventura', ('ventura',)), ('Arihant Capital', ('arihant',)), ('Yes Securities', ('yes securities',)),
    ('IDBI Capital', ('idbi capital',)), ('Systematix', ('systematix',)), ('Dolat Capital', ('dolat',)),
    ('BOB Capital Markets', ('bob capital', 'bobcaps')), ('Asit C Mehta', ('asit c',)), ('LKP Securities', ('lkp',)),
    ('Religare', ('religare',)), ('Angel One', ('angel one', 'angel broking')), ('Ashika', ('ashika',)),
    ('Reliance Securities', ('reliance securities',)), ('InCred', ('incred',)), ('Ambit', ('ambit',)), ('Equirus', ('equirus',)),
    ('Monarch Networth', ('monarch',)), ('IIFL', ('iifl',)), ('Batlivala & Karani', ('batlivala', 'b&k securities')),
    ('Sushil Finance', ('sushil',)), ('Bonanza', ('bonanza',)), ('Hem Securities', ('hem securities',)),
    ('Swastika', ('swastika',)), ('Keynote', ('keynote',)), ('Way2Wealth', ('way2wealth',)), ('Mehta Equities', ('mehta equities',)),
    ('Nomura', ('nomura',)), ('Jefferies', ('jefferies',)), ('Morgan Stanley', ('morgan stanley',)), ('Goldman Sachs', ('goldman',)),
    ('CLSA', ('clsa',)), ('Macquarie', ('macquarie',)), ('JPMorgan', ('jp morgan', 'jpmorgan')), ('HSBC', ('hsbc',)),
    ('Bernstein', ('bernstein',)), ('BofA Securities', ('bofa', 'bank of america')), ('Investec', ('investec',)),
    ('Citi', ('citigroup', 'citi research', 'citi ')), ('UBS', ('ubs',)),
)
MONTHS = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
STOP_WORDS = ('ltd', 'limited', 'the', 'pvt', 'private', 'inc', 'plc', 'co', 'company')
# short names the reports use that Main writes in full (lower case, words only)
ALIASES = {'l and t': 'LT', 'larsen and toubro': 'LT', 'm and m': 'M&M', 'mahindra and mahindra': 'M&M', 'sbi': 'SBIN',
           'state bank of india': 'SBIN', 'ril': 'RELIANCE', 'hul': 'HINDUNILVR', 'hindustan unilever': 'HINDUNILVR',
           'bel': 'BEL', 'hal': 'HAL', 'ongc': 'ONGC', 'ntpc': 'NTPC', 'bpcl': 'BPCL', 'hpcl': 'HINDPETRO', 'ioc': 'IOC',
           'tcs': 'TCS', 'infy': 'INFY', 'lic': 'LICI', 'm and m financial': 'M&MFIN', 'jsw steel': 'JSWSTEEL', 'itc': 'ITC'}
WHY = {'nosym': 'not one of your Main stocks (or the name did not match)', 'price': 'no daily candles for it',
       'wait': 'no session since the recommendation yet', 'old': 'before 1-Oct-2026'}
COLS = ('sym', 'co', 'br', 'call', 'tgt', 'rp', 'at', 'src', 'url', 'seen', 'st', 'why', 'ed', 'ep', 'pre', 'o0', 'n', 'kp', 'kd',
        'pg', 'hh', 'dd', 'cl', 'ix', 'now', 'ph', 'pc')

log = print


# ------------------------------------------------------------------ reading the pages
def session():
    return urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def http_get(opener, url, timeout=30):
    """-> (status, text, final url); network problems -> (0, '', why)."""
    req = urllib.request.Request(url, headers={
        'User-Agent': UA, 'Accept': 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-IN,en;q=0.9', 'Accept-Encoding': 'gzip'})
    try:
        with opener.open(req, timeout=timeout) as r:
            raw, status, final = r.read(), r.status, r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, '', url
    except (OSError, urllib.error.URLError) as e:
        return 0, '', str(e)[:120]
    if raw[:2] == b'\x1f\x8b':
        try:
            raw = gzip.decompress(raw)
        except OSError:
            pass
    return status, raw.decode('utf-8', errors='replace'), final


def _text(t):
    t = re.sub(r'<(script|style)\b.*?</\1>', ' ', str(t or ''), flags=re.S | re.I)
    t = re.sub(r'<[^>]+>', ' ', t)
    t = html.unescape(html.unescape(t))
    t = t.replace('₹', ' Rs ').replace('\xa0', ' ').replace('’', "'").replace('–', '-').replace('—', '-')
    return re.sub(r'\s+', ' ', t).strip()


def _num(s):
    try:
        v = float(str(s).replace(',', ''))
    except (TypeError, ValueError):
        return None
    return v if v > 0 else None


TGT = r'(?:price\s+target|target\s+price|target|tp)(?:\s+price)?(?:\s+of)?\s*(?:[:=]\s*)?(?:rs\.?|inr)?\s*(?P<tgt>\d[\d,]*(?:\.\d+)?)'
TAIL = r'\s*(?:[:|]|\s-\s|-\s|\s+by\s+|\s*,\s*says\s+|\s+says\s+|\s*,\s*)\s*(?P<br>[^:|]+?)\s*\.?$'
PATTERNS = (
    # "Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher" / "... For Target Rs.1,720 - Prabhudas Liladhar"
    ('head', re.compile(r'^\s*' + CALL_RE + r'\s+(?:rating\s+on\s+|on\s+)?(?P<co>.+?)\s*(?:[;,:|]\s*|\s-\s|\s+)(?:for\s+|with\s+(?:a\s+)?|and\s+)?'
                        + TGT + TAIL, re.I)),
    # "Hindalco Industries: Buy, target Rs 900 - Motilal Oswal"
    ('co-first', re.compile(r'^\s*(?P<co>[^:|]+?)\s*[:|]\s*' + CALL_RE + r'\b\s*(?:call|rating)?\s*[,;:|-]?\s*(?:with\s+(?:a\s+)?)?'
                            + TGT + TAIL, re.I)),
)
SLUG_RE = re.compile(r'(?:^|/)' + r'(?P<call>strong-buy|buy|sell|hold|accumulate|add|reduce|neutral|outperform|underperform)-'
                     r'(?P<co>[a-z0-9-]+?)-(?:for-|with-)?(?:a-)?(?:target|tp)(?:-price)?(?:-of)?-(?:rs-?)?(?P<tgt>\d+)(?:-(?P<dec>\d{1,2}))?'
                     r'-(?:by-)?(?P<br>[a-z0-9-]+?)(?:-\d{5,})?(?:\.html?|/|$)', re.I)


def broker_name(text):
    """A research house's name from text -> (shown name, True when it is a known one)."""
    t = ' ' + re.sub(r'\s+', ' ', str(text or '').lower()) + ' '
    best = None
    for name, keys in BROKERS:
        for k in keys:
            at = t.find(k if k.endswith(' ') or not k.isalpha() or len(k) > 4 else ' ' + k)
            if at >= 0 and (best is None or at < best[0]):
                best = (at, name)
    if best:
        return best[1], True
    w = re.sub(r'\b(ltd|limited|pvt|private|capital markets?|research|institutional equities|broking)\b\.?', ' ', str(text or ''), flags=re.I)
    w = re.sub(r'\s+', ' ', w).strip(' ,.-:;|')
    return (w[:40].title() if w.islower() else w[:40]), False


def parse_reco(text):
    """A headline / a line of text -> {call, co, tgt, br, known, how} or None."""
    t = _text(text)
    if len(t) < 12 or len(t) > 260 or not re.search(r'target|\btp\b', t, re.I):
        return None
    for how, rx in PATTERNS:
        m = rx.match(t)
        if not m:
            continue
        tgt = _num(m.group('tgt'))
        co = m.group('co').strip(' ,;:-|')
        br, known = broker_name(m.group('br'))
        if not tgt or len(co) < 2 or len(co) > 80 or not br or not re.search(r'[A-Za-z]', co):
            continue
        return {'call': CALL_CODE[re.sub(r'\s+', ' ', m.group('call').lower())], 'co': co, 'tgt': round(tgt, 2), 'br': br,
                'known': known, 'how': how}
    return None


def parse_slug(url):
    """The same words in the link's address: /buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html"""
    path = urllib.parse.urlparse(str(url or '')).path.lower()
    m = SLUG_RE.search(path)
    if not m:
        return None
    tgt = _num(m.group('tgt') + ('.' + m.group('dec') if m.group('dec') else ''))
    br, known = broker_name(m.group('br').replace('-', ' '))
    co = m.group('co').replace('-', ' ').strip()
    if not tgt or not co:
        return None
    return {'call': CALL_CODE[m.group('call').replace('-', ' ')], 'co': co.title(), 'tgt': round(tgt, 2), 'br': br, 'known': known,
            'how': 'link'}


DATE_RES = (
    (re.compile(r'\b(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?'), 'ymd'),
    (re.compile(r'\b(' + '|'.join(MONTHS) + r')[a-z]*\.?\s+(\d{1,2}),?\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?)?', re.I), 'mdy'),
    (re.compile(r'\b(\d{1,2})(?:st|nd|rd|th)?[\s\-/]+(' + '|'.join(MONTHS) + r')[a-z]*\.?[\s\-/,]+(\d{4})(?:[,\s|]+(\d{1,2}):(\d{2})\s*([ap]\.?m\.?)?)?', re.I), 'dmy'),
    (re.compile(r'\b(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})\b'), 'd/m/y'),
)


def find_date(text):
    """The first date in text -> 'yyyy-mm-dd' or 'yyyy-mm-dd HH:MM', else ''."""
    best = None
    for rx, kind in DATE_RES:
        m = rx.search(text or '')
        if not m or (best and m.start() >= best[0]):
            continue
        g = m.groups()
        try:
            hh = mm = None
            if kind == 'ymd':
                d = date(int(g[0]), int(g[1]), int(g[2]))
                hh, mm = g[3], g[4]
            elif kind == 'mdy':
                d = date(int(g[2]), MONTHS.index(g[0][:3].lower()) + 1, int(g[1]))
                hh, mm, ap = g[3], g[4], g[5]
            elif kind == 'dmy':
                d = date(int(g[2]), MONTHS.index(g[1][:3].lower()) + 1, int(g[0]))
                hh, mm, ap = g[3], g[4], g[5]
            else:
                d = date(int(g[2]), int(g[1]), int(g[0]))
            if kind in ('mdy', 'dmy') and hh is not None and ap:
                h = int(hh) % 12 + (12 if ap.lower().startswith('p') else 0)
                hh = str(h)
        except (ValueError, IndexError):
            continue
        if not (2000 <= d.year <= 2100):
            continue
        s = d.isoformat() + (' %02d:%02d' % (int(hh), int(mm)) if hh is not None and mm is not None else '')
        best = (m.start(), s)
    return best[1] if best else ''


def _abs(base, href):
    try:
        return urllib.parse.urljoin(base, html.unescape(href or ''))
    except ValueError:
        return ''


TABLE_KEYS = (('co', ('stock', 'company', 'scrip', 'name', 'security')), ('br', ('broker', 'brokerage', 'research house', 'analyst', 'source', 'by')),
              ('call', ('recommendation', 'reco', 'call', 'rating', 'action', 'advice', 'view')),
              ('tgt', ('target', 'tp')), ('rp', ('reco price', 'price at reco', 'reference', 'cmp', 'price', 'ltp')),
              ('at', ('date', 'reco date', 'time', 'published')))


def table_recos(html_text, base):
    """Tables with Stock / Broker / Recommendation / Target columns -> items."""
    out = []
    for tm in re.finditer(r'<table\b.*?</table>', html_text, re.S | re.I):
        rows = re.findall(r'<tr\b.*?</tr>', tm.group(0), re.S | re.I)
        if len(rows) < 2:
            continue
        head = [_text(c).lower() for c in re.findall(r'<t[hd]\b.*?</t[hd]>', rows[0], re.S | re.I)]
        col = {}
        for key, words in TABLE_KEYS:
            for i, h in enumerate(head):
                if i not in col.values() and any(h == w or h.startswith(w + ' ') or (' ' + w) in (' ' + h) for w in words):
                    col[key] = i
                    break
        if 'co' not in col or 'tgt' not in col or ('call' not in col and 'br' not in col):
            continue
        for row in rows[1:]:
            cells = re.findall(r'<td\b.*?</td>', row, re.S | re.I)
            vals = [_text(c) for c in cells]
            get = lambda k: vals[col[k]] if k in col and col[k] < len(vals) else ''
            tgt = _num(re.sub(r'[^\d.,]', '', get('tgt')))
            co = get('co').strip()
            call_t = get('call').lower().strip()
            call = next((CALL_CODE[c] for c in CALLS if re.match(r'^' + c.replace(' ', r'\s+') + r'\b', call_t)), 'BUY' if not call_t else '')
            if not tgt or not co or not call:
                continue
            br, known = broker_name(get('br')) if get('br') else ('', False)
            link = re.search(r'<a\b[^>]*href="([^"]+)"', row, re.I)
            out.append({'call': call, 'co': co, 'tgt': round(tgt, 2), 'br': br, 'known': known, 'how': 'table',
                        'rp': _num(re.sub(r'[^\d.,]', '', get('rp'))), 'at': find_date(get('at')) or find_date(_text(row)),
                        'url': _abs(base, link.group(1)) if link else ''})
    return out


def page_recos(html_text, base):
    """Every recommendation a page holds -> [item] (call, co, tgt, br, known, how, at, url, rp)."""
    html_text = html_text or ''
    found, seen = [], set()
    opens = [m.start() for m in re.finditer(r'<(?:li|article|tr)\b', html_text, re.I)]
    closes = [m.end() for m in re.finditer(r'</(?:li|article|tr)>', html_text, re.I)]

    def when(pos):
        """The date of the list item (li / article / tr) around pos, else the nearest one after / before it."""
        i, j = bisect.bisect_right(opens, pos) - 1, bisect.bisect_left(closes, pos)
        if i >= 0 and j < len(closes) and closes[j] - opens[i] < 6000:
            d = find_date(_text(html_text[opens[i]:closes[j]]))
            if d:
                return d
        return find_date(_text(html_text[pos: pos + 1200])) or find_date(_text(html_text[max(0, pos - 900): pos]))

    def add(it, pos, url):
        if not it:
            return
        key = (it['call'], norm_name(it['co']), it['tgt'], it['br'].lower())     # a table row and the page's data of it = one
        if key in seen:
            return
        seen.add(key)
        if not it.get('at') and pos is not None:
            it['at'] = when(pos)
        it.setdefault('url', url)
        it.setdefault('rp', None)
        found.append(it)

    for it in table_recos(html_text, base):
        add(it, 0, it.get('url', ''))
    for m in re.finditer(r'<a\b([^>]*)>(.*?)</a>', html_text, re.S | re.I):
        attrs = m.group(1)
        href = re.search(r'href\s*=\s*["\']([^"\']+)["\']', attrs, re.I)
        url = _abs(base, href.group(1)) if href else ''
        title = re.search(r'title\s*=\s*["\']([^"\']+)["\']', attrs, re.I)
        it = parse_reco(m.group(2)) or (parse_reco(title.group(1)) if title else None) or (parse_slug(url) if url else None)
        add(it, m.start(), url)
    # headlines inside the page's own data (JSON in a script)
    for m in re.finditer(r'"(?:title|headline|heading|name|seoTitle)"\s*:\s*"((?:[^"\\]|\\.){12,260})"', html_text):
        try:
            t = json.loads('"' + m.group(1) + '"')
        except ValueError:
            continue
        it = parse_reco(t)
        if it:
            near = html_text[m.start(): m.start() + 1500]
            u = re.search(r'"(?:url|link|href|permalink|shareUrl|canonical)"\s*:\s*"((?:https?:)?(?:\\/|/)[^"]+)"', near)
            d = re.search(r'"(?:date|publishDate|publishedAt|published|datePublished|createdAt|created|updatedAt|time)"\s*:\s*"([^"]{8,40})"', near)
            if d:
                it['at'] = find_date(d.group(1))
            add(it, m.start(), _abs(base, u.group(1).replace('\\/', '/')) if u else '')
    for m in re.finditer(r'<(?:li|h[1-4]|p)\b[^>]*>(.*?)</(?:li|h[1-4]|p)>', html_text, re.S | re.I):
        if '<a' in m.group(1).lower():
            continue
        add(parse_reco(m.group(1)), m.start(), '')
    for it in json_recos(html_text, base):
        add(it, None, it.get('url', ''))          # its own date or none (never a date found elsewhere on the page)
    for it in text_rows(_text(html_text)):
        add(it, None, '')
    return found


# ------------------------------------------------------------------ the page's own data (JSON in its scripts)
JKEYS = (('tgt', ('targetprice', 'target', 'tp', 'tgtprice', 'pricetarget', 'targetvalue')),
         ('co', ('stockname', 'companyname', 'company', 'scname', 'scripname', 'securityname', 'shortname', 'stock', 'name')),
         ('br', ('brokername', 'brokeragename', 'broker', 'brokerage', 'organization', 'organisation', 'orgname', 'researchhouse',
                 'analystname', 'analyst', 'source', 'author')),
         ('call', ('recommendation', 'recotype', 'recommendationtype', 'reco', 'call', 'rating', 'action', 'advice', 'recommend', 'type')),
         ('at', ('recodate', 'recommendationdate', 'reportdate', 'publishdate', 'publisheddate', 'publishedat', 'createdat', 'entrydate',
                 'date', 'created', 'time', 'updatedat')),
         ('rp', ('recoprice', 'priceatreco', 'pricerecommended', 'pricewhenrecommended', 'entryprice', 'cmp', 'ltp', 'price')),
         ('url', ('reporturl', 'pdfurl', 'pdf', 'url', 'link', 'href', 'permalink')),
         ('nse', ('nsesymbol', 'nsecode', 'nseid', 'symbol')))


def _jkey(k):
    return re.sub(r'[^a-z0-9]', '', str(k).lower())


def _jtext(v):
    if isinstance(v, dict):
        v = v.get('name') or v.get('title') or v.get('label') or ''
    return str(v).strip() if isinstance(v, (str, int, float)) and not isinstance(v, bool) else ''


def _jrec(o, base):
    """One object of the page's data -> a recommendation (a target number, a company, a call or a broker) or None."""
    by = {}
    for k, v in o.items():
        by.setdefault(_jkey(k), v)
    got = {}
    for field, names in JKEYS:
        for n in names:
            if n in by and by[n] not in (None, '', []):
                got[field] = by[n]
                break
    tgt = _num(re.sub(r'[^\d.]', '', _jtext(got.get('tgt')))) if 'tgt' in got else None
    co = _text(_jtext(got.get('co')))
    if not tgt or not co or not re.search(r'[A-Za-z]', co) or len(co) > 80:
        return None
    rp = _num(re.sub(r'[^\d.]', '', _jtext(got.get('rp')))) if 'rp' in got else None
    ct = _jtext(got.get('call')).lower()
    call = next((CALL_CODE[c] for c in CALLS if re.match(r'^' + c.replace(' ', r'\s+') + r'\b', ct)), '')
    if not call:
        if rp and not ct and tgt > rp:
            call = 'BUY'
        else:
            return None
    brt = _text(_jtext(got.get('br')))
    br, known = broker_name(brt) if brt else ('', False)
    if not br:
        return None
    url = _jtext(got.get('url'))
    nse = _jtext(got.get('nse')).upper()
    return {'call': call, 'co': co, 'tgt': round(tgt, 2), 'br': br, 'known': known, 'how': 'data', 'rp': rp,
            'at': find_date(_jtext(got.get('at'))), 'url': _abs(base, url) if url.startswith(('http', '/')) else '',
            'nse': nse if re.match(r'^[A-Z0-9&_.-]{1,20}$', nse) else ''}


def json_blobs(html_text):
    """The JSON the page carries in its scripts (Next.js __NEXT_DATA__, ld+json, any application/json)."""
    out = []
    for m in re.finditer(r'<script\b([^>]*)>(.*?)</script>', html_text or '', re.S | re.I):
        if re.search(r'__NEXT_DATA__|application/(?:ld\+)?json', m.group(1), re.I):
            try:
                out.append(json.loads(m.group(2)))
            except ValueError:
                continue
    return out


def _walk(o, fn, depth=0, seen=None):
    seen = seen if seen is not None else [0]
    if depth > 14 or seen[0] > 300000:
        return
    seen[0] += 1
    if isinstance(o, dict):
        fn(o)
        for v in o.values():
            if isinstance(v, (dict, list)):
                _walk(v, fn, depth + 1, seen)
    elif isinstance(o, list):
        for v in o:
            if isinstance(v, (dict, list)):
                _walk(v, fn, depth + 1, seen)


def json_recos(html_text, base):
    out = []
    for blob in json_blobs(html_text):
        _walk(blob, lambda o: out.append(_jrec(o, base)))
    return [x for x in out if x]


# ------------------------------------------------------------------ rows without a <table> (DSIJ: Stock / Broker / Action (Reco Date) /
# CMP (Returns) / Reco Price / Target Price / Potential %) - read from the page's text
NUM = r'[\d,]+(?:\.\d+)?'
ROW_RE = re.compile(r'(?<![A-Za-z])' + CALL_RE + r'\s*\(\s*(?P<d>[^()]{5,30}?)\s*\)\s+(?:Rs\.?\s*)?(?P<cmp>' + NUM +
                    r')\s*(?:\(\s*[-+]?[\d.,]+\s*%?\s*\))?\s+(?:Rs\.?\s*)?(?P<rp>' + NUM + r')\s+(?:Rs\.?\s*)?(?P<tgt>' + NUM + r')', re.I)
ROW_JUNK = re.compile(r'.*(?:[-+]?\d[\d,.]*\s*%|\bPDF\b|\bInsights?\b|\bView\b|\bDownload\b|\bReport\b|\bPotential\b|\bPrice\b|\bDate\)?)\s*', re.I)


def text_rows(text):
    """'Anthem Biosciences Ltd. Prabhudas Lilladher Buy (24 Nov 2026) 980.15 (0.5%) 975.50 1,050.00 7.6% ...' -> items: the call,
    its date in brackets, then CMP (returns), the reco price and the target; the company and the broker = the words before it
    (the broker by its known names, else what follows 'Ltd.' / 'Limited')."""
    out, last = [], 0
    for m in ROW_RE.finditer(text or ''):
        before = text[max(last, m.start() - 160): m.start()]
        last = m.end()
        before = ROW_JUNK.sub('', before).strip(' |,;:-')
        if not before:
            continue
        co, br, known = '', '', False
        mm = re.match(r'^(.*?\b(?:Ltd\.?|Limited\.?))\s+(.+)$', before)
        if mm:
            co = mm.group(1)
            br, known = broker_name(mm.group(2))
        else:
            low, best = ' ' + before.lower(), None
            for name, keys in BROKERS:
                for k in keys:
                    at = low.find(k if k.endswith(' ') or not k.isalpha() or len(k) > 4 else ' ' + k)
                    if at > 1 and (best is None or at < best[0]):
                        best = (at, name)
            if best:
                co, br, known = before[:best[0] - 1].strip(' ,-|'), best[1], True
        tgt, rp = _num(m.group('tgt')), _num(m.group('rp'))
        if not co or not br or not tgt or not re.search(r'[A-Za-z]', co) or len(co) > 80:
            continue
        out.append({'call': CALL_CODE[re.sub(r'\s+', ' ', m.group('call').lower())], 'co': co, 'tgt': round(tgt, 2), 'br': br,
                    'known': known, 'how': 'text', 'rp': rp, 'at': find_date(m.group('d')), 'url': ''})
    return out


# ------------------------------------------------------------------ matching to Main's stocks
def norm_name(s):
    t = str(s or '').lower().replace('&', ' and ')
    t = re.sub(r'\(.*?\)', ' ', t)
    t = re.sub(r'[^a-z0-9 ]+', ' ', t)
    words = [w for w in t.split() if w not in STOP_WORDS]
    return ' '.join(words)


class Names:
    """Main's {SYM: company name} -> company text to SYM."""

    def __init__(self, names):
        self.names = {str(k).upper(): str(v or '') for k, v in (names or {}).items() if k}
        self.by = {}
        for sym, nm in self.names.items():
            for key in {norm_name(nm), norm_name(sym)}:
                if key:
                    self.by.setdefault(key, set()).add(sym)
        self.keys = sorted(self.by)

    def match(self, co):
        raw = str(co or '').strip()
        if raw.upper() in self.names:
            return raw.upper()
        n = norm_name(raw)
        if not n:
            return ''
        if n in ALIASES and ALIASES[n] in self.names:
            return ALIASES[n]
        hit = self.by.get(n)
        if hit and len(hit) == 1:
            return next(iter(hit))
        flat = n.replace(' ', '')
        cands = set()
        for k in self.keys:
            if k.startswith(n + ' ') or n.startswith(k + ' ') or k.replace(' ', '') == flat:
                cands |= self.by[k]
        if len(cands) == 1:
            return next(iter(cands))
        # "hospitals" / "hosp", "industries" / "inds": the first two words + the start of the third
        w = n.split()
        if len(w) >= 2:
            pre = ' '.join(w[:2])
            c2 = set()
            for k in self.keys:
                if k == pre or k.startswith(pre + ' '):
                    c2 |= self.by[k]
            if len(c2) == 1:
                return next(iter(c2))
        return ''


# ------------------------------------------------------------------ the store
def _load(path, empty):
    try:
        with open(path, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else dict(empty)
    except (OSError, ValueError):
        return dict(empty)


def _save(path, d):
    tmp = path + '.%d.tmp' % os.getpid()
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(d, f, separators=(',', ':'))
    os.replace(tmp, path)


def load_store():
    d = _load(STORE_PATH, {})
    if d.get('v') != 1:
        d = {'v': 1, 'recos': {}, 'lists': {}}
    d.setdefault('recos', {})
    d.setdefault('lists', {})
    return d


def rec_key(it):
    return hashlib.sha1(('%s|%s|%s|%s|%s' % (it['br'].lower(), norm_name(it['co']), it['call'], it['tgt'],
                                             (it.get('at') or '')[:10])).encode('utf-8')).hexdigest()[:16]


def merge(store, items, src, today):
    """New items -> the store (the same broker, company, call and target within DUP_DAYS days = one, its earliest day and
    every website kept) -> the number of new recommendations."""
    recos = store['recos']
    added = 0
    by = {}
    for k, r in recos.items():
        by.setdefault((r['br'].lower(), norm_name(r['co']), r['call'], r['tgt']), []).append(k)
    for it in items:
        at = it.get('at') or today.isoformat()
        it = dict(it, at=at)
        same = None
        for k in by.get((it['br'].lower(), norm_name(it['co']), it['call'], it['tgt']), []):
            try:
                gap = abs((date.fromisoformat(recos[k]['at'][:10]) - date.fromisoformat(at[:10])).days)
            except ValueError:
                gap = 0
            if gap <= DUP_DAYS:
                same = k
                break
        if same:
            r = recos[same]
            if src not in r['src'].split(','):
                r['src'] = r['src'] + ',' + src
            if at[:10] < r['at'][:10] or (at[:10] == r['at'][:10] and len(at) > len(r['at'])):
                r['at'] = at
            if not r.get('url') and it.get('url'):
                r['url'] = it['url']
            if r.get('rp') is None and it.get('rp'):
                r['rp'] = it['rp']
            if not r.get('nse') and it.get('nse'):
                r['nse'] = it['nse']
            continue
        k = rec_key(it)
        recos[k] = {'co': it['co'], 'br': it['br'], 'known': bool(it.get('known')), 'call': it['call'], 'tgt': it['tgt'],
                    'rp': it.get('rp'), 'at': at, 'src': src, 'url': it.get('url') or '', 'seen': today.isoformat(),
                    'dated': bool(it.get('at')), 'nse': it.get('nse') or ''}
        by.setdefault((it['br'].lower(), norm_name(it['co']), it['call'], it['tgt']), []).append(k)
        added += 1
    return added


# ------------------------------------------------------------------ reading the websites
def read_list(opener, first, page_n, pages, stop_day, fetch=None, sleep=time.sleep, gap=GAP_S, until_old=False):
    """Pages 1 .. pages of one list -> (items, pages read, why stopped). A page without any recommendation ends the list;
    `until_old` (AnalystNow) goes on until a page reaches back before stop_day; a page the same as one before ends it."""
    fetch = fetch or (lambda u: http_get(opener, u))
    items, read, why = [], 0, ''
    keys = set()
    for n in range(1, max(1, pages) + 1):
        url = first if n == 1 else (page_n.format(n=n) if page_n else '')
        if not url:
            break
        if read:
            sleep(gap)
        status, text, final = fetch(url)
        read += 1
        if status != 200 or not text:
            why = 'HTTP %s' % status if status else 'no answer (%s)' % final
            break
        got = page_recos(text, final or url)
        if not got:
            why = '' if items else 'no recommendation found on the page'
            break
        page_keys = {(i['call'], i['co'].lower(), i['tgt'], i['br'].lower()) for i in got}
        if n > 1 and page_keys <= keys:
            break                                   # the website gave the same page again (it has no page n)
        keys |= page_keys
        items.extend(got)
        days = sorted(i['at'][:10] for i in got if i.get('at'))
        if days and days[0] < stop_day:
            break                                   # this page already reaches back before stop_day
        if until_old is False and n >= pages:
            break
    return items, read, why


def collect(store, today, back=False, fetch=None, sleep=time.sleep, gap=GAP_S, out=None, pages=PAGES_PER_ROUND):
    """Every website's lists -> the store. -> {src: [new, found, why]}"""
    out = out or log
    res = {}
    opener = session()
    for code, name, lists in SOURCES:
        new = found = 0
        whys = []
        for lname, first, page_n in lists:
            n = BACK_PAGES if back else pages
            try:
                items, read, why = read_list(opener, first, page_n, n, FROM_DAY, fetch, sleep, gap, until_old=back)
            except Exception as e:            # one list never stops the others
                items, read, why = [], 0, str(e)[:120]
            store['lists']['%s|%s' % (code, lname)] = {'at': datetime.now().isoformat(timespec='seconds'), 'items': len(items),
                                                       'pages': read, 'why': why}
            found += len(items)
            if why and not items:
                whys.append('%s: %s' % (lname, why))
            new += merge(store, [i for i in items if (i.get('at') or today.isoformat())[:10] >= FROM_DAY], code, today)
            sleep(gap)
        res[code] = [new, found, '; '.join(whys)]
    return res


# ------------------------------------------------------------------ what the price did
def outcomes(store, names, lab, today):
    """Every stored recommendation -> a row (COLS): matched to a Main stock, then the Kite daily candles after it."""
    meta, d = lab.load_meta()
    idx = ((meta or {}).get('index') or {}).get('D') or {}
    ix = ((meta or {}).get('indices') or {}).get(ET.BENCH)
    upto = str((meta or {}).get('upto') or '')
    rows = []
    f = open(os.path.join(d, 'D.bin'), 'rb') if d and idx else None
    cache = {}
    try:
        for k, r in sorted(store['recos'].items(), key=lambda kv: kv[1]['at'], reverse=True)[:KEEP]:
            sym = r.get('sym') or (r['nse'] if r.get('nse') and r['nse'] in names.names else '') or names.match(r['co'])
            if sym:
                r['sym'] = sym
            row = {'sym': sym or '', 'co': r['co'], 'br': r['br'], 'call': r['call'], 'tgt': r['tgt'], 'rp': r.get('rp'),
                   'at': r['at'][:16], 'src': r['src'], 'url': r.get('url') or '', 'seen': r.get('seen') or '', 'st': 'x', 'why': ''}
            if r['at'][:10] < FROM_DAY:
                row['why'] = 'old'
            elif not sym:
                row['why'] = 'nosym'
            elif f is None or sym not in idx or idx[sym][1] <= 0:
                row['why'] = 'price'
            else:
                got = cache.get(sym)
                if got is None:
                    cs = lab.Candles(f, idx[sym][0], idx[sym][1])
                    got = cache[sym] = (cs, list(cs.day))
                cs, days = got
                at = r['at'] if len(r['at']) > 10 else r['at'][:10] + ' 09:00'     # no time: that day's close (else the next session)
                k0 = ET.entry_index(days, at)
                if k0 is None:
                    row['why'] = 'wait'
                else:
                    row.update(ET.after(cs, k0, r['tgt'], ix))
                    row.pop('wq', None)
                    row['st'] = 'ok'
            rows.append(row)
    finally:
        if f:
            f.close()
    return upto, rows


def summary(rows):
    ok = [r for r in rows if r['st'] == 'ok']
    why = {}
    for r in rows:
        if r['st'] != 'ok' and r['why']:
            why[r['why']] = why.get(r['why'], 0) + 1
    src = {}
    for r in rows:
        for s in r['src'].split(','):
            src[s] = src.get(s, 0) + 1
    days = sorted(r['at'][:10] for r in rows)
    return {'recos': len(rows), 'ok': len(ok), 'brokers': len({r['br'] for r in rows}), 'stocks': len({r['sym'] for r in rows if r['sym']}),
            'buy': sum(1 for r in rows if r['call'] in ('BUY', 'ACCUMULATE', 'ADD', 'OUTPERFORM')), 'why': why, 'src': src,
            'from': days[0] if days else '', 'to': days[-1] if days else ''}


def pack(rows):
    body = json.dumps({'cols': list(COLS), 'rows': [[r.get(k) for k in COLS] for r in rows]}, separators=(',', ':'))
    return base64.b64encode(gzip.compress(body.encode('utf-8'), 9, mtime=0)).decode('ascii')


def unpack(blob):
    d = json.loads(gzip.decompress(base64.b64decode(blob)).decode('utf-8'))
    return [dict(zip(d['cols'], r)) for r in d['rows']]


def get_names(cfg, api, st, out, force=False):
    """Main's company names (asked again every NAMES_EVERY_S) -> (Names, refused words)."""
    if force or not st.get('names') or time.time() - float(st.get('namesAt') or 0) > NAMES_EVERY_S:
        try:
            ans = api(cfg, 'recos', {'op': 'names'}, tries=2, timeout=120)
        except RuntimeError as e:
            ans = {'ok': False, 'error': str(e)}
        if ans.get('ok') and isinstance(ans.get('names'), dict):
            st['names'], st['namesAt'] = ans['names'], time.time()
        elif 'unknown action' in str(ans.get('error') or ''):
            return Names(st.get('names') or {}), ('the sheet does not know the Analyst Targets yet - the laptop\'s updater puts the new '
                                                  'sheet code in (UpdateNow.bat), then they are sent')
    return Names(st.get('names') or {}), ''


def step(cfg, api, lab, today=None, back=False, force=False, fetch=None, sleep=time.sleep, gap=GAP_S, out=None):
    """The round's step (never raises): the newest recommendations of every website, matched to Main's stocks, what the
    price did after each, sent to the sheet when anything changed. -> rows sent or None."""
    out = out or log
    if not cfg.get('analyst_targets', True):
        return None
    try:
        today = today or date.today()
        if not lab.current_dir():          # nothing can be worked out (or sent) without the Kite daily candles
            out('Analyst targets: no Kite daily candles on this computer yet (they come with the daily Kite scan) - the websites are read once they are there.')
            return None
        store = load_store()
        st = _load(STATE_PATH, {})
        res = collect(store, today, back, fetch, sleep, gap, out)
        _save(STORE_PATH, store)
        new = sum(v[0] for v in res.values())
        if not any(v[1] for v in res.values()):
            out('Analyst targets: none of the websites gave a recommendation (%s) - run AnalystCheck.bat and send what it prints.'
                % '; '.join('%s %s' % (SOURCE_NAMES[k], v[2] or 'nothing') for k, v in res.items()))
        names, refused = get_names(cfg, api, st, out)
        if refused:
            out('Analyst targets: %s.' % refused)
            _save(STATE_PATH, st)
            return None
        upto, rows = outcomes(store, names, lab, today)
        _save(STORE_PATH, store)
        blob = pack(rows)
        md5 = hashlib.md5(('%s|%s|%d' % (blob, upto, ENGINE)).encode('ascii')).hexdigest()
        if not force and st.get('sent') == md5:
            _save(STATE_PATH, st)
            return 0
        body = {'op': 'put', 'made': datetime.now().isoformat(timespec='seconds'), 'upto': upto, 'sum': summary(rows), 'blob': blob,
                'engine': ENGINE}
        try:
            ans = api(cfg, 'recos', body, tries=2, timeout=240)
        except RuntimeError as e:
            ans = {'ok': False, 'error': 'could not send (%s)' % e}
        if not ans.get('ok'):
            err = str(ans.get('error') or 'unknown error')
            out('Analyst targets: %s - the next round tries again.' % (
                'the sheet does not know the Analyst Targets yet - the laptop\'s updater puts the new sheet code in (UpdateNow.bat)'
                if 'unknown action' in err else 'the sheet refused - %s' % err))
            _save(STATE_PATH, st)
            return None
        st['sent'] = md5
        _save(STATE_PATH, st)
        s = summary(rows)
        out('Analyst targets (prices up to %s): %d new recommendation(s) (%s) - %d since %s from %d broker(s), %d of your stocks%s; '
            'sent to the sheet.' % (upto, new, ', '.join('%s %d' % (SOURCE_NAMES[k], v[0]) for k, v in res.items()), s['recos'],
                                    FROM_DAY, s['brokers'], s['stocks'],
                                    ', %d not matched to your stocks' % s['why'].get('nosym', 0) if s['why'].get('nosym') else ''))
        return len(rows)
    except Exception as e:                     # never stops a round
        out('Analyst targets: %s' % e)
        return None


# ------------------------------------------------------------------ AnalystCheck.bat
def check(out=print, fetch=None, names=None, save=True):
    """Page 1 of every list: what came back and the recommendations found in it (nothing sent)."""
    opener = session()
    fetch = fetch or (lambda u: http_get(opener, u))
    nm = Names(names or {})
    if save:
        os.makedirs(CHECK_DIR, exist_ok=True)
    total = 0
    for code, name, lists in SOURCES:
        for lname, first, page_n in lists:
            out('')
            out('%s - %s: %s' % (name, lname, first))
            status, text, final = fetch(first)
            if status != 200 or not text:
                out('   HTTP %s%s' % (status, ('' if status else ' - ' + final)))
                continue
            if save:
                fn = os.path.join(CHECK_DIR, '%s_%s.html' % (code, re.sub(r'\W+', '_', lname)))
                with open(fn, 'w', encoding='utf-8') as f:
                    f.write(text)
            got = page_recos(text, final or first)
            total += len(got)
            kinds = {}
            for g in got:
                kinds[g['how']] = kinds.get(g['how'], 0) + 1
            days = sorted(g['at'][:10] for g in got if g.get('at'))
            out('   HTTP 200, %d characters%s; %d recommendation(s) found (%s)%s' % (
                len(text), (' (moved to %s)' % final) if final and final != first else '', len(got),
                ', '.join('%s %d' % kv for kv in sorted(kinds.items())) or '-',
                (' - dates %s .. %s' % (days[0], days[-1])) if days else ' - no dates found next to them'))
            for g in got[:6]:
                sym = ((g['nse'] if g.get('nse') in nm.names else nm.match(g['co'])) if names else '')
                out('   %s | %s %s | target %g | %s%s | %s' % (g.get('at') or '(no date)', g['call'], g['co'],
                                                            g['tgt'], g['br'], '' if g.get('known') else ' (?)',
                                                            ('-> ' + sym) if sym else ('not matched' if names else '')))
            inside = [g for g in got if (g.get('at') or '9')[:10] >= FROM_DAY]
            if got:
                out('   %d of them from %s on' % (len(inside), FROM_DAY))
            if not got:
                t = _text(text)
                bits = [m.group(0) for m in re.finditer(r'.{0,90}\btarget\b.{0,90}', t, re.I)][:6]
                out('   %d links, page data: %s; lines with "target": %s' % (
                    len(re.findall(r'<a\b', text, re.I)),
                    ', '.join(k for k, rx in (('__NEXT_DATA__', '__NEXT_DATA__'), ('ld+json', 'application/ld\\+json'),
                                              ('tables', '<table')) if re.search(rx, text)) or 'none',
                    ' || '.join(bits) if bits else 'none'))
                for line in shape_words(text, t):
                    out('   ' + line)
    out('')
    out('%d recommendation(s) found on the first pages%s' % (total, (' - the pages are kept in %s' % CHECK_DIR) if save else ''))
    return total


def shape_words(html_text, text):
    """AnalystCheck on a page where nothing was found: what its data and its rows look like (for the next fix)."""
    lines = []
    for blob in json_blobs(html_text)[:3]:
        paths = []

        def look(o, path, depth=0):
            if depth > 10 or len(paths) >= 8:
                return
            if isinstance(o, dict):
                ks = [_jkey(k) for k in o]
                if any('target' in k or 'tgt' in k or k in ('tp', 'reco', 'recommendation', 'brokername') for k in ks):
                    sample = {k: (str(v)[:40] if not isinstance(v, (dict, list)) else type(v).__name__) for k, v in list(o.items())[:16]}
                    paths.append('%s = %s' % (path or '(top)', json.dumps(sample, ensure_ascii=True)[:420]))
                    return
                for k, v in o.items():
                    if isinstance(v, (dict, list)):
                        look(v, path + '.' + str(k), depth + 1)
            elif isinstance(o, list):
                for i, v in enumerate(o[:3]):
                    look(v, path + '[%d]' % i, depth + 1)
        look(blob, '')
        if paths:
            lines.append('page data with target-like names: ' + ' || '.join(paths))
        elif isinstance(blob, dict):
            pp = (blob.get('props') or {}).get('pageProps') if isinstance(blob.get('props'), dict) else None
            keys = list((pp if isinstance(pp, dict) else blob).keys())[:30]
            lines.append('page data keys (no target-like names): ' + ', '.join(str(k) for k in keys))
    apis = sorted(set(re.findall(r'https?://[a-z0-9.-]*(?:api|apps)[a-z0-9.-]*\.[a-z]+/[^"\'\s<>]{3,120}', html_text or '', re.I)))
    apis = [a for a in apis if re.search(r'idea|broker|research|reco|target|stock', a, re.I)][:8]
    if apis:
        lines.append('data addresses in the page: ' + ' || '.join(apis))
    m = re.search(r'Target\s*Price', html_text or '', re.I)
    if m:
        raw = re.sub(r'<(script|style|svg)\b.*?</\1>', ' ', html_text[m.start(): m.start() + 12000], flags=re.S | re.I)
        raw = re.sub(r'\s+', ' ', raw)
        raw = re.sub(r'\s(?:style|data-[a-z-]+|aria-[a-z-]+|onclick)="[^"]*"', '', raw)
        lines.append('the page after "Target Price" (tags kept, shortened): ' + raw[:1800])
    return lines


def words(rows, sym):
    """AnalystNow.bat SYMBOL: one stock's recommendations in plain words."""
    lines = []
    for r in rows:
        if r['sym'] != sym:
            continue
        s = '%s %s: %s %s, target %g (%s)' % (r['at'], sym, r['br'], r['call'], r['tgt'], SOURCE_NAMES.get(r['src'].split(',')[0], r['src']))
        if r['st'] == 'ok':
            s += ' -> entry %s close %.2f (%+.1f%% to the target)' % (r['ed'], r['ep'], (r['tgt'] / r['ep'] - 1) * 100)
            k = r['kp'][-1]
            s += ' - reached after %d session(s) (%s)' % (k, r['kd'][-1]) if k is not None else ' - not reached in %d session(s)' % r['n']
        elif r['why']:
            s += ' - %s' % WHY.get(r['why'], r['why'])
        lines.append(s)
    return lines
