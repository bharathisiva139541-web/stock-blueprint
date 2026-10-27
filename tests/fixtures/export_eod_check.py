"""tools/export_xlsx.py note_table() / table() give the same JSON as Code.gs ab_site_noteTable_ /
ab_site_table_ for the NSE end-of-day tabs written in tests/codegs-eod.test.js (Market Statistics,
52 Week High, Delivery %). Run by tests/export-eod.test.js."""
import importlib.util
import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('export_xlsx', os.path.join(ROOT, 'tools', 'export_xlsx.py'))
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)


def tab(rows, fmts):
    r = ex.Rows(rows)
    r.fmt = fmts
    return r


NOTE = ('NSE market statistics - mainboard equities (series EQ / BE / BZ) counted from NSE\'s end-of-day files (bhavcopy, '
        '52-week high report, price band list) read by your PC. NSE\'s homepage counts every segment, so its own numbers are higher.')
ms = tab([[NOTE], ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit'],
          ['2026-10-27', 2310, 1520, 700, 90, 28, None, None], ['2026-10-26', 2300, 1520, 700, 90, 28, 41, 12]],
         [['@'], ['@'] * 8, ['@'] + ['0'] * 7, ['@'] + ['0'] * 7])
got = ex.note_table(ms, 'Date', stop_blank=False)
assert got == {'note': NOTE, 'cols': ['Date', 'Stocks Traded', 'Advances', 'Declines', 'Unchanged', 'At 52W High', 'Upper Circuit', 'Lower Circuit'],
               'rows': [['2026-10-27', 2310, 1520, 700, 90, 28, None, None], ['2026-10-26', 2300, 1520, 700, 90, 28, 41, 12]]}, json.dumps(got)
assert list(got) == ['note', 'cols', 'rows']

hi = tab([['52-week highs from NSE ... as on 2026-10-27: 2 mainboard stocks made a new 52-week high (1 in your watchlist).'],
          ['Symbol', 'Company', '52W High', '52W High Date', 'Close', '% Below 52W High', 'New High Today', 'In Watchlist'],
          ['NEWCO', None, 50, '2026-10-27', 50, 0, 'Yes', None], ['TCS', 'Tata Consultancy', 4500, '2026-01-10', 3900, 13.3, None, 'Yes']],
         [['@'], ['@'] * 8, ['@', '@', '0.00', '@', '0.00', '0.0', '@', '@']] * 1 + [['@', '@', '0.00', '@', '0.00', '0.0', '@', '@']])
h = ex.note_table(hi, 'Symbol', stop_blank=False)
assert h['rows'] == [['NEWCO', None, 50, '2026-10-27', 50, 0, 'Yes', None], ['TCS', 'Tata Consultancy', 4500, '2026-01-10', 3900, 13.3, None, 'Yes']], h
assert h['note'].startswith('52-week highs from NSE')

dl = tab([['Delivery % from NSE...'], ['Symbol', 'Company', '2026-10-27', '2026-10-26'], ['TCS', 'Tata Consultancy', 61.23, 50], ['RALLIS', 'Rallis', 30, None]],
         [['@'], ['@'] * 4, ['@', '@', '0.00', '0.00'], ['@', '@', '0.00', '0.00']])
d = ex.table(dl, 'Symbol', stop_blank=False)
assert d == {'cols': ['Symbol', 'Company', '2026-10-27', '2026-10-26'], 'rows': [['TCS', 'Tata Consultancy', 61.23, 50], ['RALLIS', 'Rallis', 30, None]]}, d
md = tab([['Your Main stocks on 2026-10-27 (NSE end-of-day files read by your PC): 1 traded - 1 advances, 0 declines, 0 unchanged.'],
          ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'],
          ['SONA', 'Sona BLW', 700, 3.5, 'Advance', 'Upper', 'Yes', 45.5]],
         [['@'], ['@'] * 8, ['@', '@', '0.00', '0.00', '@', '@', '@', '0.00']])
m = ex.note_table(md, 'Symbol', stop_blank=False)
assert m == {'note': 'Your Main stocks on 2026-10-27 (NSE end-of-day files read by your PC): 1 traded - 1 advances, 0 declines, 0 unchanged.',
             'cols': ['Symbol', 'Company', 'Close', '% Change', 'Move', 'Circuit', 'New 52W High', 'Delivery %'],
             'rows': [['SONA', 'Sona BLW', 700, 3.5, 'Advance', 'Upper', 'Yes', 45.5]]}, m
print('OK')
