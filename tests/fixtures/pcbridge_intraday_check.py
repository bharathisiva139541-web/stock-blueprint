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
K.LIVE_MARK_PATH = os.path.join(TMP, 'kite_live.json')
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
    without a close under its bottom, then a red candle and a Spring candle on the gap's bottom line on 30-Oct 13:15
    (FVG+Spring, owner's rule of 08-Nov-2026: zone top on the 1st / 2nd touch, or the bottom line)."""
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
                o, c = px, px - 1.0 if px > 252 else px + 0.3
            elif day == '2026-10-30' and half == 0:
                o, c = px, px - 6.0              # the red candle 1
            elif day == '2026-10-30' and half == 1:
                o, c = px - 0.2, px + 0.6        # candle 2: dips under candle 1's low, closes back above it
            else:
                o, c = px, px + 2.5
            if day == '2026-10-30' and half == 1:
                h, lo = c + 1.2, o - 2.0         # its low: on the gap's bottom line (at most 1 % under it)
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
hit = sp[[i for i in sp if cs4[i]['t'] == '2026-10-30 13:15'][0]]
assert cs4[hit['f']]['t'].startswith('2026-08-2') and hit['where'] == 'bottom' and hit['kind'] == 'FVG', ('the August gap', hit)

# a 4H Spring on the day's first candle is not reported, one on the second candle is (owner, 08-Nov-2026)
flat = [(dd, hf, 100.0, 100.2, 99.8, 100.0) for dd in sessions('2026-09-01', '2026-11-06') for hf in (0, 1)]
for k, (dd, hf, *_r) in enumerate(flat):
    if (dd, hf) == ('2026-10-26', 1):
        flat[k] = (dd, hf, 100.0, 100.3, 96.8, 97.0)          # red
    if (dd, hf) == ('2026-10-27', 0):
        flat[k] = (dd, hf, 97.2, 97.8, 96.5, 97.5)            # Spring on the 09:15 candle
    if (dd, hf) == ('2026-10-29', 0):
        flat[k] = (dd, hf, 100.0, 100.3, 96.8, 97.0)          # red
    if (dd, hf) == ('2026-10-29', 1):
        flat[k] = (dd, hf, 97.2, 97.8, 96.5, 97.5)            # Spring on the 13:15 candle
two = {'m15': to_m15(flat), 'day': []}
both = K.scan(two, '2026-10-20', d('2026-11-06'), HOL, ['4H'], slots={})
assert [f['candle'] for f in both if f['pattern'] == 'Spring'] == ['2026-10-27 09:15', '2026-10-29 13:15'], both
only = K.scan(two, '2026-10-20', d('2026-11-06'), HOL, ['4H'], slots=K.chosen_slots({}))
assert [f['candle'] for f in only if f['pattern'] == 'Spring'] == ['2026-10-29 13:15'], only
# the candle-time rule is for the Spring patterns only: the 4H FVG patterns count on every candle
assert [(f['candle'], f['pattern']) for f in only if f['pattern'] not in K.SPRING_PATTERNS] == \
    [('2026-10-29 09:15', 'FVG First Touch')], only
assert K.chosen_slots({'intraday_slots': {}}) == {} and K.chosen_slots({'intraday_timeframes': ['D']}) == {}

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


def page_text():
    """The local page's answer: the browser thread stores it just after the login returns (a race under load)."""
    for _ in range(200):
        if PAGES:
            break
        real_sleep(0.05)
    return PAGES[0] if PAGES else ''


assert K.due(CFG, HOL, now=datetime(2026, 11, 6, 16, 0), state={})[0], 'a finished session not scanned yet'
assert not K.due(dict(CFG, kite_api_secret=''), HOL, now=datetime(2026, 11, 6, 16, 0), state={})[0], 'not set up'
assert not K.due(CFG, HOL, now=datetime(2026, 11, 6, 16, 0), state={'scanned': '2026-11-06', 'tfs': ['4H', 'D', 'W', 'M'], 'slots': {'4H': ['13:15']},
                                                                    'rules': K.RULES_VERSION})[0]
assert K.due(CFG, HOL, now=datetime(2026, 11, 6, 16, 0), state={'scanned': '2026-11-06', 'tfs': ['4H', 'D', 'W', 'M'], 'slots': {'4H': ['13:15']}})[0], \
    'new pattern rules: the last sessions are scanned again'
s = K.login(CFG, wait_s=20, ready=press_login)
assert s and s['access_token'] == 'at-req1' and s['user'] == 'Owner', s
assert 'Kite login received' in page_text()
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
assert 'Login not completed' in page_text()

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
    if payload['op'] == 'zones':
        return {'ok': True, 'kept': len(payload['zones']), 'logged': 0}
    if payload['op'] == 'backtest':
        return {'ok': True, 'rows': len(payload['rows'])}
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
assert put['tfs'] == ['4H', 'D', 'W', 'M'] and {it['tf'] for it in items} <= {'4H', 'D', 'W', 'M'}, ('owner, 08-Nov-2026: only 4H / D / W / M', put['tfs'])
assert K.state_load()['tfs'] == ['4H', 'D', 'W', 'M'] and K.state_load()['slots'] == {'4H': ['13:15']}
assert put['slots'] == {'4H': ['13:15']} and all(it['candle'].endswith('13:15') for it in items if it['tf'] == '4H'), 'owner: only the 13:15 4H candle'
assert all(it['session'] > '2026-10-23' for it in items)
assert not [it for it in items if it['tf'] in ('15m', '30m') and it['pattern'] == 'Spring'], '15m / 30m: Spring in FVG only'
assert not [it for it in items if it['sym'] == 'NOPE'] and any('not on Kite: NOPE' in m for m in LOGS), LOGS[-4:]
assert K.state_load()['scanned'] == '2026-11-06' and K.state_load()['rules'] == K.RULES_VERSION
assert put['first'] is True and put['rules'] == K.RULES_VERSION, 'the first post replaces the rows of the sessions it covers'
assert isinstance(put['invalid'], list) and all(p.get('invalid') == [] for p in POSTS if p['op'] == 'put' and not p.get('first'))
spring_fvg = [it for it in items if it['pattern'] == 'Spring in FVG' and it['sym'] == 'PARAGMILK' and it['tf'] == '4H']
assert spring_fvg and spring_fvg[0]['zone'][3:5] == ['FVG', 'bottom'] and spring_fvg[0]['zone'][5] >= 1, spring_fvg
assert not [it for it in items if it['tf'] == 'M' and it['pattern'] == 'Spring in FVG'], 'the monthly chart: the plain Spring only'
# 4H FVG zones: the untouched ones + those first touched in the sessions scanned, every 4H candle time
zp = [p for p in POSTS if p['op'] == 'zones']
assert len(zp) == 1 and zp[0]['tf'] == '4H' and zp[0]['since'] == '2026-10-23', zp
assert all(z['tf'] == '4H' and len(z['zone']) == 4 and z['zone'][3] in ('FVG', 'Gap-up') for z in zp[0]['zones']), zp[0]['zones'][:3]
assert all(m['candle'][:10] > '2026-10-23' for m in zp[0]['mitigated']), zp[0]['mitigated']
# the backtest: every FVG+Spring of 4H / D / W on all stored candles, 2R before the stop within 20 candles
bp = [p for p in POSTS if p['op'] == 'backtest']
assert len(bp) == 1 and bp[0]["days"] == 30 and bp[0]["targets"] == [1, 1.5, 2, 3, 5], LOGS[-8:]
groups = {(r['tf'], r['group']) for r in bp[0]['rows']}
assert ('4H', 'FVG+Spring') in groups and ('D', 'Spring (every one, for comparison)') in groups and len(bp[0]['rows']) == 21, groups
assert ('4H', 'Gap-up FVG + Spring - inside FVG') in groups
tr = [t for t in bp[0]['trades'] if t['sym'] == 'PARAGMILK' and t['candle'] == '2026-10-30 13:15']
assert tr and tr[0]['where'] == 'bottom' and tr[0]['result'] == 'open', 'the candles end a week later: its 30 days are not over'
assert all(set(t) == {'sym', 'tf', 'candle', 'zone', 'where', 'touch', 'inside', 'result', 'up', 'maxR'} for t in bp[0]['trades'])
row = [r for r in bp[0]['rows'] if r['tf'] == '4H' and r['group'] == 'FVG+Spring'][0]
assert row['open'] >= 1 and len(row['hits']) == 5, row
assert any('Kite backtest' in m and '4H FVG+Spring' in m for m in LOGS), LOGS[-6:]
POSTS.clear()
assert K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 6, 19, 0)) == 0 and not POSTS, 'already scanned'
assert not K.due(CFG, HOL, now=datetime(2026, 11, 7, 10, 0))[0], 'Saturday: nothing new'
# the timeframes changed (or a state from before 08-Nov-2026 without 'tfs'): the last 10 sessions again, nothing downloaded
st1 = K.state_load()
assert K.due(dict(CFG, intraday_timeframes=['4H', 'D']), HOL, now=datetime(2026, 11, 7, 10, 0), state=dict(st1, tried=0))[0]
assert K.due(CFG, HOL, now=datetime(2026, 11, 7, 10, 0), state=dict(st1, tfs=None, tried=0))[0], 'the first version\'s state'
CALLS.clear()
POSTS.clear()
assert K.intraday_step(dict(CFG, intraday_timeframes=['D', '4H']), fake_api, HOL, now=datetime(2026, 11, 7, 10, 0)) is not None
put = [p for p in POSTS if p['op'] == 'put'][0]
assert put['tfs'] == ['4H', 'D'] and put['since'] == '2026-10-23' and {it['tf'] for it in put['items']} <= {'4H', 'D'}, put['tfs']
assert not [c for c in CALLS if c[1].startswith('/instruments/historical/')], 'everything was up to date: nothing read from Kite'
assert any('the timeframes are now 4H, D' in m for m in LOGS), LOGS[-4:]
assert any('older version' in m for m in LOGS[-12:]), 'the pretend sheet does not echo tfs: the hint'
K.intraday_step(CFG, fake_api, HOL, now=datetime(2026, 11, 7, 10, 5))           # back to the four

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

