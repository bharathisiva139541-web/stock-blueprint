# -*- coding: utf-8 -*-
"""Offline checks of the Analyst Targets (pcbridge/ScreenerBridge/analyst_recos.py; owner, 24-Nov-2026: JLHL - Prabhudas
Lilladher's Buy with a target of Rs 330, reached on 24-Nov; the brokers' recommendations of Moneycontrol / Business
Standard / DSIJ since 1-Oct-2026 and what the price did after them). The pages here are MADE in the shapes these websites
are known to use (a headline per item, the same words in the link, a table) - the real ones were not reachable when this
was written. Prints OK at the end."""
import importlib.util
import json
import os
import sys
import tempfile
from datetime import date, timedelta

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
HERE = os.path.join(ROOT, 'pcbridge', 'ScreenerBridge')
sys.path.insert(0, HERE)
TMP = tempfile.mkdtemp()
spec = importlib.util.spec_from_file_location('kite_intraday', os.path.join(HERE, 'kite_intraday.py'))
K = importlib.util.module_from_spec(spec)
spec.loader.exec_module(K)
L = K.backtest_lab
L.LAB_DIR = os.path.join(TMP, 'lab_cache')
import analyst_recos as A          # noqa: E402
A.STORE_PATH = os.path.join(TMP, 'analyst_recos.json')
A.STATE_PATH = os.path.join(TMP, 'analyst_recos_state.json')
A.CHECK_DIR = os.path.join(TMP, 'analyst_check')
LOGS = []
A.log = LOGS.append
TODAY = date(2026, 11, 24)

# ------------------------------------------------------------------ 1. a headline -> the recommendation
h = A.parse_reco('Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher')
assert h == {'call': 'BUY', 'co': 'Jupiter Life Line Hospitals', 'tgt': 330.0, 'br': 'Prabhudas Lilladher', 'known': True, 'how': 'head'}, h
for t, want in (
        ('Buy Jupiter Life Line Hospitals Ltd For Target Rs.1,720 - Prabhudas Liladhar Capital Ltd',
         ('BUY', 'Jupiter Life Line Hospitals Ltd', 1720.0, 'Prabhudas Lilladher')),
        ('Buy Jupiter Life Line Hospitals Ltd for target Rs 360 by Prabhudas Liladhar Capital Ltd',
         ('BUY', 'Jupiter Life Line Hospitals Ltd', 360.0, 'Prabhudas Lilladher')),
        ('Buy Jupiter Life Line Hospitals; target of Rs 340: Choice Institutional Equities',
         ('BUY', 'Jupiter Life Line Hospitals', 340.0, 'Choice')),
        ('Accumulate HDFC Bank; target of Rs 2,150: ICICI Securities', ('ACCUMULATE', 'HDFC Bank', 2150.0, 'ICICI Securities')),
        ('Neutral Asian Paints; target of Rs 2400: Motilal Oswal', ('NEUTRAL', 'Asian Paints', 2400.0, 'Motilal Oswal')),
        ('Sell Vodafone Idea; target of Rs 6.5: Kotak Institutional Equities', ('SELL', 'Vodafone Idea', 6.5, 'Kotak Securities')),
        ('Hindalco Industries: Buy, target Rs 900 - Motilal Oswal', ('BUY', 'Hindalco Industries', 900.0, 'Motilal Oswal')),
        ('Buy 360 ONE WAM; target price Rs 1,400: Nuvama', ('BUY', '360 ONE WAM', 1400.0, 'Nuvama')),
        ('Buy L&T, target Rs 4,200, says Jefferies', ('BUY', 'L&amp;T'.replace('&amp;', '&'), 4200.0, 'Jefferies')),
        ('Add Bharat Electronics with a target price of ₹450: Emkay Global Financial', ('ADD', 'Bharat Electronics', 450.0, 'Emkay Global')),
):
    r = A.parse_reco(t)
    assert r and (r['call'], r['co'], r['tgt'], r['br']) == want, (t, r)
for t in ('Sensex ends 300 points higher; Nifty at 24,000', 'Buy now, pay later: the target market is young',
          'Nifty target 26000 by December: analysts', 'Stocks to buy today'):
    assert A.parse_reco(t) is None, t
r = A.parse_reco('Buy Gujarat Hotels; target of Rs 400: Some New Brokers Pvt Ltd')
assert r['br'] == 'Some New Brokers' and r['known'] is False, r
assert A.broker_name('ubs')[0] == 'UBS' and A.broker_name('Pubs and more')[1] is False, 'a short name only as a word'
# the same words in a link's address
s = A.parse_slug('https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html')
assert s and (s['call'], s['co'], s['tgt'], s['br'], s['how']) == ('BUY', 'Jupiter Life Line Hospitals', 330.0, 'Prabhudas Lilladher', 'link'), s
assert A.parse_slug('https://www.moneycontrol.com/news/business/markets/sensex-ends-higher-13654322.html') is None
# dates
for t, want in (('November 24, 2026 06:41 PM IST', '2026-11-24 18:41'), ('Oct 27, 2026', '2026-10-27'),
                ('27 Oct 2026 | 10:05 AM', '2026-10-27 10:05'), ('2026-10-27T16:30:00+05:30', '2026-10-27 16:30'),
                ('04/08/2026', '2026-08-04'), ('Updated on 3rd November 2026', '2026-11-03'), ('no date here', '')):
    assert A.find_date(t) == want, (t, A.find_date(t))

