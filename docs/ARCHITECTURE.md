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
| `web/lib/*.js` | Pure engine modules (no DOM): shared by the browser and Node tests |
| `web/data/*.js` | Generated data files (`window.SB_DATA`, ...) made by `tools/` |
| `api/*.js` | Vercel serverless functions (Node 18+, CommonJS) |
| `api/_lib/` | Server-only code: provider adapters, cache, validation |
| `tools/` | Offline pipelines (xlsx export, bundling, checks) |
| `tests/*.test.js` | `node --test` unit/integration tests |

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
labelled `CACHED` with the sheet's own refresh time. Nothing is ever shown
as LIVE unless a provider returned it as real-time during this session.

## Privacy

The site and repo are public. Personal data (capital, positions, entry
prices, trades, P&L, e-mails, tokens) is never exported to `web/data/`.
Risk settings, the trade journal, alert rules and strategy edits live
only in the viewer's browser (`localStorage`), with export/import as
JSON files. Uploaded workbooks are parsed in the browser and never sent
anywhere.
