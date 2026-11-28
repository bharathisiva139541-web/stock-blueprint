# -*- coding: utf-8 -*-
"""Offline checks of Corporate Intelligence (pcbridge/ScreenerBridge/corp_ann.py; owner, 28-Nov-2026: NSE's corporate
announcements sorted into 6 categories and scored by fixed rules - "No AI involvment here. use python library to extract
information from pdf"; the laptop keeps every announcement, the sheet 30 days). The records here are MADE in the shape of
NSE's corporate-announcements answer (symbol / desc / attchmntText / attchmntFile / an_dt / seq_id / sm_name) and the PDF
is made here too (pypdf reads it). Prints OK at the end."""
import json
import os
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp()
import corp_ann as C   # noqa: E402

C.DIR = os.path.join(TMP, 'corp_data')
C.STATE_PATH = os.path.join(TMP, 'corp_state.json')
LOGS = []
C.log = LOGS.append
TODAY = date(2026, 11, 28)
C.ist_today = lambda: TODAY


def cl(sub, tx='', pt='', info=None):
    return C.classify(sub, tx, pt, info or {})


# ------------------------------------------------------------------ 1. events + categories (NSE's subject first, then the words)
cases = (
    ('Bagging/Receiving of orders/contracts', 'ABC Ltd has received an order worth Rs. 345.50 crore from NHAI', 'order', 'A'),
    ('Credit Rating', 'ICRA has reaffirmed [ICRA]AA-(Stable)', 'rating', 'B'),
    ('Board Meeting Intimation', 'to consider and approve the financial results for the quarter', 'meeting', 'C'),
    ('Outcome of Board Meeting', 'The Board approved the unaudited financial results for the quarter ended September 30, 2026', 'results', 'B'),
    ('Copy of Newspaper Publication', 'Newspaper publication of the notice', 'paper', 'F'),
    ('Trading Window', 'Closure of trading window', 'comp', 'F'),
    ('Analysts/Institutional Investor Meet/Con. Call Updates', 'Schedule of analyst / investor meet', 'call', 'F'),
    ('Investor Presentation', 'Investor presentation', 'present', 'F'),
    ('Updates', 'Monthly business update - total sales of 1,23,456 units in November 2026', 'update', 'D'),
    ('Press Release', 'The company has commissioned its new plant at Hosur with additional capacity of 500 MW', 'capex', 'A'),
    ('General Updates', 'The company has been declared L1 bidder for a project worth USD 25 million', 'order', 'A'),
    ('Action(s) initiated or orders passed', 'Receipt of a GST demand order of Rs. 12.3 crore including penalty', 'legal', 'E'),
    ('Disclosure under SEBI Takeover Regulations', 'Regulation 31 of SEBI (Substantial Acquisition of Shares and Takeovers) - creation of '
     'pledge on 12.5% of the shares', 'pledge', 'E'),
    ('Acquisition', 'Acquisition of 51% stake in XYZ Pvt Ltd for a total consideration of Rs. 120 crore', 'acq', 'A'),
    ('Fund Raising', 'The Board approved raising of funds up to Rs 1,000 crore through Qualified Institutions Placement', 'fund', 'B'),
    ('Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent',
     'Resignation of Mr X as Chief Financial Officer of the Company with immediate effect', 'kmp', 'C'),
    ('Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent',
     'Resignation of M/s ABC & Co as Statutory Auditors of the Company', 'auditor', 'C'),
    ('Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent',
     'Appointment of Ms Y as an Additional Director (Independent)', 'director', 'C'),
    ('Buy back', 'Buyback of equity shares at Rs 1,500 per share aggregating up to Rs 600 crore', 'buyback', 'B'),
    ('Bonus', 'The Board recommended a bonus issue in the ratio of 1:1', 'bonus', 'B'),
    ('Corporate Action-Updates', 'Sub-division of the face value of equity shares from Rs 10 each to Rs 2 each', 'split', 'B'),
    ('Fraud/Default/Arrest', 'Delay in payment of interest on NCDs', 'default', 'E'),
    ('Insolvency and Bankruptcy', 'NCLT admitted the petition - Corporate Insolvency Resolution Process', 'insolv', 'E'),
    ('Updates', 'A fire broke out at the Dahej plant; no injuries', 'disrupt', 'E'),
    ('Clarification sought from the Company', 'Clarification on the price movement', 'clarify', 'F'),
    ('Joint Venture', 'Joint venture agreement with a Japanese company', 'jv', 'A'),
    ('Updates', 'Receipt of Establishment Inspection Report (EIR) from USFDA for the Pithampur facility', 'approval', 'A'),
)
for sub, tx, ev, cat in cases:
    c = cl(sub, tx)
    assert (c['ev'], c['cat']) == (ev, cat), (sub, tx, c['ev'], c['cat'], c['why'])
    assert c['pr'] in ('high', 'med', 'low', 'routine') and all(0 <= c[k] <= 100 for k in ('bi', 'gr', 'su'))
    assert set(c['ex']) <= set(C.EVENTS) and c['ev'] not in c['ex']
