"""The PC's auto update (pcbridge/ScreenerBridge/self_update.py; owner, 16-Nov-2026: "You itself place the code to the script and
copy and paste file to Screenerbridge folder. here after i won't do this job"): GitHub's newest version -> this folder's files
(checked, all or none, backed up) + the sheet's Code / Code2 through the Apps Script API (the web app's own deployment moved to
a new version), the one-time Google login, the restart rules. Offline: a made GitHub / Google answer each request."""
import base64
import hashlib
import json
import os
import shutil
import sys
import tempfile
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timedelta, timezone

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, os.path.join(HERE, '..', '..', 'pcbridge', 'ScreenerBridge'))
import self_update as U  # noqa: E402

LOGS = []
U.log = LOGS.append
TMP = tempfile.mkdtemp(prefix='sbupd')
SHA1, SHA2 = 'a' * 40, 'b' * 40
DID = 'AKfycb' + 'x' * 40
CFG = {'url': 'https://script.google.com/macros/s/%s/exec' % DID, 'token': 't'}


def b(s):
    return s.encode('utf-8')


# ------------------------------------------------------------------ 1. git's blob hash
assert U.blob_sha(b'hello\n') == 'ce013625030ba8dba906f756967f9e9ca394464a'
assert U.blob_sha(b'') == 'e69de29bb2d1d6434b8b29ae775ad8c2e48c5391'


class Hub:
    """GitHub + Google, answering from dicts; every request recorded."""

    def __init__(self):
        self.sha = SHA1
        self.tree = {}            # commit -> {path: bytes}
        self.calls = []
        self.token_ok = True
        self.live = {'appsscript': ('JSON', '{"timeZone": "Asia/Kolkata"}'), 'Code': ('SERVER_JS', 'old code'),
                     'Code2': ('SERVER_JS', 'old code 2')}
        self.version = 61
        self.deployed = None
        self.api_off = False
        self.bad_raw = set()

    def __call__(self, method, url, headers=None, body=None, timeout=60):
        self.calls.append((method, url))
        u = urllib.parse.urlparse(url)
        if url.startswith(U.GH_API + '/repos/%s/commits/' % U.REPO):
            return 200, b(json.dumps({'sha': self.sha}))
        if url.startswith(U.GH_API + '/repos/%s/contents' % U.REPO):
            q = urllib.parse.parse_qs(u.query)
            files = self.tree[q['ref'][0]]
            path = u.path.split('/contents', 1)[1].lstrip('/')
            out = []
            for p, data in files.items():
                folder, _, name = p.rpartition('/')
                if folder == path:
                    out.append({'type': 'file', 'name': name, 'sha': U.blob_sha(data)})
            out.append({'type': 'dir', 'name': 'sub', 'sha': 'x'})
            return 200, b(json.dumps(out))
        if url.startswith(U.GH_RAW):
            parts = u.path.split('/')               # /owner/repo/sha/path...
            commit, path = parts[3], urllib.parse.unquote('/'.join(parts[4:]))
            data = self.tree.get(commit, {}).get(path)
            if data is None:
                return 404, b''
            return 200, (data + b' tampered' if path in self.bad_raw else data)
        if url == U.TOKEN_URL:
            form = urllib.parse.parse_qs(body.decode('ascii'))
            assert form['client_id'] == [U.CLIENT_ID] and form['client_secret'] == [U.CLIENT_SECRET]
            if form['grant_type'] == ['authorization_code']:
                v = form['code_verifier'][0]
                assert form['code'] == ['code-123'] and len(v) >= 43, form
                self.verifier = v
                return 200, b(json.dumps({'refresh_token': 'refresh-1', 'access_token': 'a1', 'scope': U.SCOPES}))
            assert form['refresh_token'] == ['refresh-1']
            return (200, b(json.dumps({'access_token': 'access-1'}))) if self.token_ok else (400, b'{"error": "invalid_grant"}')
        if url.startswith(U.SCRIPT_API):
            assert headers.get('Authorization') == 'Bearer access-1', headers
            rest = url[len(U.SCRIPT_API):]
            sid, _, what = rest.partition('/')
            assert sid == 'SCRIPT-ID-0123456789abcdef', sid
            if self.api_off:
                return 403, b(json.dumps({'error': {'message': 'User has not enabled the Apps Script API. Enable it by visiting ...'}}))
            if what == 'content' and method == 'GET':
                return 200, b(json.dumps({'scriptId': sid, 'files': [{'name': n, 'type': t, 'source': s.replace('\n', '\r\n') if n == 'Code' else s,
                                                                       'functionSet': {}} for n, (t, s) in self.live.items()]}))
            if what == 'content' and method == 'PUT':
                got = json.loads(body.decode('utf-8'))
                assert headers.get('Content-Type') == 'application/json'
                self.live = {f['name']: (f['type'], f['source']) for f in got['files']}
                return 200, b'{}'
            if what == 'versions' and method == 'POST':
                self.version += 1
                return 200, b(json.dumps({'versionNumber': self.version}))
            if what.startswith('deployments/') and method == 'PUT':
                assert what == 'deployments/' + DID, what
                cfg = json.loads(body.decode('utf-8'))['deploymentConfig']
                assert cfg['manifestFileName'] == 'appsscript' and cfg['scriptId'] == sid
                self.deployed = cfg['versionNumber']
                return 200, b'{}'
        raise AssertionError('unexpected request %s %s' % (method, url))


