#!/usr/bin/env python3
"""
Auto Bhavcopy - PC bridge for screener.in
=========================================
screener.in refuses requests that come from Google's servers, so the Google
Sheet cannot read it. This small program runs on YOUR computer instead:

  1. asks your sheet which symbols still need screener data,
  2. opens those screener.in pages from your own internet connection,
  3. sends the page text back to your sheet,
  4. tells the sheet to process it (same Results Day / Quarterly logic as before).

It also downloads NSE's daily "Price Band changes from next trade date" file
(eq_band_changes_DDMMYYYY.csv - NSE does not answer Google's servers either)
and hands it to the sheet, which files it on the "Price Band Changes" tab and
sends the day's email - no more copy/paste.

And it reads NSE's IPO lists (current, past issues, upcoming) so the sheet can
keep its "IPO Tracker" tab (mainboard IPOs: open now / closed - awaiting listing /
upcoming, with dates) and send one IPO email a day.

Commands (Setup.bat / RunNow.bat call these for you):
  python screener_bridge.py setup      one-time setup (address + secret code + schedule)
  python screener_bridge.py run        do one round of work (starts by itself after you log in, waits for the internet)
  python screener_bridge.py test       check the connection to the sheet, screener.in and NSE
  python screener_bridge.py pricebands download NSE's price band changes and send them now
  python screener_bridge.py ipos       read NSE's IPO lists and update the IPO Tracker tab now
  python screener_bridge.py moneycontrol SYMBOL   show moneycontrol's latest quarterly results (test, nothing sent)
  python screener_bridge.py reschedule re-create the log-in schedule only, keeps your settings
  python screener_bridge.py uninstall  remove the schedule

Needs only Python 3.8+ (nothing else to install). Files it creates sit next to
this script: config.json (your settings) and bridge.log (what it did).
"""
import csv
import gzip
import io
import json
import os
import random
import re
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta
from html import unescape as html_unescape
from html.parser import HTMLParser
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'config.json')
LOG_PATH = os.path.join(HERE, 'bridge.log')
LOCK_PATH = os.path.join(HERE, 'bridge.lock')
PB_STATE_PATH = os.path.join(HERE, 'pricebands_state.json')
MC_CODES_PATH = os.path.join(HERE, 'moneycontrol_codes.json')
TASK_NAME = 'AutoBhavcopyScreenerBridge'
STARTUP_FILE = 'AutoBhavcopyScreenerBridge.vbs'

DEFAULTS = {
    'url': '',                 # Apps Script web app address
    'token': '',               # secret code from the sheet menu
    'screener_base': 'https://www.screener.in',
    'max_missing_per_run': 100,  # never-attempted rows fetched per run (results-due ones are always fetched)
    'delay_min': 2.5,          # seconds between screener requests
    'delay_max': 4.5,
    'batch_size': 5,           # pages sent to the sheet at a time
    'abort_after_failures': 5, # stop the run after this many failures in a row
    'price_bands': True,       # download NSE's price band changes at every run
    'ipos': True,              # read NSE's IPO lists at every run (IPO Tracker tab + daily email)
    'eod': True,               # NSE end-of-day files: Delivery %, 52-week highs, market statistics
    'moneycontrol': True,      # results not on screener.in yet: look on moneycontrol and send its figures first
    'max_moneycontrol_per_run': 40,
}

UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) '
      'Chrome/124.0 Safari/537.36')


# ----------------------------------------------------------------- helpers
def log(msg):
    line = '%s  %s' % (datetime.now().strftime('%Y-%m-%d %H:%M:%S'), msg)
    try:
        print(line)
    except Exception:
        pass
    try:
        if os.path.exists(LOG_PATH) and os.path.getsize(LOG_PATH) > 800 * 1024:
            with open(LOG_PATH, 'r', encoding='utf-8', errors='replace') as f:
                tail = f.read()[-300 * 1024:]
            with open(LOG_PATH, 'w', encoding='utf-8') as f:
                f.write(tail)
        with open(LOG_PATH, 'a', encoding='utf-8') as f:
            f.write(line + '\n')
    except Exception:
        pass


def load_config():
    cfg = dict(DEFAULTS)
    if os.path.exists(CONFIG_PATH):
        with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
            cfg.update(json.load(f))
    return cfg


def save_config(cfg):
    with open(CONFIG_PATH, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, indent=2)