# other events of one filing: a board outcome with results + dividend; a meeting notice lists only its agenda
c = cl('Outcome of Board Meeting', 'The Board approved the unaudited financial results for the quarter and declared an interim '
       'dividend of Rs. 5 per equity share. The record date is 10-12-2026.')
assert c['ev'] == 'results' and c['ex'] == ['dividend'] and c['num']['dps'] == 5.0 and c['num']['dty'] == 'interim' and c['num']['rd'] == '2026-12-10', c
c = cl('Board Meeting Intimation', 'to consider and approve the financial results and fund raising by way of QIP')
assert c['ev'] == 'meeting' and c['ex'] == ['fund'] and c['num'].get('ins') == 'QIP', c
assert 'fund' in C.filters_of(c) and 'results' not in C.filters_of(c)
# routine filings: priority Routine, no risk
for sub in ('Trading Window', 'Copy of Newspaper Publication', 'Certificate under SEBI (Depositories and Participants) Regulations, 2018'):
    c = cl(sub, sub)
    assert c['pr'] == 'routine' and not c['risk'] and c['su'] <= 10, (sub, c)
# 'demand order of Rs ...' is no order win; SAST words are no acquisition
assert 'order' not in cl('Action(s) initiated or orders passed', 'GST demand order of Rs 12 crore')['ex']
assert cl('Disclosure under SEBI Takeover Regulations', 'Disclosure under SEBI (Substantial Acquisition of Shares and Takeovers) '
          'Regulations, 2011 - Regulation 29(2)')['ev'] == 'sast'

