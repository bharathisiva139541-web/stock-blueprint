@echo off
cd /d "%~dp0"
echo FVG+Spring / Gap-up FVG + Spring backtest (the 30 days after each signal: the move in %%, 1R - 5R targets) on the
echo Zerodha candles already on this computer - no login needed.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py backtest) else (python screener_bridge.py backtest)
echo.
pause