def http(url, data=None, timeout=60, headers=None):
    """Returns (status, text). Network problems raise OSError/URLError."""
    h = {'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8',
         'Accept-Language': 'en-US,en;q=0.9', 'Accept-Encoding': 'identity'}
    if headers:
        h.update(headers)
    req = urllib.request.Request(url, data=data, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            body = ''
        return e.code, body


def api(cfg, action, payload=None, timeout=120, tries=3):
    """Talks to the sheet's web app. Returns the parsed JSON answer."""
    body = dict(payload or {})
    body['token'] = cfg['token']
    body['action'] = action
    raw = json.dumps(body).encode('utf-8')
    last = ''
    for attempt in range(tries):
        try:
            status, text = http(cfg['url'], data=raw, timeout=timeout,
                                headers={'Content-Type': 'text/plain;charset=utf-8'})
            if status == 200:
                try:
                    return json.loads(text)
                except ValueError:
                    last = 'the address did not answer like the sheet bridge (is it the "Web app" URL ending in /exec?)'
            else:
                last = 'HTTP %s' % status
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            last = str(e)
        if attempt < tries - 1:
            time.sleep(10 * (attempt + 1))
    raise RuntimeError('Could not reach the sheet: ' + last)


# ------------------------------------------------------------------ screener
SECTION_IDS = ('quarters', 'profit-loss', 'shareholding')
REAL_PAGE_MARKERS = ('id="top-ratios"', "id='top-ratios'", 'id="quarters"', "id='quarters'",
                     'id="profit-loss"', "id='profit-loss'")


def looks_real(html):
    """A genuine screener company page - not a login/captcha/blocked page."""
    return any(m in html for m in REAL_PAGE_MARKERS)


def trim(html):
    """Keep only the sections the sheet reads (same pattern the sheet uses), so each page is ~10x smaller."""
    parts = []
    for sid in SECTION_IDS:
        m = re.search(r'<section[^>]*id=["\']%s["\'][\s\S]*?</section>' % re.escape(sid), html, re.I)
        if m:
            parts.append(m.group(0))
    return '<html><body>' + '\n'.join(parts) + '</body></html>'


def screener_url(cfg, sym, consolidated=True):
    base = cfg['screener_base'].rstrip('/')
    return '%s/company/%s/%s' % (base, urllib.parse.quote(sym), 'consolidated/' if consolidated else '')


class Blocked(Exception):
    pass


def fetch_page(cfg, sym, consolidated=True):
    """Returns ('ok', trimmed_html) | ('404', None). Raises Blocked on anything else."""
    url = screener_url(cfg, sym, consolidated)
    for attempt in range(2):
        try:
            status, text = http(url, timeout=45)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            raise Blocked('network: %s' % e)
        if status == 200:
            if not looks_real(text):
                raise Blocked('page did not look like a screener company page (blocked / captcha?)')
            return 'ok', trim(text)
        if status == 404:
            return '404', None
        if status == 429 and attempt == 0:
            log('  screener said "slow down" (429) - waiting 90 s')
            time.sleep(90)
            continue
        raise Blocked('HTTP %s' % status)
    raise Blocked('HTTP 429')


def polite_sleep(cfg):
    time.sleep(random.uniform(float(cfg['delay_min']), float(cfg['delay_max'])))


# ------------------------------------------------------------- NSE price bands
# NSE > All Reports > Equities & SME > "Price Band changes from next trade date (csv)".
# Published every trading evening as eq_band_changes_DDMMYYYY.csv where DDMMYYYY is the
# NEXT trading day - the day the new bands apply (Monday evening's file carries Tuesday's
# date). Below, "file date" = that date; the sheet gets the weekday before it as the
# report date, exactly like a paste made on the evening it was published.
PB_URLS = ('https://nsearchives.nseindia.com/content/equities/eq_band_changes_{d}.csv',
           'https://archives.nseindia.com/content/equities/eq_band_changes_{d}.csv')
PB_REPORTS_API = 'https://www.nseindia.com/api/merged-daily-reports?key=favCapital'   # the All Reports page's own list
PB_LOOKBACK_DAYS = 7     # catch up on files missed while the computer was off (older ones are skipped)
PB_STATE_VERSION = 2     # 1 read the file date as the report date; a v1 state re-checks the last week once


def nse_session():
    """An opener that keeps NSE's cookies (NSE wants them before it hands out files)."""
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    for url, ref in (('https://www.nseindia.com/', 'https://www.google.com/'),
                     ('https://www.nseindia.com/all-reports', 'https://www.nseindia.com/')):
        try:
            nse_get(opener, url, referer=ref, timeout=20)
        except (OSError, urllib.error.URLError, socket.timeout):
            pass
    return opener


def nse_get(opener, url, referer='https://www.nseindia.com/all-reports', timeout=30):
    """Returns (status, bytes). Network problems raise OSError/URLError."""
    req = urllib.request.Request(url, headers={'User-Agent': UA, 'Accept': '*/*', 'Accept-Language': 'en-US,en;q=0.9',
                                               'Accept-Encoding': 'identity', 'Referer': referer})
    try:
        with opener.open(req, timeout=timeout) as r:
            raw = r.read()
            status = r.status
    except urllib.error.HTTPError as e:
        return e.code, b''
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return status, raw


def _pb_norm(v):
    return re.sub(r'[^A-Z0-9]', '', str(v).upper())


def pb_parse(raw):
    """The band file's bytes -> [{symbol, series, name, from, to}], or None when it is not that file."""
    text = raw.decode('utf-8-sig', errors='replace')
    if '<html' in text[:600].lower():
        return None
    table = list(csv.reader(io.StringIO(text)))
    head, ix = -1, None
    for i, row in enumerate(table[:5]):
        h = [_pb_norm(c) for c in row]
        f = next((j for j, c in enumerate(h) if c == 'FROM' or c.endswith('FROM')), -1)
        t = next((j for j, c in enumerate(h) if c == 'TO' or (c.endswith('TO') and j != f)), -1)
        if 'SYMBOL' in h and f >= 0 and t >= 0:
            ix = {'symbol': h.index('SYMBOL'), 'from': f, 'to': t,
                  'series': h.index('SERIES') if 'SERIES' in h else -1,
                  'name': h.index('SECURITYNAME') if 'SECURITYNAME' in h else -1}
            head = i
            break
    if ix is None:
        return None
    out = []
    for row in table[head + 1:]:
        def cell(k):
            j = ix[k]
            return row[j].strip() if 0 <= j < len(row) else ''
        sym = cell('symbol').upper()
        if sym:
            out.append({'symbol': sym, 'series': cell('series'), 'name': cell('name'), 'from': cell('from'), 'to': cell('to')})
    return out


def pb_fetch(opener, day, url=None):
    """('ok', rows) | ('missing', None) - not published (yet) or a holiday | ('error', reason).
    The first address is NSE's current one: its 404 means "not there", its failure is an error."""
    tag = day.strftime('%d%m%Y')
    outcomes = []          # per address: 'missing' or an error text
    for u in ([url] if url else [t.format(d=tag) for t in PB_URLS]):
        try:
            status, raw = nse_get(opener, u)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            outcomes.append('NSE did not answer (%s)' % e)
            continue
        if status == 404:
            outcomes.append('missing')
            continue
        if status != 200:
            outcomes.append('HTTP %s from NSE' % status)
            continue
        rows = pb_parse(raw)
        if rows is None:
            outcomes.append('NSE did not send the CSV file (a web page came back instead)')
            continue
        return 'ok', rows
    if outcomes and (outcomes[0] == 'missing' or all(o == 'missing' for o in outcomes)):
        return 'missing', None
    return 'error', next((o for o in outcomes if o != 'missing'), 'nothing tried')


def pb_links_from_api(opener):
    """[(date, url)] of band files listed on NSE's All Reports page - in case the address changes."""
    try:
        status, raw = nse_get(opener, PB_REPORTS_API, timeout=30)
    except (OSError, urllib.error.URLError, socket.timeout):
        return []
    if status != 200:
        return []
    out = {}
    for m in re.finditer(r'(https?:\\?/\\?/[^"\s]+?eq_band_changes_(\d{2})(\d{2})(\d{4})\.csv)', raw.decode('utf-8', errors='replace')):
        try:
            out[date(int(m.group(4)), int(m.group(3)), int(m.group(2)))] = m.group(1).replace('\\/', '/')
        except ValueError:
            pass
    return sorted(out.items())


def pb_load_state():
    try:
        with open(PB_STATE_PATH, 'r', encoding='utf-8') as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def pb_save_state(st):
    try:
        with open(PB_STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(st, f, indent=2)
    except OSError as e:
        log('Price bands: could not save %s (%s)' % (PB_STATE_PATH, e))


def next_weekday(d):
    d += timedelta(days=1)
    while d.weekday() >= 5:
        d += timedelta(days=1)
    return d


def prev_weekday(d):
    d -= timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def pb_days_to_check(today, last):
    """File dates still to fetch: weekdays after the last file the sheet received, up to two
    trading days ahead (this evening's file carries the next trading day's date; after a
    holiday it carries the day after). At most PB_LOOKBACK_DAYS back."""
    start = today - timedelta(days=PB_LOOKBACK_DAYS)
    if last:
        start = max(start, last + timedelta(days=1))
    end = next_weekday(next_weekday(today))
    days = []
    d = start
    while d <= end:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def pb_send(cfg, day, rows, st):
    """Hands one file (day = its file date, the day the bands apply) to the sheet. True when the sheet filed it."""
    label = day.strftime('%d-%m-%Y')
    try:
        res = api(cfg, 'pricebands', {'reportDate': prev_weekday(day).isoformat(), 'rows': rows}, timeout=180)
    except RuntimeError as e:
        log('Price bands %s: sending to the sheet failed (%s) - the next run tries again.' % (label, e))
        return False
    if not res.get('ok'):
        err = res.get('error') or 'unknown error'
        if err == 'unknown action':
            err = ('the sheet\'s web app does not know price bands yet - in Apps Script: Deploy > Manage deployments > '
                   'pencil > Version: New version > Deploy')
        log('Price bands %s: the sheet refused - %s' % (label, err))
        return False
    note = ', email sent' if res.get('emailed') else (', filed quietly (an older day)' if res.get('quiet') else '')
    if res.get('removed'):
        note += ', %d repeated row(s) cleared' % res.get('removed')
    log('Price bands from %s: %d change(s) from NSE, %d new on the sheet, %d in Main%s.'
        % (label, res.get('rows', 0), res.get('added', 0), res.get('inMain', 0), note))
    st['v'] = PB_STATE_VERSION
    st['last'] = day.isoformat()
    st['last_sent_at'] = datetime.now().strftime('%Y-%m-%d %H:%M')
    pb_save_state(st)
    return True


def price_bands_step(cfg, today=None):
    """Downloads every price band file the sheet has not had yet and hands it over. Never raises."""
    if not cfg.get('price_bands', True):
        return
    try:
        st = pb_load_state()
        today = today or date.today()
        last = None
        if st.get('last') and st.get('v') == PB_STATE_VERSION:
            try:
                last = date.fromisoformat(st['last'])
            except ValueError:
                last = None
        days = pb_days_to_check(today, last)
        upcoming = next_weekday(today)          # this evening's file (or already out, after market close)
        opener = nse_session()
        sent, problems, upcoming_missing = 0, [], False
        for i, d in enumerate(days):
            kind, val = pb_fetch(opener, d)
            if kind == 'ok':
                if not pb_send(cfg, d, val, st):
                    return
                sent += 1
            elif kind == 'missing':
                upcoming_missing = upcoming_missing or d == upcoming
            elif d <= upcoming:                 # a day further ahead is simply not out yet
                problems.append('%s: %s' % (d.strftime('%d-%m-%Y'), val))
            if i < len(days) - 1:
                time.sleep(1.5)
        if not sent and (problems or upcoming_missing):
            # the file address may have changed: look it up on NSE's All Reports list
            newer = [(d, u) for d, u in pb_links_from_api(opener) if (last is None or d > last) and d in days]
            for d, u in newer:
                kind, val = pb_fetch(opener, d, url=u)
                if kind == 'ok' and pb_send(cfg, d, val, st):
                    sent += 1
                    upcoming_missing = upcoming_missing and d != upcoming
        if problems and not sent:
            log('Price bands: could not download from NSE - %s. If this keeps happening, use the Priceband paste tab.'
                % '; '.join(problems[-2:]))
        elif upcoming_missing:
            log('Price bands: the file for %s (NSE publishes it in the evening) is not out yet - the next run tries again.'
                % upcoming.strftime('%d-%m-%Y'))
        elif not sent:
            cur = st.get('last')
            log('Price bands: up to date (latest file: bands from %s).'
                % (date.fromisoformat(cur).strftime('%d-%m-%Y') if cur else '-'))
    except Exception as e:   # never let price bands stop the screener work
        log('Price bands: unexpected problem - %s' % e)


# ------------------------------------------------------ NSE end-of-day: delivery %, 52-week highs, market stats
# Three NSE files of each trading day (NSE > All Reports > Equities, published in the evening):
#   sec_bhavdata_full_DDMMYYYY.csv  - "Full Bhavcopy and Security Deliverable data": only the Delivery %
#                                     (DELIV_PER) is kept per stock; prices are used just for the counts;
#   CM_52_wk_High_low_DDMMYYYY.csv  - "52 Week High Low Report": the (adjusted) 52-week high and its date;
#   sec_list_DDMMYYYY.csv           - "CM - Price Band complete list": each stock's band, to count circuits.
# DDMMYYYY = the trading day. Counts cover mainboard equities only (series EQ / BE / BZ): stocks
# traded, advances, declines, unchanged, at a new 52-week high, at the upper / lower price band.
EOD_FILES = {
    'bhav': ('https://nsearchives.nseindia.com/products/content/sec_bhavdata_full_{d}.csv',
             'https://archives.nseindia.com/products/content/sec_bhavdata_full_{d}.csv'),
    'w52': ('https://nsearchives.nseindia.com/content/CM_52_wk_High_low_{d}.csv',
            'https://archives.nseindia.com/content/CM_52_wk_High_low_{d}.csv'),
    'bands': ('https://nsearchives.nseindia.com/content/equities/sec_list_{d}.csv',
              'https://archives.nseindia.com/content/equities/sec_list_{d}.csv'),
}
EOD_LINK_RE = {'bhav': r'sec_bhavdata_full_', 'w52': r'CM_52_wk_High_low_', 'bands': r'sec_list_'}
EOD_SERIES = ('EQ', 'BE', 'BZ')     # mainboard equities (SME and other series are left out)
EOD_LOOKBACK_DAYS = 7
EOD_STATE_VERSION = 2       # 1 counted new 52-week highs from the report's date alone: a v1 state re-sends the last week once
EOD_STATE_PATH = os.path.join(HERE, 'eod_state.json')
_MONTHS3 = ('JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC')


def _csv_rows(raw):
    """CSV bytes -> rows of stripped cells, or None when NSE sent a web page instead."""
    text = raw.decode('utf-8-sig', errors='replace')
    if '<html' in text[:600].lower():
        return None
    return [[c.strip() for c in row] for row in csv.reader(io.StringIO(text))]


def _header(rows, need, look=12):
    """(row index, {name: column}) of the first row holding every normalised name in `need`
    (a name maps to a test function on the normalised header cell)."""
    for i, row in enumerate(rows[:look]):
        h = [_pb_norm(c) for c in row]
        cols = {}
        for name, test in need.items():
            j = next((k for k, c in enumerate(h) if test(c)), -1)
            if j < 0:
                break
            cols[name] = j
        else:
            return i, cols
    return -1, None


def _fnum(v):
    try:
        return float(str(v).replace(',', '').strip())
    except ValueError:
        return None


def eod_date(v):
    """'06-JAN-2026' / '06-Jan-26' / '06-01-2026' / '2026-01-06' -> date, else None."""
    s = str(v or '').strip().upper()
    m = re.match(r'^(\d{1,2})[-/ ]([A-Z]{3})[A-Z]*[-/ ](\d{2}|\d{4})$', s)
    try:
        if m and m.group(2) in _MONTHS3:
            y = int(m.group(3))
            return date(y + 2000 if y < 100 else y, _MONTHS3.index(m.group(2)) + 1, int(m.group(1)))
        m = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})$', s)
        if m:
            return date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', s)
        if m:
            return date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
    except ValueError:
        return None
    return None


def bhav_parse(raw):
    """Full bhavcopy -> [{sym, series, prev, close, last, qty, high, deliv}] (deliv = Delivery %, None when NSE gives '-')."""
    rows = _csv_rows(raw)
    if rows is None:
        return None
    i, c = _header(rows, {'sym': lambda h: h == 'SYMBOL', 'series': lambda h: h == 'SERIES',
                          'prev': lambda h: h == 'PREVCLOSE', 'close': lambda h: h == 'CLOSEPRICE',
                          'deliv': lambda h: h == 'DELIVPER'})
    if i < 0:
        return None
    h = [_pb_norm(x) for x in rows[i]]
    last_j = h.index('LASTPRICE') if 'LASTPRICE' in h else -1
    high_j = h.index('HIGHPRICE') if 'HIGHPRICE' in h else -1
    qty_j = h.index('TTLTRDQNTY') if 'TTLTRDQNTY' in h else -1
    out = []
    for r in rows[i + 1:]:
        if len(r) <= max(c.values()) or not r[c['sym']]:
            continue
        g = lambda j: r[j] if 0 <= j < len(r) else ''
        out.append({'sym': r[c['sym']].upper(), 'series': r[c['series']].upper(), 'prev': _fnum(r[c['prev']]),
                    'close': _fnum(r[c['close']]), 'last': _fnum(g(last_j)), 'qty': _fnum(g(qty_j)),
                    'high': _fnum(g(high_j)), 'deliv': _fnum(r[c['deliv']])})
    return out


def w52_parse(raw):
    """52 Week High Low report -> {(sym, series): (adjusted 52-week high, its date)} (the lows are not kept)."""
    rows = _csv_rows(raw)
    if rows is None:
        return None
    i, c = _header(rows, {'sym': lambda h: h == 'SYMBOL', 'series': lambda h: h == 'SERIES',
                          'high': lambda h: '52WEEKHIGH' in h and not h.endswith('DT') and 'DATE' not in h,
                          'date': lambda h: '52WEEKHIGH' in h and (h.endswith('DT') or 'DATE' in h)})
    if i < 0:
        return None
    out = {}
    for r in rows[i + 1:]:
        if len(r) <= max(c.values()) or not r[c['sym']]:
            continue
        hi, d = _fnum(r[c['high']]), eod_date(r[c['date']])
        if hi is not None:
            out[(r[c['sym']].upper(), r[c['series']].upper())] = (hi, d)
    return out


