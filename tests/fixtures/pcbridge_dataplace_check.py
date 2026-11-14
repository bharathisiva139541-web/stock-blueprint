"""Offline checks for the big data's folder (pcbridge/ScreenerBridge/data_place.py + screener_bridge.py datafolder /
data_start): owner, 14-Nov-2026 - "yes i want the datas to be in D drive. apo than c drive la konjam spaces irukum".
Run by tests/pcbridge-dataplace.test.js (prints OK on success, raises on failure)."""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

ROOT = os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
spec = importlib.util.spec_from_file_location('screener_bridge', os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'screener_bridge.py'))
sb = importlib.util.module_from_spec(spec)
spec.loader.exec_module(sb)
DP, itd, L = sb.DP, sb.itd, sb.itd.backtest_lab

TMP = tempfile.mkdtemp()
HERE = os.path.join(TMP, 'ScreenerBridge')
DRIVE_D = os.path.join(TMP, 'D', 'StockBlueprintData')
os.makedirs(HERE)
sb.HERE = HERE
sb.CONFIG_PATH = os.path.join(HERE, 'config.json')
sb.LOOP_PATH = os.path.join(HERE, 'bridge_loop.json')
LOGS = []
sb.log = LOGS.append


def put(base, rel, text):
    p = os.path.join(base, rel)
    os.makedirs(os.path.dirname(p), exist_ok=True)
    with open(p, 'w') as f:
        f.write(text)


def tree(base):
    out = {}
    for name in DP.BIG:
        for root, _d, files in os.walk(os.path.join(base, name)):
            for fn in files:
                p = os.path.join(root, fn)
                with open(p) as f:
                    out[os.path.relpath(p, base).replace(os.sep, '/')] = f.read()
    return out


DATA = {
    'intraday_data/RELIANCE.json.gz': 'reliance store',
    'intraday_data/TCS.json.gz': 'tcs store',
    'intraday_data/ltf/RELIANCE.1H.bin': 'one hour',
    'intraday_data/ltf/RELIANCE.15m.bin': 'fifteen',
    'intraday_data/indices/NIFTY_50.json.gz': 'nifty',
    'lab_cache/b20261114/D.bin': 'cache',
    'lab_cache/current.txt': 'b20261114',
    'lab_charts/run one.pdf': 'pdf',
}


def fresh():
    for p in (HERE, os.path.join(TMP, 'D')):
        shutil.rmtree(p, ignore_errors=True)
    os.makedirs(HERE)
    for rel, text in DATA.items():
        put(HERE, rel, text)


# ------------------------------------------------------------------ 1. where the data is / should be
fresh()
cfg = {}
assert DP.place(HERE) == os.path.abspath(HERE) and DP.current(cfg, HERE) == (os.path.abspath(HERE), None)
assert DP.current({'data_folder': DRIVE_D}, HERE) == (os.path.abspath(HERE), os.path.abspath(DRIVE_D)), 'a move waits'
assert DP.has_data(HERE) and not DP.has_data(DRIVE_D)
n, b = DP.size_of(HERE)
assert n == len(DATA) and b == sum(len(t) for t in DATA.values())
DP.apply(DRIVE_D, itd)
assert itd.DATA_DIR == os.path.join(DRIVE_D, 'intraday_data') and itd.ltf_dir() == os.path.join(DRIVE_D, 'intraday_data', 'ltf')
assert L.LAB_DIR == os.path.join(DRIVE_D, 'lab_cache') and L.CHARTS_DIR == os.path.join(DRIVE_D, 'lab_charts')
assert L.LTF_DIR == itd.ltf_dir() and itd.store_path('TCS') == os.path.join(DRIVE_D, 'intraday_data', 'TCS.json.gz')
KCFG = {'kite_api_key': 'k', 'kite_api_secret': 's'}
assert itd.configured(KCFG) and itd.status_line(KCFG).endswith('; data folder: ' + DRIVE_D), itd.status_line(KCFG)
DP.apply(HERE, itd)
# a new computer (nothing next to the program): the wanted place at once, remembered
shutil.rmtree(HERE)
os.makedirs(HERE)
assert DP.current({'data_folder': DRIVE_D}, HERE) == (os.path.abspath(DRIVE_D), None) and DP.place(HERE) == os.path.abspath(DRIVE_D)
assert DP.current({}, HERE) == (os.path.abspath(DRIVE_D), None) or not DP.has_data(DRIVE_D)

