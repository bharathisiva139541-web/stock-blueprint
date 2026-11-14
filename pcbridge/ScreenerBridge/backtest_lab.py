# -*- coding: utf-8 -*-
"""Backtest Lab - the owner's own trade rules on the long Kite history (owner, 09-Nov-2026: "I need a platform to backtest
with my customized idea ... I place stoploss slightly below the FVG area ... if I take a trade I have minimum 2R; if the
stoploss hits the trade is a loss; if the trade hits 2R I don't close it, I try to catch the maximum move within weeks. So
days, stoploss, risk, returns all should be customizable ... make a separate page for backtest"; choices: the website /
app page, this laptop computes; after 2R: the stop moves to the entry, then trails under the lowest low of the last 2
candles - a break of it = exit).

How it works:
 - The daily backtest pass (kite_intraday.backtest_now = BacktestNow.bat, and the daily scan) keeps, per timeframe
   (D / W / 4H), every stock's candles in one compact file (lab_cache/<build>/<tf>.bin: float32 open / high / low /
   close + the day + the minute) and every signal with its zone (signals.json.gz): 'F' = FVG+Spring (3-candle FVG
   zone), 'G' = Gap-up FVG + Spring (+ inside FVG), 'S' = every Spring (no zone), 'T' / 'C' = FVG First Touch /
   Confirmed (the newest FVG), 'Z' / 'Y' = the first touch of EVERY FVG / Gap-up zone (11-Nov-2026). 4H: only the 13:15
   candle's Springs (the owner's 4H rule), like the daily backtest; the touches on every 4H candle.
 - The website's Backtest Lab page (owner only, behind the PIN) saves a job in the sheet; the background program asks for
   it (LabWorker, every 10 s while the page is open, else every 2 minutes), runs it here on those files (seconds) and
   sends the summary + the trade list back. No candles leave this computer.
 - The rules (run_job / simulate): entry = the Spring candle's close (or the next candle's open); stop = under the zone
   bottom / the Spring low / the lower of the two / x % under the entry, with a buffer %; trades whose risk is more than
   `maxRisk` % are skipped; target = entry + targetR x risk - then 'fixed' (sell there) or 'trail' (stop to the entry,
   then under the lowest low of the last N candles, x % under the highest high, or a close under the N EMA); at most
   `maxDays` calendar days, then sold at that day's close; a candle reaching both the stop and the target = the stop
   (conservative); a gap through the stop = sold at the open. Costs % per round trip. The account: capital, risk % per
   trade, a position at most `maxPosPct` % of the capital, at most `maxOpen` trades at once (later signals skipped).
 - Hard Spring rules (10-Nov-2026): `spring_feats` / `shape_check` - the pattern's own rule stays the base, a run may
   only tighten it (wicks, body, colour, the dip, the close, the red candle, a swing low taken out, a fall before).
"""
import array
import bisect
import re
import gzip
import heapq
import json
import math
import os
import shutil
import statistics
import sys
import threading
import time
from datetime import date, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
if HERE not in sys.path:
    sys.path.insert(0, HERE)
import structure  # noqa: E402  (market structure: CHoCH / BOS - owner, 10-Nov-2026)
import pattern_detect  # noqa: E402  (the bullish pattern engine - owner, 13-Nov-2026; docs/PATTERN_ENGINE_PLAN.md)
import pattern_registry  # noqa: E402
import pattern_p3  # noqa: E402  (phase 3 detectors - NEEDS_BENCH)
import ltf_data  # noqa: E402  (the 1-hour / 15-minute candle files - the lower-timeframe confirmation, 13-Nov-2026)

LAB_DIR = os.path.join(HERE, 'lab_cache')
CHARTS_DIR = os.path.join(HERE, 'lab_charts')   # the runs' chart PDFs (lab_charts.py; owner, 12-Nov-2026)
LTF_DIR = os.path.join(HERE, 'intraday_data', 'ltf')   # kite_intraday's 1-hour / 15-minute files (ltf_data.py)
TFS = ('D', 'W', '4H')
CACHE_VERSION = 6               # 2 (10-Nov-2026): FVG First Touch / Confirmed rows + the zone's candle in every row;
                                # 3 (11-Nov-2026): the first touch of every FVG / Gap-up zone ('Z' / 'Y');
                                # 4 (12-Nov-2026): each candle's volume too (the CHoCH candle's volume rule, E10)
                                # 5 (12-Nov-2026): zone touch rows carry the Gap-up zone inside an FVG / the FVG around a
                                #   Gap-up zone; 'P' / 'Q' rows = a Spring / Bullish Harami + Inverted Hammer inside a zone
                                # 6 (12-Nov-2026): 'V' rows = the zones price never came back to (the 2nd-zone rule needs
                                #   every zone of a CHoCH move, touched or not)
MAX_TRADES_OUT = 3000           # the trade list sent to the sheet (newest first); the figures use every trade
CURVE_POINTS = 360              # the equity curve sent (thinned)
POLL_SLOW_S = 120               # the background program asks the sheet for a job this often ...
POLL_FAST_S = 10                # ... and this often while the page is open (the sheet says which)
BUILD_SAY_S = 30                # while the candle cache is made: its progress to the sheet at most this often
log = print                     # screener_bridge sets its own

# ------------------------------------------------------------------ the rules a run may set (and their limits)
DEFAULTS = {
    'tf': 'D', 'group': 'fvg', 'from': '', 'to': '', 'minPrice': 0.0, 'minTurnover': 0.0, 'maxTouch': 0,
    'entry': 'close',
    'stop': 'zone', 'stopBuf': 0.5, 'stopPct': 5.0, 'maxRisk': 15.0,
    'targetR': 2.0, 'after': 'trail', 'breakeven': True, 'trail': 'lows', 'trailN': 2, 'trailPct': 8.0, 'emaN': 20,
    'maxDays': 60, 'cost': 0.2,
    'capital': 1000000.0, 'riskPct': 1.0, 'maxPosPct': 25.0, 'maxOpen': 10, 'compound': False,
    # EMA confluence (owner, 09-Nov-2026: "I don't enter the trade blindly seeing FVG+Spring ... I see EMA (10, 21, 50) -
    # if price is taking support at 10 EMA, I believe the stock will go upward"): on the Spring candle -
    # emaSupport 0 off / 10 / 21 / 50 / 1 = any of them: its low came to (or within emaTouch % above) that EMA and it
    # closed at / above it; aboveNN = it closed above that EMA; emaStack = 10 EMA > 21 EMA > 50 EMA (an uptrend)
    'emaSupport': 0, 'emaTouch': 1.0, 'above10': False, 'above21': False, 'above50': False, 'emaStack': False,
    # market condition (owner, 09-Nov-2026: "I see the market condition" -> "yes ... why only Nifty50, you can add other
    # indices also"): mktIndex = an index name with underscores ('NIFTY_50', '' = off); on the signal's day its daily
    # close above its mktAbove EMA (0 off / 10 / 21 / 50 / 100 / 200) and / or its 10 > 21 > 50 EMA (mktStack)
    'mktIndex': '', 'mktAbove': 0, 'mktStack': False,
    # HARD SPRING RULES (owner, 10-Nov-2026: "in our spring, sometimes c2 looks like a doji ... you should make hard rules for
    # spring ... upperwick of c2 should be very negligible or no upperwick ... give more options to define spring and add
    # your recommendations"): the pattern's own rule (Code.gs ab_isSpringPair_: c1 red with a body of 0.5 %, c2 under c1's low
    # by 0.10 % and closing above it, c2's body under 30 % of c1's, c2's high at most half of c1's range above c1's low)
    # stays the base - these only TIGHTEN it, per Spring pair (c1 = the candle before, c2 = the Spring candle). All at their
    # base value = no shape rule. Wicks / body / close position are % of c2's own high-low range.
    'upWickMax': 100.0,        # c2's upper wick at most X % of its range (0 = none at all)
    'loWickMin': 0.0,          # c2's lower wick at least X % of its range (a hammer / pin bar)
    'closeMin': 0.0,           # c2 closed in the top X % of its range (position of the close from its low)
    'c2BodyMin': 0.0,          # c2's body at least X % of its range - not a doji
    'c2Color': 'any',          # c2 closed green (above its open) / red / any
    'c2BodyMax': 30.0,         # c2's body at most X % of c1's body (the pattern allows 30)
    'undercutMin': 0.1,        # c2's low at least X % under c1's low (the pattern allows 0.10)
    'undercutMax': 0.0,        # ... and at most X % under it (0 = no limit): a far deeper dip is a breakdown
    'undAtr': 0.0,             # c2's low under c1's low by at least X x ATR(14) (0 = off) - the same on every price / timeframe
    'closeAbove': 0.0,         # c2 closed at least X % above c1's low (a close just over the line is weak)
    'recover': False,          # c2 closed above c1's CLOSE too
    'c1BodyMin': 0.5,          # c1 (the red candle): body at least X % of its open (the pattern allows 0.5)
    'c1LoWickMax': 100.0,      # c1's lower wick at most X % of its range (small = it closed near its low)
    'c1Atr': 0.0,              # c1's body at least X x ATR(14) (0 = off): a big red candle for that stock
    'lowestN': 0,              # c2's low is under the lowest low of the last N candles (0 = off): a real swing low is taken out
    'fallN': 0, 'fallPct': 10.0,   # price fell at least fallPct % from the highest high of the last fallN candles to c1's close
    # MARKET STRUCTURE (owner, 10-Nov-2026 - see structure.py): structure 'off' / 'show' (each trade labelled, nothing left
    # out - the breakdown compares) / 'only' (the rules below); pivotN = candles each side of a swing, downN = lower highs and
    # lower lows before the CHoCH, zoneWhen = the zone formed after the CHoCH's final low: 'both' (in the move up to the
    # CHoCH or after it) / 'leg' (up to one candle after the CHoCH candle) / 'after' (after the CHoCH candle), belowChoch =
    # the zone's top (no zone: the entry) under the CHoCH level, firstPull = no BOS yet (the first pullback), chochAge = the
    # signal at most N candles after the CHoCH (0 = any). Target: targetMode 'R' (targetR) / 'swing' = the last swing high
    # at least swingMinR R above the entry (trades without one are skipped).
    'structure': 'off', 'pivotN': 5, 'downN': 3, 'zoneWhen': 'both', 'belowChoch': True, 'firstPull': True, 'chochAge': 0,
    'targetMode': 'R', 'swingMinR': 1.0,
    # DISCOUNT ZONE (owner, 11-Nov-2026, SUPREMEIND: "instead of taking the trade in FVG zone below the Choch, our backtest
    # took the trade above the choch. we always try to enter with low risk, i.e. the zone in discount area. it is ok even the
    # zone have some area slightly above the Choch"; answer: the zone under the 50 % line of the move): discount = the Fib
    # level the zone must reach on the move from the CHoCH's final low to its high (0 = off, 0.5 = the middle, 0.618 ...),
    # discPart = which price of the zone: 'mid' (half of it may be above the line) / 'top' (all of it under) / 'bottom'.
    # Entry 'zone' = a buy order at the zone top, filled on the first touch (first-touch signals only).
    'discount': 0.0, 'discPart': 'mid',
    # DEVELOPMENT / TEST SPLIT (owner, 12-Nov-2026, after a ChatGPT review of his run: rules picked after seeing the results
    # fit the past; "yes do it"): testFrom = a date - the trades with a signal before it are the DEVELOPMENT period (where
    # rules are looked for), the ones from it the TEST period (kept to check them); '' = off. Nothing is left out.
    'testFrom': '',
    # THE REST OF THE CHATGPT REVIEW'S EXPERIMENTS (owner, 12-Nov-2026: "Finish all the remaining updates"), each one off by
    # default (= the frozen baseline). STRUCTURE ENGINE (structure.py): swingMode 'fractal' (n candles each side) /
    # 'zigzag' (E3: a swing confirmed when price turns zzAtr x ATR), swingAtr = ATR prominence of a swing (E2, 0 off),
    # chochMode 'last' / 'protected' (E5: the CHoCH breaks the high before the lowest low), eqAtr = equal highs / lows
    # tolerance in ATR (E5, 0 off), sweep = the final low swept the swing low before it and closed back above (E5).
    'swingMode': 'fractal', 'zzAtr': 2.0, 'swingAtr': 0.0, 'chochMode': 'last', 'eqAtr': 0.0, 'sweep': False,
    # MORE FILTERS: discountMax = the zone part at most this far down the move (E6-E8 "not too deep", 0 off), lagMin = at
    # least N calendar days from the CHoCH candle to the signal (0 off), dispAtr / dispVol = the CHoCH candle's body at least
    # x ATR(14) / its volume at least x the 20-candle average (E10 displacement, 0 off), whereIn = how deep the signal
    # candle went into the zone: 'any' / 'tm' top or middle / 't' top half only (E9; not with the zone-top order - its
    # depth is known only at the close), wkAbove = the stock's last finished WEEKLY close above its 10 / 21 / 50-week EMA
    # (E11, daily / 4H runs, 0 off)
    'discountMax': 0.0, 'lagMin': 0, 'dispAtr': 0.0, 'dispVol': 0.0, 'whereIn': 'any', 'wkAbove': 0,
    # TRAILS: trail 'atr' = atrK x ATR(14) under the highest high since the entry (E15); 'swing' = under the newest swing
    # low formed since the signal (E16, the run's swing settings, stopBuf % under it)
    'atrK': 3.0,
    # VALIDATION: valFrom (with testFrom) = three parts - development / validation / test; rollYears = the figures of every
    # N-year block ("steady over time?", 0 off)
    'valFrom': '', 'rollYears': 3,
    # THE OWNER'S REFINEMENTS AFTER HIS FIRST CHARTS PDF (12-Nov-2026):
    # zoneMin / zoneMax = the FVG's size, (top - bottom) / bottom in % (0 = no limit; "there should be control in FVG % size
    # from 2% to 10%" - STUDDS 12-Jun-2026 had a 10 % zone; a Gap-up zone inside an FVG is judged by that FVG)
    'zoneMin': 0.0, 'zoneMax': 0.0,
    # stop 'final' = under the CHoCH's final low (LL) by stopBuf ("sometimes the market broke the FVG below and go near this
    # LL final low and then started to move in our direction"); a signal without a live CHoCH is skipped
    # lockTarget = once price reaches the target, the stop moves up to the target, then the trail goes on (SIGNPOST
    # 28-Mar-2025: a gap opened above the target, closed under it and later under the stop - "It should be considered as Win";
    # his answer: "Target தொட்டதும் stop = target"); a gap open above the target sells at the target the same day if it falls back
    'lockTarget': True,
    # gapEntry = an FVG zone with a Gap-up zone inside it (formed in the same move, kite_intraday.link_zones): the buy order
    # waits at the Gap-up zone's top, the stop stays under the FVG's bottom ("Actual entry should be on the Top of the Gapup
    # zone, not on the entire FVG zone"; GABRIEL 21-Nov-2007 "Entry should on Gap-up inside FVG if available")
    'gapEntry': True,
    # lineOk = a zone short of the discount level still counts when its top is at / under the CHoCH level (+ lineTol %)
    # ("Even the Zone is above 0.382 level but zone top is at equal or below the Breakout Line (Choch) or it can be very
    # slightly above the line. the Zone can be used" - SWIGGY)
    'lineOk': False, 'lineTol': 0.5,
    # fibPat = a Spring or a Bullish Harami + Inverted Hammer whose low is within fibTol % of the zone's fibLevel line (drawn
    # from the zone bottom to its top like TradingView: top - level x height) and that closes above it - buy at its close,
    # stop under the zone bottom (FINOPB 25-Apr-2025: "in this FVG, i have drawn Fibonacci, exactly 0.618 level, the price
    # respected this level and formed Spring pattern"): 'off' / 'big' = only in zones bigger than zoneMax (else
    # BIG_ZONE_PCT) - the smaller ones keep the zone-top entry / 'all' = every zone (group 'touch')
    'fibPat': 'off', 'fibLevel': 0.618, 'fibTol': 1.0,
    # darkCloud = the FVG's 3rd candle red, opening at / above the green FVG candle's close and closing under the middle of
    # its body (RTNPOWER 14-Sep-2018: "trade in this type of FVG often fails ... It should be filterable option only"):
    # 'any' / 'exclude' / 'only'
    'darkCloud': 'any',
    # zonePick (owner, 12-Nov-2026: "in the move of Choch, if there is two FVG formed ... both under 50% line" -> "No trade
    # only on 2nd FVG. 1st FVG can be watched but not to be traded"): 'second' = when the CHoCH move has two (or more)
    # discount zones, the one price reaches first (the higher) is only watched and the trade is on the next one under it (a
    # 3rd or deeper zone is not traded); a move with one discount zone trades it as before / 'every' = every zone's first
    # touch (before 12-Nov-2026). Only with structure 'only' (zone_rank).
    'zonePick': 'second',
    # moveVol / moveVolN (owner, 12-Nov-2026: "In the move of Choch, volumes are at least twice or big volumes can be seen in
    # any of the candle or multiple candles in that swing that created Choch. Add this option"): at least moveVolN candles
    # from the final low to the CHoCH candle with a volume of moveVol x the average of the 20 candles before the final low
    # (0 = off; structure 'only')
    'moveVol': 0.0, 'moveVolN': 1,
    # touchAgain (owner, 13-Nov-2026, SWIGGY: "Here 2 FVG under 50% line. 1st one is already mitigated before Choch move, we can
    # take in this FVG even if this FVG mitigated before the Choch Move"): a zone formed after the CHoCH's final low that price
    # touched on / before the CHoCH candle (while the rise was forming) and that held (no close under its bottom) counts again -
    # its first touch AFTER the CHoCH candle is a signal ('touch' group, structure 'only'; rearm_touches) and, for the 2nd-zone
    # rule, it waits under a higher zone until then
    'touchAgain': True,
    # THE OWNER'S STOP / TARGET / EXIT OPTIONS (13-Nov-2026: "in the place of stoploss, can we add stoploss ATR based. all 5
    # options with Multiples of ATR whichever is lower ... if fixed % below the entry is 5% and 2 times the ATR is 7% stoploss
    # ... our stoploss is 7%. Our exit and target system should have more options according to my setups"; answers: half at the
    # target and the rest trails, the HH-move high as the target, a fixed % profit target - 20 / 30 / 40 % -, the stop to the
    # entry at 1R, a time stop):
    # stopAtr = the stop is ALSO worked out stopAtr x ATR(14) under the entry and the LOWER price of the two is used (the wider
    # stop; 0 = off) - with every stop kind; the ATR of the signal candle (the zone-top order: of the candle before it)
    'stopAtr': 0.0,
    # targetMode 'mh' = the CHoCH move's high (HH - the move high; no live CHoCH, or under swingMinR R above the entry = no
    # trade) / 'pct' = targetPct % above the entry
    'targetPct': 20.0,
    # partialPct = at the target sell this % of the position; the rest follows "At the target" (lock / breakeven / trail); 0 off
    'partialPct': 0.0,
    # beAt = before the target, once price is beAt R above the entry the stop moves up to the entry (0 off)
    'beAt': 0.0,
    # timeN / timeR = a time stop: timeN candles after the signal candle price has not gone timeR R up (the target not reached)
    # -> sold at that candle's close (0 off)
    'timeN': 0, 'timeR': 1.0,
    # THE PATTERN LIBRARY (owner, 13-Nov-2026: the bullish pattern engine, M1 - "yes. do as per your recommendation"): group
    # 'pattern' = the signals of one registry pattern (pattern_registry.py / pattern_detect.py), found on the cached candles at
    # run time; the stop kind 'zone' = under the pattern's own stop reference (its low). Each pattern's own parameters:
    'pattern': 'K08',
    'engBody': 0.0,                      # K08: the green candle's body at least x ATR(14) (0 = off)
    'boBuf': 0.0, 'boVol': 0.0,          # B01-B04: close at least x % above the level; volume at least x the 20-candle average
    'rsiN': 14, 'divPivot': 5, 'divMaxGap': 60, 'divRsiMax': 100.0,   # I01: RSI length, swing size, lows apart, RSI at the 1st low
    # phase 2 (13-Nov-2026): a reversal pattern (registry 'ctx') only after a fall - 'down' = the candle before it closed under its
    # falling 20-SMA; 'any' = everywhere
    'patCtx': 'any',
    # phase 3 (13-Nov-2026): the swing size of the structure / SMC patterns (P / S / V09 V10 / M17) - candles each side
    'patSwing': 5,
    # BOS + FVG SETUPS (owner, 13-Nov-2026: "Shall we track BOS setup like this. like FVG Zone at discount level in the BOS
    # move ... It can be a continuous BOS in uptrend. or BOS formed after Choch"; "yes. implement all you recommendations"):
    # setup 'choch' (the CHoCH + FVG setup) / 'bos' = every structure rule above works on the BOS move instead - from the
    # BOS's higher low (where the setup dies on a close under it) to its high, the zone under the BOS level / its Fib line,
    # the first pullback = before the next BOS (structure.bos_events); bosKind 'first' = the first BOS after a CHoCH (that
    # CHoCH with >= downN lower highs / lows) / 'trend' = the later ones of an up-trend (>= upN higher highs / lows) / 'both'
    'setup': 'choch', 'bosKind': 'both', 'upN': 1,
    # LOWER-TIMEFRAME CONFIRMATION (owner, 13-Nov-2026: "i got BOS+FVG setup in a stock in Daily Timeframe. I think without
    # confimation, i should not enter the trade just by Price touching the FVG Zone ... switching the timeframe to 15 mins.
    # If any Choch has happened inside the Zone in 15 min, then i decided to buy"; answers - my recommendations: 3 candles a
    # swing, at least 2 lower highs / lows, wait at most 5 candles of the chart's timeframe, buy at the small CHoCH's close
    # (or its FVG retest), stop under its final low (or the run's own stop)): ltf 'off' / 'D' (a weekly run) / '1H' / '15m' -
    # after the zone's signal candle, the first CHoCH of that smaller timeframe (ltfPivot candles a swing, >= ltfDown lower
    # highs / lows) whose final low lies in the zone (at most ltfUnder % under its bottom) and formed from the signal candle
    # on, within ltfWait candles of the chart (the signal candle = the 1st), before a candle of the chart closed under the
    # zone; ltfEntry 'close' = at that CHoCH candle's close / 'fvg' = an order at the top of the small FVG of its move;
    # ltfStop 'ltf' = under its final low (stopBuf %) / 'rule' = the run's own stop. Every signal is also traded without it
    # - the result's 'ltf' compares both on the same signals
    # SMART ENTRY (owner, 14-Nov-2026: "Zone kulaye lower timeframe Choch nadanthuchuna ... Choch candle close la kooda buy
    # panalam, stop loss inum namaku narrow aagum. suppose Lowertimeframe choch Zone ku mela nadanthuna ... FVG Zone create
    # aachuna, we can buy on this top of the Zone (LTF), FVG Zones ethum ilena, 50% retracementla buy panalam"; answers: the
    # small CHoCH is "in the zone" when its LEVEL (the small swing high it broke) is at / under the zone top; its final low
    # may be anywhere; several small FVGs -> the highest; the 50% line of the small move = final low .. the highest high up to
    # the CHoCH candle, fixed then; the order waits to the end of the ltfWait window - cancelled when a candle of the chart
    # closes under the zone, 'missed' when price reaches the target first (no cancel on a close under the small final low);
    # stop: an entry above the zone top -> under the small final low, at / in the zone -> the run's own stop (under the zone);
    # target = R of that stop; no risk cap): ltfEntry 'smart'
    'ltf': 'off', 'ltfPivot': 3, 'ltfDown': 2, 'ltfWait': 5, 'ltfUnder': 0.5, 'ltfEntry': 'close', 'ltfStop': 'ltf',
    # the small CHoCH above the protected high (owner, 14-Nov-2026: "also add above the protected high in lowertimeframe also"):
    # ltfChoch 'last' = a close above the last small swing high / 'protected' = above the swing high right before the lowest
    # swing low (structure.py's protected CHoCH, like the chart's chochMode)
    'ltfChoch': 'last',
}
# the program's pattern engine - every result carries it, so the page can tell an older laptop program
ENGINE = {'version': pattern_registry.VERSION, 'patterns': len(pattern_registry.implemented())}
BENCH_INDEX = 'NIFTY_50'               # the relative-strength patterns' benchmark (cache meta 'indices')
SURVIVORSHIP = ("The stocks are today's ~1,800 listed ones - companies delisted or suspended over the years are not in the "
                "candles (Kite has only current instruments), so every result looks somewhat better than reality "
                "(survivorship bias).")
