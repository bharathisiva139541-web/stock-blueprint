@echo off
cd /d "%~dp0"
echo Kite live prices every minute to the sheet's "Kite Live" tab - the Zerodha login page opens if you have not logged in today. Close this window to stop.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py live) else (python screener_bridge.py live)
echo.
pause
