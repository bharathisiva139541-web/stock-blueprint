"""Offline checks for the PC bridge's moneycontrol test (screener_bridge.py mc_lookup / mc_parse / mc_from_json / mc_check).
A local HTTP server plays moneycontrol. No network is used. Run by tests/pcbridge-moneycontrol.test.js."""
import importlib.util
import json
import os
import shutil
import tempfile
import threading
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

# ---------------------------------------------------------------- quarter names, row names, field names
Q = sb._qlabel
assert Q("Sep '26") == Q('Sep-26') == Q('Sep 2026') == Q('September 2026') == Q('Sept. 2026') == 'Sep 2026'
assert Q('Q2FY27') == Q('Q2 FY 2026-27') == Q("Q2 FY'27") == 'Sep 2026'
assert Q('Q4FY26') == 'Mar 2026' and Q('Q1 FY27') == 'Jun 2026' and Q('Q3FY27') == 'Dec 2026'
assert Q('2026-09-30') == Q('2026-09-30T00:00:00') == Q('30-Sep-2026') == Q('30 Sep 26') == Q('Sep 30, 2026') == Q('202609') == 'Sep 2026'
assert Q('2026-10-21') is None, 'a result date is not a quarter'
assert Q('Oct 2026') == 'Oct 2026' and Q('Oct 2026', True) is None, 'strict = quarter-end months only'
assert Q('Net Sales') is None and Q(202609) is None and Q('') is None
assert sb._qshift('Mar 2026', 3) == 'Dec 2025' and sb._qshift('Sep 2026', 12) == 'Sep 2025'
assert sb._num('(1,000.50)') == -1000.5 and sb._num('Rs. 1,234 Cr') == 1234 and sb._num('--') is None and sb._num(True) is None and sb._num(5) == 5.0
assert sb._rowkey('Net Sales/Income from operations') == ('revenue', 0)
assert sb._rowkey('Net Sales') == ('revenue', 3) and sb._rowkey('Total Income') == ('revenue', 8)
assert sb._rowkey('Net Profit/(Loss) For the Period:') == ('profit', 0)
assert sb._rowkey('Basic EPS') == ('eps', 0) and sb._rowkey('EPS (Rs)')[0] == 'eps'
assert sb._rowkey('Net Profit Margin (%)') is None and sb._rowkey('Sales Growth') is None and sb._rowkey('Other Income') is None
F = sb._fieldkey
assert F('netSales') == ('revenue', 0) and F('total_income')[0] == 'revenue' and F('revenueFromOperations') == ('revenue', 1)
assert F('netProfit') == ('profit', 0) and F('pat') == ('profit', 2) and F('netIncome')[0] == 'profit'
assert F('basicEps') == ('eps', 0) and F('dilutedEPS') == ('eps', 1)
for bad in ('otherIncome', 'operatingProfit', 'grossProfit', 'profitBeforeTax', 'netProfitMargin', 'salesGrowth', 'patYoy', 'totalExpenses', 'incomeTax', 'resultDate', 'id'):
    assert F(bad) is None, bad

# ---------------------------------------------------------------- page data (__NEXT_DATA__) layouts
def check(res, how='page data'):
    assert res, 'figures expected'
    assert res['how'] == how, res['how']
    assert res['quarters'][0] == 'Sep 2026', res['quarters']
    assert res['revenue']['Sep 2026'] == 120.5 and res['revenue']['Sep 2025'] == 100.0, res['revenue']
    assert res['profit']['Sep 2026'] == 22.0, res['profit']
    return res

# 1) a list of quarters, each with its figures (oldest first, labels as Q2FY27)
recs = [{'quarterName': 'Q%dFY%d' % (q, fy), 'netSales': s, 'netProfit': p, 'netProfitMargin': 9.9, 'basicEps': e, 'resultDate': '2026-10-21'}
        for (q, fy, s, p, e) in ((2, 26, 100, 15, 2.1), (3, 26, 104, 16, 2.2), (4, 26, 108, 18, 2.4), (1, 27, 110, 20, 2.6), (2, 27, 120.5, 22, 2.9))]
