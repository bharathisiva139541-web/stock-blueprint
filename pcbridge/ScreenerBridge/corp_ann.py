"""Corporate Intelligence - every NSE corporate announcement, sorted and scored by fixed rules (owner, 28-Nov-2026: a
"Today's Corporate Intelligence" page - 6 categories (A Business Growth & Opportunities, B Financial & Capital,
C Management & Governance, D Operational, E Risk & Negative, F Investor Communication & Market), a priority, the numbers
in the filing (order value, execution period, ratings, dividend, pledge, deal value, fundraising amount, monthly sales ...),
the order / revenue ratio, three scores (Business Impact, Governance / Risk, Information Surprise), filters and a company
search; "start from Past 1week announcement". His answers: "No AI involvment here. use python library to extract
information from pdf"; "30 days sheet vachurukalam, but all announcmenet should be stored in laptop, laptop on la iruntha
all announment um website kaatanum"; alerts "Website only").

How it works (standard library + pypdf for the PDFs):
  - NSE's corporate announcements come with every results check (screener_bridge ann_step already reads today + 3 days
    back in ONE request - nothing more is asked of NSE for the list); the first run also reads the days up to a week back.
    `take` keeps EVERY announcement (every NSE company) in the archive <data folder>/corp_data/days/<yyyy-mm-dd>.json.gz -
    never deleted.
  - `classify` = rules only: NSE's own subject first (`SUBJECTS`), then words in the details text and the PDF's text
    (`TEXT_RULES`); the event (`EVENTS`: its category, base scores), other events in the same filing (`ex`), the numbers
    (`numbers`), the scores and the priority (`score`).
  - `Worker` (the background program's thread): the PDFs of the Main stocks' filings whose numbers matter (`PDF_EVENTS`),
    newest first, one every PDF_GAP_S seconds, never while the round asks NSE (nse_busy), at most PDF_PER_DAY a day ->
    pypdf's text of the first PDF_PAGES pages (pypdf is installed by the program itself the first time: pip --user);
    and the website's questions about older days / one company's whole history (op 'ask' -> 'older').
  - The sheet keeps the last SHEET_DAYS days of the Main stocks' filings (op 'put', one packed blob a day); the website
    reads them through api/corp. Older days or a company's every filing come from this archive while the laptop is on.
"""
import base64
import gzip
import hashlib
import importlib
import io
import json
import os
import re
import site
import subprocess
import sys
import threading
import time
from datetime import date, datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
DIR = os.path.join(HERE, 'corp_data')          # screener_bridge.use_data_place points it at the data folder (data_place.BIG)
STATE_PATH = os.path.join(HERE, 'corp_state.json')
IST = timezone(timedelta(hours=5, minutes=30))

ENGINE = 1
RULES_VERSION = 1
BACK_DAYS = 7              # the first run: the past week (owner: "start from Past 1week announcement")
SHEET_DAYS = 30            # the sheet keeps this many days (owner: "30 days sheet vachurukalam")
POST_MAX_DAYS = 5          # days in one post
PDF_GAP_S = 6.0            # between two PDF downloads (NSE's archive - gently, like the XBRL history)
PDF_PER_DAY = 400          # PDFs a day at most
PDF_BACK_DAYS = 30         # PDFs of filings at most this old
PDF_MAX_BYTES = 15 * 1024 * 1024
PDF_PAGES = 8              # pages read of each PDF
PT_MAX = 8000              # characters of a PDF's text kept
SCAN_PDF = 4000            # ... of it the rules read (a filing's facts are on its first page)
TX_MAX = 4000              # characters of NSE's details text kept
SITE_TX = 500              # ... of it sent to the website
SYMS_EVERY_S = 20 * 3600   # Main's stocks asked again after this
ASK_IDLE_S = 120           # the website's questions: asked this often while nobody looks (the sheet says when faster)
POST_EVERY_S = 10 * 60     # PDFs read -> the changed days sent at most this often
PIP_RETRY_S = 20 * 3600
OLDER_MAX = 3000           # rows of one answer to the website
FX = {'USD': 88.0, 'EUR': 95.0, 'GBP': 112.0}   # rupees a unit, roughly - only for the size of an order / deal
PDF_HOSTS = re.compile(r'^https://(nsearchives|archives|www1?)\.nseindia\.com/[^\s"<>]{1,400}$', re.I)

log = print
D = {}                     # bind(): get (url -> (status, bytes)), api, nse_busy, revenue (sym -> TTM revenue in crore)
_LOCK = threading.RLock()


def bind(**kw):
    D.update(kw)


# ------------------------------------------------------------------ categories and events
CATS = (('A', 'Business Growth & Opportunities'), ('B', 'Financial & Capital'), ('C', 'Management & Governance'),
        ('D', 'Operational'), ('E', 'Risk & Negative'), ('F', 'Investor Communication & Market'))
CAT_NAMES = dict(CATS)

# code: (name, category, business impact, governance / risk, information surprise) - the base scores (0-100)
EVENTS = {
    'order': ('Order win', 'A', 50, 0, 60),
    'capex': ('Capacity expansion / new plant', 'A', 45, 0, 50),
    'acq': ('Acquisition', 'A', 50, 5, 60),
    'merger': ('Merger / demerger / scheme', 'A', 50, 10, 55),
    'jv': ('Partnership / JV / MoU', 'A', 35, 0, 45),
    'approval': ('Approval / product launch', 'A', 40, 0, 45),
    'results': ('Financial results', 'B', 45, 0, 40),
    'dividend': ('Dividend', 'B', 25, 0, 25),
    'fund': ('Fundraising', 'B', 40, 10, 50),
    'buyback': ('Buyback', 'B', 45, 0, 55),
    'bonus': ('Bonus issue', 'B', 35, 0, 45),
    'split': ('Stock split', 'B', 25, 0, 40),
    'rating': ('Credit rating', 'B', 20, 10, 30),
    'allot': ('Allotment of securities / ESOP', 'B', 10, 0, 10),
    'record': ('Record date / book closure', 'B', 10, 0, 10),
    'divest': ('Sale of a business / stake', 'B', 40, 5, 55),
    'kmp': ('Top management change', 'C', 15, 35, 45),
    'director': ('Director change', 'C', 10, 20, 30),
    'auditor': ('Auditor change', 'C', 5, 40, 50),
    'meeting': ('Board / shareholders meeting', 'C', 5, 0, 10),
    'sast': ('Promoter / insider shares', 'C', 10, 10, 15),
    'update': ('Business / sales update', 'D', 35, 0, 40),
    'ops': ('Operations update', 'D', 30, 10, 40),
    'sub': ('Subsidiary set up / closed', 'D', 15, 0, 20),
    'pledge': ('Pledge of promoter shares', 'E', 0, 45, 40),
    'default': ('Default / fraud', 'E', 0, 90, 80),
    'legal': ('Legal / regulatory / tax action', 'E', 0, 45, 50),
    'insolv': ('Insolvency (NCLT / IBC)', 'E', 0, 85, 70),
    'disrupt': ('Fire / accident / shutdown', 'E', 0, 60, 65),
    'call': ('Analyst / investor meet or call', 'F', 10, 0, 15),
    'present': ('Investor presentation / transcript', 'F', 15, 0, 20),
    'clarify': ('Clarification on news / price move', 'F', 5, 20, 35),
    'press': ('Press release', 'F', 20, 0, 30),
    'paper': ('Newspaper publication', 'F', 0, 0, 5),
    'comp': ('Routine compliance filing', 'F', 0, 0, 0),
    'other': ('Other update', 'F', 10, 0, 15),
}
# the page's filters (owner's list) - an announcement belongs to a filter by its event or one of its other events
FILTERS = (('all', 'All announcements'), ('high', 'High-impact events'), ('orders', 'Order wins'), ('mgmt', 'Management changes'),
           ('fund', 'Fundraising'), ('results', 'Financial results'), ('calls', 'Investor calls'), ('risk', 'Risk alerts'),
           ('actions', 'Corporate actions'))
FILTER_EVENTS = {'orders': ('order',), 'mgmt': ('kmp', 'director', 'auditor'), 'fund': ('fund',), 'results': ('results',),
                 'calls': ('call', 'present'), 'actions': ('dividend', 'bonus', 'split', 'buyback', 'record')}
# PDFs read for these (their numbers are in the PDF); a filing's other events count too
PDF_EVENTS = ('order', 'capex', 'acq', 'merger', 'jv', 'approval', 'dividend', 'fund', 'buyback', 'bonus', 'split', 'rating',
              'divest', 'update', 'ops', 'pledge', 'default', 'legal', 'insolv', 'disrupt', 'clarify', 'press', 'other', 'kmp',
              'auditor')
# a meeting notice / compliance filing lists only these as its other events (the agenda) - never results / calls
AGENDA = ('fund', 'buyback', 'bonus', 'split', 'merger', 'acq', 'divest', 'dividend')
RISK_EX = ('default', 'insolv')        # other events that make a filing a risk alert by themselves
PRI = (('high', 60), ('med', 35), ('low', 15))

