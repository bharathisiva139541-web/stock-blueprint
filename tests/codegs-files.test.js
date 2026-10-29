'use strict';
// The Apps Script project is two files (the editor cuts a file at 1,000,000 characters): Code.gs and
// Code2.gs, one global scope, run in that order. Each must stay well under the limit, parse on its own,
// declare no top-level name the other one declares (a second const / let is a load error in Apps Script,
// a second function silently replaces the first) and load in order - Code.gs's top-level code must not
// need Code2.gs (the mock runs the files one after the other, like Apps Script).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const mock = require('./fixtures/apps-script-mock.js');

const LIMIT = 1000000, KEEP_UNDER = 950000;
const files = mock.GS_FILES.map((f) => ({ name: path.basename(f), text: fs.readFileSync(f, 'utf8') }));

test('Code.gs + Code2.gs: each under the editor\'s 1,000,000-character limit, with room to grow', () => {
  assert.deepStrictEqual(files.map((f) => f.name), ['Code.gs', 'Code2.gs']);
  files.forEach((f) => {
    assert.ok(f.text.length < KEEP_UNDER, f.name + ' has ' + f.text.length + ' characters (Apps Script cuts at ' + LIMIT +
      ') - move a section to the other file or start Code3.gs');
    assert.doesNotThrow(() => new vm.Script(f.text, { filename: f.name }), f.name + ' must parse on its own');
  });
});

test('Code.gs + Code2.gs: no top-level name declared in both', () => {
  const names = (t) => [...t.matchAll(/^(?:async\s+)?(?:function\s*\*?\s*([A-Za-z_$][\w$]*)|(?:const|let|var|class)\s+([A-Za-z_$][\w$]*))/gm)]
    .map((m) => m[1] || m[2]);
  const a = new Set(names(files[0].text));
  const dup = names(files[1].text).filter((n) => a.has(n));
  assert.deepStrictEqual(dup, []);
});

test('Code.gs + Code2.gs: they load one after the other (Code.gs first) and every entry point is there', () => {
  const env = mock.loadCodeGs({ sheets: [] }, { props: {} });
  ['onOpen', 'doPost', 'doGet', 'ab_dailyPhase1Fetch_', 'ab_rsTriggerRun_', 'ab_siteFeedTrigger_', 'ab_h60FromBridge_']
    .forEach((fn) => assert.strictEqual(typeof env.context[fn], 'function', fn));
  // Code.gs alone loads too (a save of part 1 before part 2 is pasted never breaks the project's loading)
  assert.doesNotThrow(() => mock.loadCodeGs({ sheets: [] }, { props: {}, code: files[0].text }));
});
