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

Commands (Setup.bat / RunNow.bat call these for you):
  python screener_bridge.py setup      one-time setup (address + secret code + schedule)
  python screener_bridge.py run        do one round of work (starts by itself after you log in, waits for the internet)
  python screener_bridge.py test       check the connection to the sheet and to screener.in
  python screener_bridge.py reschedule re-create the log-in schedule only, keeps your settings
  python screener_bridge.py uninstall  remove the schedule

Needs only Python 3.8+ (nothing else to install). Files it creates sit next to
this script: config.json (your settings) and bridge.log (what it did).
"""
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
from datetime import datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG_PATH = os.path.join(HERE, 'config.json')
LOG_PATH = os.path.join(HERE, 'bridge.log')
LOCK_PATH = os.path.join(HERE, 'bridge.lock')
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
