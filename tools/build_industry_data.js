'use strict';
// Industry classification build / import tool (no network).
//
//   node tools/build_industry_data.js              validate + write web/data/industries.js
//                                                  and web/data/industry-profiles.js, print a report
//   node tools/build_industry_data.js --check      validate only (exit 1 on any error), write nothing
//   node tools/build_industry_data.js --import-csv <file.csv> [--write-candidate]
//        compare a new official list (columns: macro,sector,industry,basic - header row required)
//        with the master; report added / removed / moved / renamed entries; with
//        --write-candidate save data/classification/candidate-<date>.json for review.
//        The master itself is NEVER overwritten by an import: review the candidate, then
//        copy it over data/classification/nse-industry-classification.json by hand.
//   --allow-removals   let a build drop ids that the previous web/data/industries.js had
//
// Inputs:  data/classification/nse-industry-classification.json  (hierarchy, stable ids)
//          data/classification/profiles/*.json                    (research notes per id)
//          web/lib/industry-metrics.js                             (metric sets)
//          Code.gs AB_NSE_TAXONOMY                                 (must match the master)
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const MASTER = path.join(ROOT, 'data', 'classification', 'nse-industry-classification.json');
const PROFILES_DIR = path.join(ROOT, 'data', 'classification', 'profiles');
const OUT = path.join(ROOT, 'web', 'data', 'industries.js');
const OUT_PROFILES = path.join(ROOT, 'web', 'data', 'industry-profiles.js');
const METRICS = require(path.join(ROOT, 'web', 'lib', 'industry-metrics.js'));
const IND = require(path.join(ROOT, 'web', 'lib', 'industry.js'));

const args = process.argv.slice(2);
const has = (f) => args.indexOf(f) >= 0;
const errors = [], warnings = [];
const err = (m) => errors.push(m), warn = (m) => warnings.push(m);

function today() { return new Date(Date.now() + 330 * 60000).toISOString().slice(0, 10); }
function slug(s) { return String(s).toLowerCase().replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, ''); }

// ---------- master ----------
function loadMaster() { return JSON.parse(fs.readFileSync(MASTER, 'utf8')); }

/** Flatten the nested master into normalized entities with parent ids. */
function flatten(master) {
  const macros = [], sectors = [], industries = [], basics = [];
  (master.macroSectors || []).forEach((m, mi) => {
    macros.push({ id: m.id, code: m.code || null, name: m.name, order: mi + 1 });
    (m.sectors || []).forEach((s, si) => {
      sectors.push({ id: s.id, macroId: m.id, name: s.name, order: si + 1 });
      (s.industries || []).forEach((i, ii) => {
        industries.push({ id: i.id, sectorId: s.id, macroId: m.id, name: i.name, order: ii + 1 });
        (i.basicIndustries || []).forEach((b, bi) => {
          basics.push({ id: b.id, industryId: i.id, sectorId: s.id, macroId: m.id, name: b.name, order: bi + 1 });
        });
      });
    });
  });
  return { macros, sectors, industries, basics };
}

function validateMaster(master, flat) {
  ['title', 'version', 'source', 'verification', 'macroSectors'].forEach((k) => { if (!master[k]) err('master: missing "' + k + '"'); });
  const seen = {}, names = { macro: {}, sector: {}, industry: {}, basic: {} };
  const check = (level, e, parentOk) => {
    if (!e.id || !e.name) { err(level + ': entry without id or name: ' + JSON.stringify(e)); return; }
    if (e.id.indexOf(IND.PREFIX[level]) !== 0) err(level + ' "' + e.name + '": id "' + e.id + '" must start with "' + IND.PREFIX[level] + '"');
    if (!/^[a-z]-[a-z0-9-]+$/.test(e.id)) err(level + ' "' + e.name + '": id "' + e.id + '" may only use a-z, 0-9 and -');
    if (seen[e.id]) err('duplicate id ' + e.id);
    seen[e.id] = true;
    const k = IND.key(e.name);
    if (names[level][k]) err('duplicate ' + level + ' name "' + e.name + '" (' + names[level][k] + ', ' + e.id + ')');
    names[level][k] = e.id;
    if (parentOk === false) err(level + ' ' + e.id + ': missing / wrong parent');
  };
  const ids = (list) => new Set(list.map((x) => x.id));
  const mIds = ids(flat.macros), sIds = ids(flat.sectors), iIds = ids(flat.industries);
  flat.macros.forEach((m) => check('macro', m, true));
  flat.sectors.forEach((s) => check('sector', s, mIds.has(s.macroId)));
  flat.industries.forEach((i) => check('industry', i, sIds.has(i.sectorId)));
  flat.basics.forEach((b) => check('basic', b, iIds.has(b.industryId)));
  flat.macros.forEach((m) => { if (!flat.sectors.some((s) => s.macroId === m.id)) err('macro ' + m.id + ' has no sectors'); });
  flat.sectors.forEach((s) => { if (!flat.industries.some((i) => i.sectorId === s.id)) err('sector ' + s.id + ' has no industries'); });
  flat.industries.forEach((i) => { if (!flat.basics.some((b) => b.industryId === i.id)) err('industry ' + i.id + ' has no basic industries'); });
}

