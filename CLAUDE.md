# Context prompt for Claude Code (paste as your first message, or save as CLAUDE.md in the project folder)

You are taking over an existing Google Apps Script project called **"AUTO OHLC + PATTERN ENGINE"** (bound to the Google Sheet "Copy of Stock Blueprint"). I have been building it in a long chat with Claude. Continue the work here, in the repo.

## 0. About me / how to talk to me
- I am a non-technical user. **Always reply in Tamil**, even if I write in English. Keep explanations short and plain, and give exact menu paths / click steps.
- Technical identifiers (function names, code, file names, commands) stay in English.
- Do not build things I did not ask for. Offer first, build after I say yes.
- Don't paste secrets (bridge token, web-app URL) into chat or commit them.

## 1. What the project is
- Single file: `Code.gs` (~18,000 lines, Apps Script V8). It is the authoritative code. Apps Script has a 6-minute execution cap and time triggers fire +/-15 min.
- It runs inside a Google Sheet. Main tab: headers on row 2, data from row 3; the script finds columns by **header name** (Checkbox col A, SYMBOL, Result Date, NSE Ticker, MKT Price, % Change, quarterly columns, etc.). Never hard-code column letters.
- Features: daily 4-phase pipeline (Phase 1 fetch OHLC+history, Phase 2 patterns, Phase 3 alerts + EOD email, Phase 4 extras), FVG zones, pattern tags, price alerts/trades/risk, IPO tabs, NSE price bands, dashboards, Control Panel tab (`AB_CP_SECTIONS_`, read settings with `ab_setting_(key, default)`), email helpers (`ab_sendMail_` honors an email pause; MailApp body limit ~ "Limit Exceeded: Email Body Size" so emails must stay small).
- Weekend/holiday guard for time-trigger runs: `ab_skipWeekendTrigger_(e, label)`, `ab_isTradingDayToday_`; menu runs (no event object) are never skipped.
- Menu is built in `onOpen` (sub-menus "1. Daily Pipeline", "2. Results Season", "3. Quarterly Results & Trend Tags", "4. Emails & Notifications", ... "Settings & Maintenance").

## 2. Results Season engine ("Results Day")
- Entry: `ab_rsRun_` -> `ab_rsRunCore_`. State lives in the visible tab **Results Tracker** (symbol, company, result date, expected quarter, status Pending / Updated / Gave up, latest quarter seen, checks, timestamps, note).
- A stock is added when its Main "Result Date" is today or up to `AB_RS_MAX_WAIT_DAYS` (21) days old. Expected quarter = latest quarter-end before the result date (`ab_rsExpectedQuarter_`).
- Screener.in latest quarter < expected -> stays Pending (retried every run). Otherwise figures are written (`ab_qt_writeRow_`) and the Checkbox in Main is ticked **only if** the quarter belongs to the current season. Once per new season all ticks are cleared (`ab_rsResetCheckboxes_`), keeping rows the tracker already shows as Updated.
- "Results Performance" tab is rebuilt by `ab_rpRefresh_` (Stocks Tracked = tracker "Updated" rows of the season).
- Results Update email (fintech-style HTML, built in `ab_rsSendEmail_`): newest result date first, TTM Signal + Upside, today % under symbol and since-result % under date; waits for sheet formulas before building (`ab_rsWaitForFormulas_`); menu item "Re-send Results Update email (no fetch)". Retry-slot emails are quiet unless something new got through.
- Main "Result Date" column = formula per row reading the **Results** tab (NSE calendar pasted there). It must be a REAL date (DATE(...) formula, dd/mm/yyyy format) so sorting is chronological. Menu "2. Results Season > Install Result Date Live Formula" installs it. `ab_ensureResultDateReal_()` auto-heals old text-style formulas (checked every 12 h from Phase 1 and Results Day).
- Known design gap (user was offered a fix, not yet accepted): stocks missing from the Results calendar, or ticked by hand, are never verified. Proposed "Catch-up check": PC fetches ticked-but-unconfirmed rows (auto-untick if screener lacks the quarter) plus a rotating batch (~40) of unticked rows per run.

## 3. PC bridge (why it exists)
- screener.in blocks Google's servers, so a Python program on my Windows PC fetches pages and sends them to the sheet through a **web app** (`doGet`/`doPost`, actions `list`, `put`, `process`, secret token in script property `AB_BRIDGE_TOKEN`). Data is stored in a hidden tab `Screener_Bridge`. Engines read it via `ab_bridgeGet_`; during `process` the flag `AB_BRIDGE_ONLY` forbids live fetches.
- `ab_bridgeWanted_()` decides what the PC fetches: `priority` (results due / pending) then `missing` (never-attempted rows).
- PC folder `ScreenerBridge/`: `screener_bridge.py` (one-shot run, commands setup/run/test/login/reschedule/uninstall), `RunNow.bat`, `Setup.bat`, `TestConnection.bat`, `Reschedule.bat`, `README.txt`, `config.json` (url, token, max_missing_per_run, delay_min/max). Schedule: runs ~1 minute after Windows login (only when internet is up) and again 1 hour later. 429 from screener -> waits 90 s. After sending pages it calls `process` (Results Day + never-attempted rows).
- **The web app /exec URL runs the LAST DEPLOYED VERSION**, not the saved head code.

