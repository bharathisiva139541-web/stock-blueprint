@echo off
cd /d "%~dp0"
echo Kite candle check - type a symbol, then optionally a timeframe (15m 30m 1H 2H 4H D W M) and a date (YYYY-MM-DD)
echo e.g.  PARAGMILK 4H   or   PARAGMILK 4H 2026-10-30
set /p ARGS=Symbol [timeframe] [date]: 
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py intradaycheck %ARGS%) else (python screener_bridge.py intradaycheck %ARGS%)
echo.
pause
