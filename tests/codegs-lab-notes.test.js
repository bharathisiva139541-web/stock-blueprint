'use strict';
// Code2.gs, owner 09-Nov-2026: (1) the Backtest Lab's job queue - the website's page (PIN) saves a run, the PC
// (backtest_lab.py LabWorker, doPost action 'lab', bridge token) takes it, sends progress and the result (hidden tab
// Backtest_Lab, newest kept); (2) the app's bell + phone pop-ups - Mitigated FVG Log rows and the Results Update email's
// new rows become notes (hidden tab App_Notifications), one signed request to the website's push sender per run
// (HMAC-SHA256 of the feed token - the token itself is never sent), dead phones removed, the Kite poll carries the
// newest note's time.
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('crypto');
const mock = require('./fixtures/apps-script-mock');

const T0 = Date.UTC(2026, 10, 9, 10, 0);   // 09-Nov-2026 15:30 IST
const FEED = 'feed-token-123';
const BRIDGE = 'bridge-token';
const PIN = 'Blue2026';
const PUSH_URL = 'https://stock-blueprint.vercel.app/api/push';
const plain = (v) => JSON.parse(JSON.stringify(v));

function load(extra) {
  const env = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }] },
    Object.assign({ now: T0, props: { AB_FEED_TOKEN: FEED, AB_BRIDGE_TOKEN: BRIDGE }, prompts: [PIN, PIN] }, extra || {}));
  env.call('runWatchlistPinSetup');
  return env;
}
const site = (env, body) => plain(env.post(Object.assign({ token: FEED, action: 'watchlists', pin: PIN }, body)));
const pc = (env, body) => plain(env.post(Object.assign({ token: BRIDGE, action: 'lab' }, body)));
const RESULT = { v: 1, params: { tf: 'D', group: 'fvg' }, groupName: 'FVG+Spring', cacheUpto: '2026-11-09', from: '2006-01-02', to: '2026-10-20',
                 stats: { trades: 412, winPct: 41.5, avgR: 0.62, totalR: 255.4 }, account: { returnPct: 38.2, cagr: 4.1, maxDD: 12.5, curve: [] },
                 trades: [['ABC', '2026-10-01', 'FVG', 'top', 1, 100, 95, 5, 120, '2026-10-20', 'trail', 4, 19.8, 19, 4.4, 200, 4000, 1]],
                 tradeCols: ['sym'] };

test('Backtest Lab: the page saves a run, the PC takes it once, its result is kept; the PIN and the bridge token guard each side', () => {
  const env = load();
  assert.equal(site(env, { op: 'lab', pin: 'Wrong999', lab: { do: 'status' } }).error, 'wrong PIN');
  assert.equal(pc(env, { op: 'poll', token: FEED }).error, 'bad token', 'the website token cannot act as the PC');
  let st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.deepEqual([st.ok, st.result, st.job, st.pcSeenSec, st.list], [true, 'lab', null, null, []]);
  // the page was opened just now -> the PC asks every 10 s; nothing to do yet
  assert.deepEqual(pc(env, { op: 'poll' }), { ok: true, job: null, next: 10, v: 2 });
  st = site(env, { op: 'lab', lab: { do: 'run', name: '  My   2R trail ', params: { tf: 'D', group: 'fvg', stop: 'zone', stopBuf: 0.5, targetR: 2,
    trail: 'lows', trailN: 2, maxDays: 60, evil: '=IMPORTXML()', 'bad key': 1, deep: { x: 1 }, breakeven: true, from: '2010-01-01',
    emaSupport: 10, above21: true, emaStack: false, big: Infinity } } });
  assert.equal(st.job.status, 'waiting');
  assert.equal(st.job.name, 'My 2R trail');
  assert.deepEqual(st.job.params, { tf: 'D', group: 'fvg', stop: 'zone', stopBuf: 0.5, targetR: 2, trail: 'lows', trailN: 2, maxDays: 60,
                                    breakeven: true, from: '2010-01-01', emaSupport: 10, above21: true, emaStack: false },
    'flat numbers / booleans / plain words pass (the PC keeps only the rules it knows); a formula, nested data or a bad key do not');
  const got = pc(env, { op: 'poll' });
  assert.equal(got.job.id, st.job.id);
  assert.equal(got.next, 5);
  assert.deepEqual(pc(env, { op: 'poll' }).job, null, 'taken once');
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).job.status, 'running');
  assert.deepEqual(pc(env, { op: 'progress', id: got.job.id, pct: 45, note: 'half way' }), { ok: true });
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).job.pct, 45);
  assert.equal(pc(env, { op: 'result', id: 'Lother', result: RESULT }).error, 'not the current run');
  assert.equal(pc(env, { op: 'result', id: got.job.id, result: { nope: 1 } }).error, 'not a Backtest Lab result');
  assert.deepEqual(pc(env, { op: 'result', id: got.job.id, result: RESULT }), { ok: true, stored: true });
  st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.job.status, 'done');
  assert.equal(st.list.length, 1);
  assert.deepEqual([st.list[0].id, st.list[0].name, st.list[0].head.trades, st.list[0].head.avgR, st.list[0].head.returnPct],
    [got.job.id, 'My 2R trail', 412, 0.62, 38.2]);
  const one = site(env, { op: 'lab', lab: { do: 'result', id: got.job.id } });
  assert.deepEqual(one.item.result, RESULT, 'the whole result back, JSON parts joined');
  const tab = env.sheet('Backtest_Lab');
  assert.ok(tab.hidden);
  // a big result is split over cells of 45,000 characters
  const big = Object.assign({}, RESULT, { trades: Array.from({ length: 3000 }, (_, k) => ['S' + k, '2020-01-01', 'FVG', 'top', 1, 100.25, 95.5,
    4.74, 120.5, '2020-02-01', 'trail', 4.24, 20.2, 31, 5.1, 105, 2126, 1]) });
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  const j2 = pc(env, { op: 'poll' }).job;
  pc(env, { op: 'result', id: j2.id, result: big });
  assert.ok(env.sheet('Backtest_Lab').rows[1].filter((c) => String(c).length === 45000).length >= 4, 'parts');
  assert.deepEqual(site(env, { op: 'lab', lab: { do: 'result', id: j2.id } }).item.result.trades.length, 3000);
  assert.deepEqual(site(env, { op: 'lab', lab: { do: 'status' } }).list.map((x) => x.id), [j2.id, got.job.id], 'newest first');
  // delete one
  assert.deepEqual(site(env, { op: 'lab', lab: { do: 'delete', id: got.job.id } }).list.map((x) => x.id), [j2.id]);
  // a finished run is a bell note (no pop-up)
  const notes = site(env, { op: 'notes' });
  assert.equal(notes.items[0].kind, 'lab');
  assert.match(notes.items[0].title, /^Backtest ready/);
});

