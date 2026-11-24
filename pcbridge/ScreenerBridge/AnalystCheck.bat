@echo off
cd /d "%~dp0"
rem Analyst targets check - what Moneycontrol / Business Standard / DSIJ pages give (nothing is sent)
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py analystcheck %*) else (python screener_bridge.py analystcheck %*)
echo.
pause
