"""Offline checks for the PC bridge's NSE end-of-day step (screener_bridge.py eod_*): the full bhavcopy
(Delivery % + counts), the 52 Week High Low report (highs only) and the price band list (circuits).
A local HTTP server plays NSE, a fake api() plays the sheet. No network is used.
Run by tests/pcbridge-eod.test.js (prints OK on success, raises on failure)."""
import importlib.util
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
sb.EOD_STATE_PATH = os.path.join(TMP, 'eod_state.json')
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')
sb.time.sleep = lambda s: None

# the real files' layout (header cells and values with leading spaces in the bhavcopy)
BHAV = ('SYMBOL, SERIES, DATE1, PREV_CLOSE, OPEN_PRICE, HIGH_PRICE, LOW_PRICE, LAST_PRICE, CLOSE_PRICE, AVG_PRICE, TTL_TRD_QNTY, '
        'TURNOVER_LACS, NO_OF_TRADES, DELIV_QTY, DELIV_PER\r\n'
        'TCS, EQ, 27-Oct-2026, 3900.00, 3910.00, 3960.00, 3900.00, 3950.00, 3948.00, 3940.00, 100000, 3940.00, 5000, 61234, 61.23\r\n'
        'UPCIR, EQ, 27-Oct-2026, 100.00, 101.00, 105.00, 101.00, 105.00, 104.90, 103.00, 5000, 5.15, 90, 4000, 80.00\r\n'
        'LOWCIR, BE, 27-Oct-2026, 20.00, 19.50, 19.50, 19.00, 19.00, 19.00, 19.10, 3000, 0.57, 40, -, -\r\n'
        'FLAT, EQ, 27-Oct-2026, 50.00, 50.00, 51.00, 49.00, 50.00, 50.00, 50.00, 700, 0.35, 12, 350, 50.00\r\n'
        'NOBAND, EQ, 27-Oct-2026, 1000.00, 1000.00, 1200.00, 1000.00, 1200.00, 1199.00, 1150.00, 9000, 103.50, 300, 4500, 50.00\r\n'
        'SMEX, SM, 27-Oct-2026, 10.00, 10.00, 10.50, 10.00, 10.50, 10.50, 10.20, 6000, 0.61, 8, 6000, 100.00\r\n'
        'NOTRADE, EQ, 27-Oct-2026, 30.00, 0.00, 0.00, 0.00, 0.00, 30.00, 0.00, 0, 0.00, 0, -, -\r\n'
        'GOLDBEES, EQ, 27-Oct-2026, 60.00, 60.00, 61.00, 59.00, 59.50, 59.50, 60.00, 80000, 48.00, 900, 20000, 25.00\r\n')
W52 = ('"Disclaimer - The Data provided in the adjusted 52 week high and adjusted 52 week low columns  are adjusted for corporate actions '
       '(bonus, splits & rights).For actual (unadjusted) 52 week high & low prices, kindly refer bhavcopy."\r\n'
       '"Effective for 27-Oct-2026"\r\n'
       '"SYMBOL","SERIES","Adjusted 52_Week_High","52_Week_High_DT","Adjusted 52_Week_Low","52_Week_Low_DT"\r\n'
       '"TCS","EQ","4500","10-JAN-2026","3000","01-APR-2026"\r\n'
       '"UPCIR","EQ","104","26-OCT-2026","60","01-FEB-2026"\r\n'   # the report can hold highs up to the day before
       '"FLAT","EQ","50.5","01-OCT-2026","30","01-MAR-2026"\r\n'
       '"NOBAND","EQ","1200","27-Oct-2026","700","01-MAR-2026"\r\n'
       '"SMEX","SM","10.5","27-OCT-2026","5","01-JUN-2026"\r\n'
       '"LOWCIR","BE","45","02-DEC-2025","19","27-OCT-2026"\r\n')
