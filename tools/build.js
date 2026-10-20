'use strict';
// Production build check for the static site (no bundler needed):
//  1. every web/ and api/ script parses;
//  2. every <script src> in web/index.html exists;
//  3. generated data files exist and contain no personal data markers;
//  4. writes a single-file preview to dist/stock-blueprint-preview.html.
// Exit code 1 on any failure. Runs on Vercel too (no network, no Python).
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const WEB = path.join(ROOT, 'web');
let failed = 0;
function fail(msg) { failed++; console.error('  ✗ ' + msg); }
function ok(msg) { console.log('  ✓ ' + msg); }

function walk(dir, ext, out) {
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

console.log('1. syntax');
const scripts = walk(WEB, '.js', []).concat(walk(path.join(ROOT, 'api'), '.js', []));
for (const f of scripts) {
  if (f.includes(path.sep + 'data' + path.sep)) continue;           // big generated data: checked below
  try { new vm.Script(fs.readFileSync(f, 'utf8'), { filename: f }); } catch (e) { fail(path.relative(ROOT, f) + ': ' + e.message); }
}
ok(scripts.length + ' scripts parsed');

console.log('2. index.html references');
const html = fs.readFileSync(path.join(WEB, 'index.html'), 'utf8');
const refs = [...html.matchAll(/<(?:script|link)[^>]+(?:src|href)="([^"#:]+)"/g)].map((m) => m[1]);
for (const r of refs) if (!fs.existsSync(path.join(WEB, r))) fail('missing ' + r);
ok(refs.length + ' local references');

console.log('3. data files');
const PERSONAL = [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/, /script\.google\.com\/macros/, /AKfyc[A-Za-z0-9_-]{20,}/, /"tradeStats"/, /"trades"\s*:/];
for (const f of ['dashboard.js', 'history.js', 'logos.js']) {
  const p = path.join(WEB, 'data', f);
  if (!fs.existsSync(p)) { fail('web/data/' + f + ' missing (run tools/export_xlsx.py)'); continue; }
  const s = fs.readFileSync(p, 'utf8');
  try { const w = {}; new Function('window', s)(w); } catch (e) { fail('web/data/' + f + ' does not load: ' + e.message); continue; }
  PERSONAL.forEach((re) => { if (re.test(s)) fail('web/data/' + f + ' contains a personal-data marker ' + re); });
  ok('web/data/' + f + ' ' + Math.round(s.length / 1024) + ' KB');
}
const wa = path.join(WEB, 'data', 'workbook-analysis.js');
if (fs.existsSync(wa) && /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[a-z]{2,}/.test(fs.readFileSync(wa, 'utf8'))) fail('workbook-analysis.js contains an e-mail address');

console.log('4. single-file preview');
try {
  let page = html.replace('<link rel="stylesheet" href="style.css">', '<style>\n' + fs.readFileSync(path.join(WEB, 'style.css'), 'utf8') + '\n</style>');
  for (const src of refs.filter((r) => r.endsWith('.js'))) {
    const body = fs.readFileSync(path.join(WEB, src), 'utf8').replace(/<\/script/gi, '<\\/script');
    page = page.replace('<script src="' + src + '"></script>', '<script>\n' + body + '\n</script>');
  }
  // history.js is normally loaded on demand; inline it so the preview works from file://
  const hist = fs.readFileSync(path.join(WEB, 'data', 'history.js'), 'utf8').replace(/<\/script/gi, '<\\/script');
  page = page.replace('<script>\n', '<script>\n' + hist + '\n</script>\n<script>\n');
  fs.mkdirSync(path.join(ROOT, 'dist'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'dist', 'stock-blueprint-preview.html'), page);
  ok('dist/stock-blueprint-preview.html ' + Math.round(page.length / 1024) + ' KB');
} catch (e) { fail('preview: ' + e.message); }

if (failed) { console.error('\nBUILD FAILED (' + failed + ')'); process.exit(1); }
console.log('\nbuild ok');
