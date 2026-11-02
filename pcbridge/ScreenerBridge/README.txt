SCREENER BRIDGE - what is this?
screener.in blocks Google's servers, so your Google Sheet cannot read it.
This small program runs on YOUR PC, reads screener.in for the sheet, and hands the data back.

SETUP (one time)
 1. Install Python from https://www.python.org/downloads/  -  tick "Add python.exe to PATH" on the first screen.
 2. In your sheet: Auto Bhavcopy > 3. Quarterly Results & Trend Tags > PC Bridge: setup info.
 3. Double-click Setup.bat here and paste the two values when asked.

AFTER THAT it starts by itself every time you log in to Windows and stays in the background (no window) while the
computer is on - no time limit:
 - a FULL ROUND 1 minute after log-in (as soon as the internet is connected), another 1 hour later, then every 3 hours;
 - in between, every 30 minutes, the RESULTS CHECK (a few minutes at most): NSE's result filings -> the XBRL figures of
   the results filed (official, with EPS) -> moneycontrol for those NSE has no XBRL of yet -> the sheet writes them in
   Main, ticks the Checkbox and emails the NEW results (a small email, only when something new came). No screener.in.
 - A computer that slept carries on when it wakes; without internet it tries again a minute later.
 - config.json: "quick_check_minutes": 30 (0 = no results check), "full_round_every_hours": 3 (0 = only the two
   rounds after log-in, as before).
 - RunNow.bat       do one full round right now
 - QuickCheckNow.bat   do the results check once right now
 - Reschedule.bat   remove the old hourly schedule and use the log-in schedule (keeps your settings)
 - TestConnection.bat   check sheet + screener.in + NSE (price bands, IPO lists, end-of-day files, announcements, event calendar) + moneycontrol access
 - PriceBandsNow.bat    download NSE's price band changes and send them to the sheet right now
 - IposNow.bat          read NSE's IPO lists and update the sheet's IPO Tracker tab right now
 - EodNow.bat           download NSE's end-of-day files (Delivery %, 52-week highs, market statistics) right now
 - History60Now.bat       send the daily candles the sheet's History60 tab is missing right now (the first fill)
 - AnnouncementsNow.bat   send WHEN NSE got each company's results (last 4 days) right now
 - CalendarNow.bat        add NSE's forthcoming result meetings missing from the Results tab right now
 - MoneycontrolCheck.bat   show the latest quarterly results moneycontrol has for the symbols you type (sends nothing)
 - XbrlCheck.bat           read NSE's XBRL results files for the symbols you type and compare them with screener.in (sends nothing)
 - bridge.log       what it did (open with Notepad)
To stop it: run  python screener_bridge.py uninstall

NSE PRICE BAND CHANGES (no more copy/paste)
Every round also downloads NSE's "Price Band changes from next trade date (csv)"
(NSE > All Reports > Equities & SME, file eq_band_changes_DDMMYYYY.csv) and sends it to the sheet.
The sheet files it on the "Price Band Changes" tab and sends the usual email once for the day.
 - NSE publishes it in the evening. If it is not there yet, the next full round tries again;
   days missed while the PC was off are caught up (up to a week back, filed without an email).
 - pricebands_state.json   remembers the last day the sheet received.
 - bridge.log shows "Price bands dd-mm-yyyy: ..." for each day.
 - If NSE ever refuses, the old way still works: paste into the "Priceband" tab and use
   Auto Bhavcopy > 10. NSE Price Bands > Import Pasted Rows.
 - To switch it off: in config.json add  "price_bands": false