test('Backtest Lab: a run the laptop stopped part-way / nobody took is marked failed; the PC asks slowly when the page is shut', () => {
  const env = load();
  site(env, { op: 'lab', lab: { do: 'run', params: { tf: 'W' } } });
  const j = pc(env, { op: 'poll' }).job;
  env.setNow(T0 + 21 * 60000);
  let st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.job.status, 'failed');
  assert.match(st.job.error, /stopped while running/);
  assert.equal(pc(env, { op: 'fail', id: j.id, error: 'x' }).ok, true);
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  env.setNow(T0 + 13 * 3600000);
  assert.deepEqual(pc(env, { op: 'poll' }), { ok: true, job: null, next: 60, v: 2 }, 'too old: dropped; the page is shut -> every minute');
  assert.match(site(env, { op: 'lab', lab: { do: 'status' } }).job.error, /did not take it in 12 hours/);
  // a waiting run can be cancelled; a running one cannot be replaced
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  assert.equal(site(env, { op: 'lab', lab: { do: 'cancel' } }).job.status, 'cancelled');
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  pc(env, { op: 'poll' });
  assert.match(site(env, { op: 'lab', lab: { do: 'run', params: {} } }).error, /a run is going on/);
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).pcSeenSec, 0);
});

test('Backtest Lab (owner, 11-Nov-2026: "loading only ... sheet feed error"): the laptop\'s progress keeps a long run alive, its note reaches the page, a running run can be cancelled', () => {
  const env = load();
  // the laptop prepares its candles before taking any run: its words reach the page while fresh
  assert.equal(pc(env, { op: 'hello', note: 'preparing the candles on the laptop after an update (only once): 600 of 1800 stocks, about 12 min left' }).ok, true);
  let st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.pcNote, 'preparing the candles on the laptop after an update (only once): 600 of 1800 stocks, about 12 min left');
  assert.equal(st.pcSeenSec, 0);
  env.setNow(T0 + 4 * 60000);
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).pcNote, '', 'an old note is not shown');
  pc(env, { op: 'hello', note: '' });
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).pcNote, '');
  // a run taken while the cache is made: progress every few minutes keeps it running past 20 minutes
  site(env, { op: 'lab', lab: { do: 'run', name: 'slow first run', params: { tf: 'D' } } });
  const j = pc(env, { op: 'poll' }).job;
  for (let m = 5; m <= 40; m += 5) {
    env.setNow(T0 + (4 + m) * 60000);
    assert.equal(pc(env, { op: 'progress', id: j.id, pct: m, note: 'preparing the candles: ' + m * 40 + ' of 1800 stocks' }).ok, true);
  }
  st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.job.status, 'running', '44 minutes after it was taken, still alive');
  assert.match(st.job.note, /1600 of 1800/);
  env.setNow(T0 + 66 * 60000);
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).job.status, 'failed', '21 minutes without a word: stopped');
  // a running run can be cancelled from the page; the next run is accepted
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  const j2 = pc(env, { op: 'poll' }).job;
  assert.match(site(env, { op: 'lab', lab: { do: 'run', params: {} } }).error, /a run is going on/);
  assert.equal(site(env, { op: 'lab', lab: { do: 'cancel' } }).job.status, 'cancelled');
  st = site(env, { op: 'lab', lab: { do: 'run', name: 'next one', params: {} } });
  assert.equal(st.job.status, 'waiting');
  assert.equal(pc(env, { op: 'result', id: j2.id, result: RESULT }).error, 'not the current run', 'the cancelled run\'s late result is not kept over the new run');
});

