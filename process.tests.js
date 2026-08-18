/* node process.tests.js — template, reverse planner, reconciliation, .ics.
 * The headline is the worked example: out of the oven Friday 09:45, bulk at
 * 22 °C, starter from the fridge. */
'use strict';
var M = require('./model.js');
var P = require('./process.js');

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function near(name, got, want, tolMin) {
  var d = Math.abs(got - want) / 60000;
  ok(name + '  (got ' + hm(got) + ', want ' + hm(want) + ', off ' + Math.round(d) + ' min)', d <= tolMin);
}
function head(s) { console.log('\n' + s + '\n' + '-'.repeat(s.length)); }
function pad(s, n) { s = String(s); return s.length >= n ? s : s + ' '.repeat(n - s.length); }
function padl(s, n) { s = String(s); return s.length >= n ? s : ' '.repeat(n - s.length) + s; }
function hm(ms) {
  var d = new Date(ms);
  return ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][d.getDay()] + ' ' +
    String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}
function at(y, mo, d, h, mi) { return new Date(y, mo - 1, d, h, mi, 0, 0).getTime(); }

// 2026-08-21 is a Friday.
var FINISH = at(2026, 8, 21, 9, 45);
var TPL = P.defaultTemplate();

head('TEMPLATE — Bruce\'s Loaf');
console.log('  #  ' + pad('stage', 22) + pad('type', 14) + 'detail');
TPL.stages.forEach(function (s, i) {
  var d = s.type === 'fixed' || s.type === 'active' ? (s.durationMin == null ? 'no timer' : s.durationMin + ' min')
    : s.type === 'repeat' ? '×' + s.reps + ' every ' + s.intervalMin + ' min' + (s.duringStageId ? ' during ' + s.duringStageId : '')
      : s.type === 'bulk' ? 'target ' + s.targetTempC + ' °C → ' + M.hoursAt(s.targetTempC).toFixed(2) + ' h'
        : s.type === 'cold-proof' ? (s.minMin / 60) + '–' + (s.maxMin / 60) + ' h'
          : s.type === 'bake' ? 'preheat ' + s.preheatMin + ' min · ' + s.steps.map(function (b) { return b.tempC + '°C ' + b.durationMin + 'm ' + b.label.toLowerCase(); }).join(' → ')
            : s.type === 'starter-feed' ? s.role + ' ×' + s.feeds + ', gap ' + s.gapHours + ' h, peak ' + s.peakHours + ' h' : '';
  console.log('  ' + padl(i + 1, 2) + ' ' + pad(s.name, 22) + pad(s.type, 14) + d);
});

head('WORKED EXAMPLE — out of the oven Fri 09:45, bulk 22 °C, starter from the fridge');
var plan = P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: 22, fromFridge: true });
console.log('  bulk at 22 °C = 1 / r(22) = ' + M.hoursAt(22).toFixed(3) + ' h  (rate ' + M.rateAt(22).toFixed(5) + '/h)');
console.log('  cold proof used: ' + (plan.params.coldMin / 60).toFixed(2) + ' h  (range 8–16 h, midpoint ' + (plan.params.baseColdMin / 60) + ' h)');
console.log('');
plan.days.forEach(function (d) {
  console.log('  ' + new Date(d.dateMs).toDateString());
  d.events.forEach(function (e) {
    console.log('      ' + hm(e.start).slice(4) + '  ' + pad(e.name, 26) +
      (e.end > e.start ? '→ ' + hm(e.end).slice(4) + '  ' : '            ') +
      (P.isNight(e.start) && e.handsOn ? '  ** NIGHT **' : ''));
  });
});

if (plan.adjustments.length) {
  console.log('\n  Adjustments:');
  plan.adjustments.forEach(function (a) { console.log('    · ' + a.text); });
}
if (plan.problems.length) {
  console.log('\n  Problems:');
  plan.problems.forEach(function (a) { console.log('    ! ' + a.text); });
}
if (plan.options.length) {
  console.log('\n  Options offered:');
  plan.options.forEach(function (a) { console.log('    > ' + a.text); });
}