# ------------------------------------------------------------------ 2. the pages
MC = '''<html><body><ul id="cagetory">
<li class="clearfix" id="newslist-0"><a href="https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html" title="Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher"><img src="x.jpg"></a>
<span>October 27, 2026 09:15 AM IST</span>
<h2><a href="https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-330-prabhudas-lilladher-13654321.html" title="Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher">Buy Jupiter Life Line Hospitals; target of Rs 330: Prabhudas Lilladher</a></h2>
<p>Prabhudas Lilladher is bullish on Jupiter Life Line Hospitals has recommended buy rating on the stock with a target price of Rs 330 in its research report dated October 23, 2026.</p></li>
<li class="clearfix" id="newslist-1"><span>October 27, 2026 09:05 AM IST</span>
<h2><a href="/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-340-choice-institutional-equities-13654300.html">Buy Jupiter Life Line Hospitals; target of Rs 340: Choice Institutional Equities</a></h2></li>
<li class="clearfix" id="newslist-2"><span>October 26, 2026 08:00 PM IST</span>
<h2><a href="/news/business/markets/sensex-ends-higher-13654200.html">Sensex ends 300 points higher; Nifty at 24,000</a></h2></li>
<li class="clearfix" id="newslist-3"><span>September 29, 2026 10:00 AM IST</span>
<h2><a href="/news/business/stocks/neutral-asian-paints-target-of-rs-2400-motilal-oswal-13600000.html">Neutral Asian Paints; target of Rs 2400: Motilal Oswal</a></h2></li>
</ul></body></html>'''
got = A.page_recos(MC, 'https://www.moneycontrol.com/news/business/stocks/')
assert [(g['call'], g['co'], g['tgt'], g['br'], g['at']) for g in got] == [
    ('BUY', 'Jupiter Life Line Hospitals', 330.0, 'Prabhudas Lilladher', '2026-10-27 09:15'),
    ('BUY', 'Jupiter Life Line Hospitals', 340.0, 'Choice', '2026-10-27 09:05'),
    ('NEUTRAL', 'Asian Paints', 2400.0, 'Motilal Oswal', '2026-09-29 10:00')], got
assert got[1]['url'] == 'https://www.moneycontrol.com/news/business/stocks/buy-jupiter-life-line-hospitals-target-of-rs-340-choice-institutional-equities-13654300.html'
# a link with an image only: the words in its address
SLUG_ONLY = '<div><a href="/news/business/stocks/sell-vodafone-idea-target-of-rs-6-5-kotak-institutional-equities-13654400.html"><img></a> Nov 20, 2026</div>'
g = A.page_recos(SLUG_ONLY, 'https://www.moneycontrol.com/')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['at']) for x in g] == [('SELL', 'Vodafone Idea', 6.5, 'Kotak Securities', '2026-11-20')], g
# the page's own data (JSON in a script) - e.g. a Next.js page
NEXT = ('<script id="__NEXT_DATA__" type="application/json">{"props":{"items":[{"headline":"Buy Hindalco Industries; target of Rs 900: '
        'Motilal Oswal","url":"https:\\/\\/www.business-standard.com\\/markets\\/research-report\\/buy-hindalco-123.html","publishDate":'
        '"2026-11-21T08:10:00+05:30"},{"headline":"Markets open flat","url":"\\/x"}]}}</script>')
g = A.page_recos(NEXT, 'https://www.business-standard.com/markets/research-report')
assert [(x['co'], x['tgt'], x['br'], x['at'], x['url']) for x in g] == [
    ('Hindalco Industries', 900.0, 'Motilal Oswal', '2026-11-21 08:10', 'https://www.business-standard.com/markets/research-report/buy-hindalco-123.html')], g
# a table (DSIJ-like)
TABLE = '''<table class="broker"><tr><th>Date</th><th>Company Name</th><th>Broker</th><th>Recommendation</th><th>Reco Price</th><th>Target Price</th></tr>
<tr><td>04 Aug 2026</td><td><a href="/markets/reports/report-details/jupiter-life-line-hospitals-ltd/44952">Jupiter Life Line Hospitals Ltd</a></td><td>Prabhudas Lilladher</td><td>Buy</td><td>319.00</td><td>360.00</td></tr>
<tr><td>05 Nov 2026</td><td>Bharat Electronics Ltd</td><td>Emkay Global</td><td>Add</td><td>410</td><td>450</td></tr>
<tr><td>05 Nov 2026</td><td>Something</td><td>X</td><td>-</td><td>1</td><td>abc</td></tr></table>'''
g = A.page_recos(TABLE, 'https://insights.dsij.in/markets/reports/broker-reports/stock-tips')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['rp'], x['at'], x['how']) for x in g] == [
    ('BUY', 'Jupiter Life Line Hospitals Ltd', 360.0, 'Prabhudas Lilladher', 319.0, '2026-08-04', 'table'),
    ('ADD', 'Bharat Electronics Ltd', 450.0, 'Emkay Global', 410.0, '2026-11-05', 'table')], g
