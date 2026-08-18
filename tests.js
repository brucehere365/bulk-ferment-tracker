/* node tests.js — model tests + worked scenarios you can eyeball. */
'use strict';
var M = require('./model.js');
var H = M.MS_PER_HOUR;

var pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ok   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (extra ? '  ' + extra : '')); }
}
function near(name, got, want, tol) {
  var d = Math.abs(got - want);
  ok(name + '  (got ' + round(got, 4) + ', want ' + want + ' ±' + tol + ')', d <= tol);
}
function round(v, n) { var p = Math.pow(10, n || 2); return Math.round(v * p) / p; }
function head(s) { console.log('\n' + s + '\n' + '-'.repeat(s.length)); }

var T0 = Date.UTC(2026, 7, 18, 8, 0, 0);   // fixed clock: readings are all relative to this
var idc = 0;
function R(hoursIn, temp, rise, extra) {
  var r = { id: 'r' + (++idc), t: T0 + hoursIn * H, temp: temp == null ? null : temp, rise: rise == null ? null : rise, gapTemp: null };
  if (extra) Object.keys(extra).forEach(function (k) { r[k] = extra[k]; });
  return r;
}
function hm(ms) {
  var neg = ms < 0; ms = Math.abs(ms);
  var mins = Math.round(ms / 60000);
  return (neg ? '-' : '') + Math.floor(mins / 60) + 'h' + String(mins % 60).padStart(2, '0');
}
function clock(ms) { return new Date(ms).toISOString().slice(11, 16) + 'Z'; }

// ------------------------------------------------------------------ fit
head('CURVE FIT');
console.log('  rate  r(T) = ' + round(M.RATE_FIT.a, 6) + ' * exp(' + round(M.RATE_FIT.b, 5) + ' * T)   R² = ' + round(M.RATE_FIT.r2, 4) + '   rmse ' + round(M.RATE_FIT.rmse, 4) + '/h');
console.log('  rise  P(T) = ' + round(M.RISE_FIT.a, 2) + ' * exp(' + round(M.RISE_FIT.b, 5) + ' * T)   R² = ' + round(M.RISE_FIT.r2, 4) + '   rmse ' + round(M.RISE_FIT.rmse, 2) + ' pp');
console.log('');
console.log('    °C | table h | fit h | Δ     | table % | fit % | Δ');
M.TABLE.slice().sort(function (a, b) { return a.c - b.c; }).forEach(function (r) {
  var fh = M.hoursAt(r.c), fr = M.targetRisePct(r.c);
  console.log('  ' + String(r.c).padStart(4) + ' | ' + r.hours.toFixed(1).padStart(7) + ' | ' + fh.toFixed(2).padStart(5) +
    ' | ' + (fh - r.hours).toFixed(2).padStart(5) + ' | ' + String(r.rise).padStart(7) + ' | ' + fr.toFixed(1).padStart(5) +
    ' | ' + (fr - r.rise).toFixed(1).padStart(5));
});

head('FIT TESTS');
ok('rate fit R² > 0.97', M.RATE_FIT.r2 > 0.97, 'r2=' + M.RATE_FIT.r2);
ok('rise fit R² > 0.95', M.RISE_FIT.r2 > 0.95, 'r2=' + M.RISE_FIT.r2);
ok('rate is monotonic in temperature', (function () {
  for (var t = 10; t < 35; t += 0.25) if (M.rateAt(t) >= M.rateAt(t + 0.25)) return false;
  return true;
})());
ok('target rise falls as temp rises', M.targetRisePct(19) > M.targetRisePct(24));
near('hours at 22 °C ≈ table 10', M.hoursAt(22), 10, 0.35);
near('hours at 25.5 °C ≈ table 6', M.hoursAt(25.5), 6, 0.35);
near('target rise at 22 °C ≈ table 65', M.targetRisePct(22), 65, 3);
ok('input clamped below 10 °C', M.rateAt(4) === M.rateAt(10));
ok('input clamped above 35 °C', M.rateAt(50) === M.rateAt(35));
ok('18–27 °C is not flagged extrapolated', !M.isExtrapolated(18) && !M.isExtrapolated(27) && !M.isExtrapolated(22));
ok('outside the table is flagged extrapolated', M.isExtrapolated(17.9) && M.isExtrapolated(27.1));

