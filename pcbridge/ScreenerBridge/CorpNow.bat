@echo off
cd /d "%~dp0"
rem Corporate Intelligence now - NSE's announcements of the past week, sorted and scored, the PDFs read, sent to the sheet;
rem e.g. CorpNow.bat RELIANCE prints that company's announcements too
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py corp %*) else (python screener_bridge.py corp %*)
echo.
pause
