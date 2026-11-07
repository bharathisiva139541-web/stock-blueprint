@echo off
cd /d "%~dp0"
echo FVG+Spring backtest (win rate, 2R target) on the Zerodha candles already on this computer - no login needed.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py backtest) else (python screener_bridge.py backtest)
echo.
pause