# NSE's subject (its own category of the filing): (words, event, strong). strong = the subject decides the event; else the
# text's words decide and this is the fallback. 'people' = decided by the roles in the text (kmp / director / auditor).
SUBJECTS = (
    (r'bagging|receiving of orders?|award of (orders?|contracts?)|orders?\s*/\s*contracts?', 'order', True),
    (r'credit rating', 'rating', True),
    (r'\bsast\b|takeover regulations|regulation 29|regulation 31|insider trading|\bpit\b', 'sast', False),
    (r'pledge|encumbrance', 'pledge', True),
    (r'insolvency|\bibc\b|\bcirp\b', 'insolv', True),
    (r'fraud|default|arrest', 'default', True),
    (r'action\(?s?\)? (initiated|taken)|orders? passed|litigation|dispute|regulatory action|penalt', 'legal', True),
    (r'amalgamation|merger|scheme of arrangement|demerger|restructuring', 'merger', True),
    (r'joint venture', 'jv', True),
    (r'sale or disposal|divest|disinvest|slump sale', 'divest', True),
    (r'acquisition', 'acq', True),
    (r'buy ?back', 'buyback', True),
    (r'bonus', 'bonus', True),
    (r'sub-?division|\bsplit\b', 'split', True),
    (r'dividend', 'dividend', True),
    (r'fund raising|raising of funds|issue of securities|qualified institution|preferential|rights issue|debentures|'
     r'commercial paper|warrants', 'fund', True),
    (r'record date|book closure', 'record', False),
    (r'allotment|esop|esos|esps|listing of (securities|shares)', 'allot', False),
    (r'intimation|shareholders? meeting|general meeting|postal ballot|e-voting|notice of', 'meeting', True),
    (r'financial result|integrated filing.{0,10}financial', 'results', True),
    (r'change in (director|management|auditor|key managerial)|key managerial|\bkmp\b|resignation|appointment|cessation|'
     r're-?appointment', 'people', True),
    (r'analysts?|institutional investor meet|con\.? ?call|conference call|investor meet', 'call', True),
    (r'investor presentation|transcript|audio|video recording', 'present', True),
    (r'clarification|spurt|price movement|news verification', 'clarify', True),
    (r'newspaper', 'paper', True),
    (r'monthly business|business update|sales (figures|update|numbers)|production (update|figures)', 'update', True),
    (r'commencement of (commercial )?(production|operations)|commercial production|capacity', 'capex', True),
    (r'incorporation|subsidiary', 'sub', False),
    (r'trading window|loss of (share )?certificate|duplicate|certificate|reg(ulation)?\.? ?\d|compliance|shareholding pattern|'
     r'reconciliation|brsr|business responsibility|annual report|deviation|related party|corporate governance|'
     r'investor complaints|iepf|esg|registered office|registrar|name change|change of name', 'comp', True),
    (r'outcome of (the )?board meeting', 'other', False),
    (r'press release|media release', 'press', False),
    (r'investment', 'acq', False),
    (r'updates?|others?|general', 'other', False),
)

# words in the subject + details text + PDF text -> events (all found are kept; the strongest is the event when the subject
# does not decide)
TEXT_RULES = (
    ('order', r'bagg(ed|ing)|receipt of (an? |the )?(new )?(orders?|contracts?|loa|letter of (award|acceptance|intent))|'
              r'received (an? |the )?(new |repeat )?(orders?|purchase orders?|work orders?|contracts?|letters? of (award|acceptance|intent))|'
              r'secured (an? |the )?(new )?(orders?|contracts?)|letters? of (award|acceptance|intent)\b|\bloa\b|work orders?\b|'
              r'purchase orders?\b|orders? (worth|valued|value|of rs|aggregating|inflow)|awarded (an? |the )?(contract|order|project)|'
              r'emerged as (the )?(l-?1|lowest) bidder|\bl-?1 bidder|declared (as )?(the )?(l-?1|successful) bidder|'
              r'contracts? (worth|valued|aggregating)|won (an? |the )?(order|contract)|new orders?\b'),
    ('capex', r'capacity expansion|expansion of (the |its )?(existing )?(capacity|plant|facility|unit)|new (plant|facility|'
              r'manufacturing (unit|facility|plant))|greenfield|brownfield|commission(ed|ing) of|commercial (production|operations?) '
              r'(from|of|at|has)|commencement of (commercial )?(production|operations)|capital expenditure|\bcapex\b|'
              r'set(ting)? up (a |an )?(new )?(plant|unit|facility)|additional capacity|enhance(ment of)? (the )?capacity|'
              r'increase in (the )?(production |installed )?capacity'),
    ('acq', r'\bacqui(re|red|res|ring|sition)\b|takeover of|share purchase agreement|purchase of (\d+(\.\d+)?\s*%|(the )?stake)|'
            r'stake (in|purchase)|binding (term sheet|agreement) to acquire'),
    ('merger', r'amalgamation|\bmerger\b|demerger|de-merger|scheme of arrangement|composite scheme'),
    ('divest', r'\bdivest|disinvest|sale of (its |the |our )?(entire )?(stake|business|division|undertaking|subsidiary|unit)|'
               r'slump sale|hive[- ]?off|sell(ing)? (its |the |our )?(entire )?(stake|shareholding|business)'),
    ('jv', r'joint venture|\bjv\b|memorandum of understanding|\bmou\b|strategic (partnership|alliance|collaboration)|'
           r'collaborat(e|ion) with|tie[- ]up|partnership with|teaming agreement|technology (transfer|licen[cs]e) agreement|'
           r'distribution agreement|licen[cs]ing agreement'),
    ('approval', r'\busfda\b|\bus fda\b|\bdcgi\b|\bcdsco\b|\banda\b|establishment inspection report|\beir\b|final approval|'
                 r'tentative approval|product launch|launch(ed|es)? (of )?(its |a |the )?(new )?([a-z]+ )?(product|brand|range|'
                 r'variant|model|drug|formulation)|patent (granted|grant)|grant of (a )?patent|marketing authori[sz]ation'),
    ('results', r'financial results? for the|(unaudited|audited) (standalone |consolidated )?(and (standalone|consolidated) )?'
                r'financial results|results for the (quarter|year|half)|quarterly results'),
    ('dividend', r'\b(interim|final|special)? ?dividend\b'),
    ('fund', r'qualified institutions? placement|\bqip\b|preferential (issue|allotment|basis)|rights issue|issue of (listed |'
             r'unlisted )?(secured )?(non[- ]convertible )?debentures|\bncds?\b|commercial papers?|raising of funds|raise funds|'
             r'fund[- ]?rais(e|ing)|issue of (equity shares|warrants|securities)|convertible warrants|foreign currency convertible|'
             r'\bfccbs?\b|external commercial borrowing|\becb\b|private placement|further public offer'),
    ('buyback', r'buy[- ]?back'),
    ('bonus', r'bonus (issue|shares|equity)|issue of bonus'),
    ('split', r'sub[- ]?division|split of (the )?(equity )?shares|stock split|split of (the )?face value'),
    ('rating', r'credit rating|(crisil|icra|care ratings|india ratings|brickwork|acuit[eé]|infomerics)\b.{0,80}'
               r'(rating|reaffirm|upgrad|downgrad|assign)'),
    ('allot', r'allotment of|\ballotted\b|\besops?\b|\besos\b|\besps\b|employee stock option|listing (and trading )?approval'),
    ('record', r'record date|book closure'),
    ('pledge', r'\bpledg|encumbrance|\bencumbered\b|invocation of'),
    ('sast', r'offer for sale|\bofs\b|sast regulations|regulation 29|regulation 31|insider trading|regulation 7 ?\(2\)|'
             r'sale of shares by (the )?promoter|promoter.{0,30}(sold|sale of|selling|acquired|bought|purchase of)'),
    ('default', r'default(ed)? (in|on) (the )?(payment|repayment)|delay in (the )?(payment|repayment|servicing)|non[- ]payment of|'
                r'\bnpa\b|\bfraud\b|forensic audit|\barrest(ed)?\b|wilful defaulter|one[- ]time settlement'),
    ('legal', r'show[- ]cause|\bpenalty\b|tax demand|demand (order|notice)|income[- ]tax (demand|search|survey|order)|'
              r'gst (demand|order|notice|search)|search (and seizure|operation)|\braid\b|litigation|lawsuit|legal proceedings?|'
              r'sebi (order|interim|adjudication)|adjudication order|regulatory action|warning letter|import alert|form 483|'
              r'\boai\b|enforcement directorate|\bcbi\b|summons|\bfir\b'),
    ('insolv', r'insolvency|\bibc\b|\bcirp\b|resolution professional|winding up|\bliquidation\b'),
    ('disrupt', r'\bfire\b (broke|incident|accident|at|in)|fire (incident|accident)|\bexplosion\b|\bblast\b|accident at|'
                r'\bfloods?\b|cyber[- ]?(attack|security incident)|ransomware|\bstrike\b|lock[- ]?out|shut ?down (of|at)|'
                r'suspension of (operations|production)|force majeure'),
    ('update', r'monthly (business )?update|business update|sales (update|volumes?|numbers|figures)|(total|domestic|export) '
               r'sales|units sold|production (update|volumes?|numbers)|operational update|quarterly update|business performance|'
               r'\bdisbursements?\b|loan book|gross advances|customer additions|passenger traffic|\baum\b'),
    ('ops', r'resum(ed|ption) of (operations|production)|plant (operations|shutdown)|temporary (shutdown|suspension)|'
            r'commenced (operations|production)|start of (operations|production)'),
    ('sub', r'incorporation of (a |an )?(new )?(wholly[- ]owned )?(step[- ]down )?subsidiary|subsidiary (has been |was )?incorporated|'
            r'cessation of (a |the )?subsidiary|ceased to be (a )?subsidiary|strike[- ]off'),
    ('call', r'analysts?(\s*/\s*|\s+and\s+|\s+)(institutional\s+)?investors?\s+meet|investor meet|con(ference)?[- ]?call|earnings call|'
             r'analyst meet|investor conference|meeting with (the )?(analysts|investors|institutional)|one[- ]on[- ]one|'
             r'group meeting|road ?show'),
    ('present', r'investor presentation|earnings presentation|corporate presentation|\btranscript\b|audio recording|'
                r'video recording'),
    ('clarify', r'clarification|price movement|spurt in (volume|price)|movement in (the )?(share )?price|news (item|article|report)|'
                r'media report|rumou?r'),
    ('paper', r'newspaper|news paper|newspapers advertisement'),
    ('comp', r'trading window|loss of (share )?certificates?|duplicate (share )?certificates?|regulation 74 ?\(5\)|reg\.? ?74|'
             r'compliance certificate|annual secretarial compliance|\bbrsr\b|business responsibility|shareholding pattern|'
             r'reconciliation of share capital|statement of (deviation|investor complaints)|investor complaints|\biepf\b|'
             r'unclaimed|unpaid dividend|tds on dividend|change in (the )?(registered office|rta|registrar)|esg rating'),
)
_SUBJECTS = [(re.compile(w, re.I), ev, strong) for w, ev, strong in SUBJECTS]
_TEXT = [(ev, re.compile(w)) for ev, w in TEXT_RULES]           # searched in the lower-case text (faster than re.I)
ROUTINE = ('comp', 'paper', 'meeting', 'record', 'allot')


