"""tools/export_xlsx.py history60_data() on a workbook given as JSON (argv[1]: {sheets: [{name, rows, dates: [[row, col], ...]}]},
the cells listed in `dates` being 'yyyy-mm-dd' text that openpyxl would give as datetimes). Prints the JSON it returns,
for tests/export-history60.test.js to compare with Code.gs ab_site_history60_ on the same workbook."""
import datetime as dt
import importlib.util
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('export_xlsx', os.path.join(ROOT, 'tools', 'export_xlsx.py'))
ex = importlib.util.module_from_spec(spec)
spec.loader.exec_module(ex)


class Sheet:
    def __init__(self, rows):
        self.rows = rows

    def iter_rows(self, values_only=False):
        assert values_only
        return iter(tuple(r) for r in self.rows)


class Book:
    def __init__(self, sheets):
        self.sheets = sheets
        self.sheetnames = list(sheets)

    def __getitem__(self, name):
        return self.sheets[name]


with open(sys.argv[1], encoding='utf-8') as f:
    spec_in = json.load(f)
sheets = {}
for s in spec_in['sheets']:
    rows = [list(r) for r in s['rows']]
    for i, j in s.get('dates', []):
        rows[i][j] = dt.datetime.strptime(rows[i][j], '%Y-%m-%d')
    sheets[s['name']] = Sheet(rows)
print(json.dumps(ex.history60_data(Book(sheets))))
