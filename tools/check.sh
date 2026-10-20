#!/bin/sh
# Syntax check before every clasp push (node does not know .gs)
set -e
cd "$(dirname "$0")/.."
cp Code.gs /tmp/Code.check.js
node --check /tmp/Code.check.js && echo "Code.gs: OK"
python3 -m py_compile pcbridge/ScreenerBridge/screener_bridge.py && echo "screener_bridge.py: OK"
