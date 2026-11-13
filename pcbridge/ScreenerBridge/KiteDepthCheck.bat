@echo off
cd /d "%~dp0"
echo Zerodha Kite: how many years of 15-minute and 1-hour candles Kite gives (RELIANCE, TCS, INFY - or the stocks
echo you type after the name: KiteDepthCheck.bat SBIN ITC). Nothing is stored or sent. Takes about a minute.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py kitedepth %*) else (python screener_bridge.py kitedepth %*)
echo.
pause
