"""Offline checks for the PC bridge's result announcement times (screener_bridge.py ann_*): NSE's corporate
announcements -> the result filings (earliest per stock per day) sent to the sheet; notices of meetings to come are
left out. A local HTTP server plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-announcements.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import tempfile
import threading
import urllib.request
from datetime import date
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)
TMP = tempfile.mkdtemp()
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.ANN_STATE_PATH = os.path.join(TMP, 'announcements_state.json')

# ---------------------------------------------------------------- times and the result filter
assert sb.ann_time('29-Oct-2026 17:05:25') == '2026-10-29 17:05:25'
assert sb.ann_time('2026-10-29 17:05:25') == '2026-10-29 17:05:25'
assert sb.ann_time('29-Oct-2026 09:05') == '2026-10-29 09:05:00'
assert sb.ann_time('29-10-2026 17:05') == '2026-10-29 17:05:00'
assert sb.ann_time('') is None and sb.ann_time('soon') is None and sb.ann_time('31-Feb-2026 10:00') is None
assert sb.ann_is_result('Outcome of Board Meeting', 'Borosil Limited has submitted to the Exchange, the Unaudited Financial Results (Standalone & Consolidated) for the Quarter')
assert sb.ann_is_result('Financial Result Updates', '')
assert sb.ann_is_result('Integrated Filing- Financial', 'Integrated filing for the quarter')
assert not sb.ann_is_result('Board Meeting Intimation', 'to consider and approve the Financial Results for the quarter')
assert not sb.ann_is_result('Outcome of Board Meeting', 'approved the interim dividend of Rs 2 per share')
assert not sb.ann_is_result('Analysts/Institutional Investor Meet/Con. Call Updates', 'financial results discussion')

# NSE's real field names (as on the Corporate Filings page's data)
ANN = [
    {'symbol': 'BOROLTD', 'desc': 'Options to purchase securities', 'an_dt': '29-Oct-2026 17:34:51', 'sort_date': '2026-10-29 17:34:51',
     'attchmntText': 'Borosil Limited has informed the Exchange about grant of employee stock options'},
    {'symbol': 'BOROLTD', 'desc': 'Outcome of Board Meeting', 'an_dt': '29-Oct-2026 17:05:25', 'sort_date': '2026-10-29 17:05:25',
     'attchmntText': 'Borosil Limited has submitted to the Exchange, the Unaudited Financial Results (Standalone & Consolidated) for the Quarter'},
    {'symbol': 'BOROLTD', 'desc': 'Financial Result Updates', 'an_dt': '29-Oct-2026 18:10:00', 'attchmntText': 'XBRL'},
    {'symbol': 'TCS', 'desc': 'Board Meeting Intimation', 'an_dt': '27-Oct-2026 10:00:00', 'attchmntText': 'to consider the Financial Results'},
    {'symbol': 'TCS', 'desc': 'Outcome of Board Meeting', 'an_dt': '30-Oct-2026 13:20:11', 'attchmntText': 'Audited Financial Results for the quarter'},
    {'symbol': 'INFY', 'desc': 'Financial Results', 'an_dt': '30-Oct-2026 08:40:00', 'attchmntText': ''},
]
rows, timed = sb.ann_rows(ANN)
assert timed == 6, timed
assert rows == [['BOROLTD', '2026-10-29 17:05:25', 'Outcome of Board Meeting'], ['INFY', '2026-10-30 08:40:00', 'Financial Results'],
                ['TCS', '2026-10-30 13:20:11', 'Outcome of Board Meeting']], rows

# ---------------------------------------------------------------- the step against a pretend NSE and sheet
HITS, BODY = [], {'v': json.dumps(ANN).encode()}


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        body = BODY['v'] if self.path.startswith('/api/corporate-announcements') else b'<html>ok</html>'
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.ANN_URL = BASE + '/api/corporate-announcements?index=equities&from_date={f}&to_date={t}'
sb.ANN_PAGE = BASE + '/companies-listing/corporate-filings-announcements'
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
POSTS, LOGS, REPLY = [], [], {}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'results_ann', action
    POSTS.append(payload)
    return REPLY.get('r') or {'ok': True, 'received': len(payload['ann']), 'main': 2, 'fresh': 1, 'emailed': True}


sb.api = fake_api
sb.log = LOGS.append
CFG = {'url': 'x', 'token': 'y'}
sb.ann_step(CFG, today=date(2026, 10, 30), back_chunks=0)
assert any('from_date=27-10-2026&to_date=30-10-2026' in h for h in HITS), HITS
assert POSTS[0]['ann'] == rows and POSTS[0]['from'] == '2026-10-27' and POSTS[0]['to'] == '2026-10-30', POSTS
assert LOGS == ['Result announcements: 3 result filing(s) on NSE since 27-10-2026, 2 of your stocks (1 new) - morning email sent.'], LOGS

# NSE wrapped in {"data": [...]}, an older web app, a web page instead of data, unknown date fields, switched off
BODY['v'] = json.dumps({'data': ANN}).encode()
REPLY['r'] = {'ok': False, 'error': 'unknown action'}
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 10, 30), back_chunks=0)
assert POSTS[0]['ann'] == rows and 'Version: New version > Deploy' in LOGS[0], LOGS
REPLY.clear()
BODY['v'] = b'<html>Access Denied</html>'
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 10, 30), back_chunks=0)
assert POSTS == [] and 'a web page came back instead' in LOGS[0], LOGS
BODY['v'] = json.dumps([{'symbol': 'X', 'desc': 'Financial Results', 'when': 'yesterday'}]).encode()
del LOGS[:]
sb.ann_step(CFG, today=date(2026, 10, 30), back_chunks=0)
assert POSTS == [] and "NSE's dates were not recognised - its fields: desc, symbol, when" in LOGS[0], LOGS
del LOGS[:], HITS[:]
sb.ann_step(dict(CFG, announcements=False), today=date(2026, 10, 30), back_chunks=0)
assert LOGS == [] and HITS == []

# ---------------------------------------------------------------- the whole results season once (owner, 16-Nov-2026: 118 Main
# stocks had no Result Date although they had filed - ECOSMOBLTY on 13-Nov among them)
assert sb.ann_season_start(date(2026, 11, 16)) == date(2026, 10, 1) and sb.ann_season_start(date(2026, 10, 1)) == date(2026, 10, 1)
assert sb.ann_season_start(date(2027, 1, 20)) == date(2027, 1, 1) and sb.ann_season_start(date(2027, 5, 30)) == date(2027, 4, 1)
assert sb.ann_season_start(date(2026, 9, 30)) == date(2026, 7, 1)
os.remove(sb.ANN_STATE_PATH) if os.path.exists(sb.ANN_STATE_PATH) else None
st = sb.ann_state_load(date(2026, 11, 16))
assert st == {'season': '2026-10-01', 'days': []}
# the usual window is 13..16-Nov; the catch-up = 01-Oct .. 12-Nov, 4 days a request, newest first
todo = sb.ann_back_todo(date(2026, 11, 16), st, 99)
assert todo[0] == (date(2026, 11, 9), date(2026, 11, 12)) and todo[-1] == (date(2026, 10, 1), date(2026, 10, 3)) and len(todo) == 11, todo
st['days'] = ['2026-11-10', '2026-11-11']
assert sb.ann_back_todo(date(2026, 11, 16), st, 2) == [(date(2026, 11, 12), date(2026, 11, 12)), (date(2026, 11, 6), date(2026, 11, 9))]
BODY['v'] = json.dumps(ANN).encode()
REPLY['r'] = {'ok': True, 'received': 3, 'main': 2, 'fresh': 1, 'results': {'added': ['ECOSMOBLTY', 'MUTHOOTFIN'], 'replaced': ['RELIANCE']}}
del LOGS[:], POSTS[:], HITS[:]
sb.ann_step(CFG, today=date(2026, 11, 16))                     # a round: the usual window + 3 requests of the catch-up
assert [p.get('backfill') for p in POSTS] == [None, True, True, True], POSTS
assert [(p['from'], p['to']) for p in POSTS] == [('2026-11-13', '2026-11-16'), ('2026-11-09', '2026-11-12'), ('2026-11-05', '2026-11-08'),
                                                 ('2026-11-01', '2026-11-04')], POSTS
assert any('from_date=09-11-2026&to_date=12-11-2026' in h for h in HITS), HITS
assert LOGS[0].endswith(' - the Results tab got 3 result date(s) from these filings (ECOSMOBLTY, MUTHOOTFIN, RELIANCE).'), LOGS
assert LOGS[1].startswith('Result announcements: catching up the results season 09-11 .. 12-11 - 3 result filing(s), 2 of your stocks'), LOGS
assert LOGS[-1] == ('Result announcements: 8 more part(s) of the season to catch up - the next rounds do them '
                    '(or AnnouncementsNow.bat all at once).'), LOGS
st = sb.ann_state_load(date(2026, 11, 16))
assert st['days'][0] == '2026-11-01' and st['days'][-1] == '2026-11-15' and '2026-11-16' not in st['days'], st
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 11, 16), back_chunks=99)       # AnnouncementsNow.bat: the rest at once
assert len(POSTS) == 1 + 8 and POSTS[-1]['from'] == '2026-10-01' and not LOGS[-1].startswith('Result announcements: 8 more'), LOGS
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 11, 16))                     # all caught up: only the usual window
assert len(POSTS) == 1, POSTS
# NSE refuses a catch-up request: stopped, the days stay to do
os.remove(sb.ANN_STATE_PATH)
del LOGS[:], POSTS[:]
real_fetch = sb.ann_fetch
sb.ann_fetch = lambda opener, today, start=None: (None, 'HTTP 503 from NSE') if start and start < date(2026, 11, 1) else real_fetch(opener, today, start)
sb.ann_step(CFG, today=date(2026, 11, 16), back_chunks=99)
sb.ann_fetch = real_fetch
assert len(POSTS) == 4 and any('catching up 28-10 .. 31-10 - could not read NSE - HTTP 503 from NSE' in m for m in LOGS), LOGS
assert '2026-10-31' not in sb.ann_state_load(date(2026, 11, 16))['days']
# a new season starts afresh
assert sb.ann_state_load(date(2027, 1, 5)) == {'season': '2027-01-01', 'days': []}
print('OK')
