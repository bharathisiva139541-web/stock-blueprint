# Running and deploying the website

The site in `web/` is static: no build step, no database. It gets its data
in one of two ways:

- **Live feed** (Vercel and the Firebase copy): the page asks the Vercel
  function `api/site` for the sheet's current data. `api/site` reads the
  Google Sheet through the EXISTING Apps Script web app (`Code.gs` action
  `site`, website feed token) and keeps a copy for 5 minutes (daily candles:
  30 minutes). `Code.gs` answers at once from a stored copy (hidden tab
  `Site_Feed`) that a 30-minute trigger keeps fresh, because reading the
  whole sheet takes longer than `api/site` waits. Prices are shown as **DELAYED** in market hours and **EOD**
  after the close - never LIVE (GOOGLEFINANCE is ~20 min behind).
  `api/quotes` (provider `sheet`) refreshes the prices every 5 minutes while
  the market is open.
- **Saved copy** (fallback): the files in `web/data/`, made from an Excel
  export. Used on localhost, in the single-file preview, and whenever the
  live feed fails. The page then shows a yellow banner
  "Showing a saved copy from ... Live data could not be loaded: <reason>".

## 1. Switch on the live feed (one time, in this order)

### Step 1 - Paste the new Code.gs into the Apps Script editor and Save

1. Get the new code: GitHub → repo `stock-blueprint` → `Code.gs` → **Raw** →
   **Ctrl+A**, **Ctrl+C** (or open the `Code.gs` file you were sent).
2. Open the Google Sheet → **Extensions → Apps Script**.
3. Click **Code.gs** in the left list → click inside the code → **Ctrl+A** →
   **Ctrl+V** (replaces everything).
4. Click **Save** (disk icon, or **Ctrl+S**) and wait until it says saved.

With clasp instead: `./tools/check.sh`, then `clasp push`.

### Step 2 - Update the EXISTING web-app deployment (never "New deployment")

1. Apps Script editor → **Deploy → Manage deployments**.
2. Select the existing **Web app** deployment (the one the PC bridge uses) →
   click the **pencil** (Edit) icon.
3. **Version: New version** → Description, e.g. `site feed` → **Deploy**.
4. The Web app URL stays the same. Do **not** use **Deploy → New
   deployment**: that creates a new URL and the PC bridge stops working.

With clasp: `clasp deployments` (find the EXISTING ID), then
`clasp deploy -i <EXISTING_DEPLOYMENT_ID> -d "site feed"`.

### Step 3 - Copy the website feed token

1. Reload the Google Sheet tab (**F5**) so the menu picks up the new code.
2. Menu **Auto Bhavcopy → 3. Quarterly Results & Trend Tags → Website feed:
   setup info (read-only token)** (the first time Google may ask you to
   authorise - allow it).
3. Copy the token exactly. It cannot change your data: it reads the sheet
   and only keeps the website's own stored copy (hidden tab `Site_Feed`) and
   its 30-minute refresh trigger. It is not the PC bridge's secret code. The
   same token feeds the prices (`api/quotes`) and the whole site (`api/site`).
4. **Once after every New version deploy:** menu **Auto Bhavcopy → 3.
   Quarterly Results & Trend Tags → Website feed: rebuild now**. It reads the
   sheet (about a minute), stores the website data in the hidden tab
   `Site_Feed` and switches on its 30-minute auto-refresh. The box should say
   **main: OK** and **history: OK** (*history: NOT rebuilt - sheet is
   updating* while Phase 1 runs: try again later). **Website feed: stop
   auto-refresh** removes the refresh trigger; *rebuild now* switches it back on.
   Note: the refresh trigger runs the SAVED code (step 1), so saving a new
   `Code.gs` can change what the website shows within ~30 minutes, even
   before the New version deploy.

### Step 4 - Vercel environment variables

Vercel → project **stock-blueprint** → **Settings → Environment Variables**.
Add these three (Environments: Production and Preview). If one already
exists, use **⋯ → Edit** on it instead of adding it twice. Then **Save**.

| Name | Value |
|---|---|
| `MARKET_DATA_PROVIDER` | `sheet` |
| `SHEET_FEED_URL` | the EXISTING web app URL, ending in `/exec` - the same `url` as in the PC bridge `config.json`. Apps Script **Deploy → Manage deployments** shows it (and so does the sheet menu **PC Bridge: setup info**). |
| `SHEET_FEED_TOKEN` | the token from step 3 |

Never paste the URL or the token into GitHub, chat or e-mail.

### Step 5 - Redeploy on Vercel

Vercel → project → **Deployments** → the newest deployment → **⋯** (three
dots) → **Redeploy** → **Redeploy**. Environment variables only take
effect after a redeploy.

### Step 6 - Firebase copy (once)

The Firebase copy needs the new site files once (`web/config.js` points it
at the Vercel API; after that it shows the live data by itself):

1. GitHub → repo → **Code → Download ZIP** → unzip it (replace the old
   folder).
2. Open a terminal in that folder and run `firebase deploy --only hosting`.

### Step 7 - Check that it worked

1. Open https://stock-blueprint-sandy.vercel.app/ (and your Firebase
   address, `https://<project>.web.app`).