assert g[0]['url'] == 'https://insights.dsij.in/markets/reports/report-details/jupiter-life-line-hospitals-ltd/44952'

# the page's own data with the fields named (Moneycontrol's stock ideas kind of page: no headline, a record per call)
IDEAS = ('<html><script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'data': {'list': [
    {'stockName': 'Jupiter Life Line Hospitals', 'nseSymbol': 'JLHL', 'brokerName': 'Prabhudas Lilladher', 'recoType': 'BUY',
     'targetPrice': '330.00', 'recoPrice': 290.5, 'recoDate': '2026-10-27 09:15:00', 'reportUrl': '/research/jlhl-123.pdf'},
    {'stock': {'name': 'Bharat Electronics Ltd'}, 'organization': {'name': 'Emkay Global Financial Services'}, 'rating': 'Accumulate',
     'target': 450, 'cmp': 410, 'publishedAt': '2026-11-05T10:00:00+05:30'},
    {'companyName': 'Tata Motors', 'broker': 'Nomura', 'targetPrice': 800, 'price': 700},          # no call word: target above = Buy
    {'companyName': 'Coal India', 'broker': 'CLSA', 'targetPrice': 300, 'price': 400},             # no call, target below: not a call
    {'companyName': 'No Target Ltd', 'broker': 'CLSA', 'recommendation': 'Buy', 'targetPrice': None},
    {'companyName': 'No Broker Ltd', 'recommendation': 'Buy', 'targetPrice': 100},
    {'name': 'Some page', 'type': 'WebPage', 'target': 5}]}}}}) + '</script><body><p>Stock ideas</p></body></html>')
g = A.page_recos(IDEAS, 'https://www.moneycontrol.com/markets/stock-ideas/')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['rp'], x['at'], x['how'], x.get('nse', '')) for x in g] == [
    ('BUY', 'Jupiter Life Line Hospitals', 330.0, 'Prabhudas Lilladher', 290.5, '2026-10-27 09:15', 'data', 'JLHL'),
    ('ACCUMULATE', 'Bharat Electronics Ltd', 450.0, 'Emkay Global', 410.0, '2026-11-05 10:00', 'data', ''),
    ('BUY', 'Tata Motors', 800.0, 'Nomura', 700.0, '', 'data', '')], g
assert g[0]['url'] == 'https://www.moneycontrol.com/research/jlhl-123.pdf'
# rows without a <table> (the owner's DSIJ check: 'Stock Broker / Analyst Action (Reco Date) CMP (Returns) Reco Price Target Price
# Potential % Original PDF Research Insights' then 'Anthem Biosciences Ltd. Prabhudas Lillad...')
DIVS = ('<div class="hdr"><span>Stock</span><span>Broker / Analyst</span><span>Action (Reco Date)</span><span>CMP (Returns)</span>'
        '<span>Reco Price</span><span>Target Price</span><span>Potential %</span><span>Original PDF</span><span>Research Insights</span></div>'
        '<div class="row"><a href="/s/anthem">Anthem Biosciences Ltd.</a><span>Prabhudas Lilladher</span><span>Buy (24 Nov 2026)</span>'
        '<span>980.15 (0.5%)</span><span>975.50</span><span>1,050.00</span><span>7.6%</span><a>PDF</a><a>Insights</a></div>'
        '<div class="row"><a>Hindalco Industries Ltd.</a><span>Motilal Oswal Financial Services</span><span>Accumulate (20 Nov 2026)</span>'
        '<span>702.00 (-1.2%)</span><span>710.00</span><span>800.00</span><span>12.7%</span><a>PDF</a><a>Insights</a></div>'
        '<div class="row"><a>Coal India Ltd.</a><span>Axis Direct</span><span>Sell (18 Nov 2026)</span>'
        '<span>390 (2%)</span><span>382</span><span>350</span><span>-10.3%</span><a>PDF</a><a>Insights</a></div>'
        '<div class="row"><a>State Bank of India</a><span>ICICI Securities</span><span>Buy (17 Nov 2026)</span>'
        '<span>810 (1%)</span><span>800</span><span>950</span><span>17.3%</span><a>PDF</a><a>Insights</a></div>')
g = A.page_recos(DIVS, 'https://insights.dsij.in/markets/reports/broker-reports/stock-tips')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['rp'], x['at'], x['how']) for x in g] == [
    ('BUY', 'Anthem Biosciences Ltd.', 1050.0, 'Prabhudas Lilladher', 975.5, '2026-11-24', 'text'),
    ('ACCUMULATE', 'Hindalco Industries Ltd.', 800.0, 'Motilal Oswal', 710.0, '2026-11-20', 'text'),
    ('SELL', 'Coal India Ltd.', 350.0, 'Axis Securities', 382.0, '2026-11-18', 'text'),
    ('BUY', 'State Bank of India', 950.0, 'ICICI Securities', 800.0, '2026-11-17', 'text')], g
