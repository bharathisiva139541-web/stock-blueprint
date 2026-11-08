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
  4. looks for the sheet's Spring pattern and "Spring in FVG" (the sheet's FVG+Spring rule, owner 08-Nov-2026: the
     Spring candle anywhere on an FVG / Gap-up zone or under its bottom line, closing above the bottom, with no earlier
     close under the Spring low; taken off again when a later candle closes under it) - the same rules as Code.gs and
     the website (web/lib/patterns.js isSpringPair, web/lib/fvg.js longFvgDetail / springZone); on 4H
     also FVG First Touch / Confirmed / Twin Star Bottom + FVG and the untouched 4H FVG / Gap-up zones,
  5. sends what it found to the sheet's "Intraday Patterns" and "4H FVG Zones" tabs (action 'intraday'), and
  6. backtests every FVG+Spring of 4H / D / W on all stored candles (buy at the Spring close, stop under its low, win =
     2 x risk first, 20 candles) -> the sheet's "Spring Backtest" tabs (BacktestNow.bat runs only this, no login).

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
# a pattern counts only when its candle starts at one of these times (owner, 08-Nov-2026: "spring pattern to be tracked
# only 13.15 4hr candle only (i.e. 2nd 4hr candle of the day) not first one"); the FVG zones still come from every candle.
# config "intraday_slots" overrides it ({} = every candle)
DEFAULT_SLOTS = {'4H': ['13:15']}
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


GAPUP_MIN_PCT = 3            # Gap-up zones (Code.gs AB_GAPUP_MIN_PCT / the workbook's AB_GAPUP_MAX_PCT 5, web/lib/fvg.js DEFAULTS)
GAPUP_MAX_PCT = 5
CIRCUIT_LOCK_PCT = 0.05      # a candle whose range is <= 0.05 % never really traded (AB_CIRCUIT_LOCK_RANGE_PCT)
TSB = {'c1BodyMinPct': 1, 'starBodyMax': 0.35, 'starTopMax': 0.25, 'lowTolPct': 1}   # web/lib/patterns.js TSB
MIN_TURNOVER = 5000000       # AB_FVG_MIN_AVG_TURNOVER: thinner stocks get no 4H zones


def is_locked(c):
    """web/lib/fvg.js isCircuitLocked."""
    hi, lo = c['h'], c['l']
    if hi != hi or lo != lo or lo <= 0:
        return False
    return (hi - lo) / lo * 100 <= CIRCUIT_LOCK_PCT


def avg_turnover(candles):
    """web/lib/fvg.js avgTurnover (circuit-locked candles left out); None when nothing usable."""
    tot, n = 0.0, 0
    for c in candles:
        if is_locked(c):
            continue
        mid = (c['h'] + c['l']) / 2
        v = c.get('v')
        if mid != mid or mid <= 0 or v is None or v != v or v <= 0:
            continue
        tot += mid * v
        n += 1
    return tot / n if n else None


def is_twin_star_bottom(c1, c2, c3):
    """web/lib/patterns.js isTwinStarBottom = Code2.gs ab_isTwinStarBottom_."""
    body1 = c1['o'] - c1['c']
    if not body1 > 0 or body1 / c1['o'] * 100 < TSB['c1BodyMinPct']:
        return False

    def star(c):
        return abs(c['c'] - c['o']) <= TSB['starBodyMax'] * body1 and max(c['o'], c['c']) <= c1['c'] + TSB['starTopMax'] * body1
    return (star(c2) and star(c3) and c2['l'] > 0 and c3['l'] > 0 and
            abs(c2['l'] - c3['l']) <= TSB['lowTolPct'] / 100 * min(c2['l'], c3['l']) and c3['c'] >= c2['l'])


def fvg_gaps(candles):
    """3-candle bullish FVGs: up[i] when Low[i] > High[i-2] by >= 0.70 x the 14-bar average range (needs 14 bars)."""
    n = len(candles)
    up = [False] * n
    for i in range(13, n):
        if i < 2:
            continue
        dev = 0.70 * (sum(candles[k]['h'] - candles[k]['l'] for k in range(i - 13, i + 1)) / 14)
        low, high2 = candles[i]['l'], candles[i - 2]['h']
        up[i] = low > high2 and (low - high2) >= dev
    return up


def spring_zones(candles, up):
    """web/lib/fvg.js springZones: FVG and Gap-up zones oldest first -> [{'kind', 'f', 'bottom', 'top'}]."""
    out = []
    for f in range(1, len(candles)):
        if f >= 2 and up[f]:
            out.append({'kind': 'FVG', 'f': f, 'bottom': candles[f - 2]['h'], 'top': candles[f]['l']})
        a, b = candles[f - 1], candles[f]
        if is_locked(a) or is_locked(b) or not a['h'] > 0 or not b['l'] > a['h']:
            continue
        pct = (b['l'] - a['h']) / a['h'] * 100
        if GAPUP_MIN_PCT <= pct <= GAPUP_MAX_PCT:
            out.append({'kind': 'Gap-up', 'f': f, 'bottom': a['h'], 'top': b['l']})
    return out


class _RangeMin:
    """Smallest close of candles lo..hi (inclusive), in O(1) after an O(n log n) table."""

    def __init__(self, values):
        self.t = [list(values)]
        k = 1
        while 2 * k <= len(values):
            prev = self.t[-1]
            self.t.append([min(prev[j], prev[j + k]) for j in range(len(values) - 2 * k + 1)])
            k *= 2

    def min(self, lo, hi):
        if hi < lo:
            return float('inf')
        lvl = (hi - lo + 1).bit_length() - 1
        row = self.t[lvl]
        return min(row[lo], row[hi - (1 << lvl) + 1])


