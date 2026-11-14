# -*- coding: utf-8 -*-
"""Where the big data lives (owner, 14-Nov-2026: "yes i want the datas to be in D drive. apo than c drive la konjam spaces
irukum. laptop speed ah irukum" - the 20 years of Kite candles, 4-8 GB).

The big folders BIG (intraday_data = Kite candles incl. the 1-hour / 15-minute files, lab_cache = the Backtest Lab's
candle cache, lab_charts = the runs' chart PDFs) sit next to the program (the ScreenerBridge folder) unless config.json
`data_folder` names another folder (MoveDataToD.bat asks for it, default DEFAULT_FOLDER). The small state files stay next
to the program.

  * place.json `data_place.json` {at} = where the folders ARE (missing = next to the program). It changes only when a
    move has finished, so every program reads one place at a time.
  * `current(cfg, here)` -> (the place to use now, the wanted place or None when no move is waiting).
  * `move(src, dst, out)` moves file by file (each file copied to <name>.moving, renamed, then the original removed), so
    a move cut off by a power cut / sign-out loses nothing: the next start moves the rest (files still at the old place
    win - they are the ones in use). A move that fails (disk full ...) puts back what it moved.
  * The background program (`login`) moves at its start, before any of its threads; MoveDataToD.bat moves at once when
    the background program is not running, else it saves the folder and the move happens at the next sign-in.
Pure standard library."""
import json
import os
import shutil
import time

BIG = ('intraday_data', 'lab_cache', 'lab_charts')
PLACE_FILE = 'data_place.json'
MOVING_FILE = 'data_moving.json'   # {pid, src, dst, at} while a move runs (the other programs wait)
DEFAULT_FOLDER = r'D:\StockBlueprintData'
SPARE_BYTES = 2 * 1024 ** 3        # the new place must have the data's size + this free
GROWTH_BYTES = 8 * 1024 ** 3       # what KiteHistoryNow.bat may still add (only a warning)
SAY_EVERY_S = 30
TMP_SUFFIX = '.moving'


def _norm(p):
    return os.path.normcase(os.path.normpath(os.path.abspath(p)))


def same(a, b):
    return _norm(a) == _norm(b)


def place_path(here):
    return os.path.join(here, PLACE_FILE)


def place(here):
    """Where the big folders are now (absolute path)."""
    try:
        with open(place_path(here), 'r', encoding='utf-8') as f:
            at = (json.load(f) or {}).get('at')
        if at and isinstance(at, str):
            return os.path.abspath(at)
    except (OSError, ValueError, AttributeError):
        pass
    return os.path.abspath(here)


def set_place(here, at):
    p = place_path(here)
    if same(at, here):
        try:
            os.remove(p)
        except OSError:
            pass
        return
    tmp = p + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump({'at': os.path.abspath(at), 'since': time.strftime('%Y-%m-%d %H:%M:%S')}, f)
    os.replace(tmp, p)


def moving(here, alive):
    """The running move ({pid, src, dst, at}) when its program is still alive (alive(pid)), else None."""
    try:
        with open(os.path.join(here, MOVING_FILE), 'r', encoding='utf-8') as f:
            info = json.load(f) or {}
    except (OSError, ValueError):
        return None
    if info.get('pid') == os.getpid() or not alive(info.get('pid')):
        return None
    return info


def _mark(here, src, dst):
    try:
        with open(os.path.join(here, MOVING_FILE), 'w', encoding='utf-8') as f:
            json.dump({'pid': os.getpid(), 'src': src, 'dst': dst, 'at': time.strftime('%Y-%m-%d %H:%M:%S')}, f)
    except OSError:
        pass


def _unmark(here):
    try:
        os.remove(os.path.join(here, MOVING_FILE))
    except OSError:
        pass


def wanted(cfg, here):
    """config.json `data_folder` (absolute; '' / missing = next to the program)."""
    w = str((cfg or {}).get('data_folder') or '').strip().strip('"')
    return os.path.abspath(w) if w else os.path.abspath(here)


def current(cfg, here):
    """(the place to read / write now, the wanted place when a move is still waiting else None)."""
    now, want = place(here), wanted(cfg, here)
    if same(now, want):
        return now, None
    if not has_data(now):          # nothing to move (a new computer / an empty place): the wanted place from now on
        try:
            set_place(here, want)
        except OSError:
            pass
        return want, None
    return now, want


def has_data(base):
    for name in BIG:
        p = os.path.join(base, name)
        if os.path.isdir(p):
            for _root, _dirs, files in os.walk(p):
                if files:
                    return True
    return False


def size_of(base):
    """(files, bytes) of the big folders at base."""
    n = b = 0
    for name in BIG:
        for root, _dirs, files in os.walk(os.path.join(base, name)):
            for fn in files:
                try:
                    b += os.path.getsize(os.path.join(root, fn))
                    n += 1
                except OSError:
                    pass
    return n, b


