'use strict';
// The committed industry data files are valid and up to date with their sources:
// tools/build_industry_data.js --check (master, Code.gs parity, profiles schema) passes,
// and web/data/industries.js / industry-profiles.js match the master and the profile files.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
function load(file, name) { const w = {}; new Function('window', fs.readFileSync(path.join(ROOT, 'web', 'data', file), 'utf8'))(w); return w[name]; }

test('build tool --check passes (master, Code.gs parity, profile schema)', () => {
  const out = execFileSync(process.execPath, [path.join(ROOT, 'tools', 'build_industry_data.js'), '--check'], { encoding: 'utf8' });
  assert.ok(/\nOK\s*$/.test(out), out.slice(-400));
});

test('web/data/industries.js matches the master and the profile files', () => {
  const D = load('industries.js', 'SB_INDUSTRIES');
  const P = load('industry-profiles.js', 'SB_INDUSTRY_PROFILES');
  const tool = require('../tools/build_industry_data.js');
  const flat = tool.flatten(JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'classification', 'nse-industry-classification.json'), 'utf8')));
  ['macros', 'sectors', 'industries', 'basics'].forEach((k) => {
    assert.deepStrictEqual(D[k].map((x) => x.id + '|' + x.name), flat[k].map((x) => x.id + '|' + x.name), k + ' - rerun npm run industries');
  });
  assert.deepStrictEqual(D.meta.counts, { macro: 12, sector: 22, industry: 59, basic: 197 });
  // profiles in the site file = profile JSON files
  const written = {};
  const dir = path.join(ROOT, 'data', 'classification', 'profiles');
  if (fs.existsSync(dir)) fs.readdirSync(dir).filter((f) => f.endsWith('.json')).forEach((f) => {
    (JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')).basicIndustries || []).forEach((b) => { written[b.id] = b; });
  });
  assert.deepStrictEqual(Object.keys(P.profiles).sort(), Object.keys(written).sort(), 'profiles - rerun npm run industries');
  D.basics.forEach((b) => assert.strictEqual(b.hasProfile, !!written[b.id], b.id + ' hasProfile'));
  assert.strictEqual(D.meta.profiles.written + D.meta.profiles.missing, 197);
});
