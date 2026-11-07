"""
Zerodha Kite Connect -> intraday, weekly and monthly patterns for the sheet
==========================================================================
Owner, 07-Nov-2026: "PARAGMILK - in the 4 hour timeframe a Spring candlestick pattern formed in an FVG; due to the lack
of intraday data I missed this opportunity" ... "I don't sit before the laptop during market hours, so no alerts".

Once a trading day, after the close (or whenever this computer is on next), this part of the PC program:
  1. asks you to log in to Kite in your browser (Zerodha's rule: a manual login once a day; the login page sends the
     day's permission to http://127.0.0.1:8765/kite = this computer, never anywhere else),
  2. reads the 15-minute and daily candles of every stock on the sheet's PatternData tab from Kite (~3 a second),
     kept in the folder intraday_data next to this script (only the new days are read after the first time),
  3. builds the 15m / 30m / 1H / 2H / 4H candles (sessions 09:15-15:30, 4H = 09:15-13:15 and 13:15-15:30 like
     TradingView) and D / W / M,
  4. looks for the sheet's Spring pattern and "Spring in FVG" (the sheet's FVG+Spring rule) on every timeframe - the
     same rules as Code.gs and the website (web/lib/patterns.js isSpringPair, web/lib/fvg.js longFvgDetail),
  5. sends what it found to the sheet's "Intraday Patterns" tab (action 'intraday').

Kite's data is for your own use: the sheet tab keeps the prices, the website shows only which pattern formed when,
with a button that opens TradingView's own chart at that timeframe.

Settings (config.json): kite_api_key, kite_api_secret (KiteSetup.bat asks for both), "intraday": false turns it off,
"intraday_timeframes", "intraday_fvg_only" (timeframes that report only "Spring in FVG", default 15m and 30m).
"""
import csv
import gzip
import hashlib
import io
import json
import math
import os
import re
import socket
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import date, datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
IST = timezone(timedelta(hours=5, minutes=30))

KITE_ROOT = 'https://api.kite.trade'
KITE_LOGIN = 'https://kite.zerodha.com/connect/login?v=3&api_key={k}'
REDIRECT_HOST, REDIRECT_PORT, REDIRECT_PATH = '127.0.0.1', 8765, '/kite'
REDIRECT_URL = 'http://%s:%d%s' % (REDIRECT_HOST, REDIRECT_PORT, REDIRECT_PATH)
SESSION_PATH = os.path.join(HERE, 'kite_session.json')        # the day's access token (never sent anywhere but Kite)
STATE_PATH = os.path.join(HERE, 'intraday_state.json')
INSTR_PATH = os.path.join(HERE, 'kite_instruments.json')
DATA_DIR = os.path.join(HERE, 'intraday_data')

REQ_GAP_S = 0.35            # Kite: 3 historical-data requests a second
M15_BACKFILL_DAYS = 190     # the first read of a stock (Kite: at most 200 days of 15-minute candles a request)
M15_KEEP_SESSIONS = 125     # 15-minute candles kept per stock (~6 months: the 4H window below + its older gaps)
DAY_BACKFILL_DAYS = 1900    # (Kite: at most 2000 days of day candles a request) - W / M need years
OVERLAP_DAYS = 4            # each update reads these days again: a split / bonus changes Kite's older candles -> read all again
ADJUST_TOL = 0.005          # 0.5 %
FIRST_RUN_SESSIONS = 10     # the first scan reports the patterns of the last 10 sessions
LOGIN_WAIT_S = 45 * 60      # the login page waits this long for you
LOGIN_RETRY_S = 2 * 3600    # no login: asked again after 2 hours (at most LOGINS_PER_DAY pages a day)
LOGINS_PER_DAY = 4
RETRY_S = 30 * 60           # a scan that stopped (Kite / sheet problem) is tried again after 30 minutes
SESSION_CLOSE = (15, 40)    # a session counts as finished after 15:40 IST
POST_ITEMS = 400            # patterns per post to the sheet
ABORT_AFTER_ERRORS = 40     # Kite errors in a row -> stop this scan (the next one carries on)

TIMEFRAMES = ('15m', '30m', '1H', '2H', '4H', 'D', 'W', 'M')       # all it can build (IntradayCheck shows any of them)
# the timeframes the daily scan reports (owner, 08-Nov-2026, after the first scan found ~680 patterns a day: "I want the spring
# pattern to be tracked only in this time frame 4hr, D, W, M"); config "intraday_timeframes" overrides it
DEFAULT_TIMEFRAMES = ('4H', 'D', 'W', 'M')
TF_MINUTES = {'15m': 15, '30m': 30, '1H': 60, '2H': 120, '4H': 240}
TF_ARGS = {'15M': '15m', '15': '15m', '30M': '30m', '30': '30m', '1H': '1H', '60': '1H', '2H': '2H', '120': '2H',
           '4H': '4H', '240': '4H', 'D': 'D', '1D': 'D', 'W': 'W', '1W': 'W', 'M': 'M', '1M': 'M'}   # IntradayCheck.bat words
TV_INTERVAL = {'15m': '15', '30m': '30', '1H': '60', '2H': '120', '4H': '240', 'D': 'D', 'W': 'W', 'M': 'M'}
WINDOW = {'15m': 400, '30m': 400, '1H': 450, '2H': 320, '4H': 260, 'D': 300, 'W': 160, 'M': 72}   # candles looked at
DEFAULT_FVG_ONLY = ('15m', '30m')
SPRING_CFG = {'bodyMin': 0.5, 'day2BodyMax': 30, 'undercut': 0.10, 'reclaimMax': 50}   # Code.gs ab_springCfg_ defaults
SESSION_START = 9 * 60 + 15   # 09:15
SESSION_END = 15 * 60 + 30    # 15:30