BIG_ZONE_PCT = 10.0            # fibPat 'big' without a zoneMax: zones bigger than this
# THE OWNER'S SETUP RULES OF 13-Nov-2026 (always on with structure 'only' - "add this to standard exclusion ... No need filter";
# the charts BESTAGRO / APTUS and two stop losses whose zone price had sat in before the buy): a zone wholly above the CHoCH level
# never counts; the zone formed in the one swing from the final low to the move high; the traded zone touched by at most
# MIT_MAX candles (a wick in it counts) and no candle closing under its middle before the move high; the 1st (watched) zone of
# two not touched at all before the move high; a premium zone (above the Fib line, taken by lineOk) is not traded when the
# signal comes PREM_FAST_DAYS calendar days or less after the CHoCH candle
MIT_MAX = 2
PREM_FAST_DAYS = 4
LOCK_PCT = 0.05                # = kite_intraday.CIRCUIT_LOCK_PCT: a candle whose range is <= 0.05 % (a Gap-up zone's touch never counts on it)
SHAPE_KEYS = ('upWickMax', 'loWickMin', 'closeMin', 'c2BodyMin', 'c2Color', 'c2BodyMax', 'undercutMin', 'undercutMax', 'undAtr',
              'closeAbove', 'recover', 'c1BodyMin', 'c1LoWickMax', 'c1Atr', 'lowestN', 'fallN')
EMA_LENS = (10, 21, 50)
BOOLS = ('breakeven', 'compound', 'above10', 'above21', 'above50', 'emaStack', 'mktStack', 'recover', 'belowChoch', 'firstPull',
         'sweep', 'lockTarget', 'gapEntry', 'lineOk', 'touchAgain')
CHOICES = {
    'tf': TFS, 'group': ('fvg', 'fvg_top', 'fvg_middle', 'fvg_bottom', 'gap', 'gapin', 'zone', 'spring', 'ft', 'conf', 'entry',
                         'touch', 'pattern'),
    'entry': ('close', 'next_open', 'zone'), 'stop': ('zone', 'spring', 'lower', 'pct', 'final'), 'after': ('trail', 'fixed'),
    'trail': ('lows', 'pct', 'ema', 'atr', 'swing', 'none'), 'emaSupport': (0, 10, 21, 50, 1), 'mktAbove': (0, 10, 21, 50, 100, 200),
    'c2Color': ('any', 'green', 'red'), 'structure': ('off', 'show', 'only'), 'zoneWhen': ('both', 'leg', 'after'),
    'targetMode': ('R', 'swing', 'mh', 'pct'), 'discPart': ('mid', 'top', 'bottom'),
    'swingMode': ('fractal', 'zigzag'), 'chochMode': ('last', 'protected'), 'whereIn': ('any', 'tm', 't'), 'wkAbove': (0, 10, 21, 50),
    'fibPat': ('off', 'big', 'all'), 'darkCloud': ('any', 'exclude', 'only'), 'zonePick': ('second', 'every'),
    'pattern': tuple(pattern_registry.implemented()), 'patCtx': ('any', 'down'),
    'setup': ('choch', 'bos', 'both'), 'bosKind': ('first', 'trend', 'both'),
    'ltf': ('off', 'D', '1H', '15m'), 'ltfEntry': ('close', 'fvg', 'smart'), 'ltfStop': ('ltf', 'rule'), 'ltfChoch': ('last', 'protected'),
}
LIMITS = {   # key: (min, max, integer)
    'minPrice': (0, 1e6, False), 'minTurnover': (0, 1e6, False), 'maxTouch': (0, 50, True), 'stopBuf': (0, 20, False),
    'stopPct': (0.1, 50, False), 'maxRisk': (0, 100, False), 'targetR': (0.25, 50, False), 'trailN': (1, 50, True),
    'trailPct': (0.5, 60, False), 'emaN': (2, 200, True), 'maxDays': (1, 3650, True), 'cost': (0, 5, False),
    'capital': (1000, 1e10, False), 'riskPct': (0.05, 100, False), 'maxPosPct': (1, 100, False), 'maxOpen': (1, 1000, True),
    'emaTouch': (0, 10, False),
    'upWickMax': (0, 100, False), 'loWickMin': (0, 100, False), 'closeMin': (0, 100, False), 'c2BodyMin': (0, 100, False),
    'c2BodyMax': (1, 30, False), 'undercutMin': (0.1, 20, False), 'undercutMax': (0, 50, False), 'undAtr': (0, 5, False),
    'closeAbove': (0, 20, False), 'c1BodyMin': (0.5, 30, False), 'c1LoWickMax': (0, 100, False), 'c1Atr': (0, 10, False),
    'lowestN': (0, 250, True), 'fallN': (0, 250, True), 'fallPct': (0.5, 90, False),
    'pivotN': (2, 20, True), 'downN': (1, 8, True), 'chochAge': (0, 2000, True), 'swingMinR': (0, 20, False),
    'discount': (0, 1, False),
    'zzAtr': (0.5, 10, False), 'swingAtr': (0, 5, False), 'eqAtr': (0, 2, False), 'discountMax': (0, 1.5, False),
    'lagMin': (0, 2000, True), 'dispAtr': (0, 5, False), 'dispVol': (0, 10, False), 'atrK': (0.5, 10, False), 'rollYears': (0, 10, True),
    'zoneMin': (0, 50, False), 'zoneMax': (0, 100, False), 'lineTol': (0, 5, False), 'fibLevel': (0.2, 0.95, False), 'fibTol': (0, 5, False),
    'moveVol': (0, 20, False), 'moveVolN': (1, 20, True),
    'stopAtr': (0, 10, False), 'targetPct': (1, 1000, False), 'partialPct': (0, 90, False), 'beAt': (0, 20, False),
    'timeN': (0, 1000, True), 'timeR': (0.1, 20, False),
    'engBody': (0, 10, False), 'boBuf': (0, 20, False), 'boVol': (0, 20, False), 'rsiN': (2, 50, True), 'divPivot': (2, 20, True),
    'divMaxGap': (5, 500, True), 'divRsiMax': (5, 100, False), 'patSwing': (2, 10, True), 'upN': (1, 8, True),
    'ltfPivot': (2, 10, True), 'ltfDown': (1, 6, True), 'ltfWait': (1, 30, True), 'ltfUnder': (0, 100, False),
}
GROUP_NAMES = {
    'fvg': 'FVG+Spring', 'fvg_top': 'FVG+Spring - zone top', 'fvg_middle': 'FVG+Spring - zone middle',
    'fvg_bottom': 'FVG+Spring - zone bottom', 'gap': 'Gap-up FVG + Spring', 'gapin': 'Gap-up FVG + Spring - inside FVG',
    'zone': 'FVG+Spring or Gap-up FVG + Spring', 'spring': 'Every Spring',
    'ft': 'FVG First Touch', 'conf': 'FVG First Touch Confirmed',
    'entry': 'Spring on an FVG / Gap-up zone, or FVG First Touch / Confirmed',
    'touch': 'First touch of a zone (every FVG / Gap-up zone)',
    'pattern': 'Pattern library',
}
SPRING_CODES = ('S', 'F', 'G')   # the Spring shape rules apply to these (T / C = FVG First Touch / Confirmed have no Spring pair)
TOUCH_CODES = ('T', 'Z', 'Y')    # first-touch signals: the zone-top entry (a buy order waiting at the top) fills on them
FIB_CODES = ('P', 'Q')           # a Spring / Bullish Harami + Inverted Hammer inside an FVG / a Gap-up zone (fibPat)
FVG_CODES = ('F', 'Z', 'T', 'C', 'P')   # rows whose zone is a 3-candle FVG (the others: Gap-up zones)
PAT_NAMES = {'S': 'Spring', 'H': 'Bullish Harami + Inverted Hammer'}
ZONE_NAMES = {'F': 'FVG', 'G': 'Gap-up', 'S': 'Spring', 'T': 'FVG first touch', 'C': 'FVG first touch confirmed',
              'Z': 'FVG zone touch', 'Y': 'Gap-up zone touch', 'P': 'FVG zone - pattern at the Fib line',
              'Q': 'Gap-up zone - pattern at the Fib line', 'K': 'Pattern library'}
REASONS = ('stop', 'target', 'be', 'trail', 'lock', 'ema', 'tstop', 'time', 'open')
TRADE_COLS = ['sym', 'signal', 'zone', 'where', 'touch', 'entry', 'stop', 'riskPct', 'exit', 'exitOn', 'reason', 'R', 'ret',
              'days', 'maxR', 'qty', 'pnl', 'taken', 'ema', 'upW', 'loW', 'dip', 'stage', 'struct', 'target', 'acct',
              'depth', 'lhll', 'lag', 'zpct', 'pat', 'zn', 'mv', 'mit', 'part', 'stopBy', 'ltf', 'ltfWait', 'baseR', 'setup', 'ltfHow']


def _iso_date(s):
    try:
        return date.fromisoformat(str(s)[:10]).isoformat()
    except ValueError:
        return ''


def clean_params(p, unknown=None):
    """The run's rules from the page, checked: unknown keys left out, numbers kept within LIMITS, choices from CHOICES.
    `unknown` (a dict) collects the choices the page sent that this program does not know (they keep their default) - a
    page newer than the laptop's program (owner, 13-Nov-2026: K01 Hammer chosen, the old program ran K08 without a word)."""
    p = p if isinstance(p, dict) else {}
    out = dict(DEFAULTS)
    for k, opts in CHOICES.items():
        v = p.get(k)
        if not isinstance(v, bool) and v in opts:
            out[k] = int(v) if isinstance(v, float) else v
        elif v is not None and unknown is not None:
            unknown[k] = v
    for k, (lo, hi, integer) in LIMITS.items():
        v = p.get(k)
        if isinstance(v, bool) or not isinstance(v, (int, float)) or v != v:
            continue
        v = min(max(v, lo), hi)
        out[k] = int(round(v)) if integer else float(v)
    for k in BOOLS:
        if isinstance(p.get(k), bool):
            out[k] = p[k]
    for k in ('from', 'to', 'testFrom', 'valFrom'):
        out[k] = _iso_date(p.get(k) or '')
    if out['valFrom'] and not (out['testFrom'] and out['valFrom'] < out['testFrom']):
        out['valFrom'] = ''                   # the validation part sits between the development part and the test part
    mk = str(p.get('mktIndex') or '').strip().upper().replace(' ', '_')
    out['mktIndex'] = mk if re.match(r'^[A-Z0-9_&.-]{2,40}$', mk) else ''
    return out


# ------------------------------------------------------------------ the cache (written by the backtest pass)
def _minute(t):
    return int(t[11:13]) * 60 + int(t[14:16]) if len(t) >= 16 else 0


def _label(tf, day_ord, minute):
    d = date.fromordinal(day_ord).isoformat()
    return d + ' %02d:%02d' % divmod(minute, 60) if tf == '4H' else d


class CacheWriter:
    """Collects the candles + signals of every stock during a backtest pass; close() makes them the current cache."""

    def __init__(self, upto, base=None):
        self.base = base or LAB_DIR
        self.name = 'b' + datetime.now().strftime('%Y%m%d-%H%M%S-%f')
        self.dir = os.path.join(self.base, self.name + '.tmp')
        os.makedirs(self.dir, exist_ok=True)
        self.upto = upto.isoformat() if hasattr(upto, 'isoformat') else str(upto)
        self.files = {tf: open(os.path.join(self.dir, tf + '.bin'), 'wb') for tf in TFS}
        self.pos = {tf: 0 for tf in TFS}
        self.index = {tf: {} for tf in TFS}
        self.signals = {tf: {} for tf in TFS}
        self.indices = {}               # {NAME: [[day ordinal, close], ...]} - the market filter's index candles
        self.done = False

    def add(self, sym, tf, candles, rows):
        """One stock's candles of a timeframe (oldest first, {'t','day','o','h','l','c'}) and its signal rows
        [i, code, zone bottom, zone top, where, touch, inside, turnover lakh]."""
        if tf not in self.files or not candles or self.done:
            return
        try:
            self._add(sym, tf, candles, rows)
        except OSError as e:                  # a full disk: no cache this time - the scan itself carries on
            log('Backtest Lab: the cache could not be written - %s' % e)
            self.abort()

    def _add(self, sym, tf, candles, rows):
        n = len(candles)
        parts = [array.array('f', [c[k] for c in candles]) for k in ('o', 'h', 'l', 'c')]
        parts.append(array.array('f', [float(c.get('v') or 0) for c in candles]))
        parts.append(array.array('i', [date.fromisoformat(c['day'][:10]).toordinal() for c in candles]))
        parts.append(array.array('h', [_minute(c['t']) if tf == '4H' else 0 for c in candles]))
        f = self.files[tf]
        self.index[tf][sym] = [self.pos[tf], n]
        for a in parts:
            b = a.tobytes()
            f.write(b)
            self.pos[tf] += len(b)
        if self.pos[tf] % 4:
            pad = 4 - self.pos[tf] % 4
            f.write(b'\0' * pad)
            self.pos[tf] += pad
        if rows:
            self.signals[tf][sym] = rows

    def abort(self):
        for f in self.files.values():
            f.close()
        self.done = True
        shutil.rmtree(self.dir, ignore_errors=True)

    def close(self):
        if self.done:
            return
        for f in self.files.values():
            f.close()
        meta = {'v': CACHE_VERSION, 'upto': self.upto, 'built': datetime.now().isoformat(timespec='seconds'),
                'index': self.index, 'signals': self.signals,
                'indices': {k: {'d': [r[0] for r in v], 'c': [r[1] for r in v]} for k, v in (self.indices or {}).items()}}
        with gzip.open(os.path.join(self.dir, 'signals.json.gz'), 'wt', encoding='utf-8') as f:
            json.dump(meta, f, separators=(',', ':'))
        final = os.path.join(self.base, self.name)
        ltf_data.replace(self.dir, final)
        tmp = os.path.join(self.base, 'current.txt.tmp')
        with open(tmp, 'w', encoding='utf-8') as f:
            f.write(self.name)
        ltf_data.replace(tmp, os.path.join(self.base, 'current.txt'))
        self.done = True
        for d in os.listdir(self.base):   # older builds (a file still open on Windows: left for the next build)
            full = os.path.join(self.base, d)
            if d != self.name and d.startswith('b') and os.path.isdir(full):
                try:                      # another build still being written (the daily scan + the Lab's own): left alone
                    if d.endswith('.tmp') and time.time() - os.path.getmtime(full) < 6 * 3600:
                        continue
                except OSError:
                    continue
                shutil.rmtree(full, ignore_errors=True)


def turnover_fn(day_rows, days=20):
    """day ISO -> the average daily turnover (close x volume) of the `days` sessions up to that day, in lakh rupees."""
    keys = [r[0][:10] for r in day_rows]
    pre = [0.0]
    for r in day_rows:
        try:
            pre.append(pre[-1] + float(r[4]) * float(r[5] or 0))
        except (TypeError, ValueError):
            pre.append(pre[-1])

    def at(day):
        k = bisect.bisect_right(keys, day[:10])
        if k == 0:
            return 0.0
        a = max(0, k - days)
        return round((pre[k] - pre[a]) / (k - a) / 1e5, 1)
    return at


def signal_rows(candles, i, zones, turn):
    """The cache rows of a Spring on candle i: 'S' (every Spring) + one per zone it sits on ('F' FVG / 'G' Gap-up).
    Row = [i, code, zone bottom, zone top, where t/m/b, touch, inside, turnover lakh, zone formed candle (-1 none)]."""
    t = turn(candles[i]['day']) if turn else 0.0
    rows = [[i, 'S', None, None, '', 0, 0, t, -1]]
    for z in zones or ():
        rows.append([i, 'G' if z['kind'] == 'Gap-up' else 'F', round(z['bottom'], 4), round(z['top'], 4),
                     (z.get('where') or '')[:1], int(z.get('touch') or 0), 1 if z.get('inside') else 0, t, int(z['f'])])
    return rows


