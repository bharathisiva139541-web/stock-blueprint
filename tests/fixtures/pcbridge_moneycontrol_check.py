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
     'pdt_dis_nm': 'No Data Chem <span>INE0XYZ01010, NODATA, 543999</span>', 'stock_name': 'No Data Chem'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/firstco/FC01',
     'pdt_dis_nm': 'First Co <span>INE0FC001010, FIRSTCO, 500001</span>', 'stock_name': 'First Co'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/stdonly/SO01',
     'pdt_dis_nm': 'Std Only <span>INE0SO001010, STDONLY, 500002</span>', 'stock_name': 'Std Only'},
    {'link_src': 'https://www.moneycontrol.com/india/stockpricequote/chemicals/behindco/BH01',
     'pdt_dis_nm': 'Behind Co <span>INE0BH001010, BEHINDCO, 500003</span>', 'stock_name': 'Behind Co'}]) + ')'
# the real widget has no EPS row (the user's test, ACUTAAS Sep 2026)
REAL_WIDGET = '''<table class="mctable1"><tr><th>Quarterly</th><th>Sep '26</th><th>Jun '26</th><th>Mar '26</th><th>Dec '25</th><th>Sep '25</th><th></th></tr>
<tr><td>Sales</td><td>436.00</td><td>329.00</td><td>432.00</td><td>393.00</td><td>306.00</td><td></td></tr>
<tr><td>Other Income</td><td>5.00</td><td>1.00</td><td>11.00</td><td>4.00</td><td>9.00</td><td></td></tr>
<tr><td>Total Income</td><td>441.00</td><td>330.00</td><td>443.00</td><td>397.00</td><td>315.00</td><td></td></tr>
<tr><td>Net Profit</td><td>123.00</td><td>74.00</td><td>134.00</td><td>106.00</td><td>71.00</td><td></td></tr></table>'''
# a company whose Sep 2026 results are not on moneycontrol yet either
BEHIND_WIDGET = '''<table><tr><th>Quarterly</th><th>Jun '26</th><th>Mar '26</th><th>Dec '25</th><th>Sep '25</th></tr>
<tr><td>Sales</td><td>329.00</td><td>432.00</td><td>393.00</td><td>306.00</td></tr>
<tr><td>Net Profit</td><td>74.00</td><td>134.00</td><td>106.00</td><td>71.00</td></tr></table>'''
MC_Q = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026']
MC_REV = [246, 274, 308, 207, 306, 393, 432, 329, 436]
MC_NP = [37, 45, 62, 44, 71, 106, 134, 74, 123]
MC_EPS = [9.38, 11.35, 7.8, 5.41, 8.82, 13.19, 16.09, 9.07, 15.29]
def next_page(rev_shift=0):
    recs = [{'quarter': q, 'netSales': r + rev_shift, 'netProfit': n, 'basicEps': e} for q, r, n, e in zip(MC_Q, MC_REV, MC_NP, MC_EPS)]
    return ('<html><body><script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'consolidated': recs}}}) +
            '</script></body></html>')
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
    WPATH + '?C&FC01': (200, REAL_WIDGET),
    '/markets/financials/quarterly-results/firstco-FC01/': (200, next_page()),
    WPATH + '?C&SO01': (200, '<div>No Data Available</div>'),
    WPATH + '?S&SO01': (200, REAL_WIDGET),
    '/markets/financials/quarterly-results/stdonly-SO01/': (200, next_page(rev_shift=50)),     # other figures: not merged
    WPATH + '?C&BH01': (200, BEHIND_WIDGET),
}
HITS = []


class MC(BaseHTTPRequestHandler):
    def do_GET(self):
        path, _, qs = self.path.partition('?')
        HITS.append(path)
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
assert 'a run would send: Standalone Sep 2026 (standalone widget)\n' in text + '\n', 'the widget had EPS: no EPS note'
assert not os.path.exists(sb.MC_CHECK_DIR), 'nothing saved when EPS was read'

