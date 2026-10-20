# AUTO OHLC + PATTERN ENGINE (Stock Blueprint)

Google Apps Script bound to the Google Sheet "Copy of Stock Blueprint", plus a
Windows PC bridge that fetches screener.in pages for the sheet.

| Path | What |
|---|---|
| `Code.gs` | All Apps Script code (V8) |
| `appsscript.json` | Manifest - comes from `clasp pull`, do not edit web-app settings |
| `.clasp.json` | Script ID (from `clasp clone`) |
| `pcbridge/ScreenerBridge/` | Python bridge + .bat helpers (runs on the Windows PC) |
| `tools/check.sh` | Syntax check - run before every push |
| `CLAUDE.md` | Working rules for Claude Code |

## Deploy (Apps Script)
```
./tools/check.sh
clasp push
clasp deployments                       # find the EXISTING web-app deployment ID
clasp deploy -i <EXISTING_ID> -d "note" # never create a new deployment
```
Time triggers use the pushed code at once. The web app (`/exec`, used by the PC
bridge) only sees the change after the `clasp deploy -i` step.

## PC bridge
Copy `pcbridge/ScreenerBridge/` to the PC, run `Setup.bat`. `config.json`
holds the URL + token and is git-ignored.