def touch_rows(candles, i, ft, cf, turn):
    """The cache rows of the FVG patterns on candle i (owner, 10-Nov-2026: "if the price mitigated the FVG with FVG pattern
    or spring candlestick pattern, i enter"): 'T' = FVG First Touch, 'C' = FVG First Touch Confirmed (the newest 3-candle
    FVG; zone = {'f', 'bottom', 'top'})."""
    rows = []
    for code, z in (('T', ft), ('C', cf)):
        if z and z.get('f') is not None and z.get('bottom') is not None:
            t = turn(candles[i]['day']) if turn else 0.0
            rows.append([i, code, round(z['bottom'], 4), round(z['top'], 4), '', 1, 0, t, int(z['f'])])
    return rows


def zone_touch_rows(candles, i, zones, turn):
    """The cache rows of candle i's FIRST touches of zones (kite_intraday.zone_first_touches; owner, 11-Nov-2026: "the first
    return of price to the discount zone"): 'Z' = a 3-candle FVG zone, 'Y' = a Gap-up zone (+ inside), the zones' order kept
    (highest top first - a falling price reaches it first). Row[9] (12-Nov-2026, kite_intraday.link_zones): a 'Z' row's
    highest Gap-up zone inside it / a 'Y' row's widest FVG zone around it, formed before candle i - [bottom, top, candle]."""
    t = turn(candles[i]['day']) if turn else 0.0
    out = []
    for z in zones or ():
        link = None
        if z['kind'] == 'Gap-up':
            o = [x for x in z.get('outer') or () if x['f'] < i]
            if o:
                x = min(o, key=lambda x: (x['bottom'], x['f']))
                link = [round(x['bottom'], 4), round(x['top'], 4), int(x['f'])]
        else:
            g = [x for x in z.get('inner') or () if x['f'] < i]
            if g:
                x = max(g, key=lambda x: (x['top'], -x['f']))
                link = [round(x['bottom'], 4), round(x['top'], 4), int(x['f'])]
        out.append([i, 'Y' if z['kind'] == 'Gap-up' else 'Z', round(z['bottom'], 4), round(z['top'], 4), (z.get('where') or '')[:1],
                    1, 1 if z.get('inside') else 0, t, int(z['f']), link])
    return out


def zone_pct(bottom, top):
    """A zone's size: (top - bottom) / bottom in %."""
    return (top - bottom) / bottom * 100.0 if bottom and bottom > 0 and top is not None else None


def dark_cloud(cs, f):
    """kite_intraday.is_dark_cloud on the cached candles: the FVG's 3rd candle f red, opening at / above the green candle
    f-1's close and closing under the middle of its body."""
    if f is None or f < 1 or f >= cs.n:
        return False
    bo, bc, co, cc = _f(cs.o[f - 1]), _f(cs.c[f - 1]), _f(cs.o[f]), _f(cs.c[f])
    return bc > bo and cc < co and co >= bc and cc < (bo + bc) / 2.0


def current_dir(base=None):
    base = base or LAB_DIR
    try:
        with open(os.path.join(base, 'current.txt'), encoding='utf-8') as f:
            name = f.read().strip()
    except OSError:
        return None
    d = os.path.join(base, name)
    return d if name and os.path.isfile(os.path.join(d, 'signals.json.gz')) else None


def load_meta(base=None):
    d = current_dir(base)
    if not d:
        return None, None
    try:
        with gzip.open(os.path.join(d, 'signals.json.gz'), 'rt', encoding='utf-8') as f:
            meta = json.load(f)
    except (OSError, ValueError, EOFError):
        return None, None
    return (meta, d) if meta.get('v') == CACHE_VERSION else (None, None)


class Candles:
    __slots__ = ('o', 'h', 'l', 'c', 'v', 'day', 'minute', 'n')

    def __init__(self, f, off, n):
        self.n = n
        f.seek(off)
        raw = f.read(n * 26 + 4)
        vals = []
        p = 0
        for code, size in (('f', 4), ('f', 4), ('f', 4), ('f', 4), ('f', 4), ('i', 4), ('h', 2)):
            a = array.array(code)
            a.frombytes(raw[p:p + n * size])
            vals.append(a)
            p += n * size
        self.o, self.h, self.l, self.c, self.v, self.day, self.minute = vals


# ------------------------------------------------------------------ the Pattern library's signal rows (owner, 13-Nov-2026)
_PAT_MEMO = {}                 # (cache dir, tf, pattern, params hash) -> {sym: (candles, events)} while the program runs
PAT_MEMO_KEEP = 4


class _PatRows:
    """The signal rows of one Pattern library run: pattern_detect events of the chosen pattern on each stock's cached candles
    -> rows in the Lab's own format [i, 'K', stop reference, None, '', 0, 0, turnover lakh, -1, None, None, trigger, aux]
    (r[2] = the pattern's stop reference, so the stop kind 'zone' puts the stop under the pattern's low). The events are
    remembered per (cache build, timeframe, pattern, its parameters) - a second run with other exit rules does not detect
    again."""

    def __init__(self, d, tf, meta, P):
        self.pid, self.tf, self.P = P['pattern'], tf, P
        self.name = '%s %s' % (self.pid, pattern_registry.by_id()[self.pid]['name'])
        self.params = pattern_detect.params_for(self.pid, P)
        if pattern_registry.SPECS[self.pid].get('ctx'):
            self.params = dict(self.params, patCtx=P.get('patCtx', 'any'))     # the trend context before a reversal pattern
        key = (d, tf, self.pid, pattern_detect.param_hash(self.pid, self.params))
        if key not in _PAT_MEMO:
            while len(_PAT_MEMO) >= PAT_MEMO_KEEP:
                _PAT_MEMO.pop(next(iter(_PAT_MEMO)))
            _PAT_MEMO[key] = {}
        self.memo = _PAT_MEMO[key]
        self.bench = None
        if self.pid in pattern_p3.NEEDS_BENCH:             # the relative-strength patterns: NIFTY 50's daily closes
            ix = (meta.get('indices') or {}).get(BENCH_INDEX)
            if not ix or not ix.get('d'):
                raise LabError('%s needs the NIFTY 50 candles on the laptop - they come with the next daily scan (after 15:40) '
                               'or KiteHistoryNow.bat' % self.pid)
            self.bench = (list(ix['d']), list(ix['c']))
        self.dix = (meta['index'].get('D') or {}) if tf != 'D' else None
        self.dayf = open(os.path.join(d, 'D.bin'), 'rb') if self.dix else None
        self.found = 0

    def close(self):
        if self.dayf is not None:
            self.dayf.close()
            self.dayf = None

    def events(self, sym, cs):
        got = self.memo.get(sym)
        if got is None or got[0] != cs.n:
            o, h, l, c = ([_f(x) for x in a] for a in (cs.o, cs.h, cs.l, cs.c))
            got = self.memo[sym] = (cs.n, pattern_detect.detect(self.pid, o, h, l, c, [float(x) for x in cs.v], self.tf, self.params,
                                                                 day=list(cs.day), bench=self.bench))
        return got[1]

    def turnover(self, sym, cs):
        """day ordinal -> the average daily turnover (close x volume) of the 20 sessions up to that day, lakh (= turnover_fn)."""
        dc = cs
        if self.dix is not None:
            if sym not in self.dix or self.dayf is None:
                return None
            dc = Candles(self.dayf, self.dix[sym][0], self.dix[sym][1])
        pre = [0.0]
        for j in range(dc.n):
            pre.append(pre[-1] + _f(dc.c[j]) * float(dc.v[j]))
        days = list(dc.day)

        def at(day):
            k = bisect.bisect_right(days, day)
            if k == 0:
                return 0.0
            a = max(0, k - 20)
            return round((pre[k] - pre[a]) / (k - a) / 1e5, 1)
        return at

    def rows(self, sym, cs):
        ev = self.events(sym, cs)
        if not ev:
            return []
        self.found += len(ev)
        turn = self.turnover(sym, cs)
        out = []
        for a, conf, occ, trig, sref, aux in ev:
            t = turn(cs.day[a]) if turn else 0.0
            if self.P['minTurnover'] and t < self.P['minTurnover']:
                continue
            out.append([a, 'K', round(sref, 4), None, '', 0, 0, t, -1, None, None,
                        round(trig, 4) if trig is not None else None, aux])
        return out


# ------------------------------------------------------------------ one trade
def ema_series(closes, n):
    out, k, e = [], 2.0 / (n + 1), None
    for x in closes:
        e = x if e is None else e + k * (x - e)
        out.append(e)
    return out


def _f(x):
    """float32 -> a price with 2 decimals (what the chart shows)."""
    return round(float(x), 2)


def ema_lens(P):
    """The EMA lengths the run's confluence rules need (none = no EMA filter)."""
    need = set()
    if P['emaSupport']:
        need.update(EMA_LENS if P['emaSupport'] == 1 else (int(P['emaSupport']),))
    need.update(n for n in EMA_LENS if P['above%d' % n])
    if P['emaStack']:
        need.update(EMA_LENS)
    return sorted(need)


def ema_check(cs, i, P, emas):
    """EMA confluence on the Spring candle i -> (ok, text). text = what the EMAs show there ('support 10 EMA ·
    above 21 / 50 · 10>21>50'). The first candles of a stock (shorter than the EMA) never pass."""
    lens = sorted(emas)
    if not lens or i < max(lens):
        return False, ''
    c, l = _f(cs.c[i]), _f(cs.l[i])
    e = {n: emas[n][i] for n in lens}
    touch = 1 + P['emaTouch'] / 100.0
    sup = [n for n in lens if l <= e[n] * touch and c >= e[n]]
    above = [n for n in lens if c > e[n]]
    stack = len(lens) == 3 and e[10] > e[21] > e[50]
    ok = True
    if P['emaSupport']:
        want = EMA_LENS if P['emaSupport'] == 1 else (int(P['emaSupport']),)
        ok = ok and any(n in sup for n in want)
    for n in EMA_LENS:
        if P['above%d' % n]:
            ok = ok and n in above
    if P['emaStack']:
        ok = ok and stack
    parts = []
    if sup:
        parts.append('support ' + ' / '.join(str(n) for n in sup) + ' EMA')
    rest = [n for n in above if n not in sup]
    if rest:
        parts.append('above ' + ' / '.join(str(n) for n in rest))
    if stack:
        parts.append('10>21>50')
    return ok, ' · '.join(parts)


def shape_active(P):
    """True when the run sets any hard Spring rule (anything but the pattern's own base values)."""
    return any(P[k] != DEFAULTS[k] for k in SHAPE_KEYS)


def atr14(cs, j):
    """The average true range of the 14 candles ending at candle j (None when there are not 14 with a candle before)."""
    if j < 14:
        return None
    tot = 0.0
    for k in range(j - 13, j + 1):
        h, l, pc = _f(cs.h[k]), _f(cs.l[k]), _f(cs.c[k - 1])
        tot += max(h - l, abs(h - pc), abs(l - pc))
    return tot / 14.0


def spring_feats(cs, i, P, deep=False):
    """The shape of the Spring pair (c1 = candle i-1, c2 = the Spring candle i) as numbers - the same candles
    the pattern rule judged (prices to 2 decimals). The wick / body / close figures are % of c2's own range, the dip and
    the close above are % of c1's low. `deep` adds the rules that look further back (ATR, lowest low, the fall before).
    None when there is no candle before or a candle without a range."""
    if i < 1 or i >= cs.n:
        return None
    o1, h1, l1, c1 = (_f(x[i - 1]) for x in (cs.o, cs.h, cs.l, cs.c))
    o2, h2, l2, c2 = (_f(x[i]) for x in (cs.o, cs.h, cs.l, cs.c))
    rng1, rng2, b1, b2 = h1 - l1, h2 - l2, o1 - c1, abs(c2 - o2)
    if rng1 <= 0 or rng2 <= 0 or o1 <= 0 or l1 <= 0:
        return None
    f = {'upW': (h2 - max(o2, c2)) / rng2 * 100, 'loW': (min(o2, c2) - l2) / rng2 * 100, 'bodyR': b2 / rng2 * 100,
         'closePos': (c2 - l2) / rng2 * 100, 'col': 'green' if c2 > o2 else 'red' if c2 < o2 else 'doji',
         'bodyVs': b2 / b1 * 100 if b1 > 0 else 1e9, 'dip': (l1 - l2) / l1 * 100, 'above': (c2 - l1) / l1 * 100,
         'recover': c2 > c1, 'c1Body': b1 / o1 * 100, 'c1Lo': (min(o1, c1) - l1) / rng1 * 100, 'b1': b1, 'd': l1 - l2}
    if deep:
        if P['undAtr'] or P['c1Atr']:
            f['atr'] = atr14(cs, i - 1)
        n = P['lowestN']
        if n:
            f['lowest'] = (l2 < _f(min(cs.l[i - n:i]))) if i >= n else None
        n = P['fallN']
        if n:
            if i >= n:
                hi = _f(max(cs.h[i - n:i]))
                f['fall'] = (hi - c1) / hi * 100 if hi > 0 else 0.0
            else:
                f['fall'] = None
    return f


# why a Spring was left out by the hard rules (the first rule it failed) -> the page's words
SHAPE_WHY = {
    'data': 'no candle before it', 'history': 'too few candles before it for an ATR / swing-low / fall rule',
    'c1body': 'the red candle was too small', 'c1wick': 'the red candle had a long lower wick', 'c1atr': 'the red candle was small for that stock (ATR)',
    'dipmin': 'the dip under the red candle\'s low was too shallow', 'dipmax': 'the dip was too deep', 'dipatr': 'the dip was small for that stock (ATR)',
    'closeabove': 'it closed too close to the red candle\'s low', 'recover': 'it did not close above the red candle\'s close',
    'upwick': 'the upper wick was too long', 'lowick': 'the lower wick was too short', 'close': 'it did not close high enough in its range',
    'doji': 'it was a doji (body too small)', 'color': 'wrong colour', 'c2body': 'its body was too big for the red candle',
    'lowest': 'its low did not take out the lowest low of the last candles', 'fall': 'no fall before the red candle',
}


def shape_check(f, P):
    """The hard Spring rules on one pair -> (ok, why) - `why` = the first rule it failed (a SHAPE_WHY key). A rule still
    at the pattern's own value is not checked (the pattern already passed it)."""
    if f is None:
        return False, 'data'
    e = 1e-9
    if P['c1BodyMin'] > DEFAULTS['c1BodyMin'] and f['c1Body'] + e < P['c1BodyMin']:
        return False, 'c1body'
    if P['c1LoWickMax'] < 100 and f['c1Lo'] > P['c1LoWickMax'] + e:
        return False, 'c1wick'
    if P['c1Atr']:
        if f.get('atr') is None:
            return False, 'history'
        if f['b1'] + e < P['c1Atr'] * f['atr']:
            return False, 'c1atr'
    if P['undercutMin'] > DEFAULTS['undercutMin'] and f['dip'] + e < P['undercutMin']:
        return False, 'dipmin'
    if P['undercutMax'] and f['dip'] > P['undercutMax'] + e:
        return False, 'dipmax'
    if P['undAtr']:
        if f.get('atr') is None:
            return False, 'history'
        if f['d'] + e < P['undAtr'] * f['atr']:
            return False, 'dipatr'
    if P['closeAbove'] and f['above'] + e < P['closeAbove']:
        return False, 'closeabove'
    if P['recover'] and not f['recover']:
        return False, 'recover'
    if P['upWickMax'] < 100 and f['upW'] > P['upWickMax'] + e:
        return False, 'upwick'
    if P['loWickMin'] and f['loW'] + e < P['loWickMin']:
        return False, 'lowick'
    if P['closeMin'] and f['closePos'] + e < P['closeMin']:
        return False, 'close'
    if P['c2BodyMin'] and f['bodyR'] + e < P['c2BodyMin']:
        return False, 'doji'
    if P['c2Color'] != 'any' and f['col'] != P['c2Color']:
        return False, 'color'
    if P['c2BodyMax'] < DEFAULTS['c2BodyMax'] and f['bodyVs'] > P['c2BodyMax'] + e:
        return False, 'c2body'
    if P['lowestN']:
        if f.get('lowest') is None:
            return False, 'history'
        if not f['lowest']:
            return False, 'lowest'
    if P['fallN']:
        if f.get('fall') is None:
            return False, 'history'
        if f['fall'] + e < P['fallPct']:
            return False, 'fall'
    return True, ''


def market_filter(meta, P):
    """The run's market condition -> fn(day ordinal) -> True when the index agreed that day (None = no market rule).
    Raises LabError when the laptop has no candles of that index yet."""
    name = P['mktIndex']
    if not name or not (P['mktAbove'] or P['mktStack']):
        return None
    ix = (meta.get('indices') or {}).get(name)
    if not ix or not ix.get('d'):
        have = ', '.join(sorted((meta.get('indices') or {}).keys())[:12]) or 'none yet'
        raise LabError('no candles of the index %s on the laptop (it has: %s) - they come with the next daily scan '
                       '(after 15:40) or KiteHistoryNow.bat' % (name.replace('_', ' '), have))
    days, closes = ix['d'], ix['c']
    lens = set()
    if P['mktAbove']:
        lens.add(int(P['mktAbove']))
    if P['mktStack']:
        lens.update(EMA_LENS)
    emas = {n: ema_series(closes, n) for n in lens}
    longest = max(lens)

    def ok(day):
        k = bisect.bisect_right(days, day) - 1          # that day's close (or the last one before it)
        if k < longest:
            return False
        c = closes[k]
        if P['mktAbove'] and not c > emas[int(P['mktAbove'])][k]:
            return False
        if P['mktStack'] and not emas[10][k] > emas[21][k] > emas[50][k]:
            return False
        return True
    return ok


