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
 - KiteSetup.bat           one time: your Zerodha Kite Connect app's API key + secret, then the first Kite login
 - IntradayNow.bat         the Kite intraday / weekly / monthly pattern scan right now (opens the login page if needed)
 - IntradayCheck.bat       one stock's Spring check on Kite's candles, e.g. PARAGMILK 4H (sends nothing)
 - BacktestNow.bat         the FVG+Spring / Gap-up FVG + Spring backtest (30-day move, 1R-5R) on the Kite candles already here -> the sheet (no login)
 - KiteHistoryNow.bat      read Kite's long history (daily ~20 years, 4H ~5 years) for the backtest all at once, then the backtest
 - LiveNow.bat             Kite LIVE prices every minute -> the sheet's "Kite Live" tab (close the window to stop)
 - bridge.log       what it did (open with Notepad)
To stop it: run  python screener_bridge.py uninstall

ZERODHA KITE - INTRADAY / WEEKLY / MONTHLY PATTERNS (kite_intraday.py)
The sheet only has daily candles. With your Kite Connect app (developers.kite.trade, the paid "Connect" plan,
Rs 500 a month, live + historical data) this program also looks at 15m / 30m / 1H / 2H / 4H / D / W / M candles:
 1. One time: double-click KiteSetup.bat, paste the app's API key and API secret (the secret stays hidden while you
    paste), then log in on the Zerodha page that opens. The app's Redirect URL must be  http://127.0.0.1:8765/kite
    (= this computer; the login page hands the day's permission to this program and to nothing else).
 2. Every trading day after 3:40 PM - or the next time this computer is on - the background program opens the Zerodha
    login page once (Zerodha's rule: one manual login a day; the permission ends at 6 AM). Log in and close the tab;
    it then reads the candles by itself (~20-30 minutes in the background for ~1,800 stocks the first time, less after),
    alongside the usual rounds (it does not wait for them). bridge.log shows its progress on lines starting with "Kite:".
    Not logged in within 45 minutes: it asks again 2 hours later (at most 4 times a day) - or double-click IntradayNow.bat.
    If the page says "This site can't be reached" after you log in, the program had stopped waiting: IntradayNow.bat.
 3. It finds the sheet's Spring pattern and "Spring in FVG" on 4H (only the day's 2nd 4H candle, 13:15-15:30), D, W
    and M (your choice, 08-Nov-2026; config "intraday_timeframes" can list others, 15m, 30m, 1H, 2H - 15m and 30m
    report only Spring in FVG) and sends them to the sheet's "Intraday Patterns" tab (kept 30 days; the Chart column
    opens TradingView at that timeframe). The website's Patterns & FVG page lists them too (no prices - Kite's data is
    for your own use).
    "Spring in FVG" (your rule of 08-Nov-2026, checked on a picture; the same as the sheet's FVG+Spring and the
    website's): the Spring candle sits on a 3-candle FVG that still holds (no close under its
    bottom before the Spring): its low anywhere in the zone or under the bottom line (any depth), its close above the
    bottom line, and NO candle since the zone formed closed under the Spring candle's low (the red candle excepted).
    The column "FVG Detail" says where its low sat ("FVG top (touch 2)", "FVG middle (touch 3)", "Gap-up bottom
    (touch 4)"). When a LATER candle closes under the Spring low, the next scan takes that row off the sheet.
    Not on the monthly chart (M: the plain Spring only).
    "Gap-up FVG + Spring" (your choice of 08-Nov-2026: split off from Spring in FVG): the same rule on a Gap-up zone
    (3-5 %); FVG Detail adds ", inside FVG" when that Gap-up zone lies inside a 3-candle FVG (the strongest kind).
    A Spring on both kinds of zone is sent as both.
 4. On 4H it also finds the other FVG patterns of the sheet's FVG column - FVG First Touch, FVG First Touch Confirmed
    and Twin Star Bottom + FVG (on every 4H candle) - and sends the 4H FVG ZONES (the latest 3-candle FVG when never
    touched + every Gap-up of 3-5 %, liquid stocks only) to the sheet's "4H FVG Zones" tab. A Gap-up zone stays after
    its first touch (a wick is enough = mitigated, emailed once) until a 4H candle closes under its bottom (your rule,
    08-Nov-2026); "Inside FVG" = Y when it lies inside a 3-candle FVG. During market hours the sheet watches them:
    price at or under a zone top = mitigated -> one combined "Mitigated FVG" email at most once an hour, together
    with the daily zones (inside-FVG Gap-ups listed first).
 5. BACKTEST (your choices of 09-Nov-2026: "maximum number of days", "% movement upward within 30 days", not only 2R):
    after each scan it tests every Spring in FVG and Gap-up FVG + Spring of 4H (13:15 candle), D and W on ALL the
    candles stored here: buy at the Spring candle's close, stop just under its low, R = close - low. For the 30 days
    after each signal: "Up %" = the highest price vs the entry, "Hit 1R / 1.5R / 2R / 3R / 5R" = that target reached
    before any candle went under the stop, "Stopped" = it went under, "Max R" = the highest price before the stop.
    Groups: FVG+Spring (top / middle / bottom), Gap-up FVG + Spring, Gap-up inside FVG + Spring, every Spring.
    The numbers go to the sheet's "Spring Backtest" + "Spring Backtest Trades" tabs and the website (Patterns & FVG >
    FVG+Spring backtest); bridge.log shows one line per timeframe ("Kite backtest ..."). BacktestNow.bat runs only the
    backtest, on the candles already here - no Kite login needed.
    LONG HISTORY: daily candles back ~20 years (or to the listing day) and 4H back ~5 years (built from Kite's
    60-minute candles) are read once and kept here (folder intraday_data, about 250 MB) - the sheet never gets them,
    only the summary, so the sheet is not loaded by it. The daily scan reads this history a part a day (20 minutes);
    KiteHistoryNow.bat reads all of it at once (the first time about 2 hours; a line every 25 stocks with
    the time left), then runs the backtest. Stopped half-way? Run it again - the stocks already read are kept.
 - The candles are kept in the folder intraday_data (only the new days are read after the first time); the day's
   Kite permission in kite_session.json. Both stay on this computer.
 - 4H candles = 09:15-13:15 and 13:15-15:30 (like TradingView); a week / month only once it has finished.
 - IntradayCheck.bat PARAGMILK 4H 2026-10-30 shows every Spring in Kite's candles of that stock and, for each pair of
   that day, which part of the Spring rule passed or failed (sends nothing).
 - KITE LIVE PRICES (LiveNow.bat): double-click it while the market is open (or for the Muhurat session). It asks for
   the Kite login if you have not logged in today, then every minute sends the live price (+ the day's open / high /
   low and the previous close) of the sheet's stocks to a separate tab "Kite Live" (biggest gainers first, with Main's
   GOOGLEFINANCE price beside it to compare). Main, MKT Price, the alerts and the emails are NOT changed. It stops at
   3:35 PM on a trading day, after 4 hours on another day (Muhurat), or when you close the window.
   EVERY TRADING DAY BY ITSELF: the background program starts it at 09:10 (or as soon as the computer is on before
   3:35 PM); the Kite login page opens in the morning when today's login is missing (at most 3 times a day) - that
   morning login also covers the evening pattern scan. bridge.log shows a "Kite live:" line every 15 minutes.
   Only one copy sends prices at a time (LiveNow.bat by hand stops if the background one runs, and the other way).
   While these prices are fresh, the sheet's Mitigated FVG alerts (daily + 4H zones) and IPO base alerts use them;
   when the computer is off they use the GOOGLEFINANCE price as before.
   The sheet's Indextracker indices (NIFTY 50, NIFTY BANK ...) come along in the same requests: the window shows
   NIFTY 50 on each line, and your website (with the PIN) shows them live on the Overview and Markets pages.
   config.json "kite_live_seconds": 60 = how often (at least 15); "kite_live": false = not by itself.
 - To switch it off: in config.json  "intraday": false

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
 - Special sessions on a Saturday / Sunday (Muhurat trading) are taken too: the weekend days of the last week
   are tried, and NSE's file is used only when it holds that very day. bridge.log then says "a special Sunday
   session (e.g. Muhurat trading)". An ordinary weekend is noted in eod_state.json and not asked again.
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
 - history_state.json remembers exchange holidays (a past weekday with no bhavcopy, twice) and weekends
   without a special session. A Saturday / Sunday session of the last week (Muhurat trading) gets its column.
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
 - From the same filing it also reads the quarter before and the same quarter a year before (the results table's
   comparison columns): the sheet's OPM QoQ% compares within the one file, and the new Main column "OPM Qtr YoY" (this
   quarter's OPM vs the same quarter last year) too. XbrlCheck.bat shows "quarters in this file: ..." with their OPM.
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

