"""Offline checks for the PC bridge's NSE PE step (screener_bridge.py pe_*): NSE's PE_DDMMYY.csv (All Reports > PE ratio) ->
{SYM: [pe, adjusted pe]} -> the sheet (action 'nsepe'), the newest day once. A local HTTP server plays NSE, a fake api() plays the
sheet. No network is used. Run by tests/pcbridge-nsepe.test.js (prints OK on success, raises on failure)."""
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
sb.NSE_PE_STATE_PATH = os.path.join(TMP, 'nsepe_state.json')
sb.time.sleep = lambda s: None

# 1. the file, with the column names matched loosely
CSV = (b'SYMBOL,SERIES,SYMBOL P/E,ADJUSTED P/E\r\n'
       b'TCS,EQ,24.15,24.10\r\nIDEA,EQ,-,-\r\nSBIN,EQ,"1,234.5",9.8\r\nSBIN,BE,7,7\r\nBEONLY,BE,11.2,\r\nSMEX,SM,30,30\r\n')
rows = sb.pe_parse(CSV)
assert rows == {'TCS': [24.15, 24.1], 'IDEA': [None, None], 'SBIN': [1234.5, 9.8], 'BEONLY': [11.2, None]}, rows
# another layout: no series column, a title line on top, 'PE' as a word
assert sb.pe_parse(b'PE ratio as on 17-Nov-2026\nSymbol,Company,PE\nINFY,Infosys,25\n') == {'INFY': [25.0, None]}
assert sb.pe_parse(b'<html><body>blocked</body></html>') is None
assert sb.pe_parse(b'SYMBOL,CLOSE\nTCS,4000\n') is None, 'no P/E column = not the file'

# 2. the step: today's file not out yet, yesterday's found through the All Reports list; sent once
TODAY = date(2026, 11, 17)        # Tuesday
FILES = {'/content/equities/peDetail/PE_161126.csv': CSV}
HITS = []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        if self.path.startswith('/api/merged-daily-reports'):
            body = json.dumps([{'name': 'PE ratio', 'link': 'http://127.0.0.1:%d/content/equities/peDetail/PE_161126.csv' % PORT}]).encode()
        else:
            body = FILES.get(self.path)
            if body is None:
                self.send_response(404)
                self.end_headers()
                return
        self.send_response(200)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
PORT = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
sb.NSE_PE_URLS = ('http://127.0.0.1:%d/guess/PE_{d}.csv' % PORT,)
sb.PB_REPORTS_API = 'http://127.0.0.1:%d/api/merged-daily-reports?key=favCapital' % PORT
POSTS = []
ANSWER = {'ok': True, 'matched': 3, 'industryPe': {'industries': 120}}
sb.api = lambda cfg, action, payload=None, **k: (POSTS.append((action, payload)), dict(ANSWER))[1]
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
assert sb.pe_step({'nse_pe': True}, today=TODAY, opener=opener) is True
assert [p[0] for p in POSTS] == ['nsepe'] and POSTS[0][1]['day'] == '2026-11-16', POSTS
assert POSTS[0][1]['rows']['TCS'] == [24.15, 24.1]
assert json.load(open(sb.NSE_PE_STATE_PATH))['last'] == '2026-11-16'
log = open(sb.LOG_PATH, encoding='utf-8').read()
assert 'NSE PE 16-11-2026: 4 stocks from NSE -> the sheet (3 of your Main stocks); Industry PE worked out for 120 industries.' in log, log
# the same day again: nothing to send
assert sb.pe_step({'nse_pe': True}, today=TODAY, opener=opener) is False and len(POSTS) == 1
# the next evening's file
FILES['/guess/PE_171126.csv'] = CSV
assert sb.pe_step({'nse_pe': True}, today=TODAY, opener=opener) is True and POSTS[-1][1]['day'] == '2026-11-17'
# an older web app: not marked as sent, a hint in the log
os.remove(sb.NSE_PE_STATE_PATH)
ANSWER = {'ok': False, 'error': 'unknown action'}
assert sb.pe_step({'nse_pe': True}, today=TODAY, opener=opener) is False
assert not os.path.exists(sb.NSE_PE_STATE_PATH)
assert 'web app does not know this yet' in open(sb.LOG_PATH, encoding='utf-8').read()
# switched off
assert sb.pe_step({'nse_pe': False}, today=TODAY, opener=opener) is False
# 3. run_once runs it right after the end-of-day files
src = open(os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'), encoding='utf-8').read()
assert 'eod_step(cfg)\n        pe_step(cfg)' in src
srv.shutdown()
print('OK')