/** AB_NSE_TAXONOMY rows [sector, industry, [basics]] read from Code.gs without running it. */
function codeGsTaxonomy() {
  const src = fs.readFileSync(path.join(ROOT, 'Code.gs'), 'utf8');
  const a = src.indexOf('const AB_NSE_TAXONOMY = [');
  if (a < 0) return null;
  const b = src.indexOf('\n];', a);
  return vm.runInNewContext('(' + src.slice(a + 'const AB_NSE_TAXONOMY = '.length, b + 2) + ')');
}
function checkCodeGs(flat) {
  const T = codeGsTaxonomy();
  if (!T) { err('Code.gs: AB_NSE_TAXONOMY not found'); return; }
  const fromCode = new Set(), fromMaster = new Set();
  T.forEach((r) => r[2].forEach((b) => fromCode.add([r[0], r[1], b].map(IND.key).join('|'))));
  const byId = {};
  flat.sectors.concat(flat.industries).forEach((x) => { byId[x.id] = x; });
  flat.basics.forEach((b) => fromMaster.add([byId[b.sectorId].name, byId[b.industryId].name, b.name].map(IND.key).join('|')));
  fromCode.forEach((k) => { if (!fromMaster.has(k)) err('Code.gs AB_NSE_TAXONOMY has "' + k + '" which the master lacks'); });
  fromMaster.forEach((k) => { if (!fromCode.has(k)) err('master has "' + k + '" which Code.gs AB_NSE_TAXONOMY lacks'); });
}

// ---------- profiles ----------
const BASIC_REQUIRED = ['simplifiedExplanation', 'productsAndServices', 'valueChainPosition', 'howTheyMakeMoney', 'revenueSources', 'operatingCosts',
  'customersAndEndMarkets', 'demandSupplyDrivers', 'domesticInternationalExposure', 'capexIntensity', 'workingCapital', 'regulation',
  'competitiveAdvantages', 'drivers', 'risks', 'cyclicality', 'metricSet'];