head('WORKED EXAMPLE — assertions against the brief');
function find(name) {
  return plan.events.filter(function (e) { return e.name.indexOf(name) === 0; })[0];
}
var bakeOut = plan.events.filter(function (e) { return e.kind === 'bake-step'; }).slice(-1)[0];
var bakeIn = plan.events.filter(function (e) { return e.kind === 'bake-step'; })[0];
var preheat = plan.events.filter(function (e) { return e.kind === 'preheat'; })[0];
var cold = find('Cold proof');
var shape = find('Shape');
var bulk = find('Bulk ferment');
var folds = plan.events.filter(function (e) { return e.kind === 'rep'; });
var addSalt = find('Add starter');
var mix = find('Mix + autolyse');
var finalFeed = plan.events.filter(function (e) { return e.feedRole === 'final'; })[0];
var revivals = plan.events.filter(function (e) { return e.feedRole === 'revival'; }).sort(function (a, b) { return a.start - b.start; });

near('out of the oven                Fri 09:45', bakeOut.end, at(2026, 8, 21, 9, 45), 0);
near('into the oven                  Fri 09:00', bakeIn.start, at(2026, 8, 21, 9, 0), 0);
near('preheat on                     Fri 08:00', preheat.start, at(2026, 8, 21, 8, 0), 0);
near('into the fridge                Thu 21:00', cold.start, at(2026, 8, 20, 21, 0), 15);
near('shape                          Thu ~20:30', shape.start, at(2026, 8, 20, 20, 30), 15);
near('bulk starts                    Thu ~10:30', bulk.start, at(2026, 8, 20, 10, 30), 20);
near('add starter + salt             Thu ~10:00', addSalt.start, at(2026, 8, 20, 10, 0), 20);
near('mix + autolyse                 Thu ~09:00', mix.start, at(2026, 8, 20, 9, 0), 20);
near('final starter feed             Wed ~21:00', finalFeed.start, at(2026, 8, 19, 21, 0), 15);
near('revival feed 1                 Tue ~21:00', revivals[0].start, at(2026, 8, 18, 21, 0), 15);
near('revival feed 2                 Wed ~09:00', revivals[1].start, at(2026, 8, 19, 9, 0), 15);

ok('cold proof is 12 h (range midpoint, untouched)', Math.abs(cold.end - cold.start - 12 * P.HOUR) < 60000);
ok('bulk length is 1/r(22), not a hardcoded 10 h',
  Math.abs((bulk.end - bulk.start) / P.HOUR - M.hoursAt(22)) < 0.001,
  'got ' + ((bulk.end - bulk.start) / P.HOUR).toFixed(3));
ok('four coil folds', folds.length === 4);
ok('folds run inside the bulk window',
  folds.every(function (f) { return f.start >= bulk.start && f.start <= bulk.end; }));
ok('folds are 30 min apart from the start of bulk',
  folds[0].start === bulk.start &&
  folds[3].start - folds[0].start === 90 * P.MIN);
ok('no hands-on dough step lands between 23:00 and 06:00',
  plan.events.filter(function (e) { return e.handsOn && e.kind !== 'feed' && P.isNight(e.start); }).length === 0);
ok('the night-time final feed was moved, not silently kept',
  finalFeed.movedFrom != null && P.isNight(finalFeed.movedFrom) && !P.isNight(finalFeed.start));
ok('the move is reported as an adjustment',
  plan.adjustments.some(function (a) { return a.kind === 'feed'; }));