# ------------------------------------------------------------------ 10. the 30-day outcome and the summary (owner, 09-Nov-2026)
def C(o, h, l, c, day='2026-10-01'):
    return {'t': day, 'day': day, 'o': o, 'h': h, 'l': l, 'c': c, 'v': 1}


def days_after(n, start='2026-10-02'):
    d0 = date.fromisoformat(start)
    return [(d0 + timedelta(days=k)).isoformat() for k in range(n)]


sig = [C(100, 101, 95, 96, '2026-09-30'), C(96, 97, 94, 96.5, '2026-10-01')]  # entry 96.5, stop under 94, R = 2.5
dd = days_after(40)
# up to 105 (3.4R, +8.8 %) on day 5, then down through the stop on day 10; nothing after day 30 counts (it goes to 200)
path = [C(96.5, 99, 95, 98, dd[0]), C(98, 101.6, 97, 101, dd[1]), C(101, 103, 100, 102, dd[2]), C(102, 104, 101, 103, dd[3]),
        C(103, 105, 102, 104, dd[4])] + [C(104, 104.5, 100, 101, x) for x in dd[5:9]] + [C(101, 101.5, 93.5, 94, dd[9])] + \
       [C(94, 95, 93, 94.5, x) for x in dd[10:30]] + [C(150, 200, 150, 199, x) for x in dd[30:]]   # dd[29] = day 30 (in)
