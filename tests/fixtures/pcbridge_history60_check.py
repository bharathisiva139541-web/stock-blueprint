"""Offline checks for the PC bridge's History60 step (screener_bridge.py hist_*): each trading day's
open / high / low / close / volume / previous close from NSE's full bhavcopy, sent for the days the
sheet's History60 tab is missing (newer days first, then going back until it has 60).
A local HTTP server plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-history60.test.js (prints OK on success, raises on failure)."""
import importlib.util
import os
import tempfile
import threading
import urllib.request
from datetime import date, timedelta
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

TMP = tempfile.mkdtemp()
sb.EOD_STATE_PATH = os.path.join(TMP, 'eod_state.json')
sb.HIST_STATE_PATH = os.path.join(TMP, 'history_state.json')
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.time.sleep = lambda s: None

HEAD = ('SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, '
        'TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\r\n')
BHAV = (HEAD +
        'TCS, EQ, 27-Oct-2026, 3900.00, 3910.00, 3960.00, 3900.00, 3950.00, 3948.00, 3940.00, 100000, 3940.00, 5000, 61234, 61.23\r\n'
        'LOWCIR, BE, 27-Oct-2026, 20.00, 19.50, 19.50, 19.00, 19.00, 19.00, 19.10, 3000, 0.57, 40, -, -\r\n'
        'SMEX, SM, 27-Oct-2026, 10.00, 10.00, 10.50, 10.00, 10.50, 10.50, 10.20, 6000, 0.61, 8, 6000, 100.00\r\n'
        'NOTRADE, EQ, 27-Oct-2026, 30.00, 0.00, 0.00, 0.00, 0.00, 30.00, 0.00, 0, 0.00, 0, -, -\r\n'
        'TCS, BL, 27-Oct-2026, 3900.00, 3900.00, 3900.00, 3900.00, 3900.00, 3800.00, 3900.00, 10, 0.39, 1, 10, 100.00\r\n'
        'NOPREV, EQ, 27-Oct-2026, -, 50.00, 51.00, 49.00, 50.00, 50.00, 50.00, 700, 0.35, 12, 350, 50.00\r\n')

# ---------------------------------------------------------------- the candles of a day
rows = sb.hist_rows(sb.bhav_parse(BHAV.encode()))
assert rows == {'TCS': [3910.0, 3960.0, 3900.0, 3948.0, 100000, 3900.0], 'LOWCIR': [19.5, 19.5, 19.0, 19.0, 3000, 20.0],
                'NOPREV': [50.0, 51.0, 49.0, 50.0, 700, None]}, rows
# (SMEX = SME series, NOTRADE = no trades; TCS of the BL series loses to EQ)

# ---------------------------------------------------------------- the step against a pretend NSE and sheet
HOLIDAYS = {date(2026, 10, 2), date(2026, 10, 20)}
TODAY = date(2026, 10, 28)                       # Wed: today's file is not out yet


def day_csv(d):
    px = 100 + (d - date(2026, 1, 1)).days / 10
    return (HEAD + 'TCS, EQ, %s, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, %.2f, 1000, 1.00, 10, 500, 50.00\r\n'
            % (d.strftime('%d-%b-%Y'), px - 0.1, px, px + 1, px - 1, px, px, px)).encode()


FILES, HITS = {}, []


def publish(until):
    d = date(2026, 5, 1)
    while d <= until:
        if d.weekday() < 5 and d not in HOLIDAYS:
            FILES['/products/content/sec_bhavdata_full_%s.csv' % d.strftime('%d%m%Y')] = (200, day_csv(d))
        d += timedelta(days=1)


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body = FILES.get(self.path.split('?')[0], (404, b'<Error>NoSuchKey</Error>'))
        self.send_response(st)
        self.send_header('Content-Type', 'text/csv')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.EOD_FILES = dict(sb.EOD_FILES, bhav=(BASE + '/products/content/sec_bhavdata_full_{d}.csv',))
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))

SHEET, POSTS, REPLY = set(), [], {}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'hist', action
    POSTS.append(sorted(payload['days']))
    if REPLY.get('r'):
        return REPLY['r']
    for d, rows in payload['days'].items():
        assert rows['TCS'][3] > 0 and len(rows['TCS']) == 6, rows
        SHEET.add(d)
    keep = sorted(SHEET)[-60:]
    SHEET.intersection_update(keep)
    return {'ok': True, 'mode': 'added', 'days': len(keep), 'want': 60, 'oldest': keep[0], 'newest': keep[-1], 'symbols': 1}


