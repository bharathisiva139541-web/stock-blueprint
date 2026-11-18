@echo off
cd /d "%~dp0"
echo NSE XBRL 5-year check - type NSE symbols separated by spaces (e.g. TCS HDFCBANK BSE), then press Enter
set /p SYMS=Symbols: 
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py xbrlhistcheck %SYMS%) else (python screener_bridge.py xbrlhistcheck %SYMS%)
echo.
pause
