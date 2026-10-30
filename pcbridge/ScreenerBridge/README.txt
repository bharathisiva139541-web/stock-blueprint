SCREENER BRIDGE - what is this?
screener.in blocks Google's servers, so your Google Sheet cannot read it.
This small program runs on YOUR PC, reads screener.in for the sheet, and hands the data back.

SETUP (one time)
 1. Install Python from https://www.python.org/downloads/  -  tick "Add python.exe to PATH" on the first screen.
 2. In your sheet: Auto Bhavcopy > 3. Quarterly Results & Trend Tags > PC Bridge: setup info.
 3. Double-click Setup.bat here and paste the two values when asked.

AFTER THAT it runs by itself every time you log in to Windows: 1 minute after log-in it waits until the internet is connected and then does a round;
it does one more round 1 hour after that (again only with internet).
Nothing runs continuously. If you stay logged in for days, use RunNow.bat when you want a fresh round.
 - RunNow.bat       do one round right now
 - Reschedule.bat   remove the old hourly schedule and use the log-in schedule (keeps your settings)
 - TestConnection.bat   check sheet + screener.in + NSE (price bands, IPO lists, end-of-day files, announcements) + moneycontrol access
 - PriceBandsNow.bat    download NSE's price band changes and send them to the sheet right now
 - IposNow.bat          read NSE's IPO lists and update the sheet's IPO Tracker tab right now
 - EodNow.bat           download NSE's end-of-day files (Delivery %, 52-week highs, market statistics) right now
 - History60Now.bat       send the daily candles the sheet's History60 tab is missing right now (the first fill)
 - AnnouncementsNow.bat   send WHEN NSE got each company's results (last 4 days) right now
 - MoneycontrolCheck.bat   show the latest quarterly results moneycontrol has for the symbols you type (sends nothing)
 - bridge.log       what it did (open with Notepad)
To stop it: run  python screener_bridge.py uninstall

NSE PRICE BAND CHANGES (no more copy/paste)
Every round also downloads NSE's "Price Band changes from next trade date (csv)"
(NSE > All Reports > Equities & SME, file eq_band_changes_DDMMYYYY.csv) and sends it to the sheet.
The sheet files it on the "Price Band Changes" tab and sends the usual email once for the day.
 - NSE publishes it in the evening. If it is not there yet, the next round (1 hour later) tries again;
   days missed while the PC was off are caught up (up to a week back, filed without an email).
 - pricebands_state.json   remembers the last day the sheet received.
 - bridge.log shows "Price bands dd-mm-yyyy: ..." for each day.
 - If NSE ever refuses, the old way still works: paste into the "Priceband" tab and use
   Auto Bhavcopy > 10. NSE Price Bands > Import Pasted Rows.
 - To switch it off: in config.json add  "price_bands": false

NSE IPO LISTS (IPO Tracker tab + one email a day)
Every round also reads NSE > Market Data > IPO (Current, Past Issues, Upcoming Issues) and sends it to
the sheet. The sheet rebuilds the "IPO Tracker" tab: Open now / Closed - awaiting listing / Upcoming,
with dates (mainboard equity issues only - SME and debt issues such as NCDs are left out) and sends one
email the first time each day. The website's IPOs & Markets page shows the same tab.
 - bridge.log shows "IPO lists: ..." for each round.
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

IF THE COMPUTER GOES OFF IN THE MIDDLE OF A ROUND
A round can take half an hour (screener.in asks it to slow down now and then). If the computer is shut
down or the program is closed half-way, the next round CONTINUES it (within 12 hours): the sheet first
processes the pages it already got (Results Day + the email), those pages are not fetched again, and then
the rest of the round runs (the other pages, moneycontrol, processing).
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
Every round also reads NSE's corporate announcements of the last 4 days (one request) and sends the
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

MONEYCONTROL (first figures while screener.in is late)
moneycontrol.com often shows new quarterly results before screener.in. Every round, for companies
whose results are due and whose screener.in page does NOT show the new quarter yet, the program also
reads moneycontrol and sends its figures to the sheet. If moneycontrol already has the quarter, the
sheet writes those figures in Main and ticks the Checkbox (Results Tracker: Source = moneycontrol,
email: "VIA MONEYCONTROL"). When screener.in catches up, its figures replace them by themselves.
 - Needs the latest Code.gs in the sheet AND its New version deploy (Deploy > Manage deployments >
   pencil > Version: New version > Deploy). Until then bridge.log says "do the New version deploy".
 - bridge.log shows "moneycontrol SYMBOL: ..." for each company it looked up.
 - moneycontrol_codes.json   remembers each company's moneycontrol code (found once by searching).
 - To switch it off: in config.json add  "moneycontrol": false   (or Control Panel > Results Season).
 - At most 40 companies a round (the ones looked at longest ago first, the rest next round);
   change with  "max_moneycontrol_per_run": 40
 - EPS (for TTM EPS) comes from moneycontrol's results page; when it cannot be used, bridge.log says why
   ("no EPS: ...") and TTM EPS waits for screener.in.
Checks (they send nothing):
 - TestConnection.bat line 7 looks up TCS on moneycontrol and prints its latest quarter.
 - MoneycontrolCheck.bat asks for symbols (for example: TCS ACUTAAS) and tries each of moneycontrol's
   sources (results widget, results page and its page data, old pages). For each one that works it
   prints the latest quarter, revenue and net profit (with QoQ / YoY change) and EPS, then what a
   run would send to the sheet.
 - If none works it prints where the figures seem to be and saves the pages in the folder
   moneycontrol_check (next to this file) - Claude may ask you for those files.