def bands_parse(raw):
    """Price band complete list -> {(sym, series): band % (None = no band, e.g. F&O stocks)}."""
    rows = _csv_rows(raw)
    if rows is None:
        return None
    i, c = _header(rows, {'sym': lambda h: h == 'SYMBOL', 'series': lambda h: h == 'SERIES', 'band': lambda h: h == 'BAND'})
    if i < 0:
        return None
    return {(r[c['sym']].upper(), r[c['series']].upper()): _fnum(r[c['band']])
            for r in rows[i + 1:] if len(r) > max(c.values()) and r[c['sym']]}


def _at_band(price, prev, band):
    """'upper' / 'lower' when the last price sits on the band (one tick of rounding allowed), else None."""
    if not band or not prev or price is None:
        return None
    pct = (price / prev - 1) * 100
    tick = 0.01 if prev < 250 else 0.05
    tol = max(0.1, 100 * tick / prev)
    if pct >= band - tol:
        return 'upper'
    if pct <= -(band - tol):
        return 'lower'
    return None


def eod_summary(day, bhav, w52, bands):
    """The day's payload for the sheet: counts, Delivery % (EQ series) and each stock's 52-week high."""
    mb = [r for r in bhav if r['series'] in EOD_SERIES and r['prev'] and r['close'] is not None and (r['qty'] is None or r['qty'] > 0)]
    adv = sum(1 for r in mb if r['close'] > r['prev'])
    dec = sum(1 for r in mb if r['close'] < r['prev'])
    stats = {'traded': len(mb), 'advances': adv, 'declines': dec, 'unchanged': len(mb) - adv - dec,
             'high52': None, 'upper': None, 'lower': None}
    if bands is not None:
        hits = [_at_band(r['last'] if r['last'] is not None else r['close'], r['prev'], bands.get((r['sym'], r['series']))) for r in mb]
        stats['upper'], stats['lower'] = hits.count('upper'), hits.count('lower')
    closes = {r['sym']: r['close'] for r in mb}
    day_high = {(r['sym'], r['series']): r['high'] for r in mb if r['high'] is not None}
    highs = []
    if w52 is not None:
        # NSE's report "effective for" a day can still hold the highs up to the day before, so a new
        # 52-week high is the day's own high (bhavcopy) reaching the report's 52-week high.
        seen, new = set(), 0
        for (sym, ser), (hi, d) in sorted(w52.items()):
            if ser not in EOD_SERIES or sym in seen:
                continue
            seen.add(sym)
            h = day_high.get((sym, ser))
            if h is not None and h >= hi:
                hi, d = h, day
            new += d == day
            highs.append([sym, hi, d.isoformat() if d else None, closes.get(sym)])
        stats['high52'] = new
    deliv = {r['sym']: round(r['deliv'], 2) for r in bhav if r['series'] == 'EQ' and r['deliv'] is not None}
    return {'tradeDate': day.isoformat(), 'stats': stats, 'delivery': deliv, 'high52': highs,
            'files': {'bhav': True, 'w52': w52 is not None, 'bands': bands is not None}}


def eod_fetch(opener, kind, day, url=None):
    """('ok', parsed) | ('missing', None) | ('error', reason) - like pb_fetch, for one of EOD_FILES."""
    parse = {'bhav': bhav_parse, 'w52': w52_parse, 'bands': bands_parse}[kind]
    tag = day.strftime('%d%m%Y')
    outcomes = []
    for u in ([url] if url else [t.format(d=tag) for t in EOD_FILES[kind]]):
        try:
            status, raw = nse_get(opener, u, timeout=60)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            outcomes.append('NSE did not answer (%s)' % e)
            continue
        if status == 404:
            outcomes.append('missing')
            continue
        if status != 200:
            outcomes.append('HTTP %s from NSE' % status)
            continue
        val = parse(raw)
        if val is None:
            outcomes.append('NSE did not send the CSV file (a web page came back instead)')
            continue
        return 'ok', val
    if outcomes and (outcomes[0] == 'missing' or all(o == 'missing' for o in outcomes)):
        return 'missing', None
    return 'error', next((o for o in outcomes if o != 'missing'), 'nothing tried')


def eod_links_from_api(opener, kind):
    """{date: url} of one kind of file listed on NSE's All Reports page - in case the address changes."""
    try:
        status, raw = nse_get(opener, PB_REPORTS_API, timeout=30)
    except (OSError, urllib.error.URLError, socket.timeout):
        return {}
    if status != 200:
        return {}
    out = {}
    rx = r'(https?:\\?/\\?/[^"\s]+?' + EOD_LINK_RE[kind] + r'(\d{2})(\d{2})(\d{4})\.csv)'
    for m in re.finditer(rx, raw.decode('utf-8', errors='replace')):
        try:
            out[date(int(m.group(4)), int(m.group(3)), int(m.group(2)))] = m.group(1).replace('\\/', '/')
        except ValueError:
            pass
    return out