# ------------------------------------------------------------------ 2. the move: every file, the old place emptied, the place remembered
fresh()
said = []
ok, words = DP.move(HERE, HERE, DRIVE_D, out=said.append, every_s=0)
assert ok and 'the data is now in ' + os.path.abspath(DRIVE_D) in words, words
assert tree(DRIVE_D) == DATA and tree(HERE) == {} and not any(os.path.isdir(os.path.join(HERE, x)) for x in DP.BIG)
assert DP.place(HERE) == os.path.abspath(DRIVE_D) and json.load(open(os.path.join(HERE, DP.PLACE_FILE)))['at'] == os.path.abspath(DRIVE_D)
assert said[0].startswith('Moving the Kite / Backtest Lab data') and any(' of ' in x and 'done' in x for x in said[1:]), said
assert not os.path.exists(os.path.join(HERE, DP.MOVING_FILE)), 'the marker is removed'
for root, _d, files in os.walk(DRIVE_D):
    assert not [f for f in files if f.endswith(DP.TMP_SUFFIX)], files
# and back (HERE)
ok, words = DP.move(HERE, DRIVE_D, HERE, out=None)
assert ok and tree(HERE) == DATA and tree(DRIVE_D) == {} and not os.path.exists(os.path.join(HERE, DP.PLACE_FILE))

# ------------------------------------------------------------------ 3. a move cut off (sign-out / power cut): the next one moves the rest
fresh()
put(DRIVE_D, 'intraday_data/TCS.json.gz', 'an older tcs copy')          # already there from an earlier try
real_copy = DP.shutil.copyfile
count = [0]


def cut(a, b):
    count[0] += 1
    if count[0] == 4:
        raise KeyboardInterrupt('signed out')
    return real_copy(a, b)


DP.shutil.copyfile = cut
try:
    DP.move(HERE, HERE, DRIVE_D, out=None)
    raise AssertionError('should have stopped')
except KeyboardInterrupt:
    pass
finally:
    DP.shutil.copyfile = real_copy
assert DP.place(HERE) == os.path.abspath(HERE), 'not done = still the old place'
half = tree(DRIVE_D)
assert 3 <= len([k for k in half if k in DATA]) <= len(DATA)
ok, words = DP.move(HERE, HERE, DRIVE_D, out=None)
assert ok and tree(DRIVE_D) == DATA and tree(HERE) == {}, (tree(DRIVE_D), tree(HERE))   # TCS: the old place's copy won
for root, _d, files in os.walk(DRIVE_D):
    assert not [f for f in files if f.endswith(DP.TMP_SUFFIX)], files

# ------------------------------------------------------------------ 4. a move that fails (disk full): what it moved goes back
fresh()
put(DRIVE_D, 'lab_charts/old.pdf', 'already on D')
count[0] = 0


def full(a, b):
    count[0] += 1
    if count[0] == 5:
        raise OSError(28, 'No space left on device')
    return real_copy(a, b)


DP.shutil.copyfile = full
try:
    ok, words = DP.move(HERE, HERE, DRIVE_D, out=None)
finally:
    DP.shutil.copyfile = real_copy
assert not ok and 'everything is back at' in words and 'No space left' in words, words
assert tree(HERE) == DATA and tree(DRIVE_D) == {'lab_charts/old.pdf': 'already on D'}, tree(DRIVE_D)
assert DP.place(HERE) == os.path.abspath(HERE) and not os.path.exists(os.path.join(HERE, DP.MOVING_FILE))

# ------------------------------------------------------------------ 5. the target's checks
fresh()
real_free = DP.free_bytes
DP.free_bytes = lambda p: 1024
why = DP.check_target(DRIVE_D, 10 ** 6)
DP.free_bytes = real_free
assert 'free, the data needs' in why, why
DP.free_bytes = lambda p: 10
try:
    ok, words = DP.move(HERE, HERE, DRIVE_D, out=None)
finally:
    DP.free_bytes = real_free
assert not ok and 'free' in words and tree(HERE) == DATA and tree(DRIVE_D) == {}
blocker = os.path.join(TMP, 'a file')
open(blocker, 'w').close()
assert 'cannot write' in DP.check_target(os.path.join(blocker, 'sub'), 1)
if os.name == 'nt':
    assert 'there is no' in DP.check_target('Q:\\nowhere', 1) or os.path.exists('Q:\\')