def _touch_starts(candles, z):
    """The candles that start a touch of a zone's top (a low at or under the top after the previous candle's low stayed
    above it), worked out once per zone."""
    if 'starts' not in z:
        top, f = z['top'], z['f']
        z['starts'] = [k for k in range(f + 1, len(candles))
                       if candles[k]['l'] <= top and (k == f + 1 or candles[k - 1]['l'] > top)]
    return z['starts']


def spring_zone(candles, i, zones, max_age=None, rmq=None):
    """web/lib/fvg.js springZone (owner, 08-Nov-2026): the oldest zone formed before the pair (f <= i-2; with `max_age`,
    at most that many candles back) where candle i's low is at or under the zone top (inside it, or under the bottom - any
    depth) and its close above the bottom, while every close from f+1 to i-2 stays at or above both the zone bottom (the
    zone holds) and candle i's low (no earlier close under the Spring low).
    -> {'kind', 'f', 'bottom', 'top', 'where': 'top'|'middle'|'bottom', 'touch'} or None."""
    c2 = candles[i]
    rmq = rmq or _RangeMin([c['c'] for c in candles])
    for z in zones:
        if z['f'] > i - 2:
            break
        if max_age is not None and i - z['f'] > max_age:
            continue
        top, bottom = z['top'], z['bottom']
        if not (c2['l'] <= top and c2['c'] > bottom):
            continue
        if rmq.min(z['f'] + 1, i - 2) < max(bottom, c2['l']):
            continue
        touch = sum(1 for k in _touch_starts(candles, z) if k <= i)
        where = 'bottom' if c2['l'] <= bottom else 'top' if c2['l'] >= (bottom + top) / 2 else 'middle'
        return {'kind': z['kind'], 'f': z['f'], 'bottom': bottom, 'top': top, 'where': where, 'touch': touch}
    return None


def spring_broken(candles, i):
    """web/lib/fvg.js springBroken: the first candle after i that closed below candle i's low (the Spring is no longer
    valid - the owner's rule: it leaves the sheet's list), or None."""
    low = candles[i]['l']
    return next((k for k in range(i + 1, len(candles)) if candles[k]['c'] < low), None)


def fvg_detail(candles, cfg=None, max_age=None):
    """web/lib/fvg.js longFvgDetail's events + gapUpFvgs on one timeframe's candles (oldest first):
    {'spring': {i: zone}, 'ft': {i: zone}, 'conf': {i: zone}, 'twin': {i: zone}, 'unmit': zone | None,
     'gapups': [zone], 'gapup_touch': [(i, zone)]}; a zone = {'kind', 'f', 'bottom', 'top', ...}. Needs 17 candles for
    the FVG events (Gap-ups: 2)."""
    n = len(candles)
    res = {'spring': {}, 'ft': {}, 'conf': {}, 'twin': {}, 'unmit': None, 'gapups': [], 'gapup_touch': []}
    # Gap-up zones (gapUpFvgs): untouched ones = watch zones; the first touch = mitigated
    for i in range(1, n):
        a, b = candles[i - 1], candles[i]
        if is_locked(a) or is_locked(b) or not a['h'] > 0 or b['l'] <= a['h']:
            continue
        pct = (b['l'] - a['h']) / a['h'] * 100
        if pct < GAPUP_MIN_PCT or pct > GAPUP_MAX_PCT:
            continue
        z = {'kind': 'Gap-up', 'f': i, 'bottom': a['h'], 'top': b['l'], 'pct': math.floor(pct * 100 + 0.5) / 100}
        hit = next((j for j in range(i + 1, n) if not is_locked(candles[j]) and candles[j]['l'] <= b['l']), None)
        if hit is None:
            res['gapups'].append(z)
        else:
            res['gapup_touch'].append((hit, z))
    res['gapups'].reverse()
    if n < 17:
        return res
    up = fvg_gaps(candles)
    top_at, bot_at, f_at = [None] * n, [None] * n, [None] * n
    cur = (None, None, None)
    for i in range(n):
        if up[i]:
            cur = (candles[i]['l'], candles[i - 2]['h'], i)
        top_at[i], bot_at[i], f_at[i] = cur
    cont2 = [False] * n
    cont2_high = [None] * n
    ch = None
    for i in range(1, n):
        if top_at[i - 1] is not None and top_at[i] is not None and candles[i - 1]['l'] >= top_at[i - 1] and candles[i]['l'] < top_at[i]:
            cont2[i] = True
        if cont2[i]:
            ch = candles[i]['h']
        cont2_high[i] = ch
    conf = [False] * n
    for i in range(1, n):
        if cont2_high[i - 1] is not None and cont2_high[i] is not None and candles[i - 1]['c'] <= cont2_high[i - 1] and candles[i]['c'] > cont2_high[i]:
            conf[i] = True

    def active(i):
        return {'kind': 'FVG', 'f': f_at[i], 'bottom': bot_at[i], 'top': top_at[i]}
    zones = spring_zones(candles, up)
    rmq = None
    for i in range(3, n):
        if is_spring_pair(candles[i - 1], candles[i], cfg):
            rmq = rmq or _RangeMin([c['c'] for c in candles])
            hit = spring_zone(candles, i, zones, max_age, rmq)
            if hit:
                hit['broken'] = spring_broken(candles, i)
                res['spring'][i] = hit
    for i in range(4, n):
        s1, s2 = candles[i - 1], candles[i]
        if not is_twin_star_bottom(candles[i - 2], s1, s2):
            continue
        star_low = min(s1['l'], s2['l'])
        for g in range(2, i - 2):
            if not up[g]:
                continue
            top, bottom = candles[g]['l'], candles[g - 2]['h']
            if not (star_low <= top and s1['c'] >= bottom and s2['c'] >= bottom):
                continue
            if all(candles[k]['c'] >= bottom for k in range(g + 1, i - 2)):
                res['twin'][i] = {'kind': 'FVG', 'f': g, 'bottom': bottom, 'top': top}
                break
    st = 0
    for i in range(n):
        c = 0 if st == 2 else st
        if up[i] and c == 0:
            c = 1
        if cont2[i] and c == 1:
            c = 2
        if c == 2:
            res['ft'][i] = active(i)
        st = c
    st = 0
    for i in range(n):
        c = 0 if st == 3 else st
        if up[i] and c == 0:
            c = 1
        if cont2[i] and c == 1:
            c = 2
        if conf[i] and c == 2:
            c = 3
        if c == 3:
            res['conf'][i] = active(i)
        st = c
    last = max((i for i in range(n) if up[i]), default=-1)
    if last != -1 and not any(cont2[i] for i in range(last + 1, n)):
        top, bottom = candles[last]['l'], candles[last - 2]['h']
        if bottom > 0 and top > bottom:
            res['unmit'] = {'kind': 'FVG', 'f': last, 'bottom': bottom, 'top': top,
                            'pct': math.floor((top - bottom) / bottom * 10000 + 0.5) / 100}
    return res