o = K.trade_30d(sig + path, 1)
assert o['result'] == '3R' and o['stopped'] and o['hits'] == [True, True, True, True, False], o
assert o['up'] == 8.81 and o['maxR'] == 3.4, o
# the stop candle reaching a target too: not counted (as before - a candle doing both is not a win)
both = sig + [C(96.5, 102, 93, 100, dd[0])] + [C(100, 100.5, 99, 100, x) for x in dd[1:40]]
o = K.trade_30d(both, 1)
assert o['hits'] == [False] * 5 and o['result'] == 'stopped' and o['maxR'] == 0.0 and o['up'] == 5.7, o
flat = sig + [C(96.5, 97.5, 95.5, 97, x) for x in dd]
o = K.trade_30d(flat, 1)
assert o['result'] == 'none' and not o['stopped'] and o['maxR'] == 0.4, o
assert K.trade_30d(sig + [C(96.5, 97.5, 95.5, 97, x) for x in dd[:20]], 1)['result'] == 'open', 'no candle after the 30 days yet'
assert K.trade_30d([C(100, 101, 95, 96), C(96, 97, 96, 96)], 1) is None, 'no risk'
mk = lambda res, up, r, st, hits: {'result': res, 'up': up, 'maxR': r, 'stopped': st, 'hits': hits}
H = lambda k: [True] * k + [False] * (5 - k)
rows = K.bt_summary([dict(mk('3R', 9.0, 3.4, True, H(4)), tf='4H', candle='2026-10-01 13:15', zone='FVG', where='top'),
                     dict(mk('stopped', 1.0, 0.3, True, H(0)), tf='4H', candle='2026-10-05 13:15', zone='FVG', where='bottom'),
                     dict(mk('1R', 4.0, 1.2, False, H(1)), tf='4H', candle='2026-10-09 13:15', zone='FVG', where='top'),
                     dict(mk('open', None, None, False, H(0)), tf='4H', candle='2026-11-05 13:15', zone='FVG', where='top'),
                     dict(mk('2R', 6.0, 2.5, False, H(3)), tf='D', candle='2026-10-01', zone='Gap-up', where='top', inside=True)],
                    [('4H', '2026-10-01 13:15', mk('3R', 9.0, 3.4, True, H(4))), ('D', '2026-09-01', mk('open', None, None, False, H(0)))])
