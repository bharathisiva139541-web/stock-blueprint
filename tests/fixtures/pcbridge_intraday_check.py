"""Offline checks for the PC bridge's Zerodha Kite part (pcbridge/ScreenerBridge/kite_intraday.py): the candles of every
timeframe built from 15-minute / daily candles, the finished-session rules, the Kite login (a pretend login page sending
the request token to the local page), the incremental download (and a split -> everything read again), and a whole scan
where a PARAGMILK-like 4H "Spring in FVG" must be found and sent to a pretend sheet. A fake _http plays Kite. No network.
Run by tests/pcbridge-intraday.test.js (prints OK on success, raises on failure)."""
import hashlib
import importlib.util
import json
import os
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)

TMP = tempfile.mkdtemp()
K.SESSION_PATH = os.path.join(TMP, 'kite_session.json')
K.STATE_PATH = os.path.join(TMP, 'intraday_state.json')
K.INSTR_PATH = os.path.join(TMP, 'kite_instruments.json')
K.DATA_DIR = os.path.join(TMP, 'intraday_data')
K.REQ_GAP_S = 0
K.REDIRECT_PORT = 18765 + os.getpid() % 1000
LOGS = []
K.log = lambda m: LOGS.append(m)
real_sleep = time.sleep
K.time.sleep = lambda s: None
K.webbrowser.open = lambda url: OPENED.append(url)
OPENED = []

HOL = {'2026-10-21'}   # a weekday holiday (Diwali Laxmi Pujan in this pretend year)


def d(s):
    return date.fromisoformat(s)


# ------------------------------------------------------------------ 1. sessions
assert K.completed_session(datetime(2026, 11, 6, 15, 39), HOL) == d('2026-11-05'), 'before 15:40: the session before'
assert K.completed_session(datetime(2026, 11, 6, 15, 40), HOL) == d('2026-11-06')
assert K.completed_session(datetime(2026, 11, 8, 10, 0), HOL) == d('2026-11-06'), 'Sunday -> Friday'
assert K.completed_session(datetime(2026, 10, 22, 9, 0), HOL) == d('2026-10-20'), 'the holiday is skipped'
assert K.next_trading_day(d('2026-10-20'), HOL) == d('2026-10-22')
assert K.sessions_back(d('2026-11-06'), 10, HOL) == d('2026-10-23')