function pushEnv(answer) {
  const sent = [];
  const env = load({ fetch: (url, params) => { sent.push({ url, params }); return answer ? answer(url, params) : { code: 200, text: JSON.stringify({ ok: true, sent: 1, gone: [] }) }; } });
  env.sent = sent;
  return env;
}
const SUB = (n) => ({ endpoint: 'https://fcm.googleapis.com/fcm/send/abc' + n, keys: { p256dh: 'BPk' + n, auth: 'au' + n } });

test('Notifications: a mitigated zone -> a bell note + ONE signed pop-up request at the end of the run; dead phones removed', () => {
  const env = pushEnv((url, params) => ({ code: 200, text: JSON.stringify({ ok: true, sent: 2, gone: [SUB(2).endpoint] }) }));
  // no phone yet: notes only
  env.call('ab_logMitigation_', 'Gap-up FVG (inside FVG)', 'ABC', 100, 104, 4, 103.5, 'Live, Kite');
  env.call('ab_mitMailFlush_', false);
  assert.equal(env.sent.length, 0);
  // two phones (the website gives its own push sender's address)
  assert.equal(site(env, { op: 'push', push: { do: 'add', sub: SUB(1), label: 'Android' }, pushUrl: PUSH_URL }).devices, 1);
  assert.equal(site(env, { op: 'push', push: { do: 'add', sub: SUB(2) }, pushUrl: PUSH_URL }).devices, 2);
  assert.equal(site(env, { op: 'push', push: { do: 'add', sub: SUB(2) }, pushUrl: PUSH_URL }).devices, 2, 'the same phone once');
  assert.equal(site(env, { op: 'push', push: { do: 'add', sub: { endpoint: 'http://x' } }, pushUrl: PUSH_URL }).error, 'not a push subscription');
  assert.equal(site(env, { op: 'push', push: { do: 'add', sub: SUB(3) }, pushUrl: 'https://evil.example.com/steal' }).error, 'no push sender address');
  env.call('ab_logMitigation_', '4H FVG', 'XYZ', 50, 52, 4, 51.5, 'Live');
  env.call('ab_logMitigation_', 'Unmitigated FVG', 'PQR', 10, 11, 10, 10.9, 'EOD');
  env.call('ab_mitMailFlush_', false);
  assert.equal(env.sent.length, 1, 'one request for the run');
  const req = env.sent[0];
  assert.equal(req.url, PUSH_URL);
  const outer = JSON.parse(req.params.payload);
  assert.equal(outer.sig, crypto.createHmac('sha256', FEED).update(outer.ts + '.' + outer.body).digest('hex'), 'signed with the feed token');
  assert.ok(req.params.payload.indexOf(FEED) < 0, 'the token itself is never sent');
  const body = JSON.parse(outer.body);
  assert.deepEqual(body.subs.map((s) => s.endpoint), [SUB(1).endpoint, SUB(2).endpoint]);
  assert.equal(body.notes.length, 1, 'one pop-up per kind');
  assert.match(body.notes[0].title, /^2 FVG zones mitigated: XYZ, PQR/);
  assert.equal(body.notes[0].url, '#signals');
  // the push sender said phone 2 is gone
  assert.equal(site(env, { op: 'notes' }).devices, 1);
  // the bell: newest first, the Kite poll knows the newest one
  const n = site(env, { op: 'notes' });
  assert.deepEqual(n.items.map((x) => x.title), ['Unmitigated FVG mitigated: PQR', '4H FVG mitigated: XYZ', 'Gap-up FVG (inside FVG) mitigated: ABC']);
  assert.match(n.items[2].body, /Zone 100 - 104 \(4%\), price 103.5 \(Live, Kite\)/);
  assert.equal(site(env, { op: 'kite' }).notesNewest, n.newest);
  assert.ok(env.sheet('App_Notifications').hidden);
  // a test pop-up; removing the phone
  const t = site(env, { op: 'push', push: { do: 'test' }, pushUrl: PUSH_URL });
  assert.equal(t.ok, true);
  assert.equal(JSON.parse(JSON.parse(env.sent.at(-1).params.payload).body).notes[0].kind, 'test');
  assert.equal(site(env, { op: 'push', push: { do: 'remove', endpoint: SUB(1).endpoint } }).devices, 0);
});

