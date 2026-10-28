# Market data (server side, `api/`)

The website (`web/`) is static and works without any of this. The optional
Vercel functions in `api/` add prices for Indian (NSE) equities from one
**provider**, chosen with an environment variable. Secrets stay on the
server: the browser only ever talks to `/api/...` and never sees a token.

```
browser  ->  /api/quotes, /api/history, /api/market-status   (Vercel functions)
                 |
                 +-- provider "dhan"   -> DhanHQ v2 REST API (your Dhan account)
                 +-- provider "sheet"  -> your Google Sheet's Apps Script web app
                 +-- provider "none"   -> nothing (default): always UNAVAILABLE

browser  ->  /api/site?part=main|history   (any provider setting)
                 +-- always your Google Sheet's Apps Script web app (action "site")
```

`/api/site` (the **live site feed**, see below) gives the website the whole
sheet export live; it only needs `SHEET_FEED_URL` + `SHEET_FEED_TOKEN`.

## Endpoints

All answers are JSON. GET only (other methods get `405`). CORS
`Access-Control-Allow-Origin: *` is sent on GET replies because the data is
public market data with no secrets in it. Bad input gives `400 {error}`.
A provider problem (not configured, auth failed, rate limit, ...) is still a
`200` with `state: "UNAVAILABLE"` and a `message`, so the page can show it.

| Endpoint | Returns |
|---|---|
| `GET /api/market-status` | `{ provider:{name, configured, requires, licensing}, session:{state, now, lastCompletedSession, isTradingDay, holiday, nextTradingDay, calendarCovered}, status:{ok, state, message} }` |
| `GET /api/quotes?symbols=SBIN,TCS` | `{ state, source, asOf, items:[...], errors:[{symbol, reason}] }` |
| `GET /api/history?symbol=SBIN&from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ state, source, symbol, from, to, interval:'1d', candles:[{t,o,h,l,c,v}], errors }` |
| `GET /api/site?part=main\|history` | `{ ok, configured, part, readAt, fetchedAt, stale, staleReason?, session, priceState, data }` - see "Live site feed" |

Quote item: `{ id:'NSE:SBIN', symbol, exchange:'NSE', ltp, prevClose, open,
high, low, volume, changePct, lastTradeTime, state }`. `changePct` is a
percent number (`1.56` = 1.56 %), computed from `ltp` and `prevClose`.
Times are IST strings `YYYY-MM-DD HH:MM`. Missing values are `null`, never
made up. An error with `symbol: "*"` means the whole request failed.
`partial: true` means some symbols failed for a temporary reason (rate
limit, timeout); such answers are cached only briefly.

Input rules:
- `symbols`: 1-500 NSE symbols, comma separated; each must match
  `^[A-Z0-9&_-]{1,20}$` after upper-casing (an `NSE:` prefix is accepted).
  Send `&` URL-encoded: `M%26M`.
- `history`: daily candles only (`interval=1d`), real dates, `from <= to`,
  at most 3 years. Defaults: `to` = today (IST), `from` = `to` - 365 days.
  A `to` in the future is cut to today. Candles are oldest first; the
  current day's candle is left out until the session has closed.

## Providers

| `MARKET_DATA_PROVIDER` | Needs | Data | State |
|---|---|---|---|
| `none` (default / empty) | - | nothing | always `UNAVAILABLE` |
| `dhan` | `DHAN_CLIENT_ID`, `DHAN_ACCESS_TOKEN` | real-time quotes + daily history | `LIVE` / `DELAYED` / `EOD` |
| `sheet` | `SHEET_FEED_URL`, `SHEET_FEED_TOKEN` | the sheet's own prices (GOOGLEFINANCE, ~20 min late) | `DELAYED` / `EOD` / `CACHED`, never `LIVE`; no history |

An unknown value behaves like `none` and says so in the message.

### dhan (DhanHQ v2)

- Quotes: `POST https://api.dhan.co/v2/marketfeed/quote`, headers
  `access-token` + `client-id`, body `{"NSE_EQ":[securityId,...]}`. Up to
  1000 ids per request and about 1 request per second: larger lists are
  split and spaced ~1.1 s apart. A `429` waits (2 s, or `Retry-After`) and
  retries once; if it is still limited the symbols not fetched are listed
  in `errors` and the rest is returned (`partial: true`).