r4 = {r['group']: r for r in rows if r['tf'] == '4H'}
f = r4['FVG+Spring']
assert (f['signals'], f['open'], f['avgUp'], f['medUp'], f['hits'], f['stopped'], f['avgR'], f['medR']) == \
    (3, 1, 4.67, 4.0, [66.7, 33.3, 33.3, 33.3, 0.0], 66.7, 1.63, 1.2), f
assert r4['FVG+Spring - zone top']['signals'] == 2 and r4['FVG+Spring - zone bottom']['hits'][0] == 0.0
assert (f['from'], f['to']) == ('2026-10-01 13:15', '2026-11-05 13:15')
rd = {r['group']: r for r in rows if r['tf'] == 'D'}
assert rd['Gap-up FVG + Spring']['signals'] == 1 and rd['Gap-up FVG + Spring - inside FVG']['hits'][2] == 100.0, rd
assert rd['FVG+Spring']['signals'] == 0 and rd['Spring (every one, for comparison)']['open'] == 1 and len(rows) == 21
log2 = K.bt_log(rows)
assert log2[0].startswith('4H FVG+Spring 3: up +4.7% avg / +4.0% median, 2R 33%, stopped 67%') and 'inside FVG 1: up +6.0%' in log2[1], log2

# owner, 08-Nov-2026: a Spring in FVG stops counting once a LATER candle closes below its low - not reported, and the
# sheet is told to take its row off ('invalid', the last KEEP_DAYS)
def H4(day, half, o, h, l, c):
    return {'t': day + (' 09:15' if half == 0 else ' 13:15'), 'day': day, 'o': o, 'h': h, 'l': l, 'c': c, 'v': 1}


