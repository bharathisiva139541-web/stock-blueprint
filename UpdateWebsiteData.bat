@echo off
rem Drag your downloaded "Copy of Stock Blueprint.xlsx" onto this file to refresh web/data/dashboard.js
cd /d "%~dp0"
if "%~1"=="" (echo Drag the .xlsx file onto this .bat file. & pause & exit /b)
where py >nul 2>nul
if %errorlevel%==0 (py -3 -m pip install --quiet openpyxl & py -3 tools\export_xlsx.py "%~1") else (python -m pip install --quiet openpyxl & python tools\export_xlsx.py "%~1")
pause
