"""tools/export_xlsx.py ipo_tracker() gives the same JSON as Code.gs ab_site_ipoTracker_ for the
fixture tab used in tests/codegs-site-feed.test.js. Run by tests/export-ipo-tracker.test.js."""
import datetime as dt
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('export_xlsx', os.path.join(ROOT, 'tools', 'export_xlsx.py'))
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)

HDR = ['Company', 'Symbol', 'Opens', 'Closes', 'Listing date', 'Price range', 'Issue size (shares)', 'Note']
LHDR = ['Company', 'Symbol', 'Closes', 'Listing date', 'Issue price', 'Listing price', 'Listing gain %', 'Last close', 'Since issue %', 'Note']
rows = ex.Rows([
    ['IPO Tracker - mainboard equity IPOs on NSE (SME and debt issues left out)'],
    ['Updated 2026-10-21 19:28 IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.'],
    [None],
    ['Open now (1)'],
    HDR,
    ['BLS Polymers Limited', 'BLSPOLY', dt.datetime(2026, 10, 20), dt.datetime(2026, 10, 22), None, '₹142 to ₹150', 11900000, 'Closes tomorrow'],
    [None],
    ['Closed - awaiting listing (0)'],
    HDR,
    ['None', None, None, None, None, None, None, None],
    [None],
    ['Upcoming (1)'],
    HDR,
    ['M. K. Sons Fine Jewels Limited', 'MKSONS', dt.datetime(2026, 10, 28), dt.datetime(2026, 10, 30), None, '₹153 to ₹162', 17000000, 'Opens in 7 days'],
    [None],
    ['Listed recently (1)'],
    LHDR,
    ['Jio Platforms Limited', 'JPL', dt.datetime(2026, 10, 23), dt.datetime(2026, 10, 28), 1119, 1150, 0.0277, 1231, 0.1001, 'Listed on 28-Oct; last close on 30-Oct'],
])
rows.fmt = [['General'] * 10 for _ in rows]
rows.fmt[-1] = ['General', 'General', 'dd/mm/yyyy', 'dd/mm/yyyy', '#,##0.00', '#,##0.00', '0.0%', '#,##0.00', '0.0%', 'General']
got = ex.ipo_tracker(rows)
want = {
    'note': 'Updated 2026-10-21 19:28 IST from NSE, read by your PC. Unofficial summary - check the offer document before applying.',
    'warning': '',
    'open': {'cols': HDR, 'rows': [['BLS Polymers Limited', 'BLSPOLY', '2026-10-20', '2026-10-22', None, '₹142 to ₹150', 11900000.0, 'Closes tomorrow']]},
    'closed': {'cols': HDR, 'rows': []},
    'upcoming': {'cols': HDR, 'rows': [['M. K. Sons Fine Jewels Limited', 'MKSONS', '2026-10-28', '2026-10-30', None, '₹153 to ₹162', 17000000.0, 'Opens in 7 days']]},
    'listed': {'cols': LHDR, 'rows': [['Jio Platforms Limited', 'JPL', '2026-10-23', '2026-10-28', 1119.0, 1150.0, 2.77, 1231.0, 10.01,
                                       'Listed on 28-Oct; last close on 30-Oct']]},
}
assert got == want, json.dumps(got, ensure_ascii=False, indent=1)
assert list(got) == ['note', 'warning', 'open', 'closed', 'upcoming', 'listed']
warn = ex.Rows([['t'], ['Updated x'], ['Could not read from NSE this time: past - those sections may be incomplete.'], [None], ['Open now (0)'], HDR, ['None']])
warn.fmt = [['General'] * 8 for _ in warn]
w = ex.ipo_tracker(warn)
assert w['warning'].startswith('Could not read') and w['open']['rows'] == [] and w['closed'] == {'cols': [], 'rows': []}
print('OK')