def simulate(cs, row, P, ema=None, swing=None, atr=None, lows=None, final=None, mh=None, stop_at=None):
    """One signal row -> the trade under the rules P (see the module text), or (None, why skipped). `swing` (target mode
    'swing') = the Structure of these candles: the target is then the last swing high at least swingMinR R above the
    entry (none = skipped, 'noswing'). `atr` (trail 'atr') = the ATR(14) series; `lows` (trail 'swing') = the Structure
    whose swing lows the stop trails under. `final` (stop 'final') = the CHoCH's final low (none = skipped, 'nofinal').
    lockTarget (12-Nov-2026): once price reaches the target the stop moves up to it (a gap open above the target that falls
    back the same candle = sold at the target; exit reason 'lock').
    The owner's options of 13-Nov-2026: stopAtr (`atr` = the ATR(14) series) - the lower of the rule's stop and entry - stopAtr x
    ATR; target 'mh' (`mh` = the CHoCH move's high; none = skipped, 'nomh') / 'pct'; partialPct sold at the target (the exit
    price = the average of both parts, 'part' = where the first part went, 'xr' = the rest's exit); beAt (the stop to the entry
    before the target, reason 'be'); timeN / timeR (reason 'tstop')."""
    i, code, zb = row[0], row[1], row[2]
    n = cs.n
    if i >= n:
        return None, 'data'
    zone_in = P['entry'] == 'zone'
    if zone_in:
        # a buy order waiting at the zone top (owner, 11-Nov-2026): filled on the first touch at the top - or at the open
        # when the candle opened under it; only first-touch signals (a Spring / Confirmed candle came after the touch)
        if code not in TOUCH_CODES or row[3] is None:
            return None, 'zoneentry'
        entry = min(_f(cs.o[i]), _f(row[3]))
    elif P['entry'] == 'close':
        entry = _f(cs.c[i])
    else:
        if i + 1 >= n:
            return None, 'notyet'
        entry = _f(cs.o[i + 1])
    j0 = i + 1
    low = _f(cs.l[i])
    mode = P['stop']
    if mode == 'zone' and zb is None:
        mode = 'spring'                       # every Spring has no zone: under its own low
    if zone_in and mode in ('spring', 'lower'):
        mode = 'zone'                         # the touch candle's low is not known when the order fills
    if stop_at is not None:                   # the lower-timeframe confirmation worked its stop out (ltf_trade)
        stop = stop_at
    elif mode == 'pct':
        stop = entry * (1 - P['stopPct'] / 100.0)
    elif mode == 'final':
        if final is None:
            return None, 'nofinal'
        stop = _f(final) * (1 - P['stopBuf'] / 100.0)
    else:
        base = low if mode == 'spring' else zb if mode == 'zone' else min(low, zb if zb is not None else low)
        stop = base * (1 - P['stopBuf'] / 100.0)
    stop_by = ''
    if P['stopAtr']:
        # the ATR stop (13-Nov-2026): whichever is LOWER - the rule's stop or stopAtr x ATR(14) under the entry; the zone-top
        # order fills during the touch candle, so it uses the ATR up to the candle before
        ja = i - 1 if zone_in else i
        if atr is None or ja < 0 or ja >= len(atr):
            return None, 'data'
        s_atr = entry - P['stopAtr'] * atr[ja]
        stop_by = 'rule'
        if s_atr < stop:
            stop, stop_by = s_atr, 'atr'
    risk = entry - stop
    if not (entry > 0 and risk > 0):
        return None, 'gap' if P['entry'] in ('next_open', 'zone') else 'risk'
    risk_pct = risk / entry * 100
    if P['maxRisk'] and risk_pct > P['maxRisk']:
        return None, 'risk'
    if entry < P['minPrice']:
        return None, 'price'
    tmode = P['targetMode']
    target = entry * (1 + P['targetPct'] / 100.0) if tmode == 'pct' else entry + P['targetR'] * risk
    if swing is not None:
        sh = swing.last_swing_high(i, entry + P['swingMinR'] * risk)
        if sh is None:
            return None, 'noswing'
        target = _f(sh[1])
    elif tmode == 'mh':
        # the CHoCH move's high (HH): at least swingMinR R above the entry
        if mh is None or not _f(mh) > entry or _f(mh) < entry + P['swingMinR'] * risk - 1e-9:
            return None, 'nomh'
        target = _f(mh)
    end = cs.day[i] + P['maxDays']
    trail, fixed, be = P['trail'], P['after'] == 'fixed', P['breakeven']
    lock = P.get('lockTarget') and not fixed
    hit, cur, best = False, stop, entry
    ex, why, jx = None, None, None
    part = P['partialPct'] / 100.0 if P['partialPct'] and not fixed else 0.0
    tp = None                                  # where the part sold at the target went
    be_at = entry + P['beAt'] * risk if P['beAt'] else None
    t_at = entry + P['timeR'] * risk if P['timeN'] else None

    def trail_up(j, cur):
        if trail == 'lows':
            a = max(0, j - P['trailN'] + 1)
            cur = max(cur, min(_f(cs.l[k]) for k in range(a, j + 1)))
        elif trail == 'pct':
            cur = max(cur, best * (1 - P['trailPct'] / 100.0))
        elif trail == 'atr' and atr is not None:      # E15: atrK x ATR(14) under the highest high since the entry
            cur = max(cur, best - P['atrK'] * atr[j])
        elif trail == 'swing' and lows is not None:   # E16: under the newest swing low formed since the signal
            v = structure.last_swing_low(lows, j, i)
            if v is not None:
                cur = max(cur, _f(v) * (1 - P['stopBuf'] / 100.0))
        return cur

    if zone_in:
        # the entry candle itself, after the fill: a low under the stop = stopped there; its close (surely after the fill)
        # at / above the target = reached (its high may have come before the fill - not counted)
        c0 = _f(cs.c[i])
        if low < stop:
            ex, why, jx = stop, 'stop', i
        else:
            best = max(best, c0)
            if c0 >= target:
                hit = True
                if fixed:
                    ex, why, jx = target, 'target', i
                else:
                    tp = target
                    if be:
                        cur = max(cur, entry)
                    if lock:
                        cur = max(cur, target)
                    cur = trail_up(i, cur)
            elif be_at is not None and c0 >= be_at:
                cur = max(cur, entry)
    for j in (range(j0, n) if ex is None else ()):
        if cs.day[j] > end:
            ex, why, jx = _f(cs.c[j - 1]), 'time', j - 1
            break
        o, h, l, c = _f(cs.o[j]), _f(cs.h[j]), _f(cs.l[j]), _f(cs.c[j])
        if not hit:
            if o >= target:                       # opened above the target
                hit = True
                best = max(best, o)
                if fixed:
                    ex, why, jx = o, 'target', j
                    break
                tp = o
                if be:
                    cur = max(cur, entry)
                if lock:                          # the stop moves up to the target: falling back under it = sold there
                    cur = max(cur, target)
                if l < cur:
                    ex, why, jx = cur, _exit_why(cur, entry, target, lock), j
                    break
                best = max(best, h)
                cur = trail_up(j, cur)
                continue
            if l < cur:                           # the stop (moved to the entry by beAt: 'be')
                ex, why, jx = min(o, cur), 'be' if cur >= entry * (1 - 1e-9) else 'stop', j
                break
            best = max(best, h)
            if h >= target:
                hit = True
                if fixed:
                    ex, why, jx = target, 'target', j
                    break
                tp = target
                if be:
                    cur = max(cur, entry)
                if lock:
                    cur = max(cur, target)
                cur = trail_up(j, cur)
                continue
            if be_at is not None and h >= be_at:
                cur = max(cur, entry)             # 1R reached: the stop to the entry
            if t_at is not None and j - i >= P['timeN'] and best < t_at:
                ex, why, jx = c, 'tstop', j       # the time stop: no move in timeN candles
                break
            continue
        if l < cur:
            ex = min(o, cur)
            why = _exit_why(cur, entry, target, lock)
            jx = j
            break
        if trail == 'ema' and ema is not None and c < ema[j]:
            ex, why, jx = c, 'ema', j
            break
        best = max(best, h)
        cur = trail_up(j, cur)
    if ex is None:
        jx = n - 1
        ex, why = _f(cs.c[jx]), 'open'        # the window is not over yet: still running (shown, not counted)
    if jx <= i and not zone_in:               # no candle inside the window: sold where bought
        jx, ex = i, entry
    xr = ex
    if part and tp is not None:               # part sold at the target, the rest at ex: the average exit price
        ex = part * tp + (1 - part) * ex
    cost = P['cost'] / 100.0 * entry
    R = (ex - entry - cost) / risk
    best_r = (best - entry) / risk
    return {'i': i, 'code': code, 'where': row[4], 'touch': row[5], 'inside': row[6], 'turn': row[7],
            'entry': entry, 'stop': round(stop, 2), 'risk': risk, 'riskPct': round(risk_pct, 2), 'exit': round(ex, 4), 'reason': why,
            'R': round(R, 3), 'ret': round((ex - entry - cost) / entry * 100, 2), 'days': cs.day[jx] - cs.day[i],
            'maxR': round(max(0.0, best_r), 2), 'hit': hit, 'tgt': round(target, 2), 'jx': jx,
            'ek': (cs.day[i if P['entry'] != 'next_open' else min(i + 1, n - 1)], cs.minute[i if P['entry'] != 'next_open' else min(i + 1, n - 1)]),
            'xk': (cs.day[jx], cs.minute[jx]), 'sigDay': cs.day[i], 'sigMin': cs.minute[i],
            'part': round(tp, 2) if part and tp is not None else None, 'xr': round(xr, 4), 'partPct': P['partialPct'] if part else 0,
            'stopBy': stop_by}, None


# ------------------------------------------------------------------ the lower-timeframe confirmation (owner, 13-Nov-2026)
LTF_RANK = {'15m': 1, '1H': 2, '4H': 3, 'D': 4, 'W': 5}
PROGRESS_EVERY_S = 60          # a run tells the sheet how far it is at least this often (the page's "laptop" badge stays fresh)
LTF_NAMES = {'15m': '15-minute', '1H': '1-hour', 'D': 'daily'}
LTF_WHY = ('ltfnone', 'ltfbroke', 'ltfnofvg', 'ltfnofill', 'ltfdata', 'ltfnotyet', 'ltfmissed')
LTF_HOW = ('close', 'fvg', 'half')      # the Smart entry: the CHoCH in the zone at its close / the small FVG top / the 50% line
_LTF_MEMO = {'key': None, 'map': {}}


def htf_span(tf, day, minute):
    """The time a candle of the chart covers as minute keys [start, end) (key = day ordinal x 1440 + minute): a week (from
    its Monday), a day, or a 4H block (09:15-13:15 / 13:15-the day's end)."""
    if tf == 'W':
        mon = day - date.fromordinal(day).weekday()
        return mon * 1440, (mon + 7) * 1440
    if tf == 'D':
        return day * 1440, (day + 1) * 1440
    return day * 1440 + minute, day * 1440 + (795 if minute < 795 else 1440)


class _LtfSet:
    """A run's lower-timeframe candles: get(sym) -> (candles, events) - the CHoCH events (structure.choch_events, the run's
    ltfPivot) remembered per (timeframe, swing size) while the program runs (a compact array per stock); the candles are read
    again each run (a file a stock - fast)."""

    def __init__(self, d, meta, P):
        self.tf, self.n = P['ltf'], P['ltfPivot']
        self.opts = {'choch': 'protected'} if P.get('ltfChoch') == 'protected' else None
        self.d, self.meta = d, meta
        self.f = open(os.path.join(d, 'D.bin'), 'rb') if self.tf == 'D' else None
        key = (d if self.tf == 'D' else LTF_DIR, self.tf, self.n, P.get('ltfChoch', 'last'))
        if _LTF_MEMO['key'] != key:
            _LTF_MEMO['key'], _LTF_MEMO['map'] = key, {}
        self.memo = _LTF_MEMO['map']

    def close(self):
        if self.f:
            self.f.close()

    def get(self, sym):
        if self.tf == 'D':
            idx = (self.meta['index'].get('D') or {}).get(sym)
            if not idx:
                return None, None
            cs = Candles(self.f, idx[0], idx[1])
        else:
            cs = ltf_data.read(LTF_DIR, sym, self.tf)
        if not cs.n:
            return None, None
        m = self.memo.get(sym)
        if m is None or m[0] != cs.n or m[1] != cs.day[-1]:
            h, l, c = [_f(x) for x in cs.h], [_f(x) for x in cs.l], [_f(x) for x in cs.c]
            ev = structure.choch_events(h, l, c, self.n, opts=self.opts)
            flat = array.array('d')
            for e in ev:
                flat.extend(e)
            m = self.memo[sym] = (cs.n, cs.day[-1], flat)
        flat = m[2]
        return cs, [flat[k:k + 6] for k in range(0, len(flat), 6)]


def _first_at(cs, key):
    """The first candle of cs at / after the minute key."""
    day = key // 1440
    k = bisect.bisect_left(cs.day, day)
    while k < cs.n and cs.day[k] * 1440 + cs.minute[k] < key:
        k += 1
    return k


class _Hybrid:
    """The candles a confirmed trade lives on: the small timeframe's candles from the entry to the end of the chart's candle
    it is in, then the chart's candles after it (the target / stop / trail rules run on them as usual)."""
    __slots__ = ('o', 'h', 'l', 'c', 'v', 'day', 'minute', 'n')

    def __init__(self, lt, a, z, cs, j1):
        self.o = list(lt.o[a:z]) + list(cs.o[j1:])
        self.h = list(lt.h[a:z]) + list(cs.h[j1:])
        self.l = list(lt.l[a:z]) + list(cs.l[j1:])
        self.c = list(lt.c[a:z]) + list(cs.c[j1:])
        self.v = list(lt.v[a:z]) + list(cs.v[j1:])
        self.day = list(lt.day[a:z]) + list(cs.day[j1:])
        self.minute = list(lt.minute[a:z]) + list(cs.minute[j1:])
        self.n = len(self.c)


class _Remap:
    """A Structure's swings with the chart's candle numbers moved onto a _Hybrid (the target 'last swing high' / the
    'swing' trail): a swing known on the chart's candle jj (the entry's) is known only at the end of the small candles."""
    __slots__ = ('ph', 'phv', 'phc', 'pl', 'plv', 'plc')
    last_swing_high = structure.Structure.last_swing_high

    def __init__(self, st, jj, m):
        def mp(x):
            return x - jj - 1 if x < jj else (m - 1 if x == jj else m + x - jj - 1)
        self.ph = [mp(x) for x in st.ph]
        self.phv = list(st.phv)
        self.phc = [mp(x) for x in st.phc]
        self.pl = [mp(x) for x in st.pl]
        self.plv = list(st.plv)
        self.plc = [mp(x) for x in st.plc]


def ltf_text(P, lt, ev, cs, i, jj, kind, fvg, order=None, low_stop=None):
    """'15m CHoCH 2025-04-14 11:30 above 145.20 (2 lower highs / lows, final low 143.10 at 2025-04-14 10:45) · bought at its
    close · 1 candle after the signal' (the trades list). The Smart entry says which of its three ways it took and where the
    stop went (low_stop True = under the small final low)."""
    b, hi, lvl, li, lf, d = ev
    lab = lambda k: '%s %02d:%02d' % ((date.fromordinal(lt.day[k]).isoformat(),) + divmod(lt.minute[k], 60)) if P['ltf'] != 'D' else \
        date.fromordinal(lt.day[k]).isoformat()
    txt = '%s CHoCH %s above %.2f%s (%d lower highs / lows, final low %.2f at %s)' % (
        P['ltf'], lab(int(b)), _f(lvl), ' (protected high)' if P.get('ltfChoch') == 'protected' else '', int(d), _f(lf), lab(int(li)))
    if P.get('ltfEntry') == 'smart':
        txt += {'close': ' · its level in the zone - bought at its close',
                'fvg': ' · above the zone - bought at its FVG top %.2f (retest)' % _f(order or 0),
                'half': ' · above the zone, no small FVG - bought at the 50%% line %.2f of its move (retest)' % _f(order or 0)}[kind]
        txt += ' · stop under the small final low' if low_stop else ' · stop under the zone (your stop rule)'
    else:
        txt += ' · bought at its close' if kind == 'close' else ' · bought at its FVG top %.2f (retest)' % _f(fvg[1])
    w = jj - i
    return txt + (' · in the signal candle' if w == 0 else ' · %d candle%s after the signal' % (w, '' if w == 1 else 's'))


class CandleArrays:
    """Candle dicts ({'t', 'day', 'o', 'h', 'l', 'c'[, 'v']} - the daily scan's) as the arrays ltf_find reads (day ordinal,
    minute of the day, o h l c v)."""
    __slots__ = ('o', 'h', 'l', 'c', 'v', 'day', 'minute', 'n')

    def __init__(self, cands, intraday):
        self.day = [date.fromisoformat(c['day'][:10]).toordinal() for c in cands]
        self.minute = [_minute(c['t']) if intraday else 0 for c in cands]
        self.o, self.h = [c['o'] for c in cands], [c['h'] for c in cands]
        self.l, self.c = [c['l'] for c in cands], [c['c'] for c in cands]
        self.v = [float(c.get('v') or 0) for c in cands]
        self.n = len(cands)


def ltf_find(cs, i, zb, zt, P, lt, events):
    """The small CHoCH that confirms a signal on candle i of the chart cs (timeframe P['tf']) in the zone zb .. zt (zb = the
    bottom the stop sits under): the first CHoCH event of lt (`events` = structure.choch_events of the small candles, the run's
    ltfPivot) in the time of candles i .. i + ltfWait - 1, with >= ltfDown lower highs / lows, its final low formed from the
    signal candle on, at / under the zone top and at most ltfUnder % under its bottom, no candle of the chart closing under
    the zone before the one it is in -> (event, jj = the chart's candle it is in, None) or (None, None, reason: 'ltfdata' /
    'ltfnone' / 'ltfbroke' / 'ltfnotyet'). Used by the Backtest Lab (ltf_trade) and the daily scan (kite_intraday)."""
    tf = P['tf']
    w0 = htf_span(tf, cs.day[i], cs.minute[i])[0]
    jw = min(cs.n - 1, i + P['ltfWait'] - 1)
    w1 = htf_span(tf, cs.day[jw], cs.minute[jw])[1]
    if lt is None or not lt.n or lt.day[0] > cs.day[i]:
        return None, None, 'ltfdata'             # the small candles begin after the signal (Kite has none that old)
    a = _first_at(lt, w0)
    if a >= lt.n or lt.day[a] * 1440 + lt.minute[a] >= htf_span(tf, cs.day[i], cs.minute[i])[1]:
        return None, None, 'ltfdata'             # none in the signal candle's time (a gap in the small candles)
    z = _first_at(lt, w1)
    floor = zb * (1 - P['ltfUnder'] / 100.0) if P['ltfUnder'] < 100 else -1e18
    anywhere = P.get('ltfEntry') == 'smart'      # the Smart entry: the small final low may be anywhere (owner, 14-Nov-2026)
    k = bisect.bisect_left([e[0] for e in events], a)
    hit = None
    while k < len(events) and events[k][0] < z:
        e = events[k]
        if e[5] >= P['ltfDown'] and e[3] >= a and (anywhere or (_f(e[4]) <= zt + 1e-9 and _f(e[4]) >= floor - 1e-9)):
            hit = e
            break
        k += 1
    if hit is None:
        broke = any(_f(cs.c[j]) < zb - 1e-9 for j in range(i, jw + 1))
        if broke:
            return None, None, 'ltfbroke'
        if z >= lt.n or i + P['ltfWait'] - 1 >= cs.n:
            return None, None, 'ltfnotyet'
        return None, None, 'ltfnone'
    jj = chart_candle(cs, i, tf, lt, int(hit[0]))
    if any(_f(cs.c[j]) < zb - 1e-9 for j in range(i, jj)):
        return None, None, 'ltfbroke'            # a candle of the chart closed under the zone before the small CHoCH
    return hit, jj, None


def chart_candle(cs, i, tf, lt, kx):
    """The chart's candle (from i on) the small candle kx is in."""
    key = lt.day[kx] * 1440 + lt.minute[kx]
    j = i
    while j < cs.n - 1 and htf_span(tf, cs.day[j], cs.minute[j])[1] <= key:
        j += 1
    return j