def fvg_spring(candles, cfg=None, max_age=None):
    """FVG+Spring (owner, 08-Nov-2026) on one timeframe: {i: {'kind', 'f', 'bottom', 'top', 'where', 'touch', 'broken'}} -
    the Spring pairs (i-1, i) on an FVG / Gap-up zone (spring_zone); 'broken' = the first later candle that closed below
    the Spring low (or None)."""
    n = len(candles)
    if n < 17:
        return {}
    zones = spring_zones(candles, fvg_gaps(candles))
    rmq = _RangeMin([c['c'] for c in candles])
    out = {}
    for i in range(3, n):
        if is_spring_pair(candles[i - 1], candles[i], cfg):
            hit = spring_zone(candles, i, zones, max_age, rmq)
            if hit:
                hit['broken'] = spring_broken(candles, i)
                out[i] = hit
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


NO_FVG_SPRING_TFS = ('M',)        # owner, 08-Nov-2026: FVG+Spring on 4H, D and W - the monthly chart gets the plain Spring only
FVG_PATTERN_TFS = ('4H',)          # ... and on 4H also the other FVG patterns + the FVG zones (mitigation alerts)
BACKTEST_TFS = ('4H', 'D', 'W')
SPRING_PATTERNS = ('Spring in FVG', 'Spring')   # only these follow the candle-time rule (4H: the 13:15 candle)
FVG_PATTERNS = (('ft', 'FVG First Touch'), ('conf', 'FVG First Touch Confirmed'), ('twin', 'Twin Star Bottom + FVG'))
RULES_VERSION = 3                  # a change rescans the last FIRST_RUN_SESSIONS sessions (3 = the 08-Nov-2026 FVG+Spring rule)
KEEP_DAYS = 30                     # = the sheet's AB_ITD_KEEP_DAYS: Spring in FVG rows a later close under the low takes off
BT_HORIZON = 20                    # backtest: a trade gets 20 candles to hit 2R or its stop
BT_RR = 2.0
BT_TRADES = 500                    # newest FVG+Spring trades listed on the sheet
TURNOVER_DAYS = 30                 # 4H zones: the liquidity filter looks at the last 30 daily candles


def zone_out(cs, z):
    """[bottom, top, formed candle, kind, where, touch] (where / touch only for FVG+Spring)."""
    out = [round(z['bottom'], 2), round(z['top'], 2), cs[z['f']]['t'], z['kind']]
    if 'where' in z:
        out += [z['where'], z['touch']]
    return out


def trade_2r(cs, i, horizon=BT_HORIZON, rr=BT_RR):
    """The owner's backtest (08-Nov-2026): buy at candle i's close, stop just under its low, target = close + 2 x risk;
    a WIN when a later candle reaches the target before any goes under the low, within `horizon` candles. A candle that
    does both counts as a loss (the order inside it is unknown). -> (result, R, candles) with result win / loss /
    timeout (R = where it closed after `horizon` candles) / open (fewer candles since); None without a risk."""
    entry, stop = cs[i]['c'], cs[i]['l']
    risk = entry - stop
    if not risk > 0:
        return None
    target = entry + rr * risk
    for j in range(i + 1, min(len(cs), i + 1 + horizon)):
        if cs[j]['l'] < stop:
            return ('loss', -1.0, j - i)
        if cs[j]['h'] >= target:
            return ('win', rr, j - i)
    if i + horizon < len(cs):
        return ('timeout', round((cs[i + horizon]['c'] - entry) / risk, 2), horizon)
    return ('open', None, len(cs) - 1 - i)


def _slot_ok(slots, tf, c):
    return not (slots and slots.get(tf)) or c['t'][11:16] in slots[tf]