# ------------------------------------------------------------------ 2. numbers
assert C.amounts('worth Rs. 345.50 crore') [0][0] == 345.5
assert C.amounts('INR 2,500 million')[0][0] == 250.0
assert C.amounts('Rs 45 lakh')[0][0] == 0.45
assert C.amounts('Rs. 12,34,56,789/-')[0][0] == round(123456789 / 1e7, 6) or abs(C.amounts('Rs. 12,34,56,789/-')[0][0] - 12.3456789) < 1e-9
assert abs(C.amounts('USD 25 million')[0][0] - 25 * 88 / 10) < 1e-9 and C.amounts('USD 25 million')[0][3] == 'USD'
assert C.amounts('an order of 345 crore')[0][0] == 345.0
assert C.amounts('Rs 1.2 lakh crore')[0][0] == 120000.0
assert C.amounts('` 500 Cr')[0][0] == 500.0                     # the rupee sign of many PDFs comes out as a backtick
assert C.amounts('at Rs 1,500 per share') == []                 # a bare small amount is a price
# the order value: the amount beside the order's words, not the turnover / per-share ones
t = 'The company with a turnover of Rs 5,000 crore has received orders worth Rs 220 crore and Rs 130 crore, aggregating to Rs 350 crore.'
assert C.main_amount(t, 'order') == (350.0, 'INR'), C.main_amount(t, 'order')
assert C.main_amount('Dividend of Rs 5 per share; orders of Rs 40 crore', 'order') == (40.0, 'INR')
assert C.period_months('to be executed within 18 months') == 18.0
assert C.period_months('to be completed over a period of 3 years') == 36.0
assert C.period_months('the company is 25 years old') is None
r = C.rating('CARE Ratings has upgraded the long term rating from CARE A- to CARE A+; Stable')
assert r == {'ag': 'CARE', 'rt': 'A+', 'from': 'A-', 'act': 'up'}, r
r = C.rating('CRISIL has downgraded its rating to CRISIL BB+/Negative from CRISIL BBB-/Stable')
assert r['ag'] == 'CRISIL' and r['act'] == 'down', r
assert C.rating('India Ratings has affirmed IND A+/Stable')['ag'] == 'India Ratings'
assert C.rating('ICRA has reaffirmed [ICRA]AA-(Stable)') == {'ag': 'ICRA', 'rt': 'AA-', 'act': 'same'}
assert C.find_date('on December 10, 2026 the') == '2026-12-10' and C.find_date('10th Dec, 2026') == '2026-12-10'
assert C.find_date('10.12.2026') == '2026-12-10' and C.find_date('nothing') is None
n = cl('Buy back', 'Buyback of equity shares at a price of Rs 1,500 per equity share aggregating up to Rs 600 crore', '', {'mcap': 6000})['num']
assert n['val'] == 600.0 and n['px'] == 1500.0 and n['mc'] == 10.0, n
n = cl('Bonus', 'issue of 1 (one) bonus equity share for every 2 (two) fully paid-up equity shares held')['num']
assert n['ratio'] == '1:2', n
n = cl('Corporate Action-Updates', 'Sub-division of the face value of equity shares from Rs 10 each to Rs 2 each')['num']
assert n['fv'] == [10.0, 2.0], n
n = cl('Updates', 'Sales update: total sales of 45,210 units, a growth of 18% YoY')['num']
assert n['units'] == 45210 and n['gr'] == 18.0, n
n = cl('Updates', 'Monthly business update: domestic sales declined by 7.5% to 12,000 units')['num']
assert n['gr'] == -7.5, n
n = cl('Disclosure under SEBI Takeover Regulations', 'invocation of pledge on 8.2% of the share capital')['num']
assert n['pact'] == 'invoke' and n['pl'] == 8.2, n
n = cl('Acquisition', 'acquire 26% stake in ABC for Rs 75 crore')['num']
assert n['stake'] == 26.0 and n['val'] == 75.0, n

# ------------------------------------------------------------------ 3. scores
small = cl('Bagging/Receiving of orders/contracts', 'order worth Rs 5 crore', '', {'rev': 10000})
big = cl('Bagging/Receiving of orders/contracts', 'order worth Rs 5,000 crore to be executed within 24 months', '', {'rev': 10000})
assert big['num']['pct'] == 50.0 and big['num']['pcty'] == 25.0 and big['bi'] > small['bi'] and big['su'] > small['su'], (big, small)
assert big['pr'] == 'high' and small['pr'] in ('low', 'med') and small['num']['pct'] == 0.1
up = cl('Credit Rating', 'upgraded from CARE A- to CARE A+')
down = cl('Credit Rating', 'downgraded from CRISIL BBB to CRISIL BB')
assert up['bi'] > 30 and not up['risk'] and down['gr'] >= 70 and down['risk'] and down['pr'] == 'high', (up, down)
cfo_out = cl('Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent', 'Resignation of the CFO')
cfo_in = cl('Change in Directors/ Key Managerial Personnel/ Auditor/ Compliance Officer/ Share Transfer Agent', 'Appointment of Mr Z as CFO')
assert cfo_out['gr'] == 65 and cfo_out['risk'] and cfo_in['gr'] == 10 and not cfo_in['risk'], (cfo_out, cfo_in)
inv = cl('Pledge', 'invocation of pledge of promoter shares')
rel = cl('Pledge', 'release of pledge on the promoter shares')
assert inv['gr'] == 80 and inv['risk'] and rel['gr'] == 10 and not rel['risk'], (inv, rel)
tax_small = cl('Action(s) initiated or orders passed', 'income tax demand of Rs 2 crore', '', {'rev': 5000})
tax_big = cl('Action(s) initiated or orders passed', 'income tax demand of Rs 900 crore', '', {'rev': 5000})
assert tax_big['gr'] > tax_small['gr'] and tax_big['num']['pct'] == 18.0, (tax_big, tax_small)
qip = cl('Fund Raising', 'raise funds up to Rs 2,000 crore through QIP', '', {'mcap': 8000})
assert qip['num']['mc'] == 25.0 and qip['bi'] >= 60 and qip['gr'] >= 20, qip
assert set(C.filters_of(big)) >= {'orders', 'high'} and 'risk' in C.filters_of(down) and 'mgmt' in C.filters_of(cfo_out)

