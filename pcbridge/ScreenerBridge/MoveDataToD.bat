@echo off
cd /d "%~dp0"
echo Keep the big Kite / Backtest Lab data (intraday_data, lab_cache, lab_charts - up to 4-8 GB) on another drive,
echo e.g. D:\StockBlueprintData, so the C: drive keeps its space. The program files stay here.
echo Close KiteHistoryNow / IntradayNow / BacktestNow windows first. Press Enter at the question for D:\StockBlueprintData.
echo.
where py >nul 2>nul
if %errorlevel%==0 (py -3 screener_bridge.py datafolder %*) else (python screener_bridge.py datafolder %*)
echo.
pause