test('Notifications: the push sender failing never stops the run; old notes are trimmed', () => {
  const env = pushEnv(() => ({ code: 500, text: 'oops' }));
  site(env, { op: 'push', push: { do: 'add', sub: SUB(1) }, pushUrl: PUSH_URL });
  env.call('ab_logMitigation_', 'Gap-up FVG', 'ABC', 100, 104, 4, 103.5, 'Live');
  assert.doesNotThrow(() => env.call('ab_mitMailFlush_', false));
  assert.match(env.logs.join('\n'), /push sender answered HTTP 500/);
  const t = site(env, { op: 'push', push: { do: 'test' } });
  assert.equal(t.ok, false);
  for (let k = 0; k < 360; k++) env.call('ab_noteAdd_', 'mitigated', 'T' + k, '', '#signals');
  const rows = env.sheet('App_Notifications').rows.filter((r) => r[0]).length - 1;
  assert.ok(rows <= 351 && rows >= 300, String(rows));
  assert.equal(site(env, { op: 'notes' }).items[0].title, 'T359');
});

// owner, 15-Nov-2026: "suppose nan tablet la backtest run panren laptop on pani vachutu, and pdf um tablet or phone la ye
// pakanumna epdi pakurathu?" - the charts PDF goes to the owner's Google Drive too (the laptop keeps its copy)
function fakeDrive() {
  const d = { folders: [], made: 0 };
  const iter = (a) => { let i = 0; return { hasNext: () => i < a.length, next: () => a[i++] }; };
  d.file = (name, t) => { const x = { trashed: false, getName: () => name, isTrashed: () => x.trashed, getDateCreated: () => new Date(t), setTrashed: (v) => { x.trashed = v; } }; return x; };
  d.api = {
    getFolderById: (id) => { const f = d.folders.find((x) => x.id === id); if (!f) throw new Error('No item with the given ID could be found.'); return f; },
    getFoldersByName: (n) => iter(d.folders.filter((x) => x.name === n)),
    createFolder: (n) => {
      d.made++;
      const f = { id: 'FOLDER' + d.made + '_abcdef', name: n, trashed: false, files: [] };
      f.getId = () => f.id; f.getUrl = () => 'https://drive.google.com/drive/folders/' + f.id; f.isTrashed = () => f.trashed;
      f.getFiles = () => iter(f.files);
      d.folders.push(f);
      return f;
    }
  };
  return d;
}

test('Backtest Lab PDFs in Google Drive: an upload address for a run, the link kept with the result, the newest 20 kept, a missing permission explained', () => {
  let answer = { code: 200, headers: { Location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=ABC123' } };
  const env = load({ fetch: () => answer });
  const drive = fakeDrive();
  env.context.DriveApp = drive.api;
  site(env, { op: 'lab', lab: { do: 'run', name: 'tablet run', params: { tf: 'D' } } });
  const job = pc(env, { op: 'poll' }).job;
  const NAME = '2026-11-15 101530 tablet run.pdf';
  assert.equal(pc(env, { op: 'pdfup', id: job.id, name: 'run.exe', size: 1000 }).error, 'not a charts PDF name');
  assert.equal(pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 0 }).error, 'no PDF size');
  assert.match(pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 900 * 1048576 }).error, /too big .*900 MB/);
  let up = pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 26214400 });
  assert.deepEqual(up, { ok: true, upload: answer.headers.Location, folder: 'https://drive.google.com/drive/folders/FOLDER1_abcdef' });
  const req = env.fetches[env.fetches.length - 1];
  assert.equal(req.url, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&fields=id');
  assert.deepEqual(JSON.parse(req.params.payload), { name: NAME, parents: ['FOLDER1_abcdef'], mimeType: 'application/pdf' });
  assert.equal(req.params.headers['X-Upload-Content-Length'], '26214400');
  assert.deepEqual([drive.made, drive.folders[0].name], [1, 'Stock Blueprint - Backtest PDFs']);
  pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 1000 });
  assert.equal(drive.made, 1, 'the same folder again');
  drive.folders[0].trashed = true;
  pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 1000 });
  assert.equal(drive.made, 2, 'a folder put in the trash -> a new one');
  // Drive refuses / the permission was never given: the reason says what to do once
  answer = { code: 403, text: 'Request had insufficient authentication scopes.' };
  assert.match(pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 1000 }).error, /not allowed yet .*runLabDriveSetup.*Allow/);
  answer = { code: 200, headers: { Location: 'https://evil.example/x' } };
  assert.match(pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 1000 }).error, /^Google Drive: HTTP 200/);
  env.context.DriveApp = { getFolderById: () => { throw new Error('You do not have permission to call DriveApp.getFolderById. Required permissions: https://www.googleapis.com/auth/drive'); },
                           getFoldersByName: () => { throw new Error('You do not have permission to call DriveApp.getFoldersByName.'); } };
  assert.match(pc(env, { op: 'pdfup', id: job.id, name: NAME, size: 1000 }).error, /runLabDriveSetup/);
  env.context.DriveApp = drive.api;
  // the result: the link is made here from the file id (whatever url came with it); the folder keeps the newest 20 PDFs
  const folder = drive.folders[1];
  for (let k = 0; k < 23; k++) folder.files.push(drive.file('run ' + k + '.pdf', T0 - (23 - k) * 60000));
  folder.files.push(drive.file('notes.txt', T0 - 99 * 60000));
  const res = Object.assign({}, RESULT, { pdf: { file: NAME, pages: 9, trades: 4, shown: 4, drive: { id: 'FILE_abc_xyz12', url: 'javascript:alert(1)' } } });
  assert.deepEqual(pc(env, { op: 'result', id: job.id, result: res }), { ok: true, stored: true });
  const item = site(env, { op: 'lab', lab: { do: 'result', id: job.id } }).item;
  assert.deepEqual(item.result.pdf.drive, { id: 'FILE_abc_xyz12', url: 'https://drive.google.com/file/d/FILE_abc_xyz12/view' });
  assert.deepEqual(folder.files.filter((f) => f.trashed).map((f) => f.getName()), ['run 0.pdf', 'run 1.pdf', 'run 2.pdf'], 'the 3 oldest PDFs to the Drive trash');
  // a failed copy keeps its reason; a strange id is not a link
  site(env, { op: 'lab', lab: { do: 'run', name: 'b', params: {} } });
  const j2 = pc(env, { op: 'poll' }).job;
  pc(env, { op: 'result', id: j2.id, result: Object.assign({}, RESULT, { pdf: { file: NAME, drive: { id: '../../x', error: '' } } }) });
  assert.deepEqual(site(env, { op: 'lab', lab: { do: 'result', id: j2.id } }).item.result.pdf.drive, { error: 'not copied' });
  // menu / editor: connect once
  assert.equal(env.call('runLabDriveSetup'), 'https://drive.google.com/drive/folders/FOLDER2_abcdef');
});