bars = [H4('2026-09-%02d' % (1 + k // 2), k % 2, 100, 101, 99, 100.2) for k in range(15)]
bars += [H4('2026-09-09', 0, 101, 106, 100.5, 105.5), H4('2026-09-09', 1, 106, 108, 104, 107.5), H4('2026-09-10', 0, 107.5, 109, 106.5, 108.5),
         H4('2026-09-10', 1, 108.5, 109.5, 107.5, 108), H4('2026-09-11', 0, 108, 108.5, 104.2, 104.5), H4('2026-09-11', 1, 104.4, 105, 103.0, 104.3)]
d1 = K.fvg_detail(bars)
assert d1['spring'][20]['where'] == 'top' and d1['spring'][20]['broken'] is None, d1['spring']
d2 = K.fvg_detail(bars + [H4('2026-09-14', 0, 104.3, 104.6, 102.5, 102.9)])
assert d2['spring'][20]['broken'] == 21, 'the next candle closed 102.9 < the Spring low 103.0'


orig_tc = K.timeframe_candles
K.timeframe_candles = lambda store, tf: store['bars'] if tf == '4H' else []
try:
    ok = K.analyse({'bars': bars, 'day': []}, '2026-09-10', d('2026-09-11'), HOL, ['4H'], (), slots={'4H': ['13:15']})
    assert [(i['pattern'], i['candle']) for i in ok['items'] if 'Spring' in i['pattern']] == [('Spring in FVG', '2026-09-11 13:15')], ok['items']
    assert ok['invalid'] == []
    gone = K.analyse({'bars': bars + [H4('2026-09-14', 0, 104.3, 104.6, 102.5, 102.9)], 'day': []}, '2026-09-10', d('2026-09-14'), HOL,
                     ['4H'], (), slots={'4H': ['13:15']})
    assert not [i for i in gone['items'] if i['pattern'] == 'Spring in FVG'], 'broken: not reported'
    assert gone['invalid'] == [{'tf': '4H', 'candle': '2026-09-11 13:15', 'pattern': 'Spring in FVG'}], gone['invalid']
    old = K.analyse({'bars': bars + [H4('2026-09-14', 0, 104.3, 104.6, 102.5, 102.9)], 'day': []}, '2026-09-10', d('2026-11-06'), HOL,
                    ['4H'], (), slots={'4H': ['13:15']})
    assert old['invalid'] == [], 'older than the 30 days the sheet keeps: nothing to take off'
    # a Gap-up on 4H: the Spring on it is 'Gap-up FVG + Spring' (13:15 candle), the zone is still sent after its touch
    gb = [H4('2026-10-%02d' % (1 + k // 2), k % 2, 100, 104, 96, 100) for k in range(17)]
    gb += [H4('2026-10-09', 1, 100, 104.5, 99.8, 104.3), H4('2026-10-10', 0, 105, 110, 104.9, 109.5), H4('2026-10-10', 1, 109.5, 111, 106, 110.5),
           H4('2026-10-12', 0, 110.5, 110.8, 105.4, 105.6), H4('2026-10-12', 1, 105.5, 106.0, 104.7, 105.7)]
    ga = K.analyse({'bars': gb, 'day': []}, '2026-10-10', d('2026-10-12'), HOL, ['4H'], (), slots={'4H': ['13:15']})
    sp = [(i['pattern'], i['candle'], i['zone'][3:]) for i in ga['items'] if 'Spring' in i['pattern']]
    assert ('Gap-up FVG + Spring', '2026-10-12 13:15', ['Gap-up', 'top', 1, 1]) in sp, sp
    gzs = [z for z in ga['zones'] if z['zone'][3] == 'Gap-up']
    assert gzs and gzs[0]['touched'] == '2026-10-12 13:15' and gzs[0]['inside'] == 1, ga['zones']
    assert [m for m in ga['mitigated'] if m['zone'][3] == 'Gap-up'][0]['inside'] == 1, ga['mitigated']
finally:
    K.timeframe_candles = orig_tc

# BacktestNow.bat: the stored candles only - no Kite login, no download
CALLS.clear()
POSTS.clear()
OUT = []
assert K.backtest_now(CFG, fake_api, HOL, out=OUT.append) == 0
assert not CALLS and [p['op'] for p in POSTS] == ['backtest'], (CALLS[:3], POSTS[:1])
assert any('PARAGMILK' == t['sym'] for t in POSTS[0]['trades']) and any('4H FVG+Spring' in o for o in OUT), OUT

# ------------------------------------------------------------------ 11. LiveNow.bat: Kite live prices -> the sheet's "Kite Live" tab
QUOTES = {'NSE:PARAGMILK': {'last_price': 241.5, 'ohlc': {'open': 236, 'high': 243, 'low': 235.1, 'close': 233.0}},
          'NSE:FLAT': {'last_price': 99.0, 'ohlc': {'open': 100, 'high': 100.5, 'low': 98.8, 'close': 100.0}},
          'NSE:BEONLY-BE': {'last_price': 50.0, 'ohlc': {'open': 50, 'high': 50, 'low': 50, 'close': 50.0}},
          'NSE:NIFTY 50': {'last_price': 25030.35, 'ohlc': {'open': 24950, 'high': 25060, 'low': 24940, 'close': 24930.6}},
          'NSE:NIFTY FIN SERVICE': {'last_price': 26500.0, 'ohlc': {'open': 26400, 'high': 26550, 'low': 26390, 'close': 26450.0}}}
QCALLS = []


def fake_http_live(method, url, headers, data=None, timeout=60):
    u = urllib.parse.urlparse(url)
    if u.path == '/quote/ohlc':
        keys = [v for k, v in urllib.parse.parse_qsl(u.query) if k == 'i']
        QCALLS.append(keys)
        if headers.get('Authorization') != 'token key123:at-req1':
            return 403, json.dumps({'status': 'error', 'error_type': 'TokenException', 'message': 'expired'})
        return 200, json.dumps({'status': 'success', 'data': {k: QUOTES[k] for k in keys if k in QUOTES}})
    return fake_http(method, url, headers, data, timeout)


LIVE_POSTS = []


def fake_api_live(cfg, action, payload=None, timeout=120, tries=3):
    if action == 'intraday' and payload['op'] == 'syms':
        return {'ok': True, 'syms': ['PARAGMILK', 'FLAT', 'BEONLY', 'NOPE'], 'indices': ['NIFTY_50', 'NIFTY_FIN_SERVICE', 'NIFTY_NOSUCH', 'bad sym']}
    assert action == 'kitelive', action
    LIVE_POSTS.append(payload)
    return {'ok': True, 'written': len(payload['items']), 'up': 1, 'down': 1}


K._http = fake_http_live
K.session_save(s)
OUT = []
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 8, 18, 5), sleep=lambda x: None, max_rounds=2) == 0
assert len(LIVE_POSTS) == 2 and LIVE_POSTS[0]['at'] == '2026-11-08 18:05:00', LIVE_POSTS[:1]
items = {it[0]: it[1:] for it in LIVE_POSTS[0]['items']}
assert items == {'PARAGMILK': [241.5, 236, 243, 235.1, 233.0], 'FLAT': [99.0, 100, 100.5, 98.8, 100.0], 'BEONLY': [50.0, 50, 50, 50, 50.0]}, items
assert QCALLS and sorted(QCALLS[0]) == ['NSE:BEONLY-BE', 'NSE:FLAT', 'NSE:NIFTY 50', 'NSE:NIFTY FIN SERVICE', 'NSE:NIFTY NOSUCH', 'NSE:PARAGMILK'], \
    ('BE series as SYMBOL-BE; NOPE is not on Kite; the sheet\'s indices in the same request', QCALLS[0])
assert len(QCALLS) == 2, 'one request a round for stocks + indices'
# the indices (owner, 08-Nov-2026): sent with the prices under the sheet's own names; one not on Kite is told once
idx = {it[0]: it[1:] for it in LIVE_POSTS[0]['indices']}
assert idx == {'NIFTY_50': [25030.35, 24950, 25060, 24940, 24930.6], 'NIFTY_FIN_SERVICE': [26500.0, 26400, 26550, 26390, 26450.0]}, idx
assert 'NIFTY_50' not in items, 'indices never in the stock rows'
assert sum('Indices not on Kite: NIFTY_NOSUCH' in o for o in OUT) == 1, OUT
assert any('3 stocks and 3 indices' in o for o in OUT) and any('NIFTY 50 25030.35 (+0.40%)' in o for o in OUT), OUT
assert any('until 08-Nov 22:05' in o for o in OUT), ('Sunday (Muhurat): 4 hours', OUT[:3])
assert any('Not on Kite: NOPE' in o for o in OUT) and any('top: PARAGMILK +3.6%' in o for o in OUT), OUT
# a trading day stops at 15:35; an older web app without the action -> a clear hint
OUT.clear()
LIVE_POSTS.clear()


def old_app(cfg, action, payload=None, timeout=120, tries=3):
    if action == 'intraday':
        return {'ok': True, 'syms': ['FLAT']}
    return {'ok': False, 'error': 'unknown action'}


assert K.live(CFG, old_app, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 10, 0), sleep=lambda x: None, max_rounds=3) == 1
assert any('until 09-Nov 15:35' in o for o in OUT) and any('New version deploy' in o for o in OUT), OUT
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 15, 36), sleep=lambda x: None) == 0, \
    'after 15:35 on a trading day: one round, then it stops'

# ------------------------------------------------------------------ 12. every trading day by itself (owner, 08-Nov-2026)
assert K.live_due(CFG, HOL, datetime(2026, 11, 9, 10, 0)) and K.live_due(CFG, HOL, datetime(2026, 11, 9, 9, 10))
assert not K.live_due(CFG, HOL, datetime(2026, 11, 9, 9, 5)) and not K.live_due(CFG, HOL, datetime(2026, 11, 9, 15, 35))
assert not K.live_due(CFG, HOL, datetime(2026, 11, 8, 18, 0)), 'Sunday (Muhurat): only LiveNow.bat by hand'
assert not K.live_due(dict(CFG, kite_live=False), HOL, datetime(2026, 11, 9, 10, 0)) and not K.live_due({}, HOL, datetime(2026, 11, 9, 10, 0))
STARTED = []
orig_live = K.live
K.live = lambda *a, **kw: STARTED.append(kw)
try:
    R2 = K.Runner()
    assert R2.maybe_start_live(CFG, fake_api_live, HOL, now=datetime(2026, 11, 9, 9, 0)) is False, 'before 09:10'
    assert R2.maybe_start_live(CFG, fake_api_live, HOL, online=lambda: False, now=datetime(2026, 11, 9, 10, 0)) is False, 'offline'
    assert R2.maybe_start_live(CFG, fake_api_live, HOL, now=datetime(2026, 11, 9, 10, 0)) is True
    R2.live_thread.join(5)
    assert STARTED and STARTED[0]['background'] is True and callable(STARTED[0]['out'])
    assert R2.maybe_start_live(CFG, fake_api_live, HOL, now=datetime(2026, 11, 9, 10, 1)) is False, 'stopped early: again 30 minutes later'
    R2.live_next = 0
    os.remove(K.SESSION_PATH)                       # no login today: at most 3 login pages a day
    starts = 0
    for k in range(5):
        if R2.maybe_start_live(CFG, fake_api_live, HOL, now=datetime(2026, 11, 9, 11, k)):
            starts += 1
            R2.live_thread.join(5)
        R2.live_next = 0
    assert starts == 3, starts                      # 3 login pages a day (the 10:00 start had a login already)
    K.session_save(s)
finally:
    K.live = orig_live
# one copy only: another program's recent mark stops a second LiveNow
with open(K.LIVE_MARK_PATH, 'w') as f:
    json.dump({'pid': os.getpid() + 1, 'at': time.time()}, f)
OUT = []
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 10, 0), sleep=lambda x: None, max_rounds=1) == 0
assert OUT and 'already being sent' in OUT[0], OUT
# ... but a closed window (its program no longer running) does not (owner, 08-Nov-2026: LiveNow closed and opened again)
K.pid_alive = lambda pid: False
OUT = []
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 10, 0), sleep=lambda x: None, max_rounds=1) == 0
assert not any('already being sent' in o for o in OUT) and any('prices -> Kite Live' in o for o in OUT), OUT
K.pid_alive = lambda pid: True
with open(K.LIVE_MARK_PATH, 'w') as f:
    json.dump({'pid': os.getpid() + 1, 'at': time.time()}, f)
