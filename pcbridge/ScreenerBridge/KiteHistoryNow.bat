@echo off
cd /d "%~dp0"
echo Zerodha Kite: the long candle history for the backtest (daily ~20 years; 4H, 1-hour and 15-minute as far as Kite
echo gives, up to 20 years) - read once, kept on this computer (folder intraday_data, about 4-8 GB). The first time takes
echo several hours (keep the laptop on); then the backtest runs. A line every 25 stocks shows the progress and the time left. Keep this window
echo open and the laptop awake (it carries on where it stopped when you start it again).
echo The daily scan also reads it a part a day by itself - this only does it all at once.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py kitehistory) else (python screener_bridge.py kitehistory)
echo.
pause