def _norm(s):
    s = str(s or '').replace('₹', ' Rs ').replace('\xa0', ' ')
    s = re.sub(r'substantial acquisition of shares and takeovers?', 'sast regulations', s, flags=re.I)
    s = re.sub(r'prohibition of insider trading', 'insider trading', s, flags=re.I)
    return re.sub(r'\s+', ' ', s).strip()


# ------------------------------------------------------------------ numbers
_NUM = r'(\d{1,3}(?:,\d{2,3})+(?:\.\d+)?|\d+(?:\.\d+)?)'
_CUR = r'(rs\.?|inr|\brupees|usd|us\s?\$|\$|eur\b|euro|€|gbp|\xa3|`)'
_UNIT = (r'(lakh\s+crores?|lac\s+crores?|crores?|crs?\b\.?|lakhs?|lacs?\b|millions?|mn\b\.?|mio\b|billions?|bn\b\.?|thousand|'
         r'k\b)?')
_MONEY = re.compile(_CUR + r'\s*' + _NUM + r'\s*(?:/-)?\s*' + _UNIT, re.I)
_MONEY2 = re.compile(r'(?<![\d.,])' + _NUM + r'\s*(crores?|cr\b\.?|lakh\s+crores?)', re.I)   # "an order of 345 crore"
_MONEY_NOT = re.compile(r'turnover|revenue|net ?worth|market cap|paid[- ]?up|authori[sz]ed (share )?capital|share capital|'
                        r'face value|profit|ebitda|\bpat\b|income(?![- ]?tax)|previous year|last year|net sales',
                        re.I)
MONEY_NEAR = {
    'order': r'orders?|contracts?|\bloa\b|award|worth|valued|value|aggregat|amount|project|tender|consideration|cost|total',
    'capex': r'capex|investment|outlay|cost|expenditure|invest',
    'acq': r'consideration|value|valuation|deal|purchase price|enterprise value|amount|cost|invest|aggregat|for a total',
    'merger': r'consideration|value|valuation|deal|amount',
    'divest': r'consideration|value|valuation|deal|sale price|amount|aggregat|for a total',
    'jv': r'invest|value|worth|amount|contribution|capital',
    'fund': r'raise|raising|issue size|aggregat|up to|upto|not exceeding|amount|size|borrow|issue of',
    'buyback': r'buy[- ]?back|aggregat|up to|upto|not exceeding|amount|size',
    'legal': r'demand|penalty|fine|amount|tax|claim|dues|liability',
    'default': r'default|outstanding|dues|amount|payment|principal|interest',
    'update': r'sales|revenue|disburse|collection|aum|book|value',
    'press': r'orders?|contracts?|investment|deal|worth|value|raise',
    'other': r'orders?|contracts?|investment|deal|worth|value|raise',
}
_NEAR = {k: re.compile(v, re.I) for k, v in MONEY_NEAR.items()}


def _f(s):
    try:
        return float(str(s).replace(',', ''))
    except ValueError:
        return None


def _crore(n, cur, unit):
    """An amount -> crore of rupees (None when it is too small to be one - a bare 'Rs 345' is a price)."""
    cur = (cur or '').lower().replace(' ', '')
    u = (unit or '').lower().replace(' ', '').rstrip('.')
    fx = 1.0
    if cur in ('usd', 'us$', '$'):
        fx = FX['USD']
    elif cur in ('eur', 'euro', '€'):
        fx = FX['EUR']
    elif cur in ('gbp', '\xa3'):
        fx = FX['GBP']
    if u.startswith(('lakhcrore', 'laccrore')):
        v = n * 1e5
    elif u.startswith(('crore', 'cr')):
        v = n
    elif u.startswith(('lakh', 'lac')):
        v = n / 100.0
    elif u.startswith(('million', 'mn', 'mio')):
        v = n * 1e6 / 1e7
    elif u.startswith(('billion', 'bn')):
        v = n * 1e9 / 1e7
    elif u in ('thousand', 'k'):
        v = n * 1e3 / 1e7
    else:
        if n < 1e5:
            return None
        v = n / 1e7
    return v * fx


def amounts(text):
    """Every money amount in the text -> [(crore, start, end, currency)] in text order."""
    out, spans = [], set()
    for m in _MONEY.finditer(text):
        n = _f(m.group(2))
        if n is None:
            continue
        v = _crore(n, m.group(1), m.group(3))
        if v is not None and v > 0:
            c = m.group(1).lower()
            out.append((v, m.start(), m.end(), 'USD' if '$' in c or 'usd' in c else 'EUR' if c in ('eur', 'euro', '€')
                        else 'GBP' if c in ('gbp', '\xa3') else 'INR'))
            spans.update(range(m.start(), m.end()))
    for m in _MONEY2.finditer(text):
        if m.start() in spans:
            continue
        n = _f(m.group(1))
        v = _crore(n, 'rs', m.group(2)) if n is not None else None
        if v:
            out.append((v, m.start(), m.end(), 'INR'))
    return sorted(out, key=lambda t: t[1])


def main_amount(text, ev):
    """The amount the event is about: an amount with the event's words in the 100 characters before it (none of 'turnover',
    'paid-up' ...); the largest of those (a list of orders ends with the total); else the largest plain one."""
    near = _NEAR.get(ev)
    best, plain = None, None
    for v, a, b, cur in amounts(text):
        before = text[max(0, a - 100):a]
        if _MONEY_NOT.search(re.split(r';|\.\s', text[max(0, a - 45):a])[-1]) or re.match(r'\s*(?:/-)?\s*(?:\(.{0,60}?\)\s*)?(per|each)\b', text[b:b + 70], re.I):
            continue
        if near is not None and near.search(before):
            if best is None or v > best[0]:
                best = (v, cur)
        elif plain is None or v > plain[0]:
            plain = (v, cur)
    return best or plain


_PERIOD = re.compile(r'(\d+(?:\.\d+)?)\s*(?:\(\s*[a-z -]+\s*\)\s*)?(months?|years?|yrs?|weeks?|days)\b', re.I)
_PERIOD_NEAR = re.compile(r'execut|complet|deliver|suppl|period|within|over|tenure|timeline|span|duration', re.I)


def period_months(text):
    for m in _PERIOD.finditer(text):
        if not _PERIOD_NEAR.search(text[max(0, m.start() - 60):m.start()]):
            continue
        n, u = _f(m.group(1)), m.group(2).lower()
        if n is None or n <= 0:
            continue
        mo = n * 12 if u.startswith(('year', 'yr')) else n / 4.345 if u.startswith('week') else n / 30.4 if u.startswith('day') else n
        if 0 < mo <= 240:
            return round(mo, 1)
    return None


RATING_AGENCIES = (('CRISIL', r'crisil'), ('ICRA', r'\[?icra\]?'), ('CARE', r'care(?: ratings| edge)?'),
                   ('India Ratings', r'india ratings|ind-?ra|\bind\b'), ('Brickwork', r'brickwork|\bbwr\b'),
                   ('Acuite', r'acuit[eé]'), ('Infomerics', r'infomerics|\bivr\b'))
GRADES = ('AAA', 'AA+', 'AA', 'AA-', 'A+', 'A', 'A-', 'BBB+', 'BBB', 'BBB-', 'BB+', 'BB', 'BB-', 'B+', 'B', 'B-', 'C+', 'C',
          'C-', 'D')
_GRADE = r'(AAA|AA[+-]?|A[+-]?|BBB[+-]?|BB[+-]?|B[+-]?|C[+-]?|D)(?![A-Za-z0-9+])'
_AG_GRADE = re.compile(r'(crisil|\[?icra\]?|care|ind|india ratings|bwr|brickwork|acuit[eé]|ivr|infomerics)\s*\]?\s*\(?\s*'
                       + _GRADE + r'(\s*\((?:ce|so)\))?', re.I)
_FROM_TO = re.compile(r'from\s+(?:[A-Za-z\[\]-]{2,12}\s*)?\]?\s*' + _GRADE + r'[^.]{0,60}?\bto\s+(?:[A-Za-z\[\]-]{2,12}\s*)?\]?\s*' + _GRADE)


def _grade_rank(g):
    return GRADES.index(g) if g in GRADES else None


def rating(text):
    """{ag, rt, from, act: up | down | same | new | watch- | outlook- | outlook+ | withdrawn} from a rating letter's words."""
    out = {}
    low = text.lower()
    for name, w in RATING_AGENCIES:
        if re.search(w, low):
            out['ag'] = name
            break
    m = _AG_GRADE.search(text)
    if m:
        out['rt'] = m.group(2).upper()
    ft = _FROM_TO.search(text)
    if ft:
        out['from'], out['rt'] = ft.group(1).upper(), ft.group(2).upper()
    if re.search(r'upgrad|revised upward|revised (its |the )?rating upward', low):
        out['act'] = 'up'
    elif re.search(r'downgrad|revised downward|revised (its |the )?rating downward', low):
        out['act'] = 'down'
    elif out.get('from') and out.get('rt') and _grade_rank(out['from']) is not None and _grade_rank(out['rt']) is not None:
        a, b = _grade_rank(out['from']), _grade_rank(out['rt'])
        out['act'] = 'up' if b < a else 'down' if b > a else 'same'
    elif re.search(r'watch with negative|rating watch negative|credit watch.{0,20}negative', low):
        out['act'] = 'watch-'
    elif re.search(r'outlook (revised|changed) (to|from \w+ to) negative|negative outlook', low):
        out['act'] = 'outlook-'
    elif re.search(r'outlook (revised|changed) (to|from \w+ to) positive|positive outlook', low):
        out['act'] = 'outlook+'
    elif re.search(r'withdraw', low):
        out['act'] = 'withdrawn'
    elif re.search(r'reaffirm|re-affirm|retain|maintain', low):
        out['act'] = 'same'
    elif re.search(r'assign', low):
        out['act'] = 'new'
    return out


_MONTHS = {m: i + 1 for i, m in enumerate(('jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'))}
_DATE_RES = (re.compile(r'(\d{1,2})(?:st|nd|rd|th)?[\s.\-/,]+([A-Za-z]{3,9})\.?[\s.\-/,]+(\d{4})'),
             re.compile(r'([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})'),
             re.compile(r'(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})'))