# ------------------------------------------------------------------ 4. NSE's records -> the archive (every company, never deleted)
def rec(seq, sym, sub, tx, at, pdf=''):
    return {'symbol': sym, 'desc': sub, 'attchmntText': tx, 'an_dt': at, 'seq_id': seq, 'sm_name': sym.title() + ' Ltd',
            'attchmntFile': pdf, 'sm_isin': 'INE000A01010', 'smIndustry': 'Industry'}


PDF_URL = 'https://nsearchives.nseindia.com/corporate/ABC_28112026120000_order.pdf'
RECS = [rec('101', 'ABC', 'Press Release', 'Press Release', '28-Nov-2026 12:00:00', PDF_URL),
        rec('102', 'ABC', 'Trading Window', 'Closure of trading window', '27-Nov-2026 18:00:00'),
        rec('103', 'XYZ', 'Credit Rating', 'CARE Ratings has upgraded the rating from CARE A- to CARE A+', '26-Nov-2026 10:05:00'),
        rec('104', 'NOTMAIN', 'Bagging/Receiving of orders/contracts', 'order worth Rs 10 crore', '28-Nov-2026 09:00:00'),
        {'symbol': '', 'desc': 'x'}, 'junk']
got = C.take(RECS)
assert got == {'2026-11-28': 2, '2026-11-27': 1, '2026-11-26': 1}, got
assert C.take(RECS) == {}, 'the same announcements again change nothing'
assert set(C.load_day('2026-11-28')) == {'101', '104'}, 'every company is kept (not only Main)'
r = C.load_day('2026-11-28')['101']
assert r['sym'] == 'ABC' and r['co'] == 'Abc Ltd' and r['at'] == '2026-11-28 12:00:00' and r['pdf'] == PDF_URL
assert C.record({'symbol': 'ABC', 'desc': 'x', 'an_dt': '2026-11-28 10:00:00'})['id']      # no seq_id -> a made id
assert C.archive_days() == ['2026-11-26', '2026-11-27', '2026-11-28']

# ------------------------------------------------------------------ 5. the sheet: Main's stocks, the days, the website's questions
SENT = []


def api(cfg, action, body, tries=3, timeout=120):
    assert action == 'corp'
    SENT.append(json.loads(json.dumps(body)))
    if body['op'] == 'syms':
        return {'ok': True, 'syms': {'ABC': ['ABC Industries', 2000.0], 'XYZ': ['XYZ Finance', None]}}
    if body['op'] == 'ask':
        return {'ok': True, 'asks': ASKS.pop(0) if ASKS else [], 'next': 120}
    return {'ok': True}


ASKS = []
CFG = {'url': 'https://example.invalid/exec', 'token': 't'}
C.bind(revenue=lambda sym: {'ABC': 800.0}.get(sym), get=None)
SENT.clear()
n = C.step(CFG, api, [], today=TODAY, fetch_back=lambda a, b: [rec('90', 'XYZ', 'Bagging/Receiving of orders/contracts',
                                                                     'received an order worth Rs 50 crore', '22-Nov-2026 11:00:00')])
puts = [b for b in SENT if b['op'] == 'put']
assert n == 4 and [d['day'] for p in puts for d in p['days']] == ['2026-11-28', '2026-11-27', '2026-11-26', '2026-11-22'], SENT
d0 = puts[0]['days'][0]
rows = C.unpack(d0['blob'])
assert [r['sym'] for r in rows] == ['ABC'] and rows[0]['co'] == 'ABC Industries', 'Main stocks only, Main\'s name'
assert d0['sum']['n'] == 1 and puts[0]['engine'] == C.ENGINE and puts[0]['keep'] == 30
assert C.load_state()['backDays'] == ['2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'], 'the first week once'
assert any('the first week' in x for x in LOGS)
SENT.clear()
assert C.step(CFG, api, [], today=TODAY, fetch_back=lambda a, b: 1 / 0) == 0 and not [b for b in SENT if b['op'] == 'put'], \
    'nothing changed: nothing sent, no second backfill'