# ------------------------------------------------------------------ 2. candles of every timeframe
def m15_day(day, base):
    rows, m = [], 9 * 60 + 15
    for k in range(25):                      # 09:15 ... 15:15 (25 x 15 minutes)
        o = base + k
        rows.append(['%s %02d:%02d' % (day, m // 60, m % 60), o, o + 2, o - 1, o + 1, 100])
        m += 15
    return rows


M15 = m15_day('2026-11-05', 100) + m15_day('2026-11-06', 200)
f4 = K.bucket_intraday(M15, 240)
assert [c['t'] for c in f4] == ['2026-11-05 09:15', '2026-11-05 13:15', '2026-11-06 09:15', '2026-11-06 13:15'], f4
a = f4[0]
assert (a['o'], a['h'], a['l'], a['c'], a['v']) == (100, 117, 99, 116, 1600), a          # 16 candles 09:15-13:00
b = f4[1]
assert (b['o'], b['h'], b['l'], b['c'], b['v']) == (116, 126, 115, 125, 900), b          # 9 candles 13:15-15:15
assert [c['t'][11:] for c in K.bucket_intraday(M15, 120)][:4] == ['09:15', '11:15', '13:15', '15:15']
h1 = K.bucket_intraday(M15, 60)
assert [c['t'][11:] for c in h1][:7] == ['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15'] and h1[6]['v'] == 100
assert len(K.bucket_intraday(M15, 30)) == 26 and len(K.bucket_intraday(M15, 15)) == 50
assert K.bucket_intraday([['2026-11-05 09:00', 1, 2, 1, 2, 5]] + M15[:1], 15)[0]['t'] == '2026-11-05 09:15', 'pre-open left out'

DAYS = [['2026-10-29', 10, 12, 9, 11, 1], ['2026-10-30', 11, 13, 10, 12, 1], ['2026-11-02', 12, 15, 11, 14, 1],
        ['2026-11-06', 14, 16, 13, 15, 1]]
w = K.group_days(DAYS, 'W')
assert [(c['t'], c['o'], c['h'], c['l'], c['c'], c['day']) for c in w] == [('2026-10-26', 10, 13, 9, 12, '2026-10-30'),
                                                                          ('2026-11-02', 12, 16, 11, 15, '2026-11-06')], w
mo = K.group_days(DAYS, 'M')
assert [(c['t'], c['day']) for c in mo] == [('2026-10', '2026-10-30'), ('2026-11', '2026-11-06')]
assert K.candle_complete(w[1], 'W', d('2026-11-06'), HOL), 'Friday close finishes the week'
assert not K.candle_complete(w[1], 'W', d('2026-11-05'), HOL)
assert K.candle_complete(mo[0], 'M', d('2026-11-06'), HOL) and not K.candle_complete(mo[1], 'M', d('2026-11-06'), HOL)
assert K.candle_complete(mo[0], 'M', d('2026-10-30'), HOL), 'the next session is in November'

# ------------------------------------------------------------------ 3. the rules (and IntradayCheck's explanation)
c1 = {'o': 240.0, 'h': 241.0, 'l': 232.0, 'c': 233.0}
c2 = {'o': 233.5, 'h': 235.0, 'l': 229.5, 'c': 234.0}
assert K.is_spring_pair(c1, c2)
assert all(ok for _, ok in K.spring_explain(c1, c2))
bad = dict(c2, h=238.0)
assert not K.is_spring_pair(c1, bad)
assert [n for n, ok in K.spring_explain(c1, bad) if not ok] == ['candle 2 high stays within candle 1 low + 50% of candle 1 range']
assert K.tv_url('M&M', '4H') == 'https://www.tradingview.com/chart/?symbol=NSE%3AM%26M&interval=240'


# ------------------------------------------------------------------ 4. a PARAGMILK-like 4H chart, as 15-minute candles
def sessions(first, last):
    out, x = [], d(first)
    while x <= d(last):
        if K.is_trading_day(x, HOL):
            out.append(x.isoformat())
        x += timedelta(days=1)
    return out


def four_hour_path(days):
    """4H candles (two a session): a slow base, a jump that leaves a 3-candle FVG (late August), a drift down into it
    without a close under its bottom, then a red candle and a Spring candle in the gap on 30-Oct 13:15."""
    out, px = [], 205.0
    for i, day in enumerate(days):
        for half in (0, 1):
            k = 2 * i + half
            if day < '2026-08-21':
                o, c = px, px + (0.6 if k % 3 else -0.5)
            elif day == '2026-08-21' and half == 0:
                o, c = px, px + 3
            elif day == '2026-08-21' and half == 1:
                o, c = px + 1, px + 30           # the big green candle - the gap is between the candles around it
            elif day == '2026-08-24' and half == 0:
                o, c = px + 4, px + 8
            elif day < '2026-10-01':
                o, c = px, px + (1.2 if k % 2 else -1.0)
            elif day < '2026-10-30':
                o, c = px, px - 0.45 if px > 238 else px + 0.3
            elif day == '2026-10-30' and half == 0:
                o, c = px, px - 6.0              # the red candle 1
            elif day == '2026-10-30' and half == 1:
                o, c = px - 0.2, px + 0.6        # candle 2: dips under candle 1's low, closes back above it
            else:
                o, c = px, px + 2.5
            if day == '2026-10-30' and half == 1:
                h, lo = c + 1.2, o - 3.5
            elif day == '2026-08-21' and half == 1:
                h, lo = c + 0.5, o - 0.5
            elif day == '2026-08-24' and half == 0:
                h, lo = c + 0.5, o - 0.5         # its low stays above the high two candles back: the FVG
            else:
                h, lo = max(o, c) + 0.8, min(o, c) - 0.8
            out.append((day, half, o, h, lo, c))
            px = c
    return out


def to_m15(path):
    rows = []
    for day, half, o, h, lo, c in path:
        n = 16 if half == 0 else 9
        start = 9 * 60 + 15 + (240 if half else 0)
        for k in range(n):
            po = o + (c - o) * k / n
            pc = o + (c - o) * (k + 1) / n
            hh, ll = max(po, pc) + 0.05, min(po, pc) - 0.05
            if k == 1:
                hh = h
            if k == n - 2:
                ll = lo
            m = start + 15 * k
            rows.append(['%s %02d:%02d' % (day, m // 60, m % 60), round(po, 2), round(max(hh, po, pc), 2), round(min(ll, po, pc), 2),
                         round(pc, 2), 1000])
    return rows


DAYS_ALL = sessions('2026-05-04', '2026-11-06')
PATH = four_hour_path(DAYS_ALL)
SERIES = {'PARAGMILK': to_m15(PATH), 'FLAT': to_m15([(dd, hf, 100.0, 100.8, 99.2, 100.0) for dd, hf, *_ in PATH])}


def daily_of(rows15):
    by = {}
    for r in rows15:
        k = r[0][:10]
        if k not in by:
            by[k] = [k, r[1], r[2], r[3], r[4], r[5]]
        else:
            b = by[k]
            b[2], b[3], b[4], b[5] = max(b[2], r[2]), min(b[3], r[3]), r[4], b[5] + r[5]
    return [by[k] for k in sorted(by)]


# the 4H candles built from those 15-minute ones must be the path (the test's own sanity check)
four = K.bucket_intraday(SERIES['PARAGMILK'], 240)
assert len(four) == 2 * len(DAYS_ALL)
sp = K.fvg_spring(four[-K.WINDOW['4H']:])
cs4 = four[-K.WINDOW['4H']:]
hits = [cs4[i]['t'] for i in sp]
assert '2026-10-30 13:15' in hits, ('the PARAGMILK-like 4H Spring in FVG', hits, [cs4[i]['t'] for i in K.springs(cs4)])
gi = sp[[i for i in sp if cs4[i]['t'] == '2026-10-30 13:15'][0]][0]
assert cs4[gi]['t'].startswith('2026-08-2'), ('the August gap', cs4[gi]['t'])

# ------------------------------------------------------------------ 5. pretend Kite
TOKENS = {'PARAGMILK': 111, 'FLAT': 222, 'BEONLY-BE': 333}
CALLS = []
STATE = {'expired': False, 'split': False}


def kite_candles(sym, interval, frm, to):
    rows = SERIES[sym] if interval == '15minute' else daily_of(SERIES[sym])
    if STATE['split'] and sym == 'FLAT':
        rows = [[r[0]] + [round(v / 2, 2) for v in r[1:5]] + [r[5]] for r in rows]
    out = []
    for r in rows:
        t = r[0] if len(r[0]) > 10 else r[0] + ' 00:00'
        if frm <= t + ':00' <= to:
            out.append([t.replace(' ', 'T') + ':00+0530'] + r[1:])
    return out


def fake_http(method, url, headers, data=None, timeout=60):
    u = urllib.parse.urlparse(url)
    q = dict(urllib.parse.parse_qsl(u.query))
    CALLS.append((method, u.path))
    assert headers.get('X-Kite-Version') == '3'
    if u.path == '/session/token':
        f = dict(urllib.parse.parse_qsl(data.decode()))
        want = hashlib.sha256(('key123' + f['request_token'] + 'secret456').encode()).hexdigest()
        if f['checksum'] != want:
            return 403, json.dumps({'status': 'error', 'error_type': 'TokenException', 'message': 'bad checksum'})
        return 200, json.dumps({'status': 'success', 'data': {'access_token': 'at-' + f['request_token'], 'user_name': 'Owner'}})
    if headers.get('Authorization') != 'token key123:at-req1' or STATE['expired']:
        return 403, json.dumps({'status': 'error', 'error_type': 'TokenException', 'message': 'Incorrect `api_key` or `access_token`.'})
    if u.path == '/instruments/NSE':
        lines = ['instrument_token,exchange_token,tradingsymbol,name,last_price,expiry,strike,tick_size,lot_size,instrument_type,segment,exchange']
        for s, t in TOKENS.items():
            lines.append('%d,1,%s,%s,0,,0,0.05,1,EQ,NSE,NSE' % (t, s, s))
        lines.append('999,1,NIFTY 50,NIFTY,0,,0,0,0,EQ,INDICES,NSE')
        return 200, '\n'.join(lines)
    if u.path.startswith('/instruments/historical/'):
        _, _, _, tok, interval = u.path.split('/')
        sym = [s for s, t in TOKENS.items() if str(t) == tok][0]
        assert q['oi'] == '0' and q['continuous'] == '0'
        return 200, json.dumps({'status': 'success', 'data': {'candles': kite_candles(sym, interval, q['from'], q['to'])}})
    if u.path == '/user/profile':
        return 200, json.dumps({'status': 'success', 'data': {'user_name': 'Owner'}})
    return 404, '{}'


K._http = fake_http
CFG = {'kite_api_key': 'key123', 'kite_api_secret': 'secret456', 'intraday': True}

# ------------------------------------------------------------------ 6. login: the login page sends the token to the local page
def press_login(token='req1', status='success'):
    def go():
        real_sleep(0.2)
        url = 'http://127.0.0.1:%d/kite?action=login&status=%s&request_token=%s' % (K.REDIRECT_PORT, status, token)
        with urllib.request.urlopen(url, timeout=10) as r:
            PAGES.append(r.read().decode())
    threading.Thread(target=go, daemon=True).start()


PAGES = []
assert K.due(CFG, HOL, now=datetime(2026, 11, 6, 16, 0), state={})[0], 'a finished session not scanned yet'
assert not K.due(dict(CFG, kite_api_secret=''), HOL, now=datetime(2026, 11, 6, 16, 0), state={})[0], 'not set up'
assert not K.due(CFG, HOL, now=datetime(2026, 11, 6, 16, 0), state={'scanned': '2026-11-06'})[0]
s = K.login(CFG, wait_s=20, ready=press_login)
assert s and s['access_token'] == 'at-req1' and s['user'] == 'Owner', s
assert 'Kite login received' in PAGES[0]
assert OPENED and OPENED[-1] == 'https://kite.zerodha.com/connect/login?v=3&api_key=key123'
exp = datetime.fromtimestamp(s['expires'], K.IST)
assert (exp.hour, exp.minute) == (6, 0) and exp > datetime.now(K.IST), 'valid until 6 AM'
assert K.session_valid(K.session_load())
assert not K.session_valid(dict(s, expires=time.time() - 1))
saved = K.session_load()
assert 'secret456' not in json.dumps(saved), 'the secret is never saved with the session'
assert K.next_6am(datetime(2026, 11, 6, 5, 59, tzinfo=K.IST).timestamp()) == datetime(2026, 11, 6, 6, 0, tzinfo=K.IST).timestamp()
assert K.next_6am(datetime(2026, 11, 6, 20, 0, tzinfo=K.IST).timestamp()) == datetime(2026, 11, 7, 6, 0, tzinfo=K.IST).timestamp()

# a cancelled login: the page says so and the wait goes on until it times out (no token)
PAGES.clear()
K.time.sleep = lambda x: None
assert K.wait_for_request_token(1.5, ready=lambda: press_login('x', 'cancelled')) is None
assert PAGES and 'Login not completed' in PAGES[0]

# ------------------------------------------------------------------ 7. the download: first all, then only the new days
imap = K.instruments(CFG, s, '2026-11-06')
assert imap == {'PARAGMILK': 111, 'FLAT': 222, 'BEONLY-BE': 333}, imap
assert K.token_for(imap, 'BEONLY') == 333 and K.token_for(imap, 'NOPE') is None
CALLS.clear()
K.instruments(CFG, s, '2026-11-06')
assert not CALLS, 'the instrument list is read once a day'

st, n = K.update_symbol(CFG, s, 'FLAT', 222, d('2026-11-05'))
assert n == 2 and st['m15'][-1][0] == '2026-11-05 15:15' and st['day'][-1][0] == '2026-11-05', (n, st['m15'][-1], st['day'][-1])
assert len({r[0][:10] for r in st['m15']}) <= K.M15_KEEP_SESSIONS
st, n = K.update_symbol(CFG, s, 'FLAT', 222, d('2026-11-05'))
assert n == 0, 'up to date: nothing read'
CALLS.clear()
st, n = K.update_symbol(CFG, s, 'FLAT', 222, d('2026-11-06'))
assert n == 2 and st['m15'][-1][0] == '2026-11-06 15:15' and st['day'][-1][0] == '2026-11-06'
hist_froms = [c for c in CALLS if c[1].startswith('/instruments/historical/')]
assert len(hist_froms) == 2
STATE['split'] = True                       # Kite's older candles changed (a split): everything is read again
st, n = K.update_symbol(CFG, s, 'FLAT', 222, d('2026-11-06'))
assert n == 0                               # (still up to date - no request, no check)
st['m15'] = st['m15'][:-25]
st['day'] = st['day'][:-1]
K.store_save('FLAT', st)
st, n = K.update_symbol(CFG, s, 'FLAT', 222, d('2026-11-06'))
assert n == 3 and abs(st['day'][0][4] - 50.0) < 0.6, (n, st['day'][0])   # daily overlap differs -> full daily + full 15m
STATE['split'] = False

# ------------------------------------------------------------------ 8. the whole scan with a pretend sheet
POSTS = []


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'intraday'
    POSTS.append(payload)
    if payload['op'] == 'syms':
        return {'ok': True, 'syms': ['PARAGMILK', 'FLAT', 'BEONLY', 'NOPE']}
    return {'ok': True, 'added': len(payload['items'])}


K.state_save({})
K.store_save('FLAT', {'v': 1, 'sym': 'FLAT', 'm15': [], 'day': []})
SERIES['BEONLY-BE'] = SERIES['FLAT']
n = K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 6, 18, 30))
assert n is not None and n >= 1, (n, LOGS[-6:])
items = [it for p in POSTS if p['op'] == 'put' for it in p['items']]
para = [it for it in items if it['sym'] == 'PARAGMILK' and it['tf'] == '4H']
assert any(it['pattern'] == 'Spring in FVG' and it['candle'] == '2026-10-30 13:15' and it['session'] == '2026-10-30' and it['zone']
           and it['zone'][2].startswith('2026-08-2') for it in para), para
put = [p for p in POSTS if p['op'] == 'put'][0]
assert put['upto'] == '2026-11-06' and put['since'] == '2026-10-23', put        # first run: the last 10 sessions
assert all(it['session'] > '2026-10-23' for it in items)
assert not [it for it in items if it['tf'] in ('15m', '30m') and it['pattern'] == 'Spring'], '15m / 30m: Spring in FVG only'
assert not [it for it in items if it['sym'] == 'NOPE'] and any('not on Kite: NOPE' in m for m in LOGS), LOGS[-4:]
assert K.state_load()['scanned'] == '2026-11-06'
POSTS.clear()
assert K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 6, 19, 0)) == 0 and not POSTS, 'already scanned'
assert not K.due(CFG, HOL, now=datetime(2026, 11, 7, 10, 0))[0], 'Saturday: nothing new'