- History: `POST https://api.dhan.co/v2/charts/historical` with
  `{securityId, exchangeSegment:'NSE_EQ', instrument:'EQUITY', expiryCode:0, oi:false, fromDate, toDate}`;
  the `open/high/low/close/volume/timestamp` arrays become candles dated in IST.
- Status: `GET https://api.dhan.co/v2/profile` checks the token and whether
  the Data API plan is active (cached for 1 minute).
- Symbol -> securityId comes from the public scrip master CSV
  `https://images.dhan.co/api-data/api-scrip-master.csv` (downloaded by the
  server without any token, streamed, NSE cash-equity rows kept: segment
  `E`, series EQ / BE / BZ / SM / ST / SZ; EQ wins if a symbol appears
  twice). Kept in memory for 12 hours per warm function instance.
- Errors: `401/403` (or `DH-901`) -> `UNAVAILABLE`, "auth failed" (the
  token is never echoed; Dhan's own error text is not passed through, only
  its code such as `DH-901`). `DH-902` -> Data API access denied. Every
  request has a 10 s timeout (AbortController; the scrip master gets 20 s).
  Non-JSON replies and unknown symbols are reported per symbol.

**Assumptions to verify against the current DhanHQ docs** (they are also
listed at the top of `api/_lib/providers/dhan.js`):

1. `ohlc.close` in the quote response is the **previous** session's close
   (as in most Indian broker APIs). If Dhan's `ohlc.close` is missing/0,
   `prevClose = last_price - net_change` is used (`net_change` assumed to
   be the absolute change). If this is wrong, `changePct` is wrong.
2. `last_trade_time` is IST `DD/MM/YYYY HH:MM:SS`; `01/01/1980 ...` means
   "no trade" and is treated as unknown.
3. `toDate` of the historical API is exclusive, so one day is added; the
   result is filtered to `[from, to]` anyway.
4. Historical `timestamp` values are epoch seconds.

### sheet (your Google Sheet)

The server POSTs `{token, action:'snapshot'}` to the web app `/exec` URL and
expects

```json
{ "ok": true, "asOf": "YYYY-MM-DD HH:MM", "readAt": "YYYY-MM-DD HH:MM", "delayMinutes": 20,
  "cols": ["sym", "price", "chg", "..."], "rows": [["SBIN", 812.5, 1.56, "..."]] }
```

with the same column keys as `main` in `web/data/dashboard.js` (`sym`,
`price`, `chg` are required; `prevClose`/`prev`, `open`, `high`, `low`,
`volume`/`vol` are used when present). `asOf` (or `readAt` when `asOf` is
missing) is the time the sheet was read. The snapshot is cached for 60 s.

- `Code.gs` answers `snapshot` in `ab_feedSnapshot_` (Main's SYMBOL /
  MKT Price / % Change; it reads only Main's first 10 rows to find the
  header and then just those 3 columns). The web app only runs new `Code.gs` after
  **Deploy > Manage deployments > pencil > Version: New version > Deploy**
  on the EXISTING deployment (never "New deployment": that changes the URL
  the PC bridge uses). An older version answers `bad token` or
  `unknown action`, which the site reports.
- `SHEET_FEED_TOKEN` is the **separate** feed token, which never changes the
  owner's data (it reads the sheet; `site` keeps only its own stored copy in
  `Site_Feed` and that copy's refresh trigger) (script
  property `AB_FEED_TOKEN`; sheet menu *3. Quarterly Results & Trend Tags >
  Website feed: setup info (read-only token)*), never the PC bridge token:
  the bridge token can also write (`put`, `process`). The same feed token
  serves both `snapshot` (prices) and `site` (the live site feed).
- `SHEET_FEED_URL` must be the `https://script.google.com/.../exec` URL and
  the web app must allow access by "Anyone", otherwise Google returns a
  sign-in page ("did not return JSON").
- `history()` is always `UNAVAILABLE`: the sheet keeps only about 30 daily
  bars (History30), not enough for charts/backtests.

## Live site feed (`/api/site`)

The website's own data (everything `tools/export_xlsx.py` puts into
`web/data/dashboard.js` and `history.js`) read **live** from the Google
Sheet, so the site no longer needs the manual xlsx export. The static
files stay as the offline / failure fallback (the browser decides, see
`docs/ARCHITECTURE.md`).

