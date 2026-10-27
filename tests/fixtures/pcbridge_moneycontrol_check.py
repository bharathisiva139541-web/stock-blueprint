"""Offline checks for the PC bridge's moneycontrol test (screener_bridge.py mc_lookup / mc_parse / mc_check).
A local HTTP server plays moneycontrol. No network is used. Run by tests/pcbridge-moneycontrol.test.js."""
import importlib.util
import json
import os
import threading
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

SUGGEST = 'suggest1(' + json.dumps([
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/computers-software/tataconsultancyservices/TCS',
     'pdt_dis_nm': 'Tata Consultancy Services&nbsp;<span>INE467B01029, TCS, 532540</span>', 'stock_name': 'Tata Consultancy Services'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/auto-cars-jeeps/mahindramahindra/MM',
     'pdt_dis_nm': 'Mahindra &amp; Mahindra <span>INE101A01026, M&amp;M, 500520</span>', 'stock_name': 'Mahindra &amp; Mahindra'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/acutaaschemicals/AO05',
     'pdt_dis_nm': 'Acutaas Chemicals <span>INE0ABC01010, ACUTAAS, 543349</span>', 'stock_name': 'Acutaas Chemicals'}]) + ')'
OLD_TABLE = """<html><head><title>TCS Consolidated Quarterly Results</title></head><body>
<table class="mctable1"><tr><td>Consolidated Quarterly Results in Rs. Cr.</td><td>Sep '26</td><td>Jun '26</td><td>Mar '26</td><td>Dec '25</td><td>Sep '25</td></tr>
<tr><td colspan="6">12 Months</td></tr>
<tr><td>Net Sales/Income from operations</td><td>66,000.00</td><td>63,000.00</td><td>64,000.00</td><td>63,500.00</td><td>60,000.00</td></tr>
<tr><td>Other Operating Income</td><td>--</td><td>--</td><td>--</td><td>--</td><td>--</td></tr>
<tr><td>Net Profit/(Loss) For the Period</td><td>12,600.00</td><td>12,000.00</td><td>12,300.00</td><td>12,100.00</td><td>(1,000.00)</td></tr>
<tr><td>Basic EPS</td><td>34.80</td><td>33.10</td><td>34.00</td><td>33.40</td><td>31.50</td></tr></table></body></html>"""
NEXT_PAGE = """<html><head><title>Acutaas Chemicals quarterly results</title></head><body><div id="root">Sep 2026 Jun 2026</div>
<script id="__NEXT_DATA__" type="application/json">{"props":{}}</script></body></html>"""
ROUTES = {
    '/suggest': (200, SUGGEST),
    '/': (200, '<html>home</html>'),
    '/financials/tataconsultancyservices/results/consolidated-quarterly-results/TCS': (200, OLD_TABLE),
    '/financials/mahindramahindra/results/consolidated-quarterly-results/MM': (404, ''),
    '/financials/mahindramahindra/results/quarterly-results/MM': (200, OLD_TABLE.replace('Consolidated', 'Standalone')),
    '/markets/financials/quarterly-results/acutaaschemicals-AO05/': (200, NEXT_PAGE),
}


class MC(BaseHTTPRequestHandler):
    def do_GET(self):
        st, body = ROUTES.get(self.path.split('?')[0], (404, 'not found'))
        b = body.encode('utf-8')
        self.send_response(st)
        self.send_header('Content-Type', 'text/html')
        self.send_header('Content-Length', str(len(b)))
        self.end_headers()
        self.wfile.write(b)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), MC)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.MC_HOME = BASE + '/'
sb.MC_SUGGEST = BASE + '/suggest?q={q}'
sb.MC_RESULT_URLS = tuple((k, u.replace('https://www.moneycontrol.com', BASE)) for k, u in sb.MC_RESULT_URLS)

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
hit, note = sb.mc_lookup(opener, 'tcs')
assert hit and hit['code'] == 'TCS' and hit['slug'] == 'tataconsultancyservices', (hit, note)
hit, note = sb.mc_lookup(opener, 'M&M')
assert hit and hit['code'] == 'MM', ('M&M via the decoded &amp;', hit, note)
hit, note = sb.mc_lookup(opener, 'INFY')
assert hit is None and 'none listed with NSE symbol INFY' in note, note

res, seen = sb.mc_parse(OLD_TABLE)
assert res['quarters'] == ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025', 'Sep 2025'], res['quarters']
assert res['revenue'] == [66000.0, 63000.0, 64000.0, 63500.0, 60000.0]
assert res['profit'][4] == -1000.0, 'brackets = negative'
assert res['eps'][0] == 34.8
assert abs(sb._growth(res['revenue'], 0, 4) - 10.0) < 1e-9
assert sb._growth(res['profit'], 0, 4) > 0, 'growth from a loss reads as an improvement'
assert sb.mc_parse('<html><body>no tables</body></html>')[0] is None

lines = []
assert sb.mc_check('TCS', out=lines.append) is True
text = '\n'.join(lines)
assert 'found Tata Consultancy Services (moneycontrol code tataconsultancyservices / TCS)' in text, text
assert 'consolidated results: OK - quarters Sep 2026, Jun 2026, Mar 2026, Dec 2025, Sep 2025' in text, text
assert 'latest Sep 2026: revenue 66,000 Cr (QoQ +5%, YoY +10%)' in text, text

lines = []
assert sb.mc_check('M&M', out=lines.append) is True
assert 'consolidated results: HTTP 404' in '\n'.join(lines) and 'standalone results: OK' in '\n'.join(lines), lines

lines = []
assert sb.mc_check('ACUTAAS', out=lines.append) is False
text = '\n'.join(lines)
assert 'new page results: page read' in text and 'quarters mentioned: Jun 2026, Sep 2026' in text and '__NEXT_DATA__' in text, text

srv.shutdown()
print('OK')
