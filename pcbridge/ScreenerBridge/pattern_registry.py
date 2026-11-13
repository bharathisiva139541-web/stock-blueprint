# -*- coding: utf-8 -*-
"""The pattern registry (owner, 13-Nov-2026 - the bullish pattern engine, docs/PATTERN_ENGINE_PLAN.md): every one of the 194
bullish patterns of the master prompt + the owner's own patterns, with its state. It is DATA: the detectors live in
pattern_detect.py, and a test checks that every 'implemented' entry has a detector and every detector an entry.

STATUS
  implemented - built in the new engine (pattern_detect.py): explicit rules, unit + boundary + causality tests, usable in the
                Backtest Lab as Pattern "Pattern library"
  lab         - usable in the Backtest Lab today through its own group (the owner's CHoCH + FVG / Spring setups)
  partial     - exists as a Lab filter or only in the sheet / website (Code.gs, web/lib), not yet a standalone signal
  planned     - not built yet (no rules written - a name is not a pattern)
  data        - the data cannot test it properly (e.g. no 5-minute candles)

python3 pattern_registry.py json      -> the registry as JSON (tools/build_patterns.js makes the website list + docs from it)
"""
import json
import sys

VERSION = 3
CATEGORIES = {
    'C': 'Classical chart patterns', 'K': 'Candlestick patterns', 'P': 'Price action and market structure',
    'S': 'Smart money concepts / ICT (price-action proxies)', 'V': 'Volume patterns', 'B': 'Breakout and consolidation',
    'M': 'Moving average and trend', 'I': 'Momentum and indicators', 'Q': 'Quantitative and statistical',
    'X': "The owner's own patterns (existing)",
}
STATUS_NAMES = {'implemented': 'Implemented', 'lab': 'In the Lab (own group)', 'partial': 'Partial', 'planned': 'Planned',
                'data': 'Data limited', 'sheet': 'Sheet / website only'}
D3 = ('D', 'W', '4H')