2. The status pill (top right) shows **DELAYED · time** during market hours
   (09:15-15:30 IST on trading days) or **EOD · time** after the close, on
   weekends and holidays. No yellow banner under the header.
3. **Overview → Data & provider status** (or click the pill): the first row
   **Site data (Google Sheet)** says **Live feed** with today's read time,
   and the note below says **Market-data provider: sheet (configured)**.
4. A yellow **"Showing a saved copy"** banner means the live feed did not
   answer; it names the reason:
   - *not configured* → steps 4 and 5;
   - *auth failed* / *does not support action "site"* → step 2 (New version)
     or step 3 (token copied exactly);
   - *did not return JSON* → the web app's **Who has access** must stay as it
     was (Anyone);
   - *sheet is updating* / *timed out* → Phase 1 is rewriting the sheet; try
     again in a few minutes;
   - *sheet feed returned an error* (or *timed out*) right after deploying →
     step 3 point 4 (**Website feed: rebuild now**) was not run yet.

### Step 8 - My Watchlists on every device (PIN)

My Watchlists (`#lists`) are kept in your Google Sheet (hidden tab
`Site_Watchlists`), so the phone, the Vercel site and the Firebase copy show
the same lists. It uses the same `SHEET_FEED_URL` + `SHEET_FEED_TOKEN` as the
live feed - **no new Vercel setting**. The lists are protected by a PIN that
the SHEET checks (Code2.gs `ab_wlFromSite_`):

1. Paste the new `Code.gs` and `Code2.gs`, Save, and do the **New version**
   deploy of the EXISTING web app (steps 1 and 2).
2. Reload the sheet. Menu **Auto Bhavcopy → 3. Quarterly Results & Trend Tags →
   My Watchlists sync: set / change PIN**: type a PIN of 6-20 letters or
   digits, then the same PIN again. Only a salted hash is kept (Script
   Properties `AB_WL_PIN`).
3. On each device, once: **My Watchlists → Watchlist PIN → Connect**. The lists
   already in that browser are added to the sheet's (a list with the same name
   on both becomes one list).
4. 5 wrong PINs in a row lock the lists for 15 minutes (then 30, 60 ... at most
   24 h). Setting the PIN again in the sheet unlocks them at once; devices
   with the old PIN then ask for the new one.
5. *Sync is not working: auth failed ... older version* → the New version
   deploy of step 1 was not done. *the sheet has no watchlist PIN yet* →
   point 2.

Server: `api/watchlists.js` (POST `{op: get|put, pin, base, state}`, never
cached, CORS for the Firebase copy). Browser: `web/ui/watchlist-sync.js`
(three-way merge `SB.wlModel.merge`, compare-and-swap on the sheet's
revision, offline changes go with the next sync).

## 2. Saved copy (optional, on your PC)

Only needed for localhost, the single-file preview, or as a newer fallback:

1. In the Google Sheet: **File → Download → Microsoft Excel (.xlsx)**.
2. Drag the downloaded file onto **`UpdateWebsiteData.bat`**. It writes
   `web/data/dashboard.js`, `web/data/history.js` and (when Node.js is
   installed) `web/data/workbook-analysis.js`.
   Personal tabs (Portfolio, Risk Manager, Control Panel, Trade Log, Trade
   Dashboard, Entry alerts) are never exported.
3. Commit and push the changed files (GitHub Desktop or `git push`).

## 3. Localhost

Double-click **`StartWebsite.bat`** → http://localhost:8080 (keep the black
window open). Or: `python -m http.server 8080 -d web`.
Localhost has no `api/`, so the page shows the saved copy (CACHED) with the
banner "This copy is not updated automatically". With `vercel dev`, set
`localStorage['sb:api'] = 'true'` in the browser console to use its `api/`.

## 4. Vercel (first setup)

1. Vercel → **Add New → Project → Import** the GitHub repo
   `stock-blueprint`. Keep the defaults (`vercel.json` sets the output
   folder `web` and the Mumbai region). **Deploy**.
2. Live feed + prices: section 1 above. Real-time prices instead (needs a
   Dhan account with Data API access): `MARKET_DATA_PROVIDER=dhan`,
   `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN` - the live site feed keeps working
   with `SHEET_FEED_URL` + `SHEET_FEED_TOKEN`. Details and licensing notes:
   `docs/MARKET_DATA.md`.
3. Every push to `main` redeploys automatically.

## 5. Firebase Hosting (static copy)

Firebase's free Spark plan serves static files only. The copy there uses
the Vercel API named in `web/config.js` (`remoteApi`) for the live feed and
prices; set `remoteApi: ''` to keep it on the saved copy.

```
npm install -g firebase-tools
firebase login
firebase deploy --only hosting      # uses firebase.json (public: web) and .firebaserc (project stock-blueprint)
```

## 6. Checks before pushing

```
npm test           # unit + parity + provider + site-feed tests
npm run lint       # eslint
npm run typecheck  # tsc (JSDoc / checkJs)
npm run build      # syntax, references, privacy scan, dist/ preview
npm run test:ui    # browser tests (Playwright; mocks api/, no network)
```
