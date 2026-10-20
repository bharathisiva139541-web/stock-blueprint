# Stock Blueprint

Google Apps Script engine (`Code.gs`, bound to the Google Sheet "Copy of
Stock Blueprint"), a Windows PC bridge for screener.in, and a research
dashboard website (`web/`) built on the same rules.

| Path | What |
|---|---|
| `Code.gs` | All Apps Script code (V8) - the authoritative engine |
| `pcbridge/ScreenerBridge/` | Python bridge + .bat helpers (runs on the Windows PC) |
| `web/` | Static dashboard: Overview, Watchlist, Daily Suggestions, Industries, Strategy Settings, Patterns & FVG, Excel Analysis, Results, Alerts & Trades, Backtesting, IPOs & Markets |
| `web/lib/` | Engine modules (patterns, FVG, indicators, strategy, risk, backtest, classification, xlsx reader) - shared with the Node tests |
| `api/` | Optional Vercel functions: market-data providers (Dhan / your sheet / none) |
| `tools/` | `export_xlsx.py` (sheet export → web/data), `analyze_workbook.js`, `build.js` |
| `tests/` | `node --test` suites, incl. parity with the sheet's own outputs |
| `docs/` | `ARCHITECTURE.md`, `STRATEGY.md`, `MARKET_DATA.md`, `DEPLOY.md` |

Website: see `docs/DEPLOY.md` (localhost, Vercel, Firebase).
Checks: `npm test && npm run lint && npm run typecheck && npm run build`.

## Apps Script deploy
```
./tools/check.sh
clasp push
clasp deployments                       # find the EXISTING web-app deployment ID
clasp deploy -i <EXISTING_ID> -d "note" # never create a new deployment
```
Time triggers use the pushed code at once. The web app (`/exec`, used by the
PC bridge and the website feed) only sees a change after `clasp deploy -i`.

## PC bridge
Copy `pcbridge/ScreenerBridge/` to the PC, run `Setup.bat`. `config.json`
holds the URL + token and is git-ignored.