head('BULK LENGTH IS ALWAYS THE MODEL, NEVER A CONSTANT');
[19, 21, 22, 24, 25, 26].forEach(function (t) {
  var p = P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: t, fromFridge: false });
  var b = p.events.filter(function (e) { return e.type === 'bulk' && e.chain; })[0];
  var m = p.events.filter(function (e) { return e.name.indexOf('Mix') === 0; })[0];
  console.log('  ' + padl(t, 4) + ' °C  bulk ' + padl(((b.end - b.start) / P.HOUR).toFixed(2), 6) + ' h   ' +
    'bulk starts ' + hm(b.start) + '   mix ' + hm(m.start) +
    '   cold proof ' + padl((p.params.coldMin / 60).toFixed(2), 5) + ' h' +
    (p.adjustments.some(function (a) { return a.kind === 'cold-proof'; }) ? '  (flexed)' : ''));
  ok('bulk at ' + t + ' °C matches 1/r(T)',
    Math.abs((b.end - b.start) / P.HOUR - M.hoursAt(t)) < 0.001);
});

head('THE COLD PROOF AS SHOCK ABSORBER');
/* Out of the oven at 17:00 pushes the whole bench block into the small hours
 * at the 12 h midpoint. The planner has to find its way out. */
var awkward = P.planBackwards(TPL, { finishAt: at(2026, 8, 21, 17, 0), bulkTempC: 22, fromFridge: false });
var aw = awkward.events.filter(function (e) { return e.chain && e.type === 'cold-proof'; })[0];
console.log('  finish 17:00 → cold proof ' + ((aw.end - aw.start) / P.HOUR).toFixed(2) + ' h, mix at ' +
  hm(awkward.events.filter(function (e) { return e.name.indexOf('Mix') === 0; })[0].start));
awkward.adjustments.forEach(function (a) { console.log('    · ' + a.text); });
awkward.problems.forEach(function (a) { console.log('    ! ' + a.text); });
awkward.options.forEach(function (a) { console.log('    > ' + a.text); });
ok('cold proof stayed inside its 8–16 h range',
  (aw.end - aw.start) >= 8 * P.HOUR - 1000 && (aw.end - aw.start) <= 16 * P.HOUR + 1000,
  ((aw.end - aw.start) / P.HOUR).toFixed(2) + ' h');
ok('no hands-on dough step at night after flexing',
  awkward.events.filter(function (e) { return e.handsOn && e.kind !== 'feed' && e.movable && P.isNight(e.start); }).length === 0);

head('WHEN IT CANNOT BE ABSORBED, IT SAYS SO');
/* A finish time that pins the bake itself into the night. */
var nightBake = P.planBackwards(TPL, { finishAt: at(2026, 8, 21, 4, 0), bulkTempC: 22, fromFridge: false });
nightBake.problems.forEach(function (a) { console.log('    ! ' + a.text); });
nightBake.options.forEach(function (a) { console.log('    > ' + a.text); });
ok('a 04:00 finish is flagged as a problem, not silently planned',
  nightBake.problems.length > 0);
ok('the problem names the pinned bake steps',
  nightBake.problems.some(function (p) { return p.kind === 'pinned-night'; }));

head('TEMPLATE EDITING');
var t2 = P.duplicateTemplate(TPL, 'Copy');
ok('duplicate gets fresh ids', t2.id !== TPL.id && t2.stages[0].id !== TPL.stages[0].id);
ok('duplicate rewires internal references',
  t2.stages.filter(function (s) { return s.type === 'repeat'; })[0].duringStageId ===
  t2.stages.filter(function (s) { return s.type === 'bulk'; })[0].id);
ok('duplicate is not builtin', t2.builtin === false);

var t3 = P.normalizeTemplate(P.clone(TPL));
t3.stages = t3.stages.filter(function (s) { return s.type !== 'bulk'; });
t3 = P.normalizeTemplate(t3);
ok('deleting a referenced stage clears the dangling reference',
  t3.stages.filter(function (s) { return s.type === 'repeat'; })[0].duringStageId === null);