OUT = []
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 10, 0), sleep=lambda x: None, max_rounds=1) == 0
assert OUT and 'already being sent' in OUT[0], ('a running one still stops it', OUT)
K.pid_alive = None
os.remove(K.LIVE_MARK_PATH)
# the background run writes a price line every 15 rounds only
OUT = []
assert K.live(CFG, fake_api_live, HOL, out=OUT.append, now_fn=lambda: datetime(2026, 11, 9, 10, 0), sleep=lambda x: None,
              max_rounds=16, background=True) == 0
assert len([o for o in OUT if 'prices -> Kite Live' in o]) == 2 and not any('close this window' in o for o in OUT), OUT

# ------------------------------------------------------------------ 13. deep history for the backtest (owner, 09-Nov-2026:
# "the backtest date should be maximum number of days") - daily back DEEP_DAY_YEARS in 2000-day chunks until Kite has no
# more, 4H from 60-minute candles; the scan's 4H = the deep 4H + the 15-minute-built recent part, no candle twice
HCALLS = []
orig_hist = K.historical


def fake_hist(cfg, sess, token, interval, frm, to):
    HCALLS.append((interval, frm.date().isoformat(), to.date().isoformat()))
    listed = date(2015, 3, 2)
    out, d = [], max(frm.date(), listed)
    while d <= to.date():
        if d.weekday() < 5:
            if interval == 'day':
                out.append([d.isoformat(), 100.0, 101.0, 99.0, 100.5, 1000])
            else:                                  # 60-minute: 09:15 .. 15:15
                for hh in (9, 10, 11, 12, 13, 14, 15):
                    out.append(['%s %02d:15' % (d.isoformat(), hh), 100.0, 100.0 + hh, 99.0, 100.2, 10])
        d += timedelta(days=1)
    return out


