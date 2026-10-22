# Strategy rules (discovered from Code.gs and the workbook)

The website re-implements the sheet's own rules in `web/lib/*.js`. Each one
was ported line by line from `Code.gs` and checked against the downloaded
workbook (`tests/sheet-parity.test.js`: 0 mismatches over 1,746 symbols).

| Rule | Code.gs source | Website | Parity |
|---|---|---|---|
| 15 bullish candlestick patterns (Spring, Piercing, Bullish Engulfing, Bullish Harami, Tweezer Bottoms, Spring?, Three Day Low Rejection, Morningstar, Trio, FVG 1234, FVG 123, FVG 123 Type 2, FVGTouch, Bullish Harami + Inverted Hammer, Bullish Harami + Inverted Hammer (confirmed)) | `updateAllCandlestickPatterns`, `ab_isSpringPair_`, `ab_isHaramiInvHammerPair_` | `patterns.js` | PatternData col W: exact (the two Harami + Inverted Hammer tags: Code.gs = JS by `tests/patterns-hih.test.js`, until an export contains them) |
| 3-candle bullish FVG, first touch, confirmed, FVG+Spring, unmitigated zone | `ab_longFvgDetail_` (~5092) | `fvg.js longFvgDetail` | col X: exact |
| Gap-up FVG (3-5 %), circuit-lock and turnover filters | `ab_gapUpFvgs_`, `ab_isCircuitLocked_`, `ab_avgTurnover_` | `fvg.js` | col X: exact |
| 10 / 21 EMA support (touch & hold, last 4 bars) | `ab_computeEmaSupportTag_` | `indicators.js` | cols Y, AA: exact |
| ATR14 (EMA smoothing, SMA seed) | `ab_computeATR14EMA_` | `indicators.js atrEma` | col Z: exact |
| Zone approach / mitigation alert rule | `ab_checkZoneAlerts_`, `ab_checkZoneMitigatedAlerts_` | `fvg.js approachState` | rule port |
| TTM Signal (Buy if TargetPrice > price; Avoid if growth < 0 or EPS ≤ 0) | `ab_fixSignalFormulas_`, Main col AP | `strategy.js ttmSignal` | formula port |
| Quality Watch | `ab_qualityWatchSymbols_` | condition `qualityWatch` | rule port |
| Smart Dashboard presets: Quality Growth, Smart Money Buying, Deep Value, Volume Breakout, Beaten Down + Improving | `ab_smart*` (~16576) | strategy presets | rule port |
| Pattern Dashboard confluence (non-empty Pattern/FVG/10 EMA/21 EMA cells, 0-4) | `ab_buildPatternDashboard_` | condition `sheetConfluence` | exact vs PatternData |
| Position size = min(floor(capital × risk% / (entry − stop)), floor(capital / entry)) | `ab_riskCalc_` | `risk.js sizePosition` | formula port |
| Trade Win = close ≥ entry × 1.10, Loss = close ≤ stop (close only, stop first) | `resolveTradesEOD_` | backtest exit model `close` | rule port |

All are **bullish, daily, end-of-day** rules. There is no bearish rule and no
intraday rule in the sheet; the site shows a bearish FVG mirror only as
information and says intraday is not supported by the daily data.

## Presets

- **Pattern Dashboard confluence (from your sheet)** - the default for Daily
  Suggestions. Qualified = liquidity (₹50 lakh average turnover) and
  circuit-lock filters pass + confluence ≥ 3. Confluence 1-2 or an FVG zone
  being approached = Watch.
- **Smart Dashboard screens** - the five presets above, as fundamental
  screens (no entry timing, not backtestable because the historical
  fundamentals are not available).
- **DEMO - EMA trend pullback** - a generic test strategy, always labelled DEMO.

## Assumptions that need your confirmation

The sheet does not say how these signals become an "entry", so the site
labels the presets *unconfirmed* until you confirm them in Strategy Settings:

1. Qualified = confluence ≥ 3 (the Pattern Dashboard's dark-green highlight).
2. Stop-loss = entry − 2 × ATR14 (Main's "ATR" column is 2 × ATR14). In the
   sheet you type the Stoploss by hand.
3. Target = entry + 10 % (`AB_TRADE_WIN_PCT`, measured from entry like
   `resolveTradesEOD_`).
4. Entry reference = the latest daily close.

## Open questions found in the code

- `AB_GAPUP_MAX_PCT`: code default 10, the workbook's Control Panel says 5
  (5 is in force and is what the site uses).
- Main's TTM Signal has two formula variants: only about 70 rows have the
  fixed rule (Avoid when growth < 0 or EPS ≤ 0). The site always applies the
  fixed rule, so about 33 sheet "Buy" cells show as Avoid here.
- Trade Win: the code measures +10 % from the **entry**; the Control Panel
  help text says "from the alert price".
- 3-candle FVG touch uses `Low < top` (strict); gap-up and live mitigation
  use `<=`. Ported as coded.
- "FVG Unmitigated" looks only at the newest gap; an older untouched gap is
  not reported when the newest one was touched. Ported as coded.
- FVG+Spring (changed Oct 2026, owner's rule): a Spring pair with the Spring pattern's Control Panel thresholds, inside ANY 30-day FVG (touched or not) that still holds - no longer only the 2nd touch of the latest gap.
- EMA support has no lower bound (a low far below the EMA still counts).
- Zone minimum age and "days held" use calendar days, not trading days.
- About 25 basic industries have no row in the BasicIndustry PE tab, so
  their PE vs Industry PE is blank.