var t4 = P.normalizeTemplate(P.clone(TPL));
var moved = t4.stages.splice(2, 1)[0];
t4.stages.splice(5, 0, moved);
t4 = P.normalizeTemplate(t4);
ok('reordering keeps references intact (they are by id)',
  t4.stages.filter(function (s) { return s.type === 'repeat'; })[0].duringStageId ===
  t4.stages.filter(function (s) { return s.type === 'bulk'; })[0].id);
ok('a blank stage of every type normalizes',
  P.TYPES.every(function (ty) { return P.blankStage(ty).type === ty; }));

head('RECONCILIATION — real elapsed time overrides the plan');
var bake = P.commitPlan(P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: 22, fromFridge: false }), 'Test bake');
var chain0 = bake.events.filter(function (e) { return e.chain; }).sort(function (a, b) { return a.chainIndex - b.chainIndex; });
var mixEv = chain0[0], addEv = chain0[1];
var plannedBulkStart = chain0.filter(function (e) { return e.type === 'bulk'; })[0].plannedStart;

/* Start the mix 40 minutes late and take 20 minutes longer over it. */
mixEv.actualStart = mixEv.plannedStart + 40 * P.MIN;
mixEv.actualEnd = mixEv.actualStart + 80 * P.MIN;
var proj = P.projectTimeline(bake, mixEv.actualEnd + P.MIN, null);
var bulkEv = proj.chain.filter(function (e) { return e.type === 'bulk'; })[0];
near('downstream bulk pushed by the real 60 min of drift', bulkEv.start, plannedBulkStart + 60 * P.MIN, 1);
ok('the completed stage keeps its actual times',
  proj.chain[0].start === mixEv.actualStart && proj.chain[0].end === mixEv.actualEnd);
ok('current stage is the first one not ticked off', proj.current.stageId === addEv.stageId);
ok('next up is the one after that', proj.next.chainIndex === proj.current.chainIndex + 1);
var foldsNow = proj.events.filter(function (e) { return e.kind === 'rep'; });
near('folds moved with the bulk they run inside', foldsNow[0].start, bulkEv.start, 1);

head('RECONCILIATION — the accumulator takes over the bulk');
/* Tick everything up to the bulk, then hand it a real 20 °C reading history.
 * The plan said ~10 h at 22 °C; at 20 °C the accumulator must say ~13.4 h. */
var bake2 = P.commitPlan(P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: 22, fromFridge: false }), 'Handoff');
var c2 = bake2.events.filter(function (e) { return e.chain; }).sort(function (a, b) { return a.chainIndex - b.chainIndex; });
var bulkStartT = c2.filter(function (e) { return e.type === 'bulk'; })[0].plannedStart;
c2.forEach(function (e) {
  if (e.type === 'bulk') { e.actualStart = bulkStartT; return; }
  if (e.chainIndex < c2.filter(function (x) { return x.type === 'bulk'; })[0].chainIndex) {
    e.actualStart = e.plannedStart; e.actualEnd = e.plannedEnd;
  }
});
var readings = [
  { id: 'r1', t: bulkStartT, temp: 20, rise: null, gapTemp: null },
  { id: 'r2', t: bulkStartT + 2 * P.HOUR, temp: 20, rise: null, gapTemp: null }
];
var nowT = bulkStartT + 2 * P.HOUR;
var st = M.stateAt(readings, nowT);
var proj2 = P.projectTimeline(bake2, nowT, st);
var bulk2 = proj2.chain.filter(function (e) { return e.type === 'bulk'; })[0];
var shape2 = proj2.chain.filter(function (e) { return e.name === 'Shape'; })[0];
console.log('  plan said bulk ends ' + hm(bulkStartT + M.hoursAt(22) * P.HOUR) + ' (22 °C)');
console.log('  dough is at 20 °C → accumulator says ' + hm(st.predictedEnd) + ' (' + M.hoursAt(20).toFixed(2) + ' h)');
ok('bulk end now comes from the accumulator, not the plan', bulk2.fromAccumulator === true);
near('bulk end equals BFModel.stateAt().predictedEnd', bulk2.end, st.predictedEnd, 0.1);
near('shape follows the accumulator downstream', shape2.start, st.predictedEnd, 0.1);
ok('the cold bulk pushed the day later than planned',
  bulk2.end > bulkStartT + M.hoursAt(22) * P.HOUR + P.HOUR);