# a changed announcement -> its day only
SENT.clear()
C.step(CFG, api, [rec('103', 'XYZ', 'Credit Rating', 'CARE Ratings has downgraded the rating from CARE A to CARE BBB+',
                      '26-Nov-2026 10:05:00')], today=TODAY)
puts = [b for b in SENT if b['op'] == 'put']
assert [d['day'] for p in puts for d in p['days']] == ['2026-11-26'], SENT
x = C.unpack(puts[0]['days'][0]['blob'])[0]
assert x['ev'] == 'rating' and x['num']['ract'] == 'down' and x['risk'] == 1 and x['cat'] == 'B', x
assert list(x) == list(C.COLS)
# an older web app
old = lambda cfg, action, body, **k: {'ok': False, 'error': 'unknown action'}
st = C.load_state()
st.pop('syms')
C.save_state(st)
LOGS.clear()
assert C.step(CFG, old, [], today=TODAY) is None and any('UpdateNow.bat' in x for x in LOGS), LOGS
C.step(CFG, api, [], today=TODAY)                # Main's stocks again
assert C.load_state()['syms']['ABC'][0] == 'ABC Industries'
# off
assert C.step(dict(CFG, corp_intel=False), api, RECS) is None

# ------------------------------------------------------------------ 6. the PDF (pypdf) -> numbers -> the scores
def make_pdf(lines):
    """A small real PDF with these text lines (Helvetica) - for pypdf."""
    content = 'BT /F1 11 Tf 50 780 Td 14 TL ' + ' '.join('(%s) Tj T*' % l.replace('(', '[').replace(')', ']') for l in lines) + ' ET'
    objs = ['<< /Type /Catalog /Pages 2 0 R >>', '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
            '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
            '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
            '<< /Length %d >>\nstream\n%s\nendstream' % (len(content), content)]
    out, offs = b'%PDF-1.4\n', []
    for i, o in enumerate(objs):
        offs.append(len(out))
        out += ('%d 0 obj\n%s\nendobj\n' % (i + 1, o)).encode('latin-1')
    x = len(out)
    out += ('xref\n0 %d\n0000000000 65535 f \n' % (len(objs) + 1)).encode() + b''.join(('%010d 00000 n \n' % o).encode() for o in offs)
    out += ('trailer << /Size %d /Root 1 0 R >>\nstartxref\n%d\n%%%%EOF\n' % (len(objs) + 1, x)).encode()
    return out


PDF = make_pdf(['PRESS RELEASE', 'ABC Industries bags an order worth Rs. 400 crore from the Ministry of Railways.',
                'The order is to be executed within 24 months.'])
reader = C.pdf_reader(install=lambda: (False, 'not here'))
assert reader is not None, 'pypdf is installed in this test environment'
text, pages = C.pdf_text(PDF, reader)
assert 'Rs. 400 crore' in text and pages == 1, text
try:
    C.pdf_text(b'<html>no</html>', reader)
    raise AssertionError('not a PDF')
except ValueError:
    pass