BANDS = ('Symbol,Series,Security Name,Band,Remarks\r\n'
         'TCS,EQ,Tata Consultancy Services Limited,No Band,\r\n'
         'UPCIR,EQ,Up Circuit Limited,5,\r\n'
         'LOWCIR,BE,Low Circuit Limited,5,\r\n'
         'FLAT,EQ,Flat Limited,20,\r\n'
         'NOBAND,EQ,No Band Limited,No Band,\r\n')

# ---------------------------------------------------------------- parsing and counting
bhav = sb.bhav_parse(BHAV.encode())
assert [r['sym'] for r in bhav][:3] == ['TCS', 'UPCIR', 'LOWCIR'], bhav
assert bhav[0]['deliv'] == 61.23 and bhav[2]['deliv'] is None and bhav[1]['last'] == 105.0 and bhav[1]['close'] == 104.9
w52 = sb.w52_parse(W52.encode())
assert w52[('TCS', 'EQ')] == (4500.0, date(2026, 1, 10)) and w52[('UPCIR', 'EQ')][1] == date(2026, 10, 26), w52
bands = sb.bands_parse(BANDS.encode())
assert bands[('UPCIR', 'EQ')] == 5.0 and bands[('TCS', 'EQ')] is None
assert sb.bhav_parse(b'<html><body>Access denied</body></html>') is None and sb.w52_parse(b'a,b\r\n1,2') is None
for s, d in (('06-JAN-2026', date(2026, 1, 6)), ('06-Jan-26', date(2026, 1, 6)), ('06-01-2026', date(2026, 1, 6)), ('2026-01-06', date(2026, 1, 6)),
             ('31-FEB-2026', None), ('', None), ('-', None)):
    assert sb.eod_date(s) == d, (s, sb.eod_date(s))
assert sb._at_band(105, 100, 5) == 'upper' and sb._at_band(104.95, 100, 5) == 'upper' and sb._at_band(104.5, 100, 5) is None
assert sb._at_band(19, 20, 5) == 'lower' and sb._at_band(2.13, 2.03, 5) == 'upper', 'a tick of rounding on a low price'
assert sb._at_band(120, 100, None) is None and sb._at_band(None, 100, 5) is None

DAY = date(2026, 10, 27)
p = sb.eod_summary(DAY, bhav, w52, bands)
assert p['tradeDate'] == '2026-10-27'
# mainboard (EQ/BE/BZ), traded: TCS UPCIR LOWCIR FLAT NOBAND GOLDBEES (SMEX = SME, NOTRADE = no trades)
# new 52-week highs = the day's own high reaching the report's: UPCIR (105 > 104 of the day before), FLAT (51 > 50.5), NOBAND (= 1200)
assert p['stats'] == {'traded': 6, 'advances': 3, 'declines': 2, 'unchanged': 1, 'high52': 3, 'upper': 1, 'lower': 1}, p['stats']
assert p['delivery'] == {'TCS': 61.23, 'UPCIR': 80.0, 'FLAT': 50.0, 'NOBAND': 50.0, 'GOLDBEES': 25.0}, p['delivery']
assert p['high52'] == [['FLAT', 51.0, '2026-10-27', 50.0], ['LOWCIR', 45.0, '2025-12-02', 19.0], ['NOBAND', 1200.0, '2026-10-27', 1199.0],
                       ['TCS', 4500.0, '2026-01-10', 3948.0], ['UPCIR', 105.0, '2026-10-27', 104.9]], p['high52']
assert p['files'] == {'bhav': True, 'w52': True, 'bands': True}
# every traded stock's day, for the sheet to count its own Main stocks: [close, % change, move, circuit, new 52W high, series]
assert p['day'] == {'TCS': [3948.0, 1.23, 1, '', 0, 'EQ'], 'UPCIR': [104.9, 4.9, 1, 'U', 1, 'EQ'], 'LOWCIR': [19.0, -5.0, -1, 'L', 0, 'BE'],
                    'FLAT': [50.0, 0.0, 0, '', 1, 'EQ'], 'NOBAND': [1199.0, 19.9, 1, '', 1, 'EQ'], 'SMEX': [10.5, 5.0, 1, '', 1, 'SM'],
                    'GOLDBEES': [59.5, -0.83, -1, '', 0, 'EQ']}, p['day']