def api_ok(cfg, action, payload=None, **kw):
    assert action == 'scriptid'
    return {'ok': True, 'scriptId': 'SCRIPT-ID-0123456789abcdef'}


def tree(code='new code', code2='new code 2', py='X = 1\n', extra=None):
    t = {'Code.gs': b(code), 'Code2.gs': b(code2), 'README.md': b'readme',
         U.SUB + '/screener_bridge.py': b(py), U.SUB + '/self_update.py': b('Y = 2\n'), U.SUB + '/RunNow.bat': b'@echo off\r\n',
         U.SUB + '/config.json': b'{"never": 1}'}
    t.update(extra or {})
    return t


def folder(name):
    d = os.path.join(TMP, name)
    os.makedirs(d)
    with open(os.path.join(d, 'screener_bridge.py'), 'w') as f:
        f.write('X = 0\n')
    with open(os.path.join(d, 'self_update.py'), 'w') as f:
        f.write('Y = 2\n')
    with open(os.path.join(d, 'config.json'), 'w') as f:
        f.write('{"mine": true}')
    with open(os.path.join(d, 'kite_session.json'), 'w') as f:
        f.write('{"keep": true}')
    return d


def login(d):
    with open(os.path.join(d, U.SESSION_FILE), 'w') as f:
        json.dump({'refresh_token': 'refresh-1'}, f)


# ------------------------------------------------------------------ 2. plan + apply: all or none, backed up
d2 = folder('plan')
remote = {'screener_bridge.py': U.blob_sha(b'X = 1\n'), 'self_update.py': U.blob_sha(b'Y = 2\n'), 'RunNow.bat': U.blob_sha(b'@echo off\r\n'),
          'config.json': 'f' * 40, '../evil.py': 'f' * 40}
assert U.plan(d2, remote) == ['RunNow.bat', 'screener_bridge.py'], 'missing / different files only; never config.json or odd names'
hub = Hub()
hub.tree[SHA1] = tree(py='def broken(:\n')
try:
    U.apply_files(d2, SHA1, U.listing(SHA1, U.SUB, hub), ['RunNow.bat', 'screener_bridge.py'], hub)
    raise AssertionError('a .py that does not compile')
except U.UpdateError as e:
    assert 'does not compile' in str(e)
assert open(os.path.join(d2, 'screener_bridge.py')).read() == 'X = 0\n' and not os.path.exists(os.path.join(d2, 'RunNow.bat'))
assert not os.path.exists(os.path.join(d2, U.STAGE_DIR)), 'nothing left behind'
hub.tree[SHA1] = tree()
hub.bad_raw = {U.SUB + '/screener_bridge.py'}
try:
    U.apply_files(d2, SHA1, U.listing(SHA1, U.SUB, hub), ['RunNow.bat', 'screener_bridge.py'], hub)
    raise AssertionError('a download that does not match GitHub')
except U.UpdateError as e:
    assert 'does not match' in str(e)
assert open(os.path.join(d2, 'screener_bridge.py')).read() == 'X = 0\n'
hub.bad_raw = set()
U.apply_files(d2, SHA1, U.listing(SHA1, U.SUB, hub), ['RunNow.bat', 'screener_bridge.py'], hub, stamp='20261116-150000')
assert open(os.path.join(d2, 'screener_bridge.py')).read() == 'X = 1\n' and os.path.exists(os.path.join(d2, 'RunNow.bat'))
assert open(os.path.join(d2, U.BACKUP_DIR, '20261116-150000', 'screener_bridge.py')).read() == 'X = 0\n', 'the old file backed up'
assert open(os.path.join(d2, 'config.json')).read() == '{"mine": true}'
for k in range(7):                                   # only the newest 5 backups stay
    U.apply_files(d2, SHA1, {'screener_bridge.py': U.blob_sha(b'X = 1\n')}, ['screener_bridge.py'], hub, stamp='2026111%d-000000' % k)