syms = C.load_state()['syms']
todo = C.pdf_todo(syms, TODAY)
assert todo == [('2026-11-28', '101')], todo            # the press release (worth reading), not the trading window
before = C.site_row(C.load_day('2026-11-28')['101'], syms)
assert before['ev'] == 'press' and before['pg'] == '' and before['pdf'] == PDF_URL
CALLS = []
res = C.read_pdf('2026-11-28', '101', reader, get=lambda u: (CALLS.append(u), (200, PDF))[1])
assert res == 'ok' and CALLS == [PDF_URL]
after = C.site_row(C.load_day('2026-11-28')['101'], syms)
assert after['ev'] == 'order' and after['pg'] == 'r' and after['num']['val'] == 400.0 and after['num']['mo'] == 24.0, after
assert after['num']['pct'] == 50.0 and after['pr'] == 'high', 'Rs 400 crore against Rs 800 crore of revenue (TTM)'
assert C.pdf_todo(syms, TODAY) == [], 'read once'
C.take([rec('101', 'ABC', 'Press Release', 'Press Release', '28-Nov-2026 12:00:00', PDF_URL)])
assert C.load_day('2026-11-28')['101'].get('pt'), 'the PDF text survives the same record again'
# refusals: 403 = try later (not marked), 404 = marked, a web page = marked
C.take([rec('105', 'ABC', 'Updates', 'Business update', '28-Nov-2026 13:00:00', PDF_URL.replace('order', 'upd'))])
assert C.read_pdf('2026-11-28', '105', reader, get=lambda u: (403, b'')) == 'retry' and not C.load_day('2026-11-28')['105'].get('pdfSt')
assert C.read_pdf('2026-11-28', '105', reader, get=lambda u: (200, b'<html>')) == 'err:not a PDF'
assert C.load_day('2026-11-28')['105']['pdfSt'] == 'err:not a PDF'
# a scanned PDF (no text) = 'none'
C.take([rec('106', 'ABC', 'Updates', 'Business update', '28-Nov-2026 14:00:00', PDF_URL.replace('order', 'scan'))])
assert C.read_pdf('2026-11-28', '106', reader, get=lambda u: (200, make_pdf(['']))) == 'none'
assert C.site_row(C.load_day('2026-11-28')['106'], syms)['pg'] == 'x'
# only NSE's own addresses are fetched / passed on
assert not C.PDF_HOSTS.match('https://evil.example/x.pdf') and C.PDF_HOSTS.match(PDF_URL)
# owner, 28-Nov-2026: his RATNAVEER press release was on nsearchives.nseindia.IN - the first version allowed .com only, so
# no PDF was read and the website showed no link. Both now; a path on NSE's archive gets its address.
RAT_URL = 'https://nsearchives.nseindia.in/corporate/RATNAVEER_26112026163619_Press_release_signed.pdf'
assert C.PDF_HOSTS.match(RAT_URL) and C.PDF_HOSTS.match('https://www.nseindia.in/x.pdf')
assert not C.PDF_HOSTS.match('https://nseindia.in.evil.example/x.pdf') and not C.PDF_HOSTS.match('http://nsearchives.nseindia.in/x.pdf')
assert C.record({'symbol': 'ABC', 'desc': 'x', 'an_dt': '27-Nov-2026 10:00:00', 'attchmntFile': '/corporate/ABC_1.pdf'})['pdf'] == \
    'https://nsearchives.nseindia.com/corporate/ABC_1.pdf'
assert after['ps'] and any('Rs. 400 crore' in x for x in after['ps']), after['ps']
RAT_PDF = make_pdf(['RATNAVEER PRECISION ENGINEERING LIMITED', 'Date: November 26, 2026', 'To,', 'The Manager, Listing Department,',
                    'National Stock Exchange of India Limited, Exchange Plaza, Bandra Kurla Complex, Mumbai - 400051', 'Symbol: RATNAVEER',
                    'Sub: Press Release - Update on Copper Cladded Steel Wire project', 'Dear Sir/Madam,',
                    'Pursuant to Regulation 30 of SEBI LODR Regulations, 2015, please find enclosed the press release.',
                    'Kindly take the same on record.', 'Thanking you,', 'Yours faithfully,', 'For Ratnaveer Precision Engineering Limited',
                    'Company Secretary & Compliance Officer', 'PRESS RELEASE',
                    'Ratnaveer Precision Engineering Limited commences commercial production of Copper Cladded Steel',
                    'Wire at its Waghodia plant in Gujarat. The new line has an installed capacity of 6,000 MTPA and was built with a capex of',
                    'Rs. 45 crore funded through internal accruals. The company expects incremental revenue of about Rs 120 crore from this',
                    'line in FY28, with EBITDA margins of 12-14%.',
                    'Commenting on the development, Mr. Vijay Sanghavi, Managing Director said, this marks our entry into power transmission.',
                    'Safe Harbour: This release may contain forward-looking statements.'])
RAT_TX = ('Ratnaveer Precision Engineering Limited has informed the Exchange regarding a press release dated November 26, 2026, titled '
          'Press Release - Update on Copper Cladded Steel Wire project.')