def find_date(s):
    """The first date in the text -> 'yyyy-mm-dd' or None."""
    best = None
    for k, rx in enumerate(_DATE_RES):
        m = rx.search(s)
        if not m or (best and m.start() >= best[0]):
            continue
        try:
            if k == 0:
                mo = _MONTHS.get(m.group(2).lower()[:3])
                d = date(int(m.group(3)), mo, int(m.group(1))) if mo else None
            elif k == 1:
                mo = _MONTHS.get(m.group(1).lower()[:3])
                d = date(int(m.group(3)), mo, int(m.group(2))) if mo else None
            else:
                d = date(int(m.group(3)), int(m.group(2)), int(m.group(1)))
        except ValueError:
            d = None
        if d:
            best = (m.start(), d.isoformat())
    return best[1] if best else None


_DPS = re.compile(r'(?:rs\.?|inr|`)\s*(\d+(?:\.\d+)?)\s*(?:/-)?\s*(?:\(\s*\d+(?:\.\d+)?\s*%\s*\)\s*)?(?:per|each)\s+(?:fully\s+paid[- ]up\s+)?'
                  r'(?:equity\s+)?shares?', re.I)
_PCT_FV = re.compile(r'(\d+(?:\.\d+)?)\s*%\s*(?:i\.?e\.?|of the face value|on the face value)', re.I)
_PX = re.compile(r'(?:price\s+of|premium\s+of|issue\s+price|offer\s+price|buy[- ]?back\s+price|at|@)\s*(?:of\s*)?(?:rs\.?|inr|`)\s*'
                 + _NUM + r'\s*(?:/-)?\s*(?:\([^)]{0,60}\)\s*)?(?:per|each)\s*(?:fully\s+paid[- ]up\s+)?(?:equity\s+)?share', re.I)
_STAKE = (re.compile(r'(\d+(?:\.\d+)?)\s*%\s*(?:of\s+(?:the\s+)?(?:total\s+)?(?:issued\s+)?)?(?:stake|equity|shareholding|share '
                     r'capital|paid[- ]?up|voting|interest)', re.I),
          re.compile(r'(?:stake|shareholding|equity interest)\s+of\s+(?:about\s+)?(\d+(?:\.\d+)?)\s*%', re.I))
_GROWTH = (re.compile(r'(?:growth|grew|increase[sd]?|higher|rise|rose|jump(?:ed)?|up)\s+(?:of\s+|by\s+)?(?:about\s+)?(\d+(?:\.\d+)?)\s*%', re.I),
           re.compile(r'(\d+(?:\.\d+)?)\s*%\s*(?:growth|increase|higher|rise|jump|y-?o-?y|yoy|year[- ]on[- ]year)', re.I))
_FALL = re.compile(r'(?:decline[sd]?|decrease[sd]?|fell|lower|down|drop(?:ped)?)\s+(?:of\s+|by\s+)?(?:about\s+)?(\d+(?:\.\d+)?)\s*%', re.I)
_UNITS = re.compile(r'(\d{1,3}(?:,\d{2,3})+|\d{3,})\s*(?:units|vehicles|tractors|cars|motorcycles|scooters|two[- ]wheelers|'
                    r'nos\.?(?=\s)|pieces|homes)\b', re.I)
_CAP = re.compile(r'(\d[\d,]*(?:\.\d+)?)\s*(mwp|mw|gw|mva|mtpa|tpa|tpd|klpd|kl|mt|tonnes|tons|beds|lakh sq\.? ?ft|sq\.? ?ft|km)\b', re.I)
_BONUS = (re.compile(r'(\d+)\s*\(\s*[a-z]+\s*\)\s*(?:new\s+|fully\s+paid[- ]up\s+)?bonus\s+(?:equity\s+)?shares?\s+for\s+every\s+(\d+)', re.I),
          re.compile(r'(\d+)\s*bonus\s+(?:equity\s+)?shares?\s+for\s+every\s+(\d+)', re.I),
          re.compile(r'(?:ratio\s+of|in\s+the\s+ratio\s+of)\s*(\d+)\s*:\s*(\d+)', re.I),
          re.compile(r'\b(\d+)\s*:\s*(\d+)\b'))
_FV = re.compile(r'(?:face value|f\.?v\.?|nominal value)[^.]{0,80}?(?:rs\.?|inr|`)\s*(\d+(?:\.\d+)?)[^.]{0,80}?(?:to|into)\s+[^.]{0,30}?'
                 r'(?:rs\.?|inr|`)\s*(\d+(?:\.\d+)?)', re.I)
_PLEDGE = re.compile(r'(\d+(?:\.\d+)?)\s*%', re.I)
INSTRUMENTS = [(re.compile(w, re.I), n) for w, n in (
    (r'qualified institutions? placement|\bqip\b', 'QIP'), (r'preferential', 'Preferential issue'), (r'rights issue', 'Rights issue'),
    (r'non[- ]convertible debentures|\bncds?\b', 'NCDs'), (r'commercial papers?', 'Commercial paper'), (r'\bwarrants\b', 'Warrants'),
    (r'\bfccbs?\b|foreign currency convertible', 'FCCBs'), (r'external commercial borrowing|\becb\b', 'ECB'), (r'term loan', 'Term loan'))]


def _first_pct(rxs, text):
    for rx in rxs:
        m = rx.search(text)
        if m:
            v = _f(m.group(1))
            if v is not None and 0 < v <= 100:
                return v
    return None


def numbers(ev, evs, text, at=''):
    """The figures of the filing for its events -> {key: value} (amounts in crore of rupees)."""
    out = {}
    low = text.lower()
    for e in [ev] + list(evs):
        if e in MONEY_NEAR and 'val' not in out:
            got = main_amount(text, e)
            if got:
                out['val'] = round(got[0], 2)
                if got[1] != 'INR':
                    out['cur'] = got[1]
    if ev in ('order', 'capex', 'jv', 'merger') or 'order' in evs:
        mo = period_months(text)
        if mo:
            out['mo'] = mo
    if ev in ('capex', 'ops', 'order', 'jv'):
        m = _CAP.search(text)
        if m:
            out['cap'] = (m.group(1) + ' ' + m.group(2)).strip()[:20]
    if ev == 'rating' or 'rating' in evs:
        r = rating(text)
        for k, v in r.items():
            out['r' + k if k != 'from' else 'rfrom'] = v
    if ev == 'dividend' or 'dividend' in evs:
        idx = low.find('dividend')
        win = text[max(0, idx - 150):idx + 350] if idx >= 0 else text
        m = _DPS.search(win)
        if m:
            out['dps'] = _f(m.group(1))
        else:
            m = _PCT_FV.search(win)
            if m:
                out['dpct'] = _f(m.group(1))
        typ = re.search(r'(special|interim|final)\s+dividend', win, re.I)
        if typ:
            out['dty'] = typ.group(1).lower()
    if ev in ('dividend', 'bonus', 'split', 'buyback', 'record') or set(evs) & {'dividend', 'bonus', 'split', 'buyback', 'record'}:
        m = re.search(r'record date|book closure', text, re.I)
        if m:
            d = find_date(text[m.end():m.end() + 120])
            if d:
                out['rd'] = d
    if ev in ('fund', 'buyback') or set(evs) & {'fund', 'buyback'}:
        m = _PX.search(text)
        if m:
            out['px'] = _f(m.group(1))
        best = None
        for rx, nm in INSTRUMENTS:
            m = rx.search(low)
            if m and (best is None or m.start() < best[0]):
                best = (m.start(), nm)
        if best:
            out['ins'] = best[1]
    if ev in ('acq', 'divest', 'jv', 'sast', 'sub') or set(evs) & {'acq', 'divest'}:
        st = _first_pct(_STAKE, text)
        if st:
            out['stake'] = st
    if ev == 'update':
        m = _FALL.search(text)
        g = _first_pct(_GROWTH, text)
        if m and (g is None or m.start() < text.find(str(g).rstrip('0').rstrip('.'))):
            out['gr'] = -_f(m.group(1))
        elif g is not None:
            out['gr'] = g
        u = [_f(x) for x in _UNITS.findall(text)]
        u = [x for x in u if x]
        if u:
            out['units'] = int(max(u))
    if ev == 'bonus' or 'bonus' in evs:
        for rx in _BONUS:
            m = rx.search(text)
            if m and (rx is not _BONUS[3] or 'bonus' in text[max(0, m.start() - 80):m.end() + 80].lower()):
                out['ratio'] = '%s:%s' % (m.group(1), m.group(2))
                break
    if ev == 'split' or 'split' in evs:
        m = _FV.search(text)
        if m:
            out['fv'] = [_f(m.group(1)), _f(m.group(2))]
    if ev == 'pledge' or 'pledge' in evs:
        i = re.search(r'pledg|encumb', text, re.I)
        if i:
            m = _PLEDGE.search(text[i.start():i.start() + 200])
            if m and 0 < (_f(m.group(1)) or 0) <= 100:
                out['pl'] = _f(m.group(1))
        out['pact'] = ('invoke' if re.search(r'invocation|invoked', low) else 'release' if re.search(r'release|revocation|revoked', low)
                       else 'create')
    return out


# ------------------------------------------------------------------ people (who joined / left)
ROLES = (('Auditor', 'auditor', r'statutory auditors?|secretarial auditors?|internal auditors?|cost auditors?|\bauditors?\b'),
         ('CEO', 'kmp', r'chief executive officer|\bceo\b'), ('MD', 'kmp', r'managing director|\bmd\b'),
         ('CFO', 'kmp', r'chief financial officer|\bcfo\b'), ('Chairman', 'kmp', r'\bchair(man|person)\b'),
         ('COO', 'kmp', r'chief operating officer|\bcoo\b'), ('Whole-time Director', 'kmp', r'whole[- ]time director|executive director'),
         ('Chief Officer', 'kmp', r'chief [a-z ]{2,30} officer|\bpresident\b|\bcto\b|\bcio\b'),
         ('Company Secretary', 'kmp', r'company secretary|compliance officer'),
         ('Independent Director', 'director', r'independent director'),
         ('Director', 'director', r'non[- ]executive director|additional director|nominee director|woman director|\bdirectors?\b'),
         ('KMP', 'kmp', r'key managerial personnel|\bkmp\b'))
