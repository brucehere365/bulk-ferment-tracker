/* node ui.tests.js — drives the real app.js in a real DOM.
 *
 * Needs jsdom, which is the only dev dependency and is not part of the site:
 *
 *     npm install jsdom
 *     node ui.tests.js
 *
 * Nothing here stubs the app. It clicks the actual buttons, reads the actual
 * DOM and inspects the actual localStorage, including a full page reload. */
'use strict';
var fs = require('fs'), path = require('path');
var JSDOM;
try { JSDOM = require('jsdom').JSDOM; }
catch (e) {
  console.error('These tests need jsdom:  npm install jsdom');
  process.exit(2);
}
var DIR = __dirname;

var pass = 0, fail = 0, failures = [];
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; failures.push(name); console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function head(s) { console.log('\n' + s + '\n' + '-'.repeat(s.length)); }

/* A window with a clock we can push forward. The app owns no timers of its own
 * — every number is rebuilt from stored timestamps against `Date.now()` — so
 * moving that one function is the whole of "eight hours later". */
function boot(seed, offsetMs) {
  var d = new JSDOM(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8'), {
    runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/'
  });
  var win = d.window;
  win.matchMedia = win.matchMedia || function () { return { matches: false, addListener: function () {}, removeListener: function () {} }; };
  win.navigator.vibrate = function () {};
  win.AudioContext = function () { this.state = 'running'; this.currentTime = 0;
    this.createOscillator = function () { return { frequency: {}, connect: function () {}, start: function () {}, stop: function () {} }; };
    this.createGain = function () { return { gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} }, connect: function () {} }; };
    this.destination = {}; this.resume = function () {}; };
  win.URL.createObjectURL = function () { return 'blob:x'; };
  win.URL.revokeObjectURL = function () {};
  var real = win.Date.now;
  win.offset = offsetMs || 0;
  win.Date.now = function () { return real() + win.offset; };
  if (seed) win.localStorage.setItem('bft.v1', seed);
  ['model.js', 'app.js'].forEach(function (f) {
    win.eval(fs.readFileSync(path.join(DIR, f), 'utf8'));
  });
  return win;
}

var w = boot(null, 0);

var downloads = [];
var origClick = w.HTMLElement.prototype.click;
w.HTMLElement.prototype.click = function () {
  if (this.tagName === 'A' && this.download) { downloads.push({ name: this.download }); return; }
  return origClick.apply(this, arguments);
};