# DSIJ as the owner's AnalystCheck printed it (24-Nov-2026): a react-data-table - <div role="row"> / role="columnheader" /
# role="cell", the call and its date in one cell ('BUY<br/>23 Nov 2026'), CMP (returns) BEFORE the reco price
def rdt_cell(inner, head=False):
    return ('<div role="columnheader" tabindex="0" class="sc-jXuTBK rdt_TableCol_Sortable"><div class="sc-cXrvCr">%s</div></div>' % inner
            if head else '<div id="cell-1-undefined" role="cell" class="sc-glJfXD rdt_TableCell">%s</div>' % inner)


RDT = ('<div class="rdt_Table" role="table"><div class="rdt_TableHead" role="rowgroup"><div class="rdt_TableHeadRow" role="row">'
       + ''.join(rdt_cell(h, True) for h in ('Stock', 'Broker / Analyst', 'Action (Reco Date)', 'CMP (Returns)', 'Reco Price',
                                            'Target Price', 'Potential %', '<span class="text-end"> Original PDF</span>', 'Research Insights'))
       + '</div></div><div class="rdt_TableBody" role="rowgroup">'
       + '<div id="row-0" role="row" class="rdt_TableRow">' + ''.join(rdt_cell(c) for c in (
           '<a class="text-info" href="/share-price/chalet-hotels-ltd-207959">Chalet Hotels Ltd.</a>',
           '<a class="text-info" href="/markets/reports/market-reports/stock-tips/broker-detail?brokerid=14">Prabhudas Lilladher</a>',
           '<div><span class="fw-bold text-success">BUY</span><br/><span class="small">23 Nov 2026</span></div>',
           '<div class="text-end">868.75<br/><span class="small text-success">(5.05%)</span></div>',
           '<div class="text-end">827.00</div>', '<div class="text-end">1,055.00</div>', '<div>21.4%</div>',
           '<a href="https://insights.dsij.in/broker-reports/pdf/chalet-23112026.pdf">PDF</a>', '<a href="/insights/1">Insights</a>'))
       + '</div><div id="row-1" role="row" class="rdt_TableRow">' + ''.join(rdt_cell(c) for c in (
           '<a href="/share-price/rail-vikas-nigam-ltd-1">Rail Vikas Nigam Ltd.</a>', '<a href="/b?brokerid=14">Prabhudas Lilladher</a>',
           '<div><span class="fw-bold text-danger">SELL</span><br/><span class="small">18 Nov 2026</span></div>',
           '<div class="text-end">301.10<br/><span class="small">(-1.2%)</span></div>', '<div class="text-end">305.00</div>',
           '<div class="text-end">153.00</div>', '<div>-49.2%</div>', '', ''))
       + '</div></div></div><nav class="rdt_Pagination">Rows per page 10 1-2 of 2</nav>')
g = A.page_recos('<html><body><p>Go Stock Broker</p>' + RDT + '</body></html>', 'https://insights.dsij.in/markets/reports/broker-reports/stock-tips')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['rp'], x['at'], x['how']) for x in g] == [
    ('BUY', 'Chalet Hotels Ltd.', 1055.0, 'Prabhudas Lilladher', 827.0, '2026-11-23', 'grid'),
    ('SELL', 'Rail Vikas Nigam Ltd.', 153.0, 'Prabhudas Lilladher', 305.0, '2026-11-18', 'grid')], g
assert g[0]['url'] == 'https://insights.dsij.in/broker-reports/pdf/chalet-23112026.pdf', g
assert g[1]['url'] == 'https://insights.dsij.in/share-price/rail-vikas-nigam-ltd-1', g
# a <table> with CMP before the reco price: the price at the call is the reco price
CMPT = ('<table><tr><th>Company</th><th>Broker</th><th>Reco</th><th>CMP</th><th>Reco Price</th><th>Target</th></tr>'
        '<tr><td>Tata Steel</td><td>Emkay</td><td>Buy</td><td>190</td><td>182</td><td>210</td></tr></table>')