# (id, name, family, status, needs, note) - needs: o = OHLC, v = volume, b = benchmark index, i = intraday
_ROWS = [
    # A. classical chart patterns
    ('C01', 'Double Bottom', 'CH-bottoms', 'planned', 'o', ''),
    ('C02', 'Triple Bottom', 'CH-bottoms', 'planned', 'o', ''),
    ('C03', 'Inverse Head and Shoulders', 'CH-hs', 'planned', 'o', ''),
    ('C04', 'Rounding Bottom', 'CH-round', 'planned', 'o', ''),
    ('C05', 'Saucer Bottom', 'CH-round', 'planned', 'o', 'a shallower, longer C04 - the same detector with other limits'),
    ('C06', 'Falling Wedge Breakout', 'CH-lines', 'planned', 'o', ''),
    ('C07', 'Bullish Broadening Formation', 'CH-lines', 'planned', 'o', ''),
    ('C08', 'Bull Flag', 'CH-flag', 'planned', 'ov', ''),
    ('C09', 'Bull Pennant', 'CH-flag', 'planned', 'ov', ''),
    ('C10', 'Cup and Handle', 'CH-round', 'planned', 'ov', ''),
    ('C11', 'Ascending Triangle', 'CH-lines', 'planned', 'o', ''),
    ('C12', 'Symmetrical Triangle - bullish breakout', 'CH-lines', 'planned', 'o', ''),
    ('C13', 'Bullish Rectangle Breakout', 'BASE', 'planned', 'o', ''),
    ('C14', 'Ascending Channel', 'CH-lines', 'planned', 'o', 'entry rule (lower-line bounce or breakout) to be defined'),
    ('C15', 'Bullish Staircase Pattern', 'ST', 'planned', 'o', ''),
    ('C16', 'Bullish Measured Move', 'CH-legs', 'planned', 'o', 'leg 2 about leg 1 - no harmonic ratios'),
    ('C17', 'High Tight Flag', 'CH-flag', 'planned', 'ov', ''),
    ('C18', 'Flat Base Breakout', 'BASE', 'planned', 'ov', ''),
    ('C19', 'IPO Base Breakout', 'IPO', 'partial', 'o', "the sheet's IPO base sequence (Code.gs ab_ipoBaseSequence_)"),
    ('C20', 'Volatility Contraction Pattern (VCP)', 'VCP', 'planned', 'ov', ''),
    # B. candlesticks
    ('K01', 'Hammer', 'KC1', 'planned', 'o', ''),
    ('K02', 'Inverted Hammer', 'KC1', 'partial', 'o', 'only inside "Bullish Harami + Inverted Hammer"'),
    ('K03', 'Dragonfly Doji', 'KC1', 'planned', 'o', ''),
    ('K04', 'Bullish Marubozu', 'KC1', 'planned', 'o', 'K04 / K07 share one detector (shadow limits)'),
    ('K05', 'Bullish Belt Hold', 'KC1', 'planned', 'o', ''),
    ('K06', 'Long Lower Shadow', 'KC1', 'planned', 'o', ''),
    ('K07', 'Bullish Closing Marubozu', 'KC1', 'planned', 'o', ''),
    ('K08', 'Bullish Engulfing', 'KC2', 'implemented', 'o', "the same rule as the sheet's column W tag"),
    ('K09', 'Piercing Line', 'KC2', 'partial', 'o', 'sheet column W / website'),
    ('K10', 'Bullish Harami', 'KC2', 'partial', 'o', 'sheet column W / website'),
    ('K11', 'Bullish Harami Cross', 'KC2', 'planned', 'o', ''),
    ('K12', 'Tweezer Bottom', 'KC2', 'partial', 'o', 'sheet column W / website'),
    ('K13', 'Matching Low', 'KC2', 'planned', 'o', ''),
    ('K14', 'Bullish Counterattack', 'KC2', 'planned', 'o', ''),
    ('K15', 'Bullish Kicking', 'KC2', 'planned', 'o', 'a gap in the candle definition only - no gap strategy'),
    ('K16', 'Separating Lines - bullish', 'KC2', 'planned', 'o', ''),
    ('K17', 'Morning Star', 'KC3', 'partial', 'o', 'sheet column W ("Morningstar") / website'),
    ('K18', 'Morning Doji Star', 'KC3', 'planned', 'o', ''),
    ('K19', 'Three White Soldiers', 'KC3', 'planned', 'o', ''),
    ('K20', 'Three Inside Up', 'KC3', 'planned', 'o', ''),
    ('K21', 'Three Outside Up', 'KC3', 'planned', 'o', ''),
    ('K22', 'Three Stars in the South', 'KC3', 'planned', 'o', ''),
    ('K23', 'Abandoned Baby - bullish', 'KC3', 'planned', 'o', 'a gap in the candle definition only - no gap strategy'),
    ('K24', 'Stick Sandwich', 'KC3', 'planned', 'o', ''),
    ('K25', 'Concealing Baby Swallow', 'KC3', 'planned', 'o', ''),
    ('K26', 'Rising Three Methods', 'KC3', 'planned', 'o', ''),
    ('K27', 'Mat Hold', 'KC3', 'planned', 'o', 'a gap in the candle definition only - no gap strategy'),
    # C. price action / structure
    ('P01', 'Higher High - Higher Low structure', 'ST', 'planned', 'o', ''),
    ('P02', 'Lower Low Failure', 'ST', 'planned', 'o', ''),
    ('P03', 'Lower High Breakout', 'ST', 'partial', 'o', 'the CHoCH break with 1 lower high (structure.py)'),
    ('P04', 'First Higher High after downtrend', 'ST', 'planned', 'o', ''),
    ('P05', 'First Higher Low after downtrend', 'ST', 'planned', 'o', ''),
    ('P06', 'Bullish Change of Character (CHoCH)', 'ST', 'lab', 'o', 'structure.py; Lab "Market structure"; TradingView script'),
    ('P07', 'Bullish Market Structure Shift (MSS)', 'ST', 'partial', 'ov', 'CHoCH + the displacement filter (dispAtr)'),
    ('P08', 'Bullish Break of Structure (BOS)', 'ST', 'partial', 'o', 'computed (bos_before), used as a filter only'),
    ('P09', 'Swing Failure Pattern (SFP)', 'SW', 'partial', 'o', "the owner's Spring is a 1-candle SFP"),
    ('P10', 'Failed Breakdown', 'SW', 'partial', 'o', 'Spring'),
    ('P11', 'Failed Bearish Breakout', 'SW', 'planned', 'o', ''),
    ('P12', 'Support Rejection', 'SR', 'planned', 'o', ''),
    ('P13', 'Resistance Flip into Support', 'SR', 'planned', 'o', ''),
    ('P14', 'Breakout and Retest', 'RT', 'planned', 'o', ''),
    ('P15', 'Successful Breakout Retest', 'RT', 'planned', 'o', 'P14 + a bounce confirmation'),
    ('P16', 'Pullback to Previous Swing High', 'RT', 'planned', 'o', ''),
    ('P17', 'Trendline Break and Retest', 'TL', 'planned', 'o', ''),
    ('P18', 'Descending Trendline Breakout', 'TL', 'planned', 'o', ''),
    ('P19', 'Compression Before Breakout', 'NR', 'planned', 'o', ''),
    ('P20', 'Bullish Inside Bar Breakout', 'NR', 'planned', 'o', ''),
    ('P21', 'Bullish Outside Bar Reversal', 'KC2', 'planned', 'o', ''),
    ('P22', 'Consecutive Higher Closes', 'KC3', 'planned', 'o', ''),
    ('P23', 'Range Expansion after Consolidation', 'NR', 'planned', 'o', ''),
    ('P24', 'Failed Lower Low / Bullish Structure Divergence', 'ST', 'planned', 'o', ''),
    # D. SMC / ICT
    ('S01', 'Sell-Side Liquidity Sweep', 'SW', 'partial', 'o', 'the Lab structure option "sweep" (a filter)'),
    ('S02', 'Equal Lows Liquidity Sweep', 'SW', 'planned', 'o', ''),
    ('S03', 'Previous Day Low Sweep', 'SW', 'partial', 'o', 'on daily candles the Spring is this'),
    ('S04', 'Previous Week Low Sweep', 'SW', 'planned', 'o', ''),
    ('S05', 'Previous Month Low Sweep', 'SW', 'planned', 'o', ''),
    ('S06', 'Swing Low Liquidity Grab', 'SW', 'partial', 'o', 'Spring + the lowestN rule'),
    ('S07', 'Inducement and Liquidity Sweep', 'SW', 'planned', 'o', ''),
    ('S08', 'Bullish Order Block', 'OB', 'planned', 'o', 'research only (the owner trades without order blocks)'),
    ('S09', 'Bullish Breaker Block', 'OB', 'planned', 'o', ''),
    ('S10', 'Bullish Mitigation Block', 'OB', 'planned', 'o', ''),
    ('S11', 'Bullish Rejection Block', 'OB', 'planned', 'o', ''),
    ('S12', 'Bullish Fair Value Gap', 'FV', 'lab', 'o', 'Lab Pattern "First touch of a zone" / FVG+Spring'),
    ('S13', 'Consequent Encroachment - 50% FVG', 'FV', 'partial', 'o', 'the zone middle is judged; a limit entry at 50 % is new'),
    ('S14', 'Inverse Fair Value Gap', 'FV', 'planned', 'o', ''),
    ('S15', 'Bullish Displacement', 'FV', 'partial', 'ov', 'dispAtr / dispVol on the CHoCH candle'),
    ('S16', 'Displacement + FVG', 'FV', 'partial', 'ov', ''),
    ('S17', 'Liquidity Sweep + CHoCH', 'ST', 'partial', 'o', 'sweep + structure "only my setup"'),
    ('S18', 'Liquidity Sweep + BOS', 'ST', 'planned', 'o', ''),
    ('S19', 'Order Block + FVG Confluence', 'OB', 'planned', 'o', ''),
    ('S20', 'Breaker Block + Liquidity Sweep', 'OB', 'planned', 'o', ''),
    ('S21', 'Premium-to-Discount Reversal', 'FV', 'partial', 'o', 'the discount rule'),
    ('S22', 'Discount Zone Entry', 'FV', 'lab', 'o', "the owner's CHoCH + FVG setup"),
    ('S23', 'Balanced Price Range', 'FV', 'planned', 'o', ''),
    ('S24', 'Reclaimed Order Block', 'OB', 'planned', 'o', ''),
    ('S25', 'Bullish Repricing / Imbalance', 'FV', 'planned', 'o', 'definition to agree'),
    # E. volume
    ('V01', 'Volume Climax + Bullish Reversal', 'VO', 'planned', 'ov', ''),
    ('V02', 'Selling Climax', 'VO', 'planned', 'ov', ''),
    ('V03', 'High Volume Bullish Reversal', 'VO', 'planned', 'ov', ''),
    ('V04', 'Volume Dry-up Before Breakout', 'VO', 'planned', 'ov', ''),
    ('V05', 'Volume Expansion Breakout', 'VO', 'planned', 'ov', ''),
    ('V06', 'Breakout with Relative Volume Surge', 'VO', 'planned', 'ov', 'B01-B04 already take a relative-volume rule'),
    ('V07', 'Price Rise + Increasing Volume', 'VO', 'planned', 'ov', ''),
    ('V08', 'Price Rise + Decreasing Volume Pullback', 'VO', 'planned', 'ov', ''),
    ('V09', 'Accumulation with Rising Lows', 'VO', 'planned', 'ov', ''),
    ('V10', 'Absorption at Support - OHLCV proxy', 'VO', 'planned', 'ov', 'a proxy - no order-book data'),
    ('V11', 'Hidden Buying / Bullish Volume Divergence', 'VO', 'planned', 'ov', ''),
    ('V12', 'No Supply Bar', 'VO', 'planned', 'ov', ''),
    ('V13', 'Stopping Volume', 'VO', 'planned', 'ov', ''),
    ('V14', 'Effort vs Result Bullish Pattern', 'VO', 'planned', 'ov', ''),
    ('V15', 'Volume-confirmed Resistance Breakout', 'VO', 'planned', 'ov', ''),
    ('V16', 'Upthrust Failure / Failed Selling Pressure', 'VO', 'planned', 'ov', ''),
    # F. breakout / consolidation
    ('B01', '20-Day High Breakout', 'HI', 'implemented', 'ov', ''),
    ('B02', '50-Day High Breakout', 'HI', 'implemented', 'ov', ''),
    ('B03', '52-Week High Breakout', 'HI', 'implemented', 'ov', ''),
    ('B04', 'All-Time High Breakout', 'HI', 'implemented', 'ov', 'all-time = since the data starts (20 years or the listing)'),
    ('B05', 'Multi-month Resistance Breakout', 'BASE', 'planned', 'o', ''),
    ('B06', 'Multi-touch Resistance Breakout', 'BASE', 'planned', 'o', ''),
    ('B07', 'Narrow Range Breakout', 'NR', 'planned', 'o', ''),
    ('B08', 'NR4 Breakout', 'NR', 'planned', 'o', ''),
    ('B09', 'NR7 Breakout', 'NR', 'planned', 'o', ''),
    ('B10', 'Inside Bar Cluster Breakout', 'NR', 'planned', 'o', ''),
    ('B11', 'Bollinger Band Squeeze Breakout', 'SQ', 'planned', 'o', ''),
    ('B12', 'Keltner Channel Squeeze Breakout', 'SQ', 'planned', 'o', ''),
    ('B13', 'Donchian Channel Breakout', 'HI', 'planned', 'o', 'the B01 detector with its own channel length'),
    ('B14', 'Darvas Box Breakout', 'BASE', 'planned', 'o', ''),
    ('B15', 'Opening Range Breakout - intraday', 'ORB', 'data', 'oi', 'no 5-minute candles; 15-minute only for ~6 months'),
    ('B16', 'Consolidation Breakout with Retest', 'BASE', 'planned', 'o', ''),
    ('B17', 'Volatility Contraction followed by Expansion', 'NR', 'planned', 'o', ''),
    ('B18', 'Multi-week Base Breakout', 'BASE', 'planned', 'ov', ''),
    ('B19', 'Resistance Absorption Breakout', 'BASE', 'planned', 'ov', ''),
    ('B20', 'Breakout from Long-term Moving Average Compression', 'SQ', 'planned', 'o', ''),
    # G. moving averages / trend
    ('M01', '20 EMA Pullback and Bounce', 'MA-pull', 'partial', 'o', 'the Lab EMA support rule (10 / 21 / 50) on Spring candles'),
    ('M02', '50 EMA Pullback and Bounce', 'MA-pull', 'partial', 'o', 'the Lab EMA support rule on Spring candles'),
    ('M03', '100 EMA Pullback and Bounce', 'MA-pull', 'planned', 'o', ''),
    ('M04', '200 EMA Pullback and Bounce', 'MA-pull', 'planned', 'o', ''),
    ('M05', 'Golden Cross - 50 DMA / 200 DMA', 'MA-cross', 'planned', 'o', ''),
    ('M06', '20 EMA / 50 EMA Bullish Cross', 'MA-cross', 'planned', 'o', ''),
    ('M07', '50 EMA / 200 EMA Bullish Alignment', 'MA-cross', 'planned', 'o', ''),
    ('M08', 'Moving Average Ribbon Expansion', 'MA-ribbon', 'planned', 'o', ''),
    ('M09', 'Moving Average Reclaim', 'MA-reclaim', 'planned', 'o', ''),
    ('M10', '200 DMA Reclaim', 'MA-reclaim', 'planned', 'o', ''),
    ('M11', 'Multi-timeframe Moving Average Alignment', 'MA-mtf', 'planned', 'o', 'weekly + daily (4 hour only from ~2021)'),
    ('M12', 'Supertrend Bullish Reversal', 'TREND', 'planned', 'o', ''),
    ('M13', 'Ichimoku Kumo Breakout', 'ICH', 'planned', 'o', ''),
    ('M14', 'Ichimoku Bullish TK Cross', 'ICH', 'planned', 'o', ''),
    ('M15', 'Ichimoku Kumo Twist', 'ICH', 'planned', 'o', ''),
    ('M16', 'VWAP Reclaim', 'VWAP', 'data', 'ovi', 'a true VWAP needs intraday candles; only a daily proxy is possible'),
    ('M17', 'Anchored VWAP Reclaim', 'VWAP', 'planned', 'ov', 'daily typical-price proxy anchored at a confirmed pivot'),
    ('M18', 'Bullish EMA Compression and Expansion', 'SQ', 'planned', 'o', ''),
    # H. momentum / indicators
    ('I01', 'RSI Bullish Divergence', 'DIV', 'implemented', 'o', ''),
    ('I02', 'RSI Hidden Bullish Divergence', 'DIV', 'planned', 'o', ''),
    ('I03', 'RSI Bullish Failure Swing', 'OSC', 'planned', 'o', ''),
    ('I04', 'RSI 50-Level Reclaim', 'OSC', 'planned', 'o', ''),
    ('I05', 'RSI Oversold Reversal', 'OSC', 'planned', 'o', ''),
    ('I06', 'MACD Bullish Crossover', 'OSC', 'planned', 'o', ''),
    ('I07', 'MACD Zero-Line Crossover', 'OSC', 'planned', 'o', ''),
    ('I08', 'MACD Positive Divergence', 'DIV', 'planned', 'o', ''),
    ('I09', 'Stochastic Bullish Crossover', 'OSC', 'planned', 'o', ''),
    ('I10', 'Stochastic Oversold Reversal', 'OSC', 'planned', 'o', ''),
    ('I11', 'CCI Bullish Reversal', 'OSC', 'planned', 'o', ''),
    ('I12', 'MFI Bullish Divergence', 'DIV', 'planned', 'ov', ''),
    ('I13', 'OBV Breakout', 'OBV', 'planned', 'ov', ''),
    ('I14', 'OBV Bullish Divergence', 'DIV', 'planned', 'ov', ''),
    ('I15', 'ADX Trend Strength Expansion', 'OSC', 'planned', 'o', ''),
    ('I16', 'ROC Momentum Reversal', 'OSC', 'planned', 'o', ''),
    ('I17', 'TSI Bullish Crossover', 'OSC', 'planned', 'o', ''),
    ('I18', 'Aroon Bullish Crossover', 'OSC', 'planned', 'o', ''),
    ('I19', 'Parabolic SAR Bullish Reversal', 'TREND', 'planned', 'o', ''),
    ('I20', 'Bollinger Band Lower-band Reversal', 'BB', 'planned', 'o', ''),
    ('I21', 'Bollinger Band Middle-band Reclaim', 'BB', 'planned', 'o', ''),
    ('I22', 'Bollinger Band Walking', 'BB', 'planned', 'o', ''),
    ('I23', 'Relative Strength vs Benchmark Breakout', 'RS', 'planned', 'ob', 'needs the index candles (on the laptop)'),
    ('I24', 'Relative Strength New High', 'RS', 'planned', 'ob', ''),
    # I. quantitative / statistical
    ('Q01', 'Mean Reversion from Statistical Oversold', 'QS', 'planned', 'o', ''),
    ('Q02', 'Z-Score Extreme Reversal', 'QS', 'planned', 'o', ''),
    ('Q03', 'Bollinger %B Reversal', 'BB', 'planned', 'o', ''),
    ('Q04', 'RSI-Price Statistical Divergence', 'DIV', 'planned', 'o', ''),
    ('Q05', 'ATR Contraction and Expansion', 'NR', 'planned', 'o', ''),
    ('Q06', 'Volatility Regime Breakout', 'NR', 'planned', 'o', ''),
    ('Q07', 'Consecutive Down-day Exhaustion', 'QS', 'planned', 'o', ''),
    ('Q08', 'Large Down Candle Reversal', 'QS', 'planned', 'o', ''),
    ('Q09', 'Gap-independent Opening Reversal', 'QS', 'planned', 'o', 'defined on daily OHLC, no gap rule'),
    ('Q10', 'Momentum Acceleration', 'QS', 'planned', 'o', ''),
    ('Q11', 'Rate-of-Change Inflection', 'QS', 'planned', 'o', ''),
    ('Q12', 'Multi-timeframe Momentum Alignment', 'QS', 'planned', 'o', ''),
    ('Q13', 'Relative Strength Leadership Breakout', 'RS', 'planned', 'ob', ''),
    ('Q14', 'Donchian Channel Trend Initiation', 'HI', 'planned', 'o', ''),
    ('Q15', 'Statistical Pullback in Established Uptrend', 'QS', 'planned', 'o', ''),
    ('Q16', 'Price-Volume Anomaly', 'QS', 'planned', 'ov', ''),
    ('Q17', 'Range Expansion after Low Volatility', 'NR', 'planned', 'o', ''),
    ('Q18', 'Trend Persistence / Momentum Continuation', 'QS', 'planned', 'o', ''),
    ('Q19', 'Failed Momentum Breakdown', 'QS', 'planned', 'o', ''),
    ('Q20', 'Multi-factor Bullish Confluence', 'COMBO', 'planned', 'ov', 'a combination - phase 5'),
    # the owner's own patterns (kept as they are)
    ('X01', 'Spring', 'OWN', 'lab', 'o', 'Lab Pattern "Every Spring"'),
    ('X02', 'FVG + Spring', 'OWN', 'lab', 'o', 'Lab Pattern "FVG+Spring"'),
    ('X03', 'Gap-up FVG + Spring', 'OWN', 'lab', 'o', 'Lab Pattern "Gap-up FVG + Spring" (existing feature, kept)'),
    ('X04', 'CHoCH + FVG (discount zone, 2nd zone rule)', 'OWN', 'lab', 'o', 'Lab "My CHoCH + FVG setup"'),
    ('X05', 'FVG First Touch / Confirmed', 'OWN', 'lab', 'o', 'Lab Patterns "FVG First Touch" / "Confirmed"'),
    ('X06', 'Bullish Harami + Inverted Hammer', 'OWN', 'sheet', 'o', 'sheet column W; Lab Fib + pattern rule'),
    ('X07', 'Twin Star Bottom', 'OWN', 'sheet', 'o', 'sheet column W / X'),
    ('X08', 'Three Day Low Rejection', 'OWN', 'sheet', 'o', 'sheet column W'),
    ('X09', 'Trio', 'OWN', 'sheet', 'o', 'sheet column W'),
    ('X10', 'FVG 123 / FVG 1234 / FVG Touch', 'OWN', 'sheet', 'o', 'sheet column W'),
]

