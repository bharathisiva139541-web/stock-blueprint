@echo off
cd /d "%~dp0"
echo Kite intraday / weekly / monthly pattern scan - the Zerodha login page opens if you have not logged in today.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py intraday) else (python screener_bridge.py intraday)
echo.
pause