K.historical = fake_hist
try:
    up = date(2026, 11, 6)
    m15 = [['2026-11-%02d %02d:%02d' % (dd, hh, mm), 100, 101, 99, 100.5, 5] for dd in (5, 6) for hh in range(9, 16)
           for mm in (0, 15, 30, 45) if (hh, mm) >= (9, 15) and (hh, mm) < (15, 30)]
    st = {'v': 1, 'sym': 'DEEP', 'm15': m15, 'day': [['2026-11-05', 100, 101, 99, 100, 1], ['2026-11-06', 100, 101, 99, 100, 1]], 'h4': []}
    st2, n = K.deep_fill_symbol({}, {}, 'DEEP', 1, up, st)
    days = [c for c in HCALLS if c[0] == 'day']
    assert len(days) == 4 and days[0][2] == '2026-11-04', (len(days), days[:2])      # listed 2015: 3 chunks of ~5.5 years, then none
    assert st2['day'][0][0] == '2015-03-02' and st2['day'][-1][0] == '2026-11-06' and st2['deep']['day'] == '2026-11-06'
    h60 = [c for c in HCALLS if c[0] == '60minute']
    assert h60 and h60[0][2] == '2026-11-04' and min(c[1] for c in h60) == (up - timedelta(days=K.DEEP_H4_DAYS)).isoformat(), h60[:2]
    h4 = K.timeframe_candles(st2, '4H')
    ts = [c['t'] for c in h4]
    assert len(ts) == len(set(ts)) and ts == sorted(ts) and ts[-1] == '2026-11-06 13:15' and ts[-4:-2] == ['2026-11-05 09:15', '2026-11-05 13:15']
    first = [c for c in h4 if c['t'][:10] == '2026-11-04']
    assert [c['t'][11:] for c in first] == ['09:15', '13:15'] and first[0]['h'] == 112 and first[1]['h'] == 115, first
    assert K.store_load('DEEP')['deep'] == {'day': '2026-11-06', 'h4': '2026-11-06'}
    HCALLS.clear()
    assert K.deep_fill_symbol({}, {}, 'DEEP', 1, up, K.store_load('DEEP'))[1] == 0 and not HCALLS, 'read once'
    # deep_fill: only the stocks without it, within the time allowed
    K.store_save('NEW1', {'v': 1, 'sym': 'NEW1', 'm15': [], 'day': [], 'h4': []})
    K.store_save('NEW2', {'v': 1, 'sym': 'NEW2', 'm15': [], 'day': [], 'h4': []})
    lines, held, orig_dfs = [], [], K.deep_fill_symbol
    def one_at_a_time(cfg, sess, sym, token, upto, store=None):
        held.append(store)                           # deep_fill keeps no store of the to-do list in memory
        return orig_dfs(cfg, sess, sym, token, upto, store)
    K.deep_fill_symbol = one_at_a_time
    try:
        done, left, req = K.deep_fill({}, {}, {'DEEP': 1, 'NEW1': 2, 'NEW2': 3}, ['DEEP', 'NEW1', 'NEW2', 'NOTONKITE'], up,
                                      None, lines.append, every=1)
    finally:
        K.deep_fill_symbol = orig_dfs
    assert (done, left) == (2, 0) and req > 0 and K.store_load('NEW1')['day'][-1][0] == '2026-11-06'
    assert held == [None, None], held
    assert lines[0].startswith('Kite deep history: 2 of 4 stocks to read'), lines
    assert 'Kite deep history: 1 / 2 stocks' in lines[1] and 'min left' in lines[1] and 'left' not in lines[2], lines
    # the daily scan's quiet call: nothing to do -> no line
    lines.clear()
    assert K.deep_fill({}, {}, {'DEEP': 1}, ['DEEP'], up, 60, lines.append) == (0, 0, 0) and lines == []
    # the daily update: the 15-minute days that leave the store go on as 4H candles of the deep history
    keep = K.M15_KEEP_SESSIONS
    K.M15_KEEP_SESSIONS = 2
    try:
        s3 = K.store_load('DEEP')                    # a day behind: the update reads 05-11 .. 06-11 and trims to 2 sessions
        s3['m15'] = [r for r in fake_hist({}, {}, 1, '15minute', datetime(2026, 11, 3), datetime(2026, 11, 5, 15, 30))]
        s3['day'] = [r for r in s3['day'] if r[0] <= '2026-11-05']
        K.store_save('DEEP', s3)
        s4, _ = K.update_symbol({}, {}, 'DEEP', 1, up)
        assert sorted({r[0][:10] for r in s4['m15']}) == ['2026-11-05', '2026-11-06'], 'two sessions kept'
        assert [r[0] for r in s4['h4'] if r[0][:10] == '2026-11-04'] == ['2026-11-04 09:15', '2026-11-04 13:15']
        assert [c['t'] for c in K.timeframe_candles(s4, '4H')][-6:] == ['2026-11-04 09:15', '2026-11-04 13:15', '2026-11-05 09:15',
                                                                       '2026-11-05 13:15', '2026-11-06 09:15', '2026-11-06 13:15']
    finally:
        K.M15_KEEP_SESSIONS = keep
finally:
    K.historical = orig_hist

print('OK')