# the written rules of every implemented pattern (master prompt section 5: data, lookback, conditions, confirmation, signal
# time, entry eligibility, invalidation, stop reference, parameters) - pattern_detect.py follows these exactly
SPECS = {
    'K08': {
        'version': 1, 'lookback': 2, 'params': {'engBody': 0.0},
        'rules': [
            'c1 = the candle before, c2 = the signal candle (OHLC only).',
            'c1 red (close < open), c2 green (close > open).',
            "c2's body engulfs c1's: c2 open <= c1 close and c2 close >= c1 open, and c2's body is bigger than c1's "
            "(= the sheet's column W rule, AB_ENGULFING_REQUIRE_BIGGER).",
            'engBody > 0: c2 body at least engBody x ATR(14) (Wilder) of the candle before c2 - leaves out tiny candles.',
            "Confirmed at c2's close: signal candle = c2; first entry = c2's close (or the next open).",
            "Stop reference = the lower of c1's and c2's lows; trigger = c2's high.",
            'Invalidated once a later close is under that stop reference (the entry is not taken after that).',
        ]},
    'B01': {'version': 1, 'lookback': 20, 'params': {'boBuf': 0.0, 'boVol': 0.0}, 'rules': None},
    'B02': {'version': 1, 'lookback': 50, 'params': {'boBuf': 0.0, 'boVol': 0.0}, 'rules': None},
    'B03': {'version': 1, 'lookback': 252, 'params': {'boBuf': 0.0, 'boVol': 0.0}, 'rules': None},
    'B04': {'version': 1, 'lookback': 252, 'params': {'boBuf': 0.0, 'boVol': 0.0}, 'rules': None},
    'I01': {
        'version': 1, 'lookback': 60, 'params': {'rsiN': 14, 'divPivot': 5, 'divMaxGap': 60, 'divRsiMax': 100.0},
        'rules': [
            'Close prices for RSI (Wilder, rsiN = 14), lows for the swing lows.',
            'Swing lows = structure.pivots with divPivot candles each side (a low lower than the divPivot lows before it and '
            'not above the divPivot lows after it). A swing low at candle p is KNOWN only at candle p + divPivot.',
            'Two consecutive swing lows p1 < p2, at least divPivot and at most divMaxGap candles apart (60).',
            'Price makes a lower low: low(p2) < low(p1). RSI makes a higher low: RSI(p2) > RSI(p1).',
            'divRsiMax < 100: RSI(p1) must be at most divRsiMax (e.g. 40 = the first low was oversold-ish).',
            'Confirmed on candle p2 + divPivot (the 2nd swing low becomes known): signal candle = that candle - never p2.',
            "Stop reference = low(p2); trigger = the highest high from p2 to the signal candle.",
            'Invalidated by a close under low(p2) before the entry.',
        ]},
}
_BO = {'B01': ('20 candles', 'D: 20 days; W: 20 weeks; 4H: 20 candles'), 'B02': ('50 candles', 'D: 50 days; W: 50 weeks; 4H: 50 candles'),
       'B03': ('52 weeks', 'D: 252 candles; W: 52; 4H: 504 (two a day)'),
       'B04': ('all the history', 'every candle before it, with at least 252 daily candles (52 weekly, 504 4-hour) of history')}
for _k, (_what, _tf) in _BO.items():
    SPECS[_k]['rules'] = [
        'OHLC + volume.',
        'Level = the highest HIGH of %s before the signal candle (%s) - the signal candle itself is not in it.' % (_what, _tf),
        'Signal: the close is above level x (1 + boBuf %%) AND the previous close was not above ITS level (a fresh breakout - '
        'a stock staying above it does not signal again every day).',
        'boVol > 0: the signal candle\'s volume at least boVol x the average of the 20 candles before it.',
        "Confirmed at the signal candle's close: first entry = its close (or the next open).",
        "Stop reference = the signal candle's low; trigger = the level.",
        'Invalidated once a later close is back under the level before the entry.',
    ]

# ------------------------------------------------------------------ PHASE 2 (owner, 13-Nov-2026: "Yes do it" - candlesticks,
# breakouts, moving averages, basic volume patterns). The shared definitions every rule below uses:
COMMON = [
    'ATR = Wilder ATR(14) of the candle BEFORE the pattern\'s first candle (its size yardstick, known before the pattern starts).',
    'Long body = body >= 0.7 x ATR; small body = body <= 0.3 x ATR; doji = body <= 10 % of its own range (range > 0). '
    'Upper shadow = high - max(open, close), lower shadow = min(open, close) - low; "% of the range" = of that candle\'s high - low.',
    'c1, c2 ... = the pattern\'s candles, oldest first; the signal = the close of its last candle. Entry = that close or the next '
    'open (the Lab\'s "Buy"); stop reference = the lowest low of the pattern\'s candles and trigger = their highest high, unless '
    'a rule says otherwise.',
    'Fresh = the close above the level while the close before was not above ITS level (one signal per breakout, not every day '
    'the price stays above).',
    'Relative volume = the candle\'s volume / the average volume of the 20 candles BEFORE it.',
    'Trend context (Lab "Before the pattern", reversal patterns only): "After a fall" keeps a pattern only when the candle before '
    'it closed under its 20-SMA and that SMA fell over the 5 candles before. Continuation patterns (K16, K26, K27) always need '
    'the uptrend: the candle before closed above its 20-SMA, which rose over the 5 candles before.',
    'Invalidated by a close under the stop reference before the entry. Lengths are candles of the chosen timeframe unless a rule '
    'gives one per timeframe. Every value uses only the candle and earlier ones (checked: cut / changed-future tests).',
]


def _sp(rules, words, lookback, ctx=False, note=None, params=None):
    d = {'version': 1, 'lookback': lookback, 'params': params or {}, 'rules': rules, 'words': words, 'ctx': ctx}
    if note:
        d['note'] = note
    return d


