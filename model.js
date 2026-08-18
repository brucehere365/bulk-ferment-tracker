/* Bulk Ferment Tracker — model.
 *
 * Pure functions only: no DOM, no storage, no clocks of its own.
 * Loadable in the browser (window.BFModel) and in node (require).
 *
 * Core idea: fermentation is accumulated as a fraction of a bulk completed.
 * Never "start time + N hours" — that is only correct if the temperature
 * never moves, and the temperature always moves.
 */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BFModel = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function () {
  'use strict';

  var MS_PER_HOUR = 3600000;

  /* The Sourdough Journey — Dough Temping Guide.
   * Single source of truth. Both curves are fitted from this at load. */
  var TABLE = [
    { c: 27,   hours: 5.5, rise: 30  },
    { c: 26,   hours: 5.5, rise: 30  },
    { c: 25.5, hours: 6,   rise: 40  },
    { c: 25,   hours: 6,   rise: 40  },
    { c: 24.5, hours: 7,   rise: 50  },
    { c: 24,   hours: 7,   rise: 50  },
    { c: 23,   hours: 8,   rise: 55  },
    { c: 22.5, hours: 9,   rise: 60  },
    { c: 22,   hours: 10,  rise: 65  },
    { c: 21.5, hours: 11,  rise: 70  },
    { c: 21,   hours: 12,  rise: 75  },
    { c: 20.5, hours: 13,  rise: 80  },
    { c: 20,   hours: 14,  rise: 85  },
    { c: 19.5, hours: 15,  rise: 90  },
    { c: 19,   hours: 16,  rise: 95  },
    { c: 18,   hours: 17,  rise: 100 }
  ];

  var TEMP_MIN = 10, TEMP_MAX = 35;          // hard input clamp
  var TABLE_MIN = 18, TABLE_MAX = 27;        // outside this we flag "extrapolated"
  var RISE_MIN = 25, RISE_MAX = 120;         // sanity clamp on extrapolated targets
  var GAP_MINUTES = 90;                      // ask about unattended stretches longer than this
  var CAL_MIN = 0.6, CAL_MAX = 1.6, CAL_DAMP = 0.5;
  var MIN_CAL_PROGRESS = 0.05;               // below this, a rise reading is mostly noise

  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }
  function clampTemp(t) { return clamp(t, TEMP_MIN, TEMP_MAX); }

  /* Least squares of ln(y) against x  ->  y = a * exp(b * x).
   * r2 is measured on the log scale (that is what was actually fitted);
   * maxResid / rmse are reported back in natural units so they mean something. */
  function fitLogLinear(pts) {
    var n = pts.length, i, sx = 0, sy = 0, sxx = 0, sxy = 0;
    var ly = pts.map(function (p) { return Math.log(p.y); });
    for (i = 0; i < n; i++) {
      sx += pts[i].x; sy += ly[i];
      sxx += pts[i].x * pts[i].x; sxy += pts[i].x * ly[i];
    }
    var b = (n * sxy - sx * sy) / (n * sxx - sx * sx);
    var lnA = (sy - b * sx) / n;
    var mean = sy / n, ssRes = 0, ssTot = 0, maxResid = 0, sqErr = 0;
    for (i = 0; i < n; i++) {
      var pred = lnA + b * pts[i].x;
      ssRes += Math.pow(ly[i] - pred, 2);
      ssTot += Math.pow(ly[i] - mean, 2);
      var natural = Math.exp(pred) - pts[i].y;
      sqErr += natural * natural;
      if (Math.abs(natural) > Math.abs(maxResid)) maxResid = natural;
    }
    return {
      a: Math.exp(lnA), b: b,
      r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot,
      maxResid: maxResid,
      rmse: Math.sqrt(sqErr / n)
    };
  }

  /* rate = fraction of a bulk completed per hour */
  var RATE_FIT = fitLogLinear(TABLE.map(function (r) { return { x: r.c, y: 1 / r.hours }; }));
  /* target rise % at end of bulk, fitted the same way */
  var RISE_FIT = fitLogLinear(TABLE.map(function (r) { return { x: r.c, y: r.rise }; }));

  function rateAt(tempC) {
    var t = clampTemp(tempC);
    return RATE_FIT.a * Math.exp(RATE_FIT.b * t);
  }
  function hoursAt(tempC) { return 1 / rateAt(tempC); }
  function targetRisePct(tempC) {
    var t = clampTemp(tempC);
    return clamp(RISE_FIT.a * Math.exp(RISE_FIT.b * t), RISE_MIN, RISE_MAX);
  }
  function isExtrapolated(tempC) { return tempC < TABLE_MIN || tempC > TABLE_MAX; }

  /* Straight table interpolation — not used by the app, kept so the tests can
   * show how far the fitted curves sit from the printed rows. */
  function tableInterp(tempC, key) {
    var rows = TABLE.slice().sort(function (a, b) { return a.c - b.c; });
    var t = clampTemp(tempC);
    if (t <= rows[0].c) return rows[0][key];
    if (t >= rows[rows.length - 1].c) return rows[rows.length - 1][key];
    for (var i = 1; i < rows.length; i++) {
      if (t <= rows[i].c) {
        var lo = rows[i - 1], hi = rows[i];
        var f = (t - lo.c) / (hi.c - lo.c);
        return lo[key] + f * (hi[key] - lo[key]);
      }
    }
    return rows[rows.length - 1][key];
  }

  // ---------------------------------------------------------------- readings

  /* A reading: { id, t (ms epoch), temp (°C|null), rise (%|null), gapTemp (°C|null), note }
   * gapTemp means "the dough actually sat at this temp for the whole stretch
   * between the previous reading and this one" — it overrides the trapezoid
   * across that one interval.
   * ignoreCal keeps a jar reading on the chart but stops it steering the
   * projection — that is what the one-tap calibration reset sets. */
  function sortReadings(readings) {
    return readings.slice().sort(function (a, b) { return a.t - b.t; });
  }

  /* Rejects a reading that would land before the one it follows. */
  function validateReading(readings, candidate) {
    if (candidate.temp == null && candidate.rise == null) {
      return { ok: false, message: 'A reading needs a temperature or a rise %.' };
    }
    if (candidate.temp != null && (!isFinite(candidate.temp) || candidate.temp < TEMP_MIN || candidate.temp > TEMP_MAX)) {
      return { ok: false, message: 'Temperature must be between ' + TEMP_MIN + ' and ' + TEMP_MAX + ' °C.' };
    }
    if (candidate.rise != null && (!isFinite(candidate.rise) || candidate.rise < 0 || candidate.rise > 400)) {
      return { ok: false, message: 'Rise % must be between 0 and 400.' };
    }
    var others = readings.filter(function (r) { return r.id !== candidate.id; });
    if (!others.length) return { ok: true };
    var times = others.map(function (r) { return r.t; });
    var start = Math.min.apply(null, times);
    var last = Math.max.apply(null, times);
    var isEdit = readings.some(function (r) { return r.id === candidate.id; });
    if (candidate.t < start) {
      return { ok: false, message: 'That is before the bake started. Readings have to move forward.' };
    }
    if (!isEdit && candidate.t < last) {
      return { ok: false, message: 'That is before your last reading. Readings have to move forward.' };
    }
    if (isEdit) {
      /* An edited reading has to stay between its neighbours. */
      var before = times.filter(function (t) { return t <= candidate.t; });
      var orig = readings.filter(function (r) { return r.id === candidate.id; })[0];
      var origBefore = times.filter(function (t) { return t < orig.t; }).length;
      if (before.length !== origBefore) {
        return { ok: false, message: 'That time would reorder your readings. Keep it between the ones either side.' };
      }
    }
    return { ok: true };
  }

  // -------------------------------------------------------------- accumulator

  /* Replays every reading from scratch. Edits and deletes never patch state —
   * they just call this again. Calibration is causal: a factor learned at
   * reading k only affects intervals after k. */
  function replay(readings) {
    var rs = sortReadings(readings);
    var points = [], calEvents = [];
    var cal = 1, progress = 0, tableProgress = 0, curTemp = null;

    for (var i = 0; i < rs.length; i++) {
      var r = rs[i];
      if (r.temp != null) curTemp = clampTemp(r.temp);

      if (i > 0 && curTemp != null) {
        var dtH = (r.t - rs[i - 1].t) / MS_PER_HOUR;
        var prevTemp = points[i - 1].temp;
        var rA, rB;
        if (r.gapTemp != null) {
          rA = rB = rateAt(r.gapTemp);           // whole gap held at the interim temp
        } else {
          rA = rateAt(prevTemp); rB = rateAt(curTemp);
        }
        var dP = dtH * (rA + rB) / 2;            // trapezoid
        tableProgress += dP;
        progress += dP * cal;
      }

      if (r.rise != null && curTemp != null && !r.ignoreCal) {
        var target = targetRisePct(curTemp);
        var observedProgress = r.rise / target;
        if (tableProgress >= MIN_CAL_PROGRESS) {
          /* Measured against the *uncalibrated* table progress, so repeated
           * jar readings converge on one factor instead of compounding. */
          var raw = observedProgress / tableProgress;
          var capped = clamp(raw, CAL_MIN, CAL_MAX);
          var next = clamp(cal + CAL_DAMP * (capped - cal), CAL_MIN, CAL_MAX);
          calEvents.push({ t: r.t, raw: raw, from: cal, to: next, observedProgress: observedProgress, modelProgress: progress });
          cal = next;
        } else {
          calEvents.push({ t: r.t, raw: null, from: cal, to: cal, skipped: 'too-early' });
        }
      }

      points.push({
        id: r.id, t: r.t, temp: curTemp, enteredTemp: r.temp, rise: r.rise, gapTemp: r.gapTemp,
        progress: progress, tableProgress: tableProgress, cal: cal,
        target: curTemp == null ? null : targetRisePct(curTemp),
        modeledRise: curTemp == null ? null : progress * targetRisePct(curTemp)
      });
    }

    return {
      points: points, progress: progress, tableProgress: tableProgress,
      cal: cal, calEvents: calEvents,
      startedAt: rs.length ? rs[0].t : null,
      lastAt: rs.length ? rs[rs.length - 1].t : null,
      currentTemp: curTemp
    };
  }

  /* Everything the live view needs, derived from stored timestamps + `now`.
   * Nothing here depends on an interval having ticked. */
  function stateAt(readings, now) {
    var rep = replay(readings);
    if (!rep.points.length || rep.currentTemp == null) {
      return { empty: true, replay: rep, progress: 0, cal: 1 };
    }
    var last = rep.points[rep.points.length - 1];
    var sinceLastMs = Math.max(0, now - last.t);
    var rNow = rateAt(last.temp) * rep.cal;                 // calibrated rate
    var progress = rep.progress + (sinceLastMs / MS_PER_HOUR) * rNow;
    var target = targetRisePct(last.temp);
    var predictedEnd = last.t + ((1 - rep.progress) / rNow) * MS_PER_HOUR;

    return {
      empty: false,
      replay: rep,
      currentTemp: last.temp,
      progress: progress,
      progressPct: progress * 100,
      ready: progress >= 1,
      target: target,
      expectedRise: progress * target,
      rateNow: rNow,
      hoursNow: 1 / rNow,
      predictedEnd: predictedEnd,
      msRemaining: predictedEnd - now,
      cal: rep.cal,
      calibrated: Math.abs(rep.cal - 1) > 0.005,
      extrapolated: isExtrapolated(last.temp),
      sinceLastMs: sinceLastMs,
      gapPending: sinceLastMs > GAP_MINUTES * 60000,
      startedAt: rep.startedAt,
      lastAt: last.t,
      elapsedMs: now - rep.startedAt
    };
  }

  /* Plain language for the calibration factor. cal > 1 = rising faster than the table. */
  function calibrationPhrase(cal) {
    var pct = Math.round(Math.abs(cal - 1) * 100);
    if (pct < 3) return 'Tracking the table.';
    return 'Running about ' + pct + '% ' + (cal > 1 ? 'faster' : 'slower') + ' than the table.';
  }

  // ------------------------------------------------------------------ series

  /* Dense samples for the chart. Historical part follows the same linear-rate
   * assumption the trapezoid makes, so the drawn curve and the number agree. */
  function buildSeries(readings, now, opts) {
    opts = opts || {};
    var rep = replay(readings);
    if (!rep.points.length || rep.currentTemp == null) return null;
    var pts = rep.points;
    var hist = [];

    function push(t, progress, temp) {
      hist.push({ t: t, progress: progress, temp: temp, rise: progress * targetRisePct(temp) });
    }

    push(pts[0].t, pts[0].progress, pts[0].temp);
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dtH = (b.t - a.t) / MS_PER_HOUR;
      var flat = b.gapTemp != null;
      var tA = flat ? clampTemp(b.gapTemp) : a.temp;
      var tB = flat ? clampTemp(b.gapTemp) : b.temp;
      var rA = rateAt(tA), rB = rateAt(tB);
      var steps = Math.max(2, Math.min(120, Math.ceil(dtH * 12)));
      for (var s = 1; s <= steps; s++) {
        var f = s / steps, h = dtH * f;
        var rMid = rA + (rB - rA) * f;
        var prog = a.progress + a.cal * h * (rA + rMid) / 2;
        var temp = tA + (tB - tA) * f;
        if (flat && s === steps) temp = b.temp;   // land on the real reading
        push(a.t + (b.t - a.t) * f, prog, temp);
      }
    }

    /* last reading -> now, holding the last temp */
    var st = stateAt(readings, now);
    if (now > rep.lastAt) {
      var steps2 = Math.max(2, Math.min(120, Math.ceil(st.sinceLastMs / MS_PER_HOUR * 12)));
      for (var k = 1; k <= steps2; k++) {
        var t2 = rep.lastAt + (now - rep.lastAt) * (k / steps2);
        var p2 = rep.progress + ((t2 - rep.lastAt) / MS_PER_HOUR) * st.rateNow;
        push(t2, p2, st.currentTemp);
      }
    }

    /* projection forward, holding the current temp */
    var proj = [];
    if (!st.ready) {
      proj.push({ t: now, progress: st.progress, rise: st.expectedRise, temp: st.currentTemp });
      proj.push({ t: st.predictedEnd, progress: 1, rise: st.target, temp: st.currentTemp });
    }

    return {
      history: hist,
      projection: proj,
      observed: pts.filter(function (p) { return p.rise != null; })
                   .map(function (p) { return { t: p.t, rise: p.rise, progress: p.progress }; }),
      tempMarks: pts.filter(function (p) { return p.enteredTemp != null; })
                    .map(function (p) { return { t: p.t, temp: p.temp }; }),
      state: st
    };
  }

  return {
    MS_PER_HOUR: MS_PER_HOUR, TABLE: TABLE,
    TEMP_MIN: TEMP_MIN, TEMP_MAX: TEMP_MAX, TABLE_MIN: TABLE_MIN, TABLE_MAX: TABLE_MAX,
    GAP_MINUTES: GAP_MINUTES, CAL_MIN: CAL_MIN, CAL_MAX: CAL_MAX, CAL_DAMP: CAL_DAMP,
    MIN_CAL_PROGRESS: MIN_CAL_PROGRESS,
    RATE_FIT: RATE_FIT, RISE_FIT: RISE_FIT,
    fitLogLinear: fitLogLinear, clamp: clamp, clampTemp: clampTemp,
    rateAt: rateAt, hoursAt: hoursAt, targetRisePct: targetRisePct,
    isExtrapolated: isExtrapolated, tableInterp: tableInterp,
    sortReadings: sortReadings, validateReading: validateReading,
    replay: replay, stateAt: stateAt, buildSeries: buildSeries,
    calibrationPhrase: calibrationPhrase
  };
});
