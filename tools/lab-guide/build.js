#!/usr/bin/env node
/* The Backtest Lab guide (owner, 12-Nov-2026: "give me the guide to use backtest lab") - Tamil, A4, with pictures of the
   real page:
     1. the screenshots: tests/ui/ui.e2e.js's Backtest Lab check run with E2E_ONLY + GUIDE_SHOTS (the same mocked page the
        tests check) -> dist/guide/lab-shots/*.png   (skip with --no-shots to reuse the last ones)
     2. dist/guide/Backtest-Lab-Guide.html -> Chromium print -> dist/guide/Backtest-Lab-Guide.pdf
     3. a copy for the website: web/docs/Backtest-Lab-Guide.pdf (the Lab page's "Guide (PDF)" button)
   `npm run lab-guide` (Chromium = the pre-installed Playwright; NODE_PATH or the global npm root is used to find it).
   When the Lab page changes, run it again so the pictures follow. */
'use strict';
const fs = require('fs');
const path = require('path');
const { execSync, execFileSync } = require('child_process');

const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'dist', 'guide');
const SHOTS = path.join(OUT, 'lab-shots');
const NAME = 'Backtest-Lab-Guide';
const WEB_COPY = path.join(ROOT, 'web', 'docs', NAME + '.pdf');

function npmRoot() { try { return execSync('npm root -g', { encoding: 'utf8' }).trim(); } catch (e) { return ''; } }
function chromiumPath() { return process.env.CHROMIUM_PATH || (fs.existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : ''); }
function playwright() {
  try { return require('playwright'); } catch (e) { /* the global install */ }
  return require(path.join(npmRoot(), 'playwright'));
}

function shots() {
  fs.rmSync(SHOTS, { recursive: true, force: true });
  const env = Object.assign({}, process.env, { E2E_ONLY: 'Backtest Lab', GUIDE_SHOTS: SHOTS, NODE_PATH: process.env.NODE_PATH || npmRoot() });
  if (chromiumPath()) env.CHROMIUM_PATH = chromiumPath();
  execFileSync(process.execPath, [path.join(ROOT, 'tests', 'ui', 'ui.e2e.js')], { env, stdio: 'inherit' });
}