_ROLES = [(n, ev, re.compile(w, re.I)) for n, ev, w in ROLES]
_OUT = re.compile(r'resign|cessation|ceased|\bcease|step(ped|s)? down|demise|passed away|\bdeath\b|removal|removed|vacat|retire', re.I)
_IN = re.compile(r'\bappoint|\bre-?appoint|designat|elevat|induct|\bjoin', re.I)


def _role_named(text):
    return any(rx.search(text) for _, _, rx in _ROLES)


def people(text):
    """-> (event, role, action in | out | change | re) from the filing's words (the first role named)."""
    best = None
    for name, ev, rx in _ROLES:
        m = rx.search(text)
        if m and (best is None or m.start() < best[2]):
            best = (name, ev, m.start())
    if not best:
        return 'director', 'Director', ''
    name, ev, _ = best
    o, i = _OUT.search(text), _IN.search(text)
    act = 'change' if o and i else 'out' if o else ('re' if re.search(r're-?appoint|continuation', text, re.I) and i else 'in' if i else '')
    return ev, name, act


# ------------------------------------------------------------------ classification
def _text_events(text):
    found = []
    low = text.lower()
    for ev, rx in _TEXT:
        m = rx.search(low)
        if m:
            found.append((ev, m.group(0)))
    return found


def _subject_event(subject):
    for rx, ev, strong in _SUBJECTS:
        m = rx.search(subject)
        if m:
            return ev, strong, m.group(0)
    return 'other', False, ''


def classify(subject, text, pdf_text='', info=None):
    """NSE's subject + details text (+ the PDF's text) -> {ev, ex, cat, num, bi, gr, su, pr, risk, why, role, act}.
    info = {'rev': TTM revenue crore, 'mcap': market cap crore} for the sizes."""
    subject, text = _norm(subject), _norm(text)
    body = (subject + ' . ' + text + ' . ' + _norm(pdf_text)[:SCAN_PDF]).strip()
    sev, strong, sw = _subject_event(subject)
    if re.search(r'intimation|will be held|is scheduled|to consider', subject, re.I) and sev == 'results':
        sev, strong, sw = 'meeting', True, 'intimation'
    tev = _text_events(body)
    names = [e for e, _ in tev]
    # a meeting to consider results is a notice, not the results
    if 'results' in names and re.search(r'to consider and approve|will be held|is scheduled to|intimation of (the )?board meeting|'
                                        r'trading window', body, re.I) and not re.search(r'approved the|have approved|outcome', body, re.I):
        names = [e for e in names if e != 'results']
        if 'meeting' not in names:
            names.append('meeting')
    who = (text + ' . ' + _norm(pdf_text)[:SCAN_PDF]) if text else body     # the roles of the details (the subject lists them all)
    role = act = ''
    if sev == 'people':
        sev, role, act = people(who if _role_named(who) else body)
    if strong:
        ev, why = sev, 'NSE subject "%s"' % sw
    else:
        cand = [e for e in names if e not in ROUTINE and e != 'record'] or [e for e in names if e != sev]
        if cand:
            ev = max(cand, key=lambda e: max(EVENTS[e][2], EVENTS[e][3], EVENTS[e][4]))
            why = 'the words "%s"' % dict(tev).get(ev, ev)
        else:
            ev, why = sev, ('NSE subject "%s"' % sw) if sw else 'no rule matched'
    if ev in ('kmp', 'director', 'auditor') and not role:
        ev, role, act = people(who if _role_named(who) else body)
    if ev in ('meeting', 'comp', 'paper', 'call', 'present'):
        ex = [e for e in names if e in AGENDA and e != ev]
    else:
        ex = [e for e in names if e != ev and e not in ROUTINE and e not in ('press', 'other', 'clarify')]
        if EVENTS[ev][1] == 'E':
            ex = [e for e in ex if e != 'order']          # "a demand order of Rs ..." is no order win
    ex = ex[:4]
    num = numbers(ev, ex, body)
    if role:
        num['role'], num['act'] = role, act
    sc = score(ev, ex, num, info or {}, body)
    return dict(sc, ev=ev, ex=ex, cat=EVENTS[ev][1], num=num, why=why)


def _clamp(v):
    return int(max(0, min(100, round(v))))


def score(ev, ex, num, info, body=''):
    """The three scores (0-100) + priority + risk. Base scores of the event, then the filing's own figures: the order /
    deal value against the company's revenue (TTM, from its results table) or a fundraising against its market cap; a
    rating's direction; who left the company; a pledge invoked or released."""
    name, cat, bi, gr, su = EVENTS[ev]
    low = body.lower()
    rev, mcap = info.get('rev'), info.get('mcap')
    val = num.get('val')
    if val and rev and rev > 0 and ev in ('order', 'capex', 'acq', 'merger', 'jv', 'divest', 'update', 'press', 'other'):
        pct = val / rev * 100
        num['pct'] = round(pct, 1)
        if ev == 'order' and num.get('mo', 0) >= 12:
            num['pcty'] = round(pct * 12 / num['mo'], 1)       # a year's share of the order against a year's revenue
        for lim, b, s in ((50, 35, 25), (25, 25, 20), (10, 15, 12), (5, 8, 6)):
            if pct >= lim:
                bi, su = bi + b, su + s
                break
        else:
            if pct < 1:
                bi, su = bi - 12, su - 12
    if val and mcap and mcap > 0 and ev in ('fund', 'buyback', 'acq', 'divest'):
        mc = val / mcap * 100
        num['mc'] = round(mc, 1)
        for lim, b, s, g in ((20, 25, 20, 10), (10, 15, 12, 5), (5, 8, 6, 0)):
            if mc >= lim:
                bi, su = bi + b, su + s
                if ev == 'fund':
                    gr += g                                # dilution
                break
        else:
            if mc < 1:
                bi, su = bi - 10, su - 10
    if val and rev and rev > 0 and ev in ('legal', 'default'):
        pct = val / rev * 100
        num['pct'] = round(pct, 1)
        gr += 25 if pct >= 10 else 15 if pct >= 3 else 5 if pct >= 1 else -15 if pct < 0.5 else 0
    if ev == 'rating':
        a = num.get('ract')
        g = _grade_rank(num.get('rrt') or '')
        if a == 'up':
            bi, su = bi + 20, su + 25
        elif a == 'down':
            gr, su = gr + 50 + (20 if g is not None and g >= GRADES.index('BB+') else 0), su + 30
        elif a in ('watch-', 'outlook-'):
            gr, su = gr + 30, su + 15
        elif a == 'outlook+':
            bi, su = bi + 10, su + 10
        elif a == 'same':
            su -= 15
        if num.get('rrt') == 'D':
            gr = max(gr, 90)
    if ev in ('kmp', 'director', 'auditor'):
        role, act = num.get('role', ''), num.get('act', '')
        top = role in ('CEO', 'MD', 'CFO', 'Chairman', 'COO', 'Whole-time Director')
        if act in ('out', 'change'):
            if ev == 'auditor':
                gr, su = (80, 75) if 'resign' in low else (35, 40)
            elif top:
                gr, su = 65, 60
            elif ev == 'director':
                gr, su = (10, 10) if re.search(r'completion of (his |her |the )?(tenure|term)|retire', low) else (45, 40)
                if re.search(r'with immediate effect', low) and gr > 10:
                    gr += 10
            else:
                gr, su = 25, 25
            if re.search(r'demise|passed away|\bdeath\b', low):
                gr, su = max(gr, 40), max(su, 50)
        elif act == 're':
            gr, su, bi = 5, 5, 5
        elif act == 'in':
            gr, su, bi = 10, (40 if top else 20), (20 if top else 10)
    if ev == 'pledge':
        a = num.get('pact')
        gr = 80 if a == 'invoke' else 10 if a == 'release' else gr + (15 if (num.get('pl') or 0) >= 25 else 0)
        su = 70 if a == 'invoke' else 20 if a == 'release' else su
    if ev == 'legal' and re.search(r'in (favour|favor) of the company|in our favour|set aside the|quashed|dropped the (proceedings|demand)', low):
        gr, bi = 10, bi + 10
    if ev == 'dividend':
        if num.get('dty') == 'special':
            bi, su = bi + 10, su + 15
    if ev == 'update' and num.get('gr') is not None:
        g = num['gr']
        bi += 15 if g >= 25 else 8 if g >= 10 else -10 if g < 0 else 0
        su += 10 if abs(g) >= 25 else 0
        gr += 15 if g <= -15 else 0
    if ev in ('meeting', 'comp', 'paper', 'call', 'present') and ex:
        bi, su = max(bi, 20), max(su, 30)
    exg = max([EVENTS[e][3] for e in ex if e in RISK_EX] or [0])
    bi, gr, su = _clamp(bi), _clamp(max(gr, exg * 0.8)), _clamp(su)
    top = max(bi, gr)
    pr = next((p for p, lim in PRI if top >= lim), 'routine')
    if ev in ROUTINE and not ex:
        pr = 'routine'
    risk = cat == 'E' or gr >= 50
    if ev == 'pledge' and num.get('pact') == 'release':
        risk = False
    return {'bi': bi, 'gr': gr, 'su': su, 'pr': pr, 'risk': bool(risk)}


def filters_of(c):
    """The page's filters an announcement belongs to (besides 'all')."""
    evs = [c['ev']] + list(c.get('ex') or [])
    out = [f for f, e in FILTER_EVENTS.items() if any(x in e for x in (evs if f not in ('results', 'calls') else [c['ev']]))]
    if c['pr'] == 'high':
        out.append('high')
    if c['risk']:
        out.append('risk')
    return out


