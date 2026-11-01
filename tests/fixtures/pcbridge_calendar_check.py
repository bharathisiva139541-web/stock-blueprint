"""Offline checks for the PC bridge's results calendar (screener_bridge.py cal_*): NSE's Event Calendar (All
Forthcoming, Equity + SME) -> the "Financial Results" meetings sent to the sheet, once a day. A local HTTP server
plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-calendar.test.js (prints OK on success, raises on failure)."""
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
sb.CAL_STATE_PATH = os.path.join(TMP, 'calendar_state.json')
sb.time.sleep = lambda s: None

# NSE's field names on the Event Calendar page's data
EQ = [{'symbol': 'POWERGRID', 'company': 'Power Grid Corporation of India Limited', 'purpose': 'Financial Results/Dividend',
       'bm_desc': 'To consider and approve the Unaudited Financial Results', 'date': '01-Nov-2026'},
      {'symbol': 'SAIPARENT', 'company': 'Sai Parenterals Limited', 'purpose': 'Financial Results', 'bm_desc': '...', 'date': '01-Nov-2026'},
      {'symbol': 'AAKASH', 'company': 'Aakash Exploration Services Limited', 'purpose': 'Financial Results/Other business matters', 'date': '02-Nov-2026'},
      {'symbol': 'BUYCO', 'company': 'Buy Co', 'purpose': 'Buyback', 'date': '03-Nov-2026'},
      {'symbol': 'AAKASH', 'company': 'Aakash Exploration Services Limited', 'purpose': 'Financial Results', 'date': '20-Nov-2026'},
      {'symbol': 'NODATE', 'company': 'x', 'purpose': 'Financial Results', 'date': 'soon'}]
SME = {'data': [{'symbol': 'SMEONE', 'company': 'SME One Limited', 'purpose': 'Financial Results/Fund Raising', 'date': '04-Nov-2026'}]}

rows, dated = sb.cal_rows(EQ)
assert dated == 5, dated
assert rows == [['POWERGRID', 'Power Grid Corporation of India Limited', 'Financial Results/Dividend', '2026-11-01'],
                ['SAIPARENT', 'Sai Parenterals Limited', 'Financial Results', '2026-11-01'],
                ['AAKASH', 'Aakash Exploration Services Limited', 'Financial Results/Other business matters', '2026-11-02']], rows

BODY = {'/api/event-calendar?index=equities': json.dumps(EQ).encode(), '/api/event-calendar?index=sme': json.dumps(SME).encode()}
HITS = []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        body = BODY.get(self.path, b'<html>page</html>')
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
sb.CAL_SOURCES = (('equity', BASE + '/api/event-calendar?index=equities'), ('SME', BASE + '/api/event-calendar?index=sme'))
sb.CAL_PAGE = BASE + '/companies-listing/corporate-filings-event-calendar'
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
POSTS, LOGS, REPLY = [], [], {}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'calendar', action
    POSTS.append(payload)
    return REPLY.get('r') or {'ok': True, 'received': len(payload['rows']), 'added': ['POWERGRID', 'SAIPARENT', 'SMEONE']}


sb.api = fake_api
sb.log = LOGS.append
CFG = {'url': 'x', 'token': 'y'}
SUN = date(2026, 11, 1)

sb.cal_step(CFG, today=SUN)
assert [r[0] for r in POSTS[0]['rows']] == ['POWERGRID', 'SAIPARENT', 'AAKASH', 'SMEONE'], POSTS
assert LOGS == ['Results calendar: 4 forthcoming result meeting(s) on NSE (equity 3, SME 1); 3 added to the Results tab - POWERGRID, SAIPARENT, SMEONE.'], LOGS
assert json.load(open(sb.CAL_STATE_PATH))['day'] == '2026-11-01'

# once a day: the second round the same day does nothing; the next day again; "calendar" command forces it
del POSTS[:], LOGS[:], HITS[:]
sb.cal_step(CFG, today=SUN)
assert POSTS == [] and HITS == [] and LOGS == []
sb.cal_step(CFG, today=SUN, force=True)
assert len(POSTS) == 1
REPLY['r'] = {'ok': True, 'added': []}
del POSTS[:], LOGS[:]
sb.cal_step(CFG, today=date(2026, 11, 2))
assert len(POSTS) == 1 and LOGS[0].endswith('; 0 added to the Results tab.'), LOGS

# one list unreadable: the other is still sent, and the day is tried again later
BODY['/api/event-calendar?index=sme'] = b'<html>Access Denied</html>'
REPLY.pop('r')
del POSTS[:], LOGS[:]
sb.cal_step(CFG, today=date(2026, 11, 3))
assert [r[0] for r in POSTS[0]['rows']] == ['POWERGRID', 'SAIPARENT', 'AAKASH'] and 'SME: NSE did not send data' in LOGS[1], LOGS
assert json.load(open(sb.CAL_STATE_PATH))['day'] == '2026-11-02', 'not marked done'

# both unreadable / an older web app / switched off
BODY['/api/event-calendar?index=equities'] = b'<html>Access Denied</html>'
del POSTS[:], LOGS[:]
sb.cal_step(CFG, today=date(2026, 11, 3))
assert POSTS == [] and LOGS[0].startswith('Results calendar: could not read NSE'), LOGS
BODY['/api/event-calendar?index=equities'] = json.dumps(EQ).encode()
REPLY['r'] = {'ok': False, 'error': 'unknown action'}
del LOGS[:]
sb.cal_step(CFG, today=date(2026, 11, 3))
assert 'Version: New version > Deploy' in LOGS[0], LOGS
del LOGS[:], HITS[:]
sb.cal_step(dict(CFG, calendar=False), today=date(2026, 11, 3))
assert LOGS == [] and HITS == []
print('OK')