SHEET = "the sheet's own column W rule (checked equal to web/lib/patterns.js)"
P2 = {
    # candlesticks
    'K01': _sp(['One candle, range >= 0.5 x ATR, either colour.', 'Body > 10 % and <= 35 % of the range (a doji is K03).',
                'Lower shadow >= 2 x the body and >= 55 % of the range; upper shadow <= 10 % of the range.'],
               'A hammer: a small body at the top and a long lower shadow - sellers pushed the price down during the candle and '
               'buyers pushed it back up.', 15, True),
    'K02': _sp(['One candle, range >= 0.5 x ATR, either colour.', 'Body > 10 % and <= 35 % of the range.',
                'Upper shadow >= 2 x the body and >= 55 % of the range; lower shadow <= 10 % of the range.'],
               'An inverted hammer: a small body at the bottom and a long upper shadow - buyers tried to lift the price after a '
               'fall.', 15, True),
    'K03': _sp(['One candle, range >= 0.5 x ATR.', 'A doji (body <= 10 % of the range) with an upper shadow <= 10 % and a lower '
                'shadow >= 70 % of the range.'],
               'A dragonfly doji: it opened and closed at the top after a long dip during the candle - the dip was fully bought.',
               15, True),
    'K04': _sp(['Green, long body.', 'Upper and lower shadows each <= 5 % of the range.'],
               'A bullish marubozu: a long green candle with almost no shadows - buyers were in control from the open to the close.',
               15, True),
    'K05': _sp(['Green, long body, body >= 60 % of the range.', 'Opens at its low: lower shadow <= 3 % of the range.',
                'Opens below the close of the candle before.'],
               'A bullish belt hold: it opened lower, at its low, and then rose all the way - a strong turn after a fall.', 15, True),
    'K06': _sp(['Range >= 1 x ATR (a big candle).', 'Lower shadow >= 60 % of the range.',
                'Close in the upper half of the range (close location value >= 0).'],
               'A long lower shadow: a big candle whose low was strongly rejected - it closed in its upper half.', 15, True),
    'K07': _sp(['Green, long body, body >= 60 % of the range.',
                'Closes at its high: upper shadow <= 2 % of the range; a lower shadow > 5 % (otherwise it is K04).'],
               'A closing marubozu: a long green candle that closed at its high - buyers held on until the close.', 15, True),
    'K09': _sp(['c1 red; c2 opens under c1\'s LOW.', 'c2 closes above the middle of c1\'s body and below c1\'s open.',
                'No size rule (the sheet\'s rule).'],
               'A piercing line: after a red candle the next one opened below its low and closed above the middle of its body.',
               2, True, SHEET),
    'K10': _sp(['c1 red, c2 green.', "c2's body inside c1's body (c2 open >= c1 close, c2 close <= c1 open), smaller than c1's.",
                "c2's low above c1's low (the sheet's rule)."],
               'A bullish harami: a small green candle inside the body of the red one before - the fall stopped.', 2, True, SHEET),
    'K11': _sp(['c1 red, long body.', 'c2 a doji with its whole body inside c1\'s body (between c1\'s close and open).'],
               'A harami cross: a doji inside the body of a long red candle - the selling stopped.', 15, True),
    'K12': _sp(['c1 red, c2 green.', 'Lows equal within 1.25 % of their average.',
                'Bodies differ by <= 25 % of the bigger, lower shadows by <= 30 %, both lower shadows > 0 (the sheet\'s rule).'],
               'A tweezer bottom: two candles with the same low, a red then a green one - that low was defended twice.', 2, True, SHEET),
    'K13': _sp(['c1 red with a long body, c2 red.', 'Their closes equal within 0.1 % of c1\'s close.'],
               'A matching low: two red candles closing at the same price - the fall found a floor.', 15, True),
    'K14': _sp(['c1 red, long body; c2 green, long body.', 'c2 opens at least 30 % of c1\'s body under c1\'s close.',
                'c2 closes within 10 % of c1\'s body from c1\'s close.'],
               'A bullish counterattack: after a long red candle the next one opened much lower and climbed back to the same close.',
               15, True),
    'K15': _sp(['c1 red marubozu, c2 green marubozu (long bodies, shadows <= 5 % of the range).',
                'c2\'s low above c1\'s high (a gap - part of the candle definition only).'],
               'A bullish kicking pattern: a strong red candle, then a strong green one that opened above it.', 15, True),
    'K16': _sp(['The uptrend before c1 (continuation).', 'c1 red, body >= 0.3 x ATR; c2 green, long body.',
                'c2 opens at c1\'s open (within 10 % of c1\'s body) and at its own low (lower shadow <= 5 % of the range).'],
               'Bullish separating lines: in an uptrend a red candle, then a green one opening at the same price and rising - the '
               'pause is over.', 25),
    'K17': _sp(['c1 red, body >= 2 % of its open, lower shadow <= 30 % of its range.', 'c2 body <= 30 % of c1\'s.',
                'c3 green, body >= 2 % of its open, closes at or above the middle of c1\'s body (the sheet\'s rule).'],
               'A morning star: a big red candle, a small one, then a big green one closing into the red body - a turn after a fall.',
               3, True, SHEET),
    'K18': _sp(['c1 red, long body.', 'c2 a doji whose body is wholly under c1\'s close.',
                'c3 green, body >= 0.5 x ATR, closes above the middle of c1\'s body.'],
               'A morning doji star: a long red candle, a doji below it, then a green candle closing into the red body.', 15, True),
    'K19': _sp(['Three green candles, each a long body with an upper shadow <= 25 % of its range.',
                'Each closes higher than the one before and opens inside the previous body.'],
               'Three white soldiers: three strong green candles in a row, each closing higher - a steady takeover by buyers.',
               15, True),
    'K20': _sp(['c1 red, long body.', 'c2 green with its body inside c1\'s, smaller.', 'c3 green, closing above c1\'s open.'],
               'Three inside up: a harami confirmed by a third candle closing above the red candle\'s open.', 15, True),
    'K21': _sp(['c1 red; c2 green engulfing c1\'s body (opens <= c1 close, closes >= c1 open, bigger body).',
                'c3 green, closing above c2\'s close.'],
               'Three outside up: a bullish engulfing confirmed by a third candle closing higher.', 3, True),
    'K22': _sp(['c1 red, long body, lower shadow >= 30 % of its range.',
                'c2 red, smaller body, opens inside c1\'s body, low above c1\'s low, with a lower shadow.',
                'c3 small red (body <= 0.3 x ATR, shadows <= 10 % of its range) inside c2\'s range.'],
               'Three stars in the south: three red candles, each smaller and holding a higher low - the selling dried up.',
               15, True),
    'K23': _sp(['c1 red, long body.', 'c2 a doji whose HIGH is under c1\'s low (a gap - candle definition only).',
                'c3 green whose LOW is above c2\'s high, closing above the middle of c1\'s body.'],
               'A bullish abandoned baby: a doji left alone below the candles on both sides - a sharp turn.', 15, True),
    'K24': _sp(['c1 red, body >= 0.3 x ATR.', 'c2 green, opens at / above c1\'s close, closes above c1\'s open.',
                'c3 red, opens above c2\'s close, closes within 0.2 % of c1\'s close.'],
               'A stick sandwich: two red candles closing at the same price around a green one - that close held twice.', 15, True),
    'K25': _sp(['c1 and c2 red marubozus (long bodies, shadows <= 5 %).',
                'c3 red, opens under c2\'s close, its high above c2\'s close.',
                'c4 red, opens at / above c3\'s high, closes at / under c3\'s low (engulfs it with the shadows).'],
               'A concealing baby swallow: four red candles where the selling exhausts itself - a rare reversal.', 15, True),
    'K26': _sp(['The uptrend before c1 (continuation).', 'c1 green, long body.',
                'c2, c3, c4: bodies <= half of c1\'s, inside c1\'s range, at least two of them red.',
                'c5 green, long body, opens above c4\'s close and closes above c1\'s close.'],
               'Rising three methods: a strong green candle, a small three-candle pause inside it, then a new strong green candle.',
               25),
    'K27': _sp(['The uptrend before c1 (continuation).', 'c1 green, long body.',
                'c2: body wholly above c1\'s close, body <= half of c1\'s.',
                'c3, c4: bodies <= half of c1\'s, lows at / above the middle of c1\'s body.',
                'c5 green, closes above the highest high of c2 - c4.'],
               'A mat hold: a strong green candle, a short pause that holds high, then the climb goes on.', 25),
    # breakouts
    'B05': _sp(['Level = the highest high of the 126 candles before (daily; weekly 26, 4-hour 252) made at least 63 candles '
                '(weekly 13, 4-hour 126) before - the newer candles all stayed under it.',
                'Signal: the close above that level.', "Stop reference = the signal candle's low; trigger = the level."],
               'The price closed above a high that had stopped it for months.', 252),
    'B06': _sp(['Level = the highest high of the 60 candles before (weekly 26, 4-hour 120).',
                'At least 3 separate touches: highs within 1 % of the level, at least 3 candles apart.',
                'Signal: a fresh close above the level.', "Stop reference = the signal candle's low."],
               'The price closed above a level it had hit at least three times before.', 120),
    'B07': _sp(['The candle before is narrow: range <= 0.5 x ATR(14) of the candle before it.',
                'Signal: the close above that narrow candle\'s high.', 'Stop reference = the lower of the two lows.'],
               'After a very quiet, narrow candle the price closed above its high.', 16),
    'B08': _sp(['The candle before has the smallest range of the last 4 candles (NR4).', 'Signal: the close above its high.',
                'Stop reference = the lower of the two lows.'],
               'After the narrowest candle of 4 (NR4) the price closed above its high.', 4),
    'B09': _sp(['The candle before has the smallest range of the last 7 candles (NR7).', 'Signal: the close above its high.',
                'Stop reference = the lower of the two lows.'],
               'After the narrowest candle of 7 (NR7) the price closed above its high.', 7),
    'B10': _sp(['A mother candle followed by 2 to 10 inside candles (each high <= the mother\'s high, low >= its low) ending on '
                'the candle before (the nearest such mother).', 'Signal: the close above the mother\'s high.',
                "Stop reference = the mother's low."],
               'After several candles stayed inside one bigger candle, the price closed above that candle\'s high.', 12),
    'B11': _sp(['Bollinger Bands 20, 2 (population standard deviation); bandwidth = (upper - lower) / middle.',
                'Squeeze: the bandwidth of the candle before is in the lowest 10 % of the 126 candles before it.',
                'Signal: a fresh close above the upper band.', "Stop reference = the signal candle's low."],
               'After the Bollinger Bands squeezed to one of their narrowest widths, the price closed above the upper band.', 146),
    'B12': _sp(['Keltner Channel = EMA(20) +/- 1.5 x Wilder ATR(20); Bollinger Bands 20, 2.',
                'Squeeze: on the 3 candles before, both Bollinger Bands lay inside the Keltner Channel.',
                'Signal: a fresh close above the upper Keltner line.', "Stop reference = the signal candle's low."],
               'After a squeeze (Bollinger Bands inside the Keltner Channel) the price closed above the Keltner Channel.', 23),
    'B13': _sp(['Donchian channel 55: the highest high of the 55 candles before (every timeframe).',
                'Signal: a fresh close above it.', "Stop reference = the signal candle's low."],
               'The price closed above the highest high of the 55 candles before (a Donchian channel breakout).', 55),
    'B14': _sp(['Box top: a high at or above the 10 highs before it that the next 3 candles do not reach (known 3 candles later).',
                'Box bottom: the lowest low since the top, not broken by the next 3 candles, while no high reaches the top (a high '
                'at the top first = start again).',
                'Signal: the first close above the top after the box is known; a low under the bottom first = the box is void.',
                'Stop reference = the box bottom.'],
               'A Darvas box: the price built a box under a high, then closed above the box top.', 20),
    'B16': _sp(['Breakout: a fresh close above the highest high of the 20 candles before, after a base (those 20 candles\' high - '
                'low <= 15 % of the low).',
                'Retest within 10 candles: a low within 1 % above the level (or under it) and a close above it = the signal; a '
                'close more than 2 % under the level first = no retest.', "Stop reference = the retest candle's low."],
               'The price broke out of a base, came back to test the breakout level and closed above it again.', 31),
    'B17': _sp(['ATR(14) of the candle before is the lowest of the 20 before and at most 75 % of the ATR 20 candles earlier.',
                'Signal candle: green, range >= 2 x that ATR, closing in the top quarter of its range.'],
               'After the candles became small and quiet, a big green candle closed near its high - volatility woke up upwards.', 36),
    'B18': _sp(['Base = the 30 candles before (weekly 8, 4-hour 60) with high - low <= 15 % of the low.',
                'Signal: a fresh close above the base high.'],
               'The price closed above a tight multi-week base.', 60),
    'B19': _sp(['Level = the highest high of the 40 candles before.',
                'At least 3 of the 10 candles before had a high within 1.5 % of it, and the lowest low of the last 5 candles is '
                'above the lowest low of the 10 before those (higher lows).', 'Signal: a fresh close above the level.'],
               'The price kept pressing a resistance with rising lows and then closed above it.', 41),
    'B20': _sp(['SMA 20, 50 and 200 of the candle before within 3 % of its close (the averages squeezed together).',
                'Signal: the close more than 1 % above the highest of the three, while the close before was not.'],
               'The 20, 50 and 200 averages came together, then the price broke out above all of them.', 201),
    # moving averages
    'M01': None, 'M02': None, 'M03': None, 'M04': None,
    'M05': _sp(['SMA(50) crosses above SMA(200): above on the signal candle, not above on the candle before.',
                'Stop reference = the lowest low of the last 20 candles.'],
               'A golden cross: the 50 average crossed above the 200 average.', 201),
    'M06': _sp(['EMA(20) crosses above EMA(50).', 'Stop reference = the lowest low of the last 10 candles.'],
               'The 20 EMA crossed above the 50 EMA.', 51),
    'M07': _sp(['Close > EMA(50) > EMA(200), both EMAs higher than 5 candles before.',
                'Signal: the first candle where this holds after one where it did not.',
                'Stop reference = the lowest low of the last 10 candles.'],
               'Price, the 50 EMA and the 200 EMA lined up upwards, both averages rising.', 206),
    'M08': _sp(['EMAs 10, 20, 30, 40, 50, 60 in order (10 highest) on the signal candle but not on the one before.',
                'The spread EMA10 - EMA60 (as % of the close) wider than 5 candles before.',
                'Stop reference = the lowest low of the last 10 candles.'],
               'The six averages fanned out in bullish order - a ribbon opening upwards.', 66),
    'M09': _sp(['The close above EMA(50) after the 10 closes before it were all under it.',
                'Stop reference = the lowest low of those 11 candles.'],
               'The price closed back above the 50 EMA after ten closes under it.', 60),
    'M10': _sp(['The close above SMA(200) after the 20 closes before it were all under it.',
                'Stop reference = the lowest low of those 21 candles.'],
               'The price closed back above the 200-day average after twenty closes under it.', 220),
    'M11': _sp(['Higher timeframe built from the candles themselves (daily run: weeks; weekly run: months; 4-hour run: days) - '
                'only FINISHED higher candles: the last finished one closed above its EMA(10), which is above its EMA(20).',
                'The candle itself: close > EMA(20) > EMA(50).',
                'Signal: the first candle where both hold after one where they did not.',
                'Stop reference = the lowest low of the last 10 candles.'],
               'The weekly trend (finished weeks only) and the daily trend both turned up together.', 120),
    'M12': _sp(['Supertrend(10, 3) with Wilder ATR(10): (high + low) / 2 +/- 3 x ATR with the usual carry-forward of the bands.',
                'Signal: the trend turns up - the close above the upper band - on this candle.',
                'Stop reference = the Supertrend line (the lower band), or the candle\'s low if lower.'],
               'The Supertrend turned from down to up.', 30),
    # volume
    'V01': _sp(['c1 red, relative volume >= 2.5, its low under the lowest low of the 20 candles before (a climax).',
                'c2 green, closing above the middle of c1\'s range.'],
               'A selling climax on very high volume, followed straight away by a green candle that took back half of it.', 22),
    'V02': _sp(['Relative volume >= 3, the low under the lowest low of the 20 candles before, the close in the upper half of the '
                'range (close location value >= 0).'],
               'A selling climax: huge volume at a new low, but the candle closed in its upper half.', 21),
    'V03': _sp(['A fall: the candle before closed under the close 5 candles before it.',
                'Signal candle: green, relative volume >= 2, closes above the high of the candle before.'],
               'After a fall, a green candle on twice the usual volume closed above the previous high.', 21),
    'V04': _sp(['Average volume of the 10 candles before <= 60 % of the average of the 50 before those (volume dried up).',
                'Signal: a fresh close above the highest high of the 20 candles before.'],
               'Volume dried up during the pause, then the price broke out.', 61),
    'V05': _sp(['A fresh close above the highest high of the 20 candles before.',
                'Volume rising over 3 candles (each above the one before) and relative volume >= 1.5.'],
               'A breakout on volume that grew for three candles.', 21),
    'V06': _sp(['A fresh close above the highest high of the 50 candles before with relative volume >= 3.'],
               'A 50-candle breakout on three times the usual volume.', 51),
    'V07': _sp(['Three green candles with rising closes and rising volume, the last with relative volume >= 1.2.',
                'Signal: the first candle where this holds.'],
               'Three rising green candles on rising volume.', 23),
    'V08': _sp(['Uptrend: close above SMA(50), the SMA above its value 10 candles before.',
                'A pullback of 3 - 6 lower closes ending on the candle before, its average volume < 70 % of the 20 candles before it.',
                'Signal candle: green, closes above the high of the candle before.',
                'Stop reference = the lowest low of the pullback and the signal candle.'],
               'In an uptrend a quiet, low-volume pullback ended with a green candle above the previous high.', 61),
    'V12': _sp(['A down candle (close under the close before) with a range < 0.7 x ATR(14), volume lower than each of the 2 '
                'candles before, not closing at its low (close location value >= -0.5).',
                'In an uptrend: close above SMA(50), the SMA above its value 10 candles before.',
                'A volume-spread proxy (no order-book data).'],
               'A "no supply" candle: a small down candle on low volume in an uptrend - few sellers left.', 61),
    'V13': _sp(['A fall: the close under its 20-SMA and under the close 5 candles before.',
                'Relative volume >= 2, close in the upper half of the range, lower shadow >= 40 % of the range.'],
               'Stopping volume: heavy volume in a fall, but the candle closed high with a long lower shadow.', 21),
    'V15': _sp(['The B06 level (the highest high of the 60 candles before, touched at least 3 separate times within 1 %) broken by '
                'a fresh close above it with relative volume >= 1.5.'],
               'The price broke a level tested three times, on clearly higher volume.', 120),
}
for _n, _k in ((20, 'M01'), (50, 'M02'), (100, 'M03'), (200, 'M04')):
    P2[_k] = _sp(['EMA(%d) rising: above its value 10 candles before.' % _n,
                  'The signal candle\'s low at or within 0.5 %% above the EMA(%d), its close above it, green.' % _n,
                  'The 5 closes before it above the EMA and the 3 lows before it more than 0.5 % above it (a pullback that just '
                  'arrived).', "Stop reference = the signal candle's low."],
                 'A pullback in an uptrend touched the rising %d EMA and bounced off it.' % _n, _n + 10)
