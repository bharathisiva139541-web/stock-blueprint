# Running and deploying the website

The site in `web/` is static: no build step, no database. The data files in
`web/data/` are generated from your sheet export. The optional `api/`
functions (Vercel only) add live or delayed quotes.

## 1. Update the data (on your PC)

1. In the Google Sheet: **File → Download → Microsoft Excel (.xlsx)**.
2. Drag the downloaded file onto **`UpdateWebsiteData.bat`**. It writes
   `web/data/dashboard.js`, `web/data/history.js` and (when Node.js is
   installed) `web/data/workbook-analysis.js`.
   Personal tabs (Portfolio, Risk Manager, Control Panel, Trade Log, Trade
   Dashboard, Entry alerts) are never exported.
3. Commit and push the changed files (GitHub Desktop or `git push`).

## 2. Localhost

Double-click **`StartWebsite.bat`** → http://localhost:8080 (keep the black
window open). Or: `python -m http.server 8080 -d web`.
On localhost there is no `api/`, so prices show as **CACHED** (the snapshot).

## 3. Vercel (live link + market-data API)

1. Vercel → **Add New → Project → Import** the GitHub repo
   `stock-blueprint`. Keep the defaults (`vercel.json` sets the output
   folder `web` and the Mumbai region). **Deploy**.
2. Optional market data: Vercel → Project → **Settings → Environment
   Variables** (see `.env.example`), then **Redeploy**:
   - Your sheet (delayed ~20 min, no new account): `MARKET_DATA_PROVIDER=sheet`,
     `SHEET_FEED_URL` = the web app /exec address, `SHEET_FEED_TOKEN` = the
     token from the sheet menu **3. Quarterly Results & Trend Tags → Website
     feed: setup info**. The web app must run the new `Code.gs` version
     (**Deploy → Manage deployments → pencil → Version: New version →
     Deploy** - never "New deployment").
   - Dhan (real-time, needs a Dhan account with Data API access):
     `MARKET_DATA_PROVIDER=dhan`, `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN`.
   Details and licensing notes: `docs/MARKET_DATA.md`.
3. Every push to `main` redeploys automatically.

## 4. Firebase Hosting (static copy)

Firebase's free Spark plan serves static files only, so the `api/`
functions do not run there and prices show as CACHED.

```
npm install -g firebase-tools
firebase login
firebase deploy --only hosting      # uses firebase.json (public: web) and .firebaserc (project stock-blueprint)
```

## 5. Checks before pushing

```
npm test           # unit + parity + provider tests
npm run lint       # eslint
npm run typecheck  # tsc (JSDoc / checkJs)
npm run build      # syntax, references, privacy scan, dist/ preview
```
