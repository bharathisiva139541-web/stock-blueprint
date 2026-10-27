@echo off
cd /d "%~dp0"
echo moneycontrol test - type NSE symbols separated by spaces (e.g. TCS ACUTAAS), then press Enter
set /p SYMS=Symbols: 
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py moneycontrol %SYMS%) else (python screener_bridge.py moneycontrol %SYMS%)
echo.
pause