g = A.page_recos(CMPT, 'https://www.business-standard.com/')
assert [(x['co'], x['rp'], x['tgt'], x['br']) for x in g] == [('Tata Steel', 182.0, 210.0, 'Emkay Global')], g
# the same rows as plain text without brackets around the date (no table markup at all)
g = A.text_rows('Chalet Hotels Ltd. Prabhudas Lilladher BUY 23 Nov 2026 868.75 (5.05%) 827.00 1,055.00 21.4% PDF Insights')
assert [(x['call'], x['co'], x['tgt'], x['rp'], x['at']) for x in g] == [('BUY', 'Chalet Hotels Ltd.', 1055.0, 827.0, '2026-11-23')], g
# Moneycontrol's stock ideas page (owner's AnalystCheck 24-Nov-2026: __NEXT_DATA__ pageProps.data {loader, page, stocks, tags,
# researchers, ...}) - the field names of its records are not seen yet: the usual ones and other spellings both read
MCI = ('<script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'isApp': False, 'data': {
    'loader': False, 'page': 1, 'researchers': [{'name': 'A C Choksi'}], 'stocks': [
        {'stkname': 'Anthem Biosciences', 'organization': 'Prabhudas Lilladher', 'recommend_flag': 'Buy', 'recommend_price': '975.50',
         'target_price': '1050', 'recommend_date': '2026-11-24 13:52:00', 'cmp': 980.1, 'potential_returns': '7.6'},
        {'scId': 'TS', 'stockShortName': 'Tata Steel', 'brokerHouse': 'Emkay Global', 'recoTypeName': 'BUY', 'tgtPx': 210,
         'recoDate': '22 Nov 2026', 'entryPx': 182}]}}}}) + '</script>')
g = A.page_recos(MCI, 'https://www.moneycontrol.com/markets/stock-ideas/')
assert [(x['call'], x['co'], x['tgt'], x['br'], x['rp'], x['at'][:10]) for x in g] == [
    ('BUY', 'Anthem Biosciences', 1050.0, 'Prabhudas Lilladher', 975.5, '2026-11-24'),
    ('BUY', 'Tata Steel', 210.0, 'Emkay Global', 182.0, '2026-11-22')], g
OUT = []
A.check(OUT.append, fetch=lambda u: (200, MCI.replace('target_price', 'aim').replace('tgtPx', 'aim2'), u), names=None, save=False)
assert 'data {loader, page, researchers (list of 1, first: {"name": "A C Choksi"}), stocks (list of 2, first: {"stkname": "Anthem' in '\n'.join(OUT), OUT[:8]
# a broker the list does not know, after 'Ltd.'
g = A.text_rows('Anthem Biosciences Ltd. Some New Broking Buy (24 Nov 2026) 980 (0.5%) 975 1,050 7.6%')
assert [(x['co'], x['br'], x['known']) for x in g] == [('Anthem Biosciences Ltd.', 'Some New', False)], g

# ------------------------------------------------------------------ 3. names -> Main's symbols
N = A.Names({'JLHL': 'Jupiter Life Line Hospitals Ltd.', 'HINDALCO': 'Hindalco Industries Limited', 'BEL': 'Bharat Electronics Ltd',
             'LT': 'Larsen & Toubro Limited', 'ASIANPAINT': 'Asian Paints Limited', 'TATAMOTORS': 'Tata Motors Limited',
             'TMPV': 'Tata Motors Passenger Vehicles Ltd', 'HDFCBANK': 'HDFC Bank Limited', 'HDFCLIFE': 'HDFC Life Insurance Company Limited',
             '360ONE': '360 ONE WAM Ltd', 'COALINDIA': 'Coal India Ltd', 'IDEA': 'Vodafone Idea Limited'})
for co, want in (('Jupiter Life Line Hospitals', 'JLHL'), ('Jupiter Life Line Hospitals Ltd', 'JLHL'), ('JLHL', 'JLHL'),
                 ('Hindalco Industries', 'HINDALCO'), ('Hindalco', 'HINDALCO'), ('L&T', 'LT'), ('Larsen and Toubro', 'LT'),
                 ('Tata Motors', 'TATAMOTORS'), ('HDFC Bank', 'HDFCBANK'), ('HDFC', ''), ('360 ONE WAM', '360ONE'),
                 ('Coal India', 'COALINDIA'), ('Vodafone Idea', 'IDEA'), ('Some Unknown Co', ''), ('Jupiter Life Line Hosp', 'JLHL')):
    assert N.match(co) == want, (co, N.match(co))

# ------------------------------------------------------------------ 4. the store: one recommendation even when two websites carry it
store = A.load_store()
it1 = dict(got[0])
it2 = {'call': 'BUY', 'co': 'Jupiter Life Line Hospitals Ltd', 'tgt': 330.0, 'br': 'Prabhudas Lilladher', 'known': True, 'how': 'table',
       'at': '2026-10-26', 'url': 'https://insights.dsij.in/x', 'rp': 316.0}
assert A.merge(store, [it1, dict(got[1])], 'mc', TODAY) == 2
assert A.merge(store, [it2], 'dsij', TODAY) == 0, 'the same call, a day apart on another website'
r = [x for x in store['recos'].values() if x['tgt'] == 330.0][0]
assert r['src'] == 'mc,dsij' and r['at'] == '2026-10-26' and r['rp'] == 316.0, r
assert A.merge(store, [dict(it2, at='2026-11-20')], 'dsij', TODAY) == 1, 'the same target a month later = a new call'
assert A.merge(store, [{'call': 'BUY', 'co': 'Bharat Electronics', 'tgt': 450.0, 'br': 'Emkay Global', 'known': True, 'at': ''}], 'bs', TODAY) == 1
assert [x for x in store['recos'].values() if x['co'] == 'Bharat Electronics'][0]['at'] == TODAY.isoformat(), 'no date: the day it was seen'

