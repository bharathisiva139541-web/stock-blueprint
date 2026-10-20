@echo off
cd /d "%~dp0"
echo.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py setup) else (python screener_bridge.py setup)
echo.
pause