C.take([rec('201', 'ABC', 'Press Release', RAT_TX, '27-Nov-2026 16:36:19', RAT_URL)])
assert ('2026-11-27', '201') in C.pdf_todo(syms, TODAY), 'a press release on nseindia.in is read'
assert C.site_row(C.load_day('2026-11-27')['201'], syms)['pdf'] == RAT_URL, 'and its link is shown'
assert C.read_pdf('2026-11-27', '201', reader, get=lambda u: (200, RAT_PDF)) == 'ok'
rat = C.site_row(C.load_day('2026-11-27')['201'], syms)
assert rat['ev'] == 'capex' and rat['pg'] == 'r' and rat['num']['val'] == 45.0 and rat['num']['cap'] == '6,000 MTPA', rat
assert rat['ps'][0] == 'Subject: Press Release - Update on Copper Cladded Steel Wire project', rat['ps']
assert any(x.startswith('Ratnaveer Precision Engineering Limited commences commercial production') for x in rat['ps']), rat['ps']
assert any('capex of Rs. 45 crore' in x for x in rat['ps']) and any('Rs 120 crore' in x and '12-14%' in x for x in rat['ps']), rat['ps']
assert not any(re_w in ' '.join(rat['ps']).lower() for re_w in ('dear sir', 'compliance officer', 'exchange plaza', 'take the same on record',
                                                                 'safe harbour')), rat['ps']
assert len(rat['ps']) <= C.HL_MAX and all(len(x) <= C.HL_CHARS for x in rat['ps'])
assert C.highlights('', 'x') == [] and C.site_row(C.load_day('2026-11-28')['106'], syms)['ps'] == [], 'no text, no lines'
# a PDF that failed is tried again 6 hours later, 3 times in all; a scanned one never again
import time as _t
assert ('2026-11-28', '105') not in C.pdf_todo(syms, TODAY), 'failed just now'
assert ('2026-11-28', '105') in C.pdf_todo(syms, TODAY, now_s=_t.time() + 7 * 3600), '6 hours later'
assert ('2026-11-28', '106') not in C.pdf_todo(syms, TODAY, now_s=_t.time() + 7 * 3600), 'scanned = done'
C.read_pdf('2026-11-28', '105', reader, get=lambda u: (404, b''))
C.read_pdf('2026-11-28', '105', reader, get=lambda u: (404, b''))
assert C.load_day('2026-11-28')['105']['pdfTries'] == 3 and ('2026-11-28', '105') not in C.pdf_todo(syms, TODAY, now_s=_t.time() + 7 * 3600)
# the routine kinds are not downloaded; every other kind is
C.take([rec('202', 'ABC', 'Trading Window', 'Closure of trading window', '27-Nov-2026 09:00:00', PDF_URL.replace('order', 'tw')),
        rec('203', 'ABC', 'Copy of Newspaper Publication', 'Newspaper publication', '27-Nov-2026 09:05:00', PDF_URL.replace('order', 'np')),
        rec('204', 'ABC', 'Board Meeting Intimation', 'to consider and approve the financial results', '27-Nov-2026 09:10:00',
            PDF_URL.replace('order', 'bm'))])
td = [x[1] for x in C.pdf_todo(syms, TODAY)]
assert '204' in td and '202' not in td and '203' not in td, td
for rid in ('202', '203', '204'):
    C.save_day('2026-11-27', {rid: dict(C.load_day('2026-11-27')[rid], pdfSt='none', pdfTries=1)})
# pypdf missing: installed once, not again within a day
calls = []
real = C.importlib.import_module
C.importlib.import_module = lambda n: (_ for _ in ()).throw(ImportError('no')) if n == 'pypdf' else real(n)
try:
    st = C.load_state()
    assert C.pdf_reader(st, out=LOGS.append, install=lambda: (calls.append(1), (False, 'no pip'))[1]) is None
    assert C.pdf_reader(st, out=LOGS.append, install=lambda: (calls.append(1), (False, 'no pip'))[1]) is None
    assert calls == [1] and st['pip']['ok'] is False and any('InstallPdfReader.bat' in x for x in LOGS)
finally:
    C.importlib.import_module = real