```
GET /api/site?part=main      -> data = window.SB_DATA      (dashboard.js shape)
GET /api/site?part=history   -> data = window.SB_HISTORY   (history.js shape)
GET /api/site?part=history60 -> data = window.SB_HISTORY60 (history60.js shape: History60's
                                candles History30 does not have; empty bars without that tab)
```

- Needs only `SHEET_FEED_URL` + `SHEET_FEED_TOKEN` (independent of
  `MARKET_DATA_PROVIDER`). The server POSTs `{token, action:'site', part}`
  to the web app (25 s timeout; `vercel.json` allows 30 s) and expects
  `{ ok:true, part, readAt:'YYYY-MM-DD HH:MM', builtAt, stored, tz:'Asia/Kolkata', data }`
  from `Code.gs` (`ab_feedSite_`, same feed token as `snapshot`).
- **Stored copy** (`Code.gs`, "WEBSITE SITE FEED - STORED COPY"): building a
  part takes 30+ s, so `Code.gs` builds it ahead and keeps the JSON in the
  hidden tab `Site_Feed` (two slots per part, 45,000-character cells, meta in
  Script Properties). `site` answers from it at once (`stored: true`, no
  Main / History30 read); `readAt` stays "when the sheet was read" (the
  build), so the price state below ages correctly. The time trigger
  `ab_siteFeedTrigger_` (every 30 min) rebuilds `main` after 25 min on
  weekdays 09:00-16:15 and every day 17:30-21:30 (otherwise 3 h) plus once
  from 16:00 on weekdays (settled close), and `history` every 6 h plus once
  after the evening cutoff (the latest Control Panel Phase 1-3 time + 25 min,
  ~19:26). A copy built by code with an older `AB_SITE_FEED_FORMAT` is never
  served and is rebuilt (bump it when the feed output or allow-list
  changes); the trigger runs the SAVED code, so a push alone updates the
  stored feed within ~30 min. No stored copy yet: built on
  demand (`stored: false`, slow once), or `site feed is being prepared` while
  another build runs. Menu: *Website feed: rebuild now* (run once after each
  New version deploy) / *stop auto-refresh*.
- `part` other than `main` / `history` -> `400 {error}` (`no-store`).
- Not configured -> `200 { ok:false, configured:false, part, message }`
  naming the missing variable(s).
- Success -> `200`:

```json
{ "ok": true, "configured": true, "part": "main",
  "readAt": "2026-10-14 10:55", "fetchedAt": "2026-10-14 11:00",
  "stale": false,
  "session": { "state": "open", "lastCompletedSession": "2026-10-13" },
  "priceState": "DELAYED",
  "data": { "...": "same keys as window.SB_DATA / window.SB_HISTORY" } }
```

  `readAt` = when the sheet was read (IST), `fetchedAt` = when this answer
  was made, `priceState` = `sheetPriceState(readAt, now)` (table below).
- A refresh that fails (sheet busy / updating, timeout, bad answer, privacy
  guard) serves the **last good copy** of the warm instance instead:
  `stale: true`, `staleReason: "<why>"`, `priceState: "CACHED"`. With no
  copy at all the answer is `200 { ok:false, configured:true, part, message }`
  and the browser uses the static files.
- **Privacy guard**: before anything is cached or served, the JSON of
  `data` is checked for the same markers as the build's scan of `web/data`
  (an e-mail address, `script.google.com/macros`, an `AKfyc...` deployment
  id, `"trades":`, `"tradeStats"`). A hit is a failure: `blocked: the sheet
  feed contained personal-data markers`. The allow-list itself lives in
  `Code.gs` (same rules as `tools/export_xlsx.py`).
- Reasons are fixed texts; the sheet's own error text is never passed on:

| Sheet answer | `message` / `staleReason` |
|---|---|
| no answer in 25 s | `sheet feed timed out (the sheet may be busy)` |
| network error | `sheet feed not reachable (network error)` |
| HTML / empty page | `sheet feed did not return JSON (is the web app deployed with access "Anyone"?)` |
| non-2xx | `sheet feed failed (HTTP <status>)` |
| `bad token` | `auth failed: the sheet rejected SHEET_FEED_TOKEN (if the token is right, the web app still runs an older version without the site feed: deploy a New version of the EXISTING web-app deployment)` |
| `unknown action` / `unknown part` | `the sheet web app does not support action/part "..." yet (... deploy a New version of the EXISTING web-app deployment)` |
| `sheet busy ...` | `sheet busy - try again shortly` |
| `sheet is updating (History30 has N of M symbols) ...` | `sheet is updating (History30 has N of M symbols) - try again shortly` (Phase 1 is rewriting History30) |
| `site feed is being prepared - try again in a minute` (no stored copy yet, a build is running) | `sheet feed returned an error` |
| `data` without `main.cols/rows` or `dates/cols/bars`, or empty | `malformed site feed (...)` / `the sheet feed returned no Main rows ...` / `... no History30 bars` |
| any other error | `sheet feed returned an error` |