head('JUDGEMENT STAGES');
var jb = P.commitPlan(P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: 22, fromFridge: false }), 'J');
ok('bulk is a judgement stage', jb.events.filter(function (e) { return e.type === 'bulk' && e.chain; })[0].judgement === true);
ok('cold proof is a judgement stage', jb.events.filter(function (e) { return e.type === 'cold-proof'; })[0].judgement === true);
ok('a stage with cues is a judgement stage', jb.events.filter(function (e) { return e.name.indexOf('Mix') === 0; })[0].judgement === true);
ok('a stage with no cues and a real timer is not', jb.events.filter(function (e) { return e.name === 'Rest'; })[0].judgement === false);
ok('bulk carries its cue list', jb.events.filter(function (e) { return e.type === 'bulk' && e.chain; })[0].cues.length === 4);

head('NUDGING A ROW');
var np = P.planBackwards(TPL, { finishAt: FINISH, bulkTempC: 22, fromFridge: false });
var beforeShape = np.events.filter(function (e) { return e.name === 'Shape'; })[0].start;
var mixRow = np.events.filter(function (e) { return e.name.indexOf('Mix') === 0; })[0];
P.nudgeEvent(np, mixRow.id, mixRow.start - 45 * P.MIN);
var afterShape = np.events.filter(function (e) { return e.name === 'Shape'; })[0].start;
near('dragging the mix earlier drags everything after it', afterShape, beforeShape - 45 * P.MIN, 1);
var foldAfter = np.events.filter(function (e) { return e.kind === 'rep'; })[0];
var bulkAfter = np.events.filter(function (e) { return e.chain && e.type === 'bulk'; })[0];
near('folds stayed glued to the bulk', foldAfter.start, bulkAfter.start, 1);

head('ICS EXPORT');
var ics = P.toICS(plan.events, "Bruce's Loaf", FINISH);
var vevents = ics.split('BEGIN:VEVENT').length - 1;
console.log('  ' + vevents + ' events, ' + ics.split('\r\n').length + ' lines');
ok('one VEVENT per scheduled event, containers excluded',
  vevents === plan.events.filter(function (e) { return !e.container; }).length);
ok('the bake container is not exported twice',
  vevents === plan.events.length - 1);
ok('calendar is well formed', /^BEGIN:VCALENDAR\r\n/.test(ics) && /END:VCALENDAR\r\n$/.test(ics));
ok('CRLF line endings throughout', ics.indexOf('\n') === ics.indexOf('\r\n') + 1);
ok('no line exceeds 75 octets', ics.split('\r\n').every(function (l) { return l.length <= 75; }),
  (ics.split('\r\n').filter(function (l) { return l.length > 75; })[0] || '').slice(0, 40));
ok('zero-length moments get a visible duration',
  ics.indexOf('DTSTART:' + new Date(finalFeed.start).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '')) > 0);
ok('commas and semicolons are escaped', ics.indexOf('\\,') > 0 || ics.indexOf('\;') > 0);

head('FORWARD PLANNER — start now, finish when it finishes');
/* Tuesday 09:00, starter already active. Printed before it is asserted on,
 * same habit as the reverse example: the arithmetic should be readable. */
var START = at(2026, 8, 18, 9, 0);
var fwd = P.planForward(TPL, { startAt: START, bulkTempC: 22, fromFridge: false });
fwd.days.forEach(function (d) {
  console.log('  ' + new Date(d.dateMs).toDateString());
  d.events.forEach(function (e) {
    if (e.container) return;
    console.log('     ' + hm(e.start).slice(4) + '  ' + pad(e.name, 24) +
      (e.end > e.start ? 'until ' + hm(e.end).slice(4) : ''));
  });
});
console.log('  out of the oven ' + hm(fwd.params.finishAt));

