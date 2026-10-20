@echo off
rem Opens the dashboard on this PC at http://localhost:8080  (close this window to stop)
cd /d "%~dp0web"
start "" http://localhost:8080
where py >nul 2>nul
if %errorlevel%==0 (py -3 -m http.server 8080) else (python -m http.server 8080)
