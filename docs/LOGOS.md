# Company logos

Owner, 02-Nov-2026: "use the best free source to update logos in our website".

**Source:** [github.com/dharunashokkumar/indian-listed-company-logos](https://github.com/dharunashokkumar/indian-listed-company-logos)
- `data/logos/nse/NSE_<TICKER>.svg`: 3,083 NSE logos, collected from TradingView. The logos are trademarks of
their companies; the project's README asks for removal requests to go to its issues.

**What this repo holds:** only `web/data/logos.js` (~26 KB, made by `tools/build_logos.js`):

```js
window.SB_LOGO_SOURCE  = { repo, commit, count, urls: [jsDelivr CDN @commit, GitHub raw @commit] };
window.SB_LOGO_TICKERS = 'TCS INFY BAJAJ_AUTO ...';          // the tickers that have a logo
window.SB_LOGO_ALIASES = { HEG: 'HEGAM', ... };             // old tickers -> current (one company only)
window.SB_LOGOS        = {};                                // hand-checked exceptions: 'NSE:SYM' -> { url, verified: true }
```

The image files are **not** copied into this public repo; the browser loads them from one pinned commit, so the
logos cannot change under us.

**How a logo is picked (`web/ui/core.js` `logoUrls` / `logoHtml`):** by the NSE symbol only - the symbol itself,
TradingView's `_` for NSE's `-` (`BAJAJ-AUTO` -> `NSE_BAJAJ_AUTO.svg`), or the source's old ticker. Never guessed
from the company name. Order tried: jsDelivr, then GitHub's raw file, then the neutral two-letter monogram. An
address that failed 3 times without ever loading is tried last for the rest of the visit. Images are lazy-loaded
on a white plate (`--img-bg`), so they stay readable in the dark theme.

**Coverage (02-Nov-2026):** 1,720 of the 1,800 Main stocks; the rest are mostly October 2026 IPOs and SME
stocks the source does not have yet - they keep the monogram.

**Updating** (new IPOs get logos when the source adds them):

```sh
git clone --depth 1 https://github.com/dharunashokkumar/indian-listed-company-logos ../indian-listed-company-logos
npm run logos -- ../indian-listed-company-logos
```

The commit of the checkout is pinned in `web/data/logos.js`. Tests: `tests/logos.test.js`.