def analyse(store, since_iso, upto, holidays, timeframes=DEFAULT_TIMEFRAMES, fvg_only=DEFAULT_FVG_ONLY, cfg=None, slots=None,
            backtest=False):
    """One stock: the patterns on finished candles whose last session is after `since_iso` (and not after `upto`), the
    4H FVG zones still untouched + the ones first touched in those sessions, and (backtest) the 2R outcome of every
    FVG+Spring and Spring of BACKTEST_TFS on all stored candles.
    -> {'items': [{'tf', 'pattern', 'candle', 'session', 'low', 'close', 'zone'}], 'zones': [...], 'mitigated': [...],
        'trades': [...FVG+Spring...], 'springs': [(tf, outcome)...every Spring...],
        'invalid': [{'tf', 'candle'}...Spring in FVG of the last KEEP_DAYS a later close under the Spring low broke]}"""
    out = {'items': [], 'zones': [], 'mitigated': [], 'trades': [], 'springs': [], 'invalid': []}
    keep_from = (upto - timedelta(days=KEEP_DAYS)).isoformat()
    for tf in timeframes:
        all_c = [c for c in timeframe_candles(store, tf) if candle_complete(c, tf, upto, holidays)]
        if len(all_c) < 2:
            continue
        win = WINDOW.get(tf, 300)
        d = fvg_detail(all_c, cfg, max_age=win) if tf not in NO_FVG_SPRING_TFS or tf in FVG_PATTERN_TFS else None
        first = max(1, len(all_c) - win)
        for i in range(first, len(all_c)):
            c = all_c[i]
            if c['day'] <= since_iso:
                continue
            base = {'tf': tf, 'candle': c['t'], 'session': c['day'], 'low': round(c['l'], 2), 'close': round(c['c'], 2)}
            if _slot_ok(slots, tf, c):
                sz = d['spring'].get(i) if d and tf not in NO_FVG_SPRING_TFS else None
                if sz and sz['broken'] is not None:
                    pass                    # a later candle closed below its low: no longer valid (owner, 08-Nov-2026)
                elif sz:
                    out['items'].append(dict(base, pattern='Spring in FVG', zone=zone_out(all_c, sz)))
                elif tf not in fvg_only and is_spring_pair(all_c[i - 1], c, cfg):
                    out['items'].append(dict(base, pattern='Spring', zone=None))
            if d and tf in FVG_PATTERN_TFS:
                for key, name in FVG_PATTERNS:
                    z = d[key].get(i)
                    if z and z['f'] is not None:
                        out['items'].append(dict(base, pattern=name, zone=zone_out(all_c, z)))
        if d and tf not in NO_FVG_SPRING_TFS:
            # Spring in FVG rows the sheet may hold (the last KEEP_DAYS) that a later close under the Spring low broke
            for i, sz in d['spring'].items():
                if sz['broken'] is not None and all_c[i]['day'] >= keep_from and _slot_ok(slots, tf, all_c[i]):
                    out['invalid'].append({'tf': tf, 'candle': all_c[i]['t']})
        if d and tf in FVG_PATTERN_TFS:
            day = [c for c in daily_candles(store.get('day') or []) if c['day'] <= upto.isoformat()][-TURNOVER_DAYS:]
            t = avg_turnover(day)
            if t is None or t >= MIN_TURNOVER:
                for z in ([d['unmit']] if d['unmit'] else []) + d['gapups']:
                    out['zones'].append({'tf': tf, 'zone': zone_out(all_c, z), 'pct': z['pct']})
            touched = [(i, z) for i, z in d['ft'].items()] + d['gapup_touch']
            for i, z in touched:
                if all_c[i]['day'] > since_iso and z['f'] is not None:
                    out['mitigated'].append({'tf': tf, 'zone': zone_out(all_c, z), 'candle': all_c[i]['t'],
                                             'low': round(all_c[i]['l'], 2)})
        if backtest and tf in BACKTEST_TFS:
            for i in range(3, len(all_c)):
                c = all_c[i]
                if not _slot_ok(slots, tf, c) or not is_spring_pair(all_c[i - 1], c, cfg):
                    continue
                res = trade_2r(all_c, i)
                if res is None:
                    continue
                out['springs'].append((tf, c['t'], res))
                sz = d['spring'].get(i) if d and tf not in NO_FVG_SPRING_TFS else None
                if sz:
                    out['trades'].append({'tf': tf, 'candle': c['t'], 'session': c['day'], 'zone': sz['kind'], 'where': sz['where'],
                                          'touch': sz['touch'], 'result': res[0], 'r': res[1], 'bars': res[2]})
    return out


def scan(store, since_iso, upto, holidays, timeframes=DEFAULT_TIMEFRAMES, fvg_only=DEFAULT_FVG_ONLY, cfg=None, slots=None):
    """The patterns of one stock (analyse's 'items')."""
    return analyse(store, since_iso, upto, holidays, timeframes, fvg_only, cfg, slots)['items']


BT_GROUPS = (('fvg', 'FVG+Spring'), ('top', 'FVG+Spring - zone top'), ('middle', 'FVG+Spring - zone middle'),
             ('bottom', 'FVG+Spring - zone bottom'), ('spring', 'Spring (every one, for comparison)'))


def bt_summary(trades, springs, tfs=BACKTEST_TFS):
    """Win rate per timeframe: FVG+Spring (all / zone top / middle / bottom) and every Spring. -> [row dicts]."""
    agg = {}

    def add(tf, g, when, res):
        a = agg.setdefault((tf, g), {'n': 0, 'win': 0, 'loss': 0, 'timeout': 0, 'open': 0, 'r': 0.0, 'rn': 0, 'from': when, 'to': when})
        a['n'] += 1
        a[res[0]] += 1
        if res[1] is not None:
            a['r'] += res[1]
            a['rn'] += 1
        a['from'], a['to'] = min(a['from'], when), max(a['to'], when)
    for t in trades:
        res = (t['result'], t['r'], t['bars'])
        add(t['tf'], 'fvg', t['candle'], res)
        add(t['tf'], t['where'], t['candle'], res)
    for tf, when, res in springs:
        add(tf, 'spring', when, res)
    rows = []
    for tf in tfs:
        for g, name in BT_GROUPS:
            a = agg.get((tf, g))
            if not a:
                rows.append({'tf': tf, 'group': name, 'signals': 0, 'wins': 0, 'losses': 0, 'timeouts': 0, 'open': 0,
                             'winRate': None, 'avgR': None, 'from': '', 'to': ''})
                continue
            closed = a['win'] + a['loss']
            rows.append({'tf': tf, 'group': name, 'signals': a['n'], 'wins': a['win'], 'losses': a['loss'], 'timeouts': a['timeout'],
                         'open': a['open'], 'winRate': round(a['win'] * 100.0 / closed, 1) if closed else None,
                         'avgR': round(a['r'] / a['rn'], 2) if a['rn'] else None, 'from': a['from'], 'to': a['to']})
    return rows


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