# ------------------------------------------------------------------ 5. reading the lists: pages, the old-day stop, failures
PAGES = {}
for n in range(1, 8):
    day = TODAY - timedelta(days=12 * (n - 1))
    PAGES['https://www.moneycontrol.com/news/tags/recommendations.html' + ('' if n == 1 else '/page-%d/' % n)] = (
        '<li><span>%s</span><h2><a href="/news/business/stocks/buy-x%d">Buy Hindalco Industries; target of Rs %d: Motilal Oswal</a></h2></li>'
        % (day.strftime('%B %d, %Y'), n, 900 + n))
ASKED = []


def fake_fetch(url):
    ASKED.append(url)
    if url in PAGES:
        return 200, PAGES[url], url
    if 'business-standard' in url:
        return 403, '', url
    if 'dsij' in url:
        return 200, TABLE, url
    return 200, '<html>nothing here</html>', url


items, read, why = A.read_list(None, 'https://www.moneycontrol.com/news/tags/recommendations.html',
                               'https://www.moneycontrol.com/news/tags/recommendations.html/page-{n}/', 2, A.FROM_DAY, fake_fetch,
                               lambda s: None, 0)
assert read == 2 and [i['tgt'] for i in items] == [901.0, 902.0] and why == '', (read, items, why)
ASKED.clear()
items, read, why = A.read_list(None, 'https://www.moneycontrol.com/news/tags/recommendations.html',
                               'https://www.moneycontrol.com/news/tags/recommendations.html/page-{n}/', 300, A.FROM_DAY, fake_fetch,
                               lambda s: None, 0, until_old=True)
assert read == 6 and len(items) == 6, (read, len(items))     # page 6 = 25-Sep-2026, before 1-Oct: the last one read
assert not any(u.endswith('/page-7/') for u in ASKED), 'page 7 never asked'
# a website without page n answers with page 1 again: read twice, then it stops (AnalystNow asks up to 300 pages)
ASKED.clear()
items, read, why = A.read_list(None, 'https://insights.dsij.in/a', 'https://insights.dsij.in/a?page={n}', 300, A.FROM_DAY,
                               lambda u: (ASKED.append(u), (200, DIVS, u))[1], lambda s: None, 0, until_old=True)
assert read == 2 and len(items) == 4 and len(ASKED) == 2, (read, len(items), ASKED)
# one page reaching from November back to September: nothing older asked
OLD = DIVS.replace('Buy (17 Nov 2026)', 'Buy (17 Sep 2026)')
ASKED.clear()
items, read, why = A.read_list(None, 'https://insights.dsij.in/a', 'https://insights.dsij.in/a?page={n}', 300, A.FROM_DAY,
                               lambda u: (ASKED.append(u), (200, OLD, u))[1], lambda s: None, 0, until_old=True)
assert read == 1 and ASKED == ['https://insights.dsij.in/a'], ASKED
items, read, why = A.read_list(None, 'https://www.business-standard.com/markets/research-report', 'x{n}', 2, A.FROM_DAY, fake_fetch,
                               lambda s: None, 0)
assert items == [] and why == 'HTTP 403', why
store = A.load_store()
res = A.collect(store, TODAY, False, fake_fetch, lambda s: None, 0, LOGS.append)
assert res['mc'][1] == 2 and res['bs'] == [0, 0, 'research reports: HTTP 403'], res
assert res['dsij'][0] == 1, 'the 4-Aug-2026 row is before 1-Oct-2026: not kept; the 5-Nov one kept'
assert store['lists']['bs|research reports']['why'] == 'HTTP 403'

# ------------------------------------------------------------------ 6. what the price did (a made Kite daily cache)
def sessions(start, end):
    out, d = [], start
    while d <= end:
        if d.weekday() < 5:
            out.append(d.toordinal())
        d += timedelta(days=1)
    return out


ALL = sessions(date(2026, 1, 1), date(2026, 11, 20))
k27 = ALL.index(date(2026, 10, 27).toordinal())
jl = [280.0] * k27 + [300.0 + 31.0 * k / (len(ALL) - 1 - k27) for k in range(len(ALL) - k27)]       # rises to 331 at the end
cand = lambda days, cl: [{'t': date.fromordinal(d).isoformat(), 'day': date.fromordinal(d).isoformat(), 'o': c, 'h': c + 0.5,
                          'l': c - 0.5, 'c': c, 'v': 1} for d, c in zip(days, cl)]
w = L.CacheWriter(date(2026, 11, 20))
w.add('JLHL', 'D', cand(ALL, jl), [])
w.add('BEL', 'D', cand(ALL, [400.0] * len(ALL)), [])
w.indices = {'NIFTY_50': [[x, 25000.0 + k] for k, x in enumerate(ALL)]}
w.close()
store = A.load_store()
A.merge(store, [it1, dict(got[1]), {'call': 'ADD', 'co': 'Bharat Electronics Ltd', 'tgt': 450.0, 'br': 'Emkay Global', 'known': True,
                                     'at': '2026-11-05'},
                {'call': 'BUY', 'co': 'Some Unknown Co', 'tgt': 100.0, 'br': 'Ventura', 'known': True, 'at': '2026-11-01'},
                {'call': 'BUY', 'co': 'Jupiter Life Line Hospitals', 'tgt': 380.0, 'br': 'Motilal Oswal', 'known': True,
                 'at': '2026-11-21 18:00'}], 'mc', TODAY)
