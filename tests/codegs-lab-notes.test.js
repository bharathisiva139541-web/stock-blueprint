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
  assert.deepEqual(pc(env, { op: 'poll' }), { ok: true, job: null, next: 10 });
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
  assert.deepEqual(pc(env, { op: 'poll' }), { ok: true, job: null, next: 120 }, 'too old: dropped; the page is shut -> every 2 min');
  assert.match(site(env, { op: 'lab', lab: { do: 'status' } }).job.error, /did not take it in 12 hours/);
  // a waiting run can be cancelled; a running one cannot be replaced
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  assert.equal(site(env, { op: 'lab', lab: { do: 'cancel' } }).job.status, 'cancelled');
  site(env, { op: 'lab', lab: { do: 'run', params: {} } });
  pc(env, { op: 'poll' });
  assert.match(site(env, { op: 'lab', lab: { do: 'run', params: {} } }).error, /a run is going on/);
  assert.equal(site(env, { op: 'lab', lab: { do: 'status' } }).pcSeenSec, 0);
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
