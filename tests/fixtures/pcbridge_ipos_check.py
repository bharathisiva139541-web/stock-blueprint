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
TMP = tempfile.mkdtemp()
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.IPO_STATE_PATH = os.path.join(TMP, 'ipo_state.json')
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
    {'company': 'Nityas Gems and Jewellery Limited', 'symbol': 'NITYAS', 'securityType': 'BE', 'issuePrice': '1,119.00',
     'priceRange': 'Rs.1065 to Rs.1119', 'ipoStartDate': '14-10-2026', 'ipoEndDate': '16-10-2026', 'listingDate': '22-10-2026'},
]}
UPCOMING = {'data': [
    {'series': 'EQ', 'companyName': 'Bombay Coated and Special Steels Limited', 'symbol': 'BCSSL', 'issueStartDate': '2026-10-29',
     'issueEndDate': '2026-11-02', 'status': 'Forthcoming', 'issuePrice': 'Rs.78 to Rs.82', 'issueSize': '2,34,68,846'},
]}
ROUTES = {}
HITS = []
HEAD = ('SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, '
        'TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\r\n')


def bhav(day, rows):
    return (HEAD + ''.join('%s, %s, %s, %s\r\n' % (sym, ser, day, vals) for sym, ser, vals in rows)).encode()


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body = ROUTES.get(self.path, ROUTES.get(self.path.split('?')[0], (404, b'{}')))
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
sb.IPO_HOLIDAYS_URL = BASE + '/api/holiday-master?type=trading'
sb.IPO_QUOTE_URLS = (BASE + '/api/quote-equity?symbol={s}',
                     BASE + '/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series={series}&symbol={s}')
sb.EOD_FILES = dict(sb.EOD_FILES, bhav=(BASE + '/bhav_{d}.csv',))
ROUTES['/api/holiday-master'] = (200, json.dumps({'CM': [{'tradingDate': '20-Oct-2026', 'weekDay': 'Tuesday', 'description': 'Dussehra'},
                                                         {'tradingDate': '10-Nov-2026', 'description': 'Diwali Balipratipada'}],
                                                  'FO': [{'tradingDate': '01-Jan-2026'}]}).encode())
# NSE's quote: the listing date (its confirmation) and the industry; PARASHLTH is not set up on NSE yet
ROUTES['/api/quote-equity?symbol=TONBO'] = QUOTE_TONBO = (200, json.dumps({
    'info': {'symbol': 'TONBO', 'companyName': 'Tonbo Imaging India Limited', 'listingDate': '23-Oct-2026'},
    'metadata': {'series': 'EQ', 'listingDate': '23-Oct-2026'},
    'industryInfo': {'macro': 'Industrials', 'sector': 'Capital Goods', 'industry': 'Aerospace & Defense',
                     'basicIndustry': 'Aerospace & Defense'}}).encode())
# NITYAS: the first link refuses, the second (NSE's newer quote data, another shape) has it - series BE asked
ROUTES['/api/quote-equity?symbol=NITYAS'] = (401, b'')
ROUTES['/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=BE&symbol=NITYAS'] = (200, json.dumps({
    'equityResponse': [{'secInfo': {'listingDate': '22-Oct-2026', 'macro': 'Consumer Discretionary', 'sector': 'Consumer Durables',
                                    'industry': 'Consumer Durables', 'basicIndustry': 'Gems, Jewellery And Watches'}}]}).encode())
ROUTES['/api/quote-equity?symbol=PARASHLTH'] = (404, b'')
# the bhavcopies: TONBO's listing day (23-10) and the newest one out (26-10; 27-10 not out yet)
ROUTES['/bhav_23102026.csv'] = (200, bhav('23-Oct-2026', [('TONBO', 'EQ', '700.00, 812.00, 830.00, 790.00, 801.00, 805.40, 805.00, 0, 0, 0, 0, 0')]))
ROUTES['/bhav_26102026.csv'] = (200, bhav('26-Oct-2026', [('TONBO', 'EQ', '805.40, 806.00, 850.00, 800.00, 841.00, 842.30, 830.00, 0, 0, 0, 0, 0'),
                                                         ('NITYAS', 'BE', '1200.00, 1190.00, 1210.00, 1150.00, 1160.00, 1161.10, 1170.00, 0, 0, 0, 0, 0')]))