# ------------------------------------------------------------------ NSE's records
FIELDS = (('id', ('seqid', 'seqno', 'id')), ('sym', ('symbol',)), ('co', ('smname', 'companyname', 'company', 'name')),
          ('time', ('andt', 'sortdate', 'exchdisstime', 'broadcastdatetime', 'broadcastdate', 'dt', 'date')),
          ('sub', ('desc', 'subject', 'purpose')), ('tx', ('attchmnttext', 'details', 'attchmntdetails', 'text')),
          ('pdf', ('attchmntfile', 'attachment', 'file', 'pdf')), ('isin', ('smisin', 'isin')),
          ('ind', ('smindustry', 'industry')))
_FIELDS = dict(FIELDS)


def _key(k):
    return re.sub(r'[^a-z0-9]', '', str(k).lower())


def field(rec, name):
    keys = {_key(k): k for k in rec}
    for want in _FIELDS[name]:
        if want in keys and rec[keys[want]] not in (None, ''):
            return rec[keys[want]]
    return None


_TIMES = (re.compile(r'^(\d{1,2})[-/ ]([A-Za-z]{3})[a-z]*[-/ ](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?'),
          re.compile(r'^(\d{4})-(\d{2})-(\d{2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?'),
          re.compile(r'^(\d{1,2})[-/](\d{1,2})[-/](\d{4})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?'))


def nse_time(v):
    s = str(v or '').strip()
    m = _TIMES[0].match(s)
    try:
        if m and m.group(2).lower()[:3] in _MONTHS:
            y, mo, d = int(m.group(3)), _MONTHS[m.group(2).lower()[:3]], int(m.group(1))
        else:
            m = _TIMES[1].match(s)
            if m:
                y, mo, d = int(m.group(1)), int(m.group(2)), int(m.group(3))
            else:
                m = _TIMES[2].match(s)
                if not m:
                    return None
                d, mo, y = int(m.group(1)), int(m.group(2)), int(m.group(3))
        return datetime(y, mo, d, int(m.group(4)), int(m.group(5)), int(m.group(6) or 0)).strftime('%Y-%m-%d %H:%M:%S')
    except ValueError:
        return None


def record(rec):
    """One of NSE's announcement records -> our record, or None."""
    if not isinstance(rec, dict):
        return None
    sym = str(field(rec, 'sym') or '').strip().upper()
    at = nse_time(field(rec, 'time'))
    if not sym or not at or not re.match(r'^[A-Z0-9&_.-]{1,30}$', sym):
        return None
    sub = re.sub(r'\s+', ' ', str(field(rec, 'sub') or '')).strip()[:200]
    tx = re.sub(r'\s+', ' ', str(field(rec, 'tx') or '')).strip()[:TX_MAX]
    pdf = str(field(rec, 'pdf') or '').strip()
    if pdf and not pdf.lower().startswith('http'):
        pdf = ''
    rid = str(field(rec, 'id') or '').strip()
    if not re.match(r'^[A-Za-z0-9_-]{1,40}$', rid):
        rid = hashlib.md5(('%s|%s|%s|%s' % (sym, at, sub, pdf)).encode('utf-8')).hexdigest()[:16]
    return {'id': rid, 'sym': sym, 'co': re.sub(r'\s+', ' ', str(field(rec, 'co') or '')).strip()[:120], 'at': at, 'sub': sub,
            'tx': tx, 'pdf': pdf[:400], 'isin': str(field(rec, 'isin') or '')[:12], 'ind': str(field(rec, 'ind') or '')[:80]}


# ------------------------------------------------------------------ the archive (every announcement, never deleted)
def _day_path(day):
    return os.path.join(DIR, 'days', '%s.json.gz' % day)


def load_day(day):
    try:
        with gzip.open(_day_path(day), 'rt', encoding='utf-8') as f:
            d = json.load(f)
        return d.get('recs') if isinstance(d, dict) and isinstance(d.get('recs'), dict) else {}
    except (OSError, ValueError, EOFError):
        return {}


def _merge_rec(old, new):
    """The same announcement again: NSE's fields from the newer copy, the PDF's text / tries kept."""
    out = dict(old or {})
    for k, v in (new or {}).items():
        if k in ('pt', 'pdfSt', 'pdfAt', 'pdfPages'):
            if v or k not in out:
                out[k] = v
        elif v not in (None, '') or k not in out:
            out[k] = v
    return out


def save_day(day, recs):
    """Writes the day's records (merged with the file - another program may have added some)."""
    with _LOCK:
        cur = load_day(day)
        for k, r in recs.items():
            cur[k] = _merge_rec(cur.get(k), r)
        p = _day_path(day)
        os.makedirs(os.path.dirname(p), exist_ok=True)
        tmp = '%s.%d.tmp' % (p, os.getpid())
        with gzip.open(tmp, 'wt', encoding='utf-8') as f:
            json.dump({'v': 1, 'day': day, 'recs': cur}, f, separators=(',', ':'))
        for n in range(20):
            try:
                os.replace(tmp, p)
                break
            except PermissionError:
                time.sleep(1)
        else:
            try:
                os.remove(tmp)
            except OSError:
                pass
        return cur


def archive_days():
    try:
        return sorted(n[:10] for n in os.listdir(os.path.join(DIR, 'days')) if re.match(r'^\d{4}-\d{2}-\d{2}\.json\.gz$', n))
    except OSError:
        return []


def take(records):
    """NSE's announcement records -> the archive. -> {day: number of new or changed records}."""
    by_day = {}
    for raw in records or []:
        r = record(raw)
        if r:
            by_day.setdefault(r['at'][:10], {})[r['id']] = r
    out = {}
    with _LOCK:
        for day, recs in by_day.items():
            old = load_day(day)
            changed = {k: v for k, v in recs.items() if k not in old or any(old[k].get(f) != v.get(f) for f in ('sub', 'tx', 'pdf', 'co'))}
            if changed:
                save_day(day, changed)
                out[day] = len(changed)
    return out


# ------------------------------------------------------------------ state
def load_state():
    try:
        with open(STATE_PATH, encoding='utf-8') as f:
            st = json.load(f)
        return st if isinstance(st, dict) else {}
    except (OSError, ValueError):
        return {}


def save_state(st):
    try:
        tmp = STATE_PATH + '.tmp'
        with open(tmp, 'w', encoding='utf-8') as f:
            json.dump(st, f)
        os.replace(tmp, STATE_PATH)
    except OSError:
        pass


def main_stocks(cfg, api, st, out=None, force=False):
    """Main's stocks {SYM: [name, market cap crore]} (asked again every SYMS_EVERY_S) -> (dict, refusal words)."""
    out = out or log
    if force or not st.get('syms') or time.time() - float(st.get('symsAt') or 0) > SYMS_EVERY_S:
        try:
            ans = api(cfg, 'corp', {'op': 'syms'}, tries=2, timeout=120)
        except RuntimeError as e:
            ans = {'ok': False, 'error': str(e)}
        if ans.get('ok') and isinstance(ans.get('syms'), dict):
            st['syms'], st['symsAt'] = ans['syms'], time.time()
        elif 'unknown action' in str(ans.get('error') or ''):
            return st.get('syms') or {}, OLD_APP
        elif not st.get('syms'):
            return {}, 'the sheet did not give your stocks (%s)' % (ans.get('error') or 'no answer')
    return st.get('syms') or {}, ''


OLD_APP = ('the sheet does not know Corporate Intelligence yet - the laptop\'s updater puts the new sheet code in (UpdateNow.bat), '
           'then the announcements are sent')


def info_of(sym, syms):
    """{rev, mcap} of a stock: TTM revenue from its results table (the newest 4 quarters), market cap from Main."""
    out = {}
    v = syms.get(sym)
    if isinstance(v, list) and len(v) > 1 and isinstance(v[1], (int, float)) and v[1] > 0:
        out['mcap'] = float(v[1])
    try:
        r = D['revenue'](sym) if D.get('revenue') else None
        if r and r > 0:
            out['rev'] = float(r)
    except Exception:
        pass
    return out


def ttm_revenue(table):
    """A results table (xbrl_history) -> the sum of its newest 4 quarters' Sales (crore), when they follow each other."""
    q = (table or {}).get('q') or []
    rows = [r for r in q if isinstance(r, list) and len(r) >= 2 and isinstance(r[1], list) and r[1] and r[1][0] is not None]
    if len(rows) < 4:
        return None
    last = rows[-4:]
    idx = []
    for r in last:
        m = re.match(r'^([A-Za-z]{3}) (\d{4})', str(r[0]))
        if not m or m.group(1).lower() not in _MONTHS:
            return None
        idx.append(int(m.group(2)) * 12 + _MONTHS[m.group(1).lower()])
    if any(b - a != 3 for a, b in zip(idx, idx[1:])):
        return None
    return sum(float(r[1][0]) for r in last)


# ------------------------------------------------------------------ what the website gets
COLS = ('id', 'sym', 'co', 'at', 'cat', 'ev', 'ex', 'pr', 'bi', 'gr', 'su', 'risk', 'num', 'sub', 'tx', 'pdf', 'pg', 'why')


_MEMO = {}


def classify_rec(r, info):
    """classify() of an archive record, remembered while the program runs (the same record is packed again and again)."""
    key = hashlib.md5(json.dumps([r.get('sub'), r.get('tx'), r.get('pt') or '', info, RULES_VERSION], sort_keys=True)
                      .encode('utf-8')).hexdigest()
    c = _MEMO.get(key)
    if c is None:
        if len(_MEMO) > 60000:
            _MEMO.clear()
        c = _MEMO[key] = classify(r.get('sub'), r.get('tx'), r.get('pt') or '', info)
    return json.loads(json.dumps(c))


def site_row(r, syms):
    c = classify_rec(r, info_of(r['sym'], syms))
    name = syms.get(r['sym'])
    co = (name[0] if isinstance(name, list) and name and name[0] else r.get('co')) or r['sym']
    pg = 'r' if r.get('pdfSt') == 'ok' else 'x' if r.get('pdfSt') == 'none' else ''
    return {'id': r['id'], 'sym': r['sym'], 'co': co, 'at': r['at'], 'cat': c['cat'], 'ev': c['ev'], 'ex': c['ex'], 'pr': c['pr'],
            'bi': c['bi'], 'gr': c['gr'], 'su': c['su'], 'risk': 1 if c['risk'] else 0, 'num': c['num'], 'sub': r.get('sub', ''),
            'tx': (r.get('tx') or '')[:SITE_TX], 'pdf': r.get('pdf') if PDF_HOSTS.match(r.get('pdf') or '') else '', 'pg': pg,
            'why': c['why'][:120]}


