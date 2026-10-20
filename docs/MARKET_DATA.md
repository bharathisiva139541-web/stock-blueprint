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
```

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
| `sheet` | `SHEET_FEED_URL`, `SHEET_FEED_TOKEN` | the sheet's own prices (GOOGLEFINANCE, ~20 min late) | `DELAYED` / `CACHED`, never `LIVE`; no history |

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
{ "ok": true, "asOf": "YYYY-MM-DD HH:MM", "delayMinutes": 20,
  "cols": ["sym", "price", "chg", "..."], "rows": [["SBIN", 812.5, 1.56, "..."]] }
```

with the same column keys as `main` in `web/data/dashboard.js` (`sym`,
`price`, `chg` are required; `prevClose`/`prev`, `open`, `high`, `low`,
`volume`/`vol` are used when present). The snapshot is cached for 60 s.

- `Code.gs` does **not** have a `snapshot` action yet (it answers
  `unknown action`, which the site reports). Adding it is a `Code.gs`
  change, and the web app only sees it after **Deploy > Manage deployments >
  pencil > Version: New version > Deploy** on the EXISTING deployment
  (never "New deployment": that changes the URL the PC bridge uses).
- Use a **separate, read-only token** for `SHEET_FEED_TOKEN` (for example
  a new script property) rather than the PC bridge token: the bridge token
  can also write (`put`, `process`).
- `SHEET_FEED_URL` must be the `https://script.google.com/.../exec` URL and
  the web app must allow access by "Anyone", otherwise Google returns a
  sign-in page ("did not return JSON").
- `history()` is always `UNAVAILABLE`: the sheet keeps only about 30 daily
  bars (History30), not enough for charts/backtests.

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

Sheet: `DELAYED` when `asOf` is from today while the market is open, or
from the last completed session (or later) when it is closed; otherwise
`CACHED` (the sheet stopped refreshing). Never `LIVE`.

## Caching

| What | CDN (`Cache-Control`) | Memory (per warm instance) |
|---|---|---|
| quotes | `s-maxage` 15 s open, 30 s pre-open, 60 s closed/holiday/weekend | same |
| history | `s-maxage` 6 h | 6 h |
| market-status | `s-maxage` 30 s | Dhan profile 60 s, sheet snapshot 60 s |
| UNAVAILABLE / partial | `s-maxage` 15 s | not cached |
| 4xx / 5xx | `no-store` | - |

The memory cache only lives while Vercel keeps an instance warm; the CDN
cache is what protects the providers from many visitors.

## Setting the environment variables in Vercel

1. vercel.com > your project > **Settings** > **Environment Variables**.
2. Add `MARKET_DATA_PROVIDER` = `dhan` (or `sheet`), then the provider's
   variables (`DHAN_CLIENT_ID` + `DHAN_ACCESS_TOKEN`, or `SHEET_FEED_URL` +
   `SHEET_FEED_TOKEN`). Tick the environments (Production / Preview).
   Mark the tokens as **Sensitive**.
3. **Deployments** > latest > **...** > **Redeploy** (variables only reach
   functions after a new deployment).
4. Open `https://<your-site>/api/market-status` and check `provider.configured`
   and `status.message`.

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
functions. Responses never contain environment values; secret values are
also scrubbed from every string in a response and from log lines as a
second line of defence. Upstream error texts are not passed through.

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
| `api/market-status.js`, `api/quotes.js`, `api/history.js` | the endpoints (`module.exports = async (req, res)`; `.createHandler(deps)` for tests) |
| `api/_lib/providers/index.js` | `getProvider(env, deps)` |
| `api/_lib/providers/{none,dhan,sheet}.js` | the providers; `dhan-scrip-master.js` parses the CSV |
| `api/_lib/market-calendar.js` | IST helpers, NSE holidays, `sessionState`, `lastCompletedSession` |
| `api/_lib/cache.js` | memory TTL cache + `Cache-Control` values |
| `api/_lib/validate.js` | query validation |
| `api/_lib/http.js`, `api/_lib/fetch-util.js` | JSON/CORS replies, redaction, fetch with timeout |
| `tests/providers.test.js`, `tests/market-calendar.test.js` | `node --test` (fetch is mocked; no network) |