var doc = w.document;
function $(sel, root) { return (root || doc).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
function act(a, root) { return $('[data-act="' + a + '"]', root); }
function click(el) {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
function clickAct(a, root) { click(act(a, root)); }
function key(k) { click($('[data-key="' + k + '"]', sheet())); }
function sheet() { return $('#sheet-root .sheet'); }
function text() { return doc.getElementById('app').textContent; }
function toastText() { return doc.getElementById('toast').textContent; }
function stored() { return JSON.parse(w.localStorage.getItem('bft.v1')); }
function bake() { var s = stored(); return s.bakes.filter(function (b) { return b.id === s.activeId; })[0]; }
function setInput(el, v) {
  el.value = v;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}
/* Hours later. Nothing about the bake is touched — only the clock the app
 * reads — which is the point: a slept phone is exactly this. */
function advance(hours) {
  w.offset += hours * 3600000;
  w.dispatchEvent(new w.Event('pageshow'));
}
function preshapeAt(s) { var m = /Preshape at\s*(\d\d:\d\d)/.exec(s); return m && m[1]; }

head('BOOT');
ok('lands straight on the bulk ferment form', !!$('#startform'));
ok('there is no mode picker left to choose from', !act('mode-bulk') && !act('mode-full') && !act('mode-plan'));
ok('and nowhere else for the app to be', !act('templates') && !act('loaves'));
/* Booting with nothing must not write anything: the old unconditional boot
 * save is what turned an unreadable payload into a permanently blank one. */
ok('a boot with no data writes nothing at all', w.localStorage.getItem('bft.v1') === null);
ok('restore is reachable from the empty screen', !!act('storage'));

head('DECIMALS — a comma is a full stop');
ok('the first-temperature field is not a type=number', $('#startform').elements.temp.type === 'text');
ok('but still opens the decimal keyboard', $('#startform').elements.temp.getAttribute('inputmode') === 'decimal');
var sf = $('#startform');
setInput(sf.elements.name, 'Comma bake');
setInput(sf.elements.temp, '23,5');
sf.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok('a comma starts the bake', !!preshapeAt(text()));
ok('and is read as 23.5, not 23', bake().readings[0].temp === 23.5, String(bake().readings[0].temp));

head('THE ZOOM FIX IS IN THE STYLESHEET');
var css = fs.readFileSync(path.join(DIR, 'styles.css'), 'utf8');
ok('taps on controls do not double-tap-zoom', /touch-action:\s*manipulation/.test(css));
ok('the keypad keys are covered by name', /\[data-key\][^{}]*\{[^}]*touch-action:\s*manipulation/.test(css));
ok('and a stray tap selects nothing', /\[data-key\][^{}]*\{[^}]*user-select:\s*none/.test(css));
ok('no field is small enough to make Safari zoom to reach it',
  /input,\s*textarea,\s*select\s*\{\s*font-size:\s*max\(16px/.test(css));
ok('and no rule sneaks a sub-16px field back in',
  !/font-size:\s*1[0-5](\.\d+)?px/.test(css.replace(/[^\n]*font:[^\n]*\n/g, '')) ||
  !/label\.field (input|textarea)[^{]*\{[^}]*font-size:\s*1[0-5]px/.test(css));

head('LIVE VIEW');
ok('the hero says when to preshape', !!preshapeAt(text()));
ok('the chart is drawn', !!$('.chartwrap svg'));
ok('the readings list has the first reading', $$('.reading').length === 1);
ok('progress, dough temp, target and expected rise are all on screen',
  /Progress/.test(text()) && /Dough temp/.test(text()) && /Target rise/.test(text()) && /Expected rise now/.test(text()));
ok('the cue list is instructions, with nothing to tick',
  /Domed, not flat/.test(text()) && $$('.cues input').length === 0);
ok('the nav pill is down to two destinations', $$('.navpill button').length === 2);

head('LOGGING A TEMPERATURE THROUGH THE KEYPAD');
advance(1);
clickAct('logtemp');
ok('the number sheet opens on the last reading', !!$('#numval', sheet()));
key('2'); key('4'); key('.'); key('5');
ok('the keypad builds the number', $('#numval', sheet()).value === '24.5');
key('del');
ok('delete takes the last character off', $('#numval', sheet()).value === '24.');
key('5');
clickAct('save', sheet());
ok('the reading is stored', bake().readings.length === 2 && bake().readings[1].temp === 24.5);
ok('and the list shows it', $$('.reading').length === 2);

head('A COMMA TYPED ON THE PHONE KEYBOARD');
advance(1);
clickAct('logtemp');
setInput($('#numval', sheet()), '21,5');
ok('becomes a full stop as it lands', $('#numval', sheet()).value === '21.5');
clickAct('save', sheet());
ok('and is saved as 21.5', bake().readings[2].temp === 21.5, String(bake().readings[2].temp));

head('THE UNATTENDED GAP');
advance(3);
clickAct('logtemp');
ok('a three-hour gap is asked about before anything is logged', /It has been 3h/.test(sheet().textContent));
click($('[data-gap="cooler"]', sheet()));
ok('saying it was cooler asks how cool', !$('#gapinterim', sheet()).hidden);
setInput($('#gaptemp', sheet()), '19,5');
clickAct('gapsave', sheet());
setInput($('#numval', sheet()), '20');
clickAct('save', sheet());
ok('the gap temperature is stored, comma and all', bake().readings[3].gapTemp === 19.5, String(bake().readings[3].gapTemp));
ok('and the reading says the gap was held', /gap held at 19\.5/.test(text()));

head('EDITING A READING REPLAYS, IT DOES NOT PATCH');
var endBefore = preshapeAt(text());
var second = bake().readings[1];
click($('[data-act="edit"][data-id="' + second.id + '"]'));
ok('the edit sheet is populated', $('#e-temp', sheet()).value === '24.5');
ok('the temp field takes a comma too', $('#e-temp', sheet()).type === 'text');
setInput($('#e-temp', sheet()), '27,5');
clickAct('esave', sheet());
ok('the edit is stored as a number', bake().readings[1].temp === 27.5, String(bake().readings[1].temp));
ok('it recalculated from the first reading', /Recalculated from the first reading/.test(toastText()));
ok('and the projection moved', preshapeAt(text()) !== endBefore);

head('CALIBRATION FROM THE JAR');
advance(1);
clickAct('lograise');
setInput($('#numval', sheet()), '55');
clickAct('save', sheet());
ok('a jar reading is stored', bake().readings.slice(-1)[0].rise === 55);
ok('and the app says what it learned in words',
  /Tracking the table\.|Running about \d+% (faster|slower) than the table\./.test(text()));
ok('resetting calibration is offered once there is a jar reading', !!act('resetcal'));
clickAct('resetcal');
clickAct('yes', sheet());
ok('reset leaves the readings alone', bake().readings.filter(function (r) { return r.rise != null; }).length === 1);
ok('but stops them steering the projection',
  bake().readings.filter(function (r) { return r.ignoreCal; }).length === 1);

head('NOTHING IS DERIVED FROM A RUNNING TIMER');
var beforeReload = text();
var saved = w.localStorage.getItem('bft.v1');
var w2 = boot(saved, w.offset);
var t2 = w2.document.getElementById('app').textContent;
ok('a reload lands straight back in the running bulk', !!preshapeAt(t2));
ok('with the same readings', (t2.match(/Edit/g) || []).length === (beforeReload.match(/Edit/g) || []).length);
ok('and the same projection', preshapeAt(t2) === preshapeAt(beforeReload));
ok('the bake survived the reload', JSON.parse(w2.localStorage.getItem('bft.v1')).bakes.length === 1);

head('MENU AND SETTINGS');
clickAct('menu');
ok('the menu is a sheet', !!sheet());
ok('alarm, notification and wake lock are all switchable',
  !!act('t-sound', sheet()) && !!act('t-notify', sheet()) && !!act('t-wake', sheet()));
ok('night has explicit day and night pins', $$('[data-act="night"]', sheet()).length === 3);
click($('[data-act="night"][data-id="on"]', sheet()));
ok('pinning night re-points the tokens and nothing else',
  doc.documentElement.classList.contains('night'));
click($('[data-act="night"][data-id="off"]', sheet()));
ok('and day pins it back', !doc.documentElement.classList.contains('night'));
setInput($('#lead', sheet()), '20');
ok('the lead time is stored', stored().settings.leadMin === 20);
clickAct('t-jar', sheet());
ok('turning the jar off hides the rise button', !act('lograise'));
ok('and offers a one-off instead', !!act('lograise-once', sheet()));

head('FINISHING AND HISTORY');
clickAct('finish', sheet());
ok('finishing lands in history', /History/.test(text()));
ok('with nothing active', stored().activeId === null);
ok('the finished bulk is listed', /Comma bake/.test(text()));
ok('finishing opens the card straight away', !act('openbake') && !!act('closebake'));
ok('an opened bake shows its chart', !!$('.chartwrap svg'));
var crumb = $('[data-act="crumb"]');
setInput(crumb, 'Open even crumb.');
ok('the crumb note is saved', stored().bakes[0].crumb === 'Open even crumb.');
clickAct('csv');
ok('readings export as CSV', downloads.some(function (d) { return /^bulk-ferment-.*\.csv$/.test(d.name); }));
ok('there is no stage export left to offer', !act('csv-stages'));
clickAct('back');
ok('back with nothing running goes to the start form', !!$('#startform'));

head('DELETING');
clickAct('history');
clickAct('openbake');
clickAct('delbake');
clickAct('yes', sheet());
ok('a deleted bake is gone', stored().bakes.length === 0);
ok('and history says so', /No finished bakes yet/.test(text()));

head('MIGRATION FROM v2');
var v2 = JSON.stringify({
  version: 2, activeId: 'b1', activeProcessId: 'p1',
  bakes: [{ id: 'b1', name: 'Old bulk', startedAt: Date.now() - 3600000, status: 'active',
    readings: [{ id: 'r1', t: Date.now() - 3600000, temp: 24, rise: null, gapTemp: null }],
    alerts: { lead: null, end: null }, crumb: '', finalCal: 1, useJar: true }],
  templates: [{ id: 't1', name: 'Bruce\'s Loaf', stages: [] }],
  processes: [{ id: 'p1', name: 'Old bake', events: [] }],
  draft: { params: {} },
  settings: { leadMin: 45, sound: false, notify: false, wakeLock: true, useJar: true, night: 'auto' }
});
var w3 = boot(v2, 0);
var s3 = JSON.parse(w3.localStorage.getItem('bft.v1'));
ok('the old bulk ferment is untouched', s3.bakes.length === 1 && s3.bakes[0].readings.length === 1);
ok('it is what you land on', /Old bulk/.test(w3.document.getElementById('app').textContent));
ok('templates, processes and drafts are dropped',
  !('templates' in s3) && !('processes' in s3) && !('draft' in s3) && !('activeProcessId' in s3));
ok('settings carry over', s3.settings.leadMin === 45 && s3.settings.sound === false);
ok('and the version is bumped once', s3.version === 3);

/* ------------------------------------------------------------------------
 * Losing a bake is the failure this app is not allowed to have, so these
 * drive the ways it actually happened rather than asserting on the helpers. */

function goodState(name, readings) {
  var t = Date.now() - 3600000;
  return {
    version: 3, activeId: 'k1', savedAt: t, bakes: [{
      id: 'k1', name: name, startedAt: t, status: 'active',
      readings: (readings || [{ id: 'x1', t: t, temp: 24, rise: null, gapTemp: null }]),
      alerts: { lead: null, end: null }, crumb: '', finalCal: 1, useJar: true
    }],
    settings: { leadMin: 30, sound: true, notify: false, wakeLock: true, useJar: true, night: 'auto' }
  };
}

head('A CORRUPT PAYLOAD IS NEVER TURNED INTO A BLANK ONE');
var truncated = JSON.stringify(goodState('Half-written bake')).slice(0, 120);
var w4 = boot(truncated, 0);
ok('the app still starts', !!w4.document.querySelector('#startform'));
ok('the unreadable payload is kept, not dropped',
  w4.localStorage.getItem('bft.v1.corrupt') === truncated);
ok('and it is NOT overwritten with a blank state',
  w4.localStorage.getItem('bft.v1') === truncated,
  String(w4.localStorage.getItem('bft.v1')).slice(0, 40));

head('THE PREVIOUS COPY IS A REAL FALLBACK');
var w5 = boot(null, 0);
w5.localStorage.setItem('bft.v1', '{"bakes":[oops');
w5.localStorage.setItem('bft.v1.prev', JSON.stringify(goodState('Rescued bake')));
var w5b = boot(null, 0);
w5b.localStorage.setItem('bft.v1', '{"bakes":[oops');
w5b.localStorage.setItem('bft.v1.prev', JSON.stringify(goodState('Rescued bake')));
['model.js', 'app.js'].forEach(function (f) { w5b.eval(fs.readFileSync(path.join(DIR, f), 'utf8')); });
ok('a bake in the previous copy is recovered',
  /Rescued bake/.test(w5b.document.getElementById('app').textContent));
ok('and the app says it is running on a fallback',
  /would not load/.test(w5b.document.getElementById('toast').textContent));

head('EVERY SAVE LEAVES THE COPY IT REPLACED BEHIND');
var w6 = boot(JSON.stringify(goodState('Generation one')), 0);
var d6 = w6.document;
d6.querySelector('[data-act="logtemp"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
var num6 = d6.querySelector('#sheet-root .sheet #numval');
num6.value = '25';
num6.dispatchEvent(new w6.Event('input', { bubbles: true }));
d6.querySelector('#sheet-root .sheet [data-act="save"]').dispatchEvent(new w6.MouseEvent('click', { bubbles: true }));
var cur6 = JSON.parse(w6.localStorage.getItem('bft.v1'));
var prev6 = JSON.parse(w6.localStorage.getItem('bft.v1.prev'));
ok('the new reading is in the current copy', cur6.bakes[0].readings.length === 2);
ok('and the copy before it is still there', prev6 && prev6.bakes[0].readings.length === 1);

head('A BROWSER THAT REFUSES TO SAVE SAYS SO');
var w7 = boot(JSON.stringify(goodState('Doomed bake')), 0);
var d7 = w7.document;
/* Private Browsing on iOS throws here. It used to fail into a 2.6s toast and
 * then behave as though everything was fine.
 * Patched on Storage.prototype, not on the instance: jsdom's localStorage is a
 * Proxy whose set trap stores a *key* called "setItem" rather than overriding
 * the method, so an instance assignment silently does nothing. */
w7.Storage.prototype.setItem = function () { throw new Error('QuotaExceededError'); };
d7.querySelector('[data-act="logtemp"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
var num7 = d7.querySelector('#sheet-root .sheet #numval');
num7.value = '26';
num7.dispatchEvent(new w7.Event('input', { bubbles: true }));
d7.querySelector('#sheet-root .sheet [data-act="save"]').dispatchEvent(new w7.MouseEvent('click', { bubbles: true }));
ok('a failed write is reported, not swallowed',
  /blocking storage/.test(d7.getElementById('toast').textContent),
  JSON.stringify(d7.getElementById('toast').textContent));
ok('and it stays on screen rather than fading with the toast',
  /Not saving\./.test(d7.getElementById('app').textContent));
ok('the warning is a way through to the backup',
  d7.querySelector('.alarmbar').dataset.act === 'storage');

/* On the live view the sheet is behind the ••• menu; on the start screen it is
 * a button in its own right. Both routes matter, so both get walked. */
function openStorage(win, docu) {
  var el = docu.querySelector('[data-act="storage"]');
  if (!el) {
    docu.querySelector('[data-act="menu"]').dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    el = docu.querySelector('#sheet-root .sheet [data-act="storage"]');
  }
  el.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
  return docu.querySelector('#sheet-root .sheet');
}

head('BACKUP EXPORT');
var w8 = boot(JSON.stringify(goodState('Exportable bake')), 0);
var d8 = w8.document;
var dl8 = [];
var realClick8 = w8.HTMLElement.prototype.click;
w8.HTMLElement.prototype.click = function () {
  if (this.tagName === 'A' && this.download) { dl8.push(this.download); return; }
  return realClick8.apply(this, arguments);
};
var sheet8 = openStorage(w8, d8);
ok('the storage sheet says how many bakes are stored',
  /1 bake stored in this browser/.test(sheet8.textContent), JSON.stringify(sheet8.textContent.slice(0, 80)));
ok('and warns that bakes do not follow you to another URL',
  /different URL/.test(sheet8.textContent));
sheet8.querySelector('[data-act="backup-export"]').dispatchEvent(new w8.MouseEvent('click', { bubbles: true }));
ok('a backup downloads as JSON', dl8.some(function (n) { return /^trackmyloaf-backup-.*\.json$/.test(n); }),
  JSON.stringify(dl8));

head('RESTORE MERGES — IT NEVER DELETES WHAT IS ALREADY HERE');
/* Restoring onto a browser that already has bakes is the normal case after a
 * URL change, so a restore that replaced state would be its own data loss. */
var w9 = boot(JSON.stringify(goodState('Bake already here')), 0);
var d9 = w9.document;
var captured = null;
var realCreate = d9.createElement.bind(d9);
d9.createElement = function (tag) {
  var el = realCreate(tag);
  if (tag === 'input') captured = el;
  return el;
};
var sheet9 = openStorage(w9, d9);
sheet9.querySelector('[data-act="backup-import"]').dispatchEvent(new w9.MouseEvent('click', { bubbles: true }));

var incoming = goodState('Bake from the old URL');
incoming.bakes[0].id = 'k2';
incoming.activeId = 'k2';
var file = new w9.File([JSON.stringify({ app: 'trackmyloaf', version: 3, state: incoming })],
  'backup.json', { type: 'application/json' });
Object.defineProperty(captured, 'files', { value: [file] });
captured.dispatchEvent(new w9.Event('change'));

head('INSTALLABLE, AND OFFLINE BY DESIGN');
var html = fs.readFileSync(path.join(DIR, 'index.html'), 'utf8');
var manifest = JSON.parse(fs.readFileSync(path.join(DIR, 'manifest.webmanifest'), 'utf8'));
var swSrc = fs.readFileSync(path.join(DIR, 'sw.js'), 'utf8');

ok('the page links a manifest', /<link rel="manifest" href="manifest\.webmanifest">/.test(html));
ok('and an apple-touch-icon, which is the one iOS actually reads',
  /<link rel="apple-touch-icon" href="icon-180\.png">/.test(html));
ok('the service worker is registered after load, never blocking boot',
  /addEventListener\('load'[\s\S]*serviceWorker\.register\('sw\.js'\)/.test(html));
ok('and a failed registration cannot break the app', /register\('sw\.js'\)\.catch\(/.test(html));

ok('the manifest has what a browser needs to offer an install',
  manifest.name && manifest.short_name && manifest.start_url &&
  manifest.display === 'standalone' && manifest.icons.length >= 2);
ok('including both icon sizes Chrome requires',
  ['192x192', '512x512'].every(function (s) {
    return manifest.icons.some(function (i) { return i.sizes === s; });
  }));
ok('and a maskable icon, so Android does not crop the loaf',
  manifest.icons.some(function (i) { return i.purpose === 'maskable'; }));
ok('every icon the manifest names actually exists',
  manifest.icons.every(function (i) { return fs.existsSync(path.join(DIR, i.src)); }),
  manifest.icons.map(function (i) { return i.src; }).join(' '));
ok('the manifest theme matches the light-theme page background',
  manifest.background_color === '#F7F1E8' && manifest.theme_color === '#F7F1E8');

/* The same trap CLAUDE.md flags for <script> tags: add a file to the site and
 * forget the other place that lists it, and the app breaks — here, offline. */
var referenced = [];
html.replace(/(?:src|href)="([^"]+)"/g, function (m, u) {
  if (!/^(https?:|data:|#)/.test(u)) referenced.push(u);
  return m;
});
var missing = referenced.filter(function (u) {
  return u !== 'sw.js' && swSrc.indexOf("'" + u + "'") < 0;
});
ok('the worker precaches every local file index.html references',
  missing.length === 0, 'not precached: ' + missing.join(' '));
ok('every precached path exists on disk',
  (/var SHELL = \[([\s\S]*?)\];/.exec(swSrc)[1].match(/'([^']+)'/g) || [])
    .map(function (s) { return s.slice(1, -1); })
    .filter(function (p) { return p !== './'; })
    .every(function (p) { return fs.existsSync(path.join(DIR, p)); }));

/* Network-first is the whole reason a push can stay a deploy. Verified for
 * real in Chromium; asserted here so it cannot be quietly inverted. */
ok('the worker goes to the network first and falls back to the cache',
  /fromNetwork\(request\)\['catch'\]\(function \(\) \{[\s\S]*caches\.match/.test(swSrc));
ok('a new worker takes over straight away rather than waiting for tabs to close',
  /skipWaiting\(\)/.test(swSrc) && /clients\.claim\(\)/.test(swSrc));
ok('and old caches are dropped on activate', /caches\['delete'\]\(k\)/.test(swSrc));

head('THE HOME SCREEN IS THE FIX FOR iOS EVICTION, SO THE APP SAYS SO');
var wA = boot(JSON.stringify(goodState('Eviction bake')), 0);
var dA = wA.document;
Object.defineProperty(wA.navigator, 'userAgent',
  { value: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15', configurable: true });
var sheetA = openStorage(wA, dA);
ok('the storage sheet explains the seven-day wipe',
  /seven days/.test(sheetA.textContent), JSON.stringify(sheetA.textContent.slice(-260)));
ok('and tells you the taps that fix it',
  /Add to Home Screen/.test(sheetA.textContent));
ok('it does not offer a button iOS will never honour',
  !sheetA.querySelector('[data-act="install"]'));

function finish() {
  head('SUMMARY');
  console.log((fail ? '  FAILED ' + fail + ' / ' + (pass + fail) + '\n   · ' + failures.join('\n   · ')
    : '  All ' + pass + ' UI assertions passed.'));
  process.exit(fail ? 1 : 0);
}

/* FileReader is async, so the last assertions and the summary run from here. */
setTimeout(function () {
  var s9 = JSON.parse(w9.localStorage.getItem('bft.v1'));
  ok('the restored bake is added', s9.bakes.filter(function (b) { return b.id === 'k2'; }).length === 1);
  ok('and the bake already here is still here',
    s9.bakes.filter(function (b) { return b.id === 'k1'; }).length === 1, JSON.stringify(s9.bakes.map(function (b) { return b.name; })));
  ok('the running bake is not hijacked by the import', s9.activeId === 'k1');
  syncTests();
}, 150);

function syncTests() {
  head('SYNC IS OFF UNTIL YOU TURN IT ON');
  var wS = boot(JSON.stringify(goodState('Private bake')), 0);
  var dS = wS.document;
  var calls = [];
  wS.fetch = function (url, opts) {
    calls.push({ url: url, body: JSON.parse(opts.body) });
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve({ state: {
          bakes: [goodState('Private bake').bakes[0], (function () {
            var o = goodState('From the other phone').bakes[0]; o.id = 'other'; return o;
          })()],
          deleted: {}, activeId: 'k1'
        } });
      }
    });
  };

  ok('no sync code is stored by default', wS.localStorage.getItem('bft.sync') === null);

  /* Log a reading and let the debounce elapse: with sync off, nothing at all
   * should leave the phone. */
  dS.querySelector('[data-act="logtemp"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
  var nS = dS.querySelector('#sheet-root .sheet #numval');
  nS.value = '25';
  nS.dispatchEvent(new wS.Event('input', { bubbles: true }));
  dS.querySelector('#sheet-root .sheet [data-act="save"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));

  setTimeout(function () {
    ok('and nothing is sent anywhere with sync off', calls.length === 0,
      JSON.stringify(calls.map(function (c) { return c.url; })));

    head('TURNING SYNC ON');
    var sheetS = openStorage(wS, dS);
    ok('the storage sheet offers to set it up', !!sheetS.querySelector('[data-act="sync"]'));
    sheetS.querySelector('[data-act="sync"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
    var syncSheetEl = dS.querySelector('#sheet-root .sheet');
    ok('the sync sheet says who can read the bakes',
      /anyone who knows it can read your bakes/i.test(syncSheetEl.textContent));

    syncSheetEl.querySelector('#synccode').value = 'short';
    syncSheetEl.querySelector('[data-act="sync-save"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
    ok('a short code is refused', wS.localStorage.getItem('bft.sync') === null &&
      /At least 8/.test(dS.querySelector('#sheeterr').textContent));

    syncSheetEl.querySelector('#synccode').value = 'two-loaves-one-oven';
    syncSheetEl.querySelector('[data-act="sync-save"]').dispatchEvent(new wS.MouseEvent('click', { bubbles: true }));
    ok('a long enough code is stored',
      JSON.parse(wS.localStorage.getItem('bft.sync')).code === 'two-loaves-one-oven');

    setTimeout(function () {
      ok('and it pushes to the sync endpoint', calls.length >= 1 && calls[0].url === 'api/sync',
        JSON.stringify(calls.map(function (c) { return c.url; })));
      ok('sending the code and the bakes', calls[0].body.code === 'two-loaves-one-oven' &&
        calls[0].body.state.bakes.length === 1);
      var sS = JSON.parse(wS.localStorage.getItem('bft.v1'));
      ok('the other phone\'s bake arrives',
        sS.bakes.filter(function (b) { return b.id === 'other'; }).length === 1,
        JSON.stringify(sS.bakes.map(function (b) { return b.id; })));
      ok('and this phone\'s own bake is still here',
        sS.bakes.filter(function (b) { return b.id === 'k1'; }).length === 1);

      var before = calls.length;
      setTimeout(function () {
        ok('applying a merge does not bounce another push straight back',
          calls.length === before, before + ' → ' + calls.length);

        head('DELETING LEAVES A TOMBSTONE, SO IT STAYS DELETED');
        var wD = boot(JSON.stringify(goodState('Doomed')), 0);
        var dD = wD.document;
        dD.querySelector('[data-act="menu"]').dispatchEvent(new wD.MouseEvent('click', { bubbles: true }));
        dD.querySelector('#sheet-root .sheet [data-act="finish"]').dispatchEvent(new wD.MouseEvent('click', { bubbles: true }));
        dD.querySelector('[data-act="delbake"]').dispatchEvent(new wD.MouseEvent('click', { bubbles: true }));
        dD.querySelector('#sheet-root .sheet [data-act="yes"]').dispatchEvent(new wD.MouseEvent('click', { bubbles: true }));
        var sD = JSON.parse(wD.localStorage.getItem('bft.v1'));
        ok('the bake is gone', sD.bakes.length === 0);
        ok('and a tombstone records it', !!sD.deleted && !!sD.deleted.k1,
          JSON.stringify(sD.deleted));
        finish();
      }, 60);
    }, 30);
  }, 4200);
}
