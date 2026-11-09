@echo off
cd /d "%~dp0"
echo Zerodha Kite: the long candle history for the backtest (daily ~20 years, 4H ~5 years) - read once, kept on this
echo computer (folder intraday_data, about 250 MB). The first time takes about an hour; then the backtest runs.
echo The daily scan also reads it a part a day by itself - this only does it all at once.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py kitehistory) else (python screener_bridge.py kitehistory)
echo.
pause
