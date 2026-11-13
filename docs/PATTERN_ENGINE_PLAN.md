# Bullish Pattern Recognition Engine - Phase 0 audit and integration plan

Status: Phase 0 (audit + plan) approved 13-Nov-2026 ("yes. do as per your recommendation"); **M1 built** (section 11).
The live state of every pattern is docs/PATTERN_SPECS.md (generated from the registry) - the matrix below is the audit.
Written 13-Nov-2026 for the owner's "Master project prompt" (194 bullish patterns, long only, ~20 years, ~1,800 stocks).
Every number marked *measured* was run in this repo's container; everything marked *estimate* still has to be measured on
the owner's laptop.

---------------------------------------------------------------------------------------------------------------------

## 1. Existing architecture (what is really there)

A correction to the master prompt first: **Google Sheets does NOT hold 20 years of OHLC.** The sheet keeps 30 days
(History30, GOOGLEFINANCE) and 60 days (History60, NSE bhavcopy via the PC). The 20-year history lives **only on the
owner's Windows laptop** as Zerodha Kite candles, and Kite candles may not be published on the public website.

```
                         Zerodha Kite Connect (owner's login, once a day)
                                         |
        +--------------------------------v-------------------------------------------+
        |  OWNER'S LAPTOP - pcbridge/ScreenerBridge (Python 3, standard library only)|
        |                                                                            |
        |  kite_intraday.py  -> intraday_data/<SYM>.json.gz                          |
        |     daily  : back 20 years (or to listing)          (DEEP_DAY_YEARS 20)    |
        |     4 hour : back ~2000 days, built from 60-minute   (DEEP_H4_DAYS 2000)   |
        |     15 min : last 125 sessions only (~6 months)      (M15_KEEP_SESSIONS)   |
        |     weekly / monthly built from daily; indices (NIFTY 50 ... ) daily 20 y  |
        |                                                                            |
        |  backtest pass -> lab_cache/b<time>/{D,W,4H}.bin  (float32 o h l c v,      |
        |                   int32 day, int16 minute)  + signals.json.gz + meta       |
        |  structure.py  : pivots, ZigZag, CHoCH, BOS, move high, Fib depth          |
        |  backtest_lab.py: run_job -> simulate -> portfolio -> summarise            |
        |  lab_charts.py : charts PDF (HH/HL/LH/LL, CHoCH, BOS, zones, entry/stop)   |
        |  LabWorker     : polls the sheet for a job, runs it, sends the result      |
        +-----------------------------------|----------------------------------------+
                                            | doPost action 'lab' (job / progress / result)
        +-----------------------------------v----------------------------------------+
        |  GOOGLE SHEET + Apps Script (Code.gs / Code2.gs)                           |
        |  AB_LAB_JOB (one job queue), hidden tab Backtest_Lab (result JSON, 8 kept) |
        |  Main / PatternData / History30 / History60 / Results ... (30-60 days)     |
        +-----------------------------------|----------------------------------------+
                                            | api/watchlists op 'lab' (PIN, owner only)
        +-----------------------------------v----------------------------------------+
        |  VERCEL: api/*.js relays only (no compute)   web/pages/lab.js = the Lab UI |
        +----------------------------------------------------------------------------+
```

Existing Backtest Lab workflow: the page form (about 99 rules) -> sheet job queue -> the laptop polls every 10 s while
the page is open -> `run_job` on the cached candles + precomputed signal rows -> result JSON (stats, account, split,
breakdowns, 3,000 newest trades) -> sheet -> page; the charts PDF stays in `ScreenerBridge\lab_charts`.

## 2. Reusable components

