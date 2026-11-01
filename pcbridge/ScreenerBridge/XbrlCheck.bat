@echo off
cd /d "%~dp0"
echo NSE XBRL test - type NSE symbols separated by spaces (e.g. PARAS TCS), or paste an XBRL link, then press Enter
set /p SYMS=Symbols: 
where py >/dev/null 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py xbrl %SYMS%) else (python screener_bridge.py xbrl %SYMS%)
echo.
pause