# the next session: only the new candles are read and only their patterns are sent
SERIES['PARAGMILK'] = SERIES['PARAGMILK'] + m15_day('2026-11-09', 260)
CALLS.clear()
POSTS.clear()
n = K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 9, 16, 0))
put = [p for p in POSTS if p['op'] == 'put'][0]
assert put['since'] == '2026-11-06' and all(it['session'] == '2026-11-09' for it in put['items']), put
froms = [c for c in CALLS if c[1].startswith('/instruments/historical/')]
assert len(froms) == 6, ('2 short reads a stock', len(froms))

# ------------------------------------------------------------------ 9. no login: it waits and asks again later; 403 part-way
K.state_save({})
os.remove(K.SESSION_PATH)
n = K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 10, 16, 0), wait_s=1, open_browser=False)
assert n is None and K.state_load().get('wait_login_until', 0) > time.time() + 3600, K.state_load()
assert not K.due(CFG, HOL, now=datetime(2026, 11, 10, 16, 30))[0], 'asked again only after 2 hours'
K.session_save(s)
STATE['expired'] = True
st0 = K.state_load()
st0.pop('wait_login_until', None)
K.state_save(st0)
assert K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 10, 16, 0)) is None
assert any('permission ended' in m or 'next login' in m for m in LOGS[-3:]), LOGS[-3:]
STATE['expired'] = False
assert 'logged in today' in K.status_line(CFG) and 'not set up' in K.status_line({})

# the background program's runner: due and online -> a thread; offline -> not started (the internet is checked only when due)
K.state_save({})
R = K.Runner()
assert R.maybe_start(CFG, fake_api, HOL, online=lambda: False) is False and not R.busy()
assert R.maybe_start(dict(CFG, kite_api_key=''), fake_api, HOL, online=lambda: 1 / 0) is False, 'not due: the internet is not even checked'

print('OK')
