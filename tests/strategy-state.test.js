'use strict';
// web/ui/strategy-state.js - Strategy settings saves every change by itself (owner, 03-Nov-2026: "once a strategy is set in
// one browser it should not be deleted when reloaded"): one visit of the page = one new version, later changes of that
// visit amend it (save opts.amend / opts.base); remove(id) deletes a viewer-made strategy only.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const S = require('../web/lib/strategy.js');

function load(mem) {
  const ls = { getItem: (k) => (k in mem ? mem[k] : null), setItem: (k, v) => { mem[k] = String(v); }, removeItem: (k) => { delete mem[k]; } };
  const store = {
    get: (k, d) => { const v = ls.getItem('sb:' + k); return v == null ? d : JSON.parse(v); },
    set: (k, v) => { ls.setItem('sb:' + k, JSON.stringify(v)); return true; },
    del: (k) => ls.removeItem('sb:' + k)
  };
  const SB = { strategy: S, ui: { store: store, iso: (d) => String(d) }, ctx: { market: {}, stocks: [] } };
  const ctx = { window: { SB: SB }, Date: Date, JSON: JSON, Math: Math, Object: Object, Promise: Promise };
  vm.createContext(ctx);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'ui', 'strategy-state.js'), 'utf8'), ctx);
  return SB.strategies;
}

test('a visit makes one version; later changes in it amend that version; the next visit makes the next one', () => {
  const mem = {}, STR = load(mem);
  const base = STR.get('sheet');
  const a = S.clone(base); a.filters[1].enabled = false;
  const r1 = STR.save(a, '');
  assert.deepStrictEqual([r1.ok, r1.config.version, !!r1.amended], [true, 2, false]);
  const b = S.clone(STR.get('sheet')); b.triggers[0].params.min = 2;
  const r2 = STR.save(b, '', { amend: 2, base: base });
  assert.deepStrictEqual([r2.ok, r2.config.version, r2.amended], [true, 2, true]);
  const h = STR.history('sheet');
  assert.strictEqual(h.length, 1, 'one history line for the visit');
  assert.ok(h[0].changes.some((c) => /filters\[2\]\.enabled/.test(c)) && h[0].changes.some((c) => /triggers\[1\]\.params\.min: 3 → 2/.test(c)), 'every change of the visit: ' + h[0].changes);
  // a reload = a new browser session of the same storage: the change is there; a new visit's change = version 3
  const STR2 = load(mem);
  assert.deepStrictEqual([STR2.get('sheet').version, STR2.get('sheet').triggers[0].params.min, STR2.get('sheet').filters[1].enabled], [2, 2, false]);
  const c = S.clone(STR2.get('sheet')); c.triggers[0].params.min = 4;
  assert.strictEqual(STR2.save(c, '').config.version, 3);
  // amend only the version asked for (an older one is never rewritten)
  const d = S.clone(STR2.get('sheet')); d.triggers[0].params.min = 1;
  assert.strictEqual(STR2.save(d, '', { amend: 2, base: base }).config.version, 4);
  // confirmation follows the rules: an amend clears it too
  STR2.confirm('sheet', true);
  assert.ok(STR2.isConfirmed('sheet'));
  const e = S.clone(STR2.get('sheet')); e.triggers[0].params.min = 2;
  STR2.save(e, '', { amend: 4, base: base });
  assert.ok(!STR2.isConfirmed('sheet'), 'changed rules need confirming again');
  // undoing everything of a visit keeps the version, saying so
  const f = S.clone(STR2.get('sheet')); f.triggers[0].params.min = 4;
  const r6 = STR2.save(f, '', { amend: 4, base: STR2.get('sheet') && Object.assign(S.clone(STR2.get('sheet')), { triggers: S.clone(f.triggers) }) });
  assert.deepStrictEqual([r6.config.version, STR2.history('sheet')[0].changes[0]], [4, 'all changes of this version undone']);
});

test('remove: a viewer-made strategy only; the one in use falls back to the sheet\'s', () => {
  const mem = {}, STR = load(mem);
  const c = S.clone(S.PRESETS.qualityGrowth); c.id = 'custom-1'; c.source = 'custom'; c.name = 'Mine';
  assert.ok(STR.save(c, 'created').ok);
  STR.setActive('custom-1');
  assert.strictEqual(STR.activeId(), 'custom-1');
  assert.strictEqual(STR.remove('sheet'), false, 'a preset is reset, not removed');
  assert.strictEqual(STR.remove('custom-1'), true);
  assert.deepStrictEqual([STR.get('custom-1'), STR.activeId(), STR.history('custom-1').length], [null, 'sheet', 0]);
  assert.strictEqual(STR.remove('custom-1'), false);
  // its version number is never reused
  assert.strictEqual(STR.save(c, 'again').config.version, 2);
});
