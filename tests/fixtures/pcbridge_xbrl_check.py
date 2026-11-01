"""Offline checks for the PC bridge's NSE XBRL test (screener_bridge.py xbrl_*): an XBRL results file (PARAS' Sep-2026
quarter figures from the owner's ChatGPT chat) is read, its OPM worked out, and compared with a screener.in page; the
new quarter from XBRL + screener.in's earlier quarters give TTM EPS. A local HTTP server plays NSE. No network is used.
Run by tests/pcbridge-xbrl.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import tempfile
import threading
import urllib.request
from http.cookiejar import CookieJar
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)
TMP = tempfile.mkdtemp()
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.XBRL_CHECK_DIR = os.path.join(TMP, 'xbrl_check')
sb.time.sleep = lambda s: None
sb.polite_sleep = lambda cfg: None

CR = 10 ** 7
def amt(cr):
    return '%d' % round(cr * CR)

Q = {'RevenueFromOperations': 151.12, 'OtherIncome': 2.22, 'Income': 153.34, 'Expenses': 112.52, 'FinanceCosts': 0.86,
     'DepreciationDepletionAndAmortisationExpense': 5.06, 'ProfitBeforeTax': 40.82, 'TaxExpense': 10.26, 'ProfitLossForPeriod': 30.56,
     'ProfitOrLossAttributableToOwnersOfParent': 30.40}
H = {'RevenueFromOperations': 279.03, 'ProfitLossForPeriod': 51.30}
facts = ''.join('<in-capmkt:%s contextRef="OneD" unitRef="INR" decimals="-5">%s</in-capmkt:%s>' % (k, amt(v), k) for k, v in Q.items())
facts += ''.join('<in-capmkt:%s contextRef="FourD" unitRef="INR" decimals="-5">%s</in-capmkt:%s>' % (k, amt(v), k) for k, v in H.items())
facts += '<in-capmkt:BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations contextRef="OneD" unitRef="INRPerShare" decimals="2">3.76</in-capmkt:BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations>'
facts += '<in-capmkt:BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations contextRef="FourD" unitRef="INRPerShare" decimals="2">6.39</in-capmkt:BasicEarningsLossPerShareFromContinuingAndDiscontinuedOperations>'
# a segment figure in a context with a dimension must not be taken for the company's revenue
facts += '<in-capmkt:RevenueFromOperations contextRef="OneD_Seg1" unitRef="INR" decimals="-5">%s</in-capmkt:RevenueFromOperations>' % amt(74.65)
XBRL = ('<?xml version="1.0" encoding="UTF-8"?>'
        '<xbrli:xbrl xmlns:xbrli="http://www.xbrl.org/2003/instance" xmlns:in-capmkt="http://www.sebi.gov.in/xbrl/in-capmkt" '
        'xmlns:xbrldi="http://xbrl.org/2006/xbrldi">'
        '<xbrli:context id="OneD"><xbrli:entity><xbrli:identifier scheme="http://www.bseindia.com">543367</xbrli:identifier></xbrli:entity>'
        '<xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>'
        '<xbrli:context id="FourD"><xbrli:entity><xbrli:identifier scheme="x">543367</xbrli:identifier></xbrli:entity>'
        '<xbrli:period><xbrli:startDate>2026-04-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>'
        '<xbrli:context id="OneI"><xbrli:entity><xbrli:identifier scheme="x">543367</xbrli:identifier></xbrli:entity>'
        '<xbrli:period><xbrli:instant>2026-09-30</xbrli:instant></xbrli:period></xbrli:context>'
        '<xbrli:context id="OneD_Seg1"><xbrli:entity><xbrli:identifier scheme="x">543367</xbrli:identifier>'
        '<xbrli:segment><xbrldi:explicitMember dimension="in-capmkt:SegmentAxis">in-capmkt:Optics</xbrldi:explicitMember></xbrli:segment>'
        '</xbrli:entity><xbrli:period><xbrli:startDate>2026-07-01</xbrli:startDate><xbrli:endDate>2026-09-30</xbrli:endDate></xbrli:period></xbrli:context>'
        '<in-capmkt:NameOfTheCompany contextRef="OneI">Paras Defence and Space Technologies Limited</in-capmkt:NameOfTheCompany>'
        '<in-capmkt:Symbol contextRef="OneI">PARAS</in-capmkt:Symbol>'
        '<in-capmkt:NatureOfReportStandaloneConsolidated contextRef="OneD">Consolidated</in-capmkt:NatureOfReportStandaloneConsolidated>'
        + facts + '</xbrli:xbrl>').encode()

# ---------------------------------------------------------------- reading the file
x = sb.xbrl_parse(XBRL)
assert x and x['quarter'] == 'Sep 2026' and (x['start'], x['end']) == ('2026-07-01', '2026-09-30'), x
assert (x['nature'], x['symbol'], x['company']) == ('Consolidated', 'PARAS', 'Paras Defence and Space Technologies Limited'), x
assert abs(x['q']['revenue'] / CR - 151.12) < 1e-6, 'the company figure, not the segment one'
assert x['q']['eps'] == 3.76 and abs(x['q']['pat_owners'] / CR - 30.40) < 1e-6 and x['q']['exceptional'] is None
assert x['cum_months'] == 6 and abs(x['cum']['revenue'] / CR - 279.03) < 1e-6 and x['cum']['eps'] == 6.39
a, b = sb.xbrl_opm(x['q'])
assert round(a, 2) == 29.46 and round(b, 2) == 29.46, (a, b)       # EBITDA 44.52 Cr on 151.12 Cr, both ways
assert sb.xbrl_parse(b'<html>not xml') is None and sb.xbrl_parse(b'<a><b/></a>') is None

# ---------------------------------------------------------------- screener.in's quarterly table
def page(quarters, rows):
    head = '<tr><th></th>' + ''.join('<th>%s</th>' % q for q in quarters) + '</tr>'
    body = ''.join('<tr><td class="text">%s</td>%s</tr>' % (label, ''.join('<td>%s</td>' % v for v in vals)) for label, vals in rows)
    return ('<html><body><section id="quarters"><table class="data-table">%s%s</table></section>'
            '<section id="profit-loss"><table><tr><th></th><th>Mar 2025</th><th>Mar 2026</th></tr>'
            '<tr><td>Sales +</td><td>1</td><td>2</td></tr></table></section></body></html>') % (head, body)
OLD_Q = ['Sep 2024', 'Dec 2024', 'Mar 2025', 'Jun 2025', 'Sep 2025', 'Dec 2025', 'Mar 2026', 'Jun 2026']
OLD = [('Sales +', ['90', '95', '110', '100', '120', '118', '140', '127.91']), ('Expenses +', ['70'] * 8),
       ('Operating Profit', ['20'] * 8), ('OPM %', ['22%', '21%', '25%', '20%', '24%', '23%', '27%', '24%']),
       ('Net Profit +', ['10'] * 7 + ['20.74']), ('EPS in Rs', ['1.10', '1.20', '1.50', '1.30', '1.60', '1.70', '2.10', '2.63'])]
sc = sb.screener_quarters(page(OLD_Q, OLD))
assert sc['quarters'][0] == 'Jun 2026' and sc['rows']['sales']['Jun 2026'] == 127.91 and sc['rows']['opm']['Mar 2026'] == 27.0, sc
assert sc['rows']['eps']['Sep 2025'] == 1.6 and 'Mar 2026' not in sc['quarters'][:0]

# screener.in has not got the quarter yet: what the sheet would work out
lines = sb.xbrl_compare(x, sc)
txt = '\n'.join(lines)
assert '(not shown yet)' in lines[0], lines[0]
assert 'TTM EPS: 10.19 = XBRL 3.76 + screener Jun 2026 2.63 + Mar 2026 2.10 + Dec 2025 1.70; Last FY EPS 5.60' in txt, txt
assert 'Revenue QoQ: +18.1% (vs Jun 2026 127.91 Cr)' in txt and 'Revenue YoY: +25.9% (vs Sep 2025 120.00 Cr)' in txt, txt
assert '29.5 / 29.5' in txt, txt

# screener.in shows it: every figure compared, its own TTM EPS too
NEW_Q = OLD_Q[1:] + ['Sep 2026']
NEW = [(lab, vals[1:] + [v]) for (lab, vals), v in zip(OLD, ['151.12', '108', '43', '29%', '30.56', '3.76'])]
NEW += [('Other Income +', ['1'] * 7 + ['2.22']), ('Interest', ['1'] * 7 + ['0.86']), ('Depreciation', ['5'] * 7 + ['5.06']),
        ('Profit before tax', ['15'] * 7 + ['40.82'])]
txt = '\n'.join(sb.xbrl_compare(x, sb.screener_quarters(page(NEW_Q, NEW))))
for want in ('Revenue (Cr)                   151.12         151.12   OK', 'Net Profit (Cr)                 30.56          30.56   OK',
             'EPS (Rs)                         3.76           3.76   OK', "screener.in's own TTM EPS 10.19 OK", 'Revenue QoQ: +18.1% (vs Jun 2026 127.91 Cr); screener.in +18.1%'):
    assert want in txt, (want, txt)
assert "owners' share (Cr)" in txt and 'differs -0.5%' in txt, txt   # 30.40 vs screener's 30.56

# a quarter screener.in lacks the earlier quarters for
txt = '\n'.join(sb.xbrl_compare(x, sb.screener_quarters(page(OLD_Q[:5], [(l, v[:5]) for l, v in OLD]))))
assert 'TTM EPS: cannot be worked out - screener.in lacks Jun 2026, Mar 2026, Dec 2025' in txt, txt

# ---------------------------------------------------------------- the check against a pretend NSE
LIST = {'data': [{'symbol': 'PARAS', 'consolidated': 'Consolidated', 'toDate': '30-Sep-2026', 'xbrl': '', 'seqNumber': '1'}]}
ROUTES, HITS = {}, []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body = ROUTES.get(self.path, (404, b''))
        self.send_response(st)
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
LIST['data'][0]['xbrl'] = BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'
LIST['data'].append({'symbol': 'PARAS', 'xbrl': BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1611111_30072026101010_WEB.xml'})
# the standalone file of the same quarter (filed a minute earlier): read, but the consolidated one is used
STANDALONE = XBRL.replace(b'>Consolidated<', b'>Standalone<').replace(amt(151.12).encode(), amt(140.00).encode())
LIST['data'].append({'symbol': 'PARAS', 'xbrl': BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml'})
ROUTES['/api/fr?symbol=PARAS'] = (200, json.dumps(LIST).encode())
ROUTES['/api/ifr?symbol=PARAS'] = (403, b'')
ROUTES['/api/ann?symbol=PARAS'] = (200, json.dumps([{'symbol': 'PARAS', 'desc': 'Outcome of Board Meeting', 'attchmntFile': 'x.pdf'}]).encode())
ROUTES['/corporate/xbrl/INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'] = (200, XBRL)
ROUTES['/corporate/xbrl/INTEGRATED_FILING_INDAS_1611111_30072026101010_WEB.xml'] = (200, b'<html>gone</html>')
ROUTES['/corporate/xbrl/INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml'] = (200, STANDALONE)
sb.XBRL_LISTS = (('financial results', BASE + '/api/fr?symbol={s}'), ('integrated filing', BASE + '/api/ifr?symbol={s}'),
                 ('announcements', BASE + '/api/ann?symbol={s}'))
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))
SCREENER = []
def fake_fetch(cfg, sym, consolidated=True):
    SCREENER.append((sym, consolidated))
    return 'ok', page(OLD_Q, OLD)
sb.fetch_page = fake_fetch
OUT = []
sb.xbrl_check({'screener_base': 'x', 'delay_min': 0, 'delay_max': 0}, ['paras'], out=OUT.append)
txt = '\n'.join(OUT)
assert '   financial results: 3 record(s), 3 XBRL link(s)' in txt, txt
assert '   integrated filing: HTTP 403' in txt and "   announcements:     1 record(s), 0 XBRL link(s); fields: attchmntFile, desc, symbol" in txt, txt
assert ('   INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml: Paras Defence and Space Technologies Limited, consolidated, '
        'quarter Sep 2026 (2026-07-01 to 2026-09-30); also 6 months to 2026-09-30') in txt, txt
xml_hits = [h for h in HITS if h.endswith('.xml')]
assert xml_hits == ['/corporate/xbrl/INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml',
                    '/corporate/xbrl/INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml',
                    '/corporate/xbrl/INTEGRATED_FILING_INDAS_1611111_30072026101010_WEB.xml'], 'newest file first: %s' % xml_hits
assert 'INTEGRATED_FILING_INDAS_1611111_30072026101010_WEB.xml: not an XBRL file with a quarter in it' in txt, txt
assert 'TTM EPS: 10.19 = XBRL 3.76' in txt and SCREENER == [('PARAS', True)], (SCREENER, txt)
assert ('INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml: standalone, quarter Sep 2026 - not used (the consolidated file is used)'
        in txt), txt
assert 'Revenue (Cr)                   151.12' in txt and '140.00' not in txt, txt
assert os.path.exists(os.path.join(sb.XBRL_CHECK_DIR, 'PARAS_INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'))
assert txt.rstrip().endswith('(nothing was sent to the sheet; the XBRL files are in %s)' % sb.XBRL_CHECK_DIR)

# links pasted straight (the owner's PARAS files): taken as one company - the consolidated one is used
del OUT[:], SCREENER[:]
sb.xbrl_check({'screener_base': 'x', 'delay_min': 0, 'delay_max': 0}, [LIST['data'][2]['xbrl'], LIST['data'][0]['xbrl']], out=OUT.append)
txt = '\n'.join(OUT)
assert 'consolidated, quarter Sep 2026' in txt and 'not used (the consolidated file is used)' in txt and SCREENER == [('PARAS', True)], txt
# a company that files standalone only: the standalone figures, compared with screener.in's standalone page
del OUT[:], SCREENER[:]
sb.xbrl_check({'screener_base': 'x', 'delay_min': 0, 'delay_max': 0}, [LIST['data'][2]['xbrl']], out=OUT.append)
txt = '\n'.join(OUT)
assert 'standalone, quarter Sep 2026' in txt and 'Revenue (Cr)                   140.00' in txt and SCREENER == [('PARAS', False)], txt
# ---------------------------------------------------------------- step 2: the round's xbrl_step
sb.XBRL_STATE_PATH = os.path.join(TMP, 'xbrl_state.json')
GOV = BASE + '/corporate/xbrl/INTEGRATED_FILING_GOVERNANCE_1750484_30102026083256_WEB.xml'
CONS = BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'
STAND = BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml'
OLDQ = BASE + '/corporate/xbrl/INTEGRATED_FILING_INDAS_1709773_07082026042829_WEB.xml'
JUN = XBRL.replace(b'2026-07-01', b'2026-04-01').replace(b'2026-09-30', b'2026-06-30')
ROUTES['/corporate/xbrl/INTEGRATED_FILING_GOVERNANCE_1750484_30102026083256_WEB.xml'] = (200, b'<x/>')
ROUTES['/corporate/xbrl/INTEGRATED_FILING_INDAS_1709773_07082026042829_WEB.xml'] = (200, JUN)
ROUTES['/api/ifr2?symbol=PARAS'] = (200, json.dumps({'data': [{'symbol': 'PARAS', 'xbrl': u} for u in (OLDQ, GOV, STAND, CONS)]}).encode())
ROUTES['/api/ifr2?symbol=LATECO'] = (200, json.dumps({'data': [{'symbol': 'LATECO', 'xbrl': OLDQ}]}).encode())
ROUTES['/api/fr2?symbol=NONE'] = (200, b'{"data": []}')
sb.XBRL_STEP_LISTS = (('integrated filing', BASE + '/api/ifr2?symbol={s}'), ('financial results', BASE + '/api/fr2?symbol={s}'))
SENT, LOGS = [], []
sb.log = LOGS.append
def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'xbrlput', action
    SENT.append(payload)
    return {'ok': True, 'stored': len(payload['items'])}
sb.api = fake_api
del HITS[:]
assert sb.DEFAULTS['max_xbrl_per_run'] == 60
n = sb.xbrl_step({'max_xbrl_per_run': 2}, {'PARAS': 'Sep 2026', 'LATECO': 'Sep 2026', 'NONE': 'Sep 2026'})
assert n == 1 and len(SENT) == 1, (n, SENT)
it = SENT[0]['items'][0]
assert (it['sym'], it['quarter']) == ('PARAS', 'Sep 2026'), it
assert it['cons']['revenue'] == 151.12 and it['cons']['eps'] == 3.76 and it['cons']['pbt'] == 40.82 and 'pat_owners' not in it['cons'], it
assert it['stand']['revenue'] == 140.0, 'the standalone file of the same quarter too'
assert it['files'] == ['INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml', 'INTEGRATED_FILING_INDAS_1749103_29102026060807_WEB.xml'], it
assert not any('GOVERNANCE' in h for h in HITS), 'governance files are not read'
assert not any('1709773' in h and 'PARAS' in h for h in HITS) and HITS.count('/corporate/xbrl/INTEGRATED_FILING_INDAS_1709773_07082026042829_WEB.xml') == 1, HITS
assert not any('NONE' in h for h in HITS), 'over the cap: next round'
assert LOGS == ['NSE XBRL: 1 of 2 stock(s) have their results filing on NSE - sent PARAS; not filed yet: LATECO; 1 more next round.'], LOGS
st = json.load(open(sb.XBRL_STATE_PATH))
assert st['PARAS']['found'] is True and st['LATECO']['found'] is False, st
# the sheet's figures are consolidated: only that file is read (the standalone one is not downloaded)
del HITS[:], SENT[:]
sb.api = fake_api
assert sb.xbrl_step({}, {'PARAS': 'Sep 2026'}, basis={'PARAS': 'C'}) == 1
it = SENT[0]['items'][0]
assert it['cons']['revenue'] == 151.12 and it['stand'] is None and it['files'] == ['INTEGRATED_FILING_INDAS_1749104_29102026060924_WEB.xml'], it
assert not any('1749103' in h for h in HITS), HITS
del HITS[:], SENT[:]
assert sb.xbrl_step({}, {'PARAS': 'Sep 2026'}, basis={'PARAS': 'S'}) == 1
assert SENT[0]['items'][0]['cons'] is None and SENT[0]['items'][0]['stand']['revenue'] == 140.0
# nothing wanted / switched off: no request at all
del HITS[:], SENT[:]
assert sb.xbrl_step({}, {}) == 0 and sb.xbrl_step({'xbrl': False}, {'PARAS': 'Sep 2026'}) == 0 and HITS == [] and SENT == []
# the deployed web app is older
sb.api = lambda cfg, action, payload=None, timeout=120, tries=3: {'ok': False, 'error': 'unknown action'}
del LOGS[:]
assert sb.xbrl_step({}, {'PARAS': 'Sep 2026'}) == 0
assert 'New version > Deploy' in LOGS[0], LOGS
srv.shutdown()
print('OK')