assert len(os.listdir(os.path.join(d2, U.BACKUP_DIR))) == U.KEEP_BACKUPS

# ------------------------------------------------------------------ 3. the whole check: the sheet first, then the folder
d3 = folder('full')
login(d3)
hub = Hub()
hub.tree[SHA1] = tree()
up = U.Updater(d3, hub)
done = up.check_once(CFG, api_ok)
assert done == {'sha': SHA1, 'files': ['RunNow.bat', 'screener_bridge.py'], 'sheet': 62}, done
assert hub.live['Code'] == ('SERVER_JS', 'new code') and hub.live['Code2'] == ('SERVER_JS', 'new code 2')
assert hub.live['appsscript'] == ('JSON', '{"timeZone": "Asia/Kolkata"}'), 'the manifest stays as it is'
assert hub.deployed == 62, 'the web app\'s own deployment moved to the new version'
assert open(os.path.join(d3, 'kite_session.json')).read() == '{"keep": true}' and open(os.path.join(d3, 'config.json')).read() == '{"mine": true}'
bk = [n for n in os.listdir(os.path.join(d3, U.BACKUP_DIR)) if n.startswith('sheet-')]
assert len(bk) == 1 and json.load(open(os.path.join(d3, U.BACKUP_DIR, bk[0])))['files'][1]['source'].startswith('old code'), 'the old code kept'
st = json.load(open(os.path.join(d3, U.STATE_FILE)))
assert st['sha'] == SHA1 and st['scriptId'] == 'SCRIPT-ID-0123456789abcdef' and set(st['gs']) == {'Code.gs', 'Code2.gs'}
assert any('the web app moved to version 62' in m for m in LOGS) and any('2 file(s) of this program updated' in m for m in LOGS)
# nothing new: no sheet call, no download
n = len(hub.calls)
assert up.check_once(CFG, api_ok) == {'sha': SHA1, 'files': [], 'sheet': None}
assert not [c for c in hub.calls[n:] if c[1].startswith((U.SCRIPT_API, U.GH_RAW, U.TOKEN_URL))], hub.calls[n:]
# a new commit with only laptop files changed: the sheet is not touched
hub.tree[SHA2] = tree(py='X = 2\n')
hub.sha = SHA2
n = len(hub.calls)
assert up.check_once(CFG, api_ok) == {'sha': SHA2, 'files': ['screener_bridge.py'], 'sheet': None}
assert not [c for c in hub.calls[n:] if c[1].startswith(U.SCRIPT_API)]
# the sheet already runs the new code (e.g. put in by hand): recorded, no new version (CRLF in the editor's copy is the same code)
d3b = folder('same')
login(d3b)
hub2 = Hub()
hub2.tree[SHA1] = tree(code='old code', code2='old code 2')
assert U.Updater(d3b, hub2).check_once(CFG, api_ok)['sheet'] == 'same' and hub2.deployed is None and hub2.version == 61

# ------------------------------------------------------------------ 4. no Google login / the sheet cannot be updated: the folder still is
d4 = folder('nologin')
hub = Hub()
hub.tree[SHA1] = tree()
LOGS.clear()
done = U.Updater(d4, hub).check_once(CFG, api_ok, login=False)
assert done == {'sha': SHA1, 'files': ['RunNow.bat', 'screener_bridge.py'], 'sheet': None}, done
assert any('waits for the Google login (double-click GoogleLogin.bat)' in m for m in LOGS)
assert 'gs' not in json.load(open(os.path.join(d4, U.STATE_FILE))), 'tried again at the next check'
# the Apps Script API switched off
d4b = folder('apioff')
login(d4b)
hub = Hub()
hub.tree[SHA1] = tree()
hub.api_off = True
LOGS.clear()
done = U.Updater(d4b, hub).check_once(CFG, api_ok)
assert done['sheet'] is None and done['files'], done
assert any('script.google.com/home/usersettings' in m for m in LOGS), LOGS
# an older web app (no scriptid action) / the sheet not answering
d4c = folder('oldapp')
login(d4c)
hub = Hub()
hub.tree[SHA1] = tree()
LOGS.clear()
U.Updater(d4c, hub).check_once(CFG, lambda *a, **k: {'ok': False, 'error': 'unknown action'})
assert any('did not say which script it is (unknown action)' in m for m in LOGS), LOGS