def chosen_slots(cfg, tfs=None):
    """{timeframe: ['HH:MM', ...]} of the timeframes scanned whose patterns count only at those candle times."""
    raw = cfg.get('intraday_slots')
    raw = DEFAULT_SLOTS if raw is None else raw
    tfs = tfs if tfs is not None else chosen_tfs(cfg)
    out = {}
    if isinstance(raw, dict):
        for tf, times in raw.items():
            if tf in TF_MINUTES and tf in tfs and isinstance(times, (list, tuple)):
                ok = sorted({str(t) for t in times if re.match(r'^\d{2}:\d{2}$', str(t))})
                if ok:
                    out[tf] = ok
    return out


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
    if ((st.get('scanned') or '') >= upto.isoformat() and st.get('tfs') == chosen_tfs(cfg) and (st.get('slots') or {}) == chosen_slots(cfg)
            and st.get('rules') == RULES_VERSION):
        return False, upto
    if st.get('wait_login_until') and time.time() < float(st['wait_login_until']) and not session_valid(session_load()):
        return False, upto
    if time.time() - float(st.get('tried') or 0) < RETRY_S and not st.get('wait_login_until'):
        return False, upto
    return True, upto


def send_zones(cfg, api, upto, since, zones, mitigated):
    """The 4H FVG zones still untouched (+ the ones first touched since the last scan) -> the sheet's "4H FVG Zones" tab
    (the sheet watches them during market hours for the hourly mitigated email). Never raises."""
    try:
        res = api(cfg, 'intraday', {'op': 'zones', 'upto': upto.isoformat(), 'since': since, 'tf': '4H', 'zones': zones,
                                    'mitigated': mitigated}, tries=3, timeout=180)
        if res.get('ok'):
            log('Kite: 4H FVG zones -> the sheet: %d watched%s.' % (int(res.get('kept') or 0),
                ', %d first touched since the last scan (%d emailed with the next mitigated email)' % (len(mitigated), int(res.get('logged') or 0))
                if mitigated else ''))
        else:
            log('Kite: the sheet refused the 4H FVG zones - %s (paste the new Code.gs + Code2.gs and do the New version deploy)'
                % res.get('error'))
    except Exception as e:          # never stop the scan
        log('Kite: 4H FVG zones not sent - %s' % e)


def bt_log(rows):
    """One line per timeframe: FVG+Spring signals and win rate (+ every Spring for comparison)."""
    by = {}
    for r in rows:
        by.setdefault(r['tf'], {})[r['group']] = r
    out = []
    for tf in BACKTEST_TFS:
        g = by.get(tf) or {}
        f, sp = g.get(BT_GROUPS[0][1]), g.get(BT_GROUPS[4][1])
        if not f:
            continue
        rate = lambda r: ('%.1f%%' % r['winRate']) if r and r['winRate'] is not None else '-'
        out.append('%s FVG+Spring %d signals, win rate %s (top %s, middle %s, bottom %s; every Spring %s)'
                   % (tf, f['signals'], rate(f), rate(g.get(BT_GROUPS[1][1])), rate(g.get(BT_GROUPS[2][1])),
                      rate(g.get(BT_GROUPS[3][1])), rate(sp)))
    return out


def send_backtest(cfg, api, upto, trades, springs_bt):
    """The 2R backtest of every FVG+Spring (4H / D / W, all stored candles) -> the sheet's "Spring Backtest" tabs."""
    try:
        rows = bt_summary(trades, springs_bt)
        for line in bt_log(rows):
            log('Kite backtest (2R before the stop, %d candles): %s' % (BT_HORIZON, line))
        newest = sorted(trades, key=lambda t: (t['candle'], t['sym']), reverse=True)[:BT_TRADES]
        res = api(cfg, 'intraday', {'op': 'backtest', 'upto': upto.isoformat(), 'rows': rows, 'trades': newest,
                                    'horizon': BT_HORIZON, 'rr': BT_RR, 'total': len(trades)}, tries=3, timeout=180)
        if not res.get('ok'):
            log('Kite: the sheet refused the backtest - %s (paste the new Code.gs + Code2.gs and do the New version deploy)'
                % res.get('error'))
        return rows
    except Exception as e:          # never stop the scan
        log('Kite: backtest not sent - %s' % e)
        return None


