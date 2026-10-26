"""Offline checks for the PC bridge's NSE price band download (screener_bridge.py).
A local HTTP server plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-pricebands.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import sys
import tempfile
import threading
import urllib.request
from datetime import date
from http.server import BaseHTTPRequestHandler, HTTPServer
from http.cookiejar import CookieJar

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

TMP = tempfile.mkdtemp()
sb.PB_STATE_PATH = os.path.join(TMP, 'pricebands_state.json')
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.time.sleep = lambda s: None

CSV = ('Sr.No,Symbol,Series,Security Name,From,To\r\n'
       '1,SBIN,EQ,State Bank of India,10,20\r\n'
       '2,ABC,BE,"ABC Industries, Ltd",20,5\r\n'
       '3,XYZ,EQ,XYZ Ltd,No Band,20\r\n')
FILES = {}          # path -> (status, bytes, content type)
HITS = []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body, ct = FILES.get(self.path.split('?')[0], (404, b'<Error>NoSuchKey</Error>', 'application/xml'))
        self.send_response(st)
        self.send_header('Content-Type', ct)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.PB_URLS = (BASE + '/content/equities/eq_band_changes_{d}.csv', BASE + '/old/eq_band_changes_{d}.csv')
sb.PB_REPORTS_API = BASE + '/api/merged-daily-reports'
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def put(day, body=CSV.encode('utf-8'), status=200, ct='text/csv', path=None):
    FILES[path or '/content/equities/eq_band_changes_%s.csv' % day.strftime('%d%m%Y')] = (status, body, ct)


SENT = []
SHEET = {'reply': None}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'pricebands', action
    SENT.append(payload)
    if SHEET['reply']:
        return SHEET['reply']
    return {'ok': True, 'rows': len(payload['rows']), 'added': len(payload['rows']), 'inMain': 1, 'emailed': True}


sb.api = fake_api
CFG = {'url': 'x', 'token': 'y', 'price_bands': True}


def state():
    return sb.pb_load_state()


def logtail():
    with open(sb.LOG_PATH, encoding='utf-8') as f:
        return f.read()


# --- the parser
rows = sb.pb_parse(CSV.encode('utf-8-sig'))
assert rows == [
    {'symbol': 'SBIN', 'series': 'EQ', 'name': 'State Bank of India', 'from': '10', 'to': '20'},
    {'symbol': 'ABC', 'series': 'BE', 'name': 'ABC Industries, Ltd', 'from': '20', 'to': '5'},
    {'symbol': 'XYZ', 'series': 'EQ', 'name': 'XYZ Ltd', 'from': 'No Band', 'to': '20'}], rows
alt = sb.pb_parse(b'SYMBOL,SERIES,SECURITY NAME,BAND FROM,BAND TO\nINFY,EQ,Infosys,5,10\n')
assert alt == [{'symbol': 'INFY', 'series': 'EQ', 'name': 'Infosys', 'from': '5', 'to': '10'}], alt
assert sb.pb_parse(b'<!DOCTYPE html><html><body>Access denied</body></html>') is None
assert sb.pb_parse(b'a,b,c\n1,2,3\n') is None

# --- which files are checked (NSE names a file after the day its bands apply: the next trading day)
MON, TUE, WED, THU, FRI = (date(2026, 10, d) for d in (26, 27, 28, 29, 30))
assert sb.prev_weekday(MON) == date(2026, 10, 23) and sb.next_weekday(FRI) == date(2026, 11, 2)
assert sb.pb_days_to_check(MON, None) == [date(2026, 10, d) for d in (19, 20, 21, 22, 23, 26, 27, 28)], 'a week back, two trading days ahead'
assert sb.pb_days_to_check(MON, TUE) == [WED]
assert sb.pb_days_to_check(FRI, FRI) == [date(2026, 11, 2), date(2026, 11, 3)], 'Friday evening: Monday\'s file'

# --- 1) Monday evening, state left by the first version ({"last": file date, no "v"}): the last week is
#        re-sent once with the right report dates (the sheet skips / clears what it already has)
with open(sb.PB_STATE_PATH, 'w') as f:
    json.dump({'last': '2026-10-26'}, f)
put(date(2026, 10, 23))     # published Thu 22 evening
put(MON)                    # published Fri 23 evening
put(TUE)                    # published this (Mon 26) evening
sb.price_bands_step(CFG, today=MON)
assert [p['reportDate'] for p in SENT] == ['2026-10-22', '2026-10-23', '2026-10-26'], SENT
assert SENT[2]['rows'][0]['symbol'] == 'SBIN'
assert state()['last'] == '2026-10-27' and state()['v'] == 2, state()
assert 'Price bands from 27-10-2026: 3 change(s) from NSE, 3 new on the sheet, 1 in Main, email sent.' in logtail(), logtail()

# --- 2) the second run an hour later: only Wednesday's file (not out) is asked for, nothing sent
del SENT[:]
del HITS[:]
sb.price_bands_step(CFG, today=MON)
assert SENT == [], SENT
assert all('28102026' in h for h in HITS), HITS
assert 'Price bands: up to date (latest file: bands from 27-10-2026).' in logtail(), logtail()

# --- 3) Tuesday evening: Wednesday's file not out yet -> retried next run
sb.price_bands_step(CFG, today=TUE)
assert SENT == [] and state()['last'] == '2026-10-27'
assert 'the file for 28-10-2026 (NSE publishes it in the evening) is not out yet' in logtail(), logtail()
# ... NSE moved the file: found through the All Reports list (escaped JSON slashes)
FILES['/api/merged-daily-reports'] = (200, json.dumps([{'link': BASE + '/new/eq_band_changes_28102026.csv'}]).replace('/', '\\/').encode(), 'application/json')
put(WED, path='/new/eq_band_changes_28102026.csv')
sb.price_bands_step(CFG, today=TUE)
assert [p['reportDate'] for p in SENT] == ['2026-10-27'], SENT
assert state()['last'] == '2026-10-28'

# --- 4) Wednesday evening: NSE answers with a web page instead of Thursday's file -> reported, nothing sent
del SENT[:]
put(THU, body=b'<html><body>Resource not available</body></html>', ct='text/html')
sb.price_bands_step(CFG, today=WED)
assert SENT == [] and state()['last'] == '2026-10-28'
assert 'could not download from NSE - 29-10-2026' in logtail(), logtail()

# --- 5) the deployed web app is older (no 'pricebands' action): state stays, the fix is named
put(THU)
SHEET['reply'] = {'ok': False, 'error': 'unknown action'}
sb.price_bands_step(CFG, today=WED)
assert state()['last'] == '2026-10-28'
assert 'New version' in logtail()
SHEET['reply'] = None
sb.price_bands_step(CFG, today=WED)
assert state()['last'] == '2026-10-29'
assert SENT[-1]['reportDate'] == '2026-10-28'

# --- 6) switched off in config.json
del SENT[:]
put(FRI)
sb.price_bands_step(dict(CFG, price_bands=False), today=THU)
assert SENT == []

srv.shutdown()
print('OK')
