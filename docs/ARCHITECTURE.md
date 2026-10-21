# Website architecture (web/ + api/)

The website is a static, build-free dashboard (`web/`) plus optional
server-side functions (`api/`, Vercel only) for live market data.
`Code.gs` (Apps Script) remains the authoritative engine inside the
Google Sheet; the website re-implements the same rules in JavaScript so
signals can be explained, re-run and backtested.

## Folders

| Path | What |
|---|---|
| `web/index.html`, `web/style.css`, `web/app.js` | UI shell and pages (vanilla JS, no framework, no build) |
| `web/config.js` | Public site settings: `remoteApi` (the Vercel API the static Firebase copy uses) |
| `web/lib/*.js` | Pure engine modules (no DOM): shared by the browser and Node tests |
| `web/data/*.js` | Saved copy (`window.SB_DATA`, `SB_HISTORY`, ...) made by `tools/` - the fallback |
| `api/*.js` | Vercel serverless functions (Node 18+, CommonJS) |
| `api/_lib/` | Server-only code: provider adapters, cache, validation |
| `tools/` | Offline pipelines (xlsx export, bundling, checks) |
| `tests/*.test.js` | `node --test` unit/integration tests |

## Data flow

```
Google Sheet ──(Code.gs doPost: action 'site' part main|history, action 'snapshot';
               read-only token AB_FEED_TOKEN - never the PC bridge token)──▶
Vercel api/site?part=main|history  +  api/quotes (provider 'sheet')   [secrets stay server-side]
   ──(JSON, CDN-cached: main 5 min, history 30 min; CORS *)──▶
browser on Vercel (same origin)  /  browser on Firebase (remote base from web/config.js)
fallback on any failure: web/data/dashboard.js + history.js (saved copy), clearly labelled
```

- `api/site` returns `{ok, part, readAt, fetchedAt, stale, staleReason?, session, priceState, data}`.
  `data` is exactly what `tools/export_xlsx.py` writes (`SB_DATA` / `SB_HISTORY`), built by
  Code.gs with the same allow-list (no personal tabs, columns, e-mails or tokens).
- API base (`SB.apiBase()` in `web/app.js`): `''` on Vercel (same origin); `remoteApi` on
  `*.web.app` / `*.firebaseapp.com`; `null` (saved copy only) on localhost, `file://`
  and the single-file preview, unless `localStorage['sb:api'] = true` (then same origin,
  for `vercel dev`).
- Boot: loading card → `GET api/site?part=main` (32 s timeout: longer than api/site's own
  25 s wait for the sheet and Vercel's 30 s limit, so the server's answer always arrives).
  `ok:true` → every price is `priceState` (DELAYED in market hours, EOD after the close,
  CACHED when `stale`) as of `readAt`; never LIVE. DELAYED ages from `readAt` (30 min, like a
  quote), so an older CDN copy (stale-while-revalidate) shows as CACHED. Otherwise → `window.SB_DATA` if inlined (preview), else
  `data/dashboard.js`, all prices CACHED, and a banner under the header:
  "Showing a saved copy from <date> (<N> days old). Live data could not be loaded:
  <reason>." (static hosts: "This copy is not updated automatically."). A live read that
  is the server's last good copy (`stale:true`) gets a lighter banner.
- Candles (`SB.loadHistory`): after a live boot `GET api/site?part=history`, else / on
  failure `data/history.js` (the reason shows in Overview → Data & provider status).
- Quotes (`api/market-status` + `api/quotes` through the same base): polled every 60 s
  while LIVE, every 5 min while DELAYED and the NSE session is open, otherwise not.
  A provider failure is shown as a message (pill tooltip, Data & provider status)
  without changing the state of the prices shown.

## Module convention (web/lib)

Every engine module is a UMD-style file that works as a classic
`<script>` in the browser **and** as `require()` in Node:

```js
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else (root.SB = root.SB || {}).indicators = factory();   // window.SB.indicators
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  // ... pure functions only: no DOM, no fetch, no Date.now() unless passed in
  return { ema: ema, rsi: rsi };
});
```

Rules:
- Pure functions; inputs validated; never throw on bad data - return
  `null` / `{ ok:false, reason }` instead.
- Candles are arrays of `{ t: 'YYYY-MM-DD', o, h, l, c, v }`, **oldest first**.
  A function evaluating "bar i" may only read bars `0..i` (no look-ahead).
- Percent values are percent numbers (`2.5` means 2.5 %), never fractions.
- Dates are ISO strings in Asia/Kolkata (`YYYY-MM-DD` or `YYYY-MM-DD HH:MM`).

## Data states (shown in the UI)

`LIVE` (provider real-time), `DELAYED` (provider/sheet with a known delay),
`EOD` (last completed session), `CACHED` (older copy kept locally /
snapshot file), `UNAVAILABLE`. Snapshot data exported from the workbook is
labelled `CACHED` with the sheet's own refresh time; sheet data read through
the live feed is `DELAYED` / `EOD` (or `CACHED` when stale). Nothing is ever
shown as LIVE unless a provider returned it as real-time during this session.

## Privacy

The site and repo are public. Personal data (capital, positions, entry
prices, trades, P&L, e-mails, tokens) is never exported to `web/data/` nor
sent by the live feed (Code.gs applies the export's allow-list; `api/site`
refuses data containing e-mail / web-app URL / trade markers).
Risk settings, the trade journal, alert rules and strategy edits live
only in the viewer's browser (`localStorage`), with export/import as
JSON files. Uploaded workbooks are parsed in the browser and never sent
anywhere.