def backtest_now(cfg, api, holidays=None, now=None, out=print):
    """BacktestNow.bat: the backtest on the candles already stored in intraday_data (no Kite login), sent to the sheet."""
    holidays = set(holidays or ())
    st = state_load()
    try:
        upto = date.fromisoformat(st['scanned']) if st.get('scanned') else completed_session(now or now_ist(), holidays)
    except ValueError:
        upto = completed_session(now or now_ist(), holidays)
    names = sorted(f for f in os.listdir(DATA_DIR) if f.endswith('.json.gz')) if os.path.isdir(DATA_DIR) else []
    if not names:
        out('No stored Kite candles yet - the first intraday scan (IntradayNow.bat) reads them.')
        return 1
    slots = chosen_slots(cfg, list(BACKTEST_TFS))
    trades, springs_bt, t0 = [], [], time.time()
    out('Backtest of FVG+Spring on %d stocks (4H, D, W; candles up to %s) ...' % (len(names), upto.isoformat()))
    for k, name in enumerate(names):
        try:
            with gzip.open(os.path.join(DATA_DIR, name), 'rt', encoding='utf-8') as f:
                store = json.load(f)
        except (OSError, ValueError, EOFError):
            continue
        sym = str(store.get('sym') or name[:-8])
        res = analyse(store, '9999-12-31', upto, holidays, BACKTEST_TFS, (), slots=slots, backtest=True)
        for t in res['trades']:
            t['sym'] = sym
            trades.append(t)
        springs_bt.extend(res['springs'])
        if (k + 1) % 300 == 0:
            out('  %d / %d stocks (%.0f s)' % (k + 1, len(names), time.time() - t0))
    rows = send_backtest(cfg, api, upto, trades, springs_bt) or bt_summary(trades, springs_bt)
    out('\nWin rate = target (2 x risk) reached before the stop (just under the Spring candle\'s low), within %d candles:' % BT_HORIZON)
    for line in bt_log(rows):
        out('  ' + line)
    out('\nThe sheet\'s "Spring Backtest" tab has every number; the website shows them under Signals.')
    return 0


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
        slots = chosen_slots(cfg, tfs)
        changed = bool(st.get('scanned')) and (st.get('tfs') != tfs or (st.get('slots') or {}) != slots or st.get('rules') != RULES_VERSION)
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
            log('Kite: %s - the last %d sessions are scanned again, and the sheet keeps only these.'
                % ('new pattern rules (FVG+Spring: anywhere on the zone or under it, no earlier close under the Spring low; 4H FVG patterns + zones)'
                   if st.get('rules') != RULES_VERSION and st.get('tfs') == tfs and (st.get('slots') or {}) == slots else
                   'the timeframes are now %s%s' % (', '.join(tfs), ''.join(' (%s: only the %s candle)' % (t, ' / '.join(v))
                                                                          for t, v in sorted(slots.items()))),
                   FIRST_RUN_SESSIONS))
        fvg_only = tuple(t for t in (cfg.get('intraday_fvg_only') if cfg.get('intraday_fvg_only') is not None
                                     else DEFAULT_FVG_ONLY) if t in TIMEFRAMES)
        t0, reqs, errors, in_row, nokite, items = time.time(), 0, 0, 0, [], []
        zones, mitigated, trades, springs_bt, invalid = [], [], [], [], []
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
            res = analyse(store, since, upto, holidays, tfs, fvg_only, slots=slots, backtest=True)
            for key, dest in (('items', items), ('zones', zones), ('mitigated', mitigated), ('trades', trades), ('invalid', invalid)):
                for f in res[key]:
                    f['sym'] = sym
                    dest.append(f)
            springs_bt.extend(res['springs'])
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
            res = api(cfg, 'intraday', {'op': 'put', 'upto': upto.isoformat(), 'since': since, 'items': part, 'tfs': tfs, 'slots': slots,
                                        'first': p == 0, 'last': p + POST_ITEMS >= len(items), 'rules': RULES_VERSION,
                                        'invalid': invalid if p == 0 else []},
                      tries=3, timeout=180)
            if not res.get('ok'):
                log('Kite: the sheet refused the patterns - %s' % res.get('error'))
                return None
            sent += int(res.get('added') or 0)
            if p == 0 and res.get('removed'):
                log('Kite: %d Spring in FVG row(s) taken off the sheet - a later candle closed below the Spring low.' % int(res['removed']))
            old_app = old_app or 'tfs' not in res or 'slots' not in res
        if old_app:
            log('Kite: the sheet\'s web app is an older version - rows of other timeframes / candles stay on the tab until you '
                'paste the new Code2.gs and do the New version deploy (the next scan then clears them).')
        if '4H' in tfs:
            send_zones(cfg, api, upto, since, zones, mitigated)
        send_backtest(cfg, api, upto, trades, springs_bt)
        st['scanned'] = upto.isoformat()
        st['tfs'] = tfs
        st['slots'] = slots
        st['rules'] = RULES_VERSION
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
    fs = fvg_spring(cs) if tf not in NO_FVG_SPRING_TFS else {}
    hits = [(i, 'Spring in FVG' if i in fs else 'Spring') for i in springs(cs)]
    if hits:
        out('Found in this window:')
        for i, kind in hits:
            z = fs.get(i)
            out('  %-14s %s  (low %.2f, close %.2f)%s' % (kind, cs[i]['t'], cs[i]['l'], cs[i]['c'],
                ('  %s of %s %.2f - %.2f formed %s (touch %d)%s' % (z['where'], 'the FVG' if z['kind'] == 'FVG' else 'the Gap-up',
                                                                    z['bottom'], z['top'], cs[z['f']]['t'], z['touch'],
                                                                    ' - BROKEN: %s closed below its low' % cs[z['broken']]['t']
                                                                    if z['broken'] is not None else '')) if z else ''))
    else:
        out('No Spring in this window.')
    if tf in FVG_PATTERN_TFS:
        d = fvg_detail(cs)
        ev = sorted([(i, name, d[key][i]) for key, name in FVG_PATTERNS for i in d[key]], key=lambda x: x[0])[-12:]
        if ev:
            out('FVG patterns (the newest 12):')
            for i, name, z in ev:
                out('  %-26s %s  zone %.2f - %.2f formed %s' % (name, cs[i]['t'], z['bottom'], z['top'], cs[z['f']]['t']))
        zs = ([d['unmit']] if d['unmit'] else []) + d['gapups']
        out('Untouched %s zones now: %s' % (tf, '; '.join('%s %.2f - %.2f formed %s' % (z['kind'], z['bottom'], z['top'], cs[z['f']]['t'])
                                                         for z in zs) or 'none'))
    pairs = [i for i in range(1, len(cs)) if (on and cs[i]['day'] == on) or (not on and cs[i - 1]['c'] < cs[i - 1]['o'])]
    if not on:
        pairs = pairs[-20:]
    out('\nWhy each pair is / is not a Spring (candle 1 -> candle 2):')
    for i in pairs:
        steps = spring_explain(cs[i - 1], cs[i])
        bad = [n for n, ok in steps if not ok]
        out('  %s  ->  %s' % (cs[i - 1]['t'], _fmt_c(cs[i])))
        out('     ' + ('SPRING' + ((' in FVG (%s)' % fs[i]['where'] + (' - no longer valid: %s closed below its low' % cs[fs[i]['broken']]['t']
                                                                  if fs[i]['broken'] is not None else '')) if i in fs else
                                     ' (not on an FVG / Gap-up zone that holds, or an earlier candle closed below its low)')
                         if not bad else 'no: ' + '; '.join(bad)))
    out('\nTradingView: ' + tv_url(sym, tf))
    out('(nothing was sent to the sheet)')
    return 0


