"""Automatic updates (owner, 16-Nov-2026: "You itself place the code to the script and copy and paste file to Screenerbridge
folder. here after i won't do this job"): the background program keeps this folder AND the Google Sheet's code up to date
from the project's GitHub repository (branch main) by itself.

- Every UPDATE_EVERY_H hours (config.json "update_every_hours"; "auto_update": false = off) it asks GitHub for the newest
  commit of main. Files of pcbridge/ScreenerBridge that differ from the ones here (git blob hash) are downloaded, checked
  (each download must match GitHub's hash, every .py must compile) and put in this folder; the replaced ones are kept in
  _update_backup\\<time>\\ (the newest KEEP_BACKUPS kept). config.json and the state / data files are never in the
  repository, so they are never touched.
- Code.gs / Code2.gs of that commit differ from what the sheet runs -> they go into the Apps Script project through the Apps
  Script API (the project's other files - appsscript.json - stay as they are, the old code is kept in
  _update_backup\\sheet-<time>.json) and the EXISTING web-app deployment (the one in config.json's url) moves to the new
  version: the same as Deploy > Manage deployments > New version - the URL never changes. This needs a one-time Google login
  on this computer (GoogleLogin.bat; while it is missing the page opens by itself at most once a day): the login of Google's
  own Apps Script tool (clasp), only the scopes script.projects + script.deployments; the key stays in google_session.json.
- The background program restarts itself when its .py files changed (by this or by hand, e.g. a zip extracted) - never
  while the Kite scan, Kite live prices, a Backtest Lab run or its charts PDF is going, never in market hours (Mon-Fri
  09:00-15:45 IST).
"""
import base64
import hashlib
import json
import os
import re
import secrets
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import webbrowser
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

REPO = 'bharathisiva139541-web/stock-blueprint'
BRANCH = 'main'
SUB = 'pcbridge/ScreenerBridge'
GS_FILES = {'Code.gs': 'Code', 'Code2.gs': 'Code2'}     # the repository's root files -> the Apps Script project's files
GH_API = 'https://api.github.com'
GH_RAW = 'https://raw.githubusercontent.com'
UA = 'StockBlueprint-ScreenerBridge-updater'
UPDATE_EVERY_H = 3
KEEP_BACKUPS = 5
HERE = os.path.dirname(os.path.abspath(__file__))
STATE_FILE = 'update_state.json'
SESSION_FILE = 'google_session.json'
BACKUP_DIR = '_update_backup'
STAGE_DIR = '_update_new'
NAME_RE = re.compile(r'^[A-Za-z0-9][A-Za-z0-9_.-]{0,80}$')
NEVER = ('config.json',)
# Google's clasp (the Apps Script command-line tool): its installed-app OAuth client, published in clasp's own source -
# "The client secret is hardcoded and known to be publicly accessible" (Google's desktop clients cannot keep one)
CLIENT_ID = '1072944905499-vm2v2i5dvn0a0d2o4ca36i1vge8cvbn0.apps.googleusercontent.com'
CLIENT_SECRET = 'v6V3fKV_zWU7iw1DrpO1rknX'
SCOPES = 'https://www.googleapis.com/auth/script.projects https://www.googleapis.com/auth/script.deployments'
AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
TOKEN_URL = 'https://oauth2.googleapis.com/token'
SCRIPT_API = 'https://script.googleapis.com/v1/projects/'
LOGIN_HOST, LOGIN_PORT = '127.0.0.1', 8899
LOGIN_WAIT_S = 600
MARKET = (9 * 60, 15 * 60 + 45)            # IST minutes of a weekday: no restart in between
IST = timezone(timedelta(hours=5, minutes=30))
log = print


class UpdateError(Exception):
    pass


# owner's laptop, 16-Nov-2026: "Update: no connection ([SSL: CERTIFICATE_VERIFY_FAILED] ... unable to get local issuer
# certificate)" - Python reads only the root certificates Windows already has; GitHub's was not there yet. Windows' own
# downloader (PowerShell) checks certificates with Windows itself, which fetches a missing root by itself.
PS_FALLBACK = lambda: os.name == 'nt'       # noqa: E731
_RUN = subprocess.run
_PS = {'on': False, 'said': False}


