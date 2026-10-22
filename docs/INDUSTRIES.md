# Industry & Sector Intelligence

The Industries section (`#industries`) is an explorer over the official NSE four-level
industry classification, connected to the stocks in the Main tab, their prices and
candles, and the active strategy.

## Classification source

| Item | Value |
|---|---|
| Structure | NSE Indices Industry Classification Structure: Macro-Economic Sector > Sector > Industry > Basic Industry |
| Version | July 2023 (`version: "2023-07"`) |
| Where it comes from | Transcribed in `Code.gs` `AB_NSE_TAXONOMY`, the list the sheet's menu "Audit Industry Classification vs NSE list" already uses |
| Master file | `data/classification/nse-industry-classification.json` (nested, stable ids) |
| Counts | 12 macro-economic sectors, 22 sectors, 59 industries, 197 basic industries |
| Online re-verification | **Pending.** nseindia.com / niftyindices.com could not be reached from the build environment (network policy) on 22 Oct 2026. NSE may have changed the structure since July 2023. |

`tests/industry.test.js` and `tools/build_industry_data.js` fail if the master and
`Code.gs AB_NSE_TAXONOMY` ever differ, so the sheet's audit and the website always use the
same list.

### Stable ids

`m-` macro sector, `s-` sector, `i-` industry, `b-` basic industry, followed by a slug of
the official name when it was first added (for example `b-computers-software-and-consulting`).
An id never changes when a name is corrected. Routes use the slug:
`#industries/macro/<slug>`, `#industries/sector/<slug>`, `#industries/industry/<slug>`,
`#industries/basic/<slug>`.

## Data model

`tools/build_industry_data.js` turns the master and the research notes into two site files:

* `web/data/industries.js` (`window.SB_INDUSTRIES`, ~50 KB). Loaded on the Industries pages only.
  * `meta`: title, version, source, verification, counts, research-note coverage.
  * `macros[]` with `id, code, name, order, description`.
  * `sectors[]` with `id, macroId, name, order, description`.
  * `industries[]` with `id, sectorId, macroId, name, order, description, businessOverview, keyDemandDrivers, keyRisks`.
  * `basics[]` with `id, industryId, sectorId, macroId, name, order, aliases, themes, metricSet, cyclicality, hasProfile`.
* `web/data/industry-profiles.js` (`window.SB_INDUSTRY_PROFILES`). Loaded only when a basic-industry page opens.
  It holds one research note per basic industry: explanation, products, value chain, revenue / cost model,
  customers, demand / supply drivers, exposure, capex, working capital, regulation, advantages, drivers, risks,
  cyclicality, metric set, related industries, aliases and thematic tags.

The notes live in `data/classification/profiles/*.json`. They are general analysis written for Stock Blueprint,
**not NSE text**, and contain no figures, company claims or recommendations (the build warns on numbers).
**Official NSE definitions are not included.** The detail page says "Data unavailable" for them until they are
added from the official document.

### Company mapping

Companies are the stocks in the Main tab (`SYMBOL`, `StockName`, `Sector`, `Industry`,
`Basic Industry`, `INDICES`, `MCAP(CR)`...). The site and the live sheet feed both provide them.
`SB.industry.classifyStock` compares the sheet's three columns with the official table (case and
punctuation ignored):

| Status | Meaning |
|---|---|
| Verified | Basic Industry is official and the sheet's Sector / Industry are its official parents |
| Conflicting | Basic Industry is official, but the Sector / Industry typed next to it are not its parents (the official parents are used) |
| Pending verification | A classification is typed in, but its Basic Industry is not an official name |
| Unclassified | Nothing typed in |

The classification source shown is "Main tab". That data came into the sheet from screener.in / NSE and was
checked by the sheet's own audit. Thematic tags (EV, Defence...) are separate from the official hierarchy and
never change a stock's classification.

* **Market-cap category** comes from Nifty index membership in the Main `INDICES` column:
  * Nifty 50 / Next 50 = Large cap.
  * Midcap 50 / Midcap Next 100 = Mid cap.
  * Smallcap 50 / 51-250 = Small cap.
  * Microcap 250 = Micro cap.
  * Nifty SME = SME.
  * Everything else = Other listed.

  This is **not** the AMFI list.
* **BSE codes** and **ISIN** are not in the data. They are shown as "Data unavailable".

## Industry analytics: methodology

* Members of a node are the stocks mapped to it through their official basic industry (verified + conflicting).
* A period return per stock:
  * **1D** is the price change shown, with its state (DELAYED / EOD / CACHED).
  * **1W / 1M** compare the last daily close with the close 5 / 21 sessions earlier.
  * **3M / 6M / 1Y** are unavailable, because the sheet's History30 keeps about 30 sessions.
* Node figures use **equal weights**:
  * median (headline) and mean of member returns;
  * advancers / decliners and breadth = advancers / (advancers + decliners);
  * leaders / laggards;
  * volume trend = 5-day vs prior 20-day average volume.
* Only nodes with **at least 3 stocks with data** are ranked strong / weak, so one big mover cannot rank an industry.
* Benchmark: NIFTY 50 day change from the Indextracker tab (1D only, cached snapshot).
* Industry strength, stock fundamentals, technicals and the strategy are separate dimensions. A stock is
  never recommended because its industry is strong.

## Strategy integration

Basic-industry pages read the active strategy's results from `SB.strategies.runActive()`. These are the same
versioned rules as Daily Suggestions; nothing is recalculated or changed. The page shows:
* status, score and the checks passed / failed;
* entry reference / stop / target when the strategy defines them;
* the reasons a stock does not qualify;
* the DEMO / unconfirmed label.

## Updating the classification

1. Get the official list (PDF / Excel from niftyindices.com > Resources > Industry Classification).
2. Save it as CSV with the columns `macro,sector,industry,basic` (header row, one row per basic industry).
3. Run the import:
   ```
   node tools/build_industry_data.js --import-csv new.csv --write-candidate
   ```
   It reports added / removed / renamed / moved entries and writes `data/classification/candidate-<date>.json`.
   Existing ids are kept for unchanged names. **The master is never overwritten by an import.**
4. Review the candidate. Then:
   * copy it over `data/classification/nse-industry-classification.json`;
   * update `version` and `verification`;
   * update `Code.gs AB_NSE_TAXONOMY` the same way (the build checks both agree);
   * write notes for any new basic industries in `data/classification/profiles/`.
5. Run `npm run industries`. It validates the hierarchy, duplicates, orphans, Code.gs parity and the profiles,
   prints an import report against the previous build, and refuses to drop ids unless `--allow-removals` is given.
6. Run `npm test`. Commit.

## Sheet / Apps Script

No new tabs and no `Code.gs` changes were needed. The live sheet feed (`doPost` action `site`) already sends
every stock's Sector / Industry / Basic Industry, and the classification master is static reference data
versioned in the repo. A Classification tab in the sheet is not needed unless you want to edit the master from
the sheet. If you do, keep it in step with `Code.gs AB_NSE_TAXONOMY` and this repo.

## Known limitations

* The classification is the July 2023 version. Online re-verification was not possible from the build environment.
* Official basic-industry definitions are not included.
* Industry KPIs (NIM, NPA, EBITDA per tonne, ARPU...) have definitions only. They need a company-fundamentals
  source. ROE, ROCE and debt-to-equity are not in Stock Blueprint data.
* Returns longer than one month are not available (about 30 daily candles).
* BSE codes / ISIN are not in the data, and the market-cap category is by index membership.
* There are no user accounts. The industry watchlist is saved in this browser only (localStorage).