NSE IPO LISTS (IPO Tracker tab, New IPOs / IPOs / Main by themselves, one email a day)
Every round also reads NSE > Market Data > IPO (Current, Past Issues, Upcoming Issues) and sends it to
the sheet, with NSE's trading holidays and - for closed mainboard issues - NSE's quote of the symbol
(listing date, Basic Industry) and the listing day's candle from the bhavcopy. The sheet:
 - rebuilds the "IPO Tracker" tab: Open now / Closed - awaiting listing / Upcoming / Listed recently
   (last 14 days: issue price, listing price = the listing day's open, gains). Mainboard equity issues
   only (EQ and BE) - SME and debt issues such as NCDs are left out. A listing date NSE has not given yet
   is shown as the T+3 day (3 trading days after the close, SEBI's timeline) marked "expected";
 - adds each closed issue to the "New IPOs" tab (DATE OF LISTING once NSE confirms it, NOTE column);
 - on the listing day adds it to the IPOs tab and Main (once - a stock you delete is not added back),
   fills the IPOs tab's LISTING PRICE (listing-day open), Main's Basic Industry / Sector / Industry and
   Main's INDICES (NIFTY IPO) when they are blank;
 - sends ONE email the first time each day: listings today / next trading day first, then all sections.
The website's IPOs & Markets page shows the same tab. The IPO lists are read in the full rounds (log-in, an hour
later, then every 3 hours): when the PC is off, nothing is added until its next round.
 - bridge.log shows "IPO lists: ..." for each round (and what was added).
 - ipo_state.json keeps NSE's holidays, quotes and listing-day candles. When NSE's quote gives no Basic
   Industry, bridge.log says "NSE quote gave no Basic Industry yet for ..." with what each link answered;
   TestConnection line 4 ("quote:") checks it for the newest listed issue.
 - To switch it off: in config.json add  "ipos": false   (the email: Control Panel > IPOs)

NSE END-OF-DAY: DELIVERY %, 52-WEEK HIGHS, MARKET STATISTICS
Every round also downloads three NSE files of each trading day (NSE > All Reports > Equities, out in
the evening) and sends a summary to the sheet:
 - "Full Bhavcopy and Security Deliverable data": only the Delivery % of each stock is kept (no prices or
   volumes); the prices are used just to count stocks traded, advances, declines and unchanged.
 - "52 Week High Low Report": each stock's 52-week high and its date (52-week lows are not kept).
 - "CM - Price Band complete list": used only to count the stocks that closed at the upper / lower band.
The sheet counts YOUR Main stocks only (not the whole market) and fills four tabs: "Market Statistics"
(one row per day: traded, advances, declines, unchanged, at a 52-week high, upper / lower circuit),
"Market Day" (those stocks on the newest day - the lists behind the website's numbers), "Delivery %"
(your Main stocks, last 10 days) and "52 Week High" (new highs of the day + every Main stock). The website
shows them: Overview (Market statistics - click a number for its list), IPOs & Markets (52-week highs),
Watchlist and the stock details (Delivery %).
 - Days missed while the PC was off are caught up (up to a week back). eod_state.json remembers the last day.
 - bridge.log shows "NSE end-of-day dd-mm-yyyy: ..." for each day.
 - To switch it off: in config.json add  "eod": false

RESULTS: NSE XBRL FIRST, SCREENER.IN AFTER (since 02-Nov-2026)
A round used to take 40 minutes in the results season: screener.in lets about 12 pages through every 3 minutes, and
it was asked every company whose results were due. Now:
 - the 30-minute results check asks NSE only for companies that FILED their results (NSE's announcements) - XBRL first;
 - the full round asks screener.in only when it can help:
     * a company that filed and is not in Main yet: every full round (once a day after 3 days);
     * a company NSE shows no filing of: not on its result day (the results check sees the filing), then once a day;
     * a company already filled from NSE XBRL: once a day (only Promotor / FII / OPM YoY are still wanted);
     * screener.in said "not found" (404): left alone for a week;
 - moneycontrol: only for companies that filed but have no XBRL yet, each at most once an hour; a company
   moneycontrol shows no quarterly figures of is left alone for a week (moneycontrol_codes.json remembers);
 - NSE XBRL of a company without a filing seen, and the exceptional-gain look-ups: once a day (xbrl_state.json).
The Results Update email of each check / round lists only the results that are NEW in it (the tiles still count the
whole day). The sheet menu's "Re-send Results Update email (no fetch)" shows the whole day.

IF THE COMPUTER GOES OFF IN THE MIDDLE OF A ROUND
A round can take half an hour (screener.in asks it to slow down now and then). If the computer is shut
down or the program is closed half-way, the next round CONTINUES it (within 12 hours): the sheet first
processes the pages it already got (Results Day + the email), those pages are not fetched again, and then
the rest of the round runs (the other pages, processing).
 - run_state.json   remembers what the current round has sent.
 - bridge.lock      shows a round is running. A lock left behind by a round that is gone (program closed,
   computer restarted) no longer blocks the next round; while a round really runs, a new one waits up
   to 12 minutes for it and then skips.
 - bridge.log says "Continuing the round of ... that stopped half-way".

HISTORY60: 60 DAYS OF DAILY CANDLES (FVG scans + Results Performance)
The same bhavcopy also has each stock's Open / High / Low / Close / Volume. Every round the program sends
the trading days the sheet's "History60" tab is missing (the sheet keeps 60 days of your PatternData
stocks). The sheet's FVG scans (FVG column, GapUpFVG, UnmitigatedFVG) and Results Performance then look
60 days back. History30 (GOOGLEFINANCE) still needs no PC: when the PC is off, those simply see 30 days.
 - Needs the latest Code.gs in the sheet AND its New version deploy (Deploy > Manage deployments >
   pencil > Version: New version > Deploy). Until then bridge.log says "do the New version deploy".
 - The first round fills about 60 days (around 60 downloads - a few minutes). After that one day a round.
   History60Now.bat does it at once.
 - Splits / bonus issues: NSE's prices are not adjusted, so the sheet adjusts the older days itself
   (from NSE's previous close on the ex-date) and matches them to GOOGLEFINANCE where History30 starts.
 - A stock GOOGLEFINANCE gives no data for gets its candles from History60 in Phase 1 (AutoFetch Log:
   "From History60 ...").
 - history_state.json remembers exchange holidays (a past weekday with no bhavcopy, twice).
 - bridge.log shows "History60: ..." lines.
 - To switch it off: in config.json add  "history60": false

RESULT ANNOUNCEMENT TIMES (before / during / after market hours)
Every results check (30 minutes) and round reads NSE's corporate announcements of the last 4 days (one request) and sends the
quarterly-result filings to the sheet with their exact time. The sheet shows:
 - Results Tracker, column "Announced": e.g. "29/10 17:05 After market".
 - Results Update email: a pill under the result date (AFTER MKT 17:05 /
   MKT HOURS 13:20 / BEFORE MKT 08:40).
 - Results Performance: for results filed after 3:30 PM the reaction day is the NEXT session and the
   baseline that day's close (column "Reaction From").
 - When a round runs BEFORE 9:15 AM on a weekday: one email "Before the open: N results filed after the
   last close" - so switch the PC on before 9:15 to get it (Control Panel can switch it off).
 - Needs the latest Code.gs + Code2.gs in the sheet AND the New version deploy. Until then bridge.log
   says "do the New version deploy".
 - bridge.log shows "Result announcements: ..." lines. TestConnection line 6 checks NSE (sends nothing).
 - To switch it off: in config.json add  "announcements": false

RESULTS CALENDAR (the Results tab fills itself)
Once a day (the first round of the day) the program reads NSE's Event Calendar - All Forthcoming,
Equity and SME - and sends the board meetings whose purpose has "Financial Results" (Financial
Results, Financial Results/Dividend, .../Fund Raising, .../Other business matters ...). When a list
gives no such meeting (SME gave 0 on the first run), NSE's Board Meetings list is read instead
(meetings before today left out). The sheet ADDS the companies that are not on the Results tab yet,
at the bottom, in the same format (SYMBOL, COMPANY, PURPOSE, DATE). For a company already on the tab
NSE's date is compared with the company's FIRST row (the one Main's Result Date reads), by the
results quarter each date reports on:
 - same quarter, other day (e.g. 31-Oct -> 03-Nov) = NSE MOVED the meeting: that date (and purpose)
   is changed - unless that result already came out (Results Tracker: Updated);
 - a later quarter (e.g. 21-Sep June-quarter results -> 04-Nov September-quarter results) = the next
   meeting: the first row gets the new date, so Main reads it;
and that company's rows of EARLIER quarters are deleted (e.g. PRASOLCHEM 28/09 under its 02/11 row).
Other rows are never touched - clear the tab yourself after the results season as usual. No email. Main's
Result Date (and so the Results Day check and the Upcoming Results email) then sees them by itself.
 - Needs the latest Code.gs + Code2.gs AND the New version deploy.
 - bridge.log: "Results calendar: N forthcoming result meeting(s) on NSE (equity N, SME N); N added to
   the Results tab; N date(s) changed by NSE - SYMBOL 31/10 -> 03/11; N next-quarter meeting(s) replaced
   the old date - SYMBOL 04/11 (was 21/09); N old-quarter row(s) deleted - SYMBOL".
 - calendar_state.json remembers the day it last ran. CalendarNow.bat runs it again at once.
 - TestConnection line 7 checks NSE, says which list answered and, when a list has no result
   meeting, what each link gave (sends nothing). To switch it off:
   "calendar": false in config.json.

NSE XBRL RESULTS (official figures, the same day)
Every results check (30 minutes) and round the program reads, for the FILED results the sheet waits for, the company's
XBRL filing of that quarter
on NSE ("Integrated Filing - Financials": consolidated and standalone) and sends its figures to the sheet. When
screener.in does not show the quarter yet, Results Day takes NSE's figures + the earlier quarters already read from
screener.in: QoQ / YoY, Net Profit, TTM EPS, Last FY EPS, OPM QoQ% - final figures (tracker Source "NSE XBRL").
When screener.in shows the quarter later, only Promotor Holding, FII Activity and OPM YoY% are taken from it.
moneycontrol's first figures are replaced by NSE's. The Results Tracker's new "Flags" column (and pills in the
Results Update email) marks: revenue up but profit down; profit growing at least 10 points faster than revenue;
an exceptional gain of 10% of the profit before tax or more.
 - bridge.log: "NSE XBRL: N of M stock(s) have their results filing on NSE - sent ...; not filed yet: ...".
 - Needs the latest Code.gs + Code2.gs AND the New version deploy.
 - Results waiting for figures (and filed on NSE) come first; results already filled from screener.in are read once a
   day while they are at most 3 days old (for the exceptional-gain flag), and only the file the sheet needs
   (consolidated / standalone).
 - xbrl_state.json remembers what was tried. To switch it off: "xbrl": false in config.json
   ("max_xbrl_per_run": 60 = stocks a round).

NSE XBRL RESULTS - TEST (XbrlCheck.bat)
Companies also file their results with NSE as XBRL ("Integrated Filing - Financial", an XML file of tagged figures,
the same day). The plan: an official third source for Results Day, with EPS. XbrlCheck.bat is the first, test-only
step: type NSE symbols (e.g. PARAS TCS) or paste an XBRL link. For each it shows
 - which NSE lists gave XBRL links (and the field names when none did),
 - each newest XBRL file: company, standalone / consolidated, the quarter - the CONSOLIDATED one is used when the company
   files it, else the standalone one (like screener.in in Main),
 - the quarter's Revenue, Other income, Depreciation, Interest, PBT, Net Profit, EPS and OPM % next to screener.in's,
 - TTM EPS worked out the planned way: the XBRL quarter + screener.in's 3 earlier quarters (and screener's own, once it
   shows the quarter), Revenue QoQ / YoY.
Nothing is sent to the sheet. The files are saved in the xbrl_check folder. Send the screen to Claude.

MONEYCONTROL (first figures while screener.in is late)
moneycontrol.com often shows new quarterly results before screener.in. In each results check, for companies
that filed their results on NSE but have no NSE XBRL figures yet (the XBRL file comes a few hours after the
results PDF), the program also reads moneycontrol and sends its figures to the sheet. If moneycontrol already has the quarter, the
sheet writes those figures in Main and ticks the Checkbox (Results Tracker: Source = moneycontrol,
email: "VIA MONEYCONTROL"). When screener.in catches up, its figures replace them by themselves.
 - Needs the latest Code.gs in the sheet AND its New version deploy (Deploy > Manage deployments >
   pencil > Version: New version > Deploy). Until then bridge.log says "do the New version deploy".
 - bridge.log shows "moneycontrol SYMBOL: ..." for each company it looked up.
 - moneycontrol_codes.json   remembers each company's moneycontrol code (found once by searching).
 - To switch it off: in config.json add  "moneycontrol": false   (or Control Panel > Results Season).
 - At most 40 companies at a time (the ones looked at longest ago first, the rest next time), each at most once an
   hour; change with  "max_moneycontrol_per_run": 40
 - A company moneycontrol shows no quarterly figures of is left alone for 7 days.
 - EPS (for TTM EPS) comes from moneycontrol's results page; when it cannot be used, bridge.log says why
   ("no EPS: ...") and TTM EPS waits for screener.in.
Checks (they send nothing):
 - TestConnection.bat line 8 looks up TCS on moneycontrol and prints its latest quarter.
 - MoneycontrolCheck.bat asks for symbols (for example: TCS ACUTAAS) and tries each of moneycontrol's
   sources (results widget, results page and its page data, old pages). For each one that works it
   prints the latest quarter, revenue and net profit (with QoQ / YoY change) and EPS, then what a
   run would send to the sheet.
 - If none works it prints where the figures seem to be and saves the pages in the folder
   moneycontrol_check (next to this file) - Claude may ask you for those files.