def h60():
    return {'days': sorted(SHEET, reverse=True), 'want': 60}


sb.api = fake_api
LOGS = []
sb.log = LOGS.append
CFG = {'url': 'x', 'token': 'y'}

# 1) an empty History60 tab: back from today (not out yet) until 60 trading days, 10 a post
publish(date(2026, 10, 27))
n = sb.hist_step(CFG, h60(), today=TODAY)
assert n == 60 and len(SHEET) == 60, (n, len(SHEET))
assert max(SHEET) == '2026-10-27' and not any(d.isoformat() in SHEET for d in HOLIDAYS), sorted(SHEET)
assert [len(p) for p in POSTS] == [10] * 6, POSTS
assert POSTS[0][-1] == '2026-10-27' and POSTS[0][0] == '2026-10-13', 'newest first, going back (20-10 is a holiday)'
st = sb.hist_load_state()
assert st['misses'] == {'2026-10-02': 1, '2026-10-20': 1}, st      # today's missing file is not a miss
log = '\n'.join(LOGS)
assert 'History60: sent 13-10-2026 .. 27-10-2026 (10 days) - the sheet has 10 of 60 days.' in log, log
assert ('History60: 60 days sent; the sheet keeps 60 of 60 trading days (%s to 2026-10-27) for 1 stocks.' % min(SHEET)) in log, log

# 2) the same evening again: nothing to send
del POSTS[:], LOGS[:], HITS[:]
assert sb.hist_step(CFG, h60(), today=TODAY) == 0 and POSTS == []
assert LOGS == ["History60: up to date (the sheet has 60 of 60 days; today's bhavcopy is not out yet)."], LOGS
assert len(HITS) == 1, HITS

# 3) two days later: the newer days in date order (the oldest go out at the sheet's end)
publish(date(2026, 10, 30))
del POSTS[:], LOGS[:]
assert sb.hist_step(CFG, h60(), today=date(2026, 10, 30)) == 3
assert POSTS == [['2026-10-28', '2026-10-29', '2026-10-30']], POSTS
assert max(SHEET) == '2026-10-30' and len(SHEET) == 60

# 4) a day the end-of-day step already downloaded this run is not downloaded again
d31 = date(2026, 11, 2)
sb._BHAV_CACHE[d31] = sb.bhav_parse(day_csv(d31))
del POSTS[:], HITS[:]
assert sb.hist_step(CFG, h60(), today=d31) == 1 and POSTS == [['2026-11-02']] and HITS == [], (POSTS, HITS)

# 5) an older web app: the deploy hint, nothing kept as sent
REPLY['r'] = {'ok': False, 'error': 'unknown action'}
publish(date(2026, 11, 3))
del POSTS[:], LOGS[:]
assert sb.hist_step(CFG, h60(), today=date(2026, 11, 3)) == 0
assert 'Version: New version > Deploy' in '\n'.join(LOGS) and '2026-11-03' not in SHEET, LOGS
REPLY.pop('r')
del LOGS[:], HITS[:]
assert sb.hist_step(CFG, None, today=date(2026, 11, 3)) == 0 and 'do the New version deploy' in LOGS[0] and HITS == []
assert sb.hist_step(dict(CFG, history60=False), h60(), today=date(2026, 11, 3)) == 0 and len(LOGS) == 1

# 6) a download problem stops the round; the next run tries again
sb._BHAV_CACHE.clear()                          # a new run
FILES['/products/content/sec_bhavdata_full_03112026.csv'] = (500, b'oops')
del LOGS[:]
assert sb.hist_step(CFG, h60(), today=date(2026, 11, 3)) == 0
assert any('could not download the bhavcopy - 03-11-2026: HTTP 500 from NSE' in x for x in LOGS), LOGS

# 7) the days downloaded before a problem still go
FILES['/products/content/sec_bhavdata_full_03112026.csv'] = (200, day_csv(date(2026, 11, 3)))
FILES['/products/content/sec_bhavdata_full_04112026.csv'] = (500, b'oops')
sb._BHAV_CACHE.clear()
del POSTS[:], LOGS[:]
assert sb.hist_step(CFG, h60(), today=date(2026, 11, 4)) == 1 and POSTS == [['2026-11-03']], POSTS
assert any('04-11-2026: HTTP 500' in x for x in LOGS), LOGS
print('OK')