two = sb.bhav_parse((BHAV + 'TCS, BL, 27-Oct-2026, 3900.00, 3900.00, 3900.00, 3900.00, 3900.00, 3800.00, 3900.00, 10, 0.39, 1, 10, 100.00\r\n').encode())
assert sb.eod_day_rows(DAY, two, None, None)['TCS'] == [3948.0, 1.23, 1, '', 0, 'EQ'], 'the mainboard series wins'
q = sb.eod_summary(DAY, bhav, None, None)
assert (q['stats']['high52'], q['stats']['upper'], q['stats']['lower'], q['high52']) == (None, None, None, []), q
assert q['day']['UPCIR'] == [104.9, 4.9, 1, '', 0, 'EQ'], 'no band list / 52-week report: no circuit, no new high'
assert q['files'] == {'bhav': True, 'w52': False, 'bands': False}

# ---------------------------------------------------------------- the step against a pretend NSE
FILES, HITS = {}, []


class NSE(BaseHTTPRequestHandler):
    def do_GET(self):
        HITS.append(self.path)
        st, body = FILES.get(self.path.split('?')[0], (404, b'<Error>NoSuchKey</Error>'))
        self.send_response(st)
        self.send_header('Content-Type', 'text/csv')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def log_message(self, *a):
        pass


srv = HTTPServer(('127.0.0.1', 0), NSE)
threading.Thread(target=srv.serve_forever, daemon=True).start()
BASE = 'http://127.0.0.1:%d' % srv.server_port
sb.EOD_FILES = {'bhav': (BASE + '/products/content/sec_bhavdata_full_{d}.csv',), 'w52': (BASE + '/content/CM_52_wk_High_low_{d}.csv',),
                'bands': (BASE + '/content/equities/sec_list_{d}.csv',)}
sb.PB_REPORTS_API = BASE + '/api/merged-daily-reports'
sb.nse_session = lambda: urllib.request.build_opener(urllib.request.HTTPCookieProcessor(CookieJar()))


def put(day, bhav=BHAV, w52=W52, bands=BANDS):
    tag = day.strftime('%d%m%Y')
    FILES['/products/content/sec_bhavdata_full_%s.csv' % tag] = (200, bhav.encode())
    if w52:
        FILES['/content/CM_52_wk_High_low_%s.csv' % tag] = (200, w52.encode())
    if bands:
        FILES['/content/equities/sec_list_%s.csv' % tag] = (200, bands.encode())


SENT, REPLY = [], {}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    assert action == 'eod', action
    SENT.append(payload)
    if REPLY.get('r'):
        return REPLY['r']
    # the sheet answers with its own Main stocks' counts
    st = {'traded': 4, 'advances': 2, 'declines': 1, 'unchanged': 1, 'high52': 2 if payload['files']['w52'] else None, 'upper': 1, 'lower': 0}
    return {'ok': True, 'tradeDate': payload['tradeDate'], 'stats': st, 'deliveryInMain': 3, 'newHighs': payload['stats']['high52']}


sb.api = fake_api
LOGS = []
sb.log = LOGS.append
CFG = {'url': 'x', 'token': 'y'}