# ------------------------------------------------------------------ LiveNow.bat: Kite live prices -> the sheet's "Kite Live" tab
LIVE_GAP_S = 60             # one round of prices a minute (config "kite_live_seconds", at least 15)
LIVE_BATCH = 250            # instruments per quote request (Kite allows 1000; shorter links are safer)
LIVE_QUOTE_GAP_S = 1.05     # Kite: 1 quote request a second
LIVE_MAX_HOURS = 4          # started on a non-trading day (the Muhurat session): stops after 4 hours
LIVE_STOP = (15, 35)        # on a trading day: stops at 15:35 IST
LIVE_FROM = (9, 10)         # the background program starts it on a trading day from 09:10 IST (config "kite_live": false = off)
LIVE_LOGINS_PER_DAY = 3     # login pages the background program opens for it a day
LIVE_RETRY_S = 30 * 60      # a background run that stopped early (no login / a problem) starts again 30 minutes later
LIVE_LOG_EVERY = 15         # the background run writes a price line to bridge.log every 15 rounds (problems at once)
LIVE_MARK_PATH = os.path.join(HERE, 'kite_live.json')   # {pid, at}: only one copy sends prices (LiveNow.bat or the background)


def quote_key(imap, sym):
    """'NSE:SYMBOL' as Kite's quote API knows it (BE / BZ series: SYMBOL-BE / SYMBOL-BZ), or None."""
    for k in (sym, sym + '-BE', sym + '-BZ'):
        if k in imap:
            return 'NSE:' + k
    return None


def live_quotes(cfg, sess, keys):
    """{'NSE:SYM': SYM} -> {SYM: [last price, open, high, low, previous close]} from Kite's /quote/ohlc."""
    out = {}
    ks = sorted(keys)
    for p in range(0, len(ks), LIVE_BATCH):
        _throttle(LIVE_QUOTE_GAP_S)
        j = kite_req(cfg, sess, 'GET', '/quote/ohlc', params=[('i', k) for k in ks[p:p + LIVE_BATCH]], throttle=False)
        for k, q in ((j or {}).get('data') or {}).items():
            sym = keys.get(k)
            if not sym or not isinstance(q, dict):
                continue
            o = q.get('ohlc') or {}
            v = [_num(q.get('last_price')), _num(o.get('open')), _num(o.get('high')), _num(o.get('low')), _num(o.get('close'))]
            if v[0]:
                out[sym] = [round(x, 2) if x else None for x in v]
    return out


def _live_mark(check=False):
    """check: True when another program sent prices in the last 2.5 minutes (it is still running). Else marks ours."""
    if check:
        try:
            with open(LIVE_MARK_PATH, 'r', encoding='utf-8') as f:
                m = json.load(f)
            return int(m.get('pid') or 0) != os.getpid() and time.time() - float(m.get('at') or 0) < 150
        except (OSError, ValueError, AttributeError, TypeError):
            return False
    try:
        with open(LIVE_MARK_PATH, 'w', encoding='utf-8') as f:
            json.dump({'pid': os.getpid(), 'at': time.time()}, f)
    except OSError:
        pass
    return False


def live_due(cfg, holidays, now=None):
    """The background program's live prices: on (config "kite_live", default on, Kite set up), a trading day, 09:10-15:35."""
    if not cfg.get('kite_live', True) or not configured(cfg):
        return False
    now = now or now_ist()
    m = now.hour * 60 + now.minute
    return is_trading_day(now.date(), set(holidays or ())) and LIVE_FROM[0] * 60 + LIVE_FROM[1] <= m < LIVE_STOP[0] * 60 + LIVE_STOP[1]