upto, rows = A.outcomes(store, N, L, TODAY)
assert upto == '2026-11-20' and len(rows) == 5, (upto, len(rows))
by = {(r['br'], r['tgt']): r for r in rows}
pl = by[('Prabhudas Lilladher', 330.0)]
assert pl['sym'] == 'JLHL' and pl['st'] == 'ok' and pl['ed'] == '2026-10-27' and pl['ep'] == 300.0, pl      # 09:15 = that day's close
assert pl['kp'][-1] is not None and pl['kd'][-1] <= '2026-11-20', pl['kp']          # 330 reached near the end (high = close + 0.5)
assert len(pl['kp']) == 6 and len(pl['pg']) == 5 and 'wq' not in pl, pl.keys()
ch = by[('Choice', 340.0)]['kp']
assert ch[2] is not None and ch[3] is None and ch[-1] is None, ('high 331.5 from 300: 70 % of the way to 340 yes, 80 % no', ch)
assert by[('Emkay Global', 450.0)]['ed'] == '2026-11-05' and by[('Emkay Global', 450.0)]['kp'] == [None] * 6
assert by[('Ventura', 100.0)]['why'] == 'nosym' and by[('Ventura', 100.0)]['st'] == 'x'
assert by[('Motilal Oswal', 380.0)]['why'] == 'wait', 'filed on 21-Nov after the close, candles up to 20-Nov'
assert [r['at'] for r in rows] == sorted((r['at'] for r in rows), reverse=True), 'newest first'
s = A.summary(rows)
assert s['recos'] == 5 and s['ok'] == 3 and s['brokers'] == 5 and s['stocks'] == 2 and s['why'] == {'nosym': 1, 'wait': 1}, s
assert A.unpack(A.pack(rows)) == [{k: r.get(k) for k in A.COLS} for r in rows], 'the packed rows come back the same'
lines = A.words(rows, 'JLHL')
assert any('Prabhudas Lilladher BUY, target 330' in x and 'entry 2026-10-27 close 300.00' in x and 'reached after' in x for x in lines), lines

# ------------------------------------------------------------------ 7. the round's step: names from the sheet, posts once
os.path.exists(A.STORE_PATH) and os.remove(A.STORE_PATH)
CALLS = []
REPLY = {'put': {'ok': True}}


def api(cfg, action, payload=None, tries=3, timeout=120):
    CALLS.append((action, json.loads(json.dumps(payload))))
    if payload.get('op') == 'names':
        return REPLY.get('names', {'ok': True, 'names': {'JLHL': 'Jupiter Life Line Hospitals Ltd', 'BEL': 'Bharat Electronics Ltd',
                                                         'HINDALCO': 'Hindalco Industries Ltd'}})
    return dict(REPLY['put'])


cfg = {'url': 'x', 'token': 'y'}
PAGES['https://www.moneycontrol.com/news/tags/recommendations.html'] = MC
n = A.step(cfg, api, L, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0)
puts = [p for a, p in CALLS if p.get('op') == 'put']
assert n and len(puts) == 1 and puts[0]['engine'] == A.ENGINE == 1, (n, CALLS, LOGS[-3:])
sent = A.unpack(puts[0]['blob'])
assert {r['sym'] for r in sent} >= {'JLHL', 'BEL'} and puts[0]['upto'] == '2026-11-20', {r['sym'] for r in sent}
assert any('Analyst targets (prices up to 2026-11-20)' in x and 'sent to the sheet' in x for x in LOGS), LOGS[-3:]
CALLS.clear()
assert A.step(cfg, api, L, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0) == 0 and not [c for c in CALLS if c[1].get('op') == 'put'], \
    'nothing new: no post'
assert not [c for c in CALLS if c[1].get('op') == 'names'], 'the names are asked once a day'
assert A.step(cfg, api, L, TODAY, force=True, fetch=fake_fetch, sleep=lambda s: None, gap=0) == n
os.remove(A.STATE_PATH)
REPLY = {'put': {'ok': True}, 'names': {'ok': False, 'error': 'unknown action'}}
LOGS.clear()
assert A.step(cfg, api, L, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0) is None
assert any('UpdateNow.bat' in x for x in LOGS), LOGS
REPLY = {'put': {'ok': False, 'error': 'unknown action'}}
os.remove(A.STATE_PATH)
LOGS.clear()
assert A.step(cfg, api, L, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0) is None and any('UpdateNow.bat' in x for x in LOGS)
assert not A._load(A.STATE_PATH, {}).get('sent'), 'not marked sent'
assert A.step(dict(cfg, analyst_targets=False), api, L, TODAY) is None, 'config analyst_targets false = off'
# every website silent -> the hint to run AnalystCheck
LOGS.clear()
REPLY = {'put': {'ok': True}}
A.step(cfg, api, L, TODAY, fetch=lambda u: (200, '<html></html>', u), sleep=lambda s: None, gap=0)
assert any('AnalystCheck.bat' in x for x in LOGS), LOGS
# a step that breaks never stops the round
assert A.step(cfg, api, None, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0) is None and 'Analyst targets:' in LOGS[-1]