# ------------------------------------------------------------------ 6. MoveDataToD.bat (command datafolder)
fresh()
sb.save_config({'url': 'u', 'token': 't'})
out = []
asked = []
alive = [False]
sb.loop_running = lambda: alive[0]
assert sb.cmd_datafolder(sb.load_config(), (), ask=lambda q: asked.append(q) or DRIVE_D, out=out.append) == 0, out
assert 'Enter = ' + DP.DEFAULT_FOLDER + ';' in asked[0] and DP.DEFAULT_FOLDER == 'D:\\StockBlueprintData', asked
assert sb.load_config()['data_folder'] == os.path.abspath(DRIVE_D) and sb.load_config()['token'] == 't'
assert tree(DRIVE_D) == DATA and DP.place(HERE) == os.path.abspath(DRIVE_D)
assert any(x.startswith('Done - moved ') for x in out) and any('is now in:' in x for x in out), out
out = []
assert sb.cmd_datafolder(sb.load_config(), (), ask=lambda q: '', out=out.append) == 0 and any('already in' in x for x in out), out
# HERE = back next to the program
out = []
assert sb.cmd_datafolder(sb.load_config(), (), ask=lambda q: 'here', out=out.append) == 0, out
assert tree(HERE) == DATA and sb.load_config()['data_folder'] == '' and DP.place(HERE) == os.path.abspath(HERE)
# the background program runs -> only saved, it moves at the next sign-in
alive[0] = True
out = []
assert sb.cmd_datafolder(sb.load_config(), (DRIVE_D,), out=out.append) == 0
assert tree(HERE) == DATA and tree(DRIVE_D) == {} and sb.load_config()['data_folder'] == os.path.abspath(DRIVE_D)
assert any('Sign out of Windows' in x for x in out) and any('moves the data FIRST' in x for x in out), out
# no space -> nothing changed
alive[0] = False
sb.save_config({'url': 'u', 'token': 't'})
DP.free_bytes = lambda p: 10
out = []
try:
    assert sb.cmd_datafolder(sb.load_config(), (DRIVE_D,), out=out.append) == 1
finally:
    DP.free_bytes = real_free
assert 'data_folder' not in sb.load_config() and any(x.startswith('PROBLEM - ') and 'Nothing was changed' in x for x in out), out
# a move running in another program -> wait
with open(os.path.join(HERE, DP.MOVING_FILE), 'w') as f:
    json.dump({'pid': 424242, 'dst': DRIVE_D}, f)
real_alive = sb._pid_alive
sb._pid_alive = lambda pid: pid == 424242
out = []
assert sb.cmd_datafolder(sb.load_config(), (DRIVE_D,), out=out.append) == 1 and 'being moved right now' in out[0]
assert DP.moving(HERE, sb._pid_alive)['dst'] == DRIVE_D
printed = []
sb.print = printed.append
try:
    assert sb.main(['x', 'backtest']) == 1 and 'is being moved to ' + DRIVE_D + ' right now' in printed[0], printed
finally:
    del sb.print
sb._pid_alive = real_alive
assert DP.moving(HERE, lambda pid: False) is None, 'a dead mover does not block'
os.remove(os.path.join(HERE, DP.MOVING_FILE))

# ------------------------------------------------------------------ 7. the background program moves FIRST, before its threads
fresh()
sb.save_config({'url': 'u', 'token': 't', 'data_folder': DRIVE_D})
seen = []


class Started(Exception):
    pass


def runner():
    seen.append((tree(DRIVE_D) == DATA, itd.DATA_DIR))
    raise Started()


sb.loop_claim = lambda: True
real_runner = itd.Runner
itd.Runner = runner
LOGS.clear()
try:
    sb.run_after_login(sb.load_config())
    raise AssertionError('the runner should have started')
except Started:
    pass
finally:
    itd.Runner = real_runner
assert seen == [(True, os.path.join(os.path.abspath(DRIVE_D), 'intraday_data'))], seen
assert any(x.startswith('Moving the Kite / Backtest Lab data') for x in LOGS) and any(x.startswith('Data folder: moved ') for x in LOGS), LOGS
assert tree(HERE) == {}
# the next start: nothing to move, the folders point to D
LOGS.clear()
DP.apply(HERE, itd)
assert sb.data_start(sb.load_config()) == os.path.abspath(DRIVE_D) and not LOGS and itd.DATA_DIR.startswith(os.path.abspath(DRIVE_D))
# a command (BacktestNow.bat) uses the place, and says when a move is still waiting
DP.apply(HERE, itd)
sb.use_data_place(sb.load_config())
assert itd.DATA_DIR == os.path.join(os.path.abspath(DRIVE_D), 'intraday_data')
fresh()
sb.save_config({'url': 'u', 'token': 't', 'data_folder': DRIVE_D})
printed = []
sb.print = printed.append
real_bt = itd.backtest_now
itd.backtest_now = lambda cfg, api, hol: 0
try:
    assert sb.main(['x', 'backtest']) == 0
finally:
    del sb.print
    itd.backtest_now = real_bt
assert itd.DATA_DIR == os.path.join(HERE, 'intraday_data') and 'it moves to' in printed[0], printed

# ------------------------------------------------------------------ 8. the Lab's charts PDF says its real folder
assert "'path': os.path.abspath(folder)" in open(os.path.join(ROOT, 'pcbridge', 'ScreenerBridge', 'backtest_lab.py')).read()

shutil.rmtree(TMP, ignore_errors=True)
print('OK')
