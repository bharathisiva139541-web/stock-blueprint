"""Offline checks for the PC bridge's background program (screener_bridge.py run_after_login / loop_claim): owner,
02-Nov-2026 - the results check every 30 minutes with no time limit, a full round at log-in, an hour later and then
every 3 hours; a computer that slept carries on; no internet = tried again at the next tick; one program per log-in.
A fake clock - nothing waits. Run by tests/pcbridge-loop.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

TMP = tempfile.mkdtemp()
sb.LOOP_PATH = os.path.join(TMP, 'bridge_loop.json')
LOGS = []
sb.log = LOGS.append


class Stop(Exception):
    pass


CLOCK = [1000000.0]
EVENTS, ONLINE = [], [True]
sb.time.time = lambda: CLOCK[0]


def run_for(cfg, hours, sleeps=None):
    """Runs the background program on the fake clock until `hours` have passed; `sleeps` {at hour: hours asleep}."""
    end = CLOCK[0] + hours * 3600
    start = CLOCK[0]
    naps = dict(sleeps or {})

    def tick(seconds):
        for h in sorted(naps):
            if CLOCK[0] >= start + h * 3600:
                CLOCK[0] += naps.pop(h) * 3600      # the computer slept
        CLOCK[0] += seconds
        if CLOCK[0] > end:
            raise Stop()
    sb.loop_sleep = tick
    try:
        return sb.run_after_login(cfg)
    except Stop:
        return None


def at(kind):
    return [round((t - T0) / 60) for k, t in EVENTS if k == kind]


sb.run_once = lambda cfg: EVENTS.append(('full', CLOCK[0])) or 0
sb.quick_check = lambda cfg, daily=None, lock=True: EVENTS.append(('quick', CLOCK[0])) or 0
sb.internet_ok = lambda: ONLINE[0]
sb.loop_claim = lambda: True

# 30-minute checks, full rounds at 0, 60 min and then every 3 hours; a check is not run on top of a full round
T0 = CLOCK[0]
cfg = dict(sb.DEFAULTS)
assert cfg['quick_check_minutes'] == 30 and cfg['full_round_every_hours'] == 3
run_for(cfg, 8)
assert at('full') == [0, 60, 240, 420], at('full')
q = at('quick')
# (a full round does the check too - the next one is 30 minutes after it)
assert q == [30, 90, 120, 150, 180, 210, 270, 300, 330, 360, 390, 450, 480], q
assert 'Background program started: a full round now, in 60 minutes and then every 3 hours, the results check every 30 minutes.' in LOGS, LOGS

# the computer slept 5 hours after 2 hours: what fell due runs at once on waking (one full round, not three)
del EVENTS[:], LOGS[:]
T0 = CLOCK[0]
run_for(cfg, 9, sleeps={2: 5})
f = at('full')
assert f[:3] == [0, 60, 420] and len([x for x in f if 420 <= x < 450]) == 1, f

# no internet: nothing runs, a line in the log, then everything at the next tick once it is back
del EVENTS[:], LOGS[:]
T0 = CLOCK[0]
ONLINE[0] = False
def offline_then_back(seconds):
    CLOCK[0] += seconds
    if CLOCK[0] - T0 > 20 * 60:
        ONLINE[0] = True
    if CLOCK[0] - T0 > 2 * 3600:
        raise Stop()
sb.loop_sleep = offline_then_back
try:
    sb.run_after_login(cfg)
except Stop:
    pass
assert at('full')[0] == 20 or at('full')[0] == 21, at('full')
assert LOGS.count('No internet - waiting for the network ...') == 1 and 'Internet is back.' in LOGS, LOGS

# switched off: quick_check_minutes 0 and full_round_every_hours 0 = the old behaviour (two rounds, then it stops)
del EVENTS[:], LOGS[:]
T0 = CLOCK[0]
assert run_for(dict(cfg, quick_check_minutes=0, full_round_every_hours=0), 48) == 0
assert at('full') == [0, 60] and at('quick') == [], EVENTS
# only the checks off: full rounds go on
del EVENTS[:]
T0 = CLOCK[0]
run_for(dict(cfg, quick_check_minutes=0), 6.5)
assert at('full') == [0, 60, 240] and at('quick') == [], EVENTS

# a round that raises does not stop the background program
del EVENTS[:], LOGS[:]
T0 = CLOCK[0]
def boom(cfg):
    EVENTS.append(('full', CLOCK[0]))
    raise ValueError('sheet said no')
sb.run_once = boom
run_for(cfg, 2)
assert at('full') == [0, 60] and 'Unexpected problem: sheet said no' in LOGS, (EVENTS, LOGS)

# ---------------------------------------------------------------- one background program per log-in
spec2 = importlib.util.spec_from_file_location('sb2', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
fresh = importlib.util.module_from_spec(spec2)
spec2.loader.exec_module(fresh)
fresh.LOOP_PATH = os.path.join(TMP, 'loop2.json')
fresh.log = LOGS.append
assert fresh.loop_claim() is True
info = json.load(open(fresh.LOOP_PATH))
assert info['pid'] == os.getpid(), info
# another program that is alive, since this computer started -> this one stops
other = subprocess.Popen([sys.executable, '-c', 'import time; time.sleep(30)'])
try:
    json.dump({'pid': other.pid, 'boot': fresh._boot_time()}, open(fresh.LOOP_PATH, 'w'))
    if fresh._boot_time():
        assert fresh.loop_claim() is False
        del LOGS[:]
        assert fresh.run_after_login(dict(fresh.DEFAULTS)) == 0 and LOGS == ['The background program is already running - this copy stops.'], LOGS
    # ... from before a restart, or a program that is gone -> taken over
    json.dump({'pid': other.pid, 'boot': 12345.0}, open(fresh.LOOP_PATH, 'w'))
    assert fresh.loop_claim() is True
finally:
    other.kill()
    other.wait()
json.dump({'pid': other.pid, 'boot': fresh._boot_time()}, open(fresh.LOOP_PATH, 'w'))
assert fresh.loop_claim() is True, 'its program is gone'
print('OK')