// ------------------------------------------------------------ accumulator
head('ACCUMULATOR TESTS');
(function () {
  var rs = [R(0, 22), R(5, 22)];
  var rep = M.replay(rs);
  near('steady 22 °C for 5h ≈ 5/10.03 of a bulk', rep.progress, 5 / M.hoursAt(22), 1e-9);
})();
(function () {
  // trapezoid across a ramp: 20 -> 24 over 4h
  var rs = [R(0, 20), R(4, 24)];
  var rep = M.replay(rs);
  near('ramp 20→24 over 4h uses the trapezoid', rep.progress, 4 * (M.rateAt(20) + M.rateAt(24)) / 2, 1e-12);
})();
(function () {
  var rs = [R(0, 22), R(1, 22), R(2, 22), R(3, 22)];
  var a = M.replay(rs).progress;
  var b = M.replay([R(0, 22), R(3, 22)]).progress;
  near('splitting a steady interval changes nothing', a, b, 1e-9);
})();
(function () {
  // time spent warm is never given back
  var warmThenCold = M.replay([R(0, 26), R(3, 26), R(3.001, 19)]);
  var coldOnly = M.replay([R(0, 19), R(3.001, 19)]);
  ok('warm hours stay banked when it turns cold', warmThenCold.progress > coldOnly.progress * 2.5);
})();
(function () {
  var rs = [R(0, 22), R(2, 22, null, { gapTemp: 17 })];
  var withGap = M.replay(rs).progress;
  var without = M.replay([R(0, 22), R(2, 22)]).progress;
  ok('an interim gap temp is applied across the whole gap', withGap < without);
  near('gap interval integrates at the interim temp', withGap, 2 * M.rateAt(17), 1e-12);
})();
(function () {
  var rs = [R(0, 22), R(3, 22), R(6, 22)];
  var full = M.replay(rs).progress;
  var deleted = M.replay([rs[0], rs[2]]).progress;
  near('deleting a mid reading replays to the same answer', deleted, full, 1e-9);
  var shuffled = M.replay([rs[2], rs[0], rs[1]]).progress;
  near('readings out of array order are sorted before replay', shuffled, full, 1e-9);
})();

head('VALIDATION TESTS');
(function () {
  var rs = [R(0, 22), R(3, 22)];
  var vMid = M.validateReading(rs, { id: 'x', t: T0 + 1 * H, temp: 22 });
  ok('a new reading before the previous one is rejected', !vMid.ok);
  console.log('       message: "' + vMid.message + '"');
  var v = M.validateReading(rs, { id: 'x', t: T0 - 1 * H, temp: 22 });
  ok('a reading before the bake start is rejected', !v.ok);
  console.log('       message: "' + v.message + '"');
  ok('a later reading is accepted', M.validateReading(rs, { id: 'x', t: T0 + 4 * H, temp: 22 }).ok);
  ok('an empty reading is rejected', !M.validateReading(rs, { id: 'x', t: T0 + 4 * H }).ok);
  ok('an absurd temperature is rejected', !M.validateReading(rs, { id: 'x', t: T0 + 4 * H, temp: 90 }).ok);
  ok('editing a reading in place is allowed', M.validateReading(rs, { id: rs[1].id, t: T0 + 2 * H, temp: 23 }).ok);
  ok('editing a reading past its neighbour is rejected',
    !M.validateReading([R(0, 22), R(3, 22), R(6, 22)], { id: 'r' + (idc - 1), t: T0 + 7 * H, temp: 22 }).ok);
})();

