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

var dom = new JSDOM(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/'
});
var w = dom.window;
w.matchMedia = w.matchMedia || function () { return { matches: false, addListener: function () {}, removeListener: function () {} }; };
w.navigator.vibrate = function () {};
w.AudioContext = function () { this.state = 'running'; this.currentTime = 0;
  this.createOscillator = function () { return { frequency: {}, connect: function () {}, start: function () {}, stop: function () {} }; };
  this.createGain = function () { return { gain: { setValueAtTime: function () {}, exponentialRampToValueAtTime: function () {} }, connect: function () {} }; };
  this.destination = {}; this.resume = function () {}; };
w.URL.createObjectURL = function () { return 'blob:x'; };
w.URL.revokeObjectURL = function () {};

var downloads = [];
var origClick = w.HTMLElement.prototype.click;
w.HTMLElement.prototype.click = function () {
  if (this.tagName === 'A' && this.download) { downloads.push({ name: this.download }); return; }
  return origClick.apply(this, arguments);
};

['model.js', 'process.js', 'app.js'].forEach(function (f) {
  w.eval(fs.readFileSync(path.join(DIR, f), 'utf8'));
});

var doc = w.document;
function $(sel, root) { return (root || doc).querySelector(sel); }
function $$(sel, root) { return Array.prototype.slice.call((root || doc).querySelectorAll(sel)); }
function act(a, root) { return $('[data-act="' + a + '"]', root); }
function click(el) {
  if (!el) throw new Error('nothing to click');
  el.dispatchEvent(new w.MouseEvent('click', { bubbles: true }));
}
function clickAct(a, root) { click(act(a, root)); }
function sheet() { return $('#sheet-root .sheet'); }
function text() { return doc.getElementById('app').textContent; }
function toastText() { return doc.getElementById('toast').textContent; }
function localVal(ms) {
  var d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
}
function setInput(el, v) {
  el.value = v;
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  el.dispatchEvent(new w.Event('change', { bubbles: true }));
}

head('BOOT');
ok('lands on the mode picker', /What are you doing\?/.test(text()));
ok('offers all three modes', act('mode-full') && act('mode-plan') && act('mode-bulk'));
ok('seeds Bruce’s Loaf', JSON.parse(w.localStorage.getItem('bft.v1')).templates[0].name === "Bruce's Loaf");

head('TEMPLATE EDITOR — add, edit, reorder, delete');
clickAct('templates');
ok('template list shows the seeded process', /Bruce.s Loaf/.test(text()) && /11 stages/.test(text()));
clickAct('tpl-edit');
var rows = function () { return $$('.stagerow'); };
ok('editor lists 11 stages', rows().length === 11);
ok('first stage is the revival feed', /Starter revival/.test(rows()[0].textContent));
ok('bulk row says the length comes from the model',
  /re-read live from the dough temp/.test($('.bulkrow').textContent));

var thirdName = rows()[2].querySelector('b').textContent;
click(rows()[2].querySelector('[data-act="st-down"]'));
ok('moving a stage down reorders it', rows()[3].querySelector('b').textContent === thirdName);
click(rows()[3].querySelector('[data-act="st-up"]'));
ok('moving it back restores the order', rows()[2].querySelector('b').textContent === thirdName);

click(rows()[2].querySelector('.body'));
ok('tapping a stage opens its editor', sheet() && /Mix \+ autolyse/.test(sheet().textContent));
setInput($('#f-dur', sheet()), '75');
setInput($('#f-name', sheet()), 'Mix + long autolyse');
setInput($('#f-cues', sheet()), 'Elastic\nNo dry flour\nSmells of wheat');
clickAct('st-save', sheet());
ok('edits are saved', /Mix \+ long autolyse/.test(text()) && /75 min timer/.test(text()));
ok('cues are saved', /Smells of wheat/.test(text()));

clickAct('st-add');
ok('add-stage offers every type', $$('[data-newtype]', sheet()).length === w.BFProcess.TYPES.length);
click($('[data-newtype="active"]', sheet()));
ok('the new stage is appended and opened', rows().length === 12 && sheet());
clickAct('st-del', sheet());
clickAct('yes', sheet());
ok('deleting a stage removes it', rows().length === 11);