def day_rows(day, syms):
    rows = [site_row(r, syms) for r in load_day(day).values() if r.get('sym') in syms]
    return sorted(rows, key=lambda x: (x['at'], x['id']), reverse=True)


def summary(rows):
    cats = {k: 0 for k, _ in CATS}
    evs = {}
    for r in rows:
        cats[r['cat']] = cats.get(r['cat'], 0) + 1
        evs[r['ev']] = evs.get(r['ev'], 0) + 1
    return {'n': len(rows), 'stocks': len({r['sym'] for r in rows}), 'high': sum(1 for r in rows if r['pr'] == 'high'),
            'risk': sum(1 for r in rows if r['risk']), 'cats': cats, 'evs': evs}


def pack(rows):
    body = json.dumps({'cols': list(COLS), 'rows': [[r.get(k) for k in COLS] for r in rows]}, separators=(',', ':'))
    return base64.b64encode(gzip.compress(body.encode('utf-8'), 9, mtime=0)).decode('ascii')


def unpack(blob):
    d = json.loads(gzip.decompress(base64.b64decode(blob)).decode('utf-8'))
    return [dict(zip(d['cols'], r)) for r in d['rows']]


def ist_today():
    return datetime.now(IST).date()


def post_days(cfg, api, days, st, syms, force=False, out=None):
    """The sheet's days (the last SHEET_DAYS) whose rows changed -> op 'put', POST_MAX_DAYS at a time. -> days sent or None."""
    out = out or log
    today = ist_today()
    first = (today - timedelta(days=SHEET_DAYS - 1)).isoformat()
    sent = st.setdefault('sent', {})
    for k in [k for k in sent if k < first]:
        del sent[k]
    todo = []
    for day in sorted({d for d in days if first <= d <= today.isoformat()}, reverse=True):
        rows = day_rows(day, syms)
        if not rows and day not in sent:
            continue                                 # nothing that day (and nothing there before)
        blob = pack(rows)
        md5 = hashlib.md5(('%s|%d|%d' % (blob, ENGINE, RULES_VERSION)).encode('ascii')).hexdigest()
        if force or sent.get(day) != md5:
            todo.append((day, rows, blob, md5))
    n = 0
    for i in range(0, len(todo), POST_MAX_DAYS):
        part = todo[i:i + POST_MAX_DAYS]
        body = {'op': 'put', 'engine': ENGINE, 'keep': SHEET_DAYS, 'made': datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S'),
                'days': [{'day': d, 'n': len(rows), 'sum': summary(rows), 'blob': blob} for d, rows, blob, _ in part]}
        try:
            ans = api(cfg, 'corp', body, tries=2, timeout=240)
        except RuntimeError as e:
            ans = {'ok': False, 'error': 'could not send (%s)' % e}
        if not ans.get('ok'):
            err = str(ans.get('error') or 'unknown error')
            out('Corporate Intelligence: %s - the next round tries again.' % (OLD_APP if 'unknown action' in err else 'the sheet refused - %s' % err))
            return None if not n else n
        for d, _, _, md5 in part:
            sent[d] = md5
            n += 1
        save_state(st)
    return n


def back_window(today, st):
    """The first run's older days (BACK_DAYS back, before the usual window of ann_step) not read yet -> (first, last) or None."""
    have = set(st.get('backDays') or [])
    days = [today - timedelta(days=k) for k in range(4, BACK_DAYS + 1)]
    todo = [d for d in days if d.isoformat() not in have]
    return (min(todo), max(todo)) if todo else None


def words(rows):
    s = summary(rows)
    return ('%d announcement(s) of %d of your stocks - %d high-impact, %d risk alert(s); %s'
            % (s['n'], s['stocks'], s['high'], s['risk'], ', '.join('%s %d' % (k, v) for k, v in s['cats'].items() if v) or '-'))


def step(cfg, api, records, today=None, fetch_back=None, out=None):
    """The results check's step (never raises): NSE's records (today + 3 days back, already read by ann_step) -> the archive;
    the first time also the older days up to a week back (`fetch_back(first, last)` -> records or None, one NSE request);
    then the changed days -> the sheet. -> days sent or None."""
    out = out or log
    if cfg.get('corp_intel') is False:
        return None
    try:
        today = today or ist_today()
        st = load_state()
        got = take(records)
        win = back_window(today, st)
        if win and fetch_back:
            recs = fetch_back(win[0], win[1])
            if recs is not None:
                got.update({d: n for d, n in take(recs).items()})
                st['backDays'] = sorted(set(st.get('backDays') or []) | {(win[0] + timedelta(days=k)).isoformat()
                                                                         for k in range((win[1] - win[0]).days + 1)})
                out('Corporate Intelligence: the announcements of %s .. %s read too (the first week).'
                    % (win[0].strftime('%d-%m'), win[1].strftime('%d-%m')))
        syms, refused = main_stocks(cfg, api, st, out)
        if refused:
            out('Corporate Intelligence: %s.' % refused)
            save_state(st)
            return None
        days = set(got)
        if st.get('rules') != [ENGINE, RULES_VERSION]:
            days |= {(today - timedelta(days=k)).isoformat() for k in range(SHEET_DAYS)}
        n = post_days(cfg, api, days, st, syms, out=out)
        if n is not None:
            st['rules'] = [ENGINE, RULES_VERSION]
        save_state(st)
        rows = day_rows(today.isoformat(), syms)
        out('Corporate Intelligence: %d new / changed announcement(s) kept on this laptop; today %s%s.'
            % (sum(got.values()), words(rows), ' - %d day(s) sent to the sheet' % n if n else ''))
        return n
    except Exception as e:                         # never stops a results check
        out('Corporate Intelligence: %s' % e)
        return None


# ------------------------------------------------------------------ PDFs (pypdf)
def pdf_reader(st=None, out=None, install=None, force=False):
    """pypdf, installed for this user the first time (pip --user; tried again after PIP_RETRY_S). -> the module or None."""
    out = out or log
    try:
        return importlib.import_module('pypdf')
    except ImportError:
        pass
    st = st if st is not None else load_state()
    p = st.get('pip') or {}
    if not force and time.time() - float(p.get('at') or 0) < PIP_RETRY_S:
        return None
    out('Corporate Intelligence: the PDF reader (pypdf) is not on this laptop - installing it once (python -m pip install --user pypdf) ...')
    ok, why = (install or pip_install)()
    st['pip'] = {'at': time.time(), 'ok': ok, 'why': why[:300]}
    save_state(st)
    if not ok:
        out('Corporate Intelligence: pypdf could not be installed (%s) - run InstallPdfReader.bat once; the announcements '
            'are sorted from NSE\'s text meanwhile.' % why[:200])
        return None
    try:
        site.addsitedir(site.getusersitepackages())
    except Exception:
        pass
    importlib.invalidate_caches()
    try:
        mod = importlib.import_module('pypdf')
        out('Corporate Intelligence: pypdf installed - the PDFs are read from now on.')
        return mod
    except ImportError as e:
        out('Corporate Intelligence: pypdf was installed but cannot be loaded yet (%s) - it works after the next restart.' % e)
        return None


def pip_install(show=False):
    """python -m pip install --user pypdf -> (ok, words)."""
    exe = sys.executable or 'python'
    if os.path.basename(exe).lower() == 'pythonw.exe':
        alt = os.path.join(os.path.dirname(exe), 'python.exe')
        exe = alt if os.path.exists(alt) else exe
    cmd = [exe, '-m', 'pip', 'install', '--user', '--disable-pip-version-check', '--no-input', 'pypdf']
    kw = {'timeout': 600}
    if not show:
        kw.update(capture_output=True, text=True)
        if os.name == 'nt':
            kw['creationflags'] = 0x08000000           # CREATE_NO_WINDOW
    try:
        r = subprocess.run(cmd, **kw)
    except (OSError, subprocess.SubprocessError) as e:
        return False, str(e)
    tail = ((getattr(r, 'stdout', '') or '') + (getattr(r, 'stderr', '') or '')).strip().splitlines()
    return r.returncode == 0, (tail[-1] if tail else 'exit code %s' % r.returncode)


def pdf_text(raw, reader):
    """A PDF's bytes -> (text of its first PDF_PAGES pages, pages) or raises ValueError."""
    if not raw or raw[:5] != b'%PDF-':
        raise ValueError('not a PDF')
    rd = reader.PdfReader(io.BytesIO(raw), strict=False)
    if getattr(rd, 'is_encrypted', False):
        try:
            rd.decrypt('')
        except Exception:
            raise ValueError('a locked PDF')
    parts, n = [], len(rd.pages)
    for k in range(min(n, PDF_PAGES)):
        try:
            parts.append(rd.pages[k].extract_text() or '')
        except Exception:
            continue
        if sum(len(p) for p in parts) > PT_MAX * 2:
            break
    return re.sub(r'[ \t\r\f\v]+', ' ', '\n'.join(parts)).strip()[:PT_MAX], n


def pdf_todo(syms, today=None, limit=50):
    """The Main stocks' filings whose PDF is worth reading and not read yet, newest first -> [(day, id)]."""
    today = today or ist_today()
    out = []
    for k in range(PDF_BACK_DAYS):
        day = (today - timedelta(days=k)).isoformat()
        recs = load_day(day)
        for r in sorted(recs.values(), key=lambda x: x['at'], reverse=True):
            if r.get('sym') not in syms or r.get('pdfSt') or not PDF_HOSTS.match(r.get('pdf') or '') or \
                    not r['pdf'].lower().split('?')[0].endswith('.pdf'):
                continue
            c = classify_rec({'sub': r.get('sub'), 'tx': r.get('tx')}, {})
            if c['ev'] in PDF_EVENTS or any(e in PDF_EVENTS for e in c['ex']):
                out.append((day, r['id']))
                if len(out) >= limit:
                    return out
    return out