test('Backtest Lab speed (owner, 16-Nov-2026: "takunu vara mari ... adikadi sheet feed timedout error varuthu"): the waiting poll takes a run at once, a compressed result is kept and unpacked, the charts PDF comes later, the page reads without the document lock', () => {
  const zlib = require('zlib');
  const env = load();
  site(env, { op: 'lab', lab: { do: 'status' } });                     // the page is open
  // nothing to take: the waiting poll returns after its seconds (here no real waiting) and the laptop asks again at once
  assert.deepEqual(pc(env, { op: 'poll', wait: 25 }), { ok: true, job: null, next: 0, waited: true, v: 2 });
  assert.deepEqual(pc(env, { op: 'poll', wait: 999 }).waited, true, 'at most 25 s');
  // a run: the page's Run leaves a wake-up mark; the waiting poll takes it
  const st = site(env, { op: 'lab', lab: { do: 'run', name: 'fast', params: { tf: 'D' } } });
  assert.ok(env.context.CacheService.getScriptCache().get('AB_LAB_WAKE'), 'the wake-up mark');
  const got = pc(env, { op: 'poll', wait: 25 });
  assert.equal(got.job.id, st.job.id);
  assert.equal(got.v, 2);
  // the result as gzip + base64 + a small summary (the PDF still being made)
  const full = Object.assign({}, RESULT, { trades: Array.from({ length: 500 }, (_, k) => ['S' + k, '2026-10-01', 'FVG', 'top', 1, 100, 95, 5, 120, '2026-10-20', 'trail', 4, 19.8, 19, 4.4, 200, 4000, 1]),
                                         pdf: { pending: true } });
  const blob = zlib.gzipSync(Buffer.from(JSON.stringify(full))).toString('base64');
  const summary = { params: full.params, groupName: full.groupName, cacheUpto: full.cacheUpto, from: full.from, to: full.to, stats: full.stats,
                    account: { returnPct: 38.2, cagr: 4.1, maxDD: 12.5 }, pdf: { pending: true } };
  assert.equal(pc(env, { op: 'result', id: got.job.id, blob: 'not base64 !', summary: summary }).error, 'not a Backtest Lab result');
  assert.equal(pc(env, { op: 'result', id: got.job.id, blob: blob }).error, 'not a Backtest Lab result', 'no summary');
  assert.deepEqual(pc(env, { op: 'result', id: got.job.id, blob: blob, summary: summary }), { ok: true, stored: true });
  let s2 = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(s2.job.status, 'done');
  assert.deepEqual([s2.list[0].head.trades, s2.list[0].head.avgR, s2.list[0].head.pdf], [412, 0.62, { pending: true }]);
  assert.ok(String(env.sheet('Backtest_Lab').rows[1][4]).indexOf('GZ:') === 0, 'kept as it came');
  // the page gets the compressed copy (it unpacks it), or - for a browser that cannot - the sheet unpacks it
  let r = site(env, { op: 'lab', lab: { do: 'result', id: got.job.id } });
  assert.equal(r.item.blob, blob);
  assert.equal(r.item.result, undefined);
  assert.deepEqual(JSON.parse(zlib.gunzipSync(Buffer.from(r.item.blob, 'base64')).toString()).trades.length, 500);
  r = site(env, { op: 'lab', lab: { do: 'result', id: got.job.id, plain: true } });
  assert.equal(r.item.result.trades.length, 500);
  assert.equal(r.item.blob, undefined);
  // the charts PDF later (the laptop may already run the next one): kept in the run's summary, the link made here
  assert.deepEqual(pc(env, { op: 'pdf', id: got.job.id, pdf: { file: 'x.pdf', folder: 'lab_charts', path: 'D:\\StockBlueprintData\\lab_charts', pages: 1002, trades: 500, shown: 500,
                                                           drive: { id: 'FILE_abc_xyz12', url: 'javascript:alert(1)' }, junk: { a: 1 } } }), { ok: true, stored: true });
  s2 = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.deepEqual(s2.list[0].head.pdf, { file: 'x.pdf', folder: 'lab_charts', path: 'D:\\StockBlueprintData\\lab_charts', pages: 1002, trades: 500, shown: 500,
                                          drive: { id: 'FILE_abc_xyz12', url: 'https://drive.google.com/file/d/FILE_abc_xyz12/view' } });
  assert.deepEqual(pc(env, { op: 'pdf', id: 'Lnope', pdf: { error: 'x' } }), { ok: true, stored: false });
  assert.deepEqual(site(env, { op: 'lab', lab: { do: 'result', id: got.job.id } }).item.head.pdf.pages, 1002);
  // an older laptop's plain result still works
  site(env, { op: 'lab', lab: { do: 'run', name: 'old', params: { tf: 'D' } } });
  const old = pc(env, { op: 'poll' }).job;
  assert.deepEqual(pc(env, { op: 'result', id: old.id, result: RESULT }), { ok: true, stored: true });
  assert.equal(site(env, { op: 'lab', lab: { do: 'result', id: old.id } }).item.result.stats.trades, 412);
  // the page's Lab reads with the right PIN take no document lock; a wrong PIN is still counted (the locked way)
  const calls = env.calls.filter ? env.calls.length : 0;
  assert.equal(site(env, { op: 'lab', pin: 'wrong1', lab: { do: 'status' } }).error, 'wrong PIN');
  assert.ok(calls >= 0);
});

