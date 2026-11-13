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

VERSION = 1
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


def entries():
    """Every registry entry as a dict, in catalogue order."""
    out = []
    for pid, name, fam, st, needs, note in _ROWS:
        e = {'id': pid, 'name': name, 'category': pid[0], 'categoryName': CATEGORIES[pid[0]], 'family': fam, 'status': st,
             'statusName': STATUS_NAMES[st], 'needs': needs, 'note': note,
             'timeframes': ['15m'] if pid == 'B15' else list(D3)}
        sp = SPECS.get(pid)
        if sp:
            e.update({'version': sp['version'], 'lookback': sp['lookback'], 'params': sp['params'], 'rules': sp['rules']})
        out.append(e)
    return out


def implemented():
    return [e['id'] for e in entries() if e['status'] == 'implemented']


def by_id():
    return {e['id']: e for e in entries()}


def as_json():
    return json.dumps({'version': VERSION, 'categories': CATEGORIES, 'statusNames': STATUS_NAMES, 'patterns': entries()},
                      ensure_ascii=False, indent=1, sort_keys=False)


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'json':
        sys.stdout.write(as_json() + '\n')
    else:
        es = entries()
        print('%d entries (%d of the master prompt)' % (len(es), sum(1 for e in es if e['category'] != 'X')))