# no Kite daily candles: nothing read from the websites, nothing sent
keep_dir, L.LAB_DIR = L.LAB_DIR, os.path.join(TMP, 'no_cache')
ASKED.clear()
LOGS.clear()
assert A.step(cfg, api, L, TODAY, fetch=fake_fetch, sleep=lambda s: None, gap=0) is None and not ASKED and 'no Kite daily candles' in LOGS[-1], LOGS
L.LAB_DIR = keep_dir

# ------------------------------------------------------------------ 8. AnalystCheck
OUT = []
total = A.check(OUT.append, fetch=fake_fetch, names={'JLHL': 'Jupiter Life Line Hospitals Ltd'}, save=True)
text = '\n'.join(OUT)
assert total >= 3 and 'Moneycontrol - recommendations' in text and 'HTTP 403' in text, text
assert '6 of them from 2026-10-01 on' not in text and 'of them from 2026-10-01 on' in text, text
assert '| BUY Jupiter Life Line Hospitals | target 330 | Prabhudas Lilladher | -> JLHL' in text, text
assert 'lines with "target": none' in text, 'an empty page says what it had'
assert os.path.exists(os.path.join(A.CHECK_DIR, 'mc_recommendations.html'))
assert not any('broker-research' in u for _, _, ls in A.SOURCES for _, u, _ in ls), 'the tag moved to the news home page (owner, 24-Nov)'
# a page with nothing found: what its data looks like, the data addresses in it, the rows after 'Target Price'
SHAPE = ('<html><script id="__NEXT_DATA__" type="application/json">' + json.dumps({'props': {'pageProps': {'ideaData': {'rows': [
    {'scId': 'JLH', 'tgtPrice': 330, 'entryPx': 290, 'house': 'PL'}]}, 'api': 'https://api.moneycontrol.com/mcapi/v1/stock-idea/list?page=1'}}})
    + '</script><body><div class="t"><span>Target Price</span><span style="x">330</span></div></body></html>')
OUT = []
A.check(OUT.append, fetch=lambda u: (200, SHAPE, u), names=None, save=False)
text = '\n'.join(OUT)
assert "page data with target-like names: .props.pageProps.ideaData.rows[0] = {\"scId\": \"JLH\", \"tgtPrice\": \"330\"" in text, text
assert '__NEXT_DATA__ pageProps: ideaData {rows (list of 1, first: {"scId": "JLH", "tgtPrice": "330"' in text, text
assert 'data addresses in the page: https://api.moneycontrol.com/mcapi/v1/stock-idea/list?page=1' in text, text
assert 'the page after "Target Price" (tags kept, shortened): Target Price</span><span>330</span>' in text, text
# a page whose Next.js data cannot be read, a table of something else, streamed data, an address written with \/
ODD = ('<script id="__NEXT_DATA__" type="application/json">{"props": broken</script>'
       '<table><tr><th>Index</th><th>Value</th></tr><tr><td>NIFTY</td><td>24000</td></tr></table>'
       '<script>self.__next_f.push([1,"{\\"targetPrice\\":330,\\"brokerName\\":\\"PL\\"}"])</script>'
       r'<script>var u="https:\/\/api.moneycontrol.com\/mcapi\/v1\/stock-idea\/list";</script>')
OUT = []
A.check(OUT.append, fetch=lambda u: (200, ODD, u), names=None, save=False)
text = '\n'.join(OUT)
assert '__NEXT_DATA__ could not be read (Expecting value' in text, text
assert 'a table: 1 row(s); headings: index | value; first row: NIFTY | 24000' in text, text
assert 'Next.js streamed data: 1 part(s); near target-like names: ' in text and 'targetPrice' in text, text
assert 'data addresses in the page: https://api.moneycontrol.com/mcapi/v1/stock-idea/list' in text, text

# ------------------------------------------------------------------ 9. screener_bridge: the round calls it, the commands exist
src = open(os.path.join(HERE, 'screener_bridge.py'), encoding='utf-8').read()
assert src.count('recos_step(cfg)') >= 2 and "cmd == 'analysts'" in src and "cmd == 'analystcheck'" in src and 'import analyst_recos as AR' in src
for bat, cmd in (('AnalystNow.bat', 'analysts'), ('AnalystCheck.bat', 'analystcheck')):
    raw = open(os.path.join(HERE, bat), 'rb').read()
    assert b'\r\n' in raw and ('screener_bridge.py %s' % cmd).encode() in raw, bat
print('OK')