def live(cfg, api, holidays=None, out=print, now_fn=None, sleep=time.sleep, max_rounds=None, background=False):
    """LiveNow.bat (owner, 08-Nov-2026, Muhurat session): Kite's live prices of the sheet's stocks every minute ->
    the sheet's "Kite Live" tab (action 'kitelive'). Nothing else on the sheet changes. Runs until 15:35 on a trading
    day, LIVE_MAX_HOURS on any other day, or until this window is closed."""
    holidays = set(holidays or ())
    now_fn = now_fn or now_ist
    if not configured(cfg):
        out('Kite is not set up - run KiteSetup.bat first.')
        return 1
    gap = max(15, int(cfg.get('kite_live_seconds') or LIVE_GAP_S))
    if _live_mark(check=True):
        out('Kite live prices are already being sent (LiveNow.bat or the background program) - this copy stops.')
        return 0
    try:
        sess = ensure_session(cfg)
        if not sess:
            out('No Kite login - nothing to show. Run LiveNow.bat again and log in on the Zerodha page.')
            return 1
        ans = api(cfg, 'intraday', {'op': 'syms'}, tries=2, timeout=120)
        if not ans.get('ok'):
            out('The sheet refused the symbol list - %s' % ans.get('error'))
            return 1
        syms = [str(x).strip().upper() for x in ans.get('syms') or [] if str(x).strip()]
        now = now_fn()
        imap = instruments(cfg, sess, now.date().isoformat())
        keys, missing = {}, []
        for sym in syms:
            k = quote_key(imap, sym)
            if k:
                keys[k] = sym
            else:
                missing.append(sym)
        trading = is_trading_day(now.date(), holidays)
        stop_at = (now.replace(hour=LIVE_STOP[0], minute=LIVE_STOP[1], second=0, microsecond=0) if trading
                   else now + timedelta(hours=LIVE_MAX_HOURS))
        out('Kite live prices of %d stocks -> the sheet\'s "Kite Live" tab every %d seconds, until %s%s.'
            % (len(keys), gap, stop_at.strftime('%d-%b %H:%M'), '' if background else ' (or close this window)'))
        if missing:
            out('Not on Kite: %s' % ', '.join(missing[:12]) + (' ...' if len(missing) > 12 else ''))
        rounds = 0
        while True:
            t0 = time.time()
            try:
                q = live_quotes(cfg, sess, keys)
            except NeedLogin:
                out('Kite asks for a new login (it ends at 6 AM) - the login page opens.')
                sess = ensure_session(cfg)
                if not sess:
                    out('No login - stopped.')
                    return 1
                continue
            except KiteError as e:
                out('%s  Kite: %s - trying again in a minute' % (now_fn().strftime('%H:%M:%S'), e))
                q = None
            if q:
                if _live_mark(check=True):
                    out('Another copy is sending Kite live prices now - this one stops.')
                    return 0
                _live_mark()
                at = now_fn().strftime('%Y-%m-%d %H:%M:%S')
                res = api(cfg, 'kitelive', {'at': at, 'items': [[s_] + v for s_, v in q.items()]}, tries=2, timeout=90)
                if not res.get('ok'):
                    err = str(res.get('error'))
                    out('%s  The sheet refused the prices - %s' % (at[11:], err))
                    if 'unknown action' in err or 'items missing' in err:
                        out('Paste the new Code.gs + Code2.gs, do the New version deploy, then run LiveNow.bat again.')
                        return 1
                else:
                    moves = sorted(((v[0] - v[4]) / v[4] * 100, s_) for s_, v in q.items() if v[0] and v[4])
                    top = ', '.join('%s %+.1f%%' % (s_, m) for m, s_ in reversed(moves[-3:]))
                    if not background or rounds % LIVE_LOG_EVERY == 0:
                        out('%s  %d prices -> Kite Live (%s up / %s down)%s' % (at[11:], int(res.get('written') or 0), res.get('up'),
                                                                             res.get('down'), ('; top: ' + top) if top else ''))
            rounds += 1
            if (max_rounds and rounds >= max_rounds) or now_fn() >= stop_at:
                out('Stopped (%s). The "Kite Live" tab keeps the last prices.' % ('done' if max_rounds and rounds >= max_rounds
                                                                                    else 'market time over'))
                return 0
            sleep(max(5.0, gap - (time.time() - t0)))
    except KeyboardInterrupt:
        out('Stopped. The "Kite Live" tab keeps the last prices.')
        return 0
    except (KiteError, NeedLogin) as e:
        out('PROBLEM - %s' % e)
        return 1


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
    """The background program's intraday scan and (owner, 08-Nov-2026) the day's Kite live prices, each in its own
    thread so the results checks go on meanwhile."""

    def __init__(self):
        self.thread = None
        self.live_thread = None
        self.live_next = 0.0
        self.live_day = ''
        self.live_logins = 0

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def live_busy(self):
        return bool(self.live_thread and self.live_thread.is_alive())

    def maybe_start_live(self, cfg, api, holidays, online=None, now=None):
        """Starts the live prices on a trading day 09:10-15:35 (the Kite login page opens when today's login is missing,
        at most LIVE_LOGINS_PER_DAY times); a run that stopped early starts again LIVE_RETRY_S later."""
        if self.live_busy() or time.time() < self.live_next:
            return False
        now = now or now_ist()
        if not live_due(cfg, holidays, now) or (online and not online()):
            return False
        day = now.date().isoformat()
        if day != self.live_day:
            self.live_day, self.live_logins = day, 0
        if not session_valid(session_load()):
            if self.live_logins >= LIVE_LOGINS_PER_DAY:
                return False
            self.live_logins += 1
        self.live_next = time.time() + LIVE_RETRY_S
        self.live_thread = threading.Thread(target=live, args=(cfg, api, holidays),
                                            kwargs={'out': lambda m: log('Kite live: ' + m), 'background': True}, daemon=True)
        self.live_thread.start()
        return True

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