res = check(sb.mc_from_json({'props': {'pageProps': {'data': {'standalone': [], 'consolidated': {'quarterly': recs}}}}}))
assert res['eps']['Sep 2026'] == 2.9 and res['where'] == ['props.pageProps.data.consolidated.quarterly'], res
assert abs(sb._growth(res['revenue'], 'Sep 2026', 12) - 20.5) < 1e-9 and abs(sb._growth(res['revenue'], 'Sep 2026', 3) - (120.5 / 110 - 1) * 100) < 1e-9

# 2) named rows under quarter headings ({"headers": [...], "rows": [{"name": "Net Sales", "values": [...]}]})
tbl = {'headers': ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025', 'Sep 2025'],
       'rows': [{'name': 'Net Sales', 'values': ['120.50', '110', '108', '104', '100']},
                {'name': 'Other Income', 'values': [1, 1, 1, 1, 1]},
                {'name': 'Net Profit', 'values': [22, 20, 18, 16, '(2.00)']},
                {'name': 'Basic EPS', 'values': [2.9, 2.6, 2.4, 2.2, -0.3]}]}
res = check(sb.mc_from_json({'props': {'pageProps': {'results': tbl}}}))
assert res['profit']['Sep 2025'] == -2.0 and res['labels'][:2] == ['Net Sales', 'Net Profit'], res

# 3) rows as lists with a heading row ['Particulars', 'Sep 2026', ...]
rows = {'columns': ['Particulars', "Sep '26", "Jun '26", "Mar '26", "Dec '25", "Sep '25"],
        'data': [['Revenue From Operations', 120.5, 110, 108, 104, 100], ['Total Expenses', 90, 80, 80, 80, 80], ['Net Profit', 22, 20, 18, 16, 15]]}
check(sb.mc_from_json({'x': rows}))

# 4) chart-style series: [{"heading": "Net Sales", "data": [{"year": "Sep '26", "value": ...}]}]
graph = [{'heading': 'Net Sales', 'data': [{'year': "Sep '26", 'value': 120.5}, {'year': "Sep '25", 'value': 100}]},
         {'heading': 'Net Profit', 'data': [{'year': "Sep '26", 'value': 22}, {'year': "Sep '25", 'value': 18}]}]
check(sb.mc_from_json({'g': graph}))

# 5) keyed by quarter: {"Sep 2026": {"netSales": ...}}, and field-named series {"netSales": {"Sep 2026": ...}}
check(sb.mc_from_json({'q': {'Sep 2026': {'netSales': 120.5, 'netProfit': 22}, 'Sep 2025': {'netSales': 100, 'netProfit': 18}, 'note': 'x'}}))
check(sb.mc_from_json({'s': {'netSales': {'Sep 2026': 120.5, 'Sep 2025': 100}, 'netProfit': {'Sep 2026': 22, 'Sep 2025': 19}}}))

# 6) an HTML table kept as text inside the data
html_in = '<table><tr><th>Quarterly</th><th>Sep 2026</th><th>Sep 2025</th></tr><tr><td>Net Sales</td><td>120.50</td><td>100.00</td></tr><tr><td>Net Profit</td><td>22.00</td><td>18.00</td></tr></table>'
check(sb.mc_from_json({'props': {'pageProps': {'widgetHtml': html_in}}}), how='table inside the page data')

# nothing usable
assert sb.mc_from_json({'props': {'pageProps': {'news': [{'title': 'Sep 2026 results', 'url': '/news/x'}], 'price': 100}}}) is None
assert sb.mc_from_json([]) is None and sb.mc_from_json(None) is None

# a quarters-down-the-side table
down = '<table><tr><td>Quarter</td><td>Net Sales</td><td>Net Profit</td></tr><tr><td>Sep 2026</td><td>120.50</td><td>22</td></tr><tr><td>Sep 2025</td><td>100</td><td>18</td></tr></table>'
check(sb.mc_parse(down)[0], how='table')

# the map printed when nothing could be read
lines = sb.mc_json_map({'props': {'pageProps': {'chart': [{'period': 'Sep 2026', 'amt': 1}, {'period': 'Sep 2025', 'amt': 2}], 'tabs': ['Net Sales', 'Net Profit', 'EPS']}}})
assert any(l.startswith('quarters at props.pageProps.chart  (2 items, item keys: period, amt)') for l in lines), lines
assert any(l.startswith('row name at props.pageProps.tabs = Net Sales') for l in lines), lines