def free_bytes(path):
    """Free space of the drive holding path (its nearest existing parent), or None."""
    p = os.path.abspath(path)
    while p and not os.path.exists(p):
        up = os.path.dirname(p)
        if up == p:
            return None
        p = up
    try:
        return shutil.disk_usage(p).free
    except OSError:
        return None


def gb(b):
    return '%.1f GB' % (b / 1024.0 ** 3)


def check_target(dst, need):
    """'' when dst can take `need` bytes, else why not (drive missing, not writable, too little space)."""
    drive = os.path.splitdrive(os.path.abspath(dst))[0]
    if drive and not os.path.exists(drive + os.sep):
        return 'there is no %s drive on this computer' % drive
    try:
        os.makedirs(dst, exist_ok=True)
        probe = os.path.join(dst, '.write_test')
        with open(probe, 'w') as f:
            f.write('ok')
        os.remove(probe)
    except OSError as e:
        return 'cannot write in %s (%s)' % (dst, e)
    free = free_bytes(dst)
    if free is not None and free < need + SPARE_BYTES:
        return '%s has %s free, the data needs %s (+ 2 GB spare)' % (dst, gb(free), gb(need))
    return ''


def _files(src):
    for name in BIG:
        top = os.path.join(src, name)
        for root, _dirs, files in os.walk(top):
            for fn in files:
                if not fn.endswith(TMP_SUFFIX):
                    yield os.path.join(root, fn)


def _move_files(src, dst, out, total, every_s, verb, rels=None, moved=None):
    """The files of src's big folders (rels = these relative paths only) to the same place under dst; each one moved is
    added to `moved`. -> (files, bytes) moved. Raises OSError."""
    t0 = last = time.time()
    n = done = 0
    for rel in (list(rels) if rels is not None else [os.path.relpath(fp, src) for fp in _files(src)]):
        fp = os.path.join(src, rel)
        if not os.path.isfile(fp):
            continue
        to = os.path.join(dst, rel)
        os.makedirs(os.path.dirname(to), exist_ok=True)
        size = os.path.getsize(fp)
        tmp = to + TMP_SUFFIX
        shutil.copyfile(fp, tmp)
        try:
            shutil.copystat(fp, tmp)
        except OSError:
            pass
        os.replace(tmp, to)
        os.remove(fp)
        if moved is not None:
            moved.append(rel)
        n += 1
        done += size
        if out and time.time() - last >= every_s:
            last = time.time()
            left = (time.time() - t0) / done * (total - done) if done and total > done else 0
            out('%s: %s of %s done%s ...' % (verb, gb(done), gb(total), ', about %d min left' % max(1, round(left / 60)) if left else ''))
    return n, done


def _tidy(src):
    """Empty folders and half-copied files left at src removed."""
    for name in BIG:
        top = os.path.join(src, name)
        if not os.path.isdir(top):
            continue
        for root, dirs, files in os.walk(top, topdown=False):
            for fn in files:
                if fn.endswith(TMP_SUFFIX):
                    try:
                        os.remove(os.path.join(root, fn))
                    except OSError:
                        pass
            try:
                os.rmdir(root)
            except OSError:
                pass


def move(here, src, dst, out=print, every_s=SAY_EVERY_S):
    """The big folders src -> dst; on success place.json = dst. -> (ok, words)."""
    if same(src, dst):
        return True, 'already there'
    files, total = size_of(src)
    why = check_target(dst, total)
    if why:
        return False, why
    if out:
        out('Moving the Kite / Backtest Lab data (%s, %d files) from %s to %s ...' % (gb(total), files, src, dst))
    t0 = time.time()
    moved = []
    _mark(here, src, dst)
    try:
        return _move(here, src, dst, out, every_s, total, t0, moved)
    finally:
        _unmark(here)


def _move(here, src, dst, out, every_s, total, t0, moved):
    try:
        n, b = _move_files(src, dst, out, total, every_s, 'Moving', moved=moved)
    except OSError as e:
        if out:
            out('The move stopped (%s) - putting the %d moved files back ...' % (e, len(moved)))
        try:
            _move_files(dst, src, out, total, every_s, 'Putting back', rels=moved)
            _tidy(dst)
        except OSError as e2:
            return False, 'the move stopped (%s) and putting back stopped too (%s) - the next start tries again' % (e, e2)
        return False, 'the move stopped (%s); everything is back at %s' % (e, src)
    _tidy(src)
    set_place(here, dst)
    secs = time.time() - t0
    took = ('%d seconds' % max(1, round(secs))) if secs < 90 else ('%d minutes' % round(secs / 60))
    return True, 'moved %s (%d files) in %s - the data is now in %s' % (gb(b), n, took, dst)


def apply(base, itd):
    """The program's folders -> base (kite_intraday as itd and its backtest_lab)."""
    itd.DATA_DIR = os.path.join(base, 'intraday_data')
    lab = itd.backtest_lab
    lab.LAB_DIR = os.path.join(base, 'lab_cache')
    lab.CHARTS_DIR = os.path.join(base, 'lab_charts')
    lab.LTF_DIR = os.path.join(itd.DATA_DIR, 'ltf')