near('the first thing to do lands exactly on the start time', fwd.events[0].start, START, 0.001);
ok('nothing at all is scheduled before it',
  fwd.events.every(function (e) { return e.start >= START - 1; }));
ok('the finish falls out of the plan rather than being asked for',
  fwd.params.finishAt > START && fwd.params.direction === 'forward');
var fBulk = fwd.events.filter(function (e) { return e.chain && e.type === 'bulk'; })[0];
near('bulk is still 1 ÷ r(T) and nothing else',
  fBulk.end, fBulk.start + M.hoursAt(22) * P.HOUR, 0.001);
var fFolds = fwd.events.filter(function (e) { return e.kind === 'rep'; });
ok('all four coil folds are inside the bulk window', fFolds.length === 4 &&
  fFolds.every(function (e) { return e.start >= fBulk.start && e.start <= fBulk.end; }));
ok('an active starter skips the revival feeds',
  fwd.events.filter(function (e) { return e.feedRole === 'revival'; }).length === 0);
ok('a fridge starter does not',
  P.planForward(TPL, { startAt: START, bulkTempC: 22, fromFridge: true })
    .events.filter(function (e) { return e.feedRole === 'revival'; }).length === 2);

/* The same stages either way. A forward plan is the reverse plan seen from
 * the other end, not a second set of arithmetic. */
var back = P.planBackwards(TPL, { finishAt: fwd.params.finishAt, bulkTempC: 22, fromFridge: false });
ok('forwards and backwards produce the same events in the same order',
  fwd.events.length === back.events.length &&
  fwd.events.every(function (e, i) { return e.name === back.events[i].name; }));

ok('a 09:00 start is called out for putting shaping in the small hours',
  fwd.problems.some(function (p) { return p.kind === 'from-start'; }));
ok('and it is not silently planned — a later start is costed',
  fwd.options.length === 1 && fwd.options[0].kind === 'start-later');
var fixed = P.planForward(TPL, {
  startAt: fwd.options[0].startAt, bulkTempC: 22, fromFridge: false
});
console.log('  escape: ' + fwd.options[0].text);
ok('the escape it offers actually clears the night', fixed.problems.length === 0);
ok('and it is a later start, never an impossible earlier one', fwd.options[0].startAt > START);
ok('no hands-on step in the fixed plan lands at night',
  fixed.events.every(function (e) { return !(e.handsOn && P.isNight(e.start)); }));

var lateStart = P.planForward(TPL, { startAt: at(2026, 8, 18, 22, 0), bulkTempC: 22, fromFridge: false });
ok('the step you are about to do is not reported back to you as a problem',
  lateStart.problems.every(function (p) { return p.text.indexOf('Mix + autolyse at 22:00') < 0; }));

var committed = P.commitPlan(fwd, 'Forward bake');
ok('a forward plan commits like any other', committed.status === 'active' &&
  committed.events.every(function (e) { return e.plannedStart != null && e.actualStart === null; }));
var ftl = P.projectTimeline(committed, START, null);
ok('and reconciles through the same projection',
  ftl.chain.length === back.events.filter(function (e) { return e.chain; }).length && !ftl.started);

head('AVERAGE TEMP — the planner default from the last bake');
var avg = P.averageTemp([
  { id: 'a', t: 0, temp: 24, rise: null },
  { id: 'b', t: 2 * P.HOUR, temp: 24, rise: null },
  { id: 'c', t: 4 * P.HOUR, temp: 20, rise: null }
]);
near('time weighted, not a plain mean', avg * 60000, 23 * 60000, 0.001);
ok('no readings gives null', P.averageTemp([]) === null);

console.log('\n' + (fail ? 'FAILED ' + fail + ' / ' + (pass + fail) : 'All ' + pass + ' assertions passed.'));
process.exit(fail ? 1 : 0);