- An old web-app version answers `bad token` for `site` (the request falls
  through to the PC-bridge token check), hence the hint in that message.
- Size: `main` is about 1 MB of JSON, `history` about 2 MB (Vercel's limit
  is 4.5 MB per response; in `Site_Feed` about 24 and 44 cells). Serving the
  stored copy takes the web app a second or two; the CDN still keeps `main`
  for 5 min and `history` for 30 min.

## How the data state is decided

States are the ones from `docs/ARCHITECTURE.md`: `LIVE`, `DELAYED`, `EOD`,
`CACHED`, `UNAVAILABLE`. NSE session (Asia/Kolkata, independent of the
server's time zone, see `api/_lib/market-calendar.js`):

| Session | When |
|---|---|
| `pre-open` | 09:00:00 - 09:14:59 on a trading day |
| `open` | 09:15:00 - 15:30:00 on a trading day |
| `closed` | other times on a trading day |
| `holiday` / `weekend` | NSE holiday on a weekday / Saturday, Sunday |

`lastCompletedSession` = today after 15:30 on a trading day, otherwise the
previous trading day.

Dhan quote, per item:
- session `open` and last trade at most 5 minutes old -> `LIVE`
- session `open`, traded today but longer ago (illiquid stock, feed lag) or
  no trade time -> `DELAYED`; last trade on an earlier day -> `EOD`
- outside the session -> `EOD` (last completed session), except a trade
  time newer than the last completed session (e.g. pre-open) -> `DELAYED`

The response `state` is the **least fresh** item state, so a response is
`LIVE` only if every item is. Dhan history is always `EOD`.

Sheet data (the `sheet` provider and `/api/site`, both use
`sheetPriceState(readAt, now)` in `api/_lib/providers/sheet.js`), never
`LIVE` because GOOGLEFINANCE is ~20 min late:

| Sheet read time (`readAt` / `asOf`) | State |
|---|---|
| missing | `CACHED` |
| today, 09:15 or later, while the market is open | `DELAYED` |
| today, 09:15 or later, after the close but before 16:00 (last prices still settling) | `DELAYED` |
| after the 15:30 close of the last completed session (evenings, weekends, holidays, before 09:15) | `EOD` |
| older than that (the sheet stopped refreshing, or an old copy) | `CACHED` |

Weekends and holidays are therefore `EOD` (or `CACHED`), never `DELAYED`.
`/api/site` answers `CACHED` whenever it serves its last good copy after a
failed refresh (`stale: true`).

## Caching

| What | CDN (`Cache-Control`) | Memory (per warm instance) |
|---|---|---|
| quotes | `s-maxage` 15 s open, 30 s pre-open, 60 s closed/holiday/weekend | same |
| history | `s-maxage` 6 h | 6 h |
| market-status | `s-maxage` 30 s | Dhan profile 60 s, sheet snapshot 60 s |
| site `part=main` | `s-maxage` 5 min, `stale-while-revalidate` 1 h | 5 min (last good copy kept for stale-on-error) |
| site `part=history` / `part=history60` | `s-maxage` 30 min, `stale-while-revalidate` 6 h | 30 min (same) |
| site served stale (`stale: true`) | `s-maxage` 60 s | - |
| UNAVAILABLE / partial / site `ok:false` | `s-maxage` 15 s | not cached |
| 4xx / 5xx | `no-store` | - |

The memory cache only lives while Vercel keeps an instance warm; the CDN
cache is what protects the providers from many visitors.

## Setting the environment variables in Vercel

1. vercel.com > your project > **Settings** > **Environment Variables**.
2. Add `MARKET_DATA_PROVIDER` = `dhan` (or `sheet`), then the provider's
   variables (`DHAN_CLIENT_ID` + `DHAN_ACCESS_TOKEN`, or `SHEET_FEED_URL` +
   `SHEET_FEED_TOKEN`). Tick the environments (Production / Preview).
   Mark the tokens (and `SHEET_FEED_URL`) as **Sensitive**.
   `SHEET_FEED_URL` + `SHEET_FEED_TOKEN` also switch on the live site feed
   (`/api/site`), whatever `MARKET_DATA_PROVIDER` says.
3. **Deployments** > latest > **...** > **Redeploy** (variables only reach
   functions after a new deployment).
4. Open `https://<your-site>/api/market-status` and check `provider.configured`
   and `status.message`; open `https://<your-site>/api/site?part=main` and
   check `ok` (or `message`).

For local testing with `vercel dev`, copy `.env.example` to `.env`
(git-ignored) and fill it in. Never commit real values; never paste tokens
into chats or issues.

Dhan access tokens expire. When that happens the site shows "auth failed":
generate a new token in your Dhan account (DhanHQ / API section), update
`DHAN_ACCESS_TOKEN` in Vercel and redeploy.

## Licensing and terms (please verify)

- **Dhan**: the Data APIs need an active Dhan trading account and may need
  a separate (paid) **Data API plan**; `/api/market-status` reports when the
  plan is not active. Read Dhan's API terms for what you may display.
- **NSE data** is licensed by the exchange; redistribution normally needs
  an NSE data-vendor licence. This site only displays prices to the
  account owner's own visitors; it does not resell or bulk-export them.
  Whether a public site is allowed under your Dhan/NSE terms is for you to
  verify - if in doubt keep the site private or use `none`/`sheet`.
- **Google Finance** (sheet provider): delayed, "informational purposes
  only", not for trading; redistribution is restricted by Google and the
  exchanges.
- This code only reads market data. It never places orders.

## Privacy

No personal data (positions, capital, trades, e-mails) goes through these
functions. `/api/site` carries only what the public export carries:
`Code.gs` applies the `tools/export_xlsx.py` allow-list (never Portfolio,
Risk Manager, Control Panel, Trade Log, Trade Dashboard, Entry alerts,
entry/stop/qty columns), and the server's privacy guard refuses any answer
with personal-data markers. Responses never contain environment values;
secret values are also scrubbed from every string in a response and from
log lines as a second line of defence. Upstream error texts are not passed
through.

## Limitations

- The NSE holiday list (2025, 2026) in `api/_lib/market-calendar.js` must
  be updated **every year** from the official NSE circular (and for any
  one-off holiday NSE announces). For uncovered years only weekends are
  skipped and `/api/market-status` shows a note. Muhurat trading and other
  special sessions are not modelled.
- After 15:30 the Dhan `last_price` is the last traded price, which can
  differ slightly from NSE's official closing price.
- The scrip master is large (all exchanges and F&O). A cold instance
  downloads it once (up to 20 s) before the first quote; later calls use the
  12 h memory copy. Running the functions in the Mumbai region (`bom1`)
  and allowing a longer function duration in `vercel.json` helps.
- Rate limits are per instance; several warm instances can together exceed
  Dhan's 1 request/second (they then get 429 -> back off -> partial).
- No WebSocket streaming; the page has to poll `/api/quotes`.

## Code map

| File | What |
|---|---|
| `api/market-status.js`, `api/quotes.js`, `api/history.js`, `api/site.js` | the endpoints (`module.exports = async (req, res)`; `.createHandler(deps)` for tests) |
| `api/_lib/sheet-feed.js` | `postFeed()` / `configured()`: the one client for the sheet web app (used by `sheet` and `api/site.js`) |
| `api/_lib/providers/index.js` | `getProvider(env, deps)` |
| `api/_lib/providers/{none,dhan,sheet}.js` | the providers; `dhan-scrip-master.js` parses the CSV; `sheet.js` also exports `sheetPriceState` |
| `api/_lib/market-calendar.js` | IST helpers, NSE holidays, `sessionState`, `lastCompletedSession` |
| `api/_lib/cache.js` | memory TTL cache + `Cache-Control` values |
| `api/_lib/validate.js` | query validation |
| `api/_lib/http.js`, `api/_lib/fetch-util.js` | JSON/CORS replies, redaction, fetch with timeout |
| `tests/providers.test.js`, `tests/market-calendar.test.js`, `tests/site-api.test.js` | `node --test` (fetch is mocked; no network) |