def ltf_trade(cs, i, row, rs, P, lt, events, ema=None, swing=None, atr=None, lows=None, final=None, mh=None, alt=None):
    """The lower-timeframe confirmation of one signal (see DEFAULTS 'ltf') -> (trade, None) or (None, reason): ltf_find's
    reasons, 'ltfnofvg' / 'ltfnofill' (the FVG entry: no small FVG in its move / not retested in time), 'ltfmissed' (the
    Smart entry: price reached the target before the order filled - its trade bought at the small CHoCH's close instead is
    added to `alt`), or simulate's own. row / rs = the signal row and its stop row (rs[2] = the bottom the stop sits under)."""
    tf = P['tf']
    zb, zt = rs[2], row[3]
    if zb is None or zt is None:
        return None, 'ltfnone'
    hit, jj, why = ltf_find(cs, i, zb, zt, P, lt, events)
    if hit is None:
        return None, why
    b, lf, li = int(hit[0]), _f(hit[4]), int(hit[3])
    jw = min(cs.n - 1, i + P['ltfWait'] - 1)
    z = _first_at(lt, htf_span(tf, cs.day[jw], cs.minute[jw])[1])
    smart = P['ltfEntry'] == 'smart'

    def stop_for(entry, low_stop):
        """The stop of an entry: under the small final low, or the run's own stop rule -> (stop, by) or (None, why)."""
        if low_stop:
            stop = lf * (1 - P['stopBuf'] / 100.0)
        else:
            mode = P['stop']
            if mode == 'pct':
                stop = entry * (1 - P['stopPct'] / 100.0)
            elif mode == 'final':
                if final is None:
                    return None, 'nofinal'
                stop = _f(final) * (1 - P['stopBuf'] / 100.0)
            elif mode == 'spring':
                stop = _f(cs.l[i]) * (1 - P['stopBuf'] / 100.0)
            elif mode == 'lower':
                stop = min(_f(cs.l[i]), zb) * (1 - P['stopBuf'] / 100.0)
            else:
                stop = zb * (1 - P['stopBuf'] / 100.0)
        by = ''
        if P['stopAtr']:
            if atr is None or jj - 1 < 0:
                return None, 'data'
            s_atr = entry - P['stopAtr'] * atr[jj - 1]
            by = 'rule'
            if s_atr < stop:
                stop, by = s_atr, 'atr'
        return stop, by

    def finish(e0, jj, kind, order, fvg, low_stop):
        """The trade bought on small candle e0 (in the chart's candle jj): at the order price (a retest - the open when it
        gapped under it) or at e0's close."""
        zend = _first_at(lt, htf_span(tf, cs.day[jj], cs.minute[jj])[1])
        hy = _Hybrid(lt, e0, max(e0 + 1, zend), cs, jj + 1)
        m = max(e0 + 1, zend) - e0
        entry = min(_f(lt.o[e0]), order) if order is not None else _f(lt.c[e0])
        if smart:
            low_stop = entry > zt + 1e-9       # bought above the zone top: under the small final low; in the zone: your stop
        stop, stop_by = stop_for(entry, low_stop)
        if stop is None:
            return None, stop_by
        pad = lambda ser: ([ser[jj - 1]] * m + list(ser[jj + 1:])) if ser is not None and jj >= 1 else None
        P2 = dict(P, stop='pct', stopAtr=0, entry='zone' if order is not None else 'close')
        hrow = [0, 'Z' if order is not None else row[1], None, order if order is not None else row[3]] + list(row[4:8])
        t, why = simulate(hy, hrow, P2, pad(ema), _Remap(swing, jj, m) if swing is not None else None, pad(atr),
                          _Remap(lows, jj, m) if lows is not None else None, None, mh, stop_at=stop)
        if t is None:
            return None, why
        t['stopBy'] = stop_by
        t['i'] = i
        jx = t['jx']
        t['jx'] = jj if jx < m else jj + 1 + (jx - m)
        t['sigDay'], t['sigMin'] = cs.day[i], cs.minute[i]
        t['ltf'] = ltf_text(P, lt, hit, cs, i, jj, kind, fvg, order, low_stop)
        t['ltfWait'] = jj - i
        t['lx'] = {'tf': P['ltf'], 'b': b, 'li': li, 'lvl': _f(hit[2]), 'lf': lf, 'hi': int(hit[1]), 'd': int(hit[5]), 'e': e0, 'jj': jj,
                   'fvg': list(fvg) if fvg else None}
        if smart:
            t['ltfHow'] = kind
            t['lx']['how'], t['lx']['order'], t['lx']['lowStop'] = kind, order, bool(low_stop)
            if kind == 'half':
                t['lx']['half'] = [lf, half_hi]
        return t, None

    if smart:
        # the Smart entry (owner, 14-Nov-2026): the small CHoCH's level in the zone -> at its close
        if _f(hit[2]) <= zt + 1e-9:
            return finish(b, jj, 'close', None, None, _f(lt.c[b]) > zt + 1e-9)
        # above the zone: an order at the highest small FVG of its move (the CHoCH candle's own gap is known one candle later -
        # the order waits from the candle after the FVG's 3rd one), else - known once that candle shows none - at the move's 50%
        # line (final low .. the highest high up to the CHoCH candle)
        best = None
        for f in range(max(li + 2, 2), min(b + 1, lt.n - 1) + 1):
            if _f(lt.l[f]) > _f(lt.h[f - 2]) and (best is None or _f(lt.l[f]) > best[1]):
                best = (_f(lt.h[f - 2]), _f(lt.l[f]), f)
        half_hi = max(_f(lt.h[x]) for x in range(li, b + 1))
        if best is not None:
            kind, order, start = 'fvg', best[1], max(b, best[2]) + 1
        else:
            kind, order, start = 'half', round((lf + half_hi) / 2.0, 2), b + 2
        low_o = order > zt + 1e-9
        stop_o, _ = stop_for(order, low_o)
        tgt = None
        if stop_o is not None and order > stop_o:
            if P['targetMode'] == 'R':
                tgt = order + P['targetR'] * (order - stop_o)
            elif P['targetMode'] == 'pct':
                tgt = order * (1 + P['targetPct'] / 100.0)
            elif P['targetMode'] == 'mh' and mh is not None:
                tgt = _f(mh)
        jc, e0 = jj, None
        for m in range(start, min(z, lt.n)):
            jm = chart_candle(cs, i, tf, lt, m)
            while jc < jm:                       # a candle of the chart closed under the zone: the order is cancelled
                if _f(cs.c[jc]) < zb - 1e-9:
                    return None, 'ltfbroke'
                jc += 1
            if _f(lt.l[m]) <= order + 1e-9:
                e0 = m
                break
            if tgt is not None and _f(lt.h[m]) >= tgt - 1e-9:
                if alt is not None:             # what buying at the small CHoCH's close would have made
                    ta, _ = finish(b, jj, 'close', None, None, _f(lt.c[b]) > zt + 1e-9)
                    if ta is not None:
                        alt.append(ta)
                return None, 'ltfmissed'
        if e0 is None:
            if z >= lt.n or i + P['ltfWait'] - 1 >= cs.n:
                return None, 'ltfnotyet'
            return None, 'ltfnofill'
        return finish(e0, chart_candle(cs, i, tf, lt, e0), kind, order, best, low_o)

    fvg, e0 = None, b
    if P['ltfEntry'] == 'fvg':
        best = None
        for f in range(max(li + 2, 2), min(b + 1, lt.n - 1) + 1):
            if _f(lt.l[f]) > _f(lt.h[f - 2]) and (best is None or _f(lt.l[f]) > best[1]):
                best = (_f(lt.h[f - 2]), _f(lt.l[f]), f)
        if best is None:
            return None, 'ltfnofvg'
        fvg = best
        e0 = None
        for m in range(max(b, best[2]) + 1, min(z, lt.n)):
            if _f(lt.l[m]) <= best[1]:
                e0 = m
                break
            if _f(lt.c[m]) < lf:
                break                            # the small CHoCH failed before the retest
        if e0 is None:
            return None, 'ltfnofill'
        jj = chart_candle(cs, i, tf, lt, e0)
        if any(_f(cs.c[j]) < zb - 1e-9 for j in range(i, jj)):
            return None, 'ltfbroke'
    half_hi = None
    return finish(e0, jj, 'fvg' if fvg else 'close', fvg[1] if fvg else None, fvg, P['ltfStop'] == 'ltf')


def ltf_compare(rows, P):
    """The confirmation against no confirmation on the same signals (owner, 13-Nov-2026: the Lab shows which is better):
    rows = [(trade without it, trade with it or None, why not[, the Smart entry's missed trade bought at the CHoCH's close])]
    per signal candle; signals without small candles for that time ('ltfdata') or still waiting ('ltfnotyet') are left out
    of both -> {'tf', 'name', 'signals', 'confirmed', 'why', 'nodata', 'notyet', 'with', 'without', 'withoutConfirmed',
    'from'} + with the Smart entry (14-Nov-2026) 'missed' (orders price ran away from - the target came first),
    'missedAtClose' (those signals bought at the small CHoCH's close instead) and 'byHow' {close / fvg / half: figures}."""
    use = [x for x in rows if x[2] not in ('ltfdata', 'ltfnotyet')]
    why = {}
    for x in use:
        if x[1] is None:
            why[x[2] or 'other'] = why.get(x[2] or 'other', 0) + 1
    closed = lambda ts: [t for t in ts if t is not None and t['reason'] != 'open']

    def st(ts):
        s = _stats(closed(ts))
        if s['trades']:
            s['avgRLo'], s['avgRHi'] = _range([t['R'] for t in closed(ts)])
            s['edge'] = _edge(s['trades'], s['avgRLo'], s['avgRHi'])
        return s
    first = min((x[0]['sigDay'] for x in use), default=None)
    out = {'tf': P['ltf'], 'name': LTF_NAMES.get(P['ltf'], P['ltf']), 'signals': len(use),
           'confirmed': sum(1 for x in use if x[1] is not None), 'why': why,
           'nodata': sum(1 for x in rows if x[2] == 'ltfdata'), 'notyet': sum(1 for x in rows if x[2] == 'ltfnotyet'),
           'with': st([x[1] for x in use]), 'without': st([x[0] for x in use]),
           'withoutConfirmed': st([x[0] for x in use if x[1] is not None]),
           'from': date.fromordinal(first).isoformat() if first else ''}
    if P.get('ltfEntry') == 'smart':
        out['missed'] = sum(1 for x in use if x[2] == 'ltfmissed')
        out['missedAtClose'] = st([x[3] for x in use if len(x) > 3 and x[3] is not None])
        out['byHow'] = {h: dict(st([x[1] for x in use if x[1] is not None and x[1].get('ltfHow') == h]),
                                n=sum(1 for x in use if x[1] is not None and x[1].get('ltfHow') == h)) for h in LTF_HOW}
    return out


def _exit_why(cur, entry, target, lock):
    """The exit reason of a stop at `cur` after the target was reached."""
    if lock and abs(cur - target) <= 1e-9 * max(1.0, abs(target)):
        return 'lock'
    return 'trail' if cur > entry * (1 + 1e-9) else 'be' if cur >= entry * (1 - 1e-9) else 'stop'


def size_zone(r, P):
    """(bottom, top) of the zone a row's size / dark-cloud rules look at: a Gap-up zone inside an FVG (gapEntry) = that FVG."""
    if r[1] == 'Y' and P.get('gapEntry') and len(r) > 9 and r[9]:
        return r[9][0], r[9][1]
    return r[2], r[3]


def pick(rows, P):
    """The signal rows of the chosen group (and touch / turnover filters), in candle order - a candle may have several (a
    Spring on an FVG and on a Gap-up zone, several zones first touched at once): run_job takes the first of a candle that
    passes every rule (one trade a candle)."""
    g = P['group']
    fp = P.get('fibPat', 'off')
    big_pct = P.get('zoneMax') or BIG_ZONE_PCT
    out = []
    for r in rows:
        code, where, touch, inside = r[1], r[4], r[5], r[6]
        ok = ((g == 'spring' and code == 'S') or
              (g == 'fvg' and code == 'F') or
              (g.startswith('fvg_') and code == 'F' and where == g[4]) or
              (g == 'gap' and code == 'G') or
              (g == 'gapin' and code == 'G' and inside) or
              (g == 'zone' and code in ('F', 'G')) or
              (g == 'ft' and code == 'T') or
              (g == 'conf' and code == 'C') or
              (g == 'entry' and code in ('F', 'G', 'T', 'C')) or
              (g == 'touch' and code in ('Z', 'Y')) or
              (g == 'touch' and code in FIB_CODES and fp != 'off'))
        if not ok:
            continue
        if g == 'touch' and fp != 'off':
            # Fib + pattern (12-Nov-2026): 'all' = every zone by the pattern at its Fib line; 'big' = the zones bigger than
            # the size limit by the pattern, the rest by the zone-top touch
            zb, zt = size_zone(r, P)
            big = zone_pct(zb, zt) is not None and zone_pct(zb, zt) > big_pct
            if (code in FIB_CODES) != (fp == 'all' or big):
                continue
        if P['maxTouch'] and code != 'S' and touch > P['maxTouch']:
            continue
        if P['minTurnover'] and (r[7] or 0) < P['minTurnover']:
            continue
        out.append(r)
    return out


# ------------------------------------------------------------------ the account + figures
def _rs(v, d=0):
    """Rupees with Indian grouping (12,34,567); d decimals at most (trailing zeros dropped)."""
    neg = v < 0
    whole, _, frac = ('%.*f' % (d, abs(v))).partition('.')
    if len(whole) > 3:
        head, parts = whole[:-3], []
        while len(head) > 2:
            parts.insert(0, head[-2:])
            head = head[:-2]
        whole = ','.join(([head] if head else []) + parts) + ',' + whole[-3:]
    frac = frac.rstrip('0')
    return ('-' if neg else '') + whole + ('.' + frac if frac else '')