def eod_load_state():
    try:
        with open(EOD_STATE_PATH, 'r', encoding='utf-8') as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def eod_save_state(st):
    try:
        with open(EOD_STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(st, f, indent=2)
    except OSError as e:
        log('NSE end-of-day: could not save %s (%s)' % (EOD_STATE_PATH, e))


def eod_days_to_check(today, last):
    """Trading days (weekdays) after the last one the sheet received, up to today, at most a week back."""
    start = today - timedelta(days=EOD_LOOKBACK_DAYS)
    if last:
        start = max(start, last + timedelta(days=1))
    days, d = [], start
    while d <= today:
        if d.weekday() < 5:
            days.append(d)
        d += timedelta(days=1)
    return days


def eod_step(cfg, today=None):
    """Downloads each trading day's files the sheet has not had yet and hands them over (action 'eod'). Never raises."""
    if not cfg.get('eod', True):
        return
    try:
        st = eod_load_state()
        today = today or date.today()
        last = None
        try:
            last = date.fromisoformat(st['last']) if st.get('last') and st.get('v') == EOD_STATE_VERSION else None
        except ValueError:
            last = None
        days = eod_days_to_check(today, last)
        if not days:
            log('NSE end-of-day: up to date (latest day sent: %s).' % (last.strftime('%d-%m-%Y') if last else '-'))
            return
        opener = nse_session()
        api_links = None
        sent, problems, today_missing = 0, [], False
        for d in days:
            kind, bhav = eod_fetch(opener, 'bhav', d)
            if kind != 'ok':
                if api_links is None:
                    api_links = {k: eod_links_from_api(opener, k) for k in EOD_FILES}
                if d in api_links['bhav']:
                    kind, bhav = eod_fetch(opener, 'bhav', d, url=api_links['bhav'][d])
            if kind == 'missing':
                today_missing = today_missing or d == today
                continue                     # a holiday, or not published yet
            if kind == 'error':
                problems.append('%s: %s' % (d.strftime('%d-%m-%Y'), bhav))
                continue
            extra = {}
            for k in ('w52', 'bands'):
                time.sleep(1.0)
                kk, val = eod_fetch(opener, k, d)
                if kk != 'ok':
                    if api_links is None:
                        api_links = {x: eod_links_from_api(opener, x) for x in EOD_FILES}
                    if d in api_links[k]:
                        kk, val = eod_fetch(opener, k, d, url=api_links[k][d])
                extra[k] = val if kk == 'ok' else None
            payload = eod_summary(d, bhav, extra['w52'], extra['bands'])
            label = d.strftime('%d-%m-%Y')
            try:
                res = api(cfg, 'eod', payload, timeout=180)
            except RuntimeError as e:
                log('NSE end-of-day %s: sending to the sheet failed (%s) - the next run tries again.' % (label, e))
                return
            if not res.get('ok'):
                err = res.get('error') or 'unknown error'
                if err == 'unknown action':
                    err = ('the sheet\'s web app does not know this yet - after pasting the new Code.gs: Deploy > '
                           'Manage deployments > pencil > Version: New version > Deploy')
                log('NSE end-of-day %s: the sheet refused - %s' % (label, err))
                return
            s = payload['stats']
            missing = [n for n, k in (('52-week report', 'w52'), ('price band list', 'bands')) if not payload['files'][k]]
            log('NSE end-of-day %s: %d stocks traded, %d up / %d down / %d unchanged, %s at a 52-week high, '
                'circuits %s up / %s down; Delivery %% for %d in Main%s.'
                % (label, s['traded'], s['advances'], s['declines'], s['unchanged'],
                   '-' if s['high52'] is None else s['high52'], '-' if s['upper'] is None else s['upper'],
                   '-' if s['lower'] is None else s['lower'], res.get('deliveryInMain', 0),
                   ('; not downloaded: ' + ', '.join(missing)) if missing else ''))
            st['v'] = EOD_STATE_VERSION
            st['last'] = d.isoformat()
            st['last_sent_at'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            eod_save_state(st)
            sent += 1
            time.sleep(1.0)
        if problems and not sent:
            log('NSE end-of-day: could not download the bhavcopy - %s.' % '; '.join(problems[-2:]))
        elif today_missing and not sent:
            log('NSE end-of-day: today\'s files (NSE publishes them in the evening) are not out yet - the next run tries again.')
        elif not sent:
            log('NSE end-of-day: up to date (latest day sent: %s).' % (date.fromisoformat(st['last']).strftime('%d-%m-%Y') if st.get('last') else '-'))
    except Exception as e:   # never let these reports stop the screener work
        log('NSE end-of-day: unexpected problem - %s' % e)


# ------------------------------------------------------------------ NSE IPO lists
# NSE > Market Data > IPO (the page below): Current, Past Issues and Upcoming Issues. The page
# fills its tables from NSE's own data addresses; this reads the same data. The sheet (doPost
# 'ipos') sorts the issues into Open now / Closed - awaiting listing / Upcoming, leaves SME
# issues out, rebuilds the "IPO Tracker" tab and sends one email a day.
IPO_PAGE = 'https://www.nseindia.com/market-data/all-upcoming-issues-ipo'
IPO_SOURCES = (
    ('current', ('https://www.nseindia.com/api/ipo-current-issue',)),
    ('past', ('https://www.nseindia.com/api/public-past-issues?from_date={f}&to_date={t}&security_type=all',
              'https://www.nseindia.com/api/public-past-issues?from_date={f}&to_date={t}',
              'https://www.nseindia.com/api/public-past-issues')),
    ('upcoming', ('https://www.nseindia.com/api/all-upcoming-issues?category=ipo',)),
)
IPO_PAST_DAYS = 30       # past issues closed in the last 30 days (older ones are listed long ago)
IPO_FIELDS = (           # our name <- NSE field names (compared without case / punctuation)
    ('company', ('companyname', 'company', 'name', 'issuername', 'securityname')),
    ('symbol', ('symbol',)),
    ('type', ('securitytype', 'series', 'issuetype', 'type', 'segment')),
    ('start', ('issuestartdate', 'startdate', 'bidstartdate', 'issueopendate', 'opendate', 'ipostartdate')),
    ('end', ('issueenddate', 'enddate', 'bidenddate', 'issueclosedate', 'closedate', 'ipoenddate')),
    ('listing', ('listingdate', 'dateoflisting', 'listingon')),
    ('price', ('pricerange', 'priceband', 'issueprice', 'price')),
    ('size', ('issuesize', 'totalissuesize', 'size')),
)
_MONTHS = {m: i + 1 for i, m in enumerate(('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'))}


def _norm_key(k):
    return re.sub(r'[^a-z0-9]', '', str(k).lower())


def ipo_date(v):
    """NSE date text (27-Oct-2026, 27-OCT-2026, 2026-10-27, 27-10-2026, Oct 27, 2026 ...) -> 'yyyy-mm-dd' or ''."""
    t = str(v or '').strip()
    m = re.match(r'^(\d{4})-(\d{2})-(\d{2})', t)
    if m:
        y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
    else:
        m = re.match(r'^(\d{1,2})[-/ ]([A-Za-z]{3,})[-/ ,]+(\d{4})', t)
        if m:
            y, mo, d = int(m.group(3)), _MONTHS.get(m.group(2)[:3].lower(), 0), int(m.group(1))
        else:
            m = re.match(r'^([A-Za-z]{3,})\s+(\d{1,2}),?\s+(\d{4})', t)
            if m:
                y, mo, d = int(m.group(3)), _MONTHS.get(m.group(1)[:3].lower(), 0), int(m.group(2))
            else:
                m = re.match(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})', t)
                if not m:
                    return ''
                y, mo, d = int(m.group(3)), int(m.group(2)), int(m.group(1))
    try:
        return date(y, mo, d).isoformat()
    except ValueError:
        return ''


def ipo_records(obj):
    """The list of issues in NSE's answer (the answer itself, or under a key such as 'data'), or None."""
    if isinstance(obj, list):
        if not obj or all(isinstance(x, dict) for x in obj[:5]):
            return obj
        return None
    if isinstance(obj, dict):
        keys = [k for k in ('data', 'rows', 'records', 'result') if k in obj] + [k for k in obj if k not in ('data', 'rows', 'records', 'result')]
        for k in keys:
            if isinstance(obj[k], (list, dict)):
                r = ipo_records(obj[k])
                if r is not None and (r or k in ('data', 'rows', 'records', 'result')):
                    return r
    return None


def ipo_normalize(rec, which):
    nk = {_norm_key(k): v for k, v in rec.items()}
    out = {'list': which}
    for field, names in IPO_FIELDS:
        val = ''
        for n in names:
            v = nk.get(n)
            if v is None or isinstance(v, (dict, list)):
                continue
            v = str(v).strip()
            if v and v not in ('-', 'null', 'None', 'NA', 'N/A'):
                val = v
                break
        out[field] = val
    for f in ('start', 'end', 'listing'):
        out[f] = ipo_date(out[f])
    if not out['type'] and str(nk.get('issme', '')).strip().lower() in ('true', 'y', 'yes', '1'):
        out['type'] = 'SME'
    return out


def ipo_is_sme(t):
    t = str(t or '').strip().upper()
    return 'SME' in t or 'EMERGE' in t or t in ('SM', 'ST')


def ipo_kind(r):
    """'main' (equity mainboard), 'sme' or 'other' (debt NCDs / bonds, units...) - the sheet's ab_ipotKind_ rule."""
    t = str(r.get('type') or '').strip()
    if ipo_is_sme(t):
        return 'sme'
    if t:
        return 'main' if re.match(r'^(EQ|EQUITY|MAIN ?BOARD)$', t, re.I) else 'other'
    return 'other' if re.search(r'\d{2}$', r.get('symbol') or '') and not re.search(r' to ', r.get('price') or '', re.I) else 'main'


def ipo_fetch_list(opener, which, urls, today):
    """-> (records, None, field names) or (None, reason, [])."""
    f, t = (today - timedelta(days=IPO_PAST_DAYS)).strftime('%d-%m-%Y'), today.strftime('%d-%m-%Y')
    last = 'nothing tried'
    for u in urls:
        try:
            status, raw = nse_get(opener, u.format(f=f, t=t), referer=IPO_PAGE)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            last = 'NSE did not answer (%s)' % e
            continue
        if status != 200:
            last = 'HTTP %s from NSE' % status
            continue
        try:
            obj = json.loads(raw.decode('utf-8', errors='replace'))
        except ValueError:
            last = 'NSE did not send data (a web page came back instead)'
            continue
        recs = ipo_records(obj)
        if recs is None:
            last = 'NSE\'s answer had no list of issues'
            continue
        return [ipo_normalize(r, which) for r in recs], None, (sorted(recs[0].keys()) if recs else [])
    return None, last, []


def ipo_session():
    opener = nse_session()
    try:
        nse_get(opener, IPO_PAGE, referer='https://www.nseindia.com/', timeout=20)
    except (OSError, urllib.error.URLError, socket.timeout):
        pass
    return opener


def ipo_step(cfg, today=None):
    """Reads NSE's three IPO lists and hands them to the sheet. Never raises."""
    if not cfg.get('ipos', True):
        return
    try:
        today = today or date.today()
        opener = ipo_session()
        records, failed, notes = [], [], []
        for i, (which, urls) in enumerate(IPO_SOURCES):
            recs, err, _ = ipo_fetch_list(opener, which, urls, today)
            if recs is None:
                failed.append(which)
                notes.append('%s: %s' % (which, err))
            else:
                # issues that listed before today are of no interest
                records.extend(r for r in recs if not (r['listing'] and r['listing'] < today.isoformat()))
            if i < len(IPO_SOURCES) - 1:
                time.sleep(1.0)
        if len(failed) == len(IPO_SOURCES):
            log('IPO lists: could not read NSE - %s' % '; '.join(notes))
            return
        payload = {'fetchedAt': datetime.now().strftime('%Y-%m-%d %H:%M'), 'failed': failed, 'records': records}
        try:
            res = api(cfg, 'ipos', payload, timeout=180)
        except RuntimeError as e:
            log('IPO lists: sending to the sheet failed (%s) - the next run tries again.' % e)
            return
        if not res.get('ok'):
            err = res.get('error') or 'unknown error'
            if err == 'unknown action':
                err = ('the sheet\'s web app does not know the IPO lists yet - in Apps Script: Deploy > Manage deployments > '
                       'pencil > Version: New version > Deploy')
            log('IPO lists: the sheet refused - %s' % err)
            return
        log('IPO lists: %d open, %d closed - awaiting listing, %d upcoming (mainboard equity; %d SME and %d debt/other left out)%s.'
            % (res.get('open', 0), res.get('closed', 0), res.get('upcoming', 0), res.get('sme', 0), res.get('other', 0),
               ', email sent' if res.get('emailed') else ''))
        if failed:
            log('IPO lists: could not read %s this time - %s' % (', '.join(failed), '; '.join(notes)))
    except Exception as e:   # never let the IPO lists stop the screener work
        log('IPO lists: unexpected problem - %s' % e)


# ------------------------------------------------------------------ moneycontrol (reading)
# moneycontrol.com often shows a quarter's results before screener.in. The run's moneycontrol step
# (further down, mc_step) sends those figures for results screener.in does not show yet; TestConnection
# and MoneycontrolCheck.bat only CHECK that a stock can be found and read - they send nothing.
# moneycontrol has its own company codes (e.g. acutaaschemicals / AO05), found once per stock through
# its search box; the NSE symbol in the search answer confirms the match. Its results pages moved to a
# new design (the figures sit inside the page as __NEXT_DATA__ or come from its own data links), so
# several sources are tried; MoneycontrolCheck.bat shows which ones work and, when none does, prints
# where the figures seem to be and saves the pages in moneycontrol_check\ .
MC_HOME = 'https://www.moneycontrol.com/'
MC_SUGGEST = 'https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php?classic=true&query={q}&type=1&format=json'
_MC_WIDGET = 'https://www.moneycontrol.com/mc/widget/mcfinancials/getFinancialData?classic=true&referenceId=income&requestType={t}&scId={code}&frequency=3'
MC_SOURCES = (('consolidated widget', _MC_WIDGET.replace('{t}', 'C')),
              ('standalone widget', _MC_WIDGET.replace('{t}', 'S')),
              ('results page', 'https://www.moneycontrol.com/markets/financials/quarterly-results/{slug}-{code}/'),
              ('old consolidated page', 'https://www.moneycontrol.com/financials/{slug}/results/consolidated-quarterly-results/{code}/1'),
              ('old standalone page', 'https://www.moneycontrol.com/financials/{slug}/results/quarterly-results/{code}/1'))
MC_CHECK_DIR = os.path.join(HERE, 'moneycontrol_check')
MC_PAUSE = 0.8                     # seconds between two moneycontrol pages
MC_ROWS = (('revenue', ('net sales/income from operations', 'total income from operations', 'revenue from operations', 'net sales',
                        'total revenue', 'revenue', 'sales', 'income from operations', 'total income')),
           ('profit', ('net profit/(loss) for the period', 'net profit/(loss) after mi & associates', 'net profit after tax', 'net profit',
                       'profit after tax', 'pat', 'net income', 'profit/(loss) for the period')),
           ('eps', ('basic eps', 'eps', 'basic & diluted eps', 'earnings per share')))
_MON = ('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec')
_MON_RE = r'(Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec)[a-z]*\.?'
_Q_MY = re.compile(r"^" + _MON_RE + r"[\s'\-’,/]*(\d{2}|\d{4})$", re.I)                  # Sep 2026, Sep '26, Sep-26
_Q_DMY = re.compile(r"^(\d{1,2})[\s\-/]+" + _MON_RE + r"[\s\-/,'’]*(\d{2}|\d{4})$", re.I)   # 30-Sep-2026, 30 Sep 26
_Q_MDY = re.compile(r"^" + _MON_RE + r"\s+(\d{1,2}),?\s+(\d{4})$", re.I)                    # Sep 30, 2026
_Q_ISO = re.compile(r"^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ][\d:.]+Z?)?$")                    # 2026-09-30
_Q_YM = re.compile(r"^(20\d{2})(\d{2})$")                                                # 202609
_Q_FY = re.compile(r"^Q([1-4])\s*[-' ]?\s*FY\s*'?(\d{2}|\d{4})(?:\s*[-/]\s*(\d{2}|\d{4}))?$", re.I)   # Q2FY27, Q2 FY 2026-27
_LABEL_KEYS = ('name', 'label', 'heading', 'title', 'particulars', 'lineitem', 'displayname', 'head', 'metric', 'item',
               'rowname', 'field', 'key', 'text', 'description', 'desc')


def mc_session():
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
    try:
        mc_get(opener, MC_HOME, timeout=20)
    except (OSError, urllib.error.URLError, socket.timeout):
        pass
    return opener


def mc_get(opener, url, timeout=30, xhr=False):
    """Returns (status, text, final url after redirects). Network problems raise OSError/URLError."""
    headers = {'User-Agent': UA, 'Accept': 'text/html,application/json;q=0.9,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9',
               'Accept-Encoding': 'identity', 'Referer': MC_HOME}
    if xhr:
        headers['X-Requested-With'] = 'XMLHttpRequest'
    req = urllib.request.Request(url, headers=headers)
    try:
        with opener.open(req, timeout=timeout) as r:
            raw, status, final = r.read(), r.status, r.geturl()
    except urllib.error.HTTPError as e:
        return e.code, '', url
    if raw[:2] == b'\x1f\x8b':
        raw = gzip.decompress(raw)
    return status, raw.decode('utf-8', errors='replace'), final


def _strip_tags(t):
    return html_unescape(re.sub(r'\s+', ' ', re.sub(r'<[^>]+>', ' ', str(t or '')))).strip()


def mc_lookup(opener, sym):
    """NSE symbol -> {'code', 'slug', 'name', 'link'} or None, plus a note of what happened."""
    sym = sym.strip().upper()
    try:
        status, text, _ = mc_get(opener, MC_SUGGEST.format(q=urllib.parse.quote(sym)))
    except (OSError, urllib.error.URLError, socket.timeout) as e:
        return None, 'search did not answer (%s)' % e
    if status != 200:
        return None, 'search: HTTP %s' % status
    m = re.search(r'\[.*\]', text, re.S)         # plain JSON or wrapped as suggest1([...])
    try:
        items = json.loads(m.group(0)) if m else []
    except ValueError:
        return None, 'search answer was not readable (starts: %s)' % _strip_tags(text)[:80]
    found = []
    for it in items if isinstance(items, list) else []:
        if not isinstance(it, dict):
            continue
        link = str(it.get('link_src') or it.get('link') or '')
        lm = re.search(r'/stockpricequote/[^/]+/([^/]+)/([^/?#]+)', link)
        info = _strip_tags(it.get('pdt_dis_nm', '')) + ' ' + _strip_tags(it.get('stock_name', ''))
        codes = [c.strip().upper() for c in re.split(r'[,\s]+', info)]
        if lm:
            found.append((sym in codes, {'code': lm.group(2), 'slug': lm.group(1), 'name': _strip_tags(it.get('stock_name', '')) or lm.group(1), 'link': link, 'info': info}))
    exact = [f[1] for f in found if f[0]]
    if exact:
        return exact[0], 'found by NSE symbol'
    if found:
        return None, '%d match(es), none listed with NSE symbol %s (first: %s)' % (len(found), sym, found[0][1]['info'][:80])
    return None, 'no match on moneycontrol'


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


def _yr(s):
    y = int(s)
    return y + 2000 if y < 100 else y


def _qlabel(t, strict=False):
    """A quarter written in any common way ('Sep '26', 'Q2FY27', '2026-09-30', ...) -> 'Sep 2026', else None.
    strict = quarter-end months only (always so for full dates)."""
    if not isinstance(t, str):
        return None
    t = t.strip()
    if not t or len(t) > 30:
        return None
    r = _Q_MY.match(t)
    if r:
        m, y = _MON.index(r.group(1)[:3].lower()) + 1, _yr(r.group(2))
    elif _Q_FY.match(t):
        r = _Q_FY.match(t)
        q, end = int(r.group(1)), _yr(r.group(3) or r.group(2))
        y, m = (end, 3) if q == 4 else (end - 1, 3 + 3 * q)
    else:
        strict = True
        r = _Q_DMY.match(t)
        if r:
            m, y = _MON.index(r.group(2)[:3].lower()) + 1, _yr(r.group(3))
        elif _Q_MDY.match(t):
            r = _Q_MDY.match(t)
            m, y = _MON.index(r.group(1)[:3].lower()) + 1, int(r.group(3))
        elif _Q_ISO.match(t):
            r = _Q_ISO.match(t)
            y, m = int(r.group(1)), int(r.group(2))
        elif _Q_YM.match(t):
            r = _Q_YM.match(t)
            y, m = int(r.group(1)), int(r.group(2))
        else:
            return None
    if not (1 <= m <= 12 and 2000 <= y <= 2100) or (strict and m not in (3, 6, 9, 12)):
        return None
    return '%s %d' % (_MON[m - 1].title(), y)


def _qkey(label):
    mon, y = label.split()
    return int(y), _MON.index(mon.lower()) + 1


def _qshift(label, back):
    """'Sep 2026' moved back by `back` months ('Jun 2026' for 3, 'Sep 2025' for 12)."""
    y, m = _qkey(label)
    n = y * 12 + m - 1 - back
    return '%s %d' % (_MON[n % 12].title(), n // 12)


def _num(t):
    if isinstance(t, bool) or t is None:
        return None
    if isinstance(t, (int, float)):
        return float(t)
    t = re.sub(r'(?i)rs\.?|₹|crores?|cr\.?', '', str(t)).replace(',', '').strip()
    neg = t.startswith('(') and t.endswith(')')
    if neg:
        t = t[1:-1].strip()
    if not re.match(r'^[-+]?\d+(\.\d+)?$', t):
        return None
    return -float(t) if neg else float(t)


def _rowkey(label):
    """A row name ('Net Sales/Income from operations') -> ('revenue', rank) - lower rank = better name; else None."""
    t = re.sub(r'\s+', ' ', str(label or '')).strip().lower().rstrip(':').strip()
    if not t or len(t) > 80 or re.search(r'\bgrowth|margin|%|\byoy\b|\bqoq\b|\bchange|\bratio', t):
        return None
    best = None
    for key, names in MC_ROWS:
        for i, n in enumerate(names):
            r = i if t == n else (100 + i if t.startswith(n) else None)
            if r is not None and (best is None or r < best[1]):
                best = (key, r)
    return best


def _fieldkey(k):
    """A data field name ('netSales', 'net_profit', 'basicEps') -> ('revenue', rank), else None."""
    nk = re.sub(r'[^a-z0-9]', '', str(k).lower())
    if not nk or len(nk) > 40 or re.search(r'margin|growth|pct|percent|yoy|qoq|change|chg|ratio(?!n)|rank|count|date(?!d)|year|time', nk):
        return None
    if 'eps' in nk:
        return ('eps', 0 if nk in ('eps', 'basiceps') else 1)
    if not re.search(r'gross|operat|before|pbt|ebit|exceptional|minority|associat|expense|other', nk):
        for i, n in enumerate(('netprofit', 'profitaftertax', 'pat', 'netincome', 'profit')):
            if nk == n or (len(n) > 3 and n in nk):
                return ('profit', i)
    if not re.search(r'other|expense|cost|tax', nk):
        for i, n in enumerate(('netsales', 'revenuefromoperations', 'revenue', 'totalrevenue', 'sales', 'incomefromoperations', 'totalincome', 'income')):
            if nk == n or (len(n) > 4 and n in nk):
                return ('revenue', i)
    return None


def _offer(best, rk, series, label, where=''):
    """Keep, per figure, the series with the best row name (then the longest)."""
    if not rk or not series:
        return
    key, rank = rk
    cur = best.get(key)
    if cur is None or (rank, -len(series)) < (cur[0], -len(cur[1])):
        best[key] = (rank, series, label, where)


def _mc_result(best, labels, how):
    if 'revenue' not in best and 'profit' not in best:
        return None
    out = {'labels': labels, 'how': how, 'where': sorted(set(b[3] for b in best.values() if b[3]))}
    qs = set()
    for key in ('revenue', 'profit', 'eps'):
        out[key] = best[key][1] if key in best else {}
        qs |= set(out[key])
    out['quarters'] = sorted(qs, key=_qkey, reverse=True)
    return out


def _table_result(tb):
    """One table -> ({figure: (rank, {quarter: value}, row name, '')}, row names) for quarters across or down; else None."""
    for i, row in enumerate(tb[:6]):                                  # quarters across (the usual layout)
        qs = [(j, _qlabel(c)) for j, c in enumerate(row)]
        qs = [x for x in qs if x[1]]
        if len(qs) >= 2:
            best = {}
            for r in tb[i + 1:]:
                if not r:
                    continue
                shift = len(r) - len(row)                            # rows may lack the header's first cell
                series = {}
                for j, q in qs:
                    v = _num(r[j + shift]) if 0 <= j + shift < len(r) else None
                    if v is not None:
                        series[q] = v
                _offer(best, _rowkey(r[0]), series, r[0])
            return best, [r[0] for r in tb[i + 1:] if r and r[0]]
    down = [(i, _qlabel(r[0])) for i, r in enumerate(tb) if r]          # quarters down the first column
    down = [x for x in down if x[1]]
    if len(down) >= 2 and down[0][0] > 0:
        head, best = tb[down[0][0] - 1], {}
        for j, name in enumerate(head):
            series = {}
            for i, q in down:
                k = j + len(tb[i]) - len(head)
                v = _num(tb[i][k]) if 0 < k < len(tb[i]) else None
                if v is not None:
                    series[q] = v
            _offer(best, _rowkey(name), series, name)
        return best, [h for h in head if h]
    return None


def mc_parse(html):
    """A results table in the page -> {'quarters': ['Sep 2026', ...] newest first, 'revenue' / 'profit' / 'eps': {quarter: value},
    'labels': row names, 'how', 'where'}, or None; plus the row names seen (for the test printout)."""
    p = _Tables()
    try:
        p.feed(html)
    except Exception:          # malformed page: use what was read
        pass
    labels_seen = []
    for tb in p.tables:
        labels_seen += [r[0] for r in tb if r and r[0]][:15]
        got = _table_result(tb)
        res = got and _mc_result(got[0], got[1], 'table')
        if res:
            return res, labels_seen
    return None, labels_seen


def _next_data(html):
    m = re.search(r'<script[^>]*id=["\']__NEXT_DATA__["\'][^>]*>(.*?)</script>', html, re.S | re.I)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except ValueError:
        return None


def _item_quarter(d):
    """The quarter an item of figures is for: {'quarter': "Sep '26", ...} -> ('Sep 2026', 'quarter')."""
    keys = sorted(d, key=lambda k: 0 if re.search(r'quarter|period|qtr', str(k), re.I) else 1)
    for k in keys:
        q = _qlabel(d[k], True)
        if q:
            return q, k
    return None, None


def _item_value(d, qkey):
    for k in ('value', 'val', 'amount', 'v', 'y', 'data', 'figure'):
        if k in d and _num(d[k]) is not None:
            return _num(d[k])
    nums = [_num(v) for k, v in d.items() if k != qkey and _num(v) is not None]
    return nums[0] if len(nums) == 1 else None


def _series_from(vals, heads):
    """Figures of one row -> {quarter: value}: [{quarter, value}, ...] / {quarter: value} / numbers under quarter headings."""
    out = {}
    if isinstance(vals, dict):
        for k, v in vals.items():
            q, n = _qlabel(k, True), _num(v)
            if q and n is not None:
                out[q] = n
    elif isinstance(vals, list) and vals:
        if all(isinstance(x, dict) for x in vals):
            for x in vals:
                q, qk = _item_quarter(x)
                n = _item_value(x, qk) if q else None
                if q and n is not None:
                    out[q] = n
        elif heads:
            qh = [h for h in heads if h]
            pairs = zip(heads, vals) if len(vals) == len(heads) else zip(qh, vals) if len(vals) == len(qh) else ()
            for q, v in pairs:
                n = _num(v)
                if q and n is not None:
                    out[q] = n
    return out


_MC_RANKED = re.compile(r'best|worst|top_?\d|bottom', re.I)


def mc_from_json(data):
    """Quarterly figures from the page's own data (__NEXT_DATA__), whatever its layout: lists of {quarter, netSales, ...},
    named rows ({name: 'Net Sales', values: [...]}) under quarter headings, {'Sep 2026': {...}}, or HTML tables inside it.
    -> same result as mc_parse (how = 'page data', where = the data path) or None."""
    groups, count, tables = {}, [0], []

    def offer(where, rk, series, label):
        if rk and len(series) >= 2:
            _offer(groups.setdefault(where, {}), rk, series, label, where)

    def records(where, recs):
        fields = {}
        for q, d in recs:
            flat = dict(d)
            for k, v in d.items():
                if isinstance(v, dict):
                    flat.update(v)
            for k, v in flat.items():
                n = _num(v)
                if n is not None:
                    fields.setdefault(k, {})[q] = n
        for k, series in fields.items():
            offer(where, _fieldkey(k), series, k)

    def walk(node, path, heads, depth):
        count[0] += 1
        if depth > 40 or count[0] > 300000:
            return
        if isinstance(node, dict):
            # "best / worst quarters" boxes rank quarters by profit - not a quarterly series
            node = {k: v for k, v in node.items() if not _MC_RANKED.search(str(k))}
            h = heads
            for v in node.values():
                if isinstance(v, list) and len(v) >= 2 and all(isinstance(x, str) for x in v):
                    ql = [_qlabel(x, True) for x in v]
                    if sum(1 for q in ql if q) >= max(2, len(v) - 1):
                        h = ql
            parent = re.sub(r'\[\d+\]$', '', path)
            for k, v in node.items():
                if isinstance(v, str) and str(k).lower() in _LABEL_KEYS and _rowkey(v):
                    for v2 in node.values():
                        if isinstance(v2, (list, dict)):
                            offer(parent, _rowkey(v), _series_from(v2, h), v)
                    break
            qkeys = [k for k in node if _qlabel(k, True)]
            if len(qkeys) >= 2:
                records(path, [(_qlabel(k, True), node[k]) for k in qkeys if isinstance(node[k], dict)])
            for k, v in node.items():
                if isinstance(v, (list, dict)):
                    rk = _fieldkey(k) or _rowkey(k)
                    if rk:
                        offer(path, rk, _series_from(v, h), k)
                    walk(v, '%s.%s' % (path, k) if path else str(k), h, depth + 1)
                elif isinstance(v, str) and '<table' in v and len(tables) < 20:
                    tables.append(v)
        elif isinstance(node, list):
            recs = []
            for x in node:
                if isinstance(x, dict):
                    q, _ = _item_quarter(x)
                    if q:
                        recs.append((q, x))
            if len(recs) >= 2:
                records(path, recs)
            for i, x in enumerate(node):
                if isinstance(x, list) and len(x) >= 3 and isinstance(x[0], str) and heads and _rowkey(x[0]):
                    offer(path, _rowkey(x[0]), _series_from(x[1:], heads[1:] if len(heads) == len(x) else heads), x[0])
                if isinstance(x, (dict, list)):
                    walk(x, '%s[%d]' % (path, i), heads, depth + 1)
                elif isinstance(x, str) and '<table' in x and len(tables) < 20:
                    tables.append(x)

    walk(data, '', None, 0)
    best, score = None, -1
    for where, g in groups.items():
        s = (100 if 'revenue' in g else 0) + (100 if 'profit' in g else 0) + (30 if 'eps' in g else 0) + \
            max(len(b[1]) for b in g.values()) + (5 if 'consol' in where.lower() else 0)
        if s > score:
            best, score = g, s
    res = _mc_result(best, [b[2] for b in best.values()], 'page data') if best else None
    if res:
        return res
    for t in tables:
        res, _ = mc_parse(t)
        if res:
            res['how'] = 'table inside the page data'
            return res
    return None


def mc_json_map(data, limit=8):
    """Test printout when nothing could be read: where the page data mentions quarters or result row names."""
    hits, names = [], []

    def walk(node, path, depth):
        if depth > 40 or len(hits) + len(names) > 400:
            return
        if isinstance(node, dict):
            qk = sum(1 for k in node if _qlabel(k, True))
            if qk >= 2:
                hits.append((qk, path, 'keys: ' + ', '.join(str(k) for k in list(node)[:6])))
            for k, v in node.items():
                p = '%s.%s' % (path, k) if path else str(k)
                if isinstance(v, str) and _rowkey(v):
                    names.append('%s = %s' % (p, v[:40]))
                elif isinstance(v, (dict, list)):
                    walk(v, p, depth + 1)
        elif isinstance(node, list):
            n = sum(1 for x in node if (isinstance(x, str) and _qlabel(x, True)) or (isinstance(x, dict) and _item_quarter(x)[0]))
            if n >= 2:
                first = node[0]
                sample = ('item keys: ' + ', '.join(str(k) for k in list(first)[:10])) if isinstance(first, dict) \
                    else ('items: ' + ', '.join(str(x)[:14] for x in node[:4]))
                hits.append((n, path, '%d items, %s' % (len(node), sample)))
            if sum(1 for x in node if isinstance(x, str) and _rowkey(x)) >= 2:
                names.append('%s = %s' % (path, ', '.join(str(x)[:20] for x in node[:5])))
            for i, x in enumerate(node[:60]):
                if isinstance(x, (dict, list)):
                    walk(x, '%s[%d]' % (path, i), depth + 1)

    walk(data, '', 0)
    hits.sort(key=lambda h: -h[0])
    out = ['quarters at %s  (%s)' % (p or '(top)', s) for _, p, s in hits[:limit]]
    return [x[:170] for x in out + ['row name at ' + n for n in names[:4]]]


def mc_api_hints(opener, html, page_url, data=None, limit=8):
    """Test printout: links in the page's own scripts (and page data) that look like where its results come from."""
    found = []

    def scan(text):
        quoted = r"""["'`]((?:https?:)?//[a-z0-9.-]*moneycontrol\.com/[^"'`\s<>]{3,200}|/[A-Za-z0-9_\-./]*(?:financ|quarter|result)[^"'`\s<>]{0,150})["'`]"""
        bare = r"""((?:https?:)?//api[a-z0-9.-]*\.moneycontrol\.com[^"'`\s<>]{0,200}|/mcapi/[^"'`\s<>]{3,150})"""
        for rx in (quoted, bare):
            for m in re.finditer(rx, text, re.I):
                u = m.group(1)
                if (re.search(r'financ|quarter|result|mcapi', u, re.I) and not re.search(r'\.(png|jpe?g|svg|gif|webp|css|woff2?|js)(\?|$)', u, re.I)
                        and not re.search(r'^/markets/|/news/', u) and u not in found):
                    found.append(u)

    srcs = re.findall(r'<script[^>]+src=["\']([^"\']+)["\']', html, re.I)
    srcs = sorted(set(srcs), key=lambda s: 0 if re.search(r'financ|quarter|result', s, re.I) else 1 if re.search(r'pages/|_app', s) else 2)
    for s in srcs[:6]:
        try:
            st, js, _ = mc_get(opener, urllib.parse.urljoin(page_url, s), timeout=20)
        except (OSError, urllib.error.URLError, socket.timeout):
            continue
        if st == 200:
            scan(js)
        if len(found) >= limit:
            break
    if data is not None and len(found) < limit:
        scan(json.dumps(data))
    return found[:limit]


def _mc_save(sym, name, text):
    try:
        os.makedirs(MC_CHECK_DIR, exist_ok=True)
        path = os.path.join(MC_CHECK_DIR, '%s_%s' % (re.sub(r'[^A-Za-z0-9&_-]', '_', sym), name))
        with open(path, 'w', encoding='utf-8') as f:
            f.write(text)
        return path
    except OSError:
        return None


def _growth(series, q, back):
    a, b = series.get(q), series.get(_qshift(q, back))
    if a is None or b in (None, 0):
        return None
    return (a / b - 1) * 100 * (1 if b > 0 else -1)


def _mc_show(res, out):
    q, rev, pr, eps = res['quarters'][0], res['revenue'], res['profit'], res['eps']
    fmt = _fmt
    pct = lambda v: '-' if v is None else '%+.0f%%' % v
    out('      latest %s: revenue %s (QoQ %s, YoY %s) | net profit %s (QoQ %s, YoY %s) | EPS %s'
        % (q, fmt(rev.get(q)), pct(_growth(rev, q, 3)), pct(_growth(rev, q, 12)),
           fmt(pr.get(q)), pct(_growth(pr, q, 3)), pct(_growth(pr, q, 12)), fmt(eps.get(q))))
    out('      read from: %s%s' % ('; '.join(str(x) for x in res['labels'][:8]),
                                   (' (at %s)' % ', '.join(res['where'])[:120]) if res.get('where') else ''))


def mc_check(sym, out=print, detail=True):
    """Test only: find the stock on moneycontrol and read its latest quarters from each source. Returns True when
    figures were read. detail=False (TestConnection) stops at the first source that works and saves nothing."""
    opener = mc_session()
    hit, note = mc_lookup(opener, sym)
    if not hit:
        out('   %s: PROBLEM - %s' % (sym, note))
        return False
    out('   %s: found %s (moneycontrol code %s / %s)' % (sym, hit['name'], hit['slug'], hit['code']))
    shown, seen_urls, pages, newest = False, {}, [], None
    for n, (kind, tmpl) in enumerate(MC_SOURCES):
        url = tmpl.format(slug=hit['slug'], code=hit['code'])
        if n:
            time.sleep(MC_PAUSE)
        try:
            status, text, final = mc_get(opener, url, xhr='widget' in kind)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            out('   %s: did not answer (%s)' % (kind, e))
            continue
        if status != 200:
            out('   %s: HTTP %s' % (kind, status))
            continue
        final = final.split('#')[0].rstrip('/')
        if final in seen_urls:
            out('   %s: opens the same page as the %s' % (kind, seen_urls[final]))
            continue
        seen_urls[final] = kind
        res, seen = mc_parse(text)
        nd = _next_data(text)
        if not res and nd is not None:
            res = mc_from_json(nd)
        pages.append((kind, text, nd, final))
        if res:
            out('   %s: OK (%s) - %s' % (kind, res['how'], ', '.join(res['quarters'][:5])))
            if detail or not shown:
                _mc_show(res, out)
            shown = True
            if not newest or _qkey(res['quarters'][0]) > _qkey(newest):
                newest = res['quarters'][0]
            if not detail:
                return True
            continue
        title = re.search(r'<title[^>]*>(.*?)</title>', text, re.S | re.I)
        out('   %s: %d KB%s - no quarterly figures found%s%s'
            % (kind, len(text) // 1024, (' "%s"' % _strip_tags(title.group(1))[:50]) if title else '',
               ('; rows seen: ' + '; '.join(seen[:6])) if seen else '', ' (page data present)' if nd is not None else ''))
    no_eps = False
    if detail and shown:
        # exactly what a run's moneycontrol step would send for this quarter
        try:
            item, note = mc_figures(opener, hit, newest, sym)
            out('   a run would send: %s' % (note if item else 'nothing - ' + note))
            no_eps = not item or item['eps'][-1] is None
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            out('   a run would send: nothing - moneycontrol did not answer (%s)' % e)
    if detail and no_eps and pages:
        for kind, text, nd, _ in pages:
            if nd is not None:
                _mc_save(sym, kind.replace(' ', '_') + '_data.json', json.dumps(nd, indent=1, ensure_ascii=False))
        out('   page data saved in %s (Claude may ask for it)' % MC_CHECK_DIR)
    if detail and not shown and pages:
        out('   nothing readable yet - where the figures may be (please send this to Claude):')
        nd_page = next((p for p in pages if p[2] is not None), None)
        if nd_page:
            for line in mc_json_map(nd_page[2]) or ['page data has no quarter names in it']:
                out('      ' + line)
        page = nd_page or next((p for p in pages if 'page' in p[0]), pages[-1])
        for u in mc_api_hints(opener, page[1], page[3], page[2]):
            out('      data link in the page scripts: ' + u[:150])
        saved = []
        for kind, text, nd, _ in pages:
            p = _mc_save(sym, kind.replace(' ', '_') + '.html', text)
            if nd is not None:
                p = _mc_save(sym, kind.replace(' ', '_') + '_data.json', json.dumps(nd, indent=1, ensure_ascii=False)) or p
            if p:
                saved.append(p)
        if saved:
            out('   pages saved in %s' % MC_CHECK_DIR)
    return shown


# ----------------------------------------------- moneycontrol: first figures for the sheet
# Results Tracker rows still Pending whose screener.in page does not show the quarter yet: read
# moneycontrol's quarterly results and send them (action 'mcput'). The sheet writes them only
# while screener.in is behind; screener.in's figures replace them later. Company codes found
# through moneycontrol's search are remembered in moneycontrol_codes.json.
def mc_codes_load():
    try:
        with open(MC_CODES_PATH, encoding='utf-8') as f:
            d = json.load(f)
        return d if isinstance(d, dict) else {}
    except (OSError, ValueError):
        return {}


def mc_codes_save(codes):
    try:
        with open(MC_CODES_PATH, 'w', encoding='utf-8') as f:
            json.dump(codes, f, indent=1, sort_keys=True)
    except OSError:
        pass


def mc_code_for(opener, sym, codes, now=None):
    """(hit, note) - the remembered moneycontrol code, else a search (a 'not on moneycontrol' answer is kept a week)."""
    now = time.time() if now is None else now
    c = codes.get(sym)
    if c and c.get('code'):
        return c, 'remembered'
    if c and c.get('none') and now - float(c.get('at', 0)) < 7 * 86400:
        return None, c.get('why') or 'not found on moneycontrol'
    hit, note = mc_lookup(opener, sym)
    if hit:
        codes[sym] = {'code': hit['code'], 'slug': hit['slug'], 'name': hit['name'], 'at': now}
    elif not note.startswith(('search did not answer', 'search: HTTP', 'search answer')):
        codes[sym] = {'none': True, 'why': note, 'at': now}
    return hit, note


def _close(a, b):
    return a is not None and b is not None and abs(a - b) <= max(0.5, 0.005 * abs(b))


def mc_payload(sym, res, basis, src, max_quarters=12):
    """A parsed result -> the sheet's item: quarters oldest first, three months apart, figures or None."""
    newest = res['quarters'][0]
    qs = [_qshift(newest, 3 * i) for i in range(max_quarters - 1, -1, -1)]
    while qs and res['revenue'].get(qs[0]) is None and res['profit'].get(qs[0]) is None:
        qs.pop(0)
    if len(qs) < 2:
        return None
    return {'sym': sym, 'basis': basis, 'quarters': qs, 'src': src,
            'revenue': [res['revenue'].get(q) for q in qs], 'netProfit': [res['profit'].get(q) for q in qs],
            'eps': [res['eps'].get(q) for q in qs]}


def _fmt(v):
    return '-' if v is None else '{:,.2f}'.format(v).rstrip('0').rstrip('.')


def mc_figures(opener, hit, expected, sym, pause=None):
    """(item for the sheet, note) when moneycontrol shows `expected` ('Sep 2026') or later; else (None, why)."""
    pause = MC_PAUSE if pause is None else pause
    want = _qkey(expected)
    srcs = dict(MC_SOURCES)
    chosen, seen = None, []
    for kind, basis in (('consolidated widget', 'Consolidated'), ('standalone widget', 'Standalone')):
        status, text, _ = mc_get(opener, srcs[kind].format(slug=hit['slug'], code=hit['code']), xhr=True)
        res = mc_parse(text)[0] if status == 200 else None
        if res and res['quarters']:
            q = res['quarters'][0]
            seen.append(q)
            if _qkey(q) >= want and res['revenue'].get(q) is not None and res['profit'].get(q) is not None:
                chosen = (res, basis, kind)
                break
        time.sleep(pause)
    if not chosen:
        return None, ('moneycontrol shows %s' % max(seen, key=_qkey)) if seen else 'no quarterly figures on moneycontrol'
    res, basis, kind = chosen
    q = res['quarters'][0]
    # EPS and a longer history from the results page - only when it shows the same figures (same basis)
    src, eps_note = kind, ''
    try:
        time.sleep(pause)
        status, text, _ = mc_get(opener, srcs['results page'].format(slug=hit['slug'], code=hit['code']))
        page = None
        if status == 200:
            page = mc_parse(text)[0]
            nd = None if page else _next_data(text)
            page = page or (mc_from_json(nd) if nd is not None else None)
        if page and _close(page['revenue'].get(q), res['revenue'][q]) and _close(page['profit'].get(q), res['profit'][q]):
            merged = {'quarters': [q], 'revenue': dict(page['revenue']), 'profit': dict(page['profit']), 'eps': dict(page['eps'])}
            merged['revenue'].update(res['revenue'])
            merged['profit'].update(res['profit'])
            merged['eps'].update({k: v for k, v in res['eps'].items() if v is not None})
            res, src = merged, kind + ' + results page'
            if merged['eps'].get(q) is None:
                eps_note = 'no EPS on the results page'
        elif status != 200:
            eps_note = 'no EPS: results page HTTP %s' % status
        elif not page:
            eps_note = 'no EPS: no figures read on the results page'
        else:
            eps_note = 'no EPS: results page %s shows revenue %s / profit %s (newest %s) - the widget %s / %s' % (
                q, _fmt(page['revenue'].get(q)), _fmt(page['profit'].get(q)), page['quarters'][0] if page['quarters'] else '-',
                _fmt(res['revenue'][q]), _fmt(res['profit'][q]))
    except (OSError, urllib.error.URLError, socket.timeout) as e:
        eps_note = 'no EPS: results page did not answer (%s)' % e
    if res['eps'].get(q) is not None:
        eps_note = ''             # the widget itself had EPS
    item = mc_payload(sym, res, basis, src)
    if not item:
        return None, 'too few quarters on moneycontrol'
    return item, '%s %s (%s)%s' % (basis, q, src, ('; ' + eps_note) if eps_note else '')


def mc_behind(want, screener_latest):
    """The wanted symbols whose screener.in page did not show the expected quarter (or was not read)."""
    out = set()
    for s, q in want.items():
        got, exp = _qlabel(screener_latest.get(s) or ''), _qlabel(q)
        if not (got and exp and _qkey(got) >= _qkey(exp)):
            out.add(s)
    return out


def mc_step(cfg, want, behind):
    """want = {SYM: 'Sep 2026'} from the sheet; behind = the ones screener.in did not show yet. Returns how many were sent."""
    if cfg.get('moneycontrol') is False or not want:
        return 0
    codes = mc_codes_load()
    checked = codes.get('_checked') if isinstance(codes.get('_checked'), dict) else {}
    # the ones looked at longest ago first, so a long list is covered over the next rounds
    todo = sorted([s for s in want if s in behind], key=lambda s: float(checked.get(s, 0)))
    syms = todo[:int(cfg.get('max_moneycontrol_per_run', 40))]
    if not syms:
        return 0
    log('moneycontrol: looking up %d result(s) screener.in does not show yet%s ...'
        % (len(syms), (' (%d more next round)' % (len(todo) - len(syms))) if len(todo) > len(syms) else ''))
    opener, items, fails = mc_session(), [], 0
    for i, sym in enumerate(syms):
        checked[sym] = time.time()
        try:
            hit, note = mc_code_for(opener, sym, codes)
            if not hit:
                log('  moneycontrol %s: %s' % (sym, note))
                continue
            item, note = mc_figures(opener, hit, want[sym], sym)
            fails = 0
            if item:
                items.append(item)
                log('  moneycontrol %s: %s' % (sym, note))
            else:
                log('  moneycontrol %s: not yet - %s' % (sym, note))
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            fails += 1
            log('  moneycontrol %s: did not answer (%s)' % (sym, e))
            if fails >= 3:
                log('moneycontrol is not answering - stopping (next run tries again).')
                break
        if i < len(syms) - 1:
            time.sleep(random.uniform(MC_PAUSE, 2 * MC_PAUSE))
    week = time.time() - 7 * 86400
    codes['_checked'] = {k: v for k, v in checked.items() if float(v) > week}
    mc_codes_save(codes)
    if not items:
        return 0
    try:
        res = api(cfg, 'mcput', {'items': items})
    except RuntimeError as e:
        log('moneycontrol figures not sent: %s' % e)
        return 0
    if not res.get('ok'):
        hint = ' - the sheet\'s web app is older: do the New version deploy (see README)' if res.get('error') == 'unknown action' else ''
        log('Sheet refused the moneycontrol figures: %s%s' % (res.get('error'), hint))
        return 0
    bad = ['%s (%s)' % (d.get('sym'), d.get('error')) for d in res.get('details', []) if not d.get('ok')]
    log('moneycontrol: sent %d to the sheet%s' % (res.get('stored', 0), ('; refused: ' + ', '.join(bad)) if bad else ''))
    return res.get('stored', 0)


# ------------------------------------------------------------------- the run
def acquire_lock():
    try:
        if os.path.exists(LOCK_PATH) and time.time() - os.path.getmtime(LOCK_PATH) < 3 * 3600:
            return False
        with open(LOCK_PATH, 'w') as f:
            f.write(str(os.getpid()))
        return True
    except OSError:
        return True


def release_lock():
    try:
        os.remove(LOCK_PATH)
    except OSError:
        pass


def wait_for_sheet(cfg, minutes=4):
    """Right after Windows starts the internet may not be ready yet - keep trying for a few minutes."""
    deadline = time.time() + minutes * 60
    last = None
    while True:
        try:
            ans = api(cfg, 'list', tries=1, timeout=90)
            return ans
        except RuntimeError as e:
            last = e
            if time.time() > deadline:
                raise last
            time.sleep(30)


def run_once(cfg):
    if not cfg.get('url') or not cfg.get('token'):
        log('Not set up yet - run Setup.bat first.')
        return 1
    if not acquire_lock():
        log('Another run is still going (or crashed less than 3 h ago) - skipping this one.')
        return 0
    try:
        try:
            ans = wait_for_sheet(cfg)
        except RuntimeError as e:
            log('FAILED: %s' % e)
            return 1
        if not ans.get('ok'):
            log('Sheet refused: %s' % ans.get('error'))
            return 1
        price_bands_step(cfg)
        ipo_step(cfg)
        eod_step(cfg)
        priority = [s for s in ans.get('priority', [])]
        missing = [s for s in ans.get('missing', [])][:int(cfg['max_missing_per_run'])]
        todo = priority + [s for s in missing if s not in priority]
        log('Sheet wants %d symbol(s): %d results-due/pending, %d never-attempted (of %d waiting).'
            % (len(todo), len(priority), len(missing), len(ans.get('missing', []))))
        if not todo:
            return 0

        pending_items, posted, fails_in_row, aborted = [], 0, 0, False
        batch = int(cfg['batch_size'])
        screener_latest = {}       # what screener.in showed, per symbol (from the sheet's answer)

        def flush(items):
            nonlocal posted
            if not items:
                return
            res = api(cfg, 'put', {'items': items})
            if not res.get('ok'):
                raise RuntimeError('sheet said: %s' % res.get('error'))
            posted += res.get('stored', 0)
            for d in res.get('details', []):
                if d.get('latest'):
                    screener_latest[d['sym']] = d['latest']
            # Companies whose consolidated page was thin: also send the standalone page.
            extra = []
            for d in res.get('details', []):
                if d.get('thin') and 'not on screener' not in (d.get('error') or ''):
                    try:
                        polite_sleep(cfg)
                        kind, html = fetch_page(cfg, d['sym'], consolidated=False)
                        if kind == 'ok':
                            extra.append({'sym': d['sym'], 'html2': html})
                    except Blocked as e:
                        log('  %s standalone page skipped (%s)' % (d['sym'], e))
            if extra:
                res2 = api(cfg, 'put', {'items': extra})
                for d in res2.get('details', []):
                    if d.get('latest'):
                        screener_latest[d['sym']] = d['latest']

        for i, sym in enumerate(todo):
            try:
                kind, html = fetch_page(cfg, sym, True)
                if kind == '404':
                    # Some companies only have a standalone page.
                    polite_sleep(cfg)
                    kind, html = fetch_page(cfg, sym, False)
                fails_in_row = 0
                if kind == '404':
                    pending_items.append({'sym': sym, 'status': 404})
                    log('[%d/%d] %s  not on screener (404)' % (i + 1, len(todo), sym))
                else:
                    pending_items.append({'sym': sym, 'html': html})
                    log('[%d/%d] %s  ok (%d KB)' % (i + 1, len(todo), sym, len(html) // 1024))
            except Blocked as e:
                fails_in_row += 1
                log('[%d/%d] %s  FAILED - %s' % (i + 1, len(todo), sym, e))
                if fails_in_row >= int(cfg['abort_after_failures']):
                    log('Too many failures in a row - stopping this run (next hourly run tries again).')
                    aborted = True
            if len(pending_items) >= batch or aborted or i == len(todo) - 1:
                try:
                    flush(pending_items)
                except RuntimeError as e:
                    log('FAILED sending to sheet: %s' % e)
                    aborted = True
                pending_items = []
            if aborted:
                break
            if i < len(todo) - 1:
                polite_sleep(cfg)

        # Results screener.in does not show yet: moneycontrol's figures first (the sheet decides).
        mc_sent = 0
        try:
            want = ans.get('mc') or {}
            if 'mc' not in ans and priority and cfg.get('moneycontrol') is not False:
                log('moneycontrol: the sheet\'s web app does not ask for it yet - after pasting the new Code.gs, '
                    'do the New version deploy (see README).')
            mc_sent = mc_step(cfg, want, mc_behind(want, screener_latest))
        except Exception as e:   # never let moneycontrol stop the run
            log('moneycontrol: unexpected problem - %s' % e)

        if posted or mc_sent:
            log('Sent %d page(s)%s. Asking the sheet to process them...'
                % (posted, (' and %d moneycontrol result(s)' % mc_sent) if mc_sent else ''))
            try:
                res = api(cfg, 'process', timeout=420, tries=2)
                if res.get('ok'):
                    r = res.get('result', {})
                    log('Sheet: Results Day -> %s | Never-attempted rows -> %s' % (r.get('results'), r.get('missing')))
                    for err in r.get('errors', []):
                        log('Sheet problem: %s' % err)
                else:
                    log('Sheet could not process: %s' % res.get('error'))
            except RuntimeError as e:
                log('Processing call failed (data is safe in the sheet, next run processes it): %s' % e)
        log('Run finished.')
        return 0
    finally:
        release_lock()


# ----------------------------------------------------------------- commands
def cmd_test(cfg):
    ok = True
    print('1) Sheet connection ...')
    try:
        ans = api(cfg, 'list', tries=1, timeout=90)
        if ans.get('ok'):
            print('   OK - sheet wants %d results-due/pending and %d never-attempted symbols.'
                  % (len(ans.get('priority', [])), len(ans.get('missing', []))))
        else:
            ok = False
            print('   PROBLEM - sheet said: %s' % ans.get('error'))
    except RuntimeError as e:
        ok = False
        print('   PROBLEM - %s' % e)
    print('2) screener.in from this computer ...')
    try:
        kind, html = fetch_page(cfg, 'TCS', True)
        print('   OK - screener.in opened fine from this computer.' if kind == 'ok' else '   Reached screener.in (TCS page not found?).')
    except Blocked as e:
        ok = False
        print('   PROBLEM - %s' % e)
    print('3) NSE price band file from this computer ...')
    try:
        opener = nse_session()
        found = None
        d = next_weekday(date.today())
        for _ in range(9):
            if d.weekday() < 5:
                kind, val = pb_fetch(opener, d)
                if kind == 'ok':
                    found = (d, val)
                    break
                if kind == 'error':
                    print('   %s: %s' % (d.strftime('%d-%m-%Y'), val))
            d -= timedelta(days=1)
        if found:
            print('   OK - downloaded the file with the bands from %s (%d price band changes). Nothing was sent.'
                  % (found[0].strftime('%d-%m-%Y'), len(found[1])))
        else:
            print('   PROBLEM - could not download a price band file from NSE (the screener part still works;'
                  ' paste the file by hand meanwhile).')
    except Exception as e:
        print('   PROBLEM - %s' % e)
    print('4) NSE IPO lists from this computer ...')
    try:
        opener = ipo_session()
        for which, urls in IPO_SOURCES:
            recs, err, keys = ipo_fetch_list(opener, which, urls, date.today())
            if recs is None:
                print('   %-8s PROBLEM - %s' % (which + ':', err))
                continue
            main = [r for r in recs if ipo_kind(r) == 'main']
            eg = ''
            if main:
                eg = '; e.g. %s %s to %s' % (main[0]['company'] or main[0]['symbol'], main[0]['start'] or '?', main[0]['end'] or '?')
            types = {}
            for r in recs:
                types[r['type'] or '(none)'] = types.get(r['type'] or '(none)', 0) + 1
            print('   %-8s OK - %d issue(s), %d mainboard equity%s' % (which + ':', len(recs), len(main), eg))
            if recs:
                print('            types: %s' % ', '.join('%s %d' % kv for kv in sorted(types.items())))
            if recs and not any(r['start'] or r['end'] for r in recs):
                print('            dates not recognised - NSE fields: %s' % ', '.join(keys[:20]))
        print('   (nothing was sent)')
    except Exception as e:
        print('   PROBLEM - %s' % e)
    print('5) NSE end-of-day files (Delivery %, 52-week highs) from this computer ...')
    try:
        opener = nse_session()
        d, found = date.today(), None
        for _ in range(8):
            if d.weekday() < 5:
                kind, val = eod_fetch(opener, 'bhav', d)
                if kind == 'ok':
                    found = (d, val)
                    break
                if kind == 'error':
                    print('   %s: %s' % (d.strftime('%d-%m-%Y'), val))
            d -= timedelta(days=1)
        if found:
            k52, w = eod_fetch(opener, 'w52', found[0])
            kb, b = eod_fetch(opener, 'bands', found[0])
            print('   OK - bhavcopy of %s: %d rows, Delivery %% for %d stocks; 52-week report: %s; price band list: %s. Nothing was sent.'
                  % (found[0].strftime('%d-%m-%Y'), len(found[1]), sum(1 for r in found[1] if r['deliv'] is not None),
                     ('%d stocks' % len(w)) if k52 == 'ok' else k52, ('%d stocks' % len(b)) if kb == 'ok' else kb))
        else:
            print('   PROBLEM - could not download the bhavcopy from NSE.')
    except Exception as e:
        print('   PROBLEM - %s' % e)
    print('6) moneycontrol from this computer (check only) ...')
    try:
        mc_check('TCS', out=print, detail=False)
        print('   (nothing was sent)')
    except Exception as e:
        print('   PROBLEM - %s' % e)
    return 0 if ok else 1


def pythonw_path():
    exe = sys.executable
    if exe.lower().endswith('python.exe'):
        w = exe[:-len('python.exe')] + 'pythonw.exe'
        if os.path.exists(w):
            return w
    return exe


def internet_ok():
    try:
        socket.create_connection(('script.google.com', 443), timeout=6).close()
        return True
    except OSError:
        return False


def wait_for_internet(max_minutes=180):
    """Wait (checking every 20 s) until the internet works. Returns False if it never came."""
    t0 = time.time()
    announced = False
    while not internet_ok():
        if time.time() - t0 > max_minutes * 60:
            log('No internet for %d minutes - giving up this round.' % max_minutes)
            return False
        if not announced:
            log('No internet yet - waiting for the network ...')
            announced = True
        time.sleep(20)
    if announced:
        log('Internet is back.')
    return True


def run_after_login(cfg):
    """Started once at Windows log-in: round 1 when the internet is available, round 2 an hour later."""
    if wait_for_internet():
        run_once(cfg)
    time.sleep(SECOND_RUN_AFTER_MIN * 60)
    if wait_for_internet():
        run_once(cfg)
    return 0


SECOND_RUN_AFTER_MIN = 60   # on every log-in: run #1 after 1 minute, run #2 this many minutes later


def _remove_tasks():
    # removes the old hourly / twice-a-day Task Scheduler entries (if they exist)
    for name in (TASK_NAME, TASK_NAME + '_1', TASK_NAME + '_2'):
        subprocess.run(['schtasks', '/Delete', '/F', '/TN', name], capture_output=True, text=True)


def install_schedule():
    if os.name != 'nt':
        print('(Not Windows - skipping the schedule step. Run "python screener_bridge.py run" yourself or use cron.)')
        return
    script = os.path.abspath(__file__)
    py = pythonw_path()
    _remove_tasks()
    print('   Old hourly / timed Task Scheduler entries removed (nothing runs continuously now).')
    startup = os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup')
    try:
        os.makedirs(startup, exist_ok=True)
        cmd = '""%s"" ""%s"" login' % (py, script)
        vbs = ('Set sh = CreateObject("WScript.Shell")\r\n'
               'WScript.Sleep 60000\r\n'
               'sh.Run "%s", 0, False\r\n' % cmd)
        with open(os.path.join(startup, STARTUP_FILE), 'w', encoding='utf-8') as f:
            f.write(vbs)
        print('   Set: after every Windows log-in -> wait 1 minute, then run as soon as the internet is connected,')
        print('        and once more %d minutes after that run (again only when connected).' % SECOND_RUN_AFTER_MIN)
    except OSError as e:
        print('   Could not add the log-in start-up item: %s' % e)


def remove_schedule():
    if os.name == 'nt':
        _remove_tasks()
        p = os.path.join(os.environ.get('APPDATA', ''), 'Microsoft', 'Windows', 'Start Menu', 'Programs',
                         'Startup', STARTUP_FILE)
        try:
            os.remove(p)
        except OSError:
            pass
    print('Schedule removed. (config.json and bridge.log are still here - delete the folder if you want everything gone.)')


def cmd_setup(cfg):
    print('=' * 64)
    print(' Auto Bhavcopy - screener.in PC bridge - one-time setup')
    print('=' * 64)
    print('In your Google Sheet open:  Auto Bhavcopy > 3. Quarterly Results & Trend Tags >')
    print('PC Bridge: setup info (address + secret code)  - it shows both values to copy.\n')
    while True:
        url = input('Paste the WEB APP ADDRESS (ends with /exec): ').strip()
        if url.startswith('https://script.google.com/') and url.endswith('/exec'):
            break
        print('  That does not look right. It must start with https://script.google.com/ and end with /exec\n')
    token = input('Paste the SECRET CODE: ').strip()
    cfg['url'], cfg['token'] = url, token
    print('\nTesting ...')
    rc = cmd_test(cfg)
    if rc != 0:
        ans = input('\nSomething failed (see above). Save the settings anyway? (y/n): ').strip().lower()
        if ans != 'y':
            print('Nothing saved. Fix the problem and run Setup again.')
            return 1
    save_config(cfg)
    print('\nSettings saved.')
    install_schedule()
    ans = input('\nRun the first round now? It can take several minutes. (y/n): ').strip().lower()
    if ans in ('', 'y', 'yes'):
        run_once(cfg)
    print('\nAll set. Each time you log in it runs twice (only when internet is connected): ~1 minute after log-in and 1 hour after that. Log: %s' % LOG_PATH)
    return 0


def main(argv):
    cmd = argv[1] if len(argv) > 1 else 'run'
    cfg = load_config()
    if cmd == 'setup':
        return cmd_setup(cfg)
    if cmd == 'run':
        return run_once(cfg)
    if cmd == 'test':
        return cmd_test(cfg)
    if cmd == 'moneycontrol':
        syms = [a for a in argv[2:] if a.strip()] or ['TCS']
        print('moneycontrol test (nothing is sent to the sheet)')
        for sym in syms:
            mc_check(sym, out=print)
        print('(nothing was sent to the sheet)')
        return 0
    if cmd == 'ipos':
        if not cfg.get('url') or not cfg.get('token'):
            log('Not set up yet - run Setup.bat first.')
            return 1
        ipo_step(dict(cfg, ipos=True))
        return 0
    if cmd == 'eod':
        if not cfg.get('url') or not cfg.get('token'):
            log('Not set up yet - run Setup.bat first.')
            return 1
        eod_step(dict(cfg, eod=True))
        return 0
    if cmd == 'pricebands':
        if not cfg.get('url') or not cfg.get('token'):
            log('Not set up yet - run Setup.bat first.')
            return 1
        price_bands_step(dict(cfg, price_bands=True))
        return 0
    if cmd == 'login':
        return run_after_login(cfg)
    if cmd == 'reschedule':
        install_schedule()
        return 0
    if cmd == 'uninstall':
        remove_schedule()
        return 0
    print(__doc__)
    return 2


if __name__ == '__main__':
    try:
        sys.exit(main(sys.argv))
    except KeyboardInterrupt:
        sys.exit(130)