lines = []
assert sb.mc_check('ACUTAAS', out=lines.append) is True
text = '\n'.join(lines)
assert 'results page: OK (page data) - Sep 2026, Jun 2026, Mar 2026, Dec 2025, Sep 2025' in text, text
assert 'latest Sep 2026: revenue 120.5 (QoQ +10%, YoY +21%) | net profit 22 (QoQ +10%, YoY +47%) | EPS 2.9' in text, text
assert '(at props.pageProps.qr)' in text, text
assert 'old consolidated page: opens the same page as the results page' in text, text
# a run uses the widgets: none here, so it would send nothing - the page data is kept for Claude
assert 'a run would send: nothing - no quarterly figures on moneycontrol' in text, text
assert os.listdir(sb.MC_CHECK_DIR) == ['ACUTAAS_results_page_data.json'], os.listdir(sb.MC_CHECK_DIR)
shutil.rmtree(sb.MC_CHECK_DIR)

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

# ---------------------------------------------------------------- the run's moneycontrol step (step 2)
sb.MC_CODES_PATH = os.path.join(tmp, 'moneycontrol_codes.json')
SENT, LOGS = [], []
REPLY = {'ok': True}
def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    SENT.append((action, payload))
    if not REPLY.get('ok'):
        return REPLY
    return {'ok': True, 'stored': len(payload['items']), 'details': [{'sym': it['sym'], 'ok': True} for it in payload['items']]}
sb.api = fake_api
sb.log = LOGS.append

want = {'FIRSTCO': 'Sep 2026', 'STDONLY': 'Sep 2026', 'BEHINDCO': 'Sep 2026', 'NOTMC': 'Sep 2026', 'SCREENERHAS': 'Sep 2026'}
behind = sb.mc_behind(want, {'SCREENERHAS': 'Sep 2026', 'FIRSTCO': 'Jun 2026', 'STDONLY': ''})
assert behind == {'FIRSTCO', 'STDONLY', 'BEHINDCO', 'NOTMC'}, behind
assert sb.mc_behind({'A': 'Sep 2026'}, {'A': 'Dec 2026'}) == set() and sb.mc_behind({'A': 'Sep 2026'}, {'A': 'junk'}) == {'A'}

del HITS[:]
assert sb.mc_step({'moneycontrol': True}, want, behind) == 2
assert [a for a, _ in SENT] == ['mcput'], SENT
items = {it['sym']: it for it in SENT[0][1]['items']}
assert sorted(items) == ['FIRSTCO', 'STDONLY'], items
f = items['FIRSTCO']
assert (f['basis'], f['src']) == ('Consolidated', 'consolidated widget + results page'), f
assert f['quarters'] == MC_Q and f['revenue'] == [float(x) for x in MC_REV] and f['netProfit'][-1] == 123 and f['eps'] == MC_EPS, f
o = items['STDONLY']
assert (o['basis'], o['src']) == ('Standalone', 'standalone widget'), o
assert o['quarters'] == ['Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026', 'Sep 2026'] and o['revenue'][-1] == 436 and o['eps'] == [None] * 5, o
log = '\n'.join(LOGS)
assert 'moneycontrol: looking up 4 result(s) screener.in does not show yet' in log, log
assert 'moneycontrol FIRSTCO: Consolidated Sep 2026 (consolidated widget + results page)' in log, log
assert 'moneycontrol BEHINDCO: not yet - moneycontrol shows Jun 2026' in log, log
assert ('moneycontrol STDONLY: Standalone Sep 2026 (standalone widget); no EPS: results page Sep 2026 shows revenue 486 / profit 123 '
        '(newest Sep 2026) - the widget 436 / 123') in log, log
assert 'moneycontrol NOTMC: ' in log and 'none listed with NSE symbol NOTMC' in log, log
assert 'moneycontrol: sent 2 to the sheet' in log, log
assert '/suggest' in HITS and not any('screenerhas' in h.lower() for h in HITS), 'SCREENERHAS is not looked up'
codes = json.load(open(sb.MC_CODES_PATH))
assert codes['FIRSTCO']['code'] == 'FC01' and codes['NOTMC']['none'] is True, codes

