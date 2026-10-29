"""Offline checks for the PC bridge's round guard and resume (screener_bridge.py lock_is_stale / acquire_lock /
run_state_*): a lock left by a round that is gone (program closed, computer restarted, no heartbeat) is taken
over at once, and a round that stopped half-way is CONTINUED - the sheet first processes the pages it already
has, those pages are not fetched again, then the rest of the round runs. Also the round of the earlier program
version read back from bridge.log (29-Oct-2026: the laptop went off during moneycontrol).
Run by tests/pcbridge-resume.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)

TMP = tempfile.mkdtemp()
sb.LOCK_PATH = os.path.join(TMP, 'bridge.lock')
sb.RUN_STATE_PATH = os.path.join(TMP, 'run_state.json')
sb.LOG_PATH = os.path.join(TMP, 'bridge.log')

# ---------------------------------------------------------------- the lock
dead = subprocess.Popen([sys.executable, '-c', 'pass'])
dead.wait()


def lock(info, age=0):
    with open(sb.LOCK_PATH, 'w') as f:
        f.write(info if isinstance(info, str) else json.dumps(info))
    t = time.time() - age
    os.utime(sb.LOCK_PATH, (t, t))


assert sb.lock_is_stale(), 'no lock'
lock({'pid': os.getppid(), 'boot': sb._boot_time(), 'started': 'x'})
assert not sb.lock_is_stale(), 'a running round (its program is alive, fresh heartbeat)'
lock({'pid': dead.pid, 'boot': sb._boot_time()})
assert sb.lock_is_stale(), 'its program is no longer running'
lock(str(dead.pid))
assert sb.lock_is_stale(), 'the earlier version\'s lock (just the pid)'
lock({'pid': os.getppid(), 'boot': sb._boot_time()}, age=11 * 60)
assert sb.lock_is_stale(), 'no heartbeat for 11 minutes'
if sb._boot_time():
    lock({'pid': os.getppid(), 'boot': sb._boot_time() - 3600})
    assert sb.lock_is_stale(), 'the computer was restarted since'
lock({'pid': os.getppid(), 'boot': sb._boot_time()})
sb.time.sleep = lambda s: None
LOGS = []
sb.log = LOGS.append
assert sb.acquire_lock(0) is False, 'busy'
os.remove(sb.LOCK_PATH)
assert sb.acquire_lock(0) is True
info = json.load(open(sb.LOCK_PATH))
assert info['pid'] == os.getpid() and 'boot' in info and info['started'], info
assert not sb.lock_is_stale(), 'our own round'
sb.release_lock()
assert not os.path.exists(sb.LOCK_PATH)

# ---------------------------------------------------------------- the earlier version's round, from bridge.log
NOW = time.time()
T = lambda m: time.strftime('%Y-%m-%d %H:%M:%S', time.localtime(NOW - m * 60))


def write_log(lines):
    with open(sb.LOG_PATH, 'w', encoding='utf-8') as f:
        f.write('\n'.join('%s  %s' % (T(m), x) for m, x in lines) + '\n')


ROUND = [(40, 'Sheet wants 7 symbol(s): 7 results-due/pending, 0 never-attempted (of 0 waiting).'),
         (39, '[1/7] ICICIPRULI  not on screener (404)')] + \
        [(38 - i, '[%d/7] S%d  ok (50 KB)' % (i + 2, i + 2)) for i in range(5)] + \
        [(32, '  screener said "slow down" (429) - waiting 90 s'), (30, '[7/7] S7  ok (40 KB)'),
         (29, 'moneycontrol: looking up 3 result(s) screener.in does not show yet ...'), (28, '  moneycontrol S2: not yet'),
         (20, 'Another run is still going (or crashed less than 3 h ago) - skipping this one.')]
write_log([(300, 'Run finished.')] + ROUND)
st = sb.run_state_from_log(5, now=NOW)
assert st['sent'] == ['ICICIPRULI', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'] and st['from_log'] and st['stage'] == 'screener', st
write_log(ROUND[:8])                                    # stopped while fetching: only whole batches of 5 are sure
assert sb.run_state_from_log(5, now=NOW)['sent'] == ['ICICIPRULI', 'S2', 'S3', 'S4', 'S5']
write_log(ROUND[:3])
assert sb.run_state_from_log(5, now=NOW) is None, 'not one batch'
write_log(ROUND + [(10, 'Sheet: Results Day -> done | Never-attempted rows -> none'), (10, 'Run finished.')])
assert sb.run_state_from_log(5, now=NOW) is None, 'it finished'
assert sb.run_state_from_log(5, now=NOW + 13 * 3600) is None, 'too old'

# ---------------------------------------------------------------- run_once continues it
CALLS, FETCHED, MC = [], [], []
LIST = [{'ok': True, 'priority': ['ICICIPRULI', 'S2', 'S3', 'S4', 'S5', 'S6', 'S7'], 'missing': [], 'mc': {'S2': 'Sep 2026'}},
        {'ok': True, 'priority': ['S2', 'S7', 'S8', 'S9'], 'missing': ['N1'], 'mc': {'S2': 'Sep 2026', 'S7': 'Sep 2026', 'S8': 'Sep 2026'}}]
BOOM = {}


def fake_api(cfg, action, payload=None, timeout=120, tries=3):
    CALLS.append(action)
    if action == 'list':
        return LIST[min(sum(1 for c in CALLS if c == 'list') - 1, len(LIST) - 1)]
    if action == 'put':
        if BOOM.get('put') == sum(1 for c in CALLS if c == 'put'):
            raise KeyboardInterrupt('the computer went off')
        return {'ok': True, 'stored': len(payload['items']),
                'details': [{'sym': it['sym'], 'latest': 'Sep 2026' if it['sym'] == 'S8' else 'Jun 2026'} for it in payload['items']]}
    if action == 'process':
        return {'ok': True, 'result': {'results': 'done', 'missing': 'checked 0'}}
    raise AssertionError(action)


def fake_fetch(cfg, sym, consolidated=True):
    FETCHED.append(sym)
    return 'ok', '<html>%s</html>' % sym


sb.api = fake_api
sb.fetch_page = fake_fetch
sb.polite_sleep = lambda cfg: None
for name in ('price_bands_step', 'ipo_step', 'eod_step'):
    setattr(sb, name, lambda cfg, today=None: None)
sb.hist_step = lambda cfg, h60, today=None: 0
sb.mc_step = lambda cfg, want, behind: MC.append((dict(want), sorted(behind))) or 0
CFG = dict(sb.DEFAULTS, url='x', token='y')

write_log(ROUND)
del LOGS[:]
assert sb.run_once(CFG) == 0
assert CALLS == ['list', 'process', 'list', 'put', 'process'], CALLS
assert FETCHED == ['S8', 'S9', 'N1'], 'the 7 pages of the stopped round are not fetched again: %s' % FETCHED
assert MC == [({'S2': 'Sep 2026', 'S7': 'Sep 2026', 'S8': 'Sep 2026'}, ['S2', 'S7'])], MC   # S8: screener has it now
log = '\n'.join(LOGS)
assert 'Continuing the round of %s that stopped half-way' % T(40)[:16] in log and '7 page(s) were already sent' in log, log
assert '7 sent earlier in this round are skipped.' in log, log
assert sb.run_state_load()['stage'] == 'done' and not os.path.exists(sb.LOCK_PATH)

# a round of this version stopped half-way (the computer went off during the 2nd batch): the next one continues it
LIST[:] = [{'ok': True, 'priority': ['A%d' % i for i in range(12)], 'missing': [], 'mc': {}}]
del CALLS[:], FETCHED[:], LOGS[:]
BOOM['put'] = 2
try:
    sb.run_once(CFG)
    raise AssertionError('should have stopped')
except KeyboardInterrupt:
    pass
st = sb.run_state_load()
assert st['stage'] == 'screener' and st['sent'] == ['A0', 'A1', 'A2', 'A3', 'A4'], st
assert not os.path.exists(sb.LOCK_PATH), 'the lock goes with the program (a shut-down computer leaves it: see above)'
BOOM.clear()
del CALLS[:], FETCHED[:]
sb.run_once(CFG)
assert CALLS[:2] == ['list', 'process'] and FETCHED == ['A%d' % i for i in range(5, 12)], (CALLS, FETCHED)
assert sb.run_state_load()['stage'] == 'done'
# and the round after that is an ordinary one again
del CALLS[:], FETCHED[:]
sb.run_once(CFG)
assert CALLS[:2] == ['list', 'put'] and len(FETCHED) == 12, (CALLS, FETCHED)
print('OK')