function esc(s) { return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }
// **bold** and `code` in the guide's own text (no other markup)
function md(s) { return esc(s).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`(.+?)`/g, '<code>$1</code>'); }
function img(name, cap, cls) {
  const f = path.join(SHOTS, name + '.png');
  if (!fs.existsSync(f)) return '';
  return '<figure class="' + (cls || '') + '"><img src="lab-shots/' + name + '.png" alt=""><figcaption>' + md(cap || '') + '</figcaption></figure>';
}
function list(items, ordered) { return '<' + (ordered ? 'ol' : 'ul') + '>' + items.map((x) => '<li>' + md(x) + '</li>').join('') + '</' + (ordered ? 'ol' : 'ul') + '>'; }
function table(head, rows) {
  return '<table><thead><tr>' + head.map((h) => '<th>' + md(h) + '</th>').join('') + '</tr></thead><tbody>' +
    rows.map((r) => '<tr>' + r.map((c) => '<td>' + md(c) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
}
function page(title, body, num) { return '<section class="page"><h2>' + (num ? '<span class="num">' + num + '</span>' : '') + md(title) + '</h2>' + body + '</section>'; }
function box(title, body, cls) { return '<div class="box ' + (cls || '') + '">' + (title ? '<h3>' + md(title) + '</h3>' : '') + body + '</div>'; }
function p(t) { return '<p>' + md(t) + '</p>'; }

function html() {
  const pages = [];
  // ---------------------------------------------------------------- cover
  pages.push('<section class="page cover"><div class="brand">Stock Blueprint</div><h1>Backtest Lab<br><span>பயன்படுத்தும் வழிகாட்டி</span></h1>' +
    '<p class="lead">உங்கள் சொந்த trade விதிகளை கடந்த ~20 வருட Zerodha Kite candles-இல் சோதித்து, அவை உண்மையில் வேலை செய்கின்றனவா என்று பார்க்கும் இடம்.</p>' +
    box('இது என்ன?', p('எங்கே வாங்குவது, stop எங்கே, target எவ்வளவு, target-க்குப் பின் stop-ஐ எப்படி நகர்த்துவது - இந்த விதிகளை நீங்கள் தருகிறீர்கள். ' +
      'கடந்த வருடங்களில் வந்த ஒவ்வொரு signal-க்கும் அந்த விதிப்படி trade எடுத்திருந்தால் என்ன ஆகியிருக்கும் என்று **உங்கள் laptop** கணக்கிடுகிறது ' +
      '(Kite candles அங்கேயே இருக்கின்றன). முடிவு ஒரு நிமிடத்தில் website-இல் வரும்.')) +
    box('தொடங்கும் முன் (ஒரு முறை மட்டும்)', list([
      'Laptop on-ஆக இருக்க வேண்டும்; ScreenerBridge program ஓட வேண்டும் (Windows login செய்ததும் அது தானாகத் தொடங்கும்).',
      'Kite-இன் நீண்ட வரலாறு: ScreenerBridge folder-இல் `KiteHistoryNow.bat` - ஒரே ஒரு முறை (சுமார் 2 மணி நேரம்).',
      'Website-இல் உங்கள் PIN: **My Watchlists → Sync with my sheet** → PIN. அதன் பின் **Backtest Lab** திறக்கும் (உங்களுக்கு மட்டும்).',
      'ScreenerBridge update-க்குப் பின் முதல் முறை laptop candles-ஐத் தயார் செய்யும் (சில நிமிடங்கள்) - page-இல் "preparing the candles" என்று காட்டும்.'
    ], true)) +
    box('இந்த guide-இல்', list(['3 படிகள்: ready setup → basics → Run', 'More rules - விருப்பமான விதிகள்', 'முடிவைப் படிப்பது: Real or chance?, Development vs test, What worked best',
      'Runs ஒப்பீடு, TradingView script, Charts PDF', 'ஒரு நல்ல சோதனை முறை (ChatGPT சொன்ன E1-E16)', 'பிரச்சனைகள் - தீர்வுகள்'])) + '</section>');
  // ---------------------------------------------------------------- overview
  pages.push(page('மூன்று படிகள் - அவ்வளவுதான்', p('Page-ஐத் திறந்ததும் "Your rules" card. மேலிருந்து கீழாக:') +
    list(['**1 · Start from a ready setup** - தயாரான setup-ஐத் தேர்ந்தெடுங்கள் ("Use this").',
      '**2 · The basics** - timeframe, pattern, stop, target, trail, account, risk, test period. இவை எப்போதும் கண் முன்.',
      '**3 · More rules (optional)** - மற்ற எல்லா விதிகளும் மடித்து வைக்கப்பட்டுள்ளன. தேவைப்பட்டால் மட்டும் திறங்கள்.',
      'கீழே **In plain words** பெட்டியைப் படித்து, **▶ Run on my laptop** அழுத்துங்கள்.'], true) +
    img('01-start', 'Your rules - மேலே ready setups, நடுவில் basics, கீழே மடித்த "More rules" மற்றும் Run.', 'tall'), 1));
  // ---------------------------------------------------------------- step 1
  pages.push(page('படி 1 - Ready setup', img('02-ready', '"In use" = இப்போதைய விதிகள் இந்த setup-உடன் பொருந்துகின்றன.') +
    table(['Setup', 'என்ன செய்யும்'], [
      ['**My CHoCH + FVG setup**', 'உங்கள் SMC setup: lower highs / lower lows-க்குப் பின் CHoCH; அந்த move-இன் discount பாதியில் உள்ள zone-க்கு விலை முதல் முறை திரும்பும்போது zone top-இல் order; stop zone-க்குக் கீழ். இதுவே **baseline** (E1).'],
      ['**FVG + Spring**', '3-candle FVG zone மேல் Spring candle; Spring candle close-இல் வாங்குதல்; stop zone-க்குக் கீழ்.'],
      ['**Gap-up FVG + Spring**', 'அதே, Gap-up zone மேல்.']]) +
    p('"Use this" setup-இன் விதிகளை மட்டும் நிரப்பும்; உங்கள் account, risk போன்றவை அப்படியே இருக்கும். பிறகு எதையும் மாற்றலாம்.'), 2));
  // ---------------------------------------------------------------- step 2
  pages.push(page('படி 2 - The basics', img('03-basics', 'எப்போதும் கண் முன் இருக்கும் அடிப்படை விதிகள்.') +
    table(['Box', 'பொருள்'], [
      ['Timeframe', 'Daily / Weekly / 4 hour (4 hour = அன்றைய 13:15 candle).'],
      ['Pattern', 'எந்த signals சோதிக்கப்படும் (FVG+Spring, Gap-up FVG + Spring, First touch of a zone = SMC entry, Every Spring ...).'],
      ['Stop loss + How far below it (%)', 'Stop எங்கே: zone bottom / Spring candle low / இரண்டில் கீழானது / entry-இலிருந்து %. "0.5" = அதற்கு 0.5% கீழே.'],
      ['Target (R)', '**R = entry - stop** (ஒரு trade-இன் risk). 2 = risk-இன் இரண்டு மடங்கு லாபத்தில் target.'],
      ['At the target', '**Keep the trade and trail the stop** = target-க்குப் பின் trade-ஐ வைத்து stop-ஐ மேலே நகர்த்தும் (பெரிய move-ஐப் பிடிக்க). **Sell at the target** = அங்கேயே விற்கும்.'],
      ['Then', 'Trail முறை: கடைசி N candles-இன் lowest low-க்குக் கீழ் / உச்ச விலையிலிருந்து X% / EMA-க்குக் கீழ் close / **x ATR** / **புதிய swing low-க்குக் கீழ்** / trail இல்லை.'],
      ['Account ₹ / Risk per trade', 'உங்கள் கணக்கு எவ்வளவு, ஒரு trade-இல் கணக்கின் எத்தனை % risk.'],
      ['Test period from', 'உதா. 2020-01-01: அதற்கு முன் = **development** (விதிகளைத் தேர்ந்தெடுக்க), அதிலிருந்து = **test** (சரிபார்க்க மட்டும்). கீழே "Development vs test" பக்கத்தைப் பாருங்கள்.']]), 3));
  // ---------------------------------------------------------------- step 3: more rules
  pages.push(page('படி 3 - More rules (விருப்பம்)', img('04-more', 'மடித்த பகுதிகள். ஒன்றை மாற்றினால் "1 changed" என்று காட்டும்.') +
    table(['பகுதி', 'அதில் என்ன'], [
      ['Market structure - CHoCH / BOS', 'CHoCH விதிகள், discount, swing கண்டுபிடிக்கும் முறை, CHoCH candle-இன் வலிமை (அடுத்த பக்கம்).'],
      ['Spring candle shape', 'Spring candle-க்குக் கடுமையான விதிகள் (wick, body, dip). என் 5 பரிந்துரைகள் "Use this" உடன்.'],
      ['Trend filters', 'Signal candle EMA support / மேலே close; stock-இன் **weekly trend**; NIFTY போன்ற index-இன் நிலை.'],
      ['Entry details', 'Close-இல் / அடுத்த open-இல் / **zone top order**; அதிகபட்ச risk %; zone-க்குள் எவ்வளவு ஆழம்; தேதிகள்; குறைந்த விலை / turnover.'],
      ['Exit details', 'Target = கடைசி swing high; அதிகபட்ச நாட்கள்; costs (buy + sell சேர்த்து); target-இல் stop-ஐ entry-க்கு நகர்த்துதல்.'],
      ['Money details', 'ஒரு position அதிகபட்சம் %, ஒரே நேரத்தில் எத்தனை trades, லாபத்தை மீண்டும் முதலீடு.'],
      ['Checking the result', '**Validation part from** (3 பகுதி சோதனை) மற்றும் **Steady over time?** (ஒவ்வொரு N வருடத் தொகுதி).']]) +
    p('**"Clear all the More rules"** = எல்லா விருப்ப விதிகளையும் default-க்குத் திருப்பும் (basics அப்படியே). ஒரு பகுதியைத் திறந்தால் அடுத்த முறையும் திறந்தே இருக்கும்.'), 4));
  pages.push(page('Market structure பகுதி', img('05-structure', 'Market structure - "Only my setup" தேர்ந்தெடுத்தால் எல்லா விதிகளும் தெரியும்.', 'tall') +
    table(['Box', 'பொருள்'], [
      ['Market structure', '**Off** = பார்க்காது. **Show** = ஒவ்வொரு trade-க்கும் label மட்டும் (எதையும் விலக்காது - ஒப்பிட). **Only my setup** = கீழே உள்ள விதிகள்.'],
      ['A swing high / low · Lower highs and lower lows', 'Swing = இருபுறமும் N candles. CHoCH-க்கு முன் குறைந்தது இத்தனை lower highs / lows.'],
      ['The zone formed · The signal came', 'Zone எப்போது உருவானது (CHoCH move-இல் / பின்); CHoCH-க்குப் பின் எத்தனை candles-க்குள் signal.'],
      ['Discount: the zone at least · judged on', 'Move-இன் எவ்வளவு கீழே zone இருக்க வேண்டும் (50% = பாதி; 65 / 70 / 75% புதியவை), zone-இன் நடுப்பகுதி / top / bottom வைத்து.'],
      ['Swings · stand out by · The CHoCH closes · Equal highs / lows', 'Swing / CHoCH கண்டுபிடிக்கும் **மாற்று வழிகள்** (E2, E3, E5): ZigZag, x ATR உயரம், protected high, சம highs. "the usual" = இப்போதைய baseline.'],
      ['The zone at most · Days after the CHoCH', 'Zone மிக ஆழமாக இருக்கக் கூடாது (உதா. 90%); CHoCH-க்குப் பின் குறைந்தது N நாட்கள்.'],
      ['The CHoCH candle (displacement) · its volume · sweep', 'CHoCH candle-இன் body ≥ x ATR; volume ≥ x சராசரி; final low முந்தைய low-ஐ sweep செய்து மேலே close.']]), 5));
  // ---------------------------------------------------------------- run
  pages.push(page('Run - laptop-இல் ஓட்டுதல்', img('06-plain', '"In plain words" - ஓட்டும் முன் இதைப் படியுங்கள்: நீங்கள் நினைத்த விதிதானா?') +
    img('06b-actions', 'பெயர், Run, TradingView script, preset சேமிப்பு, default-க்குத் திரும்புதல்.') +
    img('07-status', 'Laptop நிலை மற்றும் run நிலை.') +
    list(['**laptop: online** = laptop கேட்டுக்கொண்டிருக்கிறது. "last asked … is it on?" = laptop off அல்லது program நின்றுவிட்டது.',
      '**waiting for your laptop** → **running** (progress bar) → முடிந்ததும் முடிவு கீழே தானாகத் திறக்கும்.',
      '**Cancel** = காத்திருப்பதை நிறுத்தும். ஒரு நேரத்தில் ஒரு run மட்டும்.',
      '**Save as a preset** = இந்த விதிகளுக்குப் பெயர் வைத்து சேமிக்கும்; **Load a preset** மூலம் திரும்பப் பெறலாம்.']), 6));
  // ---------------------------------------------------------------- result
  pages.push(page('முடிவு - முதலில் பதில்', img('08b-head', 'Run-இன் பெயர், எப்போது, எந்த காலம்; "Use these rules" = அதன் விதிகளை form-இல் போடும்.') +
    img('08-verdict', 'Verdict card: edge உண்மையா, test பகுதி ஒத்துப்போகிறதா, கணக்கு என்ன ஆனது.') +
    table(['Badge', 'பொருள்'], [
      ['**An edge** (பச்சை)', 'சராசரி R-இன் சாத்தியமான வரம்பு (90%) முழுவதும் 0-க்கு மேல் - அதிர்ஷ்டம் அல்ல (இந்த காலத்தில்).'],
      ['**Could be chance**', 'வரம்பு 0-ஐத் தாண்டுகிறது - சராசரி லாபம் அதிர்ஷ்டமாகவும் இருக்கலாம்.'],
      ['**Losing** (சிவப்பு)', 'வரம்பு முழுவதும் 0-க்குக் கீழ் - இந்த விதி நஷ்டம்.'],
      ['**Too few trades**', '30-க்குக் குறைவான trades - சொல்ல முடியாது. 300+ trades இருந்தால் நம்பிக்கை அதிகம்.']]) +
    p('**R**: −1R = முழு stop loss; +2R = risk-இன் இரண்டு மடங்கு லாபம். "Average per trade" தான் உங்கள் **edge**.'), 7));
  pages.push(page('Development vs test', img('09-split', 'Test period கொடுத்தால் இந்த table வரும் (validation date-உம் கொடுத்தால் 3 வரிசை).') +
    list(['விதிகளைத் தேர்ந்தெடுக்கும்போது **Development** வரிசையை மட்டும் பாருங்கள்.',
      'முடிவு செய்த பிறகு **Test** வரிசையைப் பாருங்கள்: அதுவும் லாபம் என்றால் "agrees". இல்லையென்றால் விதி கடந்த காலத்துக்கு மட்டும் பொருந்தியிருக்கலாம்.',
      'Test பகுதியைப் பார்த்து விதிகளை மாற்றிக்கொண்டே இருந்தால் அதுவும் development ஆகிவிடும் - அதனால் தான் **Validation** (3-வது பகுதி): development-இல் தேர்வு, validation-இல் சரிபார்ப்பு, test-ஐ கடைசியில் ஒரு முறை.',
      'உதா. Validation part from 2018-01-01, Test period from 2022-01-01.']), 8));
  pages.push(page('What worked best - ஒரு நேரத்தில் ஒரு அம்சம்', img('10-bd', 'Chips: Zone depth, Lower highs / lows, Days from CHoCH, Into the zone, Zone kind, Touch, Risk %, Turnover.') +
    table(['Column', 'பொருள்'], [
      ['Avg R · Likely range', 'அந்தக் குழுவின் சராசரி R மற்றும் அதன் 90% வரம்பு.'],
      ['vs the rest', '**Better / Worse** = மீதி trades-ஐ விட தெளிவாக நல்லது / மோசம். **Could be chance** = வித்தியாசம் அதிர்ஷ்டத்துக்குள். **Too few** = 30-க்குக் குறைவு.'],
      ['Development / Test', 'அதே குழு ஒவ்வொரு பகுதியிலும் (test period கொடுத்தால்).'],
      ['Held in test', '**Yes** = development-இலும் test-இலும் ஒரே திசை - இவற்றையே அதிகம் நம்புங்கள்.']]) +
    p('உதா. "Zone depth 78.6 - 90%" **Better** மற்றும் **Held = Yes** என்றால்: More rules › Market structure-இல் Discount 0.786, "The zone at most" 90% வைத்து மீண்டும் ஓட்டி ஒப்பிடுங்கள்.') +
    p('Zone depth, Lower highs / lows, Days from CHoCH - இவை Market structure "Show" அல்லது "Only" இருந்தால் மட்டும் வரும்.'), 9));
  pages.push(page('மற்ற பகுதிகள் (மடித்தவை)', img('15-account', 'Your account - திறந்ததும் கணக்கு வளைகோடு தெரியும்.') +
    table(['பகுதி', 'என்ன'], [
      ['Every signal - all the figures', 'எல்லா எண்களும்: win rate, profit factor, target அடைந்த %, சராசரி லாபம் / நஷ்டம், எத்தனை signals ஏன் விலக்கப்பட்டன.'],
      ['By market structure', 'Signal எங்கே இருந்தது (discount / premium / BOS-க்குப் பின் / CHoCH இல்லை) - ஒவ்வொன்றின் சராசரி R.'],
      ['Your account', 'ரூபாயில்: இப்போதைய கணக்கு, return, அதிகபட்ச வீழ்ச்சி (drawdown), எடுக்காத trades ஏன் (கீழே trades table-இல் "skipped" மேல் cursor).'],
      ['How the trades ended', 'Stop / target / trailing stop / நேரம் - எத்தனை; ஒவ்வொரு trade-இன் R பரவல்.'],
      ['Year by year - steady over time?', 'வருட வாரியாக, மற்றும் ஒவ்வொரு 3 வருடத் தொகுதியின் சராசரி R. உண்மையான edge பெரும்பாலான தொகுதிகளில் தெரியும்.']]), 10));
  pages.push(page('Trades table மற்றும் Charts PDF', img('12-trades', 'ஒவ்வொரு trade-உம்: entry, stop, target, exit, ஏன் விற்றது, R, structure.') +
    list(['**Structure** badge மேல் cursor = CHoCH நிலை, தேதி, final low, move high, zone எவ்வளவு கீழே.',
      '**In the account: skipped** மேல் cursor = ஏன் கணக்கில் எடுக்கவில்லை.',
      '**TradingView ↗** = அந்த stock-இன் chart; Alt+G அழுத்தி signal தேதியைத் தட்டுங்கள்.',
      '**⇅ Sort & filter**, **▦ Columns**, CSV - table-ஐ வரிசைப்படுத்த / வடிகட்ட / பதிவிறக்க.',
      '**Charts PDF**: ஒவ்வொரு run-உடனும் laptop-இல் ஒரு PDF - ஒவ்வொரு trade-க்கும் 2 பக்கங்கள்: 1 = chart (HH / HL / LH / LL, CHoCH, BOS, zone, BUY - candle மேல் எழுத்து இல்லை), 2 = ஏன் இந்த trade, எப்படி முடிந்தது (stop loss-க்குக் காரணங்கள்) - எளிய வாக்கியங்களில், chart இல்லாமல். நஷ்டமானவை முதலில். இடம்: ScreenerBridge folder → `lab_charts`.']), 11));
  pages.push(page('Runs ஒப்பீடு மற்றும் TradingView script', img('14-runs', 'Your runs - ஒரே table-இல் ஒப்பிட. ஒரு வரிசையை click செய்தால் அந்த முடிவு திறக்கும்.') +
    p('ஒரு நேரத்தில் **ஒரே ஒரு** மாற்றம் செய்து ஓட்டுங்கள்; வரிசைகளை ஒப்பிடுங்கள். வரம்பு 0-க்கு மேல் + test பகுதி ஒத்துப்போனால் அந்த வரிசையை அதிகம் நம்பலாம். கடைசி 8 runs sheet-இல் (Backtest_Lab tab) வைக்கப்படும்.') +
    img('11-pine', '"Copy TradingView script" - இதே விதிகளுடன் indicator. TradingView → Pine Editor → Ctrl+A → Ctrl+V → Save → Add to chart.') +
    p('Swings / CHoCH மாற்று வழிகளும் (ZigZag, x ATR, protected high, சம highs) script-இல் வரையப்படும். வரையாத விதிகள் (உதா. weekly trend, sweep) பெட்டியில் சொல்லப்படும் - அவற்றை chart-இல் நீங்களே பாருங்கள்.'), 12));
  // ---------------------------------------------------------------- testing routine
  pages.push(page('ஒரு நல்ல சோதனை முறை (E1 - E16)', list([
    '**Baseline (E1)**: "My CHoCH + FVG setup" → Test period from 2020-01-01 → Run → **Save as a preset** "Baseline E1".',
    'ஒரு நேரத்தில் **ஒரே மாற்றம்** → Run → runs table-இல் baseline-உடன் ஒப்பிடுங்கள்.',
    'நம்பும் முன்: 300+ trades · "An edge" · test பகுதி agrees · steady over time-இல் பெரும்பாலான தொகுதிகள் லாபம் · Charts PDF-இல் சில trades-ஐக் கண்ணால் பாருங்கள்.',
    'பிடித்த விதியை தினசரி scan-க்கும்: laptop-இல் `ChochRules.bat` (அதே swing / lower highs / discount).'], true) +
    table(['சோதனை', 'எங்கே மாற்றுவது'], [
      ['E2 swing x ATR உயரம்', 'More rules › Market structure › "A swing must stand out by"'],
      ['E3 ZigZag', '… › Swings → ZigZag, "… a turn of"'],
      ['E4 swing 2 / 5 / 10', '… › "A swing high / low"'],
      ['E5 protected CHoCH · equal highs · sweep', '… › "The CHoCH closes" · "Equal highs / lows" · sweep box'],
      ['E6 - E8 depth 65 / 70 / 75%', '… › "Discount: the zone at least"'],
      ['E9 zone top / middle மட்டும்', 'More rules › Entry details › "How deep …" (Buy = close-இல்)'],
      ['E10 displacement + volume', '… › Market structure › "The CHoCH candle" · "its volume"'],
      ['E11 weekly trend', 'More rules › Trend filters › "Its last finished weekly close"'],
      ['E12 - E14 2R / 2.5R / 3R', 'The basics › Target'],
      ['E15 ATR trail', 'The basics › Then → "x ATR under the highest price"'],
      ['E16 structure trail', 'The basics › Then → "Under the newest swing low"'],
      ['Validation + walk-forward', 'More rules › Checking › Validation part from · Steady over time']]), 13));
  // ---------------------------------------------------------------- troubleshooting
  pages.push(page('பிரச்சனைகள் - தீர்வுகள்', table(['காட்டுவது', 'என்ன செய்வது'], [
    ['laptop: not seen yet / "last asked … is it on?"', 'Laptop-ஐ on செய்யுங்கள்; ScreenerBridge ஓடவில்லை என்றால் `RunNow.bat` அல்லது Windows restart.'],
    ['"preparing the candles … N of M stocks"', 'Update-க்குப் பின் ஒரு முறை மட்டும். காத்திருங்கள் - உங்கள் run அதற்குப் பின் உடனே ஓடும்.'],
    ['"a backtest is still running on your laptop"', 'அது முடியும் வரை காத்திருங்கள், அல்லது Cancel அழுத்தி உங்களுடையதை ஓட்டுங்கள்.'],
    ['"No trade matched these rules"', 'விதிகள் மிகக் கடுமை: "Clear all the More rules" அல்லது ஒரு விதியை மட்டும் தளர்த்துங்கள்.'],
    ['"Too few trades"', 'பெரிய pattern group, Daily timeframe, குறைந்த விதிகள், நீண்ட காலம்.'],
    ['PIN மீண்டும் கேட்கிறது', 'My Watchlists → Sync with my sheet → PIN. 5 தவறான PIN = 15 நிமிட lock.'],
    ['Charts PDF note வரவில்லை', 'config.json-இல் "lab_charts": false இல்லையா பாருங்கள்; ScreenerBridge\\lab_charts folder.'],
    ['சில trades "skipped"', 'Money details-இல் "One position at most" / "Trades open at once" உயர்த்துங்கள் (cursor-இல் காரணம்).']]) +
    box('நினைவில் வைக்க', list(['Backtest = கடந்த காலம். எதிர்காலத்துக்கு உத்தரவாதம் இல்லை.', 'ஒரு நேரத்தில் ஒரு மாற்றம்; test பகுதியை கடைசியில் மட்டும் பாருங்கள்.',
      'இது research மட்டும் - buy recommendation அல்ல.'])), 14));
  return '<!doctype html><html lang="ta"><head><meta charset="utf-8"><title>Backtest Lab - பயன்படுத்தும் வழிகாட்டி</title><style>' + CSS + '</style></head><body>' +
    pages.join('') + '</body></html>';
}

const CSS = `
@page { size: A4; margin: 14mm 13mm 16mm; }
* { box-sizing: border-box; }
body { font-family: 'FreeSans', 'Noto Sans Tamil', 'Latha', 'Nirmala UI', sans-serif; color: #1c2430; font-size: 12.2px; line-height: 1.62; margin: 0; }
.page { page-break-after: always; }
.page:last-child { page-break-after: auto; }
h1 { font-size: 34px; line-height: 1.25; margin: 24mm 0 8mm; color: #1f3a8a; }
h1 span { font-size: 24px; color: #334155; }
h2 { font-size: 19px; margin: 0 0 4mm; color: #1f3a8a; border-bottom: 2px solid #c7d2fe; padding-bottom: 2mm; }
h2 .num { display: inline-block; min-width: 26px; height: 26px; line-height: 26px; text-align: center; border-radius: 50%; background: #4f46e5; color: #fff; font-size: 13px; margin-right: 8px; vertical-align: 2px; }
h3 { font-size: 14px; margin: 0 0 2mm; color: #312e81; }
.brand { font-size: 13px; letter-spacing: 0.08em; text-transform: uppercase; color: #6366f1; font-weight: 700; margin-top: 10mm; }
.lead { font-size: 15px; color: #334155; margin-bottom: 8mm; }
.box { border: 1px solid #c7d2fe; background: #eef2ff; border-radius: 8px; padding: 3.5mm 4.5mm; margin: 0 0 4mm; }
p { margin: 0 0 2.5mm; }
ul, ol { margin: 0 0 3mm; padding-left: 6mm; }
li { margin: 0 0 1.4mm; }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 11px; background: #f1f5f9; padding: 0 3px; border-radius: 3px; }
table { width: 100%; border-collapse: collapse; margin: 0 0 3.5mm; font-size: 11.6px; }
th, td { border: 1px solid #d5dbe5; padding: 1.6mm 2.2mm; text-align: left; vertical-align: top; }
th { background: #f1f5f9; color: #1e293b; }
td:first-child { width: 34%; }
figure { margin: 0 0 3.5mm; border: 1px solid #d5dbe5; border-radius: 6px; padding: 2mm; background: #fafbff; page-break-inside: avoid; }
figure img { display: block; max-width: 100%; max-height: 105mm; margin: 0 auto; object-fit: contain; }
figure.tall img { max-height: 165mm; }
figcaption { font-size: 11px; color: #475569; margin-top: 1.5mm; text-align: center; }
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  if (process.argv.indexOf('--no-shots') < 0) shots();
  const file = path.join(OUT, NAME + '.html');
  fs.writeFileSync(file, html());
  const { chromium } = playwright();
  const browser = await chromium.launch(chromiumPath() ? { executablePath: chromiumPath() } : {});
  const pg = await browser.newPage();
  await pg.goto('file://' + file, { waitUntil: 'load' });
  await pg.evaluate(() => document.fonts.ready);
  const pdf = path.join(OUT, NAME + '.pdf');
  await pg.pdf({ path: pdf, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '16mm', left: '13mm', right: '13mm' },
    displayHeaderFooter: true, headerTemplate: '<span></span>',
    footerTemplate: '<div style="font-size:8px;width:100%;text-align:center;color:#94a3b8;font-family:sans-serif">Backtest Lab guide · <span class="pageNumber"></span> / <span class="totalPages"></span></div>' });
  await browser.close();
  fs.mkdirSync(path.dirname(WEB_COPY), { recursive: true });
  fs.copyFileSync(pdf, WEB_COPY);
  console.log('Backtest Lab guide: ' + path.relative(ROOT, pdf) + ' (' + Math.round(fs.statSync(pdf).size / 1024) + ' KB) + ' + path.relative(ROOT, WEB_COPY));
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
module.exports = { html };