BACKTEST LAB - YOUR OWN RULES ON THE LONG HISTORY (09-Nov-2026)
 - The website's new page "Backtest Lab" (owner only - your My Watchlists PIN): choose the pattern (FVG+Spring,
   Gap-up FVG + Spring, inside FVG, every Spring), the timeframe (daily / weekly / 4 hour), where the stop goes (a
   little below the FVG zone bottom, below the Spring low, the lower of the two or a fixed %), the target (e.g. 2R),
   what happens at the target (sell there, or move the stop to the entry and trail it under the lowest low of the last
   N candles / x % under the high / a close under an EMA), the days you hold at most, costs, your account and risk per
   trade - then "Run on my laptop".
 - The background program of THIS computer picks the run up (it asks every 10 seconds while the page is open, every 2
   minutes otherwise), works it out on the Kite candles kept here in a few seconds and sends the result back - the page
   shows it, the sheet keeps the newest 8 (hidden tab Backtest_Lab). The candles never leave this computer.
 - It reads a compact copy of the candles (folder lab_cache, made by BacktestNow.bat and by every daily scan). The
   first run makes it if it is missing (about 3 minutes, once).
 - This computer must be on and the background program running (it starts at Windows log-in). After installing this
   zip: sign out and in again (or restart), so the background program uses the new version.
 - Market structure - CHoCH / BOS (10-Nov-2026): step 2 of the page. "My CHoCH + FVG setup" = your rules in one click:
   after at least 3 lower highs and 3 lower lows (a swing = 5 candles each side) a candle CLOSES above the last lower high
   (CHoCH); an FVG / Gap-up zone formed in that move or after it, below the CHoCH level; on the FIRST pullback into it
   (no BOS - no close above the highest swing high since the CHoCH) a Spring or an FVG First Touch / Confirmed = entry.
   "Show it on every trade" keeps every signal and adds a table "By market structure" (your setup / after a BOS / above
   the CHoCH level / no CHoCH) to compare in one run. Target: an R multiple or the last swing high. The first run after
   this update rebuilds the candle cache once (10-20 minutes - the program now does it right after it starts, before any
   run, and the Lab page shows "N of M stocks, about X min left"); the first run with market structure ~10 seconds more.
   The daily Zerodha scan also finds today's CHoCH + FVG setups -> the sheet's Intraday Patterns tab -> the website's
   Patterns & FVG page ("CHoCH + FVG setups") and Strategy Settings ("CHoCH + FVG (your SMC setup)").
 - The discount zone (11-Nov-2026, after your SUPREMEIND check): "My CHoCH + FVG setup" now takes the zone whose MIDDLE is
   at least half way down the move (the 50% / Fib 0.5 line from the CHoCH's final low to the highest high before the
   signal) - a part of the zone may be above the CHoCH level. The signal = the FIRST time price comes back to that zone
   (Pattern "First touch of a zone" - every FVG / Gap-up zone, not only the newest one, so a newer FVG above it does not
   hide it). Buy: "An order waiting at the zone top" (filled when price first comes down to the top, or at the open when
   it opened under it) or the touch candle's close - run both to compare. Other choices: 38.2 / 61.8 / 70.5 / 78.6 % and
   the zone's middle / top / bottom. Every trade's Structure badge shows the CHoCH, the final low, the move high and the
   50% line; the TradingView button opens that stock's chart. The first run after this update rebuilds the candle cache
   once more (the Lab page shows "N of M stocks, about X min left"). The daily scan's CHoCH + FVG setups use the same rule.
 - TradingView indicator: StockBlueprint_CHoCH_FVG.pine (delivered with this zip) draws the same rules on the TradingView
   chart - swings, CHoCH, final low, the 50% line, BOS, the zones and a BUY label (hover it: entry / stop / target) - to
   check a backtest trade with your own eyes. TradingView: Pine Editor > paste > Save > Add to chart. Easier: the Backtest
   Lab page's "Copy TradingView script" button gives the script with the rules of the form (or of a finished run).
   Since 12-Nov-2026 the script also follows the Lab's swing / CHoCH options (ZigZag swings, "a swing must stand out by
   x ATR", the protected-high CHoCH, equal highs / lows) - its summary table says which ones are on (row "Swings").
 - Charts PDF (12-Nov-2026): with every Backtest Lab run this computer also makes ONE PDF with a chart page for every trade
   (the losing ones first, newest first; then the rest; then the open ones): the candles, swing highs / lows, the CHoCH
   level + final low, the Fib (discount) line, the BOS, the FVG / Gap-up zone, the entry / stop / target lines, the BUY
   and the exit X, and the trade's numbers on top. Folder: lab_charts (here, next to this file); the newest 20 PDFs are
   kept. The Lab page shows the file name with each run. config "lab_charts": false = off.
   Two pages a trade (12-Nov-2026): page 1 = the chart with every swing marked HH / HL / LH / LL (each high / low against
   the one before), CHoCH, final low, move high, BOS, the FVG / Gap-up zone, BUY and the exit - the words are put where
   they cover no candle; page 2 = plain sentences, no chart (the prices are on page 1): why the backtest took it (the
   fall with its lower highs / lows, the CHoCH, the zone and how deep it sits in the rise, the first touch, no BOS yet,
   how old the CHoCH was, your filters, the plan) and how it ended (for a stop loss: how far it went up first, a wick only
   or a close under the stop, a big candle / heavy volume, whether the zone and the final low held, whether price reached
   the target later). Every trade of a run in ONE PDF (13-Nov-2026; was 1,500) - at most 10,000 trades (20,000 pages, ~75 MB).
 - Real or chance? + What worked best + Development / test (12-Nov-2026, after your ChatGPT review): every run now shows
   the likely range (90%) of its average R ("An edge" = the whole range above 0; "Could be chance" = it spans 0), and
   tables of the finished trades split one feature at a time - zone depth in the move, lower highs / lows before the
   CHoCH, days from the CHoCH to the signal (these three need market structure "Show" or "Only"), how deep the candle
   went into the zone, zone kind, touch, risk %, turnover - each row Better / Worse than the rest of the run (clear at
   90%), Could be chance, or Too few (under 30 trades). Step 1 "Test period from" (e.g. 2020-01-01) splits the run in a
   development part (before - choose your rules there) and a test part (from it - the check); every row then also says
   whether it held in the test part. The trade list has Depth %, LH / LL and Days from CHoCH (also in the CSV).
 - CHoCH + FVG waiting for the pullback (12-Nov-2026, your IREDA question): after each daily Zerodha scan this computer
   also sends every live CHoCH (no close under its final low, no BOS yet) whose discount zone price has NOT touched yet
   -> the sheet's "CHoCH Waiting" tab -> the website's Patterns & FVG page ("CHoCH + FVG - waiting for the pullback":
   the zone top = where to put a buy order, the zone bottom, the distance, with Kite's prices). Strategy Settings then
   says "waiting for the pullback" for such a stock. IntradayCheck.bat SYMBOL D shows the stock's waiting status too.
 - The rest of ChatGPT's experiments (12-Nov-2026), each one an option on the Lab page, all off by default (= the
   baseline): ATR swings / ZigZag / protected CHoCH / equal highs / sweep (More rules > Market structure), the zone at most,
   days after the CHoCH, the CHoCH candle's body (ATR) and volume, how deep the candle went into the zone, the stock's
   weekly trend, ATR and swing-low trails, a validation part and "steady over time" blocks. The candle cache keeps the
   volume now, so this computer rebuilds it once by itself after the update (the page shows "preparing the candles").
   The guide: the Lab page's "Guide (PDF)" button (Tamil, with pictures).
 - ChochRules.bat (12-Nov-2026): the CHoCH + FVG rules of the daily Zerodha scan - swing size (candles each side),
   lower highs / lows before the CHoCH, the discount level (0.382 / 0.5 / 0.618 / 0.705 / 0.786), which part of the zone must
   be that deep (middle / top / bottom) and where the zone formed (in the CHoCH move or after it / only in the move / only
   after the CHoCH candle). Type the same values as in your Backtest Lab run / TradingView indicator; Enter keeps a value.
   Saved in config.json (choch_swing_candles, choch_lower_highs, choch_fib, choch_zone_part, choch_zone_when). The next scan
   then looks at the last 10 sessions again with them (IntradayNow.bat = now); the sheet's tab notes and the website's
   texts say the rules in use. TestConnection line 9 and IntradayCheck.bat show them too.
 - ChochRules.bat now also asks (12-Nov-2026, the owner's 10 points): zone size min / max %, buy at the Gap-up top
   inside an FVG (yes), a zone slightly above the Fib line allowed when its top is at / near the CHoCH line,
   dark-cloud FVGs (any / leave out / only), the Fib + Spring / Harami-Inverted-Hammer entry (off / big zones /
   all) with its level (0.618) and tolerance (1%). Enter keeps a value. The Backtest Lab has the same options;
   its cache rebuilds once by itself (version 5) on the first run after this update.
 - 12-Nov-2026 (later): when a CHoCH move has two discount zones, the one price reaches first is only watched - the
   trade / the buy order is on the 2nd (ChochRules.bat asks "Two discount zones in the CHoCH move": 1 = trade the 2nd,
   2 = every zone). The Backtest Lab can also ask for big volume in the CHoCH move, and every chart in the charts PDF
   now has the volume under it. The Lab's cache rebuilds once more by itself (version 6).
 - 13-Nov-2026: a zone price touched before the CHoCH (while the rise was forming) counts again - its first touch after
   the CHoCH is the signal (SWIGGY). ChochRules.bat asks "A zone price touched before the CHoCH": 1 = counts again,
   2 = not. IMPORTANT after extracting a new zip: sign out and in again (or restart the laptop) - the background program
   keeps running the old version until then (that is why the charts PDF had no volume bars).
 - 13-Nov-2026 (later): five fixed rules of your CHoCH + FVG setup (Backtest Lab "Only my setup", the daily scan and the
   TradingView script): no zone wholly above the CHoCH line; the zone formed in the swing from the final low to the move
   high; before the move high at most 2 candles touched the zone and none closed under its middle; the 1st (watched)
   zone untouched before the move high; no premium zone when the signal comes 4 days or less after the CHoCH.
 - 13-Nov-2026 (stop / target / exit): Backtest Lab "… or x ATR under the entry, whichever is lower" next to the stop
   loss - with every stop kind the lower price of the two is used (5 % = 95, 2 x ATR = 93 -> stop 93). Target: R / % above
   the entry (20, 30, 40 % ...) / the CHoCH move high (HH) / the last swing high. Exit details: sell part (e.g. half) at the
   target and let the rest trail, the stop to the entry once price is 1R up, a time stop (no 1R move in N candles = sold at
   that candle's close). The charts PDF says them; the TradingView script draws the ATR stop and the new targets.
 - 13-Nov-2026 (pattern engine, step 1): the Backtest Lab's Pattern can now be "Pattern library" - the new bullish pattern
   engine (indicators.py, pattern_registry.py, pattern_detect.py). Built so far: K08 Bullish Engulfing, B01-B04 20-day /
   50-day / 52-week / all-time high breakouts, I01 RSI bullish divergence. The page lists all 194 patterns with their state.
   Every result now notes that delisted stocks are not in the data (survivorship bias).
 - 13-Nov-2026 (pattern engine, step 2): 70 patterns in the Pattern library now - every candlestick pattern, the breakouts
   (Darvas box, NR4 / NR7, squeezes, base breakouts ...), the moving-average patterns (pullbacks, crosses, Supertrend,
   weekly + daily alignment) and the basic volume patterns. Reversal patterns can be kept "Only after a fall".
- 13-Nov-2026 (pattern engine, step 3): 172 patterns now - market structure (higher highs / lows, CHoCH, BOS, swing failure,
  breakout + retest, trendlines ...), SMC / ICT (liquidity sweeps, order blocks, breakers, FVG touches, BPR ...), momentum
  (RSI / MACD / Stochastic / CCI / ADX / TSI / Aroon / Parabolic SAR / Bollinger), quant (z-score, volatility regimes,
  multi-factor) and Ichimoku / anchored VWAP (new file pattern_p3.py). The structure patterns have a "Swings" choice (candles
  each side). I23 / I24 / Q13 compare the stock with NIFTY 50 - its candles come with the daily scan (or KiteHistoryNow.bat).
  Left for later: the classical chart patterns (double bottom, cup and handle, flags ...).
- 13-Nov-2026 (pattern engine, step 4): 192 patterns - the classical chart patterns too (double / triple bottom, inverse head
  and shoulders, rounding bottom, falling wedge, flags, pennants, cup and handle, triangles, rectangle, channel, staircase,
  measured move, high tight flag, flat base, IPO base, VCP; new file pattern_p4.py). Each signals on its breakout.
- IMPORTANT after extracting a new zip: sign out of Windows and sign in again (or restart). The background program keeps the
  old code until then - e.g. on 13-Nov-2026 the Backtest Lab ran K08 Bullish Engulfing for every pattern chosen, because the
  old program did not know the new patterns. Now the laptop refuses a pattern it does not know, and the website's result
  says "your laptop ran ... not ..." / shows "Laptop program: pattern engine v4 · 192 patterns".
 - Spring candle shape (10-Nov-2026): step 3 of the page - hard rules that only make the Spring STRICTER (the pattern's own
   rule is loose: a doji, a 2-tick dip or a weak close can all be a "Spring"). The Spring candle (c2): upper wick at most
   x % of its range (0 = none), lower wick at least x %, closed in the top x %, body at least x % (not a doji), green /
   red, body at most x % of the red candle's. The dip: how far under the red candle's low (at least / at most, or in
   ATRs), how far it closed above that low, closed above the red candle's close. The red candle (c1): body size, lower
   wick. Where: c2's low under the lowest low of the last N candles, price fell x % before. Five recommendations to start
   from (Clean hammer, Real stop-hunt, Swing-low Spring, Washout after a fall, All of them) - ideas to test, not proven.
   The result says how many Springs passed and what left the rest out; the trade list shows each trade's wicks and dip.
   Needs this ScreenerBridge version on the laptop (restart it); no sheet change, no cache rebuild.
 - EMA confluence (09-Nov-2026): step 4 of the page - take a signal only when the Spring candle took support at the
   10 / 21 / 50 EMA (its low came down to it, or within x % above it, and it closed at or above it), closed above
   chosen EMAs, and / or the EMAs were in order 10 > 21 > 50. The trade list then shows what the EMAs did.
 - Market condition (09-Nov-2026): step 5 of the page - take a signal only on days when an index (NIFTY 50, 100, 200, 500,
   Bank, Midcap, Smallcap ... and every index of your Indextracker tab) closed above its 10 / 21 / 50 / 100 / 200 EMA
   and / or had its EMAs in order 10 > 21 > 50. The index candles (20 years, daily) come from Kite with the daily scan
   (after 15:40) or KiteHistoryNow.bat - kept in intraday_data\indices.
 - "skipped" in the trade list: hover (or tap on a phone) to see why - too many trades open at once, one share
   costing more than your position limit, one share risking more than your risk per trade, or the account ran out.
 - A check without the website: python screener_bridge.py lab   (or: lab W / lab 4H) - the default rules, nothing sent.