SPECS.update(P2)

# ------------------------------------------------------------------ PHASE 3 (owner, 13-Nov-2026: "Do it" - price action / structure,
# SMC / ICT, the rest of the volume patterns, momentum, quant, Ichimoku / anchored VWAP / EMA compression; pattern_p3.py)
COMMON += [
    'Swings (phase 3): a swing low = a low lower than the patSwing (5) candles before it and not above the patSwing candles after '
    'it (a swing high mirrored - structure.pivots, the same as the Lab\'s market structure). A swing is KNOWN patSwing candles '
    'after it; "the latest swing low" at a candle = the latest one known before that candle. A pattern whose signal is the swing '
    'itself signals on the candle it becomes known, never on the swing candle.',
    'Zones (SMC): a bullish FVG = the 3rd candle\'s low above the 1st candle\'s high, the gap at least 0.1 x ATR (zone = that gap); '
    'a bearish FVG mirrored. A zone\'s first touch = the first later candle whose low reaches the zone (its top, or its middle '
    'where the rule says so) closing above the zone bottom - a close under the bottom first ends the zone. Stop reference = the '
    'lower of the zone bottom and that candle\'s low.',
    'Indicators: RSI(14) Wilder; MACD 12 / 26 / 9; slow Stochastic 14 / 3 / 3; CCI(20); MFI(14); OBV; Chaikin A/D line; Wilder '
    '+DI / -DI / ADX(14); ROC(n) in %; TSI 25 / 13 with a 7 signal; Aroon(25); Parabolic SAR 0.02 / 0.02 / 0.2; Bollinger Bands '
    '20, 2 (population standard deviation), %B = (close - lower) / (upper - lower); z-score = (close - SMA(n)) / standard '
    'deviation(n); Ichimoku 9 / 26 / 52 (the cloud at a candle = spans A / B computed 26 candles before). EMAs are seeded with '
    'the mean of their first n values. "Crosses above" = above on this candle, at or under on the one before.',
    'Divergences (I08 I12 I14 V11, hidden I02): the two latest swing lows of price with divPivot (5) candles each side, divPivot to '
    'divMaxGap (60) candles apart; signal on the candle the 2nd one becomes known; stop reference = its low.',
    'Benchmark (I23 I24 Q13) = NIFTY 50 daily closes on the laptop; the ratio = the stock\'s close / the index close of the same '
    'day (4-hour candles: of the session before - the index has daily candles only).',
    '"Stop = the last N lows" = the lowest low of the N candles up to and including the signal candle.',
]
SW = {'patSwing': 5}
DV = {'divPivot': 5, 'divMaxGap': 60}
SMC = 'SMC research pattern (the owner trades his own CHoCH + FVG setup, X04 - this is a simpler generic version)'
P3 = {
    # P. price action / market structure
    'P01': _sp(['When a swing low L2 becomes known, the swing low before it (L1) is lower - a higher low.',
                'The highest swing high between L1 and L2 is above the latest swing high before L1 - a higher high.',
                'Signal on the candle L2 becomes known; stop reference = L2\'s low; trigger = that higher high.'],
               'Price made a higher high and then a higher low - an uptrend structure; the signal comes when the higher low is '
               'confirmed by the candles after it.', 60, params=SW),
    'P02': _sp(['A candle\'s low goes under the latest known swing low (the lower-low candle; each swing low once).',
                'Within the next 5 candles a close above that candle\'s high, with no lower low in between.',
                'Stop reference = the lower-low candle\'s low; trigger = its high.'],
               'Price dipped under the last swing low but could not stay down: within 5 candles it closed above the high of the '
               'candle that made the lower low.', 30, True, params=SW),
    'P03': _sp(['The latest known swing high is a lower high (under the swing high before it), at most 100 candles old.',
                'Signal: the first close above it.', 'Stop reference = the lowest low since that swing high; trigger = its level.'],
               'In a fall each bounce peaked lower; then price closed above the last of those lower highs.', 60, params=SW),
    'P04': _sp(['A swing high H becomes known above the swing high before it, while that one was a lower high (under the one '
                'before it), and the last two swing lows before H were falling (a lower low).',
                'Signal on the candle H becomes known; stop reference = the lowest low from the previous swing high to the signal; '
                'trigger = H.'],
               'After lower highs and lower lows, price made its first higher high.', 80, params=SW),
    'P05': _sp(['A swing low L becomes known above the swing low before it, while that one was a lower low (under the one before '
                'it), and the last two swing highs before L were falling.',
                'Signal on the candle L becomes known; stop reference = L\'s low; trigger = the highest high since L.'],
               'After lower lows, price made its first higher low.', 80, params=SW),
    'P06': _sp(['structure.choch_events with patSwing candles each side (the Lab\'s own CHoCH): after at least 2 lower highs / '
                'lows, the first close above the last swing high.',
                'Signal = that close; stop reference = the final low; trigger = the CHoCH level; the count of lower highs / lows '
                'kept for the breakdowns.'],
               'A change of character: after a fall of lower highs and lower lows, a candle closed above the last swing high.',
               80, params=SW, note='the Lab\'s market-structure engine as a pattern; the owner\'s full setup = X04'),
    'P07': _sp(['A P06 CHoCH whose candle is a displacement: green, body >= 1.2 x ATR, close in the top quarter of its range '
                '(CLV >= 0.5).', 'Signal, stop and trigger as P06.'],
               'A change of character made by one strong candle - a market structure shift.', 80, params=SW),
    'P08': _sp(['An uptrend structure: the latest known swing high above the one before it and the latest known swing low above '
                'the one before it.', 'Signal: the first close above the latest swing high (at most 100 candles old).',
                'Stop reference = the latest swing low; trigger = the swing high.'],
               'In an uptrend of higher highs and higher lows, price broke above the last swing high.', 60, params=SW),
    'P09': _sp(['A candle\'s low goes under the latest known swing low and the same candle closes back above it.',
                'The first candle that goes under that swing low decides (closing under it = taken, no later signal).',
                'Stop reference = the candle\'s low; trigger = its high; the dip under the swing low in % kept.'],
               'A swing failure: price poked under the last swing low and closed back above it in the same candle.', 30, True,
               params=SW),
    'P10': _sp(['A close under the latest known swing low (each swing low once).', 'Within 3 candles a close back above it.',
                'Stop reference = the lowest low since the breakdown; trigger = the level.'],
               'Price closed under the last swing low but got back above it within 3 candles - a failed breakdown.', 30, True,
               params=SW),
    'P11': _sp(['A fresh close under the lowest low of the 20 candles before (the close before was not under its own).',
                'Within 3 candles a close back above that level.',
                'Stop reference = the lowest low since the breakdown; trigger = the level.'],
               'Price broke under its 20-candle range and came back inside within 3 candles.', 25, True),
    'P12': _sp(['Support = two known swing lows within 1 % of each other, at most 60 candles apart, among the last three (the '
                'newest included); level = the lower of the two.',
                'Signal: the first candle whose low comes within 0.5 % above the level (or under it), closing above it, green, '
                'lower shadow >= 40 % of its range. A close under the level first = broken (no signal).',
                'Stop reference = the candle\'s low.'],
               'Price came back to a support tested twice before and was pushed up again (a long lower shadow).', 70, True,
               params=SW),
    'P13': _sp(['Resistance = two known swing highs within 1 % of each other, at most 120 candles apart (among the last three); '
                'level = the higher.',
                'A close above it, then within 20 candles a green candle whose low comes back to within 1 % above it (or under '
                'it) - no close under the level in between.', 'Signal = that candle; stop reference = its low; trigger = the level.'],
               'An old resistance was broken and then held as support on the first pullback.', 130, params=SW),
    'P14': _sp(['The first close above the latest known swing high (the breakout).',
                'Within 15 candles a candle whose low comes back to within 1 % above that level (or under it), closing above it - '
                'a close under the level first = failed.', 'Signal = that retest candle; stop reference = its low.'],
               'Price broke out above a swing high, came back to test it, and held above it.', 40, params=SW),
    'P15': _sp(['A P14 retest, then within 3 candles a close above the retest candle\'s high (no close under the level between).',
                'Signal = that close; stop reference = the lowest low since the retest; trigger = the retest candle\'s high.'],
               'After the breakout and the retest, price confirmed the bounce by closing above the retest candle.', 45, params=SW),
    'P16': _sp(['The two latest known swing highs rising (a higher high).',
                'Within 40 candles of the newer one becoming known: the first candle whose low comes back to within 1 % above the '
                'older swing high (or under it), closing at or above it, while the close is above a rising 50-SMA (above its value '
                '10 candles before). A close under the older high first = void.', 'Stop reference = the candle\'s low.'],
               'In an uptrend, price pulled back to the previous swing high - old resistance - and held there.', 80, params=SW),
    'P17': _sp(['A P18 break of a descending trendline, then within 15 candles the first candle whose low comes back to within 1 % '
                'above the line (or under it), closing above it - a close under the line first = failed.',
                'Signal = that candle; stop reference = its low.'],
               'Price broke a falling trendline, came back to it and held above it.', 90, params=SW),
    'P18': _sp(['A descending line through the two latest known swing highs (the 2nd lower), extended to today.',
                'Signal: the first close above the line within 60 candles of the 2nd high, the close before not above it.',
                'Stop reference = the lowest low since the 2nd high; trigger = the line\'s value on the signal candle.'],
               'Price closed above a falling trendline drawn through the last two lower highs.', 90, params=SW),
    'P19': _sp(['The 10 candles before: range (highest high - lowest low) at most half the range of the 30 candles before those.',
                'Signal: a fresh close above the highest high of those 10 candles.',
                'Stop reference = the lower of their lowest low and the signal candle\'s low; trigger = their high.'],
               'Price narrowed into a tight range and then broke out of it.', 41),
    'P20': _sp(['c1 = the mother candle, c2 inside it (high <= c1 high, low >= c1 low), c1 itself not inside the candle before it '
                '(exactly one inside candle - B10 takes 2 to 10).', 'Signal: c3 closes above c1\'s high.',
                'Stop reference = the lower of c2\'s and c3\'s lows; trigger = c1\'s high.'],
               'One quiet inside candle, then a close above the mother candle\'s high.', 4),
    'P21': _sp(['c2\'s high above c1\'s high and its low under c1\'s low (an outside candle), green, closing above c1\'s high.',
                'After a fall: c1\'s close under the close 5 candles before it.', 'Stop reference = c2\'s low.'],
               'After a fall, one candle went under the previous low and then closed above the previous high.', 7, True),
    'P22': _sp(['4 closes in a row, each above the close before (the first candle where this is true - not the 5th, 6th ...).',
                'Stop reference = the lowest low of the 4 rising candles.'],
               'Four higher closes in a row - steady buying.', 5),
    'P23': _sp(['The 10 candles before the signal: range (highest high - lowest low) at most 2 x ATR(14) before them.',
                'The signal candle: range >= 1.5 x that ATR, green, closing above those 10 candles\' high.',
                'Stop reference = its low; trigger = the box high.'],
               'After a tight sideways box, one wide green candle broke out of it.', 26),
    'P24': _sp(['A swing low L2 becomes known lower than the swing low before it (L1) - a lower low.',
                'The fall into L2 (from the highest high between L1 and L2) is less than 70 % of the fall into L1 (from the swing '
                'high before L1).', 'Signal when L2 becomes known; stop reference = L2\'s low; the ratio of the two falls kept.'],
               'Price still made a lower low, but the last fall was much shorter than the one before - the sellers are tiring.',
               80, True, params=SW),
    # S. smart money / ICT
    'S01': _sp(['The sell-side pool = the lowest of the last 3 known swing lows.',
                'A candle\'s low goes at least 0.1 x ATR under it and the candle closes back above it; the first candle under the '
                'pool decides.', 'Stop reference = the candle\'s low.'],
               'Price ran the stops under the lowest of the recent swing lows and closed back above them.', 40, True, SMC, SW),
    'S02': _sp(['Equal lows = two of the last three known swing lows within 0.25 x ATR(14) (at the newer one) - the newest such '
                'pair; level = the lower of the two.',
                'The first candle under the level decides: closing back above it = the signal (else taken).',
                'Stop reference = its low.'],
               'Two nearly equal lows attract stop orders; price swept under them and closed back above.', 40, True, SMC, SW),
    'S03': _sp(['The previous day\'s low (from the candles\' dates; on daily candles = the candle before).',
                'The first candle of the day that goes under it decides: closing back above it, green = the signal.',
                'Daily and 4-hour candles only. Stop reference = the candle\'s low; the level kept.'],
               'Price went under yesterday\'s low and closed back above it.', 2, True, SMC),
    'S04': _sp(['The previous week\'s low (weeks start on Monday; on weekly candles = the candle before).',
                'The first candle of the week that goes under it decides: closing back above it, green = the signal.',
                'Daily, 4-hour and weekly candles. Stop reference = the candle\'s low.'],
               'Price went under last week\'s low and closed back above it.', 10, True, SMC),
    'S05': _sp(['The previous calendar month\'s low.',
                'The first candle of the month that goes under it decides: closing back above it, green = the signal.',
                'Daily, 4-hour and weekly candles. Stop reference = the candle\'s low.'],
               'Price went under last month\'s low and closed back above it.', 45, True, SMC),
    'S06': _sp(['As P09, but the dip goes at least 0.5 x ATR under the latest known swing low before the close back above it.'],
               'A deep stop-run: price dropped well under the last swing low and still closed back above it.', 30, True, SMC, SW),
    'S07': _sp(['Major swings = patSwing candles each side, minor swings = 2 candles each side.',
                'A sweep of the latest major swing low (low under it, close back above; the first candle under it decides).',
                'Before it, a minor swing low above the major one (formed after it) was taken out - the inducement.',
                'Signal = the sweep candle; stop reference = its low.'],
               'Price first took out a small, tempting low (the inducement), then swept the real swing low and closed back above '
               'it.', 40, True, SMC, SW),
    'S08': _sp(['Displacement = a green candle with body >= 1.5 x ATR whose close breaks the latest known swing high (the close '
                'before was not above it).', 'Order block = the last red candle of the 10 before it (each candle once).',
                'Signal: the first candle after the displacement whose low reaches the block\'s high, closing above the block\'s '
                'low, within 50 candles.',
                'Stop reference = the lower of the block\'s low and that candle\'s low; trigger = the block\'s high; block size % kept.'],
               'The last down candle before a strong move up (the order block); price came back to it and held.', 60, False, SMC,
               SW),
    'S09': _sp(['Two known swing lows, the 2nd lower (a lower low). Breaker = the last green candle among the 5 up to the highest '
                'candle between them.',
                'A close above the breaker\'s high within 60 candles of the 2nd low; then, once the 2nd low is known, the first '
                'candle whose low comes back to the breaker\'s high within 30 candles of that close (a close under the breaker\'s '
                'low first ends it).', 'Signal = that candle; stop reference = the lower of the breaker\'s low and that low.'],
               'The last up candle before a lower low was broken upward; price came back to it and held - a breaker block.', 120,
               False, SMC, SW),
    'S10': _sp(['As S09, but the 2nd swing low is HIGHER than the 1st (no lower low).'],
               'As the breaker block, but without a lower low - a mitigation block.', 120, False, SMC, SW),
    'S11': _sp(['A known swing low candle with a lower shadow >= 60 % of its range and range >= 1 x ATR; zone = its low up to its '
                'body bottom.',
                'Once the swing is known, the first candle within 50 candles whose low reaches the zone top, closing above the '
                'wick\'s low.', 'Stop reference = the lower of the wick\'s low and that candle\'s low.'],
               'A long lower wick at a swing low marks where buyers rejected the price; price came back into that wick and held.',
               60, False, SMC, SW),
    'S12': _sp(['A bullish FVG (the zones rule of the shared definitions).', 'Signal: its first touch within 100 candles.'],
               'Price came back to a fair value gap left by a quick move up and held above its bottom.', 103, False, SMC),
    'S13': _sp(['A bullish FVG; level = its middle (the consequent encroachment).',
                'Signal: the first candle within 100 candles whose low reaches the middle, closing above the bottom (a close under '
                'the bottom first ends it).'],
               'Price filled half of a fair value gap and held.', 103, False, SMC),
    'S14': _sp(['A bearish FVG (the 3rd candle\'s high under the 1st candle\'s low, gap >= 0.1 x ATR).',
                'Signal: the first close above its top within 50 candles - the gap turned into support.',
                'Stop reference = the lower of its bottom and the candle\'s low; trigger = its top.'],
               'Price closed back above a downward gap - an inverse fair value gap.', 53, False, SMC),
    'S15': _sp(['One green candle with body >= 2 x ATR, closing in the top 20 % of its range (CLV >= 0.6).',
                'Stop reference = its low.'],
               'One very large green candle closing near its high - displacement.', 15),
    'S16': _sp(['As S12, only for FVGs whose middle candle is a green displacement (body >= 1.5 x ATR).'],
               'A fair value gap left by a strong candle; price came back to it and held.', 103, False, SMC),
    'S17': _sp(['A P06 CHoCH whose final low swept the swing low known before it: went under it and closed back above it within 2 '
                'candles (not after the CHoCH).', 'The CHoCH within 10 candles of the final low.',
                'Signal = the CHoCH close; stop reference = the final low.'],
               'Price swept a swing low and quickly turned the structure up with a change of character.', 80, False, SMC, SW),
    'S18': _sp(['An uptrend: the latest known swing low above the one before.',
                'A sweep candle: low under the latest swing low, close back above (the first candle under it decides).',
                'Within 10 candles a close above the latest known swing high (as at the sweep), no low under the sweep\'s low in '
                'between.', 'Signal = that close; stop reference = the sweep\'s low.'],
               'In an uptrend, price swept a swing low and then broke the swing high - liquidity taken, structure continued.', 60,
               False, SMC, SW),
    'S19': _sp(['As S08, only for displacements that left an FVG (the candle after\'s low above the candle before\'s high); the '
                'touch counted from 2 candles after the displacement.'],
               'An order block whose move up also left a fair value gap - two reasons on one level.', 60, False, SMC, SW),
    'S20': _sp(['As S09, only when the 2nd low\'s candle closed back above the 1st low (the lower low was a sweep).'],
               'A breaker block whose lower low was a stop-run.', 120, False, SMC, SW),
    'S21': _sp(['Range = the latest known swing high and the lowest low since it, at least 3 x ATR (before the high).',
                'Signal: a green candle closing above the previous candle\'s high, still in the lower half of the range (discount), '
                'with it or the candle before dipping into the lowest quarter. Once per swing high.',
                'Stop reference = the lower of the two lows; % down the range kept.'],
               'Price fell from the top half of its range into the cheap half and turned up there.', 80, False, SMC, SW),
    'S22': _sp(['A P06 CHoCH. A bullish FVG formed after its final low (3rd candle from 2 candles after the final low to 20 after '
                'the CHoCH), its bottom above the final low.',
                'The first touch after the CHoCH, closing above the bottom, while the zone\'s middle is in the discount half of the '
                'move (the final low up to the highest high since it). A zone touched before the CHoCH is used up.',
                'Within 60 candles of the CHoCH; a close under the final low ends it; one signal per CHoCH.',
                'Stop reference = the lower of the zone bottom and the touch candle\'s low; the zone\'s depth % kept.'],
               'After a change of character, price came back to a fair value gap in the cheap half of the move.', 140, False,
               SMC + "; the owner's full rules = Lab 'My CHoCH + FVG setup'", SW),
    'S23': _sp(['A bearish FVG and, within 20 candles after it, a bullish FVG overlapping it; the balanced price range = the '
                'overlap (with the newest bearish FVG before).',
                'Signal: the first touch of the overlap within 50 candles, closing above its bottom.'],
               'A down-gap and an up-gap overlapped; price came back to the overlap and held.', 75, False, SMC),
    'S24': _sp(['An S08 order block closed under (a close under its low within 50 candles of the displacement).',
                'Within 30 candles a close back above its high = the signal.',
                'Stop reference = the lowest low since the break; trigger = the block\'s high.'],
               'An order block broke down, then price reclaimed it by closing back above it.', 140, False, SMC, SW),
    'S25': _sp(['A bullish FVG at least 1 x ATR big, its 3rd candle closing above the 2nd candle\'s close.',
                'Signal on the 3rd candle (the imbalance itself); stop reference = the gap bottom (the 1st candle\'s high); '
                'trigger = the 3rd candle\'s high.'],
               'A very large up-gap between candles - price repriced higher at once.', 18, False,
               'a definition to agree - this version: an FVG >= 1 x ATR'),
    # V. volume (the rest)
    'V09': _sp(['Three consecutive known swing lows rising, the first and last at most 120 candles apart, and OBV rising at the '
                'same candles.', 'Signal when the 3rd swing low becomes known; stop reference = its low.'],
               'Higher lows with on-balance volume rising at each - quiet accumulation.', 130, params=SW),
    'V10': _sp(['Relative volume >= 2, range <= 0.7 x ATR, the low within 1 % above the latest known swing low (or under it), the '
                'close at or above it, CLV >= 0 - once per swing low.', 'Stop reference = the candle\'s low.'],
               'Heavy volume but a narrow candle at support - selling absorbed (a proxy - no order-book data).', 30, True,
               'a proxy - no order-book data', SW),
    'V11': _sp(['Price makes a lower swing low while the Chaikin A/D line makes a higher one (the divergence rule of the shared '
                'definitions).'],
               'Price made a lower low but the accumulation / distribution line made a higher low - hidden buying.', 60, params=DV),
    'V14': _sp(['In a fall: the close under its 20-SMA and under the close 5 candles before.',
                'That candle: relative volume >= 2 but range <= 0.6 x ATR - big effort, small result.',
                'The next candle closes above its high = the signal; stop reference = the lower of the two lows.'],
               'Heavy selling volume moved the price very little, and the next candle went above it.', 22, True),
    'V16': _sp(['A red candle with body >= 0.7 x ATR and relative volume >= 2.',
                'Within 3 candles a close above its high = the signal; stop reference = the lowest low since it.'],
               'A heavy red selling candle was fully reversed within 3 candles - the selling pressure failed.', 22, True),
    # I. momentum
    'I02': _sp(['Price makes a HIGHER swing low while RSI(14) makes a LOWER one (the divergence rule of the shared definitions).',
                'At the signal the close is above its 50-SMA (an uptrend).'],
               'In an uptrend price held a higher low while RSI dipped lower - a hidden bullish divergence (trend continuation).',
               60, params=DV),
    'I03': _sp(['RSI(14) under 30, back above 30 (its peak = the failure level), a pullback that stays above 30, then RSI above '
                'that peak - all within 40 candles of the first dip under 30.',
                'Stop reference = the lowest low since the pullback started.'],
               'Wilder\'s failure swing: RSI came out of oversold, pulled back without going oversold again, then broke its '
               'own peak.', 55, True),
    'I04': _sp(['RSI(14) crosses above 50, having been under 40 within the 10 candles before.', 'Stop = the last 10 lows.'],
               'RSI climbed from weak (under 40) back above 50.', 25),
    'I05': _sp(['RSI(14) crosses above 30.', 'Stop = the last 10 lows.'], 'RSI came back up out of the oversold area.', 25, True),
    'I06': _sp(['The MACD line crosses above its signal line while both are under 0.', 'Stop = the last 10 lows.'],
               'MACD turned up below the zero line - an early momentum turn.', 40),
    'I07': _sp(['The MACD line crosses above 0.', 'Stop = the last 20 lows.'],
               'The MACD line went above zero - the short average rose above the long one.', 40),
    'I08': _sp(['Price makes a lower swing low while the MACD line makes a higher one, the MACD line under 0 at the first low.'],
               'Price made a lower low but MACD made a higher low - a bullish divergence.', 60, params=DV),
    'I09': _sp(['Stochastic %K crosses above %D with both under 20 on the candle before.', 'Stop = the last 10 lows.'],
               'The stochastic lines crossed up in the oversold area.', 25, True),
    'I10': _sp(['Stochastic %K crosses above 20.', 'Stop = the last 10 lows.'], 'The stochastic came back up out of oversold.',
               25, True),
    'I11': _sp(['CCI(20) crosses above -100.', 'Stop = the last 10 lows.'], 'CCI came back up from its oversold area.', 25, True),
    'I12': _sp(['Price makes a lower swing low while MFI(14) makes a higher one.'],
               'Price made a lower low but the money flow index made a higher low.', 60, params=DV),
    'I13': _sp(['OBV above its highest value of the 50 candles before (the candle before was not), the close above its 20-EMA.',
                'Stop reference = the candle\'s low.'],
               'On-balance volume reached a 50-candle high - volume is flowing in.', 52),
    'I14': _sp(['Price makes a lower swing low while OBV makes a higher one.'],
               'Price made a lower low but on-balance volume made a higher low.', 60, params=DV),
    'I15': _sp(['ADX(14) crosses above 25 with +DI above -DI.', 'Stop = the last 10 lows.'],
               'A trend is getting stronger (ADX above 25) and it is an up trend (+DI above -DI).', 40),
    'I16': _sp(['ROC(12) crosses above 0, having been at or under -5 % within the 20 candles before.', 'Stop = the last 20 lows.'],
               'The 12-candle change turned positive after a fall of 5 % or more.', 35, True),
    'I17': _sp(['TSI crosses above its signal line while TSI is under 0.', 'Stop = the last 10 lows.'],
               'The true strength index turned up below zero.', 50),
    'I18': _sp(['Aroon up crosses above Aroon down, Aroon up at least 50.', 'Stop = the last 10 lows.'],
               'Recent highs became more recent than recent lows - the Aroon lines crossed up.', 30),
    'I19': _sp(['The Parabolic SAR flips to bullish (a high above the SAR).',
                'Stop reference = the new SAR (the lowest low of the fall) or the candle\'s low if lower.'],
               'Parabolic SAR flipped under the price - the down trend ended.', 30, True),
    'I20': _sp(['The close before under the lower Bollinger Band, this close back above it, green.', 'Stop = the last 2 lows.'],
               'Price closed outside the lower band and came straight back inside.', 22, True),
    'I21': _sp(['The close crosses above the middle band (20-SMA) after 5 closes under it, still under the upper band.',
                'Stop = the last 6 lows.'],
               'Price got back above its 20-average (the Bollinger middle band) after a week under it.', 26),
    'I22': _sp(['3 closes in a row at or above the upper Bollinger Band (the first time - the close 3 candles before was not).',
                'Stop = the last 3 lows.'],
               'Price kept closing on the upper band - walking the band, a strong trend.', 24),
    'I23': _sp(['The RS ratio (the stock\'s close / NIFTY 50\'s) above its highest value of the 50 candles before (the candle '
                'before was not), and the close above the highest high of the 20 candles before.',
                'Stop reference = the candle\'s low; ratio / its old high kept.'],
               'The stock broke out against NIFTY 50 and on its own chart at the same time.', 52, note='needs the NIFTY 50 candles on the laptop'),
    'I24': _sp(['The RS ratio above its highest value of the year before (D 252, W 52, 4H 504 candles; the candle before was '
                'not), while the close is still under its own high of that year - relative strength leads price.',
                'Stop = the last 10 lows.'],
               'Against NIFTY 50 the stock is at a new 1-year high before its own price is.', 505,
               note='needs the NIFTY 50 candles on the laptop'),
    # Q. quantitative / statistical
    'Q01': _sp(['The close before at least 2 standard deviations under its 20-SMA (z-score <= -2).',
                'The signal candle: green, closing above that candle\'s high, above the 200-SMA.', 'Stop = the last 2 lows.'],
               'A statistically oversold dip in a long-term uptrend, then a strong up candle.', 200),
    'Q02': _sp(['The 50-candle z-score crosses back above -2.', 'Stop = the last 5 lows.'],
               'Price came back from more than 2 standard deviations under its 50-average.', 52, True),
    'Q03': _sp(['%B crosses above 0.5 (the middle band) having been under 0 within the 5 candles before.', 'Stop = the last 6 lows.'],
               'From outside the lower band to above the middle band within a few candles.', 26, True),
    'Q04': _sp(['Over the last 20 candles the regression slope of the close is negative while the slope of RSI(14) is positive - '
                'the first candle where both are true, with RSI under 50.', 'Stop = the last 20 lows.'],
               'Price trended down while RSI trended up - a statistical divergence.', 40, True),
    'Q05': _sp(['ATR(14) of the candle before at or below its 10th percentile of the 126 candles before it.',
                'The signal candle: true range >= 2 x that ATR, green, close in the upper half (CLV >= 0).',
                'Stop reference = its low.'],
               'Volatility shrank to a 6-month low, then one wide green candle - expansion.', 140),
    'Q06': _sp(['The standard deviation of the last 20 returns (as of the candle before) at or below its 20th percentile of the '
                '126 before.', 'A fresh close above the highest high of the 20 candles before.', 'Stop reference = its low.'],
               'A calm period (low volatility) ended with a breakout.', 170),
    'Q07': _sp(['5 lower closes in a row, then a close above the previous candle\'s high.', 'Stop = the last 6 lows.'],
               'Five down closes in a row, then a strong up close - exhaustion.', 7, True),
    'Q08': _sp(['A red candle with body >= 2 x ATR.', 'Within 3 candles a close above the middle of its body.',
                'Stop reference = the lowest low since it.'],
               'A very large red candle was half recovered within 3 candles.', 18, True),
    'Q09': _sp(['Range >= 1 x ATR, green, the open in the lowest 30 % of the range, the close in the top 20 % (CLV >= 0.6) and '
                'above the previous close.', 'Stop reference = its low.'],
               'The candle opened weak, near its low, and closed strong, near its high.', 15, True),
    'Q10': _sp(['ROC(10) at least 5 points higher than 5 candles before, while it was already above 0 then (the first candle).',
                'Stop = the last 10 lows.'],
               'Momentum is rising faster - the 10-candle change is accelerating.', 16),
    'Q11': _sp(['ROC(10) fell into candle i-2 (at or under -5 %) and rose on the two candles after it.', 'Stop = the last 10 lows.'],
               'The 10-candle change turned up from a deep low.', 15, True),
    'Q12': _sp(['The RSI(14) of the last FINISHED higher candle (daily -> weekly, weekly -> monthly, 4-hour -> daily) above 50, '
                'and the candle\'s own RSI(14) crosses above 50.', 'Stop = the last 10 lows.'],
               'Momentum agrees on two timeframes: the higher timeframe RSI above 50 and this one crossing above 50.', 300),
    'Q13': _sp(['The RS ratio (vs NIFTY 50) up at least 10 % over 63 candles, and a fresh close above the highest high of the 50 '
                'candles before.', 'Stop reference = the candle\'s low.'],
               'A stock that has beaten NIFTY 50 by 10 % in 3 months broke out to a 50-candle high.', 64,
               note='needs the NIFTY 50 candles on the laptop'),
    'Q14': _sp(['A fresh close above the highest high of the 20 candles before, with no such close in the 60 candles before.',
                'Stop reference = the candle\'s low.'],
               'The first 20-candle breakout after a quiet period - a possible new trend (Donchian).', 81),
    'Q15': _sp(['Close above its 50-SMA, the 50-SMA above the 200-SMA and above its value 10 candles before.',
                'The close before at least 1.5 standard deviations under its 20-SMA (z <= -1.5); the signal closes above that '
                'candle\'s high.', 'Stop = the last 2 lows.'],
               'A sharp, statistically deep pullback inside a healthy uptrend, then a strong close.', 210),
    'Q16': _sp(['The return at least 2 x the standard deviation of the 20 returns before (and up), relative volume >= 2.',
                'Stop reference = the candle\'s low.'],
               'An unusually big up move on unusually big volume.', 22),
    'Q17': _sp(['The 10-candle average range (as % of the close) at or below its 10th percentile of the 126 before (as of the '
                'candle before).',
                'The signal candle: range >= 2 x that average, green, close in the top third (CLV >= 0.33), above the 10-candle '
                'high.', 'Stop reference = its low.'],
               'Candles had become very small; then a wide green candle broke the 10-candle high.', 140),
    'Q18': _sp(['Close above its 50-SMA above the 200-SMA, ROC(63) at least 20 %, and a fresh close above the 10-candle high.',
                'Stop = the last 5 lows.'],
               'A stock already up 20 % in 3 months made a new 10-candle high - momentum continuing.', 200),
    'Q19': _sp(['RSI(14) crosses under 30, then within 3 candles back above 40.', 'Stop reference = the lowest low since.'],
               'RSI broke into oversold and was back above 40 within 3 candles - the breakdown failed.', 20, True),
    'Q20': _sp(['Five factors: close above its 50-SMA, 50-SMA above 200-SMA, RSI(14) above 50, MACD above its signal, relative '
                'volume >= 1.2.', 'Signal when 4 or 5 are true and fewer than 4 were on the candle before; the score kept.',
                'Stop = the last 10 lows.'],
               'Trend, momentum and volume agree at once (4 of 5 factors).', 200,
               note='a combination - a full combination engine is phase 5'),
    # M. moving averages (the rest)
    'M13': _sp(['A fresh close above the Ichimoku cloud top (the higher of span A and span B as drawn at that candle).',
                'Stop reference = the candle\'s low; trigger = the cloud top.'],
               'Price closed above the Ichimoku cloud.', 80),
    'M14': _sp(['The tenkan-sen (9) crosses above the kijun-sen (26).', 'Stop = the last 10 lows.'],
               'The fast Ichimoku line crossed above the slow one.', 30),
    'M15': _sp(['Span A crosses above span B as computed on the candle (the cloud ahead turns bullish).', 'Stop = the last 10 lows.'],
               'The Ichimoku cloud ahead turned from red to green.', 55),
    'M17': _sp(['Anchored VWAP from the latest known swing high: the typical price (high + low + close) / 3 x volume summed from '
                'that candle / the volume summed.',
                'Signal: the close crosses above it within 60 candles of the high (once per anchor).',
                'Stop reference = the lowest low since the high; trigger = the anchored VWAP.'],
               'Price got back above the average price paid by everyone who bought since the last swing high.', 70, False,
               'a daily typical-price proxy (no intraday volume profile)', SW),
    'M18': _sp(['EMA 10, 20 and 50 within 1.5 % of the close of each other on each of the 3 candles before.',
                'The signal: green, closing above all three EMAs and above those 3 candles\' highs (the first candle).',
                'Stop = the last 4 lows.'],
               'The short, medium and long EMAs squeezed together; then price broke up out of the squeeze.', 54),
}
SPECS.update(P3)
WORDS_M1 = {
    'K08': 'A red candle was followed by a bigger green candle whose body covered all of the red body - buyers took over the '
           'whole of the day before. The stop goes under the lower of the two lows.',
    'B01': 'The close went above the highest high of the 20 candles before it, for the first time - a fresh 20-candle breakout.',
    'B02': 'The close went above the highest high of the 50 candles before it, for the first time - a fresh 50-candle breakout.',
    'B03': 'The close went above the highest high of the 52 weeks before it, for the first time - a fresh 52-week high.',
    'B04': 'The close went above every high since the history starts (20 years or the listing) - an all-time high.',
    'I01': 'Price made a lower swing low but RSI made a higher low - the fall was losing strength (a bullish divergence). The '
           'signal came only when the second low was confirmed by the candles after it, never on the low itself.',
}
for _k, _w in WORDS_M1.items():
    SPECS[_k]['words'] = _w