def read_pdf(day, rid, reader, get=None):
    """Downloads one filing's PDF and keeps its text in the archive -> 'ok' | 'none' | 'err:...' | 'retry'."""
    get = get or D.get('get')
    recs = load_day(day)
    r = recs.get(rid)
    if not r or not get:
        return 'err:gone'
    try:
        status, raw = get(r['pdf'])
    except Exception as e:
        return 'retry' if 'timed out' in str(e) or 'reset' in str(e).lower() else 'err:%s' % str(e)[:80]
    if status in (401, 403, 429, 500, 502, 503, 504) or status is None:
        return 'retry'
    st = 'err:HTTP %s' % status
    upd = {'pdfAt': datetime.now(IST).strftime('%Y-%m-%d %H:%M:%S')}
    if status == 200:
        if len(raw or b'') > PDF_MAX_BYTES:
            st = 'err:too big'
        else:
            try:
                text, pages = pdf_text(raw, reader)
                st = 'ok' if len(text) >= 40 else 'none'
                upd.update(pt=text, pdfPages=pages)
            except Exception as e:
                st = 'err:%s' % str(e)[:80]
    upd['pdfSt'] = st if st in ('ok', 'none') else st
    save_day(day, {rid: dict(r, **upd)})
    return st


def pdf_day_count(st, today=None):
    t = (today or ist_today()).isoformat()
    d = st.get('pdfDay') or {}
    return d.get('n', 0) if d.get('d') == t else 0


def pdf_count_up(st, today=None):
    t = (today or ist_today()).isoformat()
    d = st.get('pdfDay') or {}
    st['pdfDay'] = {'d': t, 'n': (d.get('n', 0) if d.get('d') == t else 0) + 1}


# ------------------------------------------------------------------ the website's questions (older days / a company)
def answer_rows(key, syms, limit=OLDER_MAX):
    """'day:yyyy-mm-dd' -> that day's rows; 'sym:SYMBOL' -> every filing of the company in the archive, newest first."""
    kind, _, v = str(key).partition(':')
    if kind == 'day' and re.match(r'^\d{4}-\d{2}-\d{2}$', v):
        return day_rows(v, syms)[:limit]
    if kind == 'sym' and re.match(r'^[A-Z0-9&_.-]{1,30}$', v):
        rows = []
        for day in reversed(archive_days()):
            for r in load_day(day).values():
                if r.get('sym') == v:
                    rows.append(site_row(r, syms if v in syms else dict(syms, **{v: [r.get('co') or v, None]})))
            if len(rows) >= limit:
                break
        return sorted(rows, key=lambda x: x['at'], reverse=True)[:limit]
    return None


def answer(cfg, api, key, syms, out=None):
    out = out or log
    rows = answer_rows(key, syms)
    if rows is None:
        return False
    days = archive_days()
    body = {'op': 'older', 'key': key, 'n': len(rows), 'blob': pack(rows), 'from': days[0] if days else '', 'engine': ENGINE}
    try:
        ans = api(cfg, 'corp', body, tries=2, timeout=180)
    except RuntimeError as e:
        ans = {'ok': False, 'error': str(e)}
    if not ans.get('ok'):
        out('Corporate Intelligence: the website asked for %s - not sent (%s).' % (key, ans.get('error')))
        return False
    out('Corporate Intelligence: the website asked for %s - %d announcement(s) sent from this laptop.' % (key, len(rows)))
    return True


class Worker:
    """The background program's part (its own thread): the PDFs, one at a time, and the website's questions."""

    def __init__(self, sleep=time.sleep, clock=time.time):
        self.thread, self.stop = None, threading.Event()
        self.sleep, self.clock = sleep, clock
        self.next_ask, self.next_post, self.dirty = 0.0, 0.0, set()
        self.queue, self.next_queue = [], 0.0
        self.next_start, self.said = 0.0, ''

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_start(self, cfg, api, nse_busy=None):
        if cfg.get('corp_intel') is False or not cfg.get('url') or self.busy() or self.clock() < self.next_start:
            return False
        self.thread = threading.Thread(target=self.loop, args=(cfg, api, nse_busy or (lambda: False)), name='corp-intel', daemon=True)
        self.thread.start()
        return True

    def ask(self, cfg, api, syms, wait):
        try:
            ans = api(cfg, 'corp', {'op': 'ask', 'wait': wait}, tries=1, timeout=wait + 60)
        except RuntimeError:
            return ASK_IDLE_S
        if not ans.get('ok'):
            return 30 * 60 if 'unknown' in str(ans.get('error') or '') else ASK_IDLE_S
        for key in (ans.get('asks') or [])[:5]:
            answer(cfg, api, key, syms)
        nxt = ans.get('next')
        return float(nxt) if isinstance(nxt, (int, float)) and 0 <= nxt <= 3600 else ASK_IDLE_S

    def once(self, cfg, api, nse_busy, st, reader):
        """One turn: the website's questions when due, one PDF, the changed days when due. -> seconds to wait."""
        syms = st.get('syms') or {}
        now = self.clock()
        if now >= self.next_ask and syms:
            self.next_ask = now + max(0.0, self.ask(cfg, api, syms, 20))
        wait = PDF_GAP_S
        if reader and syms and pdf_day_count(st) < PDF_PER_DAY and not nse_busy():
            if not self.queue and self.clock() >= self.next_queue:
                self.queue = pdf_todo(syms, limit=200)        # the list made once (it reads 30 days of the archive)
                self.next_queue = self.clock() + POST_EVERY_S
            if self.queue:
                day, rid = self.queue.pop(0)
                res = read_pdf(day, rid, reader)
                if res == 'retry':
                    wait = 120.0
                    self.queue.append((day, rid))
                else:
                    pdf_count_up(st)
                    self.dirty.add(day)
                save_state(st)
            else:
                wait = 60.0
        if self.dirty and (self.clock() >= self.next_post or len(self.dirty) >= POST_MAX_DAYS):
            n = post_days(cfg, api, self.dirty, st, syms)
            if n is not None:
                self.dirty.clear()
            self.next_post = self.clock() + POST_EVERY_S
            save_state(st)
        return min(wait, max(1.0, self.next_ask - self.clock()))

    def loop(self, cfg, api, nse_busy):
        st = load_state()
        syms, refused = main_stocks(cfg, api, st)
        save_state(st)
        if refused:
            if refused != self.said:                    # said once - the thread is started again in 30 minutes
                log('Corporate Intelligence: %s.' % refused)
                self.said = refused
            self.next_start = self.clock() + 30 * 60
            return
        reader = pdf_reader(st)
        while not self.stop.is_set():
            try:
                st = load_state()
                if not st.get('syms') or self.clock() - float(st.get('symsAt') or 0) > SYMS_EVERY_S:
                    main_stocks(cfg, api, st)
                    save_state(st)
                if reader is None and time.time() - float((st.get('pip') or {}).get('at') or 0) > PIP_RETRY_S:
                    reader = pdf_reader(st)
                w = self.once(cfg, api, nse_busy, st, reader)
            except Exception as e:                  # the thread never dies on one bad PDF
                log('Corporate Intelligence: %s' % e)
                w = 60.0
            self.sleep(w)


# ------------------------------------------------------------------ CorpNow.bat
def now(cfg, api, fetch, syms_filter=(), pdfs=200, out=print, today=None):
    """CorpNow.bat: NSE's announcements of the past week (one request), the archive, up to `pdfs` PDFs, everything sent;
    then the day's figures and the asked stocks' filings printed."""
    today = today or ist_today()
    st = load_state()
    recs = fetch(today - timedelta(days=BACK_DAYS), today)
    if recs is None:
        out('Could not read NSE\'s announcements just now - try again in a few minutes.')
        return 1
    got = take(recs)
    st['backDays'] = sorted(set(st.get('backDays') or []) | {(today - timedelta(days=k)).isoformat() for k in range(4, BACK_DAYS + 1)})
    out('NSE: %d announcement(s) of %s .. %s; %d new / changed kept on this laptop (%s).'
        % (len(recs), (today - timedelta(days=BACK_DAYS)).strftime('%d-%m'), today.strftime('%d-%m'), sum(got.values()), DIR))
    syms, refused = main_stocks(cfg, api, st, out, force=True)
    if refused:
        out(refused)
        save_state(st)
        return 1
    reader = pdf_reader(st, out)
    if reader and pdfs:
        todo = pdf_todo(syms, today, limit=pdfs)
        out('PDFs to read: %d (one every %g s - about %d min) ...' % (len(todo), PDF_GAP_S, round(len(todo) * PDF_GAP_S / 60)))
        done = {}
        for k, (day, rid) in enumerate(todo):
            res = read_pdf(day, rid, reader)
            done[res.split(':')[0]] = done.get(res.split(':')[0], 0) + 1
            if (k + 1) % 20 == 0:
                out('   %d of %d PDFs read (%s)' % (k + 1, len(todo), ', '.join('%s %d' % kv for kv in sorted(done.items()))))
            if k + 1 < len(todo):
                time.sleep(PDF_GAP_S)
        if todo:
            out('PDFs: %s.' % ', '.join('%s %d' % kv for kv in sorted(done.items())))
    n = post_days(cfg, api, {(today - timedelta(days=k)).isoformat() for k in range(SHEET_DAYS)}, st, syms, force=True, out=out)
    st['rules'] = [ENGINE, RULES_VERSION]
    save_state(st)
    out('Sent to the sheet: %s day(s).' % (n or 0))
    for k in range(BACK_DAYS + 1):
        day = (today - timedelta(days=k)).isoformat()
        rows = day_rows(day, syms)
        if rows:
            out('%s: %s' % (day, words(rows)))
    for sym in syms_filter:
        rows = answer_rows('sym:' + sym.upper(), syms, 30) or []
        out('')
        out('%s - %d announcement(s) on this laptop:' % (sym.upper(), len(rows)))
        for r in rows[:30]:
            nm = ', '.join('%s %s' % (k, v) for k, v in r['num'].items())
            out('  %s  %s / %s  %s  impact %d risk %d surprise %d  %s%s' % (r['at'][:16], r['cat'], EVENTS[r['ev']][0], r['pr'], r['bi'],
                                                                      r['gr'], r['su'], r['sub'][:60], ('  [' + nm + ']') if nm else ''))
    return 0