log = print                   # screener_bridge.py hands its own log() here


BUSY = '-busy-'               # wait_for_request_token: another copy of the program already waits on port 8765


class NeedLogin(Exception):
    """Kite refused the day's permission (expired at 6 AM, or never given)."""


class KiteError(Exception):
    pass


# ------------------------------------------------------------------ Kite: http, login, session
def _http(method, url, headers, data=None, timeout=60):
    """(status, text). Network problems raise OSError / URLError. Tests replace this."""
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            raw = r.read()
            if r.headers.get('Content-Encoding') == 'gzip' or raw[:2] == b'\x1f\x8b':
                raw = gzip.decompress(raw)
            return r.status, raw.decode('utf-8', errors='replace')
    except urllib.error.HTTPError as e:
        try:
            body = e.read().decode('utf-8', errors='replace')
        except Exception:
            body = ''
        return e.code, body


_LAST = {'t': 0.0}


def _throttle(gap=REQ_GAP_S):
    wait = _LAST['t'] + gap - time.time()
    if wait > 0:
        time.sleep(wait)
    _LAST['t'] = time.time()


def kite_req(cfg, sess, method, path, params=None, form=None, raw=False, throttle=True):
    """One Kite call. JSON answers -> the parsed object; raw -> the text. 403 -> NeedLogin; 429 / 5xx retried."""
    url = KITE_ROOT + path + ('?' + urllib.parse.urlencode(params) if params else '')
    headers = {'X-Kite-Version': '3', 'User-Agent': 'StockBlueprint-PCBridge/1', 'Accept-Encoding': 'gzip'}
    if sess:
        headers['Authorization'] = 'token %s:%s' % (cfg.get('kite_api_key', ''), sess.get('access_token', ''))
    data = None
    if form is not None:
        data = urllib.parse.urlencode(form).encode('utf-8')
        headers['Content-Type'] = 'application/x-www-form-urlencoded'
    last = ''
    for attempt in range(4):
        if throttle:
            _throttle()
        try:
            status, text = _http(method, url, headers, data)
        except (OSError, urllib.error.URLError, socket.timeout) as e:
            last = str(e)
            time.sleep(2 * (attempt + 1))
            continue
        if status == 200:
            if raw:
                return text
            try:
                return json.loads(text)
            except ValueError:
                raise KiteError('Kite sent something that is not JSON')
        msg = ''
        try:
            j = json.loads(text)
            msg = j.get('message') or ''
            kind = j.get('error_type') or ''
        except (ValueError, AttributeError):
            kind = ''
        if status == 403 or kind == 'TokenException':
            raise NeedLogin(msg or 'Kite asks for a new login')
        if status == 429 or status >= 500:
            last = 'HTTP %d %s' % (status, msg)
            time.sleep(1.0 + attempt)
            continue
        raise KiteError('HTTP %d %s' % (status, msg or text[:120]))
    raise KiteError('no answer from Kite (%s)' % last)


def next_6am(ts):
    """Kite's permission of a day ends at 06:00 IST the next morning."""
    d = datetime.fromtimestamp(ts, IST)
    six = d.replace(hour=6, minute=0, second=0, microsecond=0)
    if d >= six:
        six += timedelta(days=1)
    return six.timestamp()


def session_load():
    try:
        with open(SESSION_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) else None
    except (OSError, ValueError):
        return None


def session_save(s):
    with open(SESSION_PATH, 'w', encoding='utf-8') as f:
        json.dump(s, f)


def session_valid(s, now=None):
    now = time.time() if now is None else now
    return bool(s and s.get('access_token') and now < float(s.get('expires') or 0))


def configured(cfg):
    return bool(str(cfg.get('kite_api_key') or '').strip() and str(cfg.get('kite_api_secret') or '').strip())


def checksum(api_key, request_token, api_secret):
    return hashlib.sha256((api_key + request_token + api_secret).encode('utf-8')).hexdigest()


def wait_for_request_token(wait_s, open_url=None, ready=None):
    """Runs the tiny page at http://127.0.0.1:8765/kite that Kite's login page sends you back to, until it brings the
    request_token (or wait_s passes). open_url = the login page to open in the browser. -> token or None."""
    got = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            u = urllib.parse.urlparse(self.path)
            if u.path.rstrip('/') != REDIRECT_PATH:
                self.send_response(404)
                self.end_headers()
                return
            q = urllib.parse.parse_qs(u.query)
            tok = (q.get('request_token') or [''])[0]
            status = (q.get('status') or [''])[0]
            ok = bool(tok) and status in ('', 'success')
            if ok:
                got['token'] = tok
            body = ('<!doctype html><meta charset="utf-8"><title>Stock Blueprint - Kite</title>'
                    '<body style="font-family:sans-serif;max-width:560px;margin:60px auto;line-height:1.5">' +
                    ('<h2>&#10004; Kite login received</h2><p>Stock Blueprint\'s PC program is now reading the candles. '
                     'You can close this tab.</p>' if ok else
                     '<h2>Login not completed</h2><p>Kite said: %s. Close this tab - the program asks again later.</p>'
                     % (status or 'no permission'))).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    try:
        srv = HTTPServer((REDIRECT_HOST, REDIRECT_PORT), Handler)
    except OSError:
        return BUSY
    srv.timeout = 1
    try:
        if ready:
            ready()
        if open_url:
            try:
                webbrowser.open(open_url)
            except Exception:
                pass
        t0 = time.time()
        while 'token' not in got and time.time() - t0 < wait_s:
            srv.handle_request()
    finally:
        srv.server_close()
    return got.get('token')