| Need in the master prompt | Already there | Where |
|---|---|---|
| Long candle history, D / W / 4H | yes (D 20 y, 4H ~5.5 y, W / M) | kite_intraday.py, lab_cache |
| Background jobs, progress, cancel, retries | yes | LabWorker, AB_LAB_JOB, beats, 20-min stale rule |
| Confirmed pivots (left / right), ATR prominence, ZigZag | yes, look-ahead tested | structure.py `pivots`, `zigzag`, `swing_points` |
| HH / HL / LH / LL, CHoCH (last / protected), BOS, equal highs | yes | structure.py, lab_charts.py `swing_tags` |
| FVG, Gap-up zone, inside-FVG gap, first touch, discount depth | yes | kite_intraday.py, backtest_lab.py |
| Entries: close, next open, limit at zone top | yes | backtest_lab `simulate` |
| Stops: zone, candle low, lower of both, %, final low, ATR (whichever lower) | yes | `simulate` |
| Targets: R, %, move high, last swing high; partial; breakeven; lock; trails (lows / % / EMA / ATR / swing low); time stop; max days | yes | `simulate` |
| Gap through stop = open; stop + target in one candle = stop | yes | `simulate` |
| Portfolio: risk %, max position, max open, compounding, skip reasons | yes | `portfolio` |
| Stats, R ranges, real-or-chance, breakdowns, dev / validation / test split, rolling years | yes | `summarise`, `breakdowns`, `_split`, `_rolling` |
| Annotated trade charts | yes (PDF on the laptop) | lab_charts.py |
| Market filter on an index (EMA, stack) | yes (closes only) | `market_filter`, cache meta 'indices' |
| Candle patterns (17 tags) | yes, but in Code.gs / web/lib only - not in the Python Lab | web/lib/patterns.js, Code.gs |
| SMA / EMA / ATR / RSI / MACD / relative volume | yes in JavaScript (web/lib/indicators.js); Python has EMA / ATR only | |
| TradingView cross-check | yes | tradingview/*.pine + pine_model.py |

## 3. Missing components

1. **Python indicator library**: Wilder smoothing, RSI, MACD, Stochastic, CCI, MFI, OBV, ADX / DMI, ROC, TSI, Aroon,
   Parabolic SAR, Bollinger, Keltner, Donchian, Supertrend, Ichimoku, z-score, percentiles, anchored VWAP (daily proxy).
2. **Pattern registry** (194 entries + the owner's existing patterns) with id, family, parameters, data needs, version.
3. **Generic pattern events + lifecycle** (occurrence / confirmation / actionable candle, references, state). Today the
   Lab's signal rows are zone-shaped (codes S F G T C Z Y V P Q).
4. **Generic causality harness** (truncate-and-compare + change-the-future) applied to every detector. Today it exists
   for structure.py and the Pine model only.
5. **Entry models**: breakout stop-entry, retest entry, confirmation-candle entry, limit at any level (only the zone top
   now). **Stops / targets**: swing-low stop, MA stop, ATR target, measured-move target.
6. **Metrics**: MAE, time to MFE / MAE, Sharpe / Sortino / Calmar, monthly / quarterly returns, drawdown duration,
   consecutive wins (MFE in R = `maxR` exists).
7. **Market regime classifier** (needs index OHLC in the cache - only closes today).
8. **Sector / market-cap breakdowns** (sector + cap come from the sheet's Main, CURRENT values only).
9. **Detailed Indian cost schedule** (today one round-trip % `cost`).
10. **Combination rule engine** (AND / OR / sequence within N candles) - needs a rule string through the sheet / api
    (their filter takes flat words of 20 characters) -> a Code2.gs + api change and a New version deploy, later.
11. **Walk-forward + parameter stability** (a 2- / 3-part split exists, no optimiser).
12. **Data-quality checker** (OHLC sanity, duplicates, gaps vs NSE holidays, zero volume, spikes).
13. **UI**: pattern library, combination builder, leaderboard, trade explorer (today: trades table + PDF + TradingView).

## 4. Data facts and limits (they decide what can be tested)

| Item | Reality | Consequence |
|---|---|---|
| 5-minute data | **none** | B15 Opening Range Breakout, intraday VWAP: data limited |
| 15-minute | last ~125 sessions | intraday timeframes can be tested on ~6 months only |
| 4 hour | ~5.5 years | MTF with 4H only from ~2021 |
| Universe | today's ~1,800 PatternData stocks; Kite lists only current instruments | **survivorship bias** - delisted / suspended stocks are missing; must be shown on every result |
| Index membership, market cap | current only | cap / index breakdowns use today's category (look-ahead) - labelled |
| Splits / bonus | Kite candles are adjusted (the store re-reads a stock when old candles change) | prices consistent; dividends not adjusted; volume adjustment to verify |
| Delivery % | only recent days (NSE files) | not usable over 20 years |
| Benchmark | NIFTY 50 and 11 other indices, daily, 20 y on the laptop | regime + relative strength possible (cache must carry OHLC) |
| Market breadth | only from our own universe | survivorship-biased; optional, labelled |

## 5. Proposed integration architecture

Principle: **keep everything on the laptop; detection separate from execution; reuse `simulate` / `portfolio` /
`summarise` unchanged.** No database migration, no new hosted service, no Python packages to install (the laptop runs
the standard library only - numpy would need an install, so the plan avoids it; *measured* speed below is enough).

```
lab_cache (candles, existing)
   -> indicators.py        shared math (candle anatomy, TR / Wilder ATR, MAs, oscillators, channels)
   -> structure.py         pivots / swings / CHoCH / BOS (existing)
   -> pattern_detect.py    one function per FAMILY -> events [act_i, conf_i, occ_i, id, trigger, stop_ref, aux, score]
   -> pattern_events/      memo per (cache build, timeframe, pattern, params hash, detector version)
   -> pattern_rules.py     (phase 5) AND / OR / within-N sequences on events
   -> backtest_lab.simulate / portfolio / summarise  (existing, + new entry / stop / target models)
   -> result JSON -> sheet -> website (existing path)
```

Proposed files (laptop folder stays flat, as the zip is):

| File | What |
|---|---|
| `pcbridge/ScreenerBridge/indicators.py` | new - shared math |
| `pcbridge/ScreenerBridge/pattern_registry.py` | new - the 194 specs + owner's extras (data, not code) |
| `pcbridge/ScreenerBridge/pattern_detect.py` | new - family detectors, lifecycle, events |
| `pcbridge/ScreenerBridge/pattern_rules.py` | phase 5 - combinations |
| `pcbridge/ScreenerBridge/regime.py`, `costs.py`, `data_quality.py` | phases 4 / 6 |
| `backtest_lab.py` | new group 'pattern' feeding the existing simulate; new entry / stop / target models |
| `web/pages/lab.js` (+ maybe `web/pages/lab-patterns.js`) | pattern library + picker, later combination builder / leaderboard |
| `tests/fixtures/pcbridge_patterns_check.py`, `tests/pcbridge-patterns.test.js` | unit, boundary, causality, reproducibility, speed |
| `docs/PATTERN_SPECS.md` | generated from the registry (the written spec of every pattern) |

Logical data model (master prompt section 17) mapped to what exists - no new database:

| Entity | Stored as |
|---|---|
| Instruments | Main / PatternData (sheet) + kite_instruments.json (laptop) |
| OHLCV | lab_cache `<tf>.bin` (existing) |
| Indicator cache | computed on the fly per stock (cheap); heavy ones memoised per run |
| Swing structure | structure.py objects, memoised per (cache build, tf, options) - existing `_struct_map` |
| Pattern definitions | `pattern_registry.py` (+ version per entry) |
| Pattern events | `lab_cache/b<time>/events/<tf>/<id>_<hash>.bin` (int32 candle indexes + float32 refs) |
| Strategy definitions | the Lab's params (page localStorage presets) + a rule string later |
| Backtest runs / trades / summary | the result JSON (sheet tab Backtest_Lab) - existing |
| Pattern performance (leaderboard) | one batch result JSON (sheet, summary only) |

Pattern lifecycle: a detector tracks Potential / Forming internally and emits an event only when CONFIRMED, with
`occ_i` (first candle of the pattern), `conf_i` (the candle whose close confirmed it), `act_i` (first candle an entry
may use = conf_i, or later for pivot-based patterns), `trigger`, `stop_ref`, `expires` (entry window). Entry Eligible /
Triggered / Expired / Invalidated / Completed are decided by the entry model in `simulate`. One event per occurrence
(no double counting while a pattern persists).

Non-repainting rules (every detector): only candles <= the candle being judged; pivots only after their right-side
candles closed; higher timeframes only finished candles (existing `candle_complete`). Generic test for each detector:
(a) run on the full chart and on the chart cut at many points - events with `act_i` <= the cut must be identical;
(b) replace every candle after the cut with random candles - the same events must come out.

## 6. The 194 patterns - today's state, family, data

Legend: **Lab** = usable in the Backtest Lab today - **Partial** = exists as a Lab filter or only in the sheet / website
(Code.gs, web/lib), not yet a standalone Lab signal - **New** = not built - **Data** = limited by the data (section 4).
Families group patterns that share one detector with different parameters (about 60 detectors for 194 entries).

**A. Classical chart patterns** (family CH = pivots + geometry; the hardest - last)

| ID | Pattern | Now | Family / note |
|---|---|---|---|
| C01 | Double Bottom | New | CH-bottoms |
| C02 | Triple Bottom | New | CH-bottoms |
| C03 | Inverse Head and Shoulders | New | CH-hs |
| C04 | Rounding Bottom | New | CH-round (curve fit) |
| C05 | Saucer Bottom | New | CH-round (shallower / longer C04 - parameters) |
| C06 | Falling Wedge Breakout | New | CH-lines (two converging falling lines) |
| C07 | Bullish Broadening Formation | New | CH-lines |
| C08 | Bull Flag | New | CH-flag (pole + channel) |
| C09 | Bull Pennant | New | CH-flag (pole + triangle) |
| C10 | Cup and Handle | New | CH-round + handle |
| C11 | Ascending Triangle | New | CH-lines |
| C12 | Symmetrical Triangle (up break) | New | CH-lines |
| C13 | Bullish Rectangle Breakout | New | BASE |
| C14 | Ascending Channel | New | CH-lines (entry = lower-line bounce, defined explicitly) |
| C15 | Bullish Staircase | New | ST (steps of HH / HL) |
| C16 | Bullish Measured Move | New | CH-legs (leg 2 ~ leg 1; no harmonic ratios) |
| C17 | High Tight Flag | New | CH-flag (pole >= 90 % in <= 8 weeks - parameters) |
| C18 | Flat Base Breakout | New | BASE |
| C19 | IPO Base Breakout | Partial | Code.gs `ab_ipoBaseSequence_` (sheet); port to Python |
| C20 | VCP | New | VCP (contractions + volume dry-up) |

**B. Candlesticks** (family KC = candle anatomy, cheap; gap-type candles = candle definition only, no gap strategy)

| ID | Pattern | Now | Note |
|---|---|---|---|
| K01 | Hammer | New | |
| K02 | Inverted Hammer | Partial | only inside "Bullish Harami + Inverted Hammer" |
| K03 | Dragonfly Doji | New | |
| K04 | Bullish Marubozu | New | K04 / K07 share one detector (shadow limits) |
| K05 | Bullish Belt Hold | New | |
| K06 | Long Lower Shadow | New | |
| K07 | Bullish Closing Marubozu | New | |
| K08 | Bullish Engulfing | **Implemented (M1)** | = the sheet's col W rule (parity test with web/lib/patterns.js) |
| K09 | Piercing Line | Partial | sheet / web |
| K10 | Bullish Harami | Partial | sheet / web |
| K11 | Bullish Harami Cross | New | |
| K12 | Tweezer Bottom | Partial | sheet / web |
| K13 | Matching Low | New | |
| K14 | Bullish Counterattack | New | |
| K15 | Bullish Kicking | New | gap in the candle definition only |
| K16 | Separating Lines | New | |
| K17 | Morning Star | Partial | sheet / web ("Morningstar") |
| K18 | Morning Doji Star | New | |
| K19 | Three White Soldiers | New | |
| K20 | Three Inside Up | New | |
| K21 | Three Outside Up | New | |
| K22 | Three Stars in the South | New | |
| K23 | Abandoned Baby | New | gap in the candle definition only |
| K24 | Stick Sandwich | New | |
| K25 | Concealing Baby Swallow | New | |
| K26 | Rising Three Methods | New | |
| K27 | Mat Hold | New | gap in the candle definition only |

**C. Price action / structure** (family ST = structure.py pivots)

| ID | Pattern | Now | Note |
|---|---|---|---|
| P01 | HH-HL structure | New | ST |
| P02 | Lower Low Failure | New | ST (LL fails, close back above) |
| P03 | Lower High Breakout | Partial | = the CHoCH break with 1 lower high |
| P04 | First Higher High after downtrend | New | ST |
| P05 | First Higher Low after downtrend | New | ST |
| P06 | Bullish CHoCH | **Lab** | structure.py; Lab structure 'only'; Pine |
| P07 | Bullish MSS | Partial | CHoCH + `dispAtr` filter exists; needs its own event |
| P08 | Bullish BOS | Partial | computed (`bos_before`), used as a filter only |
| P09 | Swing Failure Pattern | Partial | the owner's Spring is a 1-candle SFP; swing-low version new |
| P10 | Failed Breakdown | Partial | Spring |
| P11 | Failed Bearish Breakout | New | SW (range support) |
| P12 | Support Rejection | New | SR (level touches) |
| P13 | Resistance Flip into Support | New | SR |
| P14 | Breakout and Retest | New | RT |
| P15 | Successful Breakout Retest | New | RT (+ bounce confirmation) |
| P16 | Pullback to Previous Swing High | New | RT |
| P17 | Trendline Break and Retest | New | TL (line through confirmed pivots) |
| P18 | Descending Trendline Breakout | New | TL |
| P19 | Compression Before Breakout | New | NR |
| P20 | Inside Bar Breakout | New | NR |
| P21 | Outside Bar Reversal | New | KC |
| P22 | Consecutive Higher Closes | New | KC |
| P23 | Range Expansion after Consolidation | New | NR |
| P24 | Failed LL / structure divergence | New | ST |

**D. SMC / ICT** (price-action proxies only - OHLCV cannot show institutional orders)

| ID | Pattern | Now | Note |
|---|---|---|---|
| S01 | Sell-Side Liquidity Sweep | Partial | structure option `sweep` (filter) |
| S02 | Equal Lows Sweep | New | SW (+ `eqAtr` tolerance exists) |
| S03 | Previous Day Low Sweep | Partial | on daily candles the Spring is exactly this |
| S04 | Previous Week Low Sweep | New | SW (finished weekly candle) |
| S05 | Previous Month Low Sweep | New | SW |
| S06 | Swing Low Liquidity Grab | Partial | Spring + `lowestN` |
| S07 | Inducement + Sweep | New | SW (minor low first, then the major) |
| S08 | Bullish Order Block | New | OB (the owner chose "no order blocks" on 10-Nov - research only) |
| S09 | Bullish Breaker Block | New | OB |
| S10 | Bullish Mitigation Block | New | OB |
| S11 | Bullish Rejection Block | New | OB |
| S12 | Bullish FVG | **Lab** | zone touch / FVG+Spring groups |
| S13 | Consequent Encroachment (50 % FVG) | Partial | zone middle used for depth; limit entry at 50 % new |
| S14 | Inverse FVG | New | FV (a bearish FVG closed through upwards) |
| S15 | Bullish Displacement | Partial | `dispAtr` / `dispVol` on the CHoCH candle |
| S16 | Displacement + FVG | Partial | |
| S17 | Liquidity Sweep + CHoCH | Partial | `sweep` + structure 'only' |
| S18 | Liquidity Sweep + BOS | New | |
| S19 | Order Block + FVG | New | OB + FV |
| S20 | Breaker Block + Sweep | New | |
| S21 | Premium-to-Discount Reversal | Partial | discount rule |
| S22 | Discount Zone Entry | **Lab** | the owner's CHoCH + FVG setup |
| S23 | Balanced Price Range | New | FV (overlapping up + down FVG) |
| S24 | Reclaimed Order Block | New | OB |
| S25 | Bullish Repricing / Imbalance | New | FV (definition to agree) |

**E. Volume** (family VO; relative volume = volume / SMA20 of earlier candles)

V01 Volume Climax + Reversal, V02 Selling Climax, V03 High-Volume Reversal, V04 Volume Dry-up Before Breakout, V05 Volume
Expansion Breakout, V06 Relative Volume Surge Breakout, V07 Price Rise + Rising Volume, V08 Low-Volume Pullback, V09
Accumulation with Rising Lows, V10 Absorption at Support (proxy), V11 Bullish Volume Divergence, V12 No Supply Bar, V13
Stopping Volume, V14 Effort vs Result, V15 Volume-confirmed Resistance Breakout, V16 Upthrust Failure - **all New**
(`moveVol` / `dispVol` exist only inside the CHoCH rules). V10 is a proxy (no order-book data); no delivery volume.

**F. Breakout / consolidation**

B01 20-day high, B02 50-day high, B03 52-week high, B04 All-time high, B13 Donchian (family HI: one detector, N =
parameter) - B05 Multi-month resistance, B06 Multi-touch resistance, B14 Darvas box, B16 Breakout + retest, B18
Multi-week base, B19 Resistance absorption (family BASE) - B07 Narrow range, B08 NR4, B09 NR7, B10 Inside-bar cluster,
B17 Contraction -> expansion (family NR) - B11 Bollinger squeeze, B12 Keltner squeeze, B20 MA compression (family SQ) -
**B01-B04 Implemented (M1)**, the rest New. **B15 Opening Range Breakout = Data** (15-minute candles only for ~6 months; no 5-minute).

**G. Moving averages / trend**

| ID | Pattern | Now | Note |
|---|---|---|---|
| M01 / M02 | 20 / 50 EMA pullback + bounce | Partial | `emaSupport` 10 / 21 / 50 on Spring candles only |
| M03 / M04 | 100 / 200 EMA pullback + bounce | New | MA-pull |
| M05 | Golden Cross 50 / 200 DMA | New | MA-cross |
| M06 | 20 / 50 EMA cross | New | MA-cross |
| M07 | 50 / 200 alignment | New | MA-cross |
| M08 | MA ribbon expansion | New | MA-ribbon |
| M09 / M10 | MA reclaim / 200 DMA reclaim | New | MA-reclaim |
| M11 | Multi-timeframe MA alignment | New | W + D (4H from ~2021) |
| M12 | Supertrend reversal | New | |
| M13-M15 | Ichimoku Kumo breakout / TK cross / Kumo twist | New | ICH |
| M16 | VWAP reclaim | **Data** | true VWAP needs intraday; daily proxy only, labelled |
| M17 | Anchored VWAP reclaim | New | daily typical-price proxy, anchor = a confirmed pivot |
| M18 | EMA compression + expansion | New | SQ |

**H. Momentum / indicators** - I01-I05 RSI (divergence, hidden divergence, failure swing, 50 reclaim, oversold
reversal), I06-I08 MACD, I09-I10 Stochastic, I11 CCI, I12 MFI divergence, I13-I14 OBV, I15 ADX expansion, I16 ROC, I17
TSI, I18 Aroon, I19 Parabolic SAR, I20-I22 Bollinger (lower-band reversal, middle reclaim, band walk), I23-I24 Relative
strength vs benchmark (needs the index cache) - **I01 Implemented (M1)**, the rest New; divergences use confirmed pivots (signal only after the 2nd
pivot is confirmed).

**I. Quantitative** - Q01-Q20 **all New** (z-score / %B / RSI-price statistics, ATR regime, down-day exhaustion, large
down candle reversal, Q09 defined on daily OHLC without gaps, momentum / ROC, Q12 multi-timeframe momentum, Q13
relative-strength leadership, Q14 Donchian trend start, Q15 statistical pullback, Q16 price-volume anomaly, Q17 range
expansion, Q18 trend persistence, Q19 failed momentum breakdown, Q20 multi-factor confluence = a combination, phase 5).

**Count:** A 20 + B 27 + C 24 + D 25 + E 16 + F 20 + G 18 + H 24 + I 20 = **194**. At the audit: Lab 3, Partial 22, Data 2,
New 167. After M1: Implemented 6, Lab 3, Partial 21, Data 2, Planned 162 (docs/PATTERN_SPECS.md has the live count). The owner's own patterns (Spring, FVG+Spring, Gap-up
FVG + Spring, inside-FVG gap, Twin Star Bottom, Harami + Inverted Hammer, Three Day Low Rejection, Trio, FVG 123 types,
FVG First Touch) stay as they are and join the registry as extras (X..).

Overlaps to agree (the registry keeps all 194 IDs, but several share one detector): C04 / C05, K04 / K07, P14 / P15,
B01-B04 / B13, M01-M04, P03 / P06 (P03 = any lower-high break, P06 = after N lower highs / lows), S03 = Spring on daily.

## 7. Computation estimates

*Measured* here (pure Python, 1 million candles): six simple candle detectors in one pass 0.97 s (~0.16 s each); RSI +
20-high breakout 0.98 s.

*Estimates* (to measure on the laptop): daily universe ~4-7 million candles (1,800 stocks, many listed after 2006), 4H
~4-5 million, weekly ~1 million. One simple detector over all daily candles ~1-2 s; indicator-based ~3-6 s; pivot /
geometry chart patterns maybe 10-60 s. A single-pattern Lab run stays seconds (detection + the existing simulate). A
full leaderboard (all patterns x D / W / 4H) ~20-60 minutes as a background batch with progress, after which the events
are memoised (incremental afterwards: only new candles). Event files: int32 candle indexes, well under 200 MB for all
patterns. No numpy needed; if the laptop turns out slower, numpy can be offered later as an optional install.

## 8. Phases (each one: tests run, real numbers reported, delivered before the next)

| Phase | Scope | Touches |
|---|---|---|
| 0 | this audit | docs only |
| **1 (milestone M1)** | foundation + a vertical slice (below) | laptop zip + website |
| 2 | candlesticks K01-K27, breakouts B (not B15), MA M01-M12, basic volume V | laptop + website |
| 3 | price action P, SMC S, momentum I, quant Q, then classical C (hardest last) | laptop + website |
| 4 | entry models B-E, swing / MA stops, ATR / measured-move targets, cost schedule, MAE + ratios | laptop + website |
| 5 | combination engine (AND / OR / within N candles / timeframes / score) | laptop + **Code2.gs + api (deploy)** + website |
| 6 | regime classifier, sector / cap breakdowns, walk-forward + parameter stability, leaderboard batch | laptop + website |
| 7 | UI: library, combination builder, leaderboard, trade explorer, exports | website |
| 8 | tuning, incremental events, monitoring | laptop |

## 9. Smallest safe milestone - M1 (proposed, waiting for approval)

1. `indicators.py`: candle anatomy (range, body, shadows, ratios, CLV, zero-range safe), TR, Wilder ATR, SMA, EMA,
   Wilder RSI, rolling high / low - each tested against hand-worked examples and an independent second implementation.
2. `pattern_registry.py`: all 194 entries (+ extras) with category, family, data needs, timeframes, default parameters,
   version and status (only M1's patterns marked implemented) -> `docs/PATTERN_SPECS.md` generated from it.
3. `pattern_detect.py`: the event model + lifecycle and three families end-to-end:
   - K08 Bullish Engulfing (a candle pattern),
   - B01-B04 N-period high breakout (20 / 50 / 252 / all-time; close above the prior N-candle high),
   - I01 RSI Bullish Divergence (two confirmed pivot lows: price LL, RSI HL; signal only after the 2nd pivot confirms).
   = 6 registry IDs implemented.
4. Backtest Lab: new Pattern "Pattern library (new)" + a pattern picker; entries close / next open; stops: the
   pattern's own low / ATR / %; everything else (targets, trails, account, split, breakdowns, PDF) reused. Existing
   groups and results unchanged (all current tests stay green + a before / after check of a fixed CHoCH + FVG run).
5. Tests: unit + boundary (zero range, equal values, missing candles), causality (cut + change-the-future) for each
   detector, reproducibility, timing on 1,800 random stocks.
6. Website: a read-only Pattern Library list (194, category filter, search, status) inside #lab.

No Code.gs / Code2.gs change and no New version deploy for M1 (the sheet / api already pass flat rules).

## 10. Decisions needed from the owner

1. Approve M1 as above?
2. Order after M1 (recommended: candlesticks + breakouts + MAs first - cheap and many; then structure / SMC; then
   volume / momentum / quant; classical chart patterns last).
3. Accept survivorship bias (delisted stocks are not in Kite) with a warning on every result?
4. Default costs = a Zerodha equity-delivery schedule (brokerage 0, STT, exchange, SEBI, stamp, GST, DP) instead of the
   flat 0.2 %? Historical rate changes only where verified.

## 11. M1 - built 13-Nov-2026

Owner's answers: M1 yes; order after it = candlesticks + breakouts + moving averages, then structure / SMC, then volume /
momentum / quant, classical chart patterns last; survivorship bias accepted with a note on EVERY Lab result
(`backtest_lab.SURVIVORSHIP`, result `warnings`); the Zerodha delivery cost schedule = phase 4.

| Piece | File |
|---|---|
| Shared maths (anatomy, TR, Wilder, ATR, SMA, EMA, RSI, prior N-high, relative volume) | pcbridge/ScreenerBridge/indicators.py |
| Registry: 194 + 10 own, status, family, data needs, written rules of the implemented ones | pcbridge/ScreenerBridge/pattern_registry.py |
| Detectors + event model + lifecycle: K08, B01-B04, I01 | pcbridge/ScreenerBridge/pattern_detect.py |
| Lab: Pattern "Pattern library" (`group` 'pattern', `pattern`, own parameters), `_PatRows`, survivorship note | backtest_lab.py |
| Charts PDF: the pattern's name, plain words (`PAT_WORDS`), the breakout level | lab_charts.py |
| Page: pattern picker + its fields + "The exact rules", the Pattern library list (chips, search, status, Use, CSV) | web/pages/lab.js |
| Generated copies | web/data/pattern-registry.js, docs/PATTERN_SPECS.md (`npm run patterns`) |
| Tests | tests/fixtures/pcbridge_patterns_check.py, tests/pcbridge-patterns.test.js, ui.e2e |

Tests run (all pass): indicator worked examples (RSI 70.464 by hand on the StockCharts sample closes; ATR, EMA, Wilder by
hand) + an independent second calculation on random data; the registry's 194 IDs per category; detector units and
boundaries (equal bodies, the level excludes the signal candle, fresh breakouts only, minimum history, divergence not before
the 2nd low is confirmed); CAUSALITY for every implemented pattern x D / W / 4H x 4 random charts x ~29 cut points (cut =
same events; random candles after the cut = same events); reproducibility; K08 = the sheet's rule on 40 random charts +
boundary candles; the Lab group end-to-end (entry = the signal close, stop under the pattern's low, next open, ATR stop,
weekly with daily turnover, turnover filter, charts PDF, the same run twice = the same result); the existing Lab fixture
unchanged.

*Measured* detection speed (this container, pure Python, 600 random stocks x 3,000 daily candles = 1.8 M candles): K08
0.15 s / M candles, B01 0.42, B02 0.39, B03 0.34, B04 0.15, I01 0.54. The laptop's ~4-7 M daily candles -> about 1-4 s
per pattern for a whole run (the events are remembered while the program runs; a second run with other exit rules does not
detect again).

Phase 2 - built 13-Nov-2026 ("Yes do it"): candlesticks K01-K27, breakouts B05-B20 (not B15 - data), moving averages
M01-M12, basic volume V01-V08 / V12 / V13 / V15 = 64 more, **70 implemented**. Shared definitions in the registry (`COMMON`:
the ATR yardstick, long / small / doji, fresh, relative volume, trend context, invalidation); every pattern has its own
written rules + a plain sentence (docs/PATTERN_SPECS.md). Tests run (all pass): a made chart per pattern (on / not on a
changed copy), independent counts for the cross / state / reclaim / multi-timeframe patterns, Supertrend by hand,
CAUSALITY for all 70 x D / W / 4H (random charts + each made chart), K09 / K10 / K12 / K17 = the sheet's column W rules.
*Measured*: all 70 together ~47 s per million candles (B10 inside-bar clusters ~3 s, most under 1.4 s) - a single
pattern on the laptop's whole daily history stays within seconds; the full leaderboard (phase 6) ~5 minutes for daily.

Phase 3 - built 13-Nov-2026 ("Do it"): price action / structure P01-P24, SMC / ICT S01-S25, the rest of the volume
patterns V09 / V10 / V11 / V14 / V16, momentum I02-I24, quant Q01-Q20, and the moving-average ones left from phase 2
(Ichimoku M13-M15, anchored VWAP M17, EMA compression M18) = 102 more, **172 implemented** (left: the classical chart
patterns C01-C20, B15 15-minute opening range and M16 true VWAP - data limited). New in indicators.py: MACD, slow
Stochastic, CCI, MFI, OBV, Chaikin A/D, Wilder +DI / -DI / ADX, ROC, TSI, Aroon, Parabolic SAR (flips like TradingView's
ta.sar), rolling percentile, regression slope, Ichimoku, rolling max / min. Detectors in pcbridge/ScreenerBridge/pattern_p3.py
(swings = structure.pivots, known patSwing candles later; the CHoCH = the Lab's own structure.choch_events). New shared
definitions (`COMMON`): swings, SMC zones and their first touch, the indicators, divergences, the NIFTY 50 benchmark. Lab:
`patSwing` (2-10, default 5) for the structure / SMC patterns; I23 / I24 / Q13 read NIFTY 50's daily closes from the cache
(4-hour candles use the session before; no NIFTY 50 on the laptop = a clear "needs the NIFTY 50 candles" message). The Lab
takes one trade a candle (two zones touched by the same candle = one trade). Tests run (all pass): every new indicator a
second way (brute force, Wilder's sum smoothing for ADX, Parabolic SAR's flip values, percentile / slope / Ichimoku by
hand); 17 cross patterns + I19 recounted from those series; made charts for 58 of the 102 (all the rare ones: on / not on a
changed copy); every event of every phase-3 pattern on random charts checked (candles in order, finite, the stop under the
signal close); CAUSALITY for all 172 x D / W / 4H; the Lab group for every pattern (= the detector, first event a candle).
*Measured*: the 102 together ~92 s per million candles (Q20 4.4 s, I11 3.0 s, the Ichimoku ones ~2.8 s, most under 1 s);
all 172 ~142 s.

Next (the agreed order): classical chart patterns C01-C20 last; then phase 4 (the Zerodha delivery cost schedule).

## 12. Known limits (will stay)

Survivorship bias; current sector / cap only; no 5-minute data; 15-minute ~6 months; 4H ~5.5 years; no historical
delivery %; OHLCV cannot reveal order flow (SMC = proxies); the charts PDF shows candles after the exit (outcome review,
not a point-in-time view - a point-in-time mode can be added); Kite candles cannot appear on the public website.