# ---------------------------------------------------------------- the check against a pretend moneycontrol
SUGGEST = 'suggest1(' + json.dumps([
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/computers-software/tataconsultancyservices/TCS',
     'pdt_dis_nm': 'Tata Consultancy Services&nbsp;<span>INE467B01029, TCS, 532540</span>', 'stock_name': 'Tata Consultancy Services'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/auto-cars-jeeps/mahindramahindra/MM',
     'pdt_dis_nm': 'Mahindra &amp; Mahindra <span>INE101A01026, M&amp;M, 500520</span>', 'stock_name': 'Mahindra &amp; Mahindra'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/acutaaschemicals/AO05',
     'pdt_dis_nm': 'Acutaas Chemicals <span>INE0ABC01010, ACUTAAS, 543349</span>', 'stock_name': 'Acutaas Chemicals'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/nodatachem/ND01',
     'pdt_dis_nm': 'No Data Chem <span>INE0XYZ01010, NODATA, 543999</span>', 'stock_name': 'No Data Chem'}]) + ')'
WIDGET = """<table class="mctable1"><thead><tr><th>Quarterly</th><th>Sep '26</th><th>Jun '26</th><th>Mar '26</th><th>Dec '25</th><th>Sep '25</th><th>Trend</th></tr></thead>
<tbody><tr><td>Net Sales</td><td>66,000.00</td><td>63,000.00</td><td>64,000.00</td><td>63,500.00</td><td>60,000.00</td><td></td></tr>
<tr><td>Other Income</td><td>900.00</td><td>800.00</td><td>850.00</td><td>820.00</td><td>700.00</td><td></td></tr>
<tr><td>Net Profit</td><td>12,600.00</td><td>12,000.00</td><td>12,300.00</td><td>12,100.00</td><td>(1,000.00)</td><td></td></tr>
<tr><td>EPS</td><td>34.80</td><td>33.10</td><td>34.00</td><td>33.40</td><td>31.50</td><td></td></tr></tbody></table>"""
NEXT_PAGE = ('<html><head><title>Acutaas Chemicals Quarterly Results</title></head><body><div id="root">Sep 2026 Jun 2026</div>'
             '<table><tr><td>Quarter</td></tr><tr><td>No Data Found</td></tr></table>'
             '<script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'qr': recs}}}) + '</script></body></html>')
EMPTY_PAGE = ('<html><head><title>No Data Chem Quarterly Results</title></head><body><table><tr><td>No Data Found</td></tr></table>'
              '<script src="/_next/static/chunks/pages/markets/financials/quarterly-results/slug-abc.js"></script>'
              '<script id="__NEXT_DATA__" type="application/json">' +
              json.dumps({'props': {'pageProps': {'yoyChart': [{'period': 'Sep 2026', 'amt': 1}, {'period': 'Sep 2025', 'amt': 2}]}},
                          'runtimeConfig': {'news': 'https://www.moneycontrol.com/news/business/results/'}}) + '</script></body></html>')
CHUNK = 'var a="https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/quarterly?scId=";var b=`${a}/mcapi/v2/financials/quarterly-results?sc=${c}`;var i="/images/financial.png";'
WPATH = '/mc/widget/mcfinancials/getFinancialData'
ROUTES = {
    '/suggest': (200, SUGGEST),
    '/': (200, '<html>home</html>'),
    WPATH + '?C&TCS': (200, WIDGET),
    WPATH + '?C&MM': (200, '<div>No Data Available</div>'),
    WPATH + '?S&MM': (200, WIDGET),
    '/markets/financials/quarterly-results/acutaaschemicals-AO05/': (200, NEXT_PAGE),
    '/financials/acutaaschemicals/results/consolidated-quarterly-results/AO05/1': (302, '/markets/financials/quarterly-results/acutaaschemicals-AO05/'),
    '/markets/financials/quarterly-results/nodatachem-ND01/': (200, EMPTY_PAGE),
    '/_next/static/chunks/pages/markets/financials/quarterly-results/slug-abc.js': (200, CHUNK),
}


class MC(BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, qs = self.path.partition('?')
        if path == WPATH:
            q = dict(x.split('=', 1) for x in qs.split('&') if '=' in x)
            path = WPATH + '?%s&%s' % (q.get('requestType'), q.get('scId'))
            if q.get('referenceId') != 'income' or q.get('frequency') != '3':
                path = 'bad widget query'
        st, body = ROUTES.get(path, (404, 'not found'))
        if st == 302:
            self.send_response(302)
            self.send_header('Location', body)
            self.send_header('Content-Length', '0')
            self.end_headers()
            return
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
sb.MC_SOURCES = tuple((k, u.replace('https://www.moneycontrol.com', BASE)) for k, u in sb.MC_SOURCES)
sb.MC_PAUSE = 0
tmp = tempfile.mkdtemp()
sb.MC_CHECK_DIR = os.path.join(tmp, 'moneycontrol_check')

opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
hit, note = sb.mc_lookup(opener, 'tcs')
assert hit and hit['code'] == 'TCS' and hit['slug'] == 'tataconsultancyservices', (hit, note)
hit, note = sb.mc_lookup(opener, 'M&M')
assert hit and hit['code'] == 'MM', ('M&M via the decoded &amp;', hit, note)
hit, note = sb.mc_lookup(opener, 'INFY')
assert hit is None and 'none listed with NSE symbol INFY' in note, note

res, seen = sb.mc_parse(WIDGET)
assert res['quarters'] == ['Sep 2026', 'Jun 2026', 'Mar 2026', 'Dec 2025', 'Sep 2025'], res['quarters']
assert res['revenue']['Sep 2026'] == 66000.0 and res['profit']['Sep 2025'] == -1000.0 and res['eps']['Sep 2026'] == 34.8
assert abs(sb._growth(res['revenue'], 'Sep 2026', 12) - 10.0) < 1e-9
assert sb._growth(res['profit'], 'Sep 2026', 12) > 0, 'growth from a loss reads as an improvement'
assert sb._growth(res['profit'], 'Sep 2026', 24) is None
assert sb.mc_parse('<html><body>no tables</body></html>')[0] is None

# TestConnection: stops at the first source that works, saves nothing
lines = []
assert sb.mc_check('TCS', out=lines.append, detail=False) is True
text = '\n'.join(lines)
assert 'found Tata Consultancy Services (moneycontrol code tataconsultancyservices / TCS)' in text, text
assert 'consolidated widget: OK (table) - Sep 2026, Jun 2026, Mar 2026, Dec 2025, Sep 2025' in text, text
assert 'latest Sep 2026: revenue 66,000 (QoQ +5%, YoY +10%) | net profit 12,600 (QoQ +5%, YoY +1360%) | EPS 34.8' in text, text
assert 'standalone widget' not in text and not os.path.exists(sb.MC_CHECK_DIR), text

lines = []
assert sb.mc_check('M&M', out=lines.append) is True
text = '\n'.join(lines)
assert 'consolidated widget: 0 KB - no quarterly figures found' in text and 'standalone widget: OK (table)' in text, text
assert 'results page: HTTP 404' in text, text

lines = []
assert sb.mc_check('ACUTAAS', out=lines.append) is True
text = '\n'.join(lines)
assert 'results page: OK (page data) - Sep 2026, Jun 2026, Mar 2026, Dec 2025, Sep 2025' in text, text
assert 'latest Sep 2026: revenue 120.5 (QoQ +10%, YoY +21%) | net profit 22 (QoQ +10%, YoY +47%) | EPS 2.9' in text, text
assert '(at props.pageProps.qr)' in text, text
assert 'old consolidated page: opens the same page as the results page' in text, text
assert not os.path.exists(sb.MC_CHECK_DIR), 'nothing saved when figures were read'

lines = []
assert sb.mc_check('NODATA', out=lines.append) is False
text = '\n'.join(lines)
assert 'results page: ' in text and 'no quarterly figures found; rows seen: No Data Found (page data present)' in text, text
assert 'nothing readable yet' in text, text
assert 'quarters at props.pageProps.yoyChart  (2 items, item keys: period, amt)' in text, text
assert 'data link in the page scripts: https://api.moneycontrol.com/mcapi/v1/stock/financial-historical/quarterly?scId=' in text, text
assert 'data link in the page scripts: /mcapi/v2/financials/quarterly-results?sc=${c}' in text, text
assert 'financial.png' not in text and '/news/' not in text, text
saved = sorted(os.listdir(sb.MC_CHECK_DIR))
assert 'NODATA_results_page.html' in saved and 'NODATA_results_page_data.json' in saved, saved
assert 'pages saved in ' + sb.MC_CHECK_DIR in text, text

srv.shutdown()
shutil.rmtree(tmp, ignore_errors=True)
print('OK')