# the next run uses the remembered codes (no search) and skips the "not on moneycontrol" one for a week
del HITS[:], SENT[:], LOGS[:]
sb.mc_step({}, want, behind)
assert '/suggest' not in HITS, HITS
assert 'moneycontrol NOTMC: ' in '\n'.join(LOGS)
# a long list: the ones looked at longest ago go first, the rest wait for the next round
del SENT[:], LOGS[:]
assert sb.mc_step({'max_moneycontrol_per_run': 2}, want, behind) >= 0
first = [l.split(':')[0].split()[-1] for l in LOGS if l.startswith('  moneycontrol ')]
assert 'moneycontrol: looking up 2 result(s) screener.in does not show yet (2 more next round)' in LOGS[0], LOGS
del LOGS[:]
sb.mc_step({'max_moneycontrol_per_run': 2}, want, behind)
second = [l.split(':')[0].split()[-1] for l in LOGS if l.startswith('  moneycontrol ')]
assert sorted(first + second) == sorted(behind), (first, second)
assert '_checked' in json.load(open(sb.MC_CODES_PATH))
# switched off in config.json; nothing wanted
del HITS[:], SENT[:]
assert sb.mc_step({'moneycontrol': False}, want, behind) == 0 and sb.mc_step({}, {}, set()) == 0 and not HITS and not SENT
# an older web app that does not know 'mcput' yet
REPLY.update(ok=False, error='unknown action')
del LOGS[:]
assert sb.mc_step({}, {'FIRSTCO': 'Sep 2026'}, {'FIRSTCO'}) == 0
assert 'New version deploy' in '\n'.join(LOGS), LOGS

# ---------------------------------------------------------------- a whole run: screener first, then moneycontrol, then process
REPLY.update(ok=True)
CALLS = []
def run_api(cfg, action, payload=None, timeout=120, tries=3):
    CALLS.append(action)
    if action == 'put':
        # the sheet answers with what screener.in showed: FIRSTCO still on Jun 2026, SCREENERHAS already on Sep 2026
        latest = {'FIRSTCO': 'Jun 2026', 'SCREENERHAS': 'Sep 2026'}
        return {'ok': True, 'stored': len(payload['items']), 'details': [
            {'sym': it['sym'], 'quarterOk': True, 'thin': False, 'latest': latest.get(it['sym'], '')} for it in payload['items']]}
    if action == 'mcput':
        SENT.append((action, payload))
        return {'ok': True, 'stored': len(payload['items']), 'details': [{'sym': it['sym'], 'ok': True} for it in payload['items']]}
    if action == 'process':
        return {'ok': True, 'result': {'results': 'done', 'missing': 'checked 0', 'errors': []}}
    raise AssertionError(action)
def fake_page(cfg, sym, consolidated=True):
    if sym == 'BLOCKEDCO':
        raise sb.Blocked('HTTP 429')
    return 'ok', '<html>' + sym + '</html>'
sb.api = run_api
sb.fetch_page = fake_page
sb.polite_sleep = lambda cfg: None
sb.price_bands_step = sb.ipo_step = lambda cfg: None
sb.LOCK_PATH = os.path.join(tmp, 'bridge.lock')
LIST = {'ok': True, 'priority': ['FIRSTCO', 'SCREENERHAS', 'BLOCKEDCO'], 'missing': [],
        'mc': {'FIRSTCO': 'Sep 2026', 'SCREENERHAS': 'Sep 2026', 'BLOCKEDCO': 'Sep 2026'}}
sb.wait_for_sheet = lambda cfg, minutes=4: dict(LIST)
cfg = dict(sb.DEFAULTS, url='http://sheet.invalid/exec', token='t', abort_after_failures=5)
del SENT[:], LOGS[:], HITS[:]
assert sb.run_once(cfg) == 0
assert CALLS == ['put', 'mcput', 'process'], CALLS
assert sorted(it['sym'] for it in SENT[0][1]['items']) == ['FIRSTCO'], SENT
log = '\n'.join(LOGS)
assert 'moneycontrol: looking up 2 result(s) screener.in does not show yet' in log, log      # FIRSTCO + BLOCKEDCO
assert 'moneycontrol BLOCKEDCO: ' in log, log
assert 'Sent 2 page(s) and 1 moneycontrol result(s). Asking the sheet to process them...' in log, log

# an older web app: no 'mc' in its list answer -> a hint, no moneycontrol requests
LIST.pop('mc')
del CALLS[:], LOGS[:], HITS[:]
assert sb.run_once(cfg) == 0
assert CALLS == ['put', 'process'], CALLS
assert 'do the New version deploy' in '\n'.join(LOGS) and not HITS, LOGS

srv.shutdown()
shutil.rmtree(tmp, ignore_errors=True)
print('OK')