ROUTES['/bhav_22102026.csv'] = (200, bhav('22-Oct-2026', [('NITYAS', 'BE', '1119.00, 1250.00, 1300.00, 1240.00, 1290.00, 1292.20, 1280.00, 0, 0, 0, 0, 0')]))
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
assert sb.ipo_kind({'type': 'BE', 'symbol': 'NITYAS'}) == 'main', 'BE = a smaller mainboard issue (trade-for-trade at first)'
assert sb.ipo_kind({'type': 'DEBT', 'symbol': 'SMCG04'}) == 'other'
assert sb.ipo_kind({'type': '', 'symbol': 'SMCG04', 'price': 'Rs.1,000'}) == 'other'
assert sb.ipo_kind({'type': '', 'symbol': 'PARASHLTH', 'price': 'Rs.660 to Rs.693'}) == 'main'

# --- a run: three lists read, issues listed more than 14 days ago dropped, everything else sent with yyyy-mm-dd dates
TUE = date(2026, 10, 27)
sb.ipo_step(CFG, today=TUE)
assert len(SENT) == 1, SENT
p = SENT[0]
assert p['failed'] == [], p['failed']
by = {r['symbol']: r for r in p['records']}
assert sorted(by) == ['BCSSL', 'EAAA', 'NITYAS', 'PARASHLTH', 'TINY', 'TONBO'], sorted(by)
assert by['EAAA'] == {'list': 'current', 'company': 'EAAA India Alternatives Limited', 'symbol': 'EAAA', 'type': 'EQ',
                      'start': '2026-10-26', 'end': '2026-10-28', 'listing': '', 'price': 'Rs.400 to Rs.420', 'size': '',
                      'issue': ''}, by['EAAA']          # a price band is not the issue price; still open: no quote asked
# NSE's holidays (equity segment) for the T+3 listing day
assert p['holidays'] == ['2026-10-20', '2026-11-10'], p['holidays']
# listed: the issue price, NSE's quote (listing date + industry), the listing day's candle and the newest close
assert by['TONBO']['issue'] == '700' and by['TONBO']['nseListing'] == '2026-10-23', by['TONBO']
assert by['TONBO']['industry'] == {'macro': 'Industrials', 'sector': 'Capital Goods', 'industry': 'Aerospace & Defense',
                                   'basic': 'Aerospace & Defense'}, by['TONBO']
assert by['TONBO']['day1'] == [812.0, 830.0, 790.0, 805.4] and by['TONBO']['last'] == ['2026-10-26', 842.3], by['TONBO']
assert by['NITYAS']['issue'] == '1119' and by['NITYAS']['day1'] == [1250.0, 1300.0, 1240.0, 1292.2], by['NITYAS']
assert by['NITYAS']['last'] == ['2026-10-26', 1161.1] and by['NITYAS']['industry']['basic'] == 'Gems, Jewellery And Watches'
# closed, not on NSE yet: nothing from the quote, asked again next run
assert 'nseListing' not in by['PARASHLTH'] and 'industry' not in by['PARASHLTH'] and 'day1' not in by['PARASHLTH']
assert 'nseListing' not in by['TINY'], 'SME issues: no quote asked'
assert not any('symbol=TINY' in h or 'symbol=EAAA' in h or 'symbol=BCSSL' in h for h in HITS), HITS
st = json.load(open(sb.IPO_STATE_PATH))
assert st['candles']['TONBO'] == {'day': '2026-10-23', 'ohlc': [812.0, 830.0, 790.0, 805.4]}, st['candles']
assert st['quotes']['TONBO']['listing'] == '2026-10-23' and 'why' not in st['quotes']['TONBO']
pq = st['quotes']['PARASHLTH']
assert (pq['listing'], pq['industry'], pq['why']) == ('', {}, 'link 1: HTTP 404; link 2: HTTP 404'), pq
assert 'IPO lists: NSE quote gave no Basic Industry yet for PARASHLTH (PARASHLTH: link 1: HTTP 404; link 2: HTTP 404) - asked again next round.' in logtail(), logtail()
# the next run: known quotes and candles are not asked again; holidays read again only after a week
del SENT[:], HITS[:]
sb.ipo_step(CFG, today=TUE)
assert SENT[0]['records'] and [h for h in HITS if 'quote' in h.lower()] == [
    '/api/quote-equity?symbol=PARASHLTH', '/api/NextApi/apiClient/GetQuoteApi?functionName=getSymbolData&marketType=N&series=EQ&symbol=PARASHLTH'], HITS