def _cert_problem(e):
    r = getattr(e, 'reason', e)
    return isinstance(r, ssl.SSLCertVerificationError) or 'CERTIFICATE_VERIFY_FAILED' in str(r)


def ps_get(url, timeout=120):
    """A GET through Windows' own web stack (PowerShell Invoke-WebRequest, no window) -> (status, bytes)."""
    fd, tmp = tempfile.mkstemp(prefix='sbupd', suffix='.bin')
    os.close(fd)

    def q(v):
        return "'" + str(v).replace("'", "''") + "'"
    script = ("$ProgressPreference='SilentlyContinue'; "
              "[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor "
              "[Net.SecurityProtocolType]::Tls12; "
              "try { Invoke-WebRequest -UseBasicParsing -Uri %s -UserAgent %s -OutFile %s -TimeoutSec %d; exit 0 } "
              "catch { $c = 0; if ($_.Exception.Response) { $c = [int]$_.Exception.Response.StatusCode }; "
              "if ($c -gt 0) { exit $c } else { [Console]::Error.WriteLine($_.Exception.Message); exit 1 } }"
              % (q(url), q(UA), q(tmp), int(timeout)))
    try:
        r = _RUN(['powershell', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
                 capture_output=True, text=True, timeout=timeout + 30, creationflags=0x08000000 if os.name == 'nt' else 0)
        if r.returncode == 0:
            with open(tmp, 'rb') as f:
                return 200, f.read()
        if 100 <= r.returncode < 600:
            return r.returncode, b''
        raise UpdateError('Windows could not reach GitHub either (%s)' % ((r.stderr or '').strip()[:200] or 'PowerShell failed'))
    except (OSError, subprocess.SubprocessError) as e:
        raise UpdateError('Windows could not reach GitHub either (%s)' % e)
    finally:
        try:
            os.remove(tmp)
        except OSError:
            pass


def http(method, url, headers=None, body=None, timeout=60):
    """-> (status, body bytes). Never raises for an HTTP answer; a network failure raises UpdateError. A GitHub download
    Python cannot check the certificate of goes through Windows' own downloader (ps_get) - from then on in this program."""
    gh = url.startswith((GH_API, GH_RAW))
    if gh and method == 'GET' and _PS['on']:
        return ps_get(url, max(timeout, 60))
    h = {'User-Agent': UA}
    h.update(headers or {})
    req = urllib.request.Request(url, data=body, method=method, headers=h)
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, r.read()
    except urllib.error.HTTPError as e:
        try:
            return e.code, e.read() or b''
        except Exception:
            return e.code, b''
    except (urllib.error.URLError, OSError) as e:
        why = getattr(e, 'reason', e)
        if _cert_problem(e):
            if gh and method == 'GET' and PS_FALLBACK():
                _PS['on'] = True
                if not _PS['said']:
                    _PS['said'] = True
                    log('Update: Python could not check GitHub\'s security certificate - using Windows\' own downloader.')
                return ps_get(url, max(timeout, 60))
            raise UpdateError('this computer could not check the security certificate of %s (%s) - open %s once in '
                              'Microsoft Edge, then double-click UpdateNow.bat' % (urllib.parse.urlparse(url).netloc, why,
                                                                                  'https://github.com' if gh else url.split('?')[0]))
        raise UpdateError('no connection (%s)' % why)


def blob_sha(data):
    """Git's hash of a file's bytes (what GitHub lists for every file)."""
    return hashlib.sha1(b'blob %d\0' % len(data) + data).hexdigest()


def _json(status, body, what):
    if status != 200:
        raise UpdateError('%s answered HTTP %d' % (what, status))
    try:
        return json.loads(body.decode('utf-8'))
    except ValueError:
        raise UpdateError('%s gave something unreadable' % what)


def latest(get=http):
    """The newest commit of main -> its sha."""
    sha = _json(*get('GET', '%s/repos/%s/commits/%s' % (GH_API, REPO, BRANCH), {'Accept': 'application/vnd.github+json'}),
                what='GitHub').get('sha') or ''
    if not re.match(r'^[0-9a-f]{40}$', sha):
        raise UpdateError('GitHub gave no commit')
    return sha


def listing(sha, path, get=http):
    """{file name: blob sha} of a folder of the repository at commit sha (files only)."""
    items = _json(*get('GET', '%s/repos/%s/contents%s?ref=%s' % (GH_API, REPO, '/' + path if path else '', sha),
                       {'Accept': 'application/vnd.github+json'}), what='GitHub')
    if not isinstance(items, list):
        raise UpdateError('GitHub gave no file list')
    return {it['name']: it['sha'] for it in items if isinstance(it, dict) and it.get('type') == 'file' and it.get('name') and it.get('sha')}


def raw(sha, path, want, get=http):
    """A file of the repository at commit sha -> bytes, checked against its blob sha."""
    st, body = get('GET', '%s/%s/%s/%s' % (GH_RAW, REPO, sha, urllib.parse.quote(path)), None)
    if st != 200:
        raise UpdateError('GitHub answered HTTP %d for %s' % (st, path))
    if blob_sha(body) != want:
        raise UpdateError('the download of %s does not match GitHub - not used' % path)
    return body


def plan(here, remote):
    """The names of the repository's files that are missing here or differ."""
    out = []
    for name, want in sorted(remote.items()):
        if not NAME_RE.match(name) or name in NEVER:
            continue
        try:
            with open(os.path.join(here, name), 'rb') as f:
                have = blob_sha(f.read())
        except OSError:
            have = None
        if have != want:
            out.append(name)
    return out


def _replace(src, dst, tries=10):
    for k in range(tries):
        try:
            os.replace(src, dst)
            return
        except PermissionError:
            if k == tries - 1:
                raise
            time.sleep(2)


def _tidy(folder, keep=KEEP_BACKUPS, prefix=''):
    try:
        names = sorted(n for n in os.listdir(folder) if n.startswith(prefix))
    except OSError:
        return
    for n in names[:-keep] if len(names) > keep else []:
        p = os.path.join(folder, n)
        if os.path.isdir(p):
            shutil.rmtree(p, ignore_errors=True)
        else:
            try:
                os.remove(p)
            except OSError:
                pass


def apply_files(here, sha, remote, names, get=http, stamp=None):
    """Downloads `names` into _update_new, checks them, then puts them here (the replaced files backed up). All or none:
    a bad download / a .py that does not compile -> UpdateError and nothing changed."""
    stage = os.path.join(here, STAGE_DIR)
    shutil.rmtree(stage, ignore_errors=True)
    os.makedirs(stage)
    try:
        for name in names:
            data = raw(sha, SUB + '/' + name, remote[name], get)
            if name.endswith('.py'):
                try:
                    compile(data.decode('utf-8'), name, 'exec')
                except (SyntaxError, UnicodeDecodeError, ValueError) as e:
                    raise UpdateError('%s of the new version does not compile (%s) - nothing changed' % (name, e))
            with open(os.path.join(stage, name), 'wb') as f:
                f.write(data)
        stamp = stamp or datetime.now().strftime('%Y%m%d-%H%M%S')
        bdir = os.path.join(here, BACKUP_DIR, stamp)
        for name in names:
            cur = os.path.join(here, name)
            if os.path.exists(cur):
                os.makedirs(bdir, exist_ok=True)
                shutil.copy2(cur, os.path.join(bdir, name))
            _replace(os.path.join(stage, name), cur)
        _tidy(os.path.join(here, BACKUP_DIR), prefix='2')
    finally:
        shutil.rmtree(stage, ignore_errors=True)


# ------------------------------------------------------------------ the Google login (once) and the sheet's code
def load_json(path, default):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            v = json.load(f)
        return v if isinstance(v, type(default)) else default
    except (OSError, ValueError):
        return default


def save_json(path, v):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(v, f, indent=1)
    _replace(tmp, path)


def _form(d):
    return urllib.parse.urlencode(d).encode('ascii')


def google_login(here=HERE, get=http, wait_s=LOGIN_WAIT_S, open_browser=webbrowser.open, port=LOGIN_PORT, ready=None):
    """The one-time Google login: Google's page in the browser -> back to a tiny page on this computer -> the key saved in
    google_session.json. -> True / False (and why in the log)."""
    verifier = secrets.token_urlsafe(64)
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode('ascii')).digest()).decode('ascii').rstrip('=')
    state = secrets.token_urlsafe(16)
    redirect = 'http://localhost:%d' % port
    url = AUTH_URL + '?' + urllib.parse.urlencode({
        'client_id': CLIENT_ID, 'redirect_uri': redirect, 'response_type': 'code', 'scope': SCOPES, 'access_type': 'offline',
        'prompt': 'consent', 'state': state, 'code_challenge': challenge, 'code_challenge_method': 'S256'})
    got = {}

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            q = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            ok = (q.get('state') or [''])[0] == state and bool((q.get('code') or [''])[0])
            if ok:
                got['code'] = q['code'][0]
            elif q.get('error'):
                got['error'] = q['error'][0]
            body = ('<!doctype html><meta charset="utf-8"><title>Stock Blueprint - Google</title>'
                    '<body style="font-family:sans-serif;max-width:560px;margin:60px auto;line-height:1.5">' +
                    ('<h2>&#10004; Google login received</h2><p>Stock Blueprint\'s PC program can now put new code into your '
                     'Google Sheet by itself. You can close this tab.</p>' if ok else
                     '<h2>Login not completed</h2><p>Close this tab - double-click GoogleLogin.bat to try again.</p>')).encode('utf-8')
            self.send_response(200)
            self.send_header('Content-Type', 'text/html; charset=utf-8')
            self.send_header('Content-Length', str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

    try:
        srv = HTTPServer((LOGIN_HOST, port), Handler)
    except OSError:
        log('Google login: port %d is busy (another login waiting?) - try again in a few minutes.' % port)
        return False
    srv.timeout = 1
    try:
        if ready:
            ready(url)
        if open_browser:
            try:
                open_browser(url)
            except Exception:
                pass
        end = time.time() + wait_s
        while time.time() < end and 'code' not in got and 'error' not in got:
            srv.handle_request()
    finally:
        srv.server_close()
    if 'code' not in got:
        log('Google login: %s.' % ('Google said "%s"' % got['error'] if 'error' in got else 'not done in time'))
        return False
    st, body = get('POST', TOKEN_URL, {'Content-Type': 'application/x-www-form-urlencoded'}, _form({
        'code': got['code'], 'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET, 'redirect_uri': redirect,
        'grant_type': 'authorization_code', 'code_verifier': verifier}))
    try:
        tok = json.loads(body.decode('utf-8')) if st == 200 else {}
    except ValueError:
        tok = {}
    if not tok.get('refresh_token'):
        log('Google login: Google gave no key (HTTP %d) - double-click GoogleLogin.bat to try again.' % st)
        return False
    save_json(os.path.join(here, SESSION_FILE), {'refresh_token': tok['refresh_token'], 'scope': tok.get('scope', ''),
                                                 'at': datetime.now().strftime('%Y-%m-%d %H:%M')})
    log('Google login: done - the program can now update the sheet\'s code by itself.')
    return True


def access_token(here=HERE, get=http):
    """A fresh access token from the saved login, or None (no login yet / Google refused it - then the file goes)."""
    path = os.path.join(here, SESSION_FILE)
    sess = load_json(path, {})
    if not sess.get('refresh_token'):
        return None
    st, body = get('POST', TOKEN_URL, {'Content-Type': 'application/x-www-form-urlencoded'}, _form({
        'refresh_token': sess['refresh_token'], 'client_id': CLIENT_ID, 'client_secret': CLIENT_SECRET,
        'grant_type': 'refresh_token'}))
    if st == 200:
        try:
            return json.loads(body.decode('utf-8')).get('access_token') or None
        except ValueError:
            return None
    if st in (400, 401):            # revoked / expired: a new login is needed
        try:
            os.remove(path)
        except OSError:
            pass
        log('Google login: the saved login no longer works - the login page opens again.')
    return None


def deployment_id(cfg):
    m = re.search(r'/macros/s/([A-Za-z0-9_-]{20,})/exec', str((cfg or {}).get('url') or ''))
    return m.group(1) if m else None


def _api_err(st, body, what):
    try:
        msg = json.loads(body.decode('utf-8')).get('error', {}).get('message', '')
    except (ValueError, AttributeError):
        msg = ''
    if st == 403 and 'Apps Script API' in msg:
        return ('the Apps Script API is off for your Google account - open script.google.com/home/usersettings and turn '
                '"Google Apps Script API" on')
    return '%s: Google answered HTTP %d%s' % (what, st, (' (%s)' % msg[:160]) if msg else '')


def deploy_sheet(cfg, script_id, sha, new_code, token, here=HERE, get=http, stamp=None):
    """Puts new_code {'Code': text, 'Code2': text} into the Apps Script project and moves the web app's own deployment to a
    new version. -> 'same' (the sheet runs this code already) / the new version number. Raises UpdateError."""
    did = deployment_id(cfg)
    if not did:
        raise UpdateError('config.json has no web-app address - the sheet was not updated')
    h = {'Authorization': 'Bearer ' + token}
    st, body = get('GET', SCRIPT_API + script_id + '/content', h)
    if st != 200:
        raise UpdateError(_api_err(st, body, 'reading the sheet\'s code'))
    files = (json.loads(body.decode('utf-8')) or {}).get('files') or []
    names = {f.get('name') for f in files}
    if not all(n in names for n in new_code):
        raise UpdateError('the sheet\'s script has no %s file - not updated' % ' / '.join(n for n in new_code if n not in names))
    if all((f.get('source') or '').replace('\r', '') == new_code[f['name']] for f in files if f.get('name') in new_code):
        return 'same'
    stamp = stamp or datetime.now().strftime('%Y%m%d-%H%M%S')
    bdir = os.path.join(here, BACKUP_DIR)
    os.makedirs(bdir, exist_ok=True)
    save_json(os.path.join(bdir, 'sheet-%s.json' % stamp), {'files': files})
    _tidy(bdir, prefix='sheet-')
    out = [{'name': f['name'], 'type': f.get('type'), 'source': new_code.get(f['name'], f.get('source') or '')} for f in files]
    jh = dict(h, **{'Content-Type': 'application/json'})
    st, body = get('PUT', SCRIPT_API + script_id + '/content', jh, json.dumps({'scriptId': script_id, 'files': out}).encode('utf-8'))
    if st != 200:
        raise UpdateError(_api_err(st, body, 'putting the new code in'))
    desc = 'auto update %s %s' % (sha[:7], datetime.now().strftime('%d-%b-%Y %H:%M'))
    st, body = get('POST', SCRIPT_API + script_id + '/versions', jh, json.dumps({'description': desc}).encode('utf-8'))
    if st != 200:
        raise UpdateError(_api_err(st, body, 'making a new version'))
    ver = json.loads(body.decode('utf-8')).get('versionNumber')
    if not ver:
        raise UpdateError('Google gave no version number')
    st, body = get('PUT', SCRIPT_API + script_id + '/deployments/' + did, jh, json.dumps({'deploymentConfig': {
        'scriptId': script_id, 'versionNumber': ver, 'manifestFileName': 'appsscript', 'description': desc}}).encode('utf-8'))
    if st != 200:
        raise UpdateError(_api_err(st, body, 'moving the web app to version %s' % ver))
    return ver


# ------------------------------------------------------------------ the background program's part
def market_now(now=None):
    t = datetime.fromtimestamp(now if now is not None else time.time(), IST)
    return t.weekday() < 5 and MARKET[0] <= t.hour * 60 + t.minute < MARKET[1]


def py_snapshot(here):
    out = {}
    try:
        for n in os.listdir(here):
            if n.endswith('.py'):
                s = os.stat(os.path.join(here, n))
                out[n] = (s.st_size, int(s.st_mtime))
    except OSError:
        pass
    return out


class Updater:
    """In the background program: check_once in its own thread every update_every_hours; restart_due() = this program's
    .py files changed since it started and nothing is going on."""

    def __init__(self, here=HERE, get=http):
        self.here, self.get = here, get
        self.files = py_snapshot(here)
        self.next = 0.0
        self.thread = None

    def busy(self):
        return bool(self.thread and self.thread.is_alive())

    def maybe_check(self, cfg, api, online=None):
        if cfg.get('auto_update') is False or self.busy() or time.time() < self.next:
            return False
        try:
            every = float(cfg.get('update_every_hours', UPDATE_EVERY_H))
        except (TypeError, ValueError):
            every = UPDATE_EVERY_H
        if every <= 0:
            return False
        if online and not online():
            return False
        self.next = time.time() + every * 3600
        self.thread = threading.Thread(target=self.check_once, args=(cfg, api), daemon=True)
        self.thread.start()
        return True

    def restart_due(self, busy=None, now=None):
        if self.busy() or py_snapshot(self.here) == self.files or market_now(now):
            return False
        return not (busy and busy())

    def check_once(self, cfg, api, login=True, now=None):
        """GitHub's newest version -> the sheet's code, then this folder. -> {'sha', 'files', 'sheet'} (what was done)."""
        here, get = self.here, self.get
        spath = os.path.join(here, STATE_FILE)
        st = load_json(spath, {})
        done = {'sha': None, 'files': [], 'sheet': None}
        try:
            sha = latest(get)
            done['sha'] = sha
            st['checked'] = datetime.now().strftime('%Y-%m-%d %H:%M')
            root = listing(sha, '', get)
            gs = {n: root.get(n) for n in GS_FILES}
            # 1. the sheet first (the program's new version may need the web app's); a sheet that cannot be updated does
            #    not hold this folder back (the program copes with an older web app and says so)
            if all(gs.values()) and st.get('gs') != gs:
                try:
                    done['sheet'] = self.sheet(cfg, api, sha, gs, st, login)
                except UpdateError as e:
                    log('Update: %s.' % e)
            # 2. this folder
            remote = listing(sha, SUB, get)
            names = plan(here, remote)
            if names:
                apply_files(here, sha, remote, names, get)
                done['files'] = names
                log('Update: %d file(s) of this program updated to the newest version (%s) - %s. The background program '
                    'restarts itself to use them (not in market hours).' % (len(names), sha[:7], ', '.join(names[:12]) +
                                                                            (' ...' if len(names) > 12 else '')))
            st['sha'] = sha
        except UpdateError as e:
            log('Update: %s.' % e)
        except Exception as e:          # never stops the background program
            log('Update: unexpected problem - %s.' % e)
        try:
            save_json(spath, st)
        except OSError:
            pass
        return done

    def sheet(self, cfg, api, sha, gs, st, login=True):
        """The repository's Code.gs / Code2.gs -> the sheet (see deploy_sheet). -> 'same' / version / None (waits for the login)."""
        token = access_token(self.here, self.get)
        if not token and login:
            day = datetime.now().strftime('%Y-%m-%d')
            if st.get('loginDay') != day:
                st['loginDay'] = day
                log('Update: the sheet\'s new code needs a one-time Google login on this computer - the login page opens '
                    'now (choose the Google account of your sheet, then Allow).')
                if google_login(self.here, self.get):
                    token = access_token(self.here, self.get)
        if not token:
            log('Update: the sheet\'s new code waits for the Google login (double-click GoogleLogin.bat).')
            return None
        sid = st.get('scriptId')
        if not sid:
            try:
                res = api(cfg, 'scriptid', {}) or {}
            except (RuntimeError, OSError) as e:
                raise UpdateError('the sheet did not answer (%s) - the sheet was not updated' % e)
            sid = res.get('scriptId') if res.get('ok') else None
            if not sid or not re.match(r'^[A-Za-z0-9_-]{20,}$', str(sid)):
                raise UpdateError('the web app did not say which script it is (%s) - the sheet was not updated'
                                  % (res.get('error') or 'an older web app'))
            st['scriptId'] = sid
        code = {GS_FILES[n]: raw(sha, n, gs[n], self.get).decode('utf-8') for n in GS_FILES}
        ver = deploy_sheet(cfg, sid, sha, code, token, self.here, self.get)
        st['gs'] = gs
        log('Update: the sheet already runs the newest code.' if ver == 'same' else
            'Update: the sheet\'s code updated and the web app moved to version %s (same address as before).' % ver)
        return ver


def status_line(here=HERE):
    st = load_json(os.path.join(here, STATE_FILE), {})
    login = bool(load_json(os.path.join(here, SESSION_FILE), {}).get('refresh_token'))
    return 'Auto update: %s; version %s; sheet code %s; Google login %s' % (
        'last checked ' + st['checked'] if st.get('checked') else 'not checked yet', (st.get('sha') or '-')[:7],
        'up to date' if st.get('gs') else 'not updated by this program yet', 'yes' if login else 'missing (GoogleLogin.bat)')