def down(*a, **k):
    raise RuntimeError('Could not reach the sheet: timed out')


LOGS.clear()
U.Updater(d4c, hub).check_once(CFG, down)
assert any('the sheet did not answer (Could not reach the sheet: timed out)' in m for m in LOGS), LOGS
# a revoked login: the key file goes (the login page comes again)
hub.token_ok = False
assert U.access_token(d4c, hub) is None and not os.path.exists(os.path.join(d4c, U.SESSION_FILE))
# no web-app address in config.json
try:
    U.deploy_sheet({'url': ''}, 'SCRIPT-ID-0123456789abcdef', SHA1, {'Code': 'x'}, 'access-1', d4c, Hub())
    raise AssertionError('no address')
except U.UpdateError as e:
    assert 'no web-app address' in str(e)
# GitHub down: a log line, the program goes on
LOGS.clear()


def offline(*a, **k):
    raise U.UpdateError('no connection (timed out)')


assert U.Updater(d4c, offline).check_once(CFG, api_ok)['sha'] is None and any('no connection' in m for m in LOGS)

# ------------------------------------------------------------------ 5. the one-time Google login (a browser made here)
d5 = folder('login')
hub = Hub()


def browser(url):
    q = urllib.parse.parse_qs(urllib.parse.urlparse(url).query)
    assert q['client_id'] == [U.CLIENT_ID] and q['scope'] == [U.SCOPES] and q['access_type'] == ['offline']
    assert q['redirect_uri'] == ['http://localhost:18899'] and q['code_challenge_method'] == ['S256']
    browser.challenge = q['code_challenge'][0]

    def hit():
        time.sleep(0.3)
        urllib.request.urlopen('http://127.0.0.1:18899/?state=wrong&code=x', timeout=5).read()       # not ours: ignored
        page = urllib.request.urlopen('http://127.0.0.1:18899/?' + urllib.parse.urlencode({'state': q['state'][0], 'code': 'code-123'}),
                                      timeout=5).read().decode('utf-8')
        browser.page = page
    threading.Thread(target=hit, daemon=True).start()


assert U.google_login(d5, hub, wait_s=20, open_browser=browser, port=18899) is True
assert 'Google login received' in browser.page
assert browser.challenge == base64.urlsafe_b64encode(hashlib.sha256(hub.verifier.encode()).digest()).decode().rstrip('='), 'PKCE'
assert json.load(open(os.path.join(d5, U.SESSION_FILE)))['refresh_token'] == 'refresh-1'
assert U.access_token(d5, hub) == 'access-1'
assert U.google_login(d5, hub, wait_s=1, open_browser=None, port=18899) is False, 'nobody came'

# ------------------------------------------------------------------ 6. when to check / restart
IST = timezone(timedelta(hours=5, minutes=30))


def ts(y, m, d, hh, mm):
    return datetime(y, m, d, hh, mm, tzinfo=IST).timestamp()


assert U.market_now(ts(2026, 11, 16, 10, 0)) and U.market_now(ts(2026, 11, 16, 9, 0))
assert not U.market_now(ts(2026, 11, 16, 15, 45)) and not U.market_now(ts(2026, 11, 16, 8, 59))
assert not U.market_now(ts(2026, 11, 14, 11, 0)), 'a Saturday'
d6 = folder('restart')
up6 = U.Updater(d6, Hub())
evening = ts(2026, 11, 16, 18, 0)
assert up6.restart_due(now=evening) is False, 'nothing changed'
time.sleep(1.1)
with open(os.path.join(d6, 'screener_bridge.py'), 'w') as f:
    f.write('X = 9  # a zip extracted by hand\n')
assert up6.restart_due(now=evening) is True
assert up6.restart_due(now=ts(2026, 11, 16, 11, 0)) is False, 'not in market hours'
assert up6.restart_due(busy=lambda: True, now=evening) is False, 'not while something runs'
with open(os.path.join(d6, 'notes.txt'), 'w') as f:
    f.write('x')