head('CALIBRATION TESTS');
(function () {
  // 5h at 22 °C -> table progress 0.4986, target 63.1 % -> table expects ~31.4 % rise.
  // Jar says 40 % -> observed progress 0.634 -> raw factor 1.27, damped to 1.135.
  var rs = [R(0, 22), R(5, 22, 40)];
  var rep = M.replay(rs);
  var ev = rep.calEvents[0];
  console.log('  raw factor ' + round(ev.raw, 3) + ' -> applied ' + round(ev.to, 3) + '   "' + M.calibrationPhrase(rep.cal) + '"');
  ok('a fast jar reading pushes the factor above 1', rep.cal > 1);
  near('damping moves halfway, not all the way', rep.cal, 1 + 0.5 * (ev.raw - 1), 1e-9);
  ok('factor stays inside 0.6–1.6', rep.cal >= M.CAL_MIN && rep.cal <= M.CAL_MAX);
})();
(function () {
  var rs = [R(0, 22), R(5, 22, 200)];   // absurd jar reading
  ok('one wild reading cannot blow up the projection', M.replay(rs).cal <= M.CAL_MAX);
  var rs2 = [R(0, 22), R(5, 22, 1)];
  ok('one dead jar reading cannot stall the projection', M.replay(rs2).cal >= M.CAL_MIN);
})();
(function () {
  var rs = [R(0, 22), R(0.2, 22, 2)];
  ok('a jar reading too early to mean anything is skipped', M.replay(rs).cal === 1 && M.replay(rs).calEvents[0].skipped === 'too-early');
})();
(function () {
  // repeated consistent readings converge, they do not compound
  var rs = [R(0, 22)];
  for (var h = 2; h <= 8; h += 2) rs.push(R(h, 22, 1.27 * (h / M.hoursAt(22)) * M.targetRisePct(22)));
  var cal = M.replay(rs).cal;
  near('repeated consistent jar readings converge on the true factor', cal, 1.27, 0.02);
})();
(function () {
  var rs = [R(0, 22), R(5, 22, 40, { ignoreCal: true })];
  var rep = M.replay(rs);
  ok('reset calibration keeps the jar dot but drops its influence',
    rep.cal === 1 && rep.points[1].rise === 40 && rep.calEvents.length === 0);
})();
(function () {
  var rs = [R(0, 22), R(5, 22, 40), R(10, 22)];
  var st = M.stateAt(rs, T0 + 10 * H);
  var un = M.stateAt([R(0, 22), R(10, 22)], T0 + 10 * H);
  ok('calibration applies only to intervals after the jar reading', st.progress > un.progress && st.progress < un.progress * 1.135);
})();

head('PREDICTION TESTS');
(function () {
  var rs = [R(0, 22)];
  var st = M.stateAt(rs, T0);
  near('at t=0 the estimate is the table duration for that temp', st.msRemaining / H, M.hoursAt(22), 1e-9);
  var st2 = M.stateAt(rs, T0 + 5 * H);
  near('5h in at a steady temp, half the bulk is left', st2.msRemaining / H, M.hoursAt(22) - 5, 1e-9);
  near('predicted end does not move at a steady temp', st2.predictedEnd, st.predictedEnd, 1e-6);
})();
(function () {
  var rs = [R(0, 24), R(3, 19)];
  var st = M.stateAt(rs, T0 + 3 * H);
  ok('a cold snap pushes the end later', st.predictedEnd > T0 + M.hoursAt(24) * H);
  ok('but not as late as a cold start would (warm hours are banked)', st.predictedEnd < T0 + M.hoursAt(19) * H);
})();
(function () {
  var st = M.stateAt([R(0, 22), R(12, 22)], T0 + 12 * H);
  ok('past 100 % the state reads ready', st.ready && st.progress > 1);
})();
(function () {
  var st = M.stateAt([R(0, 22)], T0 + 3 * H);
  ok('a 3h silence raises the gap question', st.gapPending);
  ok('a fresh reading does not', !M.stateAt([R(0, 22)], T0 + 30 * 60000).gapPending);
})();
(function () {
  // backgrounded tab: state comes from timestamps, not from ticking
  var rs = [R(0, 22), R(2, 23)];
  var a = M.stateAt(rs, T0 + 9 * H);
  var b = M.stateAt(rs, T0 + 9 * H);
  ok('state is a pure function of readings + now', a.progress === b.progress && a.predictedEnd === b.predictedEnd);
})();

// ------------------------------------------------------------- scenarios
function scenario(title, readings, now, notes) {
  head('SCENARIO — ' + title);
  if (notes) console.log('  ' + notes + '\n');
  var rep = M.replay(readings);
  console.log('   elapsed | temp  | entry        | progress | target% | modelled rise%');
  rep.points.forEach(function (p) {
    var entry = [];
    if (p.enteredTemp != null) entry.push('temp ' + p.enteredTemp + '°');
    if (p.rise != null) entry.push('jar ' + p.rise + '%');
    if (p.gapTemp != null) entry.push('gap@' + p.gapTemp + '°');
    console.log('  ' + hm(p.t - rep.startedAt).padStart(8) + ' | ' + (p.temp.toFixed(1) + '°').padStart(5) + ' | ' +
      entry.join(' + ').padEnd(12) + ' | ' + (round(p.progress * 100, 1) + '%').padStart(8) + ' | ' +
      (round(p.target, 1) + '%').padStart(7) + ' | ' + (round(p.modeledRise, 1) + '%').padStart(14));
  });
  var st = M.stateAt(readings, now);
  console.log('');
  console.log('  now                 ' + clock(now) + '  (' + hm(now - rep.startedAt) + ' into the bulk)');
  console.log('  progress            ' + round(st.progress * 100, 1) + '%');
  console.log('  dough temp          ' + round(st.currentTemp, 1) + '°C' + (st.extrapolated ? '  (extrapolated)' : ''));
  console.log('  target rise now     ' + round(st.target, 1) + '%');
  console.log('  expected rise now   ' + round(st.expectedRise, 1) + '%');
  console.log('  calibration         ' + round(st.cal, 3) + '  — ' + M.calibrationPhrase(st.cal));
  console.log('  predicted preshape  ' + clock(st.predictedEnd) + '   in ' + hm(st.msRemaining));
  console.log('  naive lookup says   ' + clock(rep.startedAt + M.hoursAt(readings[0].temp) * H) + '   (start + ' + round(M.hoursAt(readings[0].temp), 2) + 'h at the starting temp)');
  return st;
}