SPECS['K08']['ctx'] = True
SPECS['K08']['note'] = SHEET


def entries():
    """Every registry entry as a dict, in catalogue order."""
    out = []
    for pid, name, fam, st, needs, note in _ROWS:
        sp = SPECS.get(pid)
        if sp:
            st = 'implemented'                       # built in the engine (a SPECS entry with rules + a detector)
            note = sp.get('note', note)
        e = {'id': pid, 'name': name, 'category': pid[0], 'categoryName': CATEGORIES[pid[0]], 'family': fam, 'status': st,
             'statusName': STATUS_NAMES[st], 'needs': needs, 'note': note,
             'timeframes': ['15m'] if pid == 'B15' else list(D3)}
        if sp:
            e.update({'version': sp['version'], 'lookback': sp['lookback'], 'params': sp['params'], 'rules': sp['rules'],
                      'words': sp.get('words', ''), 'ctx': bool(sp.get('ctx'))})
        out.append(e)
    return out


def implemented():
    return [e['id'] for e in entries() if e['status'] == 'implemented']


def by_id():
    return {e['id']: e for e in entries()}


def as_json():
    return json.dumps({'version': VERSION, 'categories': CATEGORIES, 'statusNames': STATUS_NAMES, 'common': COMMON, 'patterns': entries()},
                      ensure_ascii=False, indent=1, sort_keys=False)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'json':
        sys.stdout.write(as_json() + '\n')
    else:
        es = entries()
        print('%d entries (%d of the master prompt)' % (len(es), sum(1 for e in es if e['category'] != 'X')))
