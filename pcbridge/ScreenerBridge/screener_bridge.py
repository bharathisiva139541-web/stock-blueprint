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

Commands (Setup.bat / RunNow.bat call these for you):
  python screener_bridge.py setup      one-time setup (address + secret code + schedule)
  python screener_bridge.py run        do one round of work (starts by itself after you log in, waits for the internet)
  python screener_bridge.py test       check the connection to the sheet, screener.in and NSE
  python screener_bridge.py pricebands download NSE's price band changes and send them now
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
from http.cookiejar import CookieJar

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'config.json')
LOG_PATH = os.path.join(HERE, 'bridge.log')
LOCK_PATH = os.path.join(HERE, 'bridge.lock')
PB_STATE_PATH = os.path.join(HERE, 'pricebands_state.json')
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
        priority = [s for s in ans.get('priority', [])]
        missing = [s for s in ans.get('missing', [])][:int(cfg['max_missing_per_run'])]
        todo = priority + [s for s in missing if s not in priority]
        log('Sheet wants %d symbol(s): %d results-due/pending, %d never-attempted (of %d waiting).'
            % (len(todo), len(priority), len(missing), len(ans.get('missing', []))))
        if not todo:
            return 0

        pending_items, posted, fails_in_row, aborted = [], 0, 0, False
        batch = int(cfg['batch_size'])

        def flush(items):
            nonlocal posted
            if not items:
                return
            res = api(cfg, 'put', {'items': items})
            if not res.get('ok'):
                raise RuntimeError('sheet said: %s' % res.get('error'))
            posted += res.get('stored', 0)
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
                api(cfg, 'put', {'items': extra})

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

        if posted:
            log('Sent %d page(s). Asking the sheet to process them...' % posted)
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