# ------------------------------------------------------------------ 7. the website's questions (older days / a company)
rows = C.answer_rows('sym:XYZ', syms)
assert [r['at'][:10] for r in rows] == ['2026-11-26', '2026-11-22'] and all(r['sym'] == 'XYZ' for r in rows), rows
assert [r['id'] for r in C.answer_rows('day:2026-11-28', syms)] == ['106', '105', '101'], 'newest first, Main only'
assert C.answer_rows('sym:NOTMAIN', syms)[0]['co'] == 'Notmain Ltd', 'a company not in Main: NSE\'s name'
assert C.answer_rows('bad', syms) is None and C.answer_rows('day:x', syms) is None
SENT.clear()
ASKS[:] = [['sym:XYZ', 'day:2026-11-28']]
w = C.Worker(sleep=lambda s: None, clock=lambda: 1000.0)
st = C.load_state()
wait = w.once(CFG, api, lambda: False, st, None)
older = [b for b in SENT if b['op'] == 'older']
assert [b['key'] for b in older] == ['sym:XYZ', 'day:2026-11-28'] and len(C.unpack(older[0]['blob'])) == 2, SENT
assert older[0]['from'] == '2026-11-22' and older[0]['engine'] == C.ENGINE
assert w.next_ask == 1120.0 and 0 < wait <= 120, (w.next_ask, wait)
# the worker's PDF turn: one PDF, the day sent later together
C.take([rec('107', 'ABC', 'Press Release', 'Press Release', '28-Nov-2026 15:00:00', PDF_URL.replace('order', 'o2'))])
C.bind(get=lambda u: (200, PDF))
SENT.clear()
w2 = C.Worker(sleep=lambda s: None, clock=lambda: 5000.0)
w2.next_ask = 10 ** 9
st = C.load_state()
w2.once(CFG, api, lambda: False, st, reader)
assert C.load_day('2026-11-28')['107']['pdfSt'] == 'ok' and C.pdf_day_count(st) == 1
assert [d['day'] for b in SENT if b['op'] == 'put' for d in b['days']] == ['2026-11-28'], SENT
# never while the round asks NSE
C.take([rec('108', 'ABC', 'Press Release', 'Press Release', '28-Nov-2026 16:00:00', PDF_URL.replace('order', 'o3'))])
w3 = C.Worker(sleep=lambda s: None, clock=lambda: 9000.0)
w3.next_ask = 10 ** 9
w3.once(CFG, api, lambda: True, C.load_state(), reader)
assert not C.load_day('2026-11-28')['108'].get('pdfSt'), 'nse_busy: no PDF'

# an older web app: the thread says it once and starts again only after 30 minutes
T = [100.0]
w4 = C.Worker(sleep=lambda s: None, clock=lambda: T[0])
LOGS.clear()
st = C.load_state()
st.pop('syms', None)
C.save_state(st)
w4.loop(CFG, old, lambda: False)
w4.loop(CFG, old, lambda: False)
assert sum('UpdateNow.bat' in x for x in LOGS) == 1 and w4.next_start == 1900.0, (LOGS, w4.next_start)
assert w4.maybe_start(CFG, old) is False, 'not before 30 minutes'
C.main_stocks(CFG, api, st, force=True)
C.save_state(st)

# ------------------------------------------------------------------ 8. size of a busy day (1,800 stocks x 2 filings)
many = []
for i in range(1800):
    many.append(rec('9%05d' % i, 'S%04d' % i, 'Bagging/Receiving of orders/contracts', 'received an order worth Rs %d crore to be '
                    'executed within 12 months from a state government' % (i + 1), '25-Nov-2026 11:%02d:00' % (i % 60)))
    many.append(rec('8%05d' % i, 'S%04d' % i, 'Copy of Newspaper Publication', 'Newspaper publication of the financial results',
                    '25-Nov-2026 12:%02d:00' % (i % 60)))
C.take(many)
bigsyms = {'S%04d' % i: ['Stock %d' % i, 1000.0] for i in range(1800)}
rows = C.day_rows('2026-11-25', bigsyms)
blob = C.pack(rows)
assert len(rows) == 3600 and len(blob) < 40 * 45000, len(blob)

# ------------------------------------------------------------------ 9. the names the website shows = the JS lists
print(json.dumps({'events': {k: [v[0], v[1]] for k, v in C.EVENTS.items()}, 'filters': C.FILTERS, 'filterEvents': C.FILTER_EVENTS,
                  'cols': C.COLS, 'cats': C.CATS, 'blob': C.pack([after]), 'row': after}))
print('OK')