## 4. DEPLOYMENT RULES (very important)
- Never create a "New deployment" for the existing web app: it changes the URL the PC bridge uses. Always **update the existing deployment** (same deployment ID) with a new version.
- With clasp: `clasp push`, then `clasp deploy -i <EXISTING_DEPLOYMENT_ID> -d "<note>"`. Find the ID with `clasp deployments`. Keep `appsscript.json` web-app settings: executeAs USER_DEPLOYING, access ANYONE (or ANYONE_ANONYMOUS as currently set - read it from the existing manifest, do not change it).
- Time-driven triggers use the saved head code and need no reinstall after a push.
- Manual equivalent in the editor: Deploy > Manage deployments > pencil > Version: New version > Deploy.

## 5. Setup tasks I want you to do first
1. Create/organize the repo: `Code.gs`, `appsscript.json`, `.clasp.json` (script ID - ask me for it), `pcbridge/ScreenerBridge/` (python + bat files), `README.md`, this file as `CLAUDE.md`. Add `.gitignore` (config.json, .clasprc.json, any token). Initialize git.
2. Help me install and log in to clasp (`npm i -g @google/clasp`, `clasp login`, enable the Apps Script API at script.google.com/home/usersettings), then `clasp clone` / `clasp pull` so the repo matches what is live. If the pulled code differs from my attached `Code.gs`, show me the diff before overwriting anything.
3. Run a syntax check before every push (`node --check` on a copy named `.js`; `.gs` is unknown to node). Use small vm-based harnesses for logic checks where useful.
4. Deliver changes as small commits; after any `Code.gs` change tell me (in Tamil) whether a New version deploy is needed (yes if the PC bridge / web app must see it).
5. Then ask me what to work on next. Pending offers I have NOT accepted yet: Catch-up check (above), daily summary email even when nothing new, pattern chapter for the Tamil guidebook, slower PC request delays, Dhan real-time prices, scratch cleanup / Phase 1 timeout alert.

## 6. Things that already bit us (don't repeat)
- Result Date as TEXT sorts alphabetically -> must be real dates.
- Loops that `break` on the first row with empty symbol AND name stop reading Main early; be careful with blank rows inside the data range.
- Sheets filter has no "(Blanks)" for formula-"" cells; use a custom formula filter such as `=LEN(G3)=0`.
- Email body too big -> "Limit Exceeded: Email Body Size"; use compact layouts / truncation.
- GOOGLEFINANCE values are ~20 minutes delayed; check after 10:00 AM IST.

## 7. Files to attach / copy into the repo
- The latest `Code.gs` I downloaded from the chat (most recent delivery).
- `ScreenerBridge.zip` (Python bridge) from the earlier chat delivery.
- Optionally the Tamil guidebook (`Stock_Blueprint_Guidebook_Tamil.docx/.pdf`).

## 8. Website (web/, api/, tools/) - added Oct 2026
- Static dashboard in `web/` (no build), engine modules in `web/lib/` ported 1:1 from Code.gs and verified by `tests/sheet-parity.test.js` (patterns col W, FVG col X, EMA cols Y/AA, ATR col Z, confluence). If Code.gs rules change, port the change to `web/lib/` and keep the parity tests green.
- Data: `tools/export_xlsx.py <export.xlsx>` -> `web/data/dashboard.js` + `history.js` (the SAVED COPY / fallback); `node tools/analyze_workbook.js <export.xlsx>` -> `web/data/workbook-analysis.js`.
- PRIVACY (repo and site are public): never export Portfolio, Risk Manager, Control Panel, Trade Log, Trade Dashboard, Entry alerts, entry/stop/qty columns, e-mails or tokens. Viewer data (risk settings, journal, alert rules, strategy edits) lives only in the browser's localStorage. `npm run build` scans web/data for personal markers.
- Themes: light (default) + dark via `:root[data-theme="dark"]` tokens in style.css; never hard-code colours.
- Code.gs `doPost` action `snapshot` (read-only, token `AB_FEED_TOKEN`, menu "Website feed: setup info") feeds the Vercel `sheet` provider; it needs a New version deploy of the EXISTING web app.
- LIVE SITE FEED: Code.gs `doPost` action `site` (`part` main|history, same read-only token) returns exactly what `export_xlsx.py` writes (same allow-list - keep both in step). Vercel `api/site?part=main|history` calls it (env `SHEET_FEED_URL` + `SHEET_FEED_TOKEN`, cache 5 / 30 min, stale copy on error, privacy-marker guard). The browser (`web/app.js`) boots from `api/site` when `SB.apiBase()` is not null: '' on Vercel, `web/config.js` `remoteApi` on Firebase (*.web.app / *.firebaseapp.com), null on localhost / file:// / preview unless `localStorage sb:api = true`. Any failure -> saved copy (`data/dashboard.js`, `history.js`) with the "Showing a saved copy ... Live data could not be loaded: <reason>" banner. Sheet prices are DELAYED / EOD / CACHED, never LIVE. Owner setup steps: docs/DEPLOY.md section 1.
- Checks: `npm test && npm run lint && npm run typecheck && npm run build`; browser: `NODE_PATH=$(npm root -g) CHROMIUM_PATH=/opt/pw-browsers/chromium node tests/ui/ui.e2e.js` (mocks api/ with page routes, no network). Docs: docs/STRATEGY.md, docs/MARKET_DATA.md, docs/DEPLOY.md, docs/ARCHITECTURE.md.