var s1 = scenario('steady 22 °C', [R(0, 22), R(2, 22), R(4, 22), R(6, 22)], T0 + 6 * H,
  'Nothing moves. The accumulator should agree exactly with the lookup table.');
near('steady scenario: predicted end = start + hours(22)', (s1.predictedEnd - T0) / H, M.hoursAt(22), 1e-9);

var s2 = scenario('24 °C for 3h, then dropping to 19 °C',
  [R(0, 24), R(1.5, 24), R(3, 24), R(4, 21.5), R(5, 19), R(7, 19)], T0 + 7 * H,
  'Warm start banks progress fast; the cold night stretches what is left.\nThe estimate must land well before a cold-start lookup would say.');
ok('cold-snap scenario ends later than the warm lookup', (s2.predictedEnd - T0) / H > M.hoursAt(24));
ok('cold-snap scenario ends earlier than a 19 °C bulk from scratch', (s2.predictedEnd - T0) / H < M.hoursAt(19));

var s3 = scenario('22 °C with a jar reading that says it is running fast',
  [R(0, 22), R(2, 22), R(4, 22), R(5, 22, 40), R(6, 22)], T0 + 6 * H,
  'At 5h the table expects ~31 % rise. The jar says 40 %. Factor is damped, not snapped,\nand only speeds up the hours after the reading.');
ok('fast jar reading pulls preshape earlier', s3.predictedEnd < T0 + M.hoursAt(22) * H);
ok('calibration is reported in plain language', /faster/.test(M.calibrationPhrase(s3.cal)));

var s4 = scenario('overnight gap, answered "it was cooler"',
  [R(0, 21), R(1, 21), R(8, 18, null, { gapTemp: 18.5 }), R(9, 18)], T0 + 9 * H,
  'Slept through 7 hours. The interim 18.5 °C is applied across the whole gap\ninstead of pretending it held at 21 °C.');
var s4b = M.stateAt([R(0, 21), R(1, 21), R(8, 18), R(9, 18)], T0 + 9 * H);
console.log('  without the gap answer, progress would read ' + round(s4b.progress * 100, 1) + '% instead of ' + round(s4.progress * 100, 1) + '%');
ok('answering the gap question lowers progress vs assuming the old temp held', s4.progress < s4b.progress);

head('SERIES / CHART DATA');
(function () {
  var rs = [R(0, 24), R(3, 24), R(5, 19)];
  var ser = M.buildSeries(rs, T0 + 6 * H);
  ok('series is monotonic in progress', ser.history.every(function (p, i, a) { return i === 0 || p.progress >= a[i - 1].progress - 1e-12; }));
  ok('series ends at now', Math.abs(ser.history[ser.history.length - 1].t - (T0 + 6 * H)) < 1);
  ok('series final progress matches stateAt', Math.abs(ser.history[ser.history.length - 1].progress - ser.state.progress) < 1e-9);
  ok('projection runs from now to the predicted end', ser.projection.length === 2 && Math.abs(ser.projection[1].t - ser.state.predictedEnd) < 1);
  ok('projection lands on the target rise', Math.abs(ser.projection[1].rise - ser.state.target) < 1e-9);
  var slopeWarm = (function () { var a = ser.history[2], b = ser.history[3]; return (b.progress - a.progress) / (b.t - a.t); })();
  var slopeCold = (function () { var n = ser.history.length; var a = ser.history[n - 3], b = ser.history[n - 2]; return (b.progress - a.progress) / (b.t - a.t); })();
  ok('the curve visibly bends when the temperature drops', slopeCold < slopeWarm * 0.6);
})();

console.log('\n' + '='.repeat(56));
console.log(fail === 0 ? 'ALL ' + pass + ' TESTS PASSED' : pass + ' passed, ' + fail + ' FAILED');
console.log('='.repeat(56));
process.exit(fail ? 1 : 0);