function loadProfiles(flat) {
  const out = { macros: {}, sectors: {}, industries: {}, basics: {} }, files = {};
  if (!fs.existsSync(PROFILES_DIR)) return { out, files };
  const valid = { macros: new Set(flat.macros.map((x) => x.id)), sectors: new Set(flat.sectors.map((x) => x.id)),
    industries: new Set(flat.industries.map((x) => x.id)), basics: new Set(flat.basics.map((x) => x.id)) };
  const SECTION = { macroSectors: 'macros', sectors: 'sectors', industries: 'industries', basicIndustries: 'basics' };
  fs.readdirSync(PROFILES_DIR).filter((f) => f.endsWith('.json')).sort().forEach((f) => {
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(PROFILES_DIR, f), 'utf8')); } catch (e) { err('profiles/' + f + ': not valid JSON (' + e.message + ')'); return; }
    Object.keys(SECTION).forEach((sec) => {
      (j[sec] || []).forEach((p) => {
        const bucket = SECTION[sec];
        if (!p || !p.id) { err('profiles/' + f + ': ' + sec + ' entry without id'); return; }
        if (!valid[bucket].has(p.id)) { err('profiles/' + f + ': unknown ' + sec + ' id "' + p.id + '"'); return; }
        if (out[bucket][p.id]) { err('profiles: ' + p.id + ' written twice (' + files[p.id] + ', ' + f + ')'); return; }
        out[bucket][p.id] = p; files[p.id] = f;
      });
    });
  });
  // basic-industry checks
  Object.keys(out.basics).forEach((id) => {
    const p = out.basics[id];
    BASIC_REQUIRED.forEach((k) => {
      const v = p[k];
      if (v == null || v === '' || (Array.isArray(v) && !v.length)) err(id + ': missing "' + k + '"');
    });
    if (p.capexIntensity && ['Low', 'Medium', 'High'].indexOf(p.capexIntensity) < 0) err(id + ': capexIntensity must be Low / Medium / High');
    if (p.cyclicality && ['Cyclical', 'Defensive', 'Mixed'].indexOf(p.cyclicality) < 0) err(id + ': cyclicality must be Cyclical / Defensive / Mixed');
    if (p.metricSet && !METRICS.SETS[p.metricSet]) err(id + ': unknown metricSet "' + p.metricSet + '"');
    (p.relatedBasicIndustries || []).forEach((r) => {
      if (r === id) err(id + ': relates to itself');
      else if (!valid.basics.has(r)) err(id + ': unknown related basic industry "' + r + '"');
    });
    (p.drivers || []).forEach((d) => { if (!d || !d.factor || !d.impact) err(id + ': driver needs factor + impact'); });
    (p.risks || []).forEach((r) => { if (!r || !r.risk || !r.detail) err(id + ': risk needs risk + detail'); });
    // invented figures are not allowed in the notes
    const text = JSON.stringify(p);
    if (/\b\d{1,3}(\.\d+)?\s?%|\b(19|20)\d\d\b|rs\.?\s?\d|₹\s?\d/i.test(text)) warn(id + ': contains a number / year / percentage - the notes must stay qualitative');
  });
  // the same sentence reused across many basic industries = generic text
  const seenSentences = {};
  Object.keys(out.basics).forEach((id) => {
    const p = out.basics[id];
    ['simplifiedExplanation', 'howTheyMakeMoney', 'demandSupplyDrivers', 'competitiveAdvantages'].forEach((k) => {
      const s = String(p[k] || '').trim().toLowerCase();
      if (s.length < 40) return;
      (seenSentences[s] = seenSentences[s] || []).push(id);
    });
  });
  Object.keys(seenSentences).forEach((s) => { if (seenSentences[s].length > 2) warn('same text in ' + seenSentences[s].length + ' basic industries: ' + seenSentences[s].slice(0, 4).join(', ')); });
  return { out, files };
}

// ---------- import report (previous build vs this build) ----------
function readPrevious() {
  if (!fs.existsSync(OUT)) return null;
  try { const w = {}; new Function('window', fs.readFileSync(OUT, 'utf8'))(w); return w.SB_INDUSTRIES || null; } catch (e) { return null; }
}
function diffEntities(prev, next) {
  const rep = { added: [], removed: [], renamed: [], moved: [], unchanged: 0 };
  ['macros', 'sectors', 'industries', 'basics'].forEach((k) => {
    const a = {}; (prev ? prev[k] || [] : []).forEach((x) => { a[x.id] = x; });
    const b = {}; (next[k] || []).forEach((x) => { b[x.id] = x; });
    Object.keys(b).forEach((id) => {
      if (!a[id]) { rep.added.push(id); return; }
      const parentKey = (x) => x.industryId || x.sectorId || x.macroId || '';
      if (a[id].name !== b[id].name) rep.renamed.push(id + ': "' + a[id].name + '" -> "' + b[id].name + '"');
      else if (parentKey(a[id]) !== parentKey(b[id])) rep.moved.push(id + ': ' + parentKey(a[id]) + ' -> ' + parentKey(b[id]));
      else rep.unchanged++;
    });
    Object.keys(a).forEach((id) => { if (!b[id]) rep.removed.push(id); });
  });
  return rep;
}

