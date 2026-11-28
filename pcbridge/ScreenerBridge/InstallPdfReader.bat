@echo off
cd /d "%~dp0"
rem Installs pypdf (the PDF reader Corporate Intelligence uses) for this Windows user - once. The background program
rem tries this by itself too; run it when bridge.log says pypdf could not be installed.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py installpdf) else (python screener_bridge.py installpdf)
echo.
pause
