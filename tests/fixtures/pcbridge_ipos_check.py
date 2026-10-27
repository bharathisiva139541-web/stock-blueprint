"""Offline checks for the PC bridge's NSE IPO lists (screener_bridge.py ipo_step).
A local HTTP server plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-ipos.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import sys
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
sb.time.sleep = lambda s: None

# NSE-like answers: a bare list, a {"data": [...]} wrapper, different field spellings
CURRENT = [
    {'symbol': 'EAAA', 'companyName': 'EAAA India Alternatives Limited', 'series': 'EQ', 'issueStartDate': '26-Oct-2026',
     'issueEndDate': '28-OCT-2026', 'status': 'Active', 'issuePrice': 'Rs.400 to Rs.420', 'noOfTime': '0.10'},
    {'symbol': 'TINY', 'companyName': 'Tiny SME Limited', 'series': 'SME', 'issueStartDate': '27-Oct-2026', 'issueEndDate': '29-Oct-2026'},
]
PAST = {'data': [
    {'company': 'Paras Healthcare Limited', 'symbol': 'PARASHLTH', 'securityType': 'EQ', 'issuePrice': '-', 'priceRange': 'Rs.660 to Rs.693',
     'ipoStartDate': '21-10-2026', 'ipoEndDate': '23-10-2026', 'listingDate': '-'},
    {'company': 'Tonbo Imaging India Limited', 'symbol': 'TONBO', 'securityType': 'EQ', 'issuePrice': '700.00', 'priceRange': 'Rs.665 to Rs.700',
     'ipoStartDate': '15-10-2026', 'ipoEndDate': '19-10-2026', 'listingDate': '23-10-2026'},
]}
UPCOMING = {'data': [
    {'series': 'EQ', 'companyName': 'Bombay Coated and Special Steels Limited', 'symbol': 'BCSSL', 'issueStartDate': '2026-10-29',
     'issueEndDate': '2026-11-02', 'status': 'Forthcoming', 'issuePrice': 'Rs.78 to Rs.82', 'issueSize': '2,34,68,846'},
]}
ROUTES = {}
HITS = []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body = ROUTES.get(self.path.split('?')[0], (404, b'{}'))
        self.send_response(st)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.IPO_PAGE = BASE + '/ipo-page'
sb.IPO_SOURCES = (('current', (BASE + '/api/ipo-current-issue',)),
                  ('past', (BASE + '/api/past-a?from_date={f}&to_date={t}', BASE + '/api/past-b?from_date={f}&to_date={t}')),
                  ('upcoming', (BASE + '/api/all-upcoming-issues?category=ipo',)))
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
ROUTES['/api/ipo-current-issue'] = (200, json.dumps(CURRENT).encode())
ROUTES['/api/past-b'] = (200, json.dumps(PAST).encode())     # the first past address fails, the second works
ROUTES['/api/all-upcoming-issues'] = (200, json.dumps(UPCOMING).encode())

SENT = []
SHEET = {'reply': None}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'ipos', action
    SENT.append(payload)
    return SHEET['reply'] or {'ok': True, 'open': 1, 'closed': 1, 'upcoming': 1, 'sme': 1, 'other': 0, 'emailed': True}


sb.api = fake_api
CFG = {'url': 'x', 'token': 'y', 'ipos': True}


def logtail():
    with open(sb.LOG_PATH, encoding='utf-8') as f:
        return f.read()


# --- dates in NSE's spellings
for raw, iso in (('27-Oct-2026', '2026-10-27'), ('27-OCT-2026', '2026-10-27'), ('2026-10-27', '2026-10-27'), ('2026-10-27T00:00:00', '2026-10-27'),
                 ('27-10-2026', '2026-10-27'), ('27/10/2026', '2026-10-27'), ('Oct 27, 2026', '2026-10-27'), ('27 October 2026', '2026-10-27'),
                 ('27-Oct-2026 10:00:00', '2026-10-27'), ('-', ''), ('', ''), ('To be announced', ''), ('31-02-2026', '')):
    assert sb.ipo_date(raw) == iso, (raw, sb.ipo_date(raw))
assert sb.ipo_records([]) == [] and sb.ipo_records({'data': []}) == [] and sb.ipo_records({'msg': 'x'}) is None
assert sb.ipo_is_sme('SME') and sb.ipo_is_sme('sme') and not sb.ipo_is_sme('EQ') and not sb.ipo_is_sme('')
assert sb.ipo_kind({'type': 'EQ', 'symbol': 'X'}) == 'main' and sb.ipo_kind({'type': 'SME'}) == 'sme'
assert sb.ipo_kind({'type': 'DEBT', 'symbol': 'SMCG04'}) == 'other'
assert sb.ipo_kind({'type': '', 'symbol': 'SMCG04', 'price': 'Rs.1,000'}) == 'other'
assert sb.ipo_kind({'type': '', 'symbol': 'PARASHLTH', 'price': 'Rs.660 to Rs.693'}) == 'main'

# --- a run: three lists read, listed issues dropped, everything else sent with yyyy-mm-dd dates
TUE = date(2026, 10, 27)
sb.ipo_step(CFG, today=TUE)
assert len(SENT) == 1, SENT
p = SENT[0]
assert p['failed'] == [], p['failed']
by = {r['symbol']: r for r in p['records']}
assert sorted(by) == ['BCSSL', 'EAAA', 'PARASHLTH', 'TINY'], sorted(by)       # TONBO listed on 23-10: dropped
assert by['EAAA'] == {'list': 'current', 'company': 'EAAA India Alternatives Limited', 'symbol': 'EAAA', 'type': 'EQ',
                      'start': '2026-10-26', 'end': '2026-10-28', 'listing': '', 'price': 'Rs.400 to Rs.420', 'size': ''}, by['EAAA']
assert by['PARASHLTH']['list'] == 'past' and by['PARASHLTH']['listing'] == '' and by['PARASHLTH']['price'] == 'Rs.660 to Rs.693'
assert by['PARASHLTH']['start'] == '2026-10-21' and by['PARASHLTH']['end'] == '2026-10-23'
assert by['BCSSL']['size'] == '2,34,68,846' and by['BCSSL']['start'] == '2026-10-29'
assert by['TINY']['type'] == 'SME', 'SME issues go to the sheet marked as SME (the sheet leaves them out)'
assert any('/api/past-a?from_date=27-09-2026&to_date=27-10-2026' in h for h in HITS), HITS
assert 'IPO lists: 1 open, 1 closed - awaiting listing, 1 upcoming (mainboard equity; 1 SME and 0 debt/other left out), email sent.' in logtail(), logtail()

# --- one list fails: the rest is still sent, the failure is named
del SENT[:]
ROUTES['/api/all-upcoming-issues'] = (200, b'<html><body>Access denied</body></html>')
sb.ipo_step(CFG, today=TUE)
assert SENT[0]['failed'] == ['upcoming'] and 'BCSSL' not in [r['symbol'] for r in SENT[0]['records']]
assert 'could not read upcoming this time' in logtail()

# --- NSE refuses everything: nothing sent
del SENT[:]
for k in list(ROUTES):
    ROUTES[k] = (401, b'{}')
sb.ipo_step(CFG, today=TUE)
assert SENT == [] and 'IPO lists: could not read NSE - current: HTTP 401 from NSE' in logtail(), logtail()

# --- the deployed web app is older: the fix is named
ROUTES['/api/ipo-current-issue'] = (200, json.dumps(CURRENT).encode())
SHEET['reply'] = {'ok': False, 'error': 'unknown action'}
sb.ipo_step(CFG, today=TUE)
assert 'does not know the IPO lists yet' in logtail() and 'New version' in logtail()

# --- switched off in config.json
del SENT[:]
sb.ipo_step(dict(CFG, ipos=False), today=TUE)
assert SENT == []

srv.shutdown()
print('OK')