clickAct('templates');
clickAct('tpl-dupe');
ok('duplicate opens a fresh editable copy', /copy/i.test($('.topbar h1').textContent));
clickAct('templates');
ok('both processes are listed', $$('[data-act="tpl-edit"]').length === 2);
clickAct('tpl-export');
ok('template exports as JSON', downloads.some(function (d) { return /\.json$/.test(d.name); }));
click($$('[data-act="tpl-del"]')[1]);
clickAct('yes', sheet());
ok('deleting a process removes it', $$('[data-act="tpl-edit"]').length === 1);

head('REVERSE PLANNER — the worked example, through the UI');
clickAct('home');
clickAct('mode-plan');
ok('planner form is up', $('#planform'));
var FRI = new Date(2026, 7, 21, 9, 45, 0, 0).getTime();
var form = $('#planform');
setInput(form.elements.finishAt, localVal(FRI));
setInput(form.elements.bulkTempC, '22');
ok('starter defaults to “from the fridge”', act('t-fridge').getAttribute('aria-checked') === 'true');
form.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));

var plan = function () { return JSON.parse(w.localStorage.getItem('bft.v1')).draft; };
function row(name) { return plan().events.filter(function (e) { return e.name.indexOf(name) === 0; })[0]; }
function hm(ms) { var d = new Date(ms); return ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'][d.getDay()] + ' ' + String(d.getHours()).padStart(2,'0') + ':' + String(d.getMinutes()).padStart(2,'0'); }
ok('a plan was produced', !!plan());
console.log('    mix ' + hm(row('Mix').start) + ' · bulk ' + hm(row('Bulk').start) +
  ' · shape ' + hm(row('Shape').start) + ' · fridge ' + hm(row('Cold proof').start) +
  ' · final feed ' + hm(plan().events.filter(function(e){return e.feedRole==='final';})[0].start));
ok('timeline is grouped by day', $$('.planday').length >= 3);
ok('days are named', /Thursday/.test($$('.planday').map(function (d) { return d.textContent; }).join(' ')));
ok('every row has a time, a name and a what-to-do',
  $$('.planrow').every(function (r) { return $('.when', r) && $('.what b', r) && $('.what em', r); }));
ok('it explains where the bulk length came from', /1 ÷ r\(22 °C\)/.test(text()));
ok('it reports moving the night-time feed', /Final starter feed moved from/.test(text()));
ok('no plan row is flagged as a night-time hands-on step', $$('.planrow.night').length === 0);

head('DRAG A ROW TO ADJUST');
var shapeBefore = row('Shape').start;
var mixRow = $$('.planrow').filter(function (r) { return /Mix/.test(r.textContent); })[0];
function ptr(type, el, x) {
  var e = new w.MouseEvent(type, { bubbles: true, clientX: x, clientY: 10 });
  Object.defineProperty(e, 'pointerId', { value: 1 });
  el.dispatchEvent(e);
}
mixRow.setPointerCapture = function () {};
ptr('pointerdown', mixRow, 200);
ptr('pointermove', mixRow, 128);       // -72px @ 2.4px/min = -30 min
ptr('pointerup', mixRow, 128);
ok('dragging the mix row moved it 30 min earlier',
  Math.round((row('Mix').start - (shapeBefore - (shapeBefore - row('Mix').start))) / 60000) === 0 &&
  Math.abs(row('Shape').start - (shapeBefore - 30 * 60000)) < 1000,
  hm(row('Shape').start));
ok('the drag was announced', /Moved to/.test(toastText()));

var t2 = $$('.planrow').filter(function (r) { return /Coil folds 1/.test(r.textContent); })[0];
t2.setPointerCapture = function () {};
ptr('pointerdown', t2, 200); ptr('pointerup', t2, 200);
ok('a tap with no movement opens the exact-time sheet', sheet() && $('#nz-time', sheet()));
clickAct('cancel', sheet());

head('ICS EXPORT');
clickAct('plan-ics');
ok('exports a .ics file', downloads.some(function (d) { return /\.ics$/.test(d.name); }));

head('LIVE TRACKER — start the plan and run it');
clickAct('plan-start');
ok('dropped into the live tracker', /Timeline/.test(text()));
var proc = function () { var s = JSON.parse(w.localStorage.getItem('bft.v1')); return s.processes.filter(function (p) { return p.id === s.activeProcessId; })[0]; };
ok('the plan is now the active bake', !!proc());
ok('future stages are pre-scheduled', proc().events.every(function (e) { return e.plannedStart != null; }));
ok('nothing is ticked off yet', proc().events.every(function (e) { return e.actualEnd == null; }));
ok('now card offers to start the first stage', /Start /.test(act('proc-start').textContent));
ok('next up is shown', $('.nextup'));
ok('the timeline lists every stage', $$('.tlrow').length >= 11);

ok('a due starter feed is put in front of you, not skipped',
  !!$('.subcount') && /[Ss]tarter/.test($('.subcount').textContent));

/* Tick every feed off, then work down the bench stages to the bulk. */
var guard = 0;
while ($('.subcount [data-act="proc-tick"]') && guard++ < 10) click($('.subcount [data-act="proc-tick"]'));
ok('every starter feed can be ticked off', guard >= 3);

guard = 0;
while (guard++ < 40) {
  if (act('proc-start')) clickAct('proc-start');
  if (sheet() && $('#numval', sheet())) break;     // the bulk asks for a temperature
  var main = $('.actions [data-act="proc-tick"]');
  if (!main) break;
  click(main);
  if (sheet() && $('#numval', sheet())) break;
}
ok('ticking stages off advanced the chain', proc().events.filter(function (e) { return e.actualEnd != null; }).length >= 4);

head('BULK HANDOFF — the existing engine, not a reimplementation');
ok('starting the bulk asks for a dough temperature',
  sheet() && /Dough temperature/.test(sheet().textContent));
setInput($('#numval', sheet()), '20');
clickAct('save', sheet());
var st0 = JSON.parse(w.localStorage.getItem('bft.v1'));
var rec = st0.bakes.filter(function (b) { return b.id === proc().bulkBakeId; })[0];
ok('a real bulk-tracker bake record was created', !!rec && rec.readings.length === 1);
ok('it is the app-wide active bulk, so every existing control works', st0.activeId === rec.id);
ok('the bulk chart appears in place', $('.chartwrap svg'));
ok('log temp and log rise are the original controls', act('logtemp') && act('lograise'));
ok('progress, target rise and calibration are on screen',
  /Progress/.test(text()) && /Target rise/.test(text()) && /Expected rise now/.test(text()));

var bulkEv = function () { return proc().events.filter(function (e) { return e.chain && e.type === 'bulk'; })[0]; };
var shapeEv = function () { return proc().events.filter(function (e) { return e.name === 'Shape'; })[0]; };
var Mm = w.BFModel;
var predicted = Mm.stateAt(rec.readings, Date.now()).predictedEnd;
console.log('    plan said ' + (Mm.hoursAt(22)).toFixed(2) + ' h at 22 °C; dough is 20 °C so the model says ' + Mm.hoursAt(20).toFixed(2) + ' h');
ok('downstream now follows the accumulator, not the plan',
  Math.abs(w.BFProcess.projectTimeline(proc(), Date.now(), Mm.stateAt(rec.readings, Date.now()))
    .chain.filter(function (e) { return e.name === 'Shape'; })[0].start - predicted) < 1000);
ok('the timeline says so out loud', /from the dough, not the plan/.test(text()));

clickAct('logtemp');
ok('logging a temperature reuses the original number sheet', sheet() && $('#numval', sheet()));
setInput($('#numval', sheet()), '19');
clickAct('save', sheet());
ok('the reading landed in the same bake record',
  JSON.parse(w.localStorage.getItem('bft.v1')).bakes.filter(function (b) { return b.id === rec.id; })[0].readings.length === 2);

head('JUDGEMENT STAGES');
var mainBtn = function () { return $('.actions [data-act="proc-tick"]'); };
ok('the bulk will not tick itself off', act('proc-start') === null && mainBtn() !== null);
ok('the button asks for confirmation, not completion', /Confirm/.test(mainBtn().textContent));
ok('the cues are on screen', /Jiggles as one mass/.test(text()));
ok('and it says whose call it is', /cannot say done/i.test(text()));

head('FOLDS AS A SUB-COUNTDOWN UNDER THE BULK');
ok('the next fold is shown under the bulk countdown', $('.subcount') && /Coil folds/.test($('.subcount').textContent));
click($('.subcount [data-act="proc-tick"]'));
ok('ticking a fold does not end the bulk',
  proc().events.filter(function (e) { return e.kind === 'rep' && e.actualEnd != null; }).length === 1 &&
  bulkEv().actualEnd == null);
ok('the next fold takes its place', /Coil folds 2/.test($('.subcount').textContent));

head('PER-STAGE NOTES');
click($('[data-act="proc-note"]'));
setInput($('#sn-text', sheet()), 'Dough 20.1 at mix, kitchen cold.');
clickAct('sn-save', sheet());
ok('the note is saved against the stage', bulkEv().log === 'Dough 20.1 at mix, kitchen cold.');
ok('and shows on the button', /Dough 20\.1/.test(act('proc-note').textContent));

head('RECONCILIATION');
var plannedShape = shapeEv().plannedStart;
click(mainBtn());                         // confirm the bulk done, now
var liveShape = shapeEv();
ok('confirming the bulk starts the next stage there and then', liveShape.actualStart != null);
ok('the shape stage really did move off its planned time',
  Math.abs(liveShape.actualStart - plannedShape) > 60 * 60000);
ok('the bulk record was closed out',
  JSON.parse(w.localStorage.getItem('bft.v1')).bakes.filter(function (b) { return b.id === rec.id; })[0].status === 'done');
ok('the app-wide active bulk was released', JSON.parse(w.localStorage.getItem('bft.v1')).activeId === null);

head('HOME AND RESUME');
clickAct('home');
ok('home shows the bake in progress', /Bake in progress/.test(text()));
clickAct('resume-process');
ok('resume drops straight back in', $('.nextup') || /Timeline/.test(text()));

head('BULK-ONLY MODE IS UNTOUCHED');
clickAct('home');
clickAct('mode-bulk');
ok('the original start screen is intact', $('#startform') && /First dough temperature/.test(text()));
var sf = $('#startform');
setInput(sf.elements.temp, '24.5');
sf.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok('a standalone bulk starts', /Preshape at/.test(text()));
ok('it did not touch the running full bake', proc().status === 'active');
ok('the original chart and readings list are there', $('.chartwrap svg') && $('.readings'));
clickAct('menu');
clickAct('abandon', sheet());
clickAct('yes', sheet());

head('HISTORY');
ok('abandoning a standalone bulk lands in history', /History/.test(text()));
ok('the abandoned bulk is listed under bulk ferments', /Bulk ferments/.test(text()));
clickAct('csv');
ok('readings CSV still exports', downloads.some(function (d) { return /^bulk-ferment-.*\.csv$/.test(d.name); }));

/* Finish the full bake so it reaches history too. */
clickAct('back');
ok('back from history returns to the running bake', !!$('.nextup') || /Timeline/.test(text()));
clickAct('proc-menu');
clickAct('proc-ics', sheet());
ok('the rest of a running bake exports as .ics', downloads.filter(function (d) { return /\.ics$/.test(d.name); }).length >= 2);
clickAct('proc-menu');
clickAct('proc-finish', sheet());
clickAct('yes', sheet());
ok('finishing the bake lands in history', /History/.test(text()));
ok('full bakes get their own section', /Full bakes/.test(text()));
ok('and the bulk it owned is not listed separately',
  (text().match(/— bulk/g) || []).length === 0);
ok('finishing opens the bake card straight away', act('closebake') !== null);
if (act('openproc')) clickAct('openproc');
ok('opening a finished bake shows planned against actual', /planned /.test(text()));
ok('and the bulk chart it ran', !!$('.chartwrap svg'));
clickAct('csv-stages');
ok('stage-level CSV exports', downloads.some(function (d) { return /^bakes-stages-.*\.csv$/.test(d.name); }));
clickAct('back');
ok('back with nothing running goes home', /What are you doing\?/.test(text()) && !/Bake in progress/.test(text()));

head('UNSOCIABLE HOURS, THROUGH THE UI');
clickAct('mode-plan');
var pf = $('#planform');
setInput(pf.elements.finishAt, localVal(new Date(2026, 7, 21, 17, 0, 0, 0).getTime()));
setInput(pf.elements.bulkTempC, '22');
click(act('t-fridge'));                    // starter already active
pf.dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok('a 17:00 finish makes it flex the cold proof', /Cold proof (stretched|squeezed) to/.test(text()));
ok('it says why', /out of the night/.test(text()));
ok('and the result has no night-time hands-on rows', $$('.planrow.night').length === 0);
var flexed = plan().params.coldMin;
ok('the flex stayed inside the 8–16 h range', flexed >= 480 && flexed <= 960, String(flexed / 60) + ' h');

setInput($('#planform').elements.finishAt, localVal(new Date(2026, 7, 21, 4, 0, 0, 0).getTime()));
$('#planform').dispatchEvent(new w.Event('submit', { bubbles: true, cancelable: true }));
ok('a 04:00 bake time is called out rather than silently planned',
  /puts you in the kitchen at night/.test(text()));
ok('it names the bake steps that cannot move', /Preheat the oven at 0[0-3]:/.test(text()));

head('JSON IMPORT ROUND TRIP');
/* Export the edited template, then import the bytes back and check it survived. */
var exported = null;
w.Blob = function (parts) { exported = parts.join(''); this.parts = parts; };
clickAct('home'); clickAct('templates'); clickAct('tpl-export');
ok('export produced JSON', exported && JSON.parse(exported).kind === 'bulk-ferment-template');
var payload = exported;

var picked = null;
w.HTMLInputElement.prototype.click = function () { picked = this; };
var origFR = w.FileReader;
w.FileReader = function () {
  var self = this;
  this.readAsText = function () { self.result = payload; self.onload(); };
};
clickAct('tpl-import');
Object.defineProperty(picked, 'files', { value: [{ name: 't.json' }], configurable: true });
picked.dispatchEvent(new w.Event('change', { bubbles: true }));
w.FileReader = origFR;
ok('import added a process', $$('[data-act="tpl-edit"]').length === 2);
var imported = JSON.parse(w.localStorage.getItem('bft.v1')).templates[1];
var original = JSON.parse(payload).template;
ok('every stage came back', imported.stages.length === original.stages.length);
ok('the edits made earlier survived the trip',
  imported.stages.some(function (st) { return st.name === 'Mix + long autolyse' && st.durationMin === 75; }));
ok('cues came back too',
  imported.stages.some(function (st) { return st.cues.indexOf('Smells of wheat') >= 0; }));
ok('the fold still points at the bulk stage',
  imported.stages.filter(function (st) { return st.type === 'repeat'; })[0].duringStageId ===
  imported.stages.filter(function (st) { return st.type === 'bulk'; })[0].id);
ok('but with fresh ids, so it is a separate process',
  imported.stages[0].id !== original.stages[0].id);

head('RELOAD — nothing is held in a running timer');
var saved = w.localStorage.getItem('bft.v1');
/* Put a bake back in flight, then reload the page from storage alone. */
var st9 = JSON.parse(saved);
var proc9 = st9.processes[0];
proc9.status = 'active'; st9.activeProcessId = proc9.id;
saved = JSON.stringify(st9);

var dom2 = new JSDOM(fs.readFileSync(path.join(DIR, 'index.html'), 'utf8'), {
  runScripts: 'outside-only', pretendToBeVisual: true, url: 'https://example.test/'
});
var w2 = dom2.window;
w2.matchMedia = function () { return { matches: false, addListener: function () {}, removeListener: function () {} }; };
w2.navigator.vibrate = function () {};
w2.AudioContext = w.AudioContext;
w2.URL.createObjectURL = function () { return 'blob:x'; };
w2.URL.revokeObjectURL = function () {};
w2.localStorage.setItem('bft.v1', saved);
['model.js', 'process.js', 'app.js'].forEach(function (f) { w2.eval(fs.readFileSync(path.join(DIR, f), 'utf8')); });
var t2text = w2.document.getElementById('app').textContent;
ok('a reload lands straight back in the running bake', /Timeline/.test(t2text));
ok('the ticked-off stages are still ticked', /done \d\d:\d\d/.test(t2text));
ok('the stage note survived', /Dough 20\.1/.test(t2text));
ok('the templates survived', JSON.parse(w2.localStorage.getItem('bft.v1')).templates.length === 2);

head('SUMMARY');
console.log((fail ? '  FAILED ' + fail + ' / ' + (pass + fail) + '\n   · ' + failures.join('\n   · ')
  : '  All ' + pass + ' UI assertions passed.'));
process.exit(fail ? 1 : 0);