// ---------- CSV import (official list -> candidate master) ----------
function parseCsv(text) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (q) { if (ch === '"' && text[i + 1] === '"') { cell += '"'; i++; } else if (ch === '"') q = false; else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === ',') { row.push(cell); cell = ''; }
    else if (ch === '\n' || ch === '\r') { if (ch === '\r' && text[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((r) => r.some((c) => String(c).trim()));
}
function importCsv(file, master, flat) {
  const rows = parseCsv(fs.readFileSync(file, 'utf8'));
  const hdr = rows.shift().map((h) => IND.key(h));
  const col = (n) => hdr.indexOf(n);
  const ci = { macro: col('macro') >= 0 ? col('macro') : col('macroeconomicsector'), sector: col('sector'), industry: col('industry'), basic: col('basic') >= 0 ? col('basic') : col('basicindustry') };
  Object.keys(ci).forEach((k) => { if (ci[k] < 0) err('CSV: no "' + k + '" column (need macro, sector, industry, basic)'); });
  if (errors.length) return null;
  const idOf = {}; ['macros', 'sectors', 'industries', 'basics'].forEach((k, li) => flat[k].forEach((x) => { idOf[IND.LEVELS[li] + '|' + IND.key(x.name)] = x.id; }));
  const cand = JSON.parse(JSON.stringify(master));
  cand.macroSectors = [];
  const pick = (level, name) => idOf[level + '|' + IND.key(name)] || IND.PREFIX[level] + slug(name);
  const seenBasic = {};
  rows.forEach((r, n) => {
    const v = { macro: String(r[ci.macro] || '').trim(), sector: String(r[ci.sector] || '').trim(), industry: String(r[ci.industry] || '').trim(), basic: String(r[ci.basic] || '').trim() };
    if (!v.macro || !v.sector || !v.industry || !v.basic) { err('CSV row ' + (n + 2) + ': empty level'); return; }
    if (seenBasic[IND.key(v.basic)]) { err('CSV row ' + (n + 2) + ': basic industry "' + v.basic + '" listed twice'); return; }
    seenBasic[IND.key(v.basic)] = true;
    let M = cand.macroSectors.find((x) => IND.key(x.name) === IND.key(v.macro));
    if (!M) { M = { id: pick('macro', v.macro), code: (master.macroSectors.find((x) => IND.key(x.name) === IND.key(v.macro)) || {}).code || null, name: v.macro, sectors: [] }; cand.macroSectors.push(M); }
    let S = M.sectors.find((x) => IND.key(x.name) === IND.key(v.sector));
    if (!S) { S = { id: pick('sector', v.sector), name: v.sector, industries: [] }; M.sectors.push(S); }
    let I = S.industries.find((x) => IND.key(x.name) === IND.key(v.industry));
    if (!I) { I = { id: pick('industry', v.industry), name: v.industry, basicIndustries: [] }; S.industries.push(I); }
    I.basicIndustries.push({ id: pick('basic', v.basic), name: v.basic });
  });
  cand.verification = Object.assign({}, cand.verification, { candidateFrom: path.basename(file), candidateBuilt: today() });
  return cand;
}

// ---------- main ----------
function main() {
  const master = loadMaster();
  const flat = flatten(master);
  validateMaster(master, flat);
  checkCodeGs(flat);
  const counts = { macro: flat.macros.length, sector: flat.sectors.length, industry: flat.industries.length, basic: flat.basics.length };

  const ix = args.indexOf('--import-csv');
  if (ix >= 0) {
    const cand = importCsv(args[ix + 1], master, flat);
    if (cand) {
      const cflat = flatten(cand);
      const rep = diffEntities(flat, cflat);
      console.log('CSV import report (candidate vs master):');
      console.log('  candidate counts: macro ' + cflat.macros.length + ', sector ' + cflat.sectors.length + ', industry ' + cflat.industries.length + ', basic ' + cflat.basics.length);
      console.log('  added ' + rep.added.length + ', removed ' + rep.removed.length + ', renamed ' + rep.renamed.length + ', moved ' + rep.moved.length + ', unchanged ' + rep.unchanged);
      ['added', 'removed', 'renamed', 'moved'].forEach((k) => rep[k].slice(0, 40).forEach((x) => console.log('   ' + k + ': ' + x)));
      if (has('--write-candidate')) {
        const f = path.join(ROOT, 'data', 'classification', 'candidate-' + today() + '.json');
        fs.writeFileSync(f, JSON.stringify(cand, null, 2) + '\n');
        console.log('  candidate written to ' + path.relative(ROOT, f) + ' - review it, then replace the master by hand (the build checks it against Code.gs).');
      }
    }
    return finish(null);
  }

  const prof = loadProfiles(flat);
  const P = prof.out;
  const missing = flat.basics.filter((b) => !P.basics[b.id]).map((b) => b.id);
  const decorate = (list, bucket, fields) => list.map((x) => {
    const p = P[bucket][x.id] || {};
    const o = Object.assign({}, x);
    fields.forEach((f) => { if (p[f] != null) o[f] = p[f]; });
    return o;
  });
  const data = {
    meta: {
      title: master.title, version: master.version, levels: master.levels, source: master.source, verification: master.verification,
      generated: today(), counts: counts,
      profiles: { written: Object.keys(P.basics).length, missing: missing.length,
        note: 'Research notes written for Stock Blueprint (general analysis, not NSE text). Official NSE definitions are not included.' }
    },
    macros: decorate(flat.macros, 'macros', ['description']),
    sectors: decorate(flat.sectors, 'sectors', ['description']),
    industries: decorate(flat.industries, 'industries', ['description', 'businessOverview', 'keyDemandDrivers', 'keyRisks']),
    basics: decorate(flat.basics, 'basics', ['aliases', 'themes', 'metricSet', 'cyclicality'])
      .map((b) => Object.assign(b, { hasProfile: !!P.basics[b.id] }))
  };
  const prev = readPrevious();
  const rep = diffEntities(prev, data);
  console.log('Industry classification: ' + master.title + ' (' + master.version + ')');
  console.log('  levels: ' + counts.macro + ' macro-economic sectors, ' + counts.sector + ' sectors, ' + counts.industry + ' industries, ' + counts.basic + ' basic industries');
  console.log('  vs previous build: added ' + rep.added.length + ', removed ' + rep.removed.length + ', renamed ' + rep.renamed.length + ', moved ' + rep.moved.length + ', unchanged ' + rep.unchanged);
  rep.removed.forEach((x) => console.log('   removed: ' + x));
  rep.renamed.forEach((x) => console.log('   renamed: ' + x));
  rep.moved.forEach((x) => console.log('   moved: ' + x));
  console.log('  profiles: ' + Object.keys(P.basics).length + ' of ' + counts.basic + ' basic industries, ' + Object.keys(P.industries).length + ' of ' + counts.industry +
    ' industries, ' + Object.keys(P.sectors).length + ' of ' + counts.sector + ' sectors, ' + Object.keys(P.macros).length + ' of ' + counts.macro + ' macro sectors');
  if (missing.length) console.log('  basic industries without a profile (' + missing.length + '): ' + missing.slice(0, 20).join(', ') + (missing.length > 20 ? ' ...' : ''));
  if (prev && rep.removed.length && !has('--allow-removals')) err(rep.removed.length + ' id(s) would be removed - rerun with --allow-removals after checking them');
  if (has('--check') || errors.length) return finish(null);

  const head = '// Generated by tools/build_industry_data.js - do not edit by hand\n';
  fs.writeFileSync(OUT, head + 'window.SB_INDUSTRIES = ' + JSON.stringify(data) + ';\n');
  const profiles = {};
  Object.keys(P.basics).forEach((id) => { const p = Object.assign({}, P.basics[id]); delete p.id; profiles[id] = p; });
  fs.writeFileSync(OUT_PROFILES, head + 'window.SB_INDUSTRY_PROFILES = ' + JSON.stringify({ generated: today(), note: data.meta.profiles.note, profiles: profiles }) + ';\n');
  console.log('  wrote ' + path.relative(ROOT, OUT) + ' (' + Math.round(fs.statSync(OUT).size / 1024) + ' KB) and ' + path.relative(ROOT, OUT_PROFILES) + ' (' + Math.round(fs.statSync(OUT_PROFILES).size / 1024) + ' KB)');
  return finish(null);
}
function finish() {
  warnings.forEach((w) => console.log('  ! ' + w));
  if (errors.length) {
    errors.slice(0, 60).forEach((e) => console.error('  x ' + e));
    console.error((errors.length > 60 ? '  ... ' + (errors.length - 60) + ' more\n' : '') + 'FAILED: ' + errors.length + ' error(s) - nothing written');
    process.exit(1);
  }
  console.log('OK');
}

if (require.main === module) main();
module.exports = { flatten, parseCsv, diffEntities, codeGsTaxonomy };
