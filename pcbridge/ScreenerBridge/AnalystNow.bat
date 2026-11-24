@echo off
cd /d "%~dp0"
rem Analyst targets now - the brokers' recommendations since 1-Oct-2026; e.g. AnalystNow.bat JLHL prints that stock's too
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py analysts %*) else (python screener_bridge.py analysts %*)
echo.
pause
