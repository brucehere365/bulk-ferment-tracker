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
ok('the schema is at v3', stored().version === 3);
ok('no templates or processes are stored', !('templates' in stored()) && !('processes' in stored()));

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

head('SUMMARY');
console.log((fail ? '  FAILED ' + fail + ' / ' + (pass + fail) + '\n   · ' + failures.join('\n   · ')
  : '  All ' + pass + ' UI assertions passed.'));
process.exit(fail ? 1 : 0);