up6b = U.Updater(d6, Hub())
assert up6b.restart_due(now=evening) is False, 'only .py files count'
# maybe_check: off / every 0 / offline / then once, in its own thread, not again before the hours passed
up7 = U.Updater(folder('maybe'), offline)
assert up7.maybe_check({'auto_update': False}, api_ok) is False and up7.maybe_check({'update_every_hours': 0}, api_ok) is False
assert up7.maybe_check({}, api_ok, online=lambda: False) is False
assert up7.maybe_check({}, api_ok) is True and up7.next > time.time() + 3 * 3600 - 60
up7.thread.join(5)
assert up7.maybe_check({}, api_ok) is False, 'not again before 3 hours'
assert up7.restart_due(now=evening) is False

# ------------------------------------------------------------------ 7. the status line (TestConnection line 10)
assert U.status_line(d3).startswith('Auto update: last checked ') and 'Google login yes' in U.status_line(d3)
assert 'not checked yet' in U.status_line(d6) and 'missing (GoogleLogin.bat)' in U.status_line(d6)

# ------------------------------------------------------------------ 8. GitHub's certificate unknown to Python (owner's laptop, 16-Nov-2026:
# "[SSL: CERTIFICATE_VERIFY_FAILED] ... unable to get local issuer certificate"): Windows' own downloader takes over
import ssl  # noqa: E402
import subprocess  # noqa: E402
import urllib.error  # noqa: E402
real_open, real_fb, real_run = U.urllib.request.urlopen, U.PS_FALLBACK, U._RUN
RUNS = []


def bad_cert(req, timeout=None):
    raise urllib.error.URLError(ssl.SSLCertVerificationError(1, '[SSL: CERTIFICATE_VERIFY_FAILED] certificate verify failed: unable to get local issuer certificate'))


def fake_ps(answer):
    def run(cmd, **kw):
        script = cmd[-1]
        RUNS.append(script)
        assert cmd[0] == 'powershell' and '-NonInteractive' in cmd and kw.get('capture_output')
        assert 'Invoke-WebRequest -UseBasicParsing -Uri ' in script and '-UserAgent ' + "'" + U.UA + "'" in script
        out = script.split('-OutFile ', 1)[1].split("'")[1]
        code, data = answer
        if code == 0:
            with open(out, 'wb') as f:
                f.write(data)
        return subprocess.CompletedProcess(cmd, code, '', 'The remote name could not be resolved' if code == 1 else '')
    return run


try:
    U.urllib.request.urlopen = bad_cert
    U.PS_FALLBACK = lambda: True
    U._PS.update(on=False, said=False)
    U._RUN = fake_ps((0, b'{"sha": "%s"}' % SHA1.encode()))
    LOGS.clear()
    assert U.latest() == SHA1, 'the commit through PowerShell'
    assert any("using Windows' own downloader" in m for m in LOGS) and len(RUNS) == 1
    assert "'https://api.github.com/repos/%s/commits/main'" % U.REPO in RUNS[0]
    assert U.http('GET', U.GH_RAW + "/x/y/it's.py")[0] == 200 and "it''s.py" in RUNS[-1], 'quotes doubled for PowerShell'
    U._RUN = fake_ps((404, b''))
    assert U.http('GET', U.GH_RAW + '/x/y/z') == (404, b''), 'an HTTP answer passes as its status'
    U._RUN = fake_ps((1, b''))
    try:
        U.http('GET', U.GH_RAW + '/x/y/z')
        raise AssertionError('PowerShell failed too')
    except U.UpdateError as e:
        assert 'Windows could not reach GitHub either (The remote name could not be resolved)' in str(e), e
    # not Windows / not GitHub: a clear hint, never "no connection"
    U._PS.update(on=False)
    U.PS_FALLBACK = lambda: False
    try:
        U.http('GET', U.GH_API + '/repos/x')
        raise AssertionError('no fallback here')
    except U.UpdateError as e:
        assert 'could not check the security certificate of api.github.com' in str(e) and 'https://github.com' in str(e), e
    U.PS_FALLBACK = lambda: True
    try:
        U.http('POST', U.TOKEN_URL, body=b'x')
        raise AssertionError('a POST never goes through PowerShell')
    except U.UpdateError as e:
        assert 'oauth2.googleapis.com' in str(e), e

    def down(req, timeout=None):
        raise urllib.error.URLError(OSError('timed out'))
    U.urllib.request.urlopen = down
    try:
        U.http('GET', U.GH_API + '/repos/x')
        raise AssertionError('offline')
    except U.UpdateError as e:
        assert str(e) == 'no connection (timed out)', e
finally:
    U.urllib.request.urlopen, U.PS_FALLBACK, U._RUN = real_open, real_fb, real_run
    U._PS.update(on=False, said=False)

shutil.rmtree(TMP, ignore_errors=True)
print('OK')
