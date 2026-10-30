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
sb.LOG_PATH = os.path.join(tempfile.mkdtemp(), 'bridge.log')

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
sb.ann_step(CFG, today=date(2026, 10, 30))
assert any('from_date=27-10-2026&to_date=30-10-2026' in h for h in HITS), HITS
assert POSTS[0]['ann'] == rows and POSTS[0]['from'] == '2026-10-27' and POSTS[0]['to'] == '2026-10-30', POSTS
assert LOGS == ['Result announcements: 3 result filing(s) on NSE since 27-10-2026, 2 of your stocks (1 new) - morning email sent.'], LOGS

# NSE wrapped in {"data": [...]}, an older web app, a web page instead of data, unknown date fields, switched off
BODY['v'] = json.dumps({'data': ANN}).encode()
REPLY['r'] = {'ok': False, 'error': 'unknown action'}
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 10, 30))
assert POSTS[0]['ann'] == rows and 'Version: New version > Deploy' in LOGS[0], LOGS
REPLY.clear()
BODY['v'] = b'<html>Access Denied</html>'
del LOGS[:], POSTS[:]
sb.ann_step(CFG, today=date(2026, 10, 30))
assert POSTS == [] and 'a web page came back instead' in LOGS[0], LOGS
BODY['v'] = json.dumps([{'symbol': 'X', 'desc': 'Financial Results', 'when': 'yesterday'}]).encode()
del LOGS[:]
sb.ann_step(CFG, today=date(2026, 10, 30))
assert POSTS == [] and "NSE's dates were not recognised - its fields: desc, symbol, when" in LOGS[0], LOGS
del LOGS[:], HITS[:]
sb.ann_step(dict(CFG, announcements=False), today=date(2026, 10, 30))
assert LOGS == [] and HITS == []
print('OK')
