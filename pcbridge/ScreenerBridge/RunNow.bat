@echo off
cd /d "%~dp0"
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py run) else (python screener_bridge.py run)
echo.
pause