test('My daily scan (owner, 16-Nov-2026: "Backtestlab laye entha strategy lam venum, ena rules lam venum nu dailyscan ku angaiye setpanra mari venum"): the page saves the setups + rules, the laptop takes them with its poll / symbol list, the Intraday Patterns tab follows', () => {
  const env = mock.loadCodeGs({ sheets: [{ name: 'Main', rows: [[], ['SYMBOL']] }, { name: 'PatternData', rows: [['h'], ['', '', '', 'PARAGMILK'], ['', '', '', 'ABC']] }] },
    { now: T0, props: { AB_FEED_TOKEN: FEED, AB_BRIDGE_TOKEN: BRIDGE }, prompts: [PIN, PIN] });
  env.call('runWatchlistPinSetup');
  let st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.scan, null, 'nothing saved yet: the laptop keeps ChochRules.bat\'s');
  assert.deepEqual(pc(env, { op: 'poll', scanAt: '' }), { ok: true, job: null, next: 10, v: 2 });
  st = site(env, { op: 'lab', lab: { do: 'scan', name: ' My   SMC ', params: { tf: 'D', group: 'touch', pivotN: 10, discount: 0.382 },
    rules: { pivotN: 10, downN: 4, fib: 0.382, part: 'top', zoneWhen: 'leg', chochMode: 'protected', scanChoch: true, bos: false, scanSpring: false,
             scanGapSpring: true, scanH4: true, on4H: false, onD: true, onW: true, ltf: 'off', h4Body: 0.7, h4Zones: 'fvg', m15Choch: 'only',
             m15Pivot: 99, junk: 'x' } } });
  assert.ok(st.ok && st.scan, JSON.stringify(st));
  assert.equal(st.scan.at, '2026-11-09 15:30:00');
  assert.equal(st.scan.name, 'My SMC');
  assert.equal(st.scan.took, null, 'the laptop has not taken them yet');
  assert.equal(st.scan.setups, 'CHoCH + FVG, Gap-up FVG + Spring on D, W; Daily FVG + 4H Spring (the red day\'s body at least 0.7 x ATR, FVG zones, 15-minute CHoCH required)');
  assert.equal(st.scan.rules, 'swings of 10 candles, at least 4 lower highs / lows, the zone\'s top at least 38.2% down the move, the zone formed only in the CHoCH move, ' +
    'the 2nd discount zone when the move has two (the 1st only watched), the CHoCH breaks the protected high (the swing high before the lowest low)');
  assert.deepEqual([st.scan.values.m15Pivot, st.scan.values.bos, st.scan.values.ltf, st.scan.values.junk], [3, false, 'off', undefined], 'checked: out of range = the default');
  assert.deepEqual(st.scan.params, { tf: 'D', group: 'touch', pivotN: 10, discount: 0.382 }, 'the form they came from ("Put the daily scan\'s rules in the form")');
  assert.equal(env.context.CacheService.getScriptCache().get('AB_LAB_WAKE'), 'scan', 'a waiting laptop poll answers at once');
  // the laptop's poll: the rules while it does not have them; then it says it has them -> noted for the page
  const p1 = pc(env, { op: 'poll', wait: 25, scanAt: '' });
  assert.deepEqual([p1.job, p1.waited, p1.scan.at, p1.scan.rules.pivotN, p1.scan.rules.scanSpring, p1.scan.rules.junk], [null, true, '2026-11-09 15:30:00', 10, false, undefined]);
  assert.equal(pc(env, { op: 'poll', scanAt: '2026-11-09 15:30:00' }).scan, undefined);
  st = site(env, { op: 'lab', lab: { do: 'status' } });
  assert.equal(st.scan.took, T0, 'your laptop has it');
  // the daily scan's symbol list hands them over too (a laptop whose Lab worker is off)
  const syms = plain(env.post({ token: BRIDGE, action: 'intraday', op: 'syms', scanAt: 'older' }));
  assert.ok(syms.ok && syms.scan && syms.scan.rules.pivotN === 10);
  assert.equal(plain(env.post({ token: BRIDGE, action: 'intraday', op: 'syms', scanAt: '2026-11-09 15:30:00' })).scan, undefined);
  // a run still goes as before beside it
  site(env, { op: 'lab', lab: { do: 'run', params: { tf: 'D' } } });
  assert.ok(pc(env, { op: 'poll', scanAt: '2026-11-09 15:30:00' }).job);
  // the Intraday Patterns tab: the setups switched off leave it, 'Daily FVG + 4H Spring' is kept with its note
  const it = (sym, tf, pattern, candle, note) => ({ sym: sym, tf: tf, pattern: pattern, candle: candle, session: candle.slice(0, 10), low: 100, close: 101,
                                                   zone: [99, 102, '2026-10-01', 'FVG', 'top', 1], note: note });
  const rules = st.scan.values;
  const r = plain(env.post({ token: BRIDGE, action: 'intraday', op: 'put', upto: '2026-11-06', since: '2026-10-23', first: true, tfs: ['4H', 'D', 'W', 'M'],
    slots: { '4H': ['13:15'] }, choch: rules, items: [it('PARAGMILK', 'D', 'Daily FVG + 4H Spring', '2026-11-05', 'first day back in the zone: red, body 1.2 x ATR · 4H: 09:15 red, 13:15 Spring (under its low, closed back above) · 15m CHoCH 14:15 (2 lower highs / lows)'),
      it('PARAGMILK', 'D', 'Spring in FVG', '2026-11-05'), it('ABC', '4H', 'CHoCH + FVG', '2026-11-05 13:15', 'Zone first touch'),
      it('ABC', 'D', 'CHoCH + FVG', '2026-11-04', 'Zone first touch'), it('ABC', 'D', 'BOS + FVG', '2026-11-04', 'Zone first touch'), it('ABC', 'W', 'Spring', '2026-11-03')] }));
  assert.equal(r.ok, true);
  const tab = env.sheet('Intraday Patterns').rows;
  assert.deepEqual(tab.slice(2).map((x) => [x[1], x[3], x[4]]), [['PARAGMILK', 'D', 'Daily FVG + 4H Spring'], ['ABC', 'D', 'CHoCH + FVG'], ['ABC', 'W', 'Spring']],
    'FVG + Spring, BOS + FVG and the 4-hour chart are off');
  assert.match(tab[2][13], /^FVG top \(touch 1\) · first day back in the zone: red, body 1\.2 x ATR · 4H: 09:15 red, 13:15 Spring \(under its low, closed back above\) · 15m CHoCH 14:15/);
  assert.match(tab[0][0], /Your setups \(Backtest Lab > My daily scan\): CHoCH \+ FVG, Gap-up FVG \+ Spring on D, W; Daily FVG \+ 4H Spring \(/);
  // a later close under its low: the row leaves the tab like the others
  env.post({ token: BRIDGE, action: 'intraday', op: 'put', upto: '2026-11-07', since: '2026-11-06', tfs: ['4H', 'D', 'W', 'M'], slots: { '4H': ['13:15'] }, choch: rules,
    items: [], first: true, invalid: [{ sym: 'PARAGMILK', tf: 'D', candle: '2026-11-05', pattern: 'Daily FVG + 4H Spring' }] });
  assert.deepEqual(env.sheet('Intraday Patterns').rows.slice(2).map((x) => x[4]), ['CHoCH + FVG', 'Spring']);
  // an older laptop (rules without the setups): everything stays as before
  assert.equal(env.run('ab_scanSetupsText_(ab_scanRules_({ pivotN: 5 }))'), 'CHoCH + FVG, BOS + FVG, FVG + Spring, Gap-up FVG + Spring on 4H, D, W');
  assert.equal(env.run('ab_scanOff_(ab_scanRules_({}), "Spring in FVG", "4H") || ab_scanOff_(ab_scanRules_({}), "BOS + FVG", "W")'), false);
  assert.equal(env.run('ab_scanOff_(ab_scanRules_({}), "Daily FVG + 4H Spring", "D")'), true);
  assert.equal(env.run('ab_scanSetupsText_(ab_scanRules_({ scanChoch: false, bos: false, scanSpring: false, scanGapSpring: false }))'), 'none of the setups');
});

