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
 - TestConnection.bat   check sheet + screener.in + NSE (price bands, IPO lists) access
 - PriceBandsNow.bat    download NSE's price band changes and send them to the sheet right now
 - IposNow.bat          read NSE's IPO lists and update the sheet's IPO Tracker tab right now
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