def portfolio(trades, P):
    """Trades in time order -> each taken one gets qty / pnl (rupees); at most maxOpen at once. -> summary dict."""
    cap = P['capital']
    eq = cap
    heap, still, realized, skipped, seq, blown, capped = [], [], [], 0, 0, None, 0
    why = {'full': 0, 'cap': 0, 'risk': 0, 'blown': 0}
    order = sorted(trades, key=lambda t: (t['ek'], t['sym']))
    for t in order:
        while heap and heap[0][0] <= t['ek']:    # positions sold before (or when) this one is bought
            o = heapq.heappop(heap)[2]
            eq += o['pnl']
            realized.append(o)
        t['qty'], t['pnl'], t['taken'], t['acct'] = 0, 0, 0, ''
        # why a signal is not taken (owner, 09-Nov-2026: "more trades were skipped in the account, I don't know why -
        # show the reason when I place the cursor on the word skipped")
        if eq <= 0:                              # the account is gone: no more trades
            blown = blown or date.fromordinal(t['ek'][0]).isoformat()
            skipped += 1
            why['blown'] += 1
            t['acct'] = 'Not taken: the account had run out (Rs %s).' % _rs(eq)
            continue
        if len(heap) + len(still) >= P['maxOpen']:
            skipped += 1
            why['full'] += 1
            t['acct'] = ('Not taken: %d trades were already open - your limit is %d at once (Money: "Trades open at once, '
                         'at most").' % (len(heap) + len(still), P['maxOpen']))
            continue
        base = eq if P['compound'] else cap
        risk_amt = base * P['riskPct'] / 100.0
        pos_amt = base * P['maxPosPct'] / 100.0
        qty_r = int(risk_amt // t['risk'])
        qty_c = int(pos_amt // t['entry'])
        qty = min(qty_r, qty_c)
        if qty_r < 1:
            skipped += 1
            why['risk'] += 1
            t['acct'] = ('Not taken: one share risks Rs %s (entry %s - stop %s), more than your risk per trade of Rs %s '
                         '(%g%% of the account).' % (_rs(t['risk'], 2), _rs(t['entry'], 2), _rs(t.get('stop', t['entry'] - t['risk']), 2),
                                                     _rs(risk_amt), P['riskPct']))
            continue
        if qty_c < 1:
            skipped += 1
            why['cap'] += 1
            t['acct'] = ('Not taken: one share costs Rs %s, more than your position limit of Rs %s (%g%% of the account, '
                         'Money: "One position at most").' % (_rs(t['entry'], 2), _rs(pos_amt), P['maxPosPct']))
            continue
        t['acct'] = '%d shares, Rs %s invested, Rs %s at risk' % (qty, _rs(qty * t['entry']), _rs(qty * t['risk']))
        if qty_c < qty_r:
            capped += 1
            t['acct'] += (' - made smaller by your position limit of %g%% (the full %g%% risk would be %d shares)'
                          % (P['maxPosPct'], P['riskPct'], qty_r))
        t['acct'] += '.'
        t['qty'] = qty
        t['pnl'] = round(qty * (t['exit'] - t['entry']) - P['cost'] / 100.0 * qty * t['entry'], 2)
        t['taken'] = 1
        if t['reason'] == 'open':
            still.append(t)                      # still running: never sold, so it keeps its place
        else:
            seq += 1
            heapq.heappush(heap, (t['xk'], seq, t))
    while heap:
        o = heapq.heappop(heap)[2]
        eq += o['pnl']
        realized.append(o)
    realized.sort(key=lambda o: o['xk'])
    curve, peak, dd, e = [], cap, 0.0, cap
    for o in realized:
        e += o['pnl']
        peak = max(peak, e)
        dd = min(100.0, max(dd, (peak - e) / peak * 100 if peak > 0 else 0))
        curve.append([date.fromordinal(o['xk'][0]).isoformat(), round(e)])
    if len(curve) > CURVE_POINTS:            # thinned, keeping the last point of each step
        step = len(curve) / float(CURVE_POINTS)
        curve = [curve[min(len(curve) - 1, int((k + 1) * step) - 1)] for k in range(CURVE_POINTS)]
    first = min((o['ek'][0] for o in realized), default=None)
    last = max((o['xk'][0] for o in realized), default=None)
    years = (last - first) / 365.25 if first and last and last > first else 0
    final = e
    cagr = ((final / cap) ** (1 / years) - 1) * 100 if years >= 0.25 and final > 0 else None
    return {'capital': cap, 'final': round(final), 'pnl': round(final - cap), 'returnPct': round((final - cap) / cap * 100, 2),
            'cagr': round(cagr, 2) if cagr is not None else None, 'maxDD': round(dd, 2), 'taken': len(realized) + len(still),
            'skipped': skipped, 'openNow': len(still), 'openPnl': round(sum(o['qty'] * (o['exit'] - o['entry']) for o in still)),
            'years': round(years, 1), 'curve': curve, 'blown': blown, 'skipReasons': why, 'capped': capped}


def _stats(ts):
    rs = [t['R'] for t in ts]
    n = len(rs)
    if not n:
        return {'trades': 0}
    wins = [r for r in rs if r > 0]
    losses = [r for r in rs if r <= 0]
    streak = worst = 0
    for t in sorted(ts, key=lambda t: t['ek']):
        streak = streak + 1 if t['R'] <= 0 else 0
        worst = max(worst, streak)
    gain, loss = sum(wins), -sum(losses)
    return {'trades': n, 'winPct': round(len(wins) * 100.0 / n, 1), 'avgR': round(sum(rs) / n, 3),
            'medR': round(statistics.median(rs), 3), 'totalR': round(sum(rs), 1),
            'pf': round(gain / loss, 2) if loss > 0 else None,
            'avgWinR': round(gain / len(wins), 2) if wins else None, 'avgLossR': round(-loss / len(losses), 2) if losses else None,
            'hitPct': round(sum(1 for t in ts if t['hit']) * 100.0 / n, 1),
            'avgRet': round(sum(t['ret'] for t in ts) / n, 2), 'medRet': round(statistics.median([t['ret'] for t in ts]), 2),
            'avgDays': round(sum(t['days'] for t in ts) / n, 1), 'bestR': round(max(rs), 2), 'worstR': round(min(rs), 2),
            'avgMaxR': round(sum(t['maxR'] for t in ts) / n, 2), 'maxLosingStreak': worst}


HIST_EDGES = [(-1e9, -1, '< -1R'), (-1, 0, '-1R to 0'), (0, 1, '0 to 1R'), (1, 2, '1R to 2R'), (2, 3, '2R to 3R'),
              (3, 5, '3R to 5R'), (5, 10, '5R to 10R'), (10, 1e9, '10R +')]


def summarise(trades, P, skips, meta, secs):
    closed = [t for t in trades if t['reason'] != 'open']
    acct = portfolio(trades, P)
    by_year = {}
    for t in closed:
        y = date.fromordinal(t['sigDay']).year
        a = by_year.setdefault(y, [])
        a.append(t)
    years = []
    for y in sorted(by_year):
        s = _stats(by_year[y])
        taken = [t for t in by_year[y] if t['taken']]
        years.append({'year': y, 'trades': s['trades'], 'winPct': s['winPct'], 'avgR': s['avgR'], 'totalR': s['totalR'],
                      'pnl': round(sum(t['pnl'] for t in taken)), 'taken': len(taken)})
    hist = [{'label': lab, 'n': sum(1 for t in closed if lo <= t['R'] < hi)} for lo, hi, lab in HIST_EDGES]
    reasons = {r: sum(1 for t in trades if t['reason'] == r) for r in REASONS}
    # market structure: the same figures per stage (owner, 10-Nov-2026: "if FVG formed above the BOS means it is already
    # moved heavily" - one run shows whether the setup below the CHoCH level beats the others)
    stages = []
    if any(t.get('stage') for t in trades):
        both = P.get('setup') == 'both'
        for sn in (run_setups(P) if both else [None]):
            names = structure.BOS_STAGE_NAMES if (sn or P.get('setup')) == 'bos' else structure.STAGE_NAMES
            for key in structure.STAGES:
                ts = [t for t in closed if t.get('stage') == key and (not both or t.get('setup') == sn)]
                n_open = sum(1 for t in trades if t.get('stage') == key and t['reason'] == 'open' and (not both or t.get('setup') == sn))
                if not ts and not n_open:
                    continue
                s = _stats(ts)
                row = {'stage': key, 'name': ((SETUP_NAMES[sn] + ': ') if both else '') + names[key], 'trades': s['trades'],
                       'open': n_open, 'winPct': s.get('winPct'), 'avgR': s.get('avgR'), 'medR': s.get('medR'),
                       'totalR': s.get('totalR'), 'hitPct': s.get('hitPct'), 'avgMaxR': s.get('avgMaxR')}
                if both:
                    row['setup'] = sn
                stages.append(row)
    zone_name = ZONE_NAMES
    where_name = {'t': 'top', 'm': 'middle', 'b': 'bottom'}
    rows = []
    for t in sorted(trades, key=lambda t: (t['sigDay'], t['sigMin'], t['sym']), reverse=True)[:MAX_TRADES_OUT]:
        rows.append([t['sym'], _label(P['tf'], t['sigDay'], t['sigMin']),
                     (t.get('pname') or zone_name[t['code']]) + (' inside FVG' if t['code'] in ('G', 'Y', 'Q') and (t['inside'] or t.get('fz')) else '') +
                     (' (again after the CHoCH)' if t.get('again') else ''),
                     where_name.get(t['where'], ''), t['touch'] or '', t['entry'], t['stop'], t['riskPct'], round(t['exit'], 2),
                     _label(P['tf'], t['xk'][0], t['xk'][1]), t['reason'], t['R'], t['ret'], t['days'], t['maxR'],
                     t['qty'], t['pnl'], t['taken'], t.get('ema', ''), t.get('upW', ''), t.get('loW', ''), t.get('dip', ''),
                     t.get('stage', ''), t.get('struct', ''), t.get('tgt', ''), t.get('acct', ''),
                     int(round(t['depth'] * 100)) if t.get('depth') is not None else '', t.get('lhll', ''), t.get('lag', ''),
                     t.get('zpct', ''), t.get('pat', ''), t.get('zn', ''), t.get('mv', ''), t.get('mit', ''),
                     ('%g%% at %s' % (t['partPct'], _rs(t['part'], 2))) if t.get('part') is not None else '', t.get('stopBy', ''),
                     t.get('ltf', ''), t.get('ltfWait', ''), t.get('baseR', ''), t.get('setup', ''), t.get('ltfHow', '')])
    first = min((t['sigDay'] for t in trades), default=None)
    last = max((t['sigDay'] for t in trades), default=None)
    stats = _stats(closed)
    lo_r, hi_r = _range([t['R'] for t in closed])
    if stats['trades']:
        stats['avgRLo'], stats['avgRHi'] = lo_r, hi_r
        stats['edge'] = _edge(stats['trades'], lo_r, hi_r)
    split = _split(closed, P)
    rolling = _rolling(closed, P['rollYears'])
    gname = GROUP_NAMES[P['group']]
    if P['group'] == 'pattern':
        gname += ': %s %s' % (P['pattern'], pattern_registry.by_id()[P['pattern']]['name'])
    return {'v': 1, 'params': P, 'groupName': gname, 'cacheUpto': meta.get('upto'), 'warnings': [SURVIVORSHIP],
            'from': date.fromordinal(first).isoformat() if first else '', 'to': date.fromordinal(last).isoformat() if last else '',
            'stats': stats, 'open': len(trades) - len(closed), 'skipped': skips, 'account': acct, 'years': years,
            'hist': hist, 'reasons': reasons, 'tradeCols': TRADE_COLS, 'trades': rows, 'tradesTotal': len(trades),
            'stages': stages, 'breakdowns': breakdowns(closed, P), 'split': split, 'rolling': rolling, 'secs': round(secs, 1)}


# ------------------------------------------------------------------ "real or chance?" + the breakdowns + the dev / test split
# (owner, 12-Nov-2026, after a ChatGPT review of his 405-trade run: zone depth 60-70 % weak and 70-90 % strong, 4 lower highs /
# lows better than 3, a signal 0-10 days after the CHoCH weak; "yes do it" to: the same figures in every run, with a range
# that says whether a difference can be luck, and a development / test split)
Z90 = 1.645                  # the likely range of an average = average +/- 1.645 x its standard error (90 %)
BD_MIN = 30                  # a group with fewer closed trades: 'few' (no verdict)
BD_HELD_MIN = 10             # the dev / test check needs this many trades in both periods
BD_DIMS = (
    ('setup', 'Setup', 'cat', (('choch', 'CHoCH + FVG'), ('bos', 'BOS + FVG'))),
    ('ltfHow', 'Lower-timeframe entry (Smart)', 'cat',
     (('close', 'small CHoCH in the zone - at its close'), ('fvg', 'above the zone - small FVG retest'),
      ('half', 'above the zone - 50% line retest'))),
    ('depth', 'Zone depth in the move (0% = the move high, 100% = the final low)', 'num',
     ((-1e9, 0.382, 'above the 38.2% line'), (0.382, 0.5, '38.2 - 50%'), (0.5, 0.618, '50 - 61.8%'), (0.618, 0.705, '61.8 - 70.5%'),
      (0.705, 0.786, '70.5 - 78.6%'), (0.786, 0.9, '78.6 - 90%'), (0.9, 1.0 + 1e-9, '90 - 100%'), (1.0 + 1e-9, 1e9, 'under the final low'))),
    ('lhll', 'Lower highs / lows before the CHoCH', 'num',
     ((1, 2, '1'), (2, 3, '2'), (3, 4, '3'), (4, 5, '4'), (5, 6, '5'), (6, 1e9, '6 or more'))),
    ('lag', 'Days from the CHoCH candle to the signal', 'num',
     ((0, 6, '0 - 5 days'), (6, 11, '6 - 10 days'), (11, 21, '11 - 20 days'), (21, 41, '21 - 40 days'), (41, 61, '41 - 60 days'),
      (61, 121, '61 - 120 days'), (121, 1e9, 'over 120 days'))),
    ('where', 'How deep the signal candle went into the zone', 'cat',
     (('t', 'top half'), ('m', 'middle (lower half)'), ('b', 'to / under the bottom'))),
    ('zone', 'Zone kind', 'cat',
     (('FVG', 'FVG'), ('Gap-up', 'Gap-up'), ('Gap-up inside FVG', 'Gap-up inside FVG'), ('none', 'no zone (Spring only)'))),
    ('touch', 'Touch of the zone', 'num', ((1, 2, '1st touch'), (2, 3, '2nd'), (3, 4, '3rd'), (4, 1e9, '4th or later'))),
    ('risk', 'Risk (entry to stop)', 'num',
     ((0, 2, 'under 2%'), (2, 4, '2 - 4%'), (4, 6, '4 - 6%'), (6, 8, '6 - 8%'), (8, 10, '8 - 10%'), (10, 15, '10 - 15%'), (15, 1e9, '15% or more'))),
    ('zpct', 'Zone size (top - bottom, % of the bottom)', 'num',
     ((0, 1, 'under 1%'), (1, 2, '1 - 2%'), (2, 4, '2 - 4%'), (4, 6, '4 - 6%'), (6, 8, '6 - 8%'), (8, 10, '8 - 10%'), (10, 1e9, '10% or more'))),
    ('mv', 'Biggest volume in the CHoCH move (x the 20 candles before it)', 'num',
     ((0, 1.5, 'under 1.5x'), (1.5, 2, '1.5 - 2x'), (2, 3, '2 - 3x'), (3, 5, '3 - 5x'), (5, 10, '5 - 10x'), (10, 1e12, '10x or more'))),
    ('zn', 'Which discount zone of the CHoCH move', 'num', ((1, 2, '1st (the only / the higher one)'), (2, 3, '2nd'), (3, 1e9, '3rd or deeper'))),
    ('ltfWait', 'Candles from the signal to the lower-timeframe CHoCH', 'num',
     ((0, 1, 'in the signal candle'), (1, 2, '1 candle after'), (2, 3, '2 after'), (3, 5, '3 - 4 after'), (5, 1e9, '5 or more after'))),
    ('turn', 'Average daily turnover (20 days)', 'num',
     ((0, 50, 'under ₹50 lakh'), (50, 200, '₹50 lakh - 2 Cr'), (200, 1000, '₹2 - 10 Cr'), (1000, 5000, '₹10 - 50 Cr'), (5000, 1e12, '₹50 Cr or more'))),
)


def _bd_value(t, key):
    if key == 'zone':
        return ('Gap-up inside FVG' if t.get('inside') or t.get('fz') else 'Gap-up') if t['code'] in ('G', 'Y', 'Q') else 'FVG' \
            if t['code'] in FVG_CODES else 'none'
    if key == 'risk':
        return t.get('riskPct')
    if key == 'touch':
        return t.get('touch') or None
    if key == 'where':
        return t.get('where') if t.get('where') in ('t', 'm', 'b') else None
    if key in ('setup', 'ltfHow'):
        return t.get(key) or None
    v = t.get(key)
    return v if isinstance(v, (int, float)) and v == v else None


def _range(rs):
    """The likely range (90 %) of the average R of these results: (low, high), (None, None) under 2."""
    n = len(rs)
    if n < 2:
        return None, None
    m = sum(rs) / float(n)
    e = Z90 * statistics.stdev(rs) / math.sqrt(n)
    return round(m - e, 3), round(m + e, 3)


def _edge(n, lo, hi):
    """'real' (the whole range above 0), 'losing' (all under 0), 'chance' (it spans 0), 'few' (under BD_MIN trades)."""
    if n < BD_MIN or lo is None:
        return 'few'
    return 'real' if lo > 0 else 'losing' if hi < 0 else 'chance'


def _vs_rest(a, b):
    """Group a vs the rest b (R lists): 'better' / 'worse' when the difference of the averages is clear (90 %), else
    'chance'; 'few' when a has under BD_MIN trades or b under 2."""
    if len(a) < BD_MIN or len(b) < 2:
        return 'few'
    va, vb = statistics.variance(a), statistics.variance(b)
    se = math.sqrt(va / len(a) + vb / len(b))
    d = sum(a) / float(len(a)) - sum(b) / float(len(b))
    if se <= 0:
        return 'chance' if d == 0 else 'better' if d > 0 else 'worse'
    z = d / se
    return 'better' if z > Z90 else 'worse' if z < -Z90 else 'chance'


def _parts(ts, P):
    """[(part, trades)] of a run with testFrom set - ('dev', before valFrom / testFrom), ('val', valFrom .. testFrom, with
    valFrom), ('test', from testFrom) - else None."""
    if not P.get('testFrom'):
        return None
    at = date.fromisoformat(P['testFrom']).toordinal()
    if P.get('valFrom'):
        v = date.fromisoformat(P['valFrom']).toordinal()
        return [('dev', [t for t in ts if t['sigDay'] < v]), ('val', [t for t in ts if v <= t['sigDay'] < at]),
                ('test', [t for t in ts if t['sigDay'] >= at])]
    return [('dev', [t for t in ts if t['sigDay'] < at]), ('test', [t for t in ts if t['sigDay'] >= at])]


def _period(ts, P):
    """(development, test) trades of a run with testFrom set, else (None, None)."""
    parts = _parts(ts, P)
    if parts is None:
        return None, None
    return parts[0][1], parts[-1][1]


def _brief(ts):
    rs = [t['R'] for t in ts]
    if not rs:
        return {'trades': 0}
    lo, hi = _range(rs)
    return {'trades': len(rs), 'winPct': round(sum(1 for r in rs if r > 0) * 100.0 / len(rs), 1), 'avgR': round(sum(rs) / len(rs), 3),
            'lo': lo, 'hi': hi}


def breakdowns(closed, P):
    """The closed trades split by one feature at a time (BD_DIMS) -> [{'key', 'name', 'rows': [{'label', 'trades', 'winPct',
    'avgR', 'medR', 'totalR', 'hitPct', 'lo', 'hi', 'verdict' (vs the rest of the run: better / worse / chance / few),
    with testFrom also 'dev' / 'test' (+ 'val' with valFrom; {trades, winPct, avgR, lo, hi}) and 'held' ('yes' / 'no' / '' =
    too few: the group beat (or trailed) the rest in EVERY part)}]}] - a feature with fewer than 2 groups of trades is left out."""
    out = []
    for key, name, kind, bins in BD_DIMS:
        groups = []
        for b in bins:
            if kind == 'num':
                lo, hi, label = b
                ts = [t for t in closed if _bd_value(t, key) is not None and lo <= _bd_value(t, key) < hi]
            else:
                val, label = b
                ts = [t for t in closed if _bd_value(t, key) == val]
            if ts:
                groups.append((label, ts))
        if len(groups) < 2:
            continue
        rows = []
        keyed = [t for _, ts in groups for t in ts]
        for label, ts in groups:
            ids = set(id(t) for t in ts)
            rest = [t for t in keyed if id(t) not in ids]
            s = _stats(ts)
            lo, hi = _range([t['R'] for t in ts])
            row = {'label': label, 'trades': s['trades'], 'winPct': s['winPct'], 'avgR': s['avgR'], 'medR': s['medR'],
                   'totalR': s['totalR'], 'hitPct': s['hitPct'], 'lo': lo, 'hi': hi,
                   'verdict': _vs_rest([t['R'] for t in ts], [t['R'] for t in rest])}
            mine, theirs = _parts(ts, P), _parts(rest, P)
            if mine is not None:
                for (part, a), (_, b) in zip(mine, theirs):
                    row[part] = _brief(a)
                if all(len(a) >= BD_HELD_MIN and len(b) >= 2 for (_, a), (_, b) in zip(mine, theirs)):
                    sides = [sum(t['R'] for t in a) / len(a) - sum(t['R'] for t in b) / len(b) for (_, a), (_, b) in zip(mine, theirs)]
                    row['held'] = 'yes' if all(x > 0 for x in sides) or all(x < 0 for x in sides) else 'no'
                else:
                    row['held'] = ''
            rows.append(row)
        out.append({'key': key, 'name': name, 'rows': rows, 'trades': len(keyed)})
    return out


def _split(closed, P):
    """testFrom set: {'at', 'dev': figures of the development period (signals before it), 'test': the test period} - each
    {trades, winPct, avgR, medR, totalR, pf, hitPct, avgRLo, avgRHi, edge, from, to}; else None."""
    parts = _parts(closed, P)
    if parts is None:
        return None

    def part(ts):
        s = _stats(ts)
        if not s['trades']:
            return s
        lo, hi = _range([t['R'] for t in ts])
        s.update({'avgRLo': lo, 'avgRHi': hi, 'edge': _edge(s['trades'], lo, hi),
                  'from': date.fromordinal(min(t['sigDay'] for t in ts)).isoformat(),
                  'to': date.fromordinal(max(t['sigDay'] for t in ts)).isoformat()})
        return s
    out = {'at': P['testFrom'], 'val': P.get('valFrom') or ''}
    for key, ts in parts:
        out[{'dev': 'dev', 'val': 'valid', 'test': 'test'}[key]] = part(ts)
    return out


def _rolling(closed, years):
    """'Steady over time?': the figures of every `years`-year block from the first signal's year -> [{from, to, trades,
    winPct, avgR, lo, hi, edge}] (None with `years` 0 or fewer than two blocks)."""
    if not years or not closed:
        return None
    y0 = min(date.fromordinal(t['sigDay']).year for t in closed)
    y1 = max(date.fromordinal(t['sigDay']).year for t in closed)
    out = []
    for a in range(y0, y1 + 1, years):
        ts = [t for t in closed if a <= date.fromordinal(t['sigDay']).year < a + years]
        if not ts:
            continue
        b = _brief(ts)
        b.update({'from': a, 'to': min(a + years - 1, y1), 'edge': _edge(b['trades'], b['lo'], b['hi'])})
        out.append(b)
    return out if len(out) >= 2 else None


def run_job(params, base=None, progress=None, charts=None, name=''):
    """One Backtest Lab run on the cache -> the result (summarise). Raises LabError when there is no cache yet. `charts` = a
    folder: a PDF with a chart page per trade is made there (lab_charts.py; result 'pdf')."""
    t0 = time.time()
    unknown = {}
    P = clean_params(params, unknown)
    if 'group' in unknown or (P['group'] == 'pattern' and 'pattern' in unknown):
        what = ('pattern %s' % unknown['pattern']) if 'pattern' in unknown else ('signals "%s"' % unknown['group'])
        raise LabError('this laptop program does not know the %s - its program is older than the website. Extract the newest '
                       'ScreenerBridge.zip into the ScreenerBridge folder, then sign out of Windows and sign in again (or '
                       'restart) and run it again' % what)
    meta, d = load_meta(base)
    if not meta:
        raise LabError('no backtest cache on this computer yet')
    tf = P['tf']
    ltf_on = P['ltf'] != 'off'
    if ltf_on and not LTF_RANK[P['ltf']] < LTF_RANK[tf]:
        raise LabError('the confirmation timeframe (%s) must be smaller than the chart\'s (%s) - e.g. daily chart + 1-hour or '
                       '15-minute, weekly chart + daily' % (P['ltf'], tf))
    if ltf_on and P['group'] in ('pattern', 'spring'):
        raise LabError('the lower-timeframe confirmation needs a zone (FVG / Gap-up) - not "%s"' % GROUP_NAMES[P['group']])
    sigs = meta['signals'].get(tf) or {}
    index = meta['index'].get(tf) or {}
    lo = date.fromisoformat(P['from']).toordinal() if P['from'] else None
    hi = date.fromisoformat(P['to']).toordinal() if P['to'] else None
    trades, skips = [], {'risk': 0, 'gap': 0, 'price': 0, 'notyet': 0, 'data': 0, 'ema': 0, 'mkt': 0, 'shape': 0, 'struct': 0,
                         'noswing': 0, 'zoneentry': 0, 'where': 0, 'wk': 0, 'zsize': 0, 'dcloud': 0, 'gapin': 0, 'nofinal': 0,
                         'fiblevel': 0, 'nomh': 0}
    if ltf_on:
        skips.update({k: 0 for k in LTF_WHY})
    lset = _LtfSet(d, meta, P) if ltf_on else None
    cmp_rows = []                       # [(the trade without the confirmation, with it or None, why not)] per signal candle
    shape_on, shape_why, struct_why = shape_active(P), {}, {}
    smode = P['structure']
    sopts = struct_opts(P)
    setups = run_setups(P)
    trail_on = P['after'] == 'trail'
    final_stop = P['stop'] == 'final'
    again_on = P['touchAgain'] and smode == 'only' and P['group'] == 'touch'
    mh_tgt = P['targetMode'] == 'mh'
    need_struct = smode != 'off' or P['targetMode'] == 'swing' or (trail_on and P['trail'] == 'swing') or final_stop or mh_tgt
    if not need_struct:
        setups = setups[:1]                     # no market structure in the run: one pass
    smaps = ({sn: _struct_map(d, tf, P['pivotN'], sopts, struct_setup(dict(P, setup=sn))) for sn in setups}
             if need_struct else None)
    PC = dict(P, entry='close') if P['fibPat'] != 'off' else P      # Fib + pattern rows: bought at the pattern candle's close
    wk_index = (meta['index'].get('W') or {}) if P['wkAbove'] and tf != 'W' else None
    lens = ema_lens(P)
    mkt = market_filter(meta, P)
    fw = open(os.path.join(d, 'W.bin'), 'rb') if wk_index is not None else None
    pat_on = P['group'] == 'pattern'
    pat = _PatRows(d, tf, meta, P) if pat_on else None
    syms = sorted(index) if pat_on else sorted(sigs)
    fib = P['discount'] or None
    said = time.time()
    with open(os.path.join(d, tf + '.bin'), 'rb') as f:
        for k, sym in enumerate(syms):
            if pat_on:
                if sym not in index:
                    continue
                cs = Candles(f, index[sym][0], index[sym][1])
                rows = pat.rows(sym, cs)
                if not rows:
                    continue
            else:
                rows = pick(sigs.get(sym) or [], P)
                if not rows or sym not in index:
                    continue
                cs = Candles(f, index[sym][0], index[sym][1])
            ema = ema_series(cs.c, P['emaN']) if P['after'] == 'trail' and P['trail'] == 'ema' else None
            emas = {n: ema_series([_f(x) for x in cs.c], n) for n in lens}
            atr = (structure.atr_series([_f(x) for x in cs.h], [_f(x) for x in cs.l], [_f(x) for x in cs.c])
                   if (trail_on and P['trail'] == 'atr') or P['stopAtr'] else None)
            wk = week_filter(fw, wk_index.get(sym), P['wkAbove']) if wk_index is not None else None
            ltf_box = []                        # the stock's small candles + events, read when a signal first needs them

            def make_ctx(sn):
                """One setup's rules on this stock -> (attempt, its touchAgain rows or None)."""
                SP = P if len(setups) == 1 else dict(P, setup=sn)
                dn = setup_down(SP)
                st = None
                if smaps is not None:
                    sm = smaps[sn]
                    st = sm.get(sym)
                    if st is None or st.size != cs.n:
                        st = sm[sym] = _Struct(cs, P['pivotN'], sopts, struct_setup(SP))
                zl_memo = []
                again, xrows = None, None
                if again_on and st is not None:
                    # a zone touched on / before the CHoCH candle counts again after it (owner, 13-Nov-2026, SWIGGY)
                    again = st.rearm.get(dn)
                    if again is None:
                        zk = sorted(((x[1], int(x[8])), int(x[8]), x[2], x[3], x[0], x[1] == 'Y') for x in sigs[sym]
                                    if x[1] in ('Z', 'Y') and len(x) > 8 and x[8] is not None and x[8] >= 0)
                        zk.sort(key=lambda z: z[1])
                        lows_, his_ = [_f(x) for x in cs.l], [_f(x) for x in cs.h]       # the prices as the cache rows have them
                        again = st.rearm[dn] = rearm_touches(
                            st.s.events, dn, zk, lows_, [_f(x) for x in cs.c],
                            lambda j: lows_[j] > 0 and (his_[j] - lows_[j]) / lows_[j] * 100 <= LOCK_PCT)
                    if again:
                        byk = {(x[1], int(x[8])): x for x in sigs[sym] if x[1] in ('Z', 'Y') and len(x) > 8 and x[8] is not None and x[8] >= 0}
                        extra = []
                        for got in again.values():
                            for key, j in got.items():
                                if j is None:
                                    continue
                                o = byk[key]
                                lo_, mid = _f(cs.l[j]), (o[2] + o[3]) / 2.0
                                extra.append([j, o[1], o[2], o[3], 'b' if lo_ <= o[2] else 't' if lo_ >= mid else 'm', 1, o[6], o[7], o[8],
                                              o[9] if len(o) > 9 else None, 'A'])
                        xrows = pick(extra, P)

                def zone_list(k_):
                    """Every zone of the stock [(f, bottom, top, first touch candle or None)] by f (the 2nd-zone rule); with touchAgain
                    a zone touched on / before CHoCH k_'s candle = its first touch after it (or None)."""
                    if not zl_memo:
                        zl_memo.append(sorted((((x[1], int(x[8])) if x[1] != 'V' else None, int(x[8]), x[2], x[3], None if x[1] == 'V' else x[0])
                                               for x in sigs[sym] if x[1] in ('Z', 'Y', 'V') and len(x) > 8 and x[8] is not None and x[8] >= 0),
                                              key=lambda z: z[1]))
                    got = (again or {}).get(k_) or {}
                    return [(f_, b_, t_, got[key] if key in got else ft) for key, f_, b_, t_, ft in zl_memo[0]]

                def rank(r, sj, zf, outer):
                    """zone_rank of a signal row whose structure is judged."""
                    k_, i_ = sj['k'], r[0]
                    pr = _f(cs.c[i_])
                    ab, at_ = r[2], r[3]                     # (a Gap-up zone inside an FVG: the FVG overlaps it - the same area)

                    def jok(f2, b2, t2):
                        j2 = st.s.judge(i_, f2, t2, pr, cs.c, P['downN'], P['chochAge'], h=cs.h, zone_bottom=b2, part=P['discPart'],
                                        fib=fib)
                        return j2['k'] == k_ and not struct_fail(j2, P)
                    return zone_rank(zone_list(k_), i_, ab, at_, st.s.events[k_][3], jok,
                                     lambda f2, b2: any(cs.c[j] < b2 for j in range(f2 + 1, i_)))

                def attempt(r):
                    """One signal row -> (trade, None) or (None, (skip key, rule))."""
                    code = r[1]
                    zone_row = r[2] is not None and r[3] is not None
                    link = r[9] if len(r) > 9 else None
                    outer = link if (code == 'Y' and P['gapEntry'] and link) else None   # the FVG around this Gap-up zone
                    if code == 'Z' and P['gapEntry'] and link:
                        return None, ('gapin', '')         # the order waits at the Gap-up zone inside this FVG (that zone's row)
                    zp, dc, fline = None, None, None
                    if zone_row:
                        zb_, zt_ = size_zone(r, P)
                        zp = zone_pct(zb_, zt_)
                        big_ok = code in FIB_CODES and P['fibPat'] == 'big'
                        if zp is not None and ((P['zoneMin'] and zp < P['zoneMin'] - 1e-9) or
                                               (P['zoneMax'] and zp > P['zoneMax'] + 1e-9 and not big_ok)):
                            return None, ('zsize', '')
                        ff = outer[2] if outer else (r[8] if code in FVG_CODES and len(r) > 8 else None)
                        dc = ff is not None and ff >= 0 and dark_cloud(cs, ff)
                        if P['darkCloud'] != 'any' and (P['darkCloud'] == 'exclude') == dc:
                            return None, ('dcloud', '')
                    if code in FIB_CODES:
                        fline = r[3] - P['fibLevel'] * (r[3] - r[2])
                        lo_, cl_ = _f(cs.l[r[0]]), _f(cs.c[r[0]])
                        if not (fline * (1 - P['fibTol'] / 100.0) <= lo_ <= fline * (1 + P['fibTol'] / 100.0) and cl_ > fline):
                            return None, ('fiblevel', '')
                    spring_row = r[1] in SPRING_CODES
                    feats = spring_feats(cs, r[0], P, deep=shape_on) if spring_row else None   # the Spring pair's shape
                    if shape_on and spring_row:
                        ok, why = shape_check(feats, P)
                        if not ok:
                            return None, ('shape', why)
                    sj = None
                    if smode != 'off' or final_stop or mh_tgt:
                        zf = r[8] if len(r) > 8 and r[8] is not None and r[8] >= 0 else None
                        sj = st.s.judge(r[0], zf, r[3] if zf is not None else None, _f(cs.c[r[0]]), cs.c, P['downN'], P['chochAge'],
                                        h=cs.h, zone_bottom=r[2] if zf is not None else None, part=P['discPart'], fib=fib)
                        if smode == 'only':
                            why = struct_fail(sj, P) or struct_more(st.s, sj, cs, r[0], P)
                            if why:
                                return None, ('struct', why)
                    zrank = None
                    if smode != 'off' and sj is not None and sj['k'] >= 0 and len(r) > 8 and r[8] is not None and r[8] >= 0:
                        zrank = rank(r, sj, r[8], outer)          # which discount zone of the CHoCH move (owner, 12-Nov-2026)
                        if smode == 'only' and P['zonePick'] == 'second' and zrank[0]:
                            return None, ('struct', zrank[0])
                    mit = None
                    if smode == 'only' and sj is not None and sj['k'] >= 0:
                        # the owner's rules of 13-Nov-2026: a fast premium zone, touches / a deep close before the move high, a
                        # touched 1st zone
                        zf_ = r[8] if len(r) > 8 and r[8] is not None and r[8] >= 0 else None
                        lo_at, cl_at = (lambda j: _f(cs.l[j])), (lambda j: _f(cs.c[j]))
                        area = zrank[2] if (zrank is not None and P['zonePick'] == 'second' and zrank[1] == 2) else None
                        why = setup_fail(sj, zf_, r[2], r[3], lo_at, cl_at, cs.day[r[0]] - cs.day[st.s.events[sj['k']][0]], area)
                        if why:
                            return None, ('struct', why)
                        if zf_ is not None and sj.get('mh', -1) >= 0:
                            mit = zone_mitigation(lo_at, cl_at, zf_, r[2], r[3], sj['mh'])[0]
                    # E9: how deep the signal candle went into its zone (not with the zone-top order - known only at the close)
                    if P['whereIn'] != 'any' and P['entry'] != 'zone' and r[4] in ('t', 'm', 'b'):
                        if not (r[4] == 't' or (P['whereIn'] == 'tm' and r[4] == 'm')):
                            return None, ('where', '')
                    note = ''
                    if lens:
                        ok, note = ema_check(cs, r[0], P, emas)
                        if not ok:
                            return None, ('ema', '')
                    final = st.s.events[sj['k']][4] if final_stop and sj is not None and sj['k'] >= 0 else None
                    rs = r if not outer else [r[0], r[1], outer[0]] + list(r[3:])      # the stop under the FVG's bottom
                    mh = sj.get('H') if mh_tgt and sj is not None and sj['k'] >= 0 else None
                    t, why = simulate(cs, rs, PC if code in FIB_CODES else P, ema, st.s if P['targetMode'] == 'swing' else None, atr,
                                      st.s if trail_on and P['trail'] == 'swing' else None, final, mh)
                    if ltf_on:
                        # the lower-timeframe confirmation (13-Nov-2026): the trade above = the same signal without it (compared)
                        if t is not None and not grp_base:
                            grp_base.append(t)
                        if not ltf_box:
                            ltf_box.extend(lset.get(sym))
                        base_r = t['R'] if t is not None else None
                        t, why = ltf_trade(cs, r[0], r, rs, PC if code in FIB_CODES else P, ltf_box[0], ltf_box[1] or [], ema,
                                           st.s if P['targetMode'] == 'swing' else None, atr,
                                           st.s if trail_on and P['trail'] == 'swing' else None, final, mh, alt=grp_alt)
                        if t is None:
                            if why in LTF_WHY and not grp_lwhy:
                                grp_lwhy.append(why)
                            return None, (why, '')
                        t['baseR'] = base_r
                    if t is None:
                        return None, (why, '')
                    t['ema'] = note
                    t['sym'] = sym
                    if code == 'K':                       # a Pattern library signal: its name + level (the trades list, the PDF)
                        t['pname'], t['pid'], t['trig'] = pat.name, P['pattern'], r[11] if len(r) > 11 else None
                    t['zpct'] = round(zp, 2) if zp is not None else None
                    t['dc'] = bool(dc)
                    if code in FIB_CODES:
                        t['pat'] = PAT_NAMES.get(r[10] if len(r) > 10 else '', '')
                        t['fibLine'] = round(fline, 2)
                    if outer:
                        t['fz'] = outer                       # the FVG around the Gap-up zone (the charts PDF draws both)
                    if feats:
                        t['upW'], t['loW'], t['dip'] = round(feats['upW'], 1), round(feats['loW'], 1), round(feats['dip'], 2)
                    if st is not None:
                        t['setup'] = sn                       # CHoCH + FVG / BOS + FVG (14-Nov-2026: both in one run)
                    if sj is not None:
                        t['stage'] = sj['stage']
                        t['struct'] = struct_text(st.s, sj, cs, P['tf'], P)
                        t['k'], t['H'] = sj['k'], sj.get('H')
                        if sj['k'] >= 0:                   # for the breakdowns (12-Nov-2026)
                            ev = st.s.events[sj['k']]
                            t['lhll'], t['lag'] = ev[5], cs.day[r[0]] - cs.day[ev[0]]
                            mv = move_volumes(cs, ev[3], ev[0])
                            if mv:
                                t['mv'] = round(max(mv), 1)
                            if sj.get('depth') is not None:
                                t['depth'] = round(sj['depth'], 4)
                    zf = r[8] if len(r) > 8 and r[8] is not None and r[8] >= 0 else None
                    t['zb'], t['zt'], t['zf'] = (r[2], r[3], zf) if zf is not None else (None, None, None)
                    if len(r) > 10 and r[10] == 'A' and code in ('Z', 'Y'):
                        t['again'] = True                     # touched before the CHoCH - its first touch since then
                    if mit is not None:
                        t['mit'] = mit                        # candles that touched the zone before the move high
                    if zrank is not None:
                        t['zn'] = zrank[1]
                        if zrank[2]:
                            t['z1'] = list(zrank[2])          # the nearest zone above (the charts PDF: "the 1st zone, only watched")
                    return t, None

                return attempt, xrows

            ctxs = []                           # (attempt, its rows by candle) per setup, in run_setups' order
            row_key = lambda x: (x[0], -(x[3] if x[3] is not None else -1e18), x[1] != 'Z', x[8] if len(x) > 8 else 0)
            for sn in setups:
                att, xr = make_ctx(sn)
                by_c = {}
                for x in (sorted(rows + xr, key=row_key) if xr else rows):
                    by_c.setdefault(x[0], []).append(x)
                ctxs.append((att, by_c))
            cands = sorted(set().union(*[c[1].keys() for c in ctxs]))
            for i in cands:
                if i >= cs.n or (lo and cs.day[i] < lo) or (hi and cs.day[i] > hi):
                    continue
                if mkt and not mkt(cs.day[i]):
                    skips['mkt'] += 1
                    continue
                if wk is not None and not wk(cs.day[i]):
                    skips['wk'] += 1
                    continue
                fail = None
                grp_base, grp_lwhy, grp_alt, got = [], [], [], None
                for att, by_c in ctxs:                 # setup by setup: the first row of the candle that passes every rule
                    for r in by_c.get(i, ()):
                        t, why = att(r)
                        if t is not None:
                            trades.append(t)
                            fail, got = None, t
                            break
                        fail = fail or why
                    if got is not None:
                        break
                if ltf_on and grp_base:
                    cmp_rows.append((grp_base[0], got, None if got is not None else (grp_lwhy[0] if grp_lwhy else (fail or ('', ''))[0]),
                                     grp_alt[0] if grp_alt and got is None else None))
                if fail:                               # none passed: counted once, under the first row's reason
                    key, rule = fail
                    skips[key] = skips.get(key, 0) + 1
                    if key == 'shape':
                        shape_why[rule] = shape_why.get(rule, 0) + 1
                    elif key == 'struct':
                        struct_why[rule] = struct_why.get(rule, 0) + 1
            # every 300 stocks and at least every PROGRESS_EVERY_S (14-Nov-2026: a slow run said nothing for 16 minutes - the page
            # showed "is it on?" and the sheet calls a run silent for 20 minutes stopped)
            if progress and ((k + 1) % 300 == 0 or time.time() - said >= PROGRESS_EVERY_S):
                said = time.time()
                progress(int((k + 1) * 90 / max(1, len(syms))))
    if fw is not None:
        fw.close()
    if pat is not None:
        pat.close()
    if lset is not None:
        lset.close()
    res = summarise(trades, P, skips, meta, time.time() - t0)
    if ltf_on:
        res['ltf'] = ltf_compare(cmp_rows, P)
    res['engine'] = ENGINE
    if unknown:
        res['warnings'].append('Your laptop\'s program did not know %s and used its own default%s - extract the newest '
                               'ScreenerBridge.zip, then sign out of Windows and sign in again.' % (
                                   ', '.join('%s "%s"' % (k, v) for k, v in sorted(unknown.items())), '' if len(unknown) == 1 else 's'))
    if charts:
        try:
            res['pdf'] = make_charts(charts, d, P, trades, res, meta, progress, name)
        except Exception as e:            # the run's figures still go to the page
            log('Backtest Lab: the charts PDF could not be made - %s' % e)
            res['pdf'] = {'error': str(e)[:200]}
        res['secs'] = round(time.time() - t0, 1)
    res['indexNames'] = sorted((meta.get('indices') or {}).keys())      # the page's list of indices
    res['shapeWhy'] = shape_why                                         # {rule: Springs it left out} (first failed rule)
    res['structWhy'] = struct_why                                       # {rule: signals the structure rules left out}
    return res


# ------------------------------------------------------------------ the charts PDF (lab_charts.py)
def make_charts(folder, d, P, trades, res, meta, progress=None, name=''):
    """Every trade of a run in one PDF in `folder` (owner, 12-Nov-2026: laptop folder only, every trade, the losing ones
    first) - two pages a trade: the chart with the market structure (HH / HL / LH / LL, CHoCH, BOS, zone, BUY) and why it
    was taken / how it ended -> {'file', 'folder', 'pages', 'trades', 'shown'}. Reads each stock's candles once."""
    import lab_charts as LC
    os.makedirs(folder, exist_ok=True)
    order = sorted(trades, key=LC.sort_key)
    shown = order[:LC.MAX_TRADES]
    per = 3 if P.get('ltf', 'off') != 'off' else 2     # + the lower-timeframe confirmation's page (13-Nov-2026)
    total = per * len(shown) + 1
    page_of = {id(t): per * k + 2 for k, t in enumerate(shown)}
    made = datetime.now()
    title = name or ('Backtest Lab run - %s' % P['tf'])
    fname = made.strftime('%Y-%m-%d %H%M%S') + ' ' + LC.safe_name(title) + '.pdf'
    pdf = LC.PdfWriter(os.path.join(folder, fname))
    try:
        LC.cover_page(pdf, title, P, res, len(shown), len(trades), made.strftime('%d %b %Y %H:%M'))
        by_sym = {}
        for t in shown:
            by_sym.setdefault(t['sym'], []).append(t)
        tf = P['tf']
        index = meta['index'].get(tf) or {}
        sopts = struct_opts(P)
        setups = run_setups(P)
        smaps = {sn: _struct_map(d, tf, P['pivotN'], sopts, struct_setup(dict(P, setup=sn))) for sn in setups}
        lens = ema_lens(P)
        lset = _LtfSet(d, meta, P) if per == 3 else None
        done, said = 0, [time.time()]
        with open(os.path.join(d, tf + '.bin'), 'rb') as f:
            for sym in sorted(by_sym):
                if sym not in index:
                    continue
                cs = Candles(f, index[sym][0], index[sym][1])
                sts, seqs = {}, {}

                def st_of(sn):
                    if sn not in sts:
                        sm = smaps[sn]
                        x = sm.get(sym)
                        if x is None or x.size != cs.n:
                            x = sm[sym] = _Struct(cs, P['pivotN'], sopts, struct_setup(dict(P, setup=sn)))
                        sts[sn] = x
                        seqs[sn] = LC.swing_seq(x.s)    # the run's own swings (fractal / ATR / ZigZag) as the structure saw them
                    return sts[sn]
                extra0 = {'atr': structure.atr_series(cs.h, cs.l, cs.c)}
                emas = {n: ema_series([_f(x) for x in cs.c], n) for n in lens} or None
                for t in by_sym[sym]:
                    sn = t.get('setup') if t.get('setup') in smaps else setups[0]
                    st = st_of(sn)
                    PT = dict(P, setup=sn) if P.get('setup') == 'both' else P       # its own setup's words
                    extra = dict(extra0, seq=seqs[sn])
                    if 'k' not in t:                  # structure not a rule in this run: the chart still shows the CHoCH, if any
                        zf = t.get('zf')
                        sj = st.s.judge(t['i'], zf, t.get('zt') if zf is not None else None, _f(cs.c[t['i']]), cs.c, P['downN'],
                                        P['chochAge'], h=cs.h, zone_bottom=t.get('zb') if zf is not None else None,
                                        part=P['discPart'], fib=P['discount'] or None)
                        t['k'], t['H'] = sj['k'], sj.get('H')
                        if sj['k'] >= 0 and not t.get('struct'):
                            t['struct'] = struct_text(st.s, sj, cs, tf, P)
                    if lset is not None and 'ltfc' not in extra0:
                        extra0['ltfc'] = lset.get(sym)[0]
                    extra['ltfc'] = extra0.get('ltfc')
                    LC.trade_page(pdf, (page_of[id(t)],), t, cs, st.s, PT, page_of[id(t)], total, title, None, emas, extra,
                                  extra.get('ltfc'))
                    done += 1
                    if progress and (done % 200 == 0 or time.time() - said[0] >= PROGRESS_EVERY_S):
                        said[0] = time.time()
                        progress(90 + int(9 * done / max(1, len(shown))))
        pages = pdf.close()
        if lset is not None:
            lset.close()
    except Exception:
        pdf.abort()
        raise
    LC.tidy(folder)
    log('Backtest Lab: charts PDF %s (%d pages) in %s' % (fname, pages, folder))
    return {'file': fname, 'folder': LC.FOLDER, 'path': os.path.abspath(folder), 'pages': pages, 'trades': len(trades), 'shown': len(shown)}


# ------------------------------------------------------------------ market structure (structure.py) in a run
_STRUCT = {'key': None, 'map': {}, 'all': {}}     # 'all' = {key: map}, the newest last; 'map' = the last one asked for
STRUCT_KEEP = 2


class _Struct:
    """A stock's Structure + the candle count it was made from (a new cache build = new candles)."""
    __slots__ = ('s', 'size', 'rearm')

    def __init__(self, cs, n, opts=None, setup=None):
        self.s = structure.Structure(cs.h, cs.l, cs.c, n, opts or None, setup)
        self.size = cs.n
        self.rearm = {}                 # {down_n: rearm_touches' map} (touchAgain)


def struct_opts(P):
    """The structure engine options of a run (structure.py; only the ones away from the baseline): {'swing', 'zz', 'prom',
    'choch', 'eq'}."""
    o = {}
    if P['swingMode'] == 'zigzag':
        o['swing'], o['zz'] = 'zigzag', P['zzAtr']
    if P['swingAtr']:
        o['prom'] = P['swingAtr']
    if P['chochMode'] == 'protected':
        o['choch'] = 'protected'
    if P['eqAtr']:
        o['eq'] = P['eqAtr']
    return o


def run_setups(P):
    """The setups a run tries on every signal candle, in this order (14-Nov-2026: "if i want to run CHoch+FVG, BOS+FVG at a
    same time"): ['choch'] / ['bos'] / both -> ['choch', 'bos'] (a candle that qualifies for both is the CHoCH trade)."""
    return ['choch', 'bos'] if P.get('setup') == 'both' else [P.get('setup') or 'choch']


SETUP_NAMES = {'choch': 'CHoCH + FVG', 'bos': 'BOS + FVG'}


def struct_setup(P):
    """The structure's setup (structure.Structure): None = the CHoCH events; a BOS run -> {'kind': 'bos', 'bos', 'downN',
    'upN'} (13-Nov-2026)."""
    if P.get('setup') != 'bos':
        return None
    return {'kind': 'bos', 'bos': P.get('bosKind') or 'both', 'downN': P.get('downN', 3), 'upN': P.get('upN', 1)}


def setup_down(P):
    """The down_n a run hands the structure: the CHoCH's lower highs / lows - a BOS structure chose its events already."""
    return 1 if P.get('setup') == 'bos' else P['downN']


def struct_more(s, sj, cs, i, P):
    """The run's further structure rules (12-Nov-2026: the ChatGPT review's E6-E8 / E10 / E5) on a signal that passed
    struct_fail -> the first one it fails (a STRUCT_WHY key) or ''."""
    k = sj['k']
    b = s.events[k][0]
    if P['discountMax'] and sj.get('depth') is not None and sj['depth'] > P['discountMax'] + 1e-9:
        return 'deep'
    if P['lagMin'] and cs.day[i] - cs.day[b] < P['lagMin']:
        return 'early'
    if P['dispAtr']:
        a = atr14(cs, b)
        if a is None or _f(cs.c[b]) - _f(cs.o[b]) < P['dispAtr'] * a:
            return 'disp'
    if P['dispVol']:
        vs = [float(x) for x in cs.v[max(0, b - 20):b] if x > 0]
        if len(vs) < 10 or not float(cs.v[b]) >= P['dispVol'] * sum(vs) / len(vs):
            return 'vol'
    if P['sweep'] and not s.sweep[k]:
        return 'sweep'
    if P.get('moveVol'):
        ratios = move_volumes(cs, s.events[k][3], b)
        if ratios is None or sum(1 for x in ratios if x >= P['moveVol'] - 1e-9) < P.get('moveVolN', 1):
            return 'mvol'
    return ''


def move_volumes(cs, li, b):
    """The CHoCH move's candles (the final low li .. the CHoCH candle b) -> each one's volume / the average volume of the 20
    candles before the final low (at least 10 with a volume), or None (no volume to compare with)."""
    vs = [float(x) for x in cs.v[max(0, li - 20):li] if x > 0]
    if len(vs) < 10:
        return None
    avg = sum(vs) / len(vs)
    return [float(cs.v[j]) / avg for j in range(li, min(b, cs.n - 1) + 1)]


def rearm_touches(events, down_n, zones, lows, closes, locked=None):
    """touchAgain (owner, 13-Nov-2026): for every CHoCH with at least down_n lower highs / lows (events = structure's
    [b, hi, lvl, li, lf, d]), the zones formed after its final low (li <= f <= b) that price touched on / before the CHoCH
    candle and that held (every close f+1 .. b at / above the bottom) - and the first candle after the CHoCH candle, up to
    the next such CHoCH's candle (it is still this CHoCH's then), whose low reaches the zone top (a Gap-up zone: not a
    circuit-locked candle). zones = [(key, f, bottom, top, first touch candle or None, is Gap-up)] by f; locked(j) -> bool.
    -> {event index: {key: candle or None (not touched again in that time)}}. Walks each CHoCH's own candles once."""
    ks = [k for k, e in enumerate(events) if e[5] >= down_n]
    fs = [z[1] for z in zones]
    out, n = {}, len(lows)
    for x, k in enumerate(ks):
        b, li = events[k][0], events[k][3]
        end = min(n, (events[ks[x + 1]][0] + 1) if x + 1 < len(ks) else n)
        cand = []
        for z in zones[bisect.bisect_left(fs, li):bisect.bisect_right(fs, b)]:
            if z[4] is None or z[4] > b:
                continue
            if any(closes[j] < z[2] for j in range(z[1] + 1, b + 1)):
                continue
            cand.append(z)
        if not cand:
            continue
        got = {z[0]: None for z in cand}
        pending = sorted(cand, key=lambda z: -z[3])
        j = b + 1
        while pending and j < end:
            lo = lows[j]
            if pending[0][3] >= lo:
                lk = locked(j) if locked else False
                keep = []
                for z in pending:
                    if z[3] >= lo and not (z[5] and lk):
                        got[z[0]] = j
                    else:
                        keep.append(z)
                pending = keep
            j += 1
        out[k] = got
    return out


def zone_mitigation(low_at, close_at, f, zb, zt, upto):
    """The candles f+1 .. upto (the move high's candle) that touched the zone (low at / under its top - a wick in it is
    enough) and whether one of them closed under the zone's middle -> (touches, deep close)."""
    mid, n, deep = (zb + zt) / 2.0, 0, False
    for j in range(f + 1, upto + 1):
        if low_at(j) <= zt + 1e-9:
            n += 1
            if close_at(j) < mid - 1e-9:
                deep = True
    return n, deep


def setup_fail(sj, f, zb, zt, low_at, close_at, days, area=None):
    """The owner's rules of 13-Nov-2026 on a signal whose structure passed (sj = structure judge with 'mh' / 'stage';
    f / zb / zt = the traded zone; days = calendar days from the CHoCH candle; area = the 1st (watched) zone above when this
    one is the 2nd, (bottom, top, candle)) -> the first rule it fails (a STRUCT_WHY key) or ''."""
    if sj.get('stage') == 'prem' and days is not None and days <= PREM_FAST_DAYS:
        return 'premfast'
    mh = sj.get('mh')
    if f is None or mh is None or mh < 0:
        return ''
    n, deep = zone_mitigation(low_at, close_at, f, zb, zt, mh)
    if deep:
        return 'deepclose'
    if n > MIT_MAX:
        return 'mitig'
    if area is not None and zone_mitigation(low_at, close_at, area[2], area[0], area[1], mh)[0] > 0:
        return 'zone1mit'
    return ''


def zone_rank(zones, i, zb, zt, li, judge_ok, broken):
    """The owner's 2nd-zone rule (12-Nov-2026, zonePick 'second'): a signal on candle i in the area zb .. zt (a Gap-up zone
    inside an FVG = that FVG) of a CHoCH whose final low is candle li. `zones` = every zone of the stock [(f, bottom, top,
    first touch candle or None)] by f; `judge_ok(f, bottom, top)` = that zone passes the run's structure rules for the same
    CHoCH on candle i; `broken(f, bottom)` = a close under its bottom from f+1 to i-1. The discount zones of the move above
    this area (bottom >= its top; overlapping ones merged into one area) and under it (top <= its bottom, not reached yet,
    not broken) -> ('' trade | 'zone1' the higher of two or more - only watched | 'zone3' a 3rd or deeper one, number of
    the areas above + 1, the nearest area above (bottom, top, candle) or None)."""
    above, below = [], False
    for f, b2, t2, ft in zones:
        if f < li:
            continue
        if f >= i:
            break
        if b2 >= zt - 1e-9:
            if judge_ok(f, b2, t2):
                above.append((b2, t2, f))
        elif t2 <= zb + 1e-9 and not below:
            if (ft is None or ft >= i) and not broken(f, b2) and judge_ok(f, b2, t2):
                below = True
    areas = []
    for b2, t2, f in sorted(above):
        if areas and b2 <= areas[-1][1] + 1e-9:
            a = areas[-1]
            areas[-1] = (a[0], max(a[1], t2), min(a[2], f))
        else:
            areas.append((b2, t2, f))
    n = len(areas) + 1
    if n >= 3:
        return 'zone3', n, areas[0]
    if n == 1 and below:
        return 'zone1', 1, None
    return '', n, areas[0] if areas else None


def week_filter(fw, idx, n):
    """E11 (12-Nov-2026): day ordinal -> True when the stock's last FINISHED weekly candle before that day's week closed
    above its n-week EMA (the first n weeks never pass; no weekly candles = never)."""
    if not idx:
        return lambda day: False
    w = Candles(fw, idx[0], idx[1])
    closes = [_f(x) for x in w.c]
    ema = ema_series(closes, n)
    days = list(w.day)

    def ok(day):
        monday = day - date.fromordinal(day).weekday()
        k = bisect.bisect_left(days, monday) - 1      # the weekly candle's day = its last session, before this week
        return k >= n - 1 and closes[k] > ema[k]
    return ok


def _struct_map(d, tf, n, opts=None, setup=None):
    """{sym: _Struct} kept while the program runs (the same cache build, timeframe, swing size, structure options and setup)
    - the first run with market structure works it out (seconds), later runs reuse it. The last STRUCT_KEEP keys are kept
    (14-Nov-2026: a run of CHoCH + FVG and BOS + FVG together needs both); an older one is dropped (memory)."""
    key = (d, tf, n, tuple(sorted((opts or {}).items())), tuple(sorted((setup or {}).items())))
    allm = _STRUCT['all']
    if key in allm:
        allm[key] = allm.pop(key)          # the newest last
    else:
        allm[key] = {}
        while len(allm) > STRUCT_KEEP:
            allm.pop(next(iter(allm)))
    _STRUCT['key'], _STRUCT['map'] = key, allm[key]
    return allm[key]


STRUCT_WHY = {'nochoch': 'no live CHoCH before it (after the lower highs / lows you set)',
              'zone': 'its zone did not form in the CHoCH move / after it', 'bos': 'a BOS came first (not the first pullback)',
              'above': 'its zone is not below the CHoCH level',
              'premium': 'its zone was not in the discount part of the move (above your Fib line)',
              'deep': 'its zone was deeper in the move than your "at most" level',
              'early': 'it came sooner after the CHoCH than your minimum days',
              'disp': 'the CHoCH candle\'s body was smaller than your ATR rule (no displacement)',
              'vol': 'the CHoCH candle\'s volume was under your x-times-average rule',
              'sweep': 'the final low did not sweep the swing low before it (closed back above)',
              'zone1': 'the 1st (higher) of two discount zones in the CHoCH move - only watched, the trade is on the 2nd',
              'zone3': 'a 3rd (or deeper) discount zone of the CHoCH move - only the 2nd is traded',
              'mvol': 'no big-volume candle (your x-times rule) in the CHoCH move',
              'abovechoch': 'its zone was wholly above the CHoCH level',
              'swing': 'its zone did not form in the swing from the final low to the move high',
              'premfast': 'a premium zone (above your Fib line) with the signal 4 days or less after the CHoCH',
              'deepclose': 'a candle closed under the middle of its zone before the move high',
              'mitig': 'more than 2 candles touched its zone before the move high',
              'zone1mit': 'the 1st (watched) zone was touched before the move high'}


def struct_fail(sj, P):
    """The first market-structure rule a signal fails (a STRUCT_WHY key) or ''."""
    if sj['k'] < 0:
        return 'nochoch'
    w = P['zoneWhen']
    if not (sj['after_low'] and (w == 'both' or (w == 'leg' and sj['leg']) or (w == 'after' and sj['after']))):
        return 'zone'
    # the owner's rules of 13-Nov-2026: no zone wholly above the CHoCH level; the zone formed in the swing final low -> move high
    if sj.get('zbot') is not None and sj.get('lvl') is not None and sj['zbot'] >= sj['lvl'] - 1e-9:
        return 'abovechoch'
    if sj.get('zf') is not None and sj.get('mh') is not None and sj['mh'] >= 0 and sj['zf'] > sj['mh']:
        return 'swing'
    if P['firstPull'] and not sj['first']:
        return 'bos'
    if P['belowChoch'] and not sj['below']:
        return 'above'
    if P['discount'] and not (sj.get('depth') is not None and sj['depth'] >= P['discount'] - 1e-9):
        # lineOk (12-Nov-2026, SWIGGY): a zone whose top is at / under the CHoCH level (+ lineTol %) counts all the same
        if not (P.get('lineOk') and sj.get('ztop') is not None and sj.get('lvl') is not None and
                sj['ztop'] <= sj['lvl'] * (1 + (P.get('lineTol') or 0) / 100.0) + 1e-9):
            return 'premium'
    return ''


PART_WORDS = {'mid': 'middle', 'top': 'top', 'bottom': 'bottom'}


def struct_text(s, sj, cs, tf, P=None):
    """'CHoCH 207.00 on 2025-05-13 (3 lower highs / lows, final low 180.20 on ...) · move high 230.10 · zone middle 62% down
    the move (50% line 205.15) · BOS on ...' for the trade list (the owner checks it on the TradingView chart)."""
    if sj['k'] < 0:
        return ''
    b, hi, lvl, li, lf, dd = s.events[sj['k']]
    if s.bos:
        ck = s.ck[sj['k']]
        how = ('the 1st BOS after the CHoCH of %s' % _label(tf, cs.day[s.chev[ck][0]], cs.minute[s.chev[ck][0]]) if ck >= 0 else
               '%d higher high%s / low%s' % (dd, '' if dd == 1 else 's', '' if dd == 1 else 's'))
        txt = 'BOS %.2f on %s (%s, higher low %.2f on %s)' % (
            _f(lvl), _label(tf, cs.day[b], cs.minute[b]), how, _f(lf), _label(tf, cs.day[li], cs.minute[li]))
    else:
        txt = 'CHoCH %.2f on %s (%d lower highs / lows, final low %.2f on %s)' % (
            _f(lvl), _label(tf, cs.day[b], cs.minute[b]), dd, _f(lf), _label(tf, cs.day[li], cs.minute[li]))
    if sj.get('H') is not None:
        txt += ' · move high %.2f' % _f(sj['H'])
        if sj.get('depth') is not None:
            part = PART_WORDS.get((P or {}).get('discPart'), 'middle')
            txt += ' · zone %s %d%% down the move' % (part, int(round(sj['depth'] * 100)))
            fib = (P or {}).get('discount')
            if fib:
                txt += ' (%g%% line %.2f)' % (fib * 100, _f(structure.fib_line(sj['H'], lf, fib)))
    if not sj['first']:
        k = s.st.get(sj['k'])
        if k and k[5] >= 0:
            txt += ' · %sBOS on %s' % ('next ' if s.bos else '', _label(tf, cs.day[k[5]], cs.minute[k[5]]))
    return txt


class LabError(Exception):
    pass


def headline(res):
    s, a = res.get('stats') or {}, res.get('account') or {}
    if not s.get('trades'):
        return 'no trades'
    out = ('%d trades, win %.1f%%, avg %.2fR, total %.0fR; account %+.1f%% (max drawdown %.1f%%)'
           % (s['trades'], s['winPct'], s['avgR'], s['totalR'], a.get('returnPct') or 0, a.get('maxDD') or 0))
    if s.get('avgRLo') is not None:
        out += '; likely range of the average %.2fR to %.2fR (%s)' % (s['avgRLo'], s['avgRHi'], EDGE_WORDS.get(s.get('edge'), ''))
    sp = res.get('split')
    if sp and sp.get('dev', {}).get('trades') and sp.get('test', {}).get('trades'):
        out += '; before %s: avg %.2fR (%d trades), from it: avg %.2fR (%d trades)' % (
            sp['at'], sp['dev']['avgR'], sp['dev']['trades'], sp['test']['avgR'], sp['test']['trades'])
    return out


EDGE_WORDS = {'real': 'an edge - the whole range is above 0', 'losing': 'losing - the whole range is under 0',
              'chance': 'could be chance - the range spans 0', 'few': 'too few trades to say'}


# ------------------------------------------------------------------ the background worker
class LabWorker:
    """Asks the sheet for a Backtest Lab job (the website's page) and runs it here. One thread per program."""

    def __init__(self):
        self.thread = None
        self.build = None            # fn(out) -> True when it built the cache (kite_intraday.lab_build_cache)

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_start(self, cfg, api, build=None):
        if cfg.get('backtest_lab') is False or self.busy():
            return False
        self.build = build
        self.thread = threading.Thread(target=self.loop, args=(cfg, api), daemon=True)
        self.thread.start()
        return True

    def _build(self, cfg, api, say):
        """Makes the candle cache (the first time, or after an update changed it) - minutes for 1,800 stocks. `say(k, total,
        note)` is called at most every BUILD_SAY_S with the progress. -> True when there is a cache now."""
        if not self.build:
            return False
        t0, last = time.time(), [0.0]

        def tick(k, total):
            now = time.time()
            if k < total and now - last[0] < BUILD_SAY_S:
                return
            last[0] = now
            left = (now - t0) / k * (total - k) / 60 if k else 0
            say(k, total, 'preparing the candles on the laptop after an update (only once): %d of %d stocks%s'
                % (k, total, ', about %d min left' % max(1, round(left)) if k < total else ' - done'))
        log('Backtest Lab: preparing the candle cache (the first time, or after an update) ...')
        try:
            ok = self.build(lambda m: log('Backtest Lab: ' + m), tick)
        except TypeError:                    # a build function of the older kind (no progress)
            ok = self.build(lambda m: log('Backtest Lab: ' + m))
        log('Backtest Lab: candle cache %s in %.0f min.' % ('ready' if ok else 'not made (no Kite candles yet)', (time.time() - t0) / 60))
        return bool(ok) and bool(load_meta()[0])

    def loop(self, cfg, api, rounds=None):
        old_app_said = False
        k = 0
        # an update that changed the cache (or no cache yet): make it now, before any run is taken - the page shows the
        # progress (op 'hello'); a run sent meanwhile waits and is taken right after (11-Nov-2026)
        if self.build and not load_meta()[0]:
            def hello(k, total, note):
                try:
                    api(cfg, 'lab', {'op': 'hello', 'note': note if k < total else ''}, tries=1, timeout=30)
                except Exception:
                    pass
            try:
                self._build(cfg, api, hello)
            except Exception as e:
                log('Backtest Lab: the candle cache could not be made - %s' % e)
        while rounds is None or k < rounds:
            k += 1
            wait = POLL_SLOW_S
            try:
                res = api(cfg, 'lab', {'op': 'poll'}, tries=1, timeout=60)
                if not res.get('ok'):
                    if 'unknown action' in str(res.get('error')):
                        if not old_app_said:
                            log('Backtest Lab: the sheet\'s web app is an older version - deploy a New version of the '
                                'existing web app (Deploy > Manage deployments > Edit > New version).')
                            old_app_said = True
                        wait = 1800
                    else:
                        wait = 300
                else:
                    wait = min(max(int(res.get('next') or POLL_SLOW_S), 5), 900)
                    job = res.get('job')
                    if job:
                        self.run_one(cfg, api, job)
                        wait = 5
            except Exception as e:            # no internet / the sheet busy: try again later
                log('Backtest Lab: %s' % e)
                wait = 300
            if rounds is None:
                time.sleep(wait)

    def run_one(self, cfg, api, job):
        jid = job.get('id')
        name = job.get('name') or ''

        def progress(pct, note=''):
            try:
                api(cfg, 'lab', {'op': 'progress', 'id': jid, 'pct': pct, 'note': note}, tries=1, timeout=30)
            except Exception:
                pass
        log('Backtest Lab: running "%s" ...' % (name or jid))
        try:
            meta, _ = load_meta()
            base = 0
            if not meta:
                if not self.build:
                    raise LabError('no backtest cache yet - run BacktestNow.bat once')
                progress(1, 'preparing the candles on the laptop after an update (only once) - this can take 10-30 minutes')
                # the progress keeps the run alive on the sheet (it would call a run silent for 20 minutes "stopped")
                if not self._build(cfg, api, lambda k, total, note: progress(max(1, int(k * 60 / max(1, total))), note)):
                    raise LabError('no Kite candles on this laptop yet - run KiteHistoryNow.bat')
                base = 60
            charts = CHARTS_DIR if cfg.get('lab_charts') is not False else None
            res = run_job(job.get('params') or {}, progress=lambda p: progress(base + int(p * (100 - base) / 100)), charts=charts, name=name)
            reply = api(cfg, 'lab', {'op': 'result', 'id': jid, 'result': res}, tries=3, timeout=180)
            if not reply.get('ok'):
                raise LabError('the sheet refused the result - %s' % reply.get('error'))
            log('Backtest Lab: "%s" done in %.0f s - %s.' % (name or jid, res['secs'], headline(res)))
        except Exception as e:
            log('Backtest Lab: "%s" failed - %s' % (name or jid, e))
            try:
                api(cfg, 'lab', {'op': 'fail', 'id': jid, 'error': str(e)[:300]}, tries=2, timeout=60)
            except Exception:
                pass