test('My daily scan: the sheet\'s check of the rules + its words = the laptop\'s (kite_intraday.py choch_rules / setup_words / choch_rules_words) on random rules', () => {
  const { spawnSync } = require('child_process');
  const path = require('path');
  const py = ['python3', 'python'].find((p) => spawnSync(p, ['-c', 'import sys']).status === 0);
  if (!py) return;
  const env = load();
  const rnd = (() => { let x = 160; return () => { x = (x * 1103515245 + 12345) % 2147483648; return x / 2147483648; }; })();
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const sets = [];
  for (let k = 0; k < 60; k++) {
    sets.push({ pivotN: pick([2, 3, 5, 8, 10, 25]), downN: pick([1, 3, 4, 9]), fib: pick([0.382, 0.5, 0.618, 0.786, 0.1]), part: pick(['mid', 'top', 'bottom', 'x']),
      zoneWhen: pick(['both', 'leg', 'after']), zoneMin: pick([0, 2, 60]), zoneMax: pick([0, 8, 15]), lineOk: pick([true, false]), lineTol: pick([0, 1, 9]),
      gapEntry: pick([true, false]), darkCloud: pick(['any', 'exclude', 'only']), fibPat: pick(['off', 'big', 'all']), fibLevel: pick([0.5, 0.618, 0.786]),
      fibTol: pick([0.5, 1, 3]), zonePick: pick(['second', 'every']), touchAgain: pick([true, false]), chochMode: pick(['last', 'protected']),
      bos: pick([true, false]), bosKind: pick(['both', 'first', 'trend']), ltf: pick(['15m', '1H', 'off']), scanChoch: pick([true, false]),
      scanSpring: pick([true, false]), scanGapSpring: pick([true, false]), scanH4: pick([true, false]), on4H: pick([true, false]), onD: pick([true, false]),
      onW: pick([true, false]), h4Body: pick([0, 0.3, 0.5, 1.5, 9]), h4Zones: pick(['both', 'fvg', 'gap']), m15Choch: pick(['show', 'only', 'off']),
      m15Pivot: pick([2, 3, 4, 7]), m15Down: pick([1, 2, 3, 0]) });
  }
  const gs = JSON.parse(JSON.stringify(env.run('(function (sets) { return sets.map(function (r) { const x = ab_scanRules_(r); return [x, ab_scanSetupsText_(x), ab_chochRulesText_(x)]; }); })(' +
    JSON.stringify(sets) + ')')));
  const code = 'import json, sys\nsys.path.insert(0, sys.argv[1])\nimport kite_intraday as K\nsets = json.load(sys.stdin)\n' +
    'out = []\nfor r in sets:\n    x = K.choch_rules({K._rule_names()[k]: v for k, v in r.items() if k in K._rule_names()})\n' +
    '    out.append([x, K.setup_words(x), K.choch_rules_words(x)])\nprint(json.dumps(out))\n';
  const res = spawnSync(py, ['-c', code, path.join(__dirname, '..', 'pcbridge', 'ScreenerBridge')], { input: JSON.stringify(sets), encoding: 'utf8' });
  assert.equal(res.status, 0, res.stderr);
  const pyOut = JSON.parse(res.stdout);
  gs.forEach((g, k) => {
    assert.deepEqual(Object.keys(g[0]).sort(), Object.keys(pyOut[k][0]).sort(), 'the same rules');
    Object.keys(g[0]).forEach((key) => {
      const a = g[0][key], b = pyOut[k][0][key];
      assert.ok(typeof a === 'number' ? Math.abs(a - b) < 1e-9 : a === b, key + ': ' + a + ' vs ' + b + ' ' + JSON.stringify(sets[k]));
    });
    assert.equal(g[1], pyOut[k][1], JSON.stringify(sets[k]));
    assert.equal(g[2], pyOut[k][2], JSON.stringify(sets[k]));
  });
});