def login(cfg, wait_s=LOGIN_WAIT_S, open_browser=True, ready=None):
    """Kite's login page in the browser -> the request token at 127.0.0.1:8765/kite -> the day's access token.
    -> the saved session, or None when you did not log in within wait_s."""
    if not configured(cfg):
        raise KiteError('Kite is not set up - run KiteSetup.bat')
    key, secret = str(cfg['kite_api_key']).strip(), str(cfg['kite_api_secret']).strip()
    url = KITE_LOGIN.format(k=urllib.parse.quote(key))
    log('Kite: opening the Zerodha login page in your browser (waiting up to %d minutes) ...' % (wait_s // 60))
    t0 = time.time()
    tok = wait_for_request_token(wait_s, open_url=url if open_browser else None, ready=ready)
    if tok == BUSY:
        # the background program already waits for a login on port 8765: it takes the token and saves the session
        log('Kite: the background program is already waiting for this login - log in on the page, this waits for it.')
        if open_browser:
            try:
                webbrowser.open(url)
            except Exception:
                pass
        while time.time() - t0 < wait_s:
            s = session_load()
            if session_valid(s) and float(s.get('at') or 0) >= t0 - 5:
                return s
            time.sleep(2)
        return None
    if not tok:
        return None
    ans = kite_req(cfg, None, 'POST', '/session/token', form={'api_key': key, 'request_token': tok,
                                                               'checksum': checksum(key, tok, secret)}, throttle=False)
    d = (ans or {}).get('data') or {}
    if not d.get('access_token'):
        raise KiteError('Kite did not give a permission for the day')
    now = time.time()
    s = {'access_token': d['access_token'], 'user': d.get('user_name') or d.get('user_id') or '', 'at': now,
         'expires': next_6am(now)}
    session_save(s)
    log('Kite: logged in as %s (valid until 6 AM).' % (s['user'] or 'you'))
    return s


def ensure_session(cfg, wait_s=LOGIN_WAIT_S, open_browser=True):
    s = session_load()
    if session_valid(s):
        return s
    return login(cfg, wait_s=wait_s, open_browser=open_browser)


# ------------------------------------------------------------------ instruments + candles from Kite
def instruments(cfg, sess, today_iso):
    """NSE equity symbol -> Kite instrument token (Kite's list, read once a day)."""
    try:
        with open(INSTR_PATH, 'r', encoding='utf-8') as f:
            c = json.load(f)
        if c.get('day') == today_iso and c.get('map'):
            return c['map']
    except (OSError, ValueError, AttributeError):
        pass
    text = kite_req(cfg, sess, 'GET', '/instruments/NSE', raw=True)
    m = instruments_parse(text)
    if not m:
        raise KiteError('Kite\'s instrument list was empty')
    try:
        with open(INSTR_PATH, 'w', encoding='utf-8') as f:
            json.dump({'day': today_iso, 'map': m}, f)
    except OSError:
        pass
    return m


def instruments_parse(text):
    out = {}
    for r in csv.DictReader(io.StringIO(text)):
        if (r.get('segment') or '') != 'NSE' or (r.get('instrument_type') or '') != 'EQ':
            continue
        try:
            out[(r.get('tradingsymbol') or '').strip().upper()] = int(r.get('instrument_token'))
        except (TypeError, ValueError):
            continue
    return out


def token_for(imap, sym):
    """Kite lists BE / BZ series as SYMBOL-BE / SYMBOL-BZ."""
    for k in (sym, sym + '-BE', sym + '-BZ'):
        if k in imap:
            return imap[k]
    return None


def _num(v):
    try:
        x = float(v)
        return x if math.isfinite(x) else None
    except (TypeError, ValueError):
        return None


def parse_candles(candles, daily):
    """Kite's [[time, o, h, l, c, v], ...] -> [[key, o, h, l, c, v]] (key 'YYYY-MM-DD HH:MM', or 'YYYY-MM-DD' daily)."""
    out = []
    for c in candles or []:
        if not isinstance(c, (list, tuple)) or len(c) < 6:
            continue
        t = str(c[0])
        m = re.match(r'^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2})', t)
        if not m:
            continue
        vals = [_num(x) for x in c[1:6]]
        if any(v is None for v in vals[:4]) or min(vals[:4]) <= 0:
            continue
        out.append([m.group(1) if daily else m.group(1) + ' ' + m.group(2)] + [round(v, 4) for v in vals[:4]] + [int(vals[4] or 0)])
    return out


def historical(cfg, sess, token, interval, frm, to):
    ans = kite_req(cfg, sess, 'GET', '/instruments/historical/%d/%s' % (token, interval),
                   params={'from': frm.strftime('%Y-%m-%d %H:%M:%S'), 'to': to.strftime('%Y-%m-%d %H:%M:%S'),
                           'continuous': 0, 'oi': 0})
    return parse_candles(((ans or {}).get('data') or {}).get('candles'), interval == 'day')


# ------------------------------------------------------------------ the candles kept on this computer
def _safe(sym):
    return re.sub(r'[^A-Za-z0-9_-]', lambda m: '%%%02X' % ord(m.group()), sym)


def store_path(sym):
    return os.path.join(DATA_DIR, _safe(sym) + '.json.gz')


def store_load(sym):
    try:
        with gzip.open(store_path(sym), 'rt', encoding='utf-8') as f:
            s = json.load(f)
        if isinstance(s, dict):
            s.setdefault('m15', [])
            s.setdefault('day', [])
            return s
    except (OSError, ValueError, EOFError):
        pass
    return {'v': 1, 'sym': sym, 'm15': [], 'day': []}


def store_save(sym, s):
    os.makedirs(DATA_DIR, exist_ok=True)
    tmp = store_path(sym) + '.tmp'
    with gzip.open(tmp, 'wt', encoding='utf-8') as f:
        json.dump(s, f, separators=(',', ':'))
    os.replace(tmp, store_path(sym))


def _merge(old, new):
    by = {r[0]: r for r in old}
    for r in new:
        by[r[0]] = r
    return [by[k] for k in sorted(by)]


def _adjusted(old, new):
    """A split / bonus: Kite's candles of the overlapping days changed."""
    by = {r[0]: r for r in old}
    for r in new:
        o = by.get(r[0])
        if o and o[4] > 0 and abs(r[4] - o[4]) / o[4] > ADJUST_TOL:
            return True
    return False


def _trim_sessions(rows, keep):
    days = sorted({r[0][:10] for r in rows})
    if len(days) <= keep:
        return rows
    first = days[-keep]
    return [r for r in rows if r[0][:10] >= first]


def update_symbol(cfg, sess, sym, token, upto):
    """Brings the stored candles of one stock up to session `upto` (a date): the daily candles from a few days back
    (a split / bonus changes Kite's older candles -> everything is read again), then the 15-minute ones. Nothing is read
    when both are up to date. -> (store, requests made)."""
    s = store_load(sym)
    upto_iso = upto.isoformat()
    end = datetime(upto.year, upto.month, upto.day, 15, 30)
    m15, day = s['m15'], s['day']
    if m15 and day and m15[-1][0][:10] >= upto_iso and day[-1][0] >= upto_iso:
        return s, 0
    req = 0
    lastd = date.fromisoformat(day[-1][0]) if day else None
    full = not lastd or (upto - lastd).days >= DAY_BACKFILL_DAYS - 30
    if not full:
        frm = lastd - timedelta(days=OVERLAP_DAYS + 3)
        new = historical(cfg, sess, token, 'day', datetime(frm.year, frm.month, frm.day), end)
        req += 1
        if _adjusted(day, new):
            full = True
        else:
            day = _merge(day, new)
    if full:
        frm = upto - timedelta(days=DAY_BACKFILL_DAYS)
        day = historical(cfg, sess, token, 'day', datetime(frm.year, frm.month, frm.day), end)
        req += 1
    last15 = date.fromisoformat(m15[-1][0][:10]) if m15 else None
    full15 = full or not last15 or (upto - last15).days > M15_BACKFILL_DAYS - OVERLAP_DAYS - 5
    if not full15:
        frm = last15 - timedelta(days=OVERLAP_DAYS)
        new = historical(cfg, sess, token, '15minute', datetime(frm.year, frm.month, frm.day, 9, 0), end)
        req += 1
        if _adjusted(m15, new):
            full15 = True
        else:
            m15 = _merge(m15, new)
    if full15:
        frm = upto - timedelta(days=M15_BACKFILL_DAYS)
        m15 = historical(cfg, sess, token, '15minute', datetime(frm.year, frm.month, frm.day, 9, 0), end)
        req += 1
    s['day'] = [r for r in day if r[0] <= upto_iso]
    s['m15'] = _trim_sessions([r for r in m15 if r[0][:10] <= upto_iso], M15_KEEP_SESSIONS)
    s['upto'] = upto_iso
    store_save(sym, s)
    return s, req


# ------------------------------------------------------------------ candles of every timeframe
def _mod(key):
    return int(key[11:13]) * 60 + int(key[14:16])


def _hhmm(m):
    return '%02d:%02d' % (m // 60, m % 60)


def bucket_intraday(m15, minutes):
    """15-minute candles -> candles of `minutes` (15 / 30 / 60 / 120 / 240) starting at 09:15 each session, like
    TradingView (4H = 09:15-13:15 and 13:15-15:30). -> [{'t', 'day', 'o', 'h', 'l', 'c', 'v'}] oldest first."""
    out, cur, ck = [], None, None
    for r in m15:
        m = _mod(r[0])
        if m < SESSION_START or m >= SESSION_END:
            continue
        b = (m - SESSION_START) // minutes
        key = r[0][:10] + ' ' + _hhmm(SESSION_START + b * minutes)
        if key != ck:
            if cur:
                out.append(cur)
            cur, ck = {'t': key, 'day': r[0][:10], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]}, key
        else:
            cur['h'] = max(cur['h'], r[2])
            cur['l'] = min(cur['l'], r[3])
            cur['c'] = r[4]
            cur['v'] += r[5]
    if cur:
        out.append(cur)
    return out


def daily_candles(day):
    return [{'t': r[0], 'day': r[0], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]} for r in day]


def group_days(day, kind):
    """Daily candles -> weekly (key = the week's Monday, like TradingView) or monthly ('YYYY-MM') candles; 'day' =
    the last session in it."""
    out, cur, ck = [], None, None
    for r in day:
        d = date.fromisoformat(r[0])
        key = (d - timedelta(days=d.weekday())).isoformat() if kind == 'W' else r[0][:7]
        if key != ck:
            if cur:
                out.append(cur)
            cur, ck = {'t': key, 'day': r[0], 'o': r[1], 'h': r[2], 'l': r[3], 'c': r[4], 'v': r[5]}, key
        else:
            cur['h'] = max(cur['h'], r[2])
            cur['l'] = min(cur['l'], r[3])
            cur['c'] = r[4]
            cur['v'] += r[5]
            cur['day'] = r[0]
    if cur:
        out.append(cur)
    return out


def timeframe_candles(store, tf):
    if tf in TF_MINUTES:
        return bucket_intraday(store.get('m15') or [], TF_MINUTES[tf])
    if tf == 'D':
        return daily_candles(store.get('day') or [])
    return group_days(store.get('day') or [], tf)


# ------------------------------------------------------------------ the sheet's rules (ports of web/lib)
def is_spring_pair(c1, c2, cfg=None):
    """web/lib/patterns.js isSpringPair = Code.gs ab_isSpringPair_: c1 a red candle with a real body, c2 dips under
    c1's low (by >= undercut %) and closes back above it with a small body, its high not above c1 low + reclaimMax % of
    c1's range. Candles {'o','h','l','c'}."""
    cfg = cfg or SPRING_CFG
    v = [c1.get('o'), c1.get('h'), c1.get('l'), c1.get('c'), c2.get('o'), c2.get('h'), c2.get('l'), c2.get('c')]
    if any(not isinstance(x, (int, float)) or isinstance(x, bool) or x != x for x in v):
        return False
    c1_body = abs(c1['c'] - c1['o'])
    c1_range = c1['h'] - c1['l']
    return ((c1['c'] < c1['o']) and
            (c1_body / c1['o'] >= cfg['bodyMin'] / 100) and
            (c2['l'] < c1['l']) and
            (c2['c'] > c1['l']) and
            (abs(c2['c'] - c2['o']) < (cfg['day2BodyMax'] / 100) * c1_body) and
            (c2['l'] <= c1['l'] * (1 - cfg['undercut'] / 100)) and
            (c2['h'] <= c1['l'] + (cfg['reclaimMax'] / 100) * c1_range))


SPRING_STEPS = (
    ('candle 1 is red', lambda a, b, g: a['c'] < a['o']),
    ('candle 1 body is at least %(bodyMin)s%% of its open', lambda a, b, g: abs(a['c'] - a['o']) / a['o'] >= g['bodyMin'] / 100),
    ('candle 2 low goes under candle 1 low', lambda a, b, g: b['l'] < a['l']),
    ('candle 2 closes back above candle 1 low', lambda a, b, g: b['c'] > a['l']),
    ('candle 2 body is under %(day2BodyMax)s%% of candle 1 body', lambda a, b, g: abs(b['c'] - b['o']) < g['day2BodyMax'] / 100 * abs(a['c'] - a['o'])),
    ('candle 2 low is at least %(undercut)s%% under candle 1 low', lambda a, b, g: b['l'] <= a['l'] * (1 - g['undercut'] / 100)),
    ('candle 2 high stays within candle 1 low + %(reclaimMax)s%% of candle 1 range', lambda a, b, g: b['h'] <= a['l'] + g['reclaimMax'] / 100 * (a['h'] - a['l'])),
)


def spring_explain(c1, c2, cfg=None):
    """[(condition, passed)] of the Spring rule - for IntradayCheck."""
    cfg = cfg or SPRING_CFG
    return [(name % cfg, bool(fn(c1, c2, cfg))) for name, fn in SPRING_STEPS]


def fvg_spring(candles, cfg=None):
    """web/lib/fvg.js longFvgDetail 'fvg-spring' events: a Spring pair (i-1, i) whose 2nd candle dips into a 3-candle
    bullish FVG formed before it (Low[g] > High[g-2], gap >= 0.70 x the 14-bar average range) that still holds - no close
    below its bottom from the gap to the pair (Low <= top, Close >= bottom). -> {i: (g, bottom, top)}; g = the oldest
    such gap, as the sheet's loop finds it. Needs 17 candles."""
    n = len(candles)
    out = {}
    if n < 17:
        return out
    min_dev = [float('nan')] * n
    for i in range(13, n):
        min_dev[i] = 0.70 * (sum(candles[k]['h'] - candles[k]['l'] for k in range(i - 13, i + 1)) / 14)
    up = [False] * n
    for i in range(2, n):
        if min_dev[i] == min_dev[i]:
            low, high2 = candles[i]['l'], candles[i - 2]['h']
            up[i] = low > high2 and (low - high2) >= min_dev[i]
    for i in range(3, n):
        if not is_spring_pair(candles[i - 1], candles[i], cfg):
            continue
        c2 = candles[i]
        for g in range(2, i - 1):
            if not up[g]:
                continue
            top, bottom = candles[g]['l'], candles[g - 2]['h']
            if not (c2['l'] <= top and c2['c'] >= bottom):
                continue
            if all(candles[k]['c'] >= bottom for k in range(g + 1, i - 1)):
                out[i] = (g, bottom, top)
                break
    return out


def springs(candles, cfg=None):
    return [i for i in range(1, len(candles)) if is_spring_pair(candles[i - 1], candles[i], cfg)]


# ------------------------------------------------------------------ sessions
def is_trading_day(d, holidays):
    return d.weekday() < 5 and d.isoformat() not in holidays


def prev_trading_day(d, holidays):
    d -= timedelta(days=1)
    while not is_trading_day(d, holidays):
        d -= timedelta(days=1)
    return d


def next_trading_day(d, holidays):
    d += timedelta(days=1)
    while not is_trading_day(d, holidays):
        d += timedelta(days=1)
    return d


def completed_session(now, holidays):
    """The newest session that has finished (after 15:40 IST) at `now` (an IST datetime)."""
    d = now.date()
    if is_trading_day(d, holidays) and (now.hour, now.minute) >= SESSION_CLOSE:
        return d
    return prev_trading_day(d, holidays)


def sessions_back(d, n, holidays):
    for _ in range(n):
        d = prev_trading_day(d, holidays)
    return d


def candle_complete(c, tf, upto, holidays):
    """Intraday and daily candles up to `upto` are finished; a week / month only once the next session is in the next one."""
    if tf in TF_MINUTES or tf == 'D':
        return c['day'] <= upto.isoformat()
    nxt = next_trading_day(upto, holidays)
    if tf == 'W':
        return (nxt - timedelta(days=nxt.weekday())).isoformat() > c['t']
    return nxt.isoformat()[:7] > c['t']


def scan(store, since_iso, upto, holidays, timeframes=DEFAULT_TIMEFRAMES, fvg_only=DEFAULT_FVG_ONLY, cfg=None):
    """The patterns of one stock on finished candles whose last session is after `since_iso` and not after `upto`.
    -> [{'tf', 'pattern', 'candle', 'session', 'low', 'close', 'zone': [bottom, top, formed] | None}]"""
    found = []
    for tf in timeframes:
        all_c = [c for c in timeframe_candles(store, tf) if candle_complete(c, tf, upto, holidays)]
        cs = all_c[-WINDOW.get(tf, 300):]
        if len(cs) < 2:
            continue
        fs = fvg_spring(cs, cfg)
        for i in range(1, len(cs)):
            c = cs[i]
            if c['day'] <= since_iso:
                continue
            if i in fs:
                g, bottom, top = fs[i]
                found.append({'tf': tf, 'pattern': 'Spring in FVG', 'candle': c['t'], 'session': c['day'],
                              'low': round(c['l'], 2), 'close': round(c['c'], 2),
                              'zone': [round(bottom, 2), round(top, 2), cs[g]['t']]})
            elif tf not in fvg_only and is_spring_pair(cs[i - 1], c, cfg):
                found.append({'tf': tf, 'pattern': 'Spring', 'candle': c['t'], 'session': c['day'],
                              'low': round(c['l'], 2), 'close': round(c['c'], 2), 'zone': None})
    return found


def tv_url(sym, tf):
    return 'https://www.tradingview.com/chart/?symbol=%s&interval=%s' % (urllib.parse.quote('NSE:' + sym, safe=''), TV_INTERVAL[tf])


# ------------------------------------------------------------------ state + the daily step
def state_load():
    try:
        with open(STATE_PATH, 'r', encoding='utf-8') as f:
            s = json.load(f)
        return s if isinstance(s, dict) else {}
    except (OSError, ValueError):
        return {}


def state_save(s):
    try:
        with open(STATE_PATH, 'w', encoding='utf-8') as f:
            json.dump(s, f, indent=1)
    except OSError:
        pass


def now_ist():
    return datetime.now(IST).replace(tzinfo=None)


def chosen_tfs(cfg):
    """The timeframes the daily scan reports, in TIMEFRAMES order."""
    want = cfg.get('intraday_timeframes') or DEFAULT_TIMEFRAMES
    return [t for t in TIMEFRAMES if t in want]


def due(cfg, holidays, now=None, state=None):
    """(True, upto) when the newest finished session is not scanned yet (or the timeframes changed since the last scan)
    and no login was asked for recently."""
    if not cfg.get('intraday', True) or not configured(cfg):
        return False, None
    now = now or now_ist()
    st = state if state is not None else state_load()
    upto = completed_session(now, holidays)
    if (st.get('scanned') or '') >= upto.isoformat() and st.get('tfs') == chosen_tfs(cfg):
        return False, upto
    if st.get('wait_login_until') and time.time() < float(st['wait_login_until']) and not session_valid(session_load()):
        return False, upto
    if time.time() - float(st.get('tried') or 0) < RETRY_S and not st.get('wait_login_until'):
        return False, upto
    return True, upto


def intraday_step(cfg, api, holidays=None, now=None, wait_s=LOGIN_WAIT_S, force=False, open_browser=True):
    """The daily scan: login -> the sheet's symbols -> Kite candles -> patterns -> the sheet. Never raises.
    api = screener_bridge.api (the sheet's web app). -> the number of patterns sent, or None when it did not run."""
    holidays = set(holidays or ())
    now = now or now_ist()
    st = state_load()
    try:
        if not configured(cfg):
            log('Kite: not set up - run KiteSetup.bat (your API key and secret from developers.kite.trade).')
            return None
        upto = completed_session(now, holidays)
        tfs = chosen_tfs(cfg)
        changed = bool(st.get('scanned')) and st.get('tfs') != tfs
        if not force and not changed and (st.get('scanned') or '') >= upto.isoformat():
            log('Kite: the session of %s is already scanned.' % upto.isoformat())
            return 0
        sess = session_load()
        if not session_valid(sess):
            day = now.date().isoformat()
            asked = st.get('logins') if isinstance(st.get('logins'), dict) else {}
            if not force and int(asked.get(day) or 0) >= LOGINS_PER_DAY:
                log('Kite: you were asked to log in %d times today - IntradayNow.bat starts it yourself.' % LOGINS_PER_DAY)
                st['wait_login_until'] = time.time() + LOGIN_RETRY_S
                return None
            st['logins'] = {day: int(asked.get(day) or 0) + 1}
            state_save(st)
            try:
                sess = login(cfg, wait_s=wait_s, open_browser=open_browser)
            except NeedLogin as e:
                sess = None
                log('Kite: the login was refused - %s' % e)
            if not sess:
                st['wait_login_until'] = time.time() + LOGIN_RETRY_S
                log('Kite: no login - the intraday scan waits; the login page opens again in %d hours '
                    '(or double-click IntradayNow.bat).' % (LOGIN_RETRY_S // 3600))
                return None
        st.pop('wait_login_until', None)
        st['tried'] = time.time()
        state_save(st)
        ans = api(cfg, 'intraday', {'op': 'syms'}, tries=2, timeout=120)
        if not ans.get('ok'):
            log('Kite: the sheet refused the symbol list - %s (did you paste the new Code.gs + Code2.gs and do the New '
                'version deploy?)' % ans.get('error'))
            return None
        syms = [str(s).strip().upper() for s in ans.get('syms') or [] if str(s).strip()]
        imap = instruments(cfg, sess, now.date().isoformat())
        since = (st.get('scanned') if not changed else None) or sessions_back(upto, FIRST_RUN_SESSIONS, holidays).isoformat()
        if changed:
            log('Kite: the timeframes are now %s - the last %d sessions are scanned again, and the sheet keeps only these '
                'timeframes.' % (', '.join(tfs), FIRST_RUN_SESSIONS))
        fvg_only = tuple(t for t in (cfg.get('intraday_fvg_only') if cfg.get('intraday_fvg_only') is not None
                                     else DEFAULT_FVG_ONLY) if t in TIMEFRAMES)
        t0, reqs, errors, in_row, nokite, items = time.time(), 0, 0, 0, [], []
        log('Kite: reading the candles of %d stocks up to %s (only new days after the first time) ...'
            % (len(syms), upto.isoformat()))
        for k, sym in enumerate(syms):
            tok = token_for(imap, sym)
            if tok is None:
                nokite.append(sym)
                continue
            try:
                store, n = update_symbol(cfg, sess, sym, tok, upto)
                reqs += n
                in_row = 0
            except NeedLogin:
                log('Kite: the permission ended part-way (it ends at 6 AM) - the scan carries on after the next login.')
                st['wait_login_until'] = 0
                return None
            except KiteError as e:
                errors += 1
                in_row += 1
                log('Kite: %s - %s' % (sym, e))
                if in_row >= ABORT_AFTER_ERRORS:
                    log('Kite: %d errors in a row - stopping this scan (the next one carries on).' % in_row)
                    return None
                continue
            for f in scan(store, since, upto, holidays, tfs, fvg_only):
                f['sym'] = sym
                items.append(f)
            if (k + 1) % 200 == 0:
                log('Kite: %d / %d stocks (%d requests, %.0f min)' % (k + 1, len(syms), reqs, (time.time() - t0) / 60))
        counts = {}
        for f in items:
            counts[f['tf'] + ' ' + f['pattern']] = counts.get(f['tf'] + ' ' + f['pattern'], 0) + 1
        log('Kite: %d stocks in %.0f min (%d requests%s%s). Found %d pattern(s)%s.'
            % (len(syms) - len(nokite), (time.time() - t0) / 60, reqs, ', %d errors' % errors if errors else '',
               ', not on Kite: ' + ', '.join(nokite[:12]) + (' ...' if len(nokite) > 12 else '') if nokite else '',
               len(items), ': ' + ', '.join('%s %d' % kv for kv in sorted(counts.items())) if counts else ''))
        sent, old_app = 0, False
        for p in range(0, max(1, len(items)), POST_ITEMS):
            part = items[p:p + POST_ITEMS]
            res = api(cfg, 'intraday', {'op': 'put', 'upto': upto.isoformat(), 'since': since, 'items': part, 'tfs': tfs,
                                        'last': p + POST_ITEMS >= len(items)}, tries=3, timeout=180)
            if not res.get('ok'):
                log('Kite: the sheet refused the patterns - %s' % res.get('error'))
                return None
            sent += int(res.get('added') or 0)
            old_app = old_app or 'tfs' not in res
        if old_app:
            log('Kite: the sheet\'s web app is an older version - rows of other timeframes stay on the tab until you paste the '
                'new Code2.gs and do the New version deploy (the next scan then clears them).')
        st['scanned'] = upto.isoformat()
        st['tfs'] = tfs
        st['last'] = {'at': datetime.now().strftime('%Y-%m-%d %H:%M'), 'stocks': len(syms) - len(nokite), 'found': len(items),
                      'requests': reqs, 'errors': errors}
        log('Kite: the sheet\'s "Intraday Patterns" tab has %d new row(s).' % sent)
        return len(items)
    except NeedLogin as e:
        log('Kite: %s - the scan carries on after the next login.' % e)
        return None
    except Exception as e:          # never stop the PC program
        log('Kite: unexpected problem - %s' % e)
        return None
    finally:
        state_save(st)


# ------------------------------------------------------------------ IntradayCheck.bat (nothing is sent)
def _fmt_c(c):
    return '%s  O %.2f  H %.2f  L %.2f  C %.2f' % (c['t'], c['o'], c['h'], c['l'], c['c'])


def check(cfg, args, holidays=None, out=print, now=None):
    """IntradayCheck.bat SYMBOL [TF] [YYYY-MM-DD]: reads the stock's Kite candles and shows every Spring / Spring in FVG
    of that timeframe in the window, and why the pairs on the date (or the last 20 with a red first candle) are or are not
    a Spring. Nothing is sent to the sheet."""
    holidays = set(holidays or ())
    args = [a for a in args if a.strip()]
    if not args:
        out('Type a symbol, e.g.  IntradayCheck.bat PARAGMILK 4H')
        return 1
    sym = args[0].strip().upper()
    tf = next((TF_ARGS[a.strip().upper()] for a in args[1:] if a.strip().upper() in TF_ARGS), '4H')
    on = next((a for a in args[1:] if re.match(r'^\d{4}-\d{2}-\d{2}$', a)), None)
    sess = ensure_session(cfg)
    if not sess:
        out('No Kite login - nothing to check.')
        return 1
    now = now or now_ist()
    upto = completed_session(now, holidays)
    imap = instruments(cfg, sess, now.date().isoformat())
    tok = token_for(imap, sym)
    if tok is None:
        out('%s is not in Kite\'s NSE equity list.' % sym)
        return 1
    store, _ = update_symbol(cfg, sess, sym, tok, upto)
    cs = [c for c in timeframe_candles(store, tf) if candle_complete(c, tf, upto, holidays)][-WINDOW[tf]:]
    out('%s %s - %d finished candles from Kite, %s to %s' % (sym, tf, len(cs), cs[0]['t'] if cs else '-', cs[-1]['t'] if cs else '-'))
    fs = fvg_spring(cs)
    hits = [(i, 'Spring in FVG' if i in fs else 'Spring') for i in springs(cs)]
    if hits:
        out('Found in this window:')
        for i, kind in hits:
            z = fs.get(i)
            out('  %-14s %s  (low %.2f, close %.2f)%s' % (kind, cs[i]['t'], cs[i]['l'], cs[i]['c'],
                ('  FVG %.2f - %.2f formed %s' % (z[1], z[2], cs[z[0]]['t'])) if z else ''))
    else:
        out('No Spring in this window.')
    pairs = [i for i in range(1, len(cs)) if (on and cs[i]['day'] == on) or (not on and cs[i - 1]['c'] < cs[i - 1]['o'])]
    if not on:
        pairs = pairs[-20:]
    out('\nWhy each pair is / is not a Spring (candle 1 -> candle 2):')
    for i in pairs:
        steps = spring_explain(cs[i - 1], cs[i])
        bad = [n for n, ok in steps if not ok]
        out('  %s  ->  %s' % (cs[i - 1]['t'], _fmt_c(cs[i])))
        out('     ' + ('SPRING' + (' in FVG' if i in fs else ' (no FVG holding under it)') if not bad else 'no: ' + '; '.join(bad)))
    out('\nTradingView: ' + tv_url(sym, tf))
    out('(nothing was sent to the sheet)')
    return 0


def setup(cfg, save_config, ask=input, ask_secret=None):
    """KiteSetup.bat: your Kite Connect app's API key and secret -> config.json, then a first login."""
    import getpass
    ask_secret = ask_secret or getpass.getpass
    print('=' * 64)
    print(' Zerodha Kite Connect - one-time setup')
    print('=' * 64)
    print('Open developers.kite.trade -> My apps -> your app. It shows the API key and the API secret.')
    print('The app\'s Redirect URL must be exactly:  ' + REDIRECT_URL + '\n')
    while True:
        key = ask('Paste the API KEY: ').strip()
        if re.match(r'^[A-Za-z0-9]{6,40}$', key):
            break
        print('  That does not look like an API key (letters and digits only). Try again.')
    while True:
        secret = ask_secret('Paste the API SECRET (it stays hidden while you paste - press Enter after it): ').strip()
        if re.match(r'^[A-Za-z0-9]{10,64}$', secret):
            break
        print('  That does not look like an API secret (letters and digits only). Try again.')
    cfg['kite_api_key'], cfg['kite_api_secret'] = key, secret
    cfg.setdefault('intraday', True)
    save_config(cfg)
    print('\nSaved in config.json on this computer only.')
    print('Now the Zerodha login page opens in your browser - log in with your Zerodha user ID, password and app code.')
    try:
        sess = login(cfg, wait_s=10 * 60)
    except (KiteError, NeedLogin) as e:
        print('PROBLEM - %s' % e)
        return 1
    if not sess:
        print('No login within 10 minutes. Run KiteSetup.bat again when you are ready.')
        return 1
    try:
        p = kite_req(cfg, sess, 'GET', '/user/profile')
        print('Connected to Kite as %s.' % (((p or {}).get('data') or {}).get('user_name') or sess.get('user') or 'you'))
    except (KiteError, NeedLogin) as e:
        print('Logged in, but the profile check failed - %s' % e)
        return 1
    print('All set. Each trading day after 3:40 PM (or the next time this computer is on) the program asks you to log in '
          'once and then reads the candles by itself.')
    return 0


def status_line(cfg):
    """TestConnection: one line about Kite (no login is started)."""
    if not configured(cfg):
        return 'not set up (KiteSetup.bat) - the intraday patterns are off'
    s = session_load()
    st = state_load()
    last = st.get('last') or {}
    return ('%s; last scan: %s' % ('logged in today as %s' % (s.get('user') or 'you') if session_valid(s) else
                                   'not logged in today (the program asks when it needs to)',
                                   ('%s - %s stocks, %s pattern(s)' % (last.get('at'), last.get('stocks'), last.get('found')))
                                   if last else 'none yet'))


class Runner:
    """The background program's intraday scan, in its own thread so the results checks go on meanwhile."""

    def __init__(self):
        self.thread = None

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_start(self, cfg, api, holidays, online=None):
        """Starts the scan when it is due (and, with `online`, only while the internet works - checked only then)."""
        if self.busy():
            return False
        ok, _ = due(cfg, holidays)
        if not ok or (online and not online()):
            return False
        self.thread = threading.Thread(target=intraday_step, args=(cfg, api, holidays), daemon=True)
        self.thread.start()
        return True