# first run on Tue 27-Oct: last week's Thu 22 (holiday, no file) is skipped; Mon 26 has no 52-week report
put(date(2026, 10, 20)); put(date(2026, 10, 21)); put(date(2026, 10, 23))
put(date(2026, 10, 26), w52=None)
put(DAY)
sb.eod_step(CFG, today=DAY)
assert [x['tradeDate'] for x in SENT] == ['2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26', '2026-10-27'], [x['tradeDate'] for x in SENT]
assert SENT[3]['files'] == {'bhav': True, 'w52': False, 'bands': True} and SENT[3]['stats']['high52'] is None
log = '\n'.join(LOGS)
assert ('NSE end-of-day 27-10-2026: your Main stocks - 4 traded, 2 up / 1 down / 1 unchanged, 2 at a 52-week high, circuits 1 up / 0 down; '
        'Delivery % for 3 in Main.') in log, log
assert ('NSE end-of-day 26-10-2026: your Main stocks - 4 traded, 2 up / 1 down / 1 unchanged, - at a 52-week high, circuits 1 up / 0 down; '
        'Delivery % for 3 in Main; not downloaded: 52-week report.') in log, log
assert sb.eod_load_state()['last'] == '2026-10-27'

# the next run: nothing new
del SENT[:], LOGS[:]
sb.eod_step(CFG, today=DAY)
assert SENT == [] and 'NSE end-of-day: up to date (latest day sent: 27-10-2026).' in LOGS, LOGS
# next evening before NSE publishes: says so; switched off: nothing at all
del LOGS[:], HITS[:]
sb.eod_step(CFG, today=date(2026, 10, 28))
assert SENT == [] and any("today's files" in x and 'not out yet' in x for x in LOGS), LOGS
del LOGS[:], HITS[:]
sb.eod_step(dict(CFG, eod=False), today=date(2026, 10, 28))
assert not LOGS and not HITS

# a moved address: found through NSE's All Reports list
FILES['/api/merged-daily-reports'] = (200, ('[{"name":"Full Bhavcopy","link":"' + BASE.replace('/', '\\/') +
                                            '\\/new\\/sec_bhavdata_full_28102026.csv"}]').encode())
FILES['/new/sec_bhavdata_full_28102026.csv'] = (200, BHAV.encode())
del LOGS[:]
sb.eod_step(CFG, today=date(2026, 10, 28))
assert [x['tradeDate'] for x in SENT] == ['2026-10-28'] and SENT[0]['files'] == {'bhav': True, 'w52': False, 'bands': False}, SENT

# an older web app: the hint, and the day is not marked as sent
REPLY['r'] = {'ok': False, 'error': 'unknown action'}
sb.eod_save_state({'v': sb.EOD_STATE_VERSION, 'last': '2026-10-26'})
del SENT[:], LOGS[:]
sb.eod_step(CFG, today=DAY)
assert len(SENT) == 1 and 'Version: New version > Deploy' in '\n'.join(LOGS) and sb.eod_load_state()['last'] == '2026-10-26', LOGS


# just after a New version deploy Google may still answer with the older version (no Main-stock counts): stop, send that day again
REPLY['r'] = {'ok': True, 'tradeDate': '2026-10-27', 'deliveryInMain': 3, 'newHighs': 2}
sb.eod_save_state({'v': sb.EOD_STATE_VERSION, 'last': '2026-10-23'})
del SENT[:], LOGS[:]
sb.eod_step(CFG, today=DAY)
assert [x['tradeDate'] for x in SENT] == ['2026-10-26'], 'stops at the first day the old version answered'
assert 'answered with its older version' in '\n'.join(LOGS) and sb.eod_load_state()['last'] == '2026-10-23', LOGS

# a state from an earlier version of this program: the last week is sent again once
REPLY.pop('r')
sb.eod_save_state({'last': '2026-10-27'})
del SENT[:]
sb.eod_step(CFG, today=DAY)
assert [x['tradeDate'] for x in SENT] == ['2026-10-20', '2026-10-21', '2026-10-23', '2026-10-26', '2026-10-27'], [x['tradeDate'] for x in SENT]
assert sb.eod_load_state()['v'] == sb.EOD_STATE_VERSION
del SENT[:]
sb.eod_step(CFG, today=DAY)
assert SENT == []

srv.shutdown()
print('OK')