assert not any('holiday' in h or 'bhav_23' in h or 'bhav_22' in h for h in HITS), HITS
assert {r['symbol']: r for r in SENT[0]['records']}['TONBO']['day1'] == [812.0, 830.0, 790.0, 805.4]
assert by['PARASHLTH']['list'] == 'past' and by['PARASHLTH']['listing'] == '' and by['PARASHLTH']['price'] == 'Rs.660 to Rs.693'
assert by['PARASHLTH']['start'] == '2026-10-21' and by['PARASHLTH']['end'] == '2026-10-23'
assert by['BCSSL']['size'] == '2,34,68,846' and by['BCSSL']['start'] == '2026-10-29'
assert by['TINY']['type'] == 'SME', 'SME issues go to the sheet marked as SME (the sheet leaves them out)'
assert any('/api/past-a?from_date=27-09-2026&to_date=27-10-2026' in h for h in HITS), HITS
assert 'IPO lists: 1 open, 1 closed - awaiting listing, 1 upcoming, 0 listed recently (mainboard equity; 1 SME and 0 debt/other left out), email sent.' in logtail(), logtail()
# the sheet's answer: what it did, each in its own log line
SHEET['reply'] = {'ok': True, 'open': 1, 'closed': 1, 'upcoming': 1, 'listed': 2, 'sme': 1, 'other': 0, 'emailed': False,
                  'soon': ['EDELALTS lists today (T+3, not confirmed by NSE yet)'], 'newIpos': ['PARASHLTH'], 'added': ['JPL'],
                  'priced': ['TONBO 812'], 'industry': ['TONBO: Aerospace & Defense'], 'indices': ['JPL'], 'problems': []}
sb.ipo_step(CFG, today=TUE)
for line in ('IPO lists: listing today / next trading day - EDELALTS lists today (T+3, not confirmed by NSE yet)',
             'IPO lists: added to the New IPOs tab - PARASHLTH', 'IPO lists: added to the IPOs tab + Main - JPL',
             'IPO lists: LISTING PRICE filled (listing-day open) - TONBO 812', 'IPO lists: Basic Industry filled in Main - TONBO: Aerospace & Defense',
             'IPO lists: INDICES set to NIFTY IPO in Main - JPL'):
    assert line in logtail(), (line, logtail())
assert 'could not finish' not in logtail()
SHEET['reply'] = None

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

# --- one symbol's quote, as TestConnection line 4 shows it
ROUTES['/api/quote-equity?symbol=TONBO'] = QUOTE_TONBO
got, said = sb.ipo_quote(sb.nse_session(), 'TONBO')
assert got['listing'] == '2026-10-23' and got['industry']['basic'] == 'Aerospace & Defense' and said == ['link 1: OK'], (got, said)
ROUTES['/api/quote-equity?symbol=ODD'] = (200, json.dumps({'info': {'symbol': 'ODD'}, 'priceInfo': {}}).encode())
got, said = sb.ipo_quote(sb.nse_session(), 'ODD')
assert got == {'listing': '', 'industry': {}} and said == ['link 1: no listing date / Basic Industry (answer keys: info, priceInfo)',
                                                          'link 2: HTTP 404'], said

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
