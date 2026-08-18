/* Bulk Ferment Tracker — process model.
 *
 * Templates, the reverse planner, timeline projection and .ics export.
 * Pure functions only: no DOM, no storage, no clocks of its own — `now` and
 * `finishAt` are always passed in.
 *
 * This module never predicts a bulk itself. Bulk duration is always
 * BFModel.hoursAt(T) — the fitted rate curve — and once a bulk is running the
 * live accumulator's predictedEnd replaces the estimate outright.
 */
(function (root, factory) {
  var M = (typeof module === 'object' && module.exports) ? require('./model.js') : root.BFModel;
  var api = factory(M);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.BFProcess = api;
})(typeof globalThis !== 'undefined' ? globalThis : null, function (M) {
  'use strict';

  var MIN = 60000, HOUR = 3600000;

  /* Anything hands-on landing in here is a plan that will not survive contact
   * with a real week. 23:00–06:00 local. */
  var NIGHT_START = 23, NIGHT_END = 6;
  /* Where a night-time starter feed gets pushed back to. */
  var EVENING_HOUR = 21;

  var TYPES = ['starter-feed', 'fixed', 'active', 'repeat', 'bulk', 'cold-proof', 'bake'];

  var TYPE_LABEL = {
    'starter-feed': 'Starter feed', 'fixed': 'Fixed timer', 'active': 'Hands-on',
    'repeat': 'Repeats', 'bulk': 'Bulk ferment', 'cold-proof': 'Cold proof', 'bake': 'Bake'
  };

  /* Hands-on by default? A `fixed` stage still needs you at its start — that is
   * the moment you mix, or cover, or set the timer. A bulk does not: it simply
   * begins when the knead ends. Every stage can override this. */
  var HANDS_ON_DEFAULT = {
    'starter-feed': true, 'fixed': true, 'active': true, 'repeat': true,
    'bulk': false, 'cold-proof': true, 'bake': true
  };

  function clone(o) { return JSON.parse(JSON.stringify(o)); }
  function uid(p) { return (p || 'x') + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function num(v, d) { var n = parseFloat(v); return isFinite(n) ? n : d; }

  // ------------------------------------------------------------- template

  /* Bruce's Loaf. Every number here is a starting point, not a spec — the
   * editor can change all of it, and the seed is re-derivable from this file. */
  function defaultTemplate() {
    return normalizeTemplate({
      id: 'tpl-bruce',
      name: "Bruce's Loaf",
      description: '500 g flour · 320 g water · 100 g starter · 10 g salt.',
      builtin: true,
      stages: [
        {
          id: 's-revive', type: 'starter-feed', name: 'Starter revival', role: 'revival',
          feeds: 2, gapHours: 12, ratio: '1:5:5', peakHours: 6, fridgeOnly: true,
          notes: 'Only if the starter is coming out of the fridge. Two feeds, twelve hours apart, to wake it back up.',
          cues: ['Doubling reliably between feeds', 'Domed and bubbly', 'Smells sweet and sour, not sharp']
        },
        {
          id: 's-final-feed', type: 'starter-feed', name: 'Final starter feed', role: 'final',
          feeds: 1, gapHours: 12, ratio: '1:5:5', peakHours: 6, peakAtStageId: 's-add',
          notes: 'Time this one so the starter is at peak the moment it goes into the dough.',
          cues: ['Domed, not collapsed', 'Bubbles all the way through the jar', 'Floats in water']
        },
        {
          id: 's-mix', type: 'fixed', name: 'Mix + autolyse', durationMin: 60,
          notes: '500 g flour, 320 g hot tap water. Knead briefly to bring it together, then cover it.',
          cues: ['Elastic', 'Settled — no dry flour left']
        },
        {
          id: 's-add', type: 'active', name: 'Add starter + salt', durationMin: 10,
          notes: 'Flatten the dough out. Spread 100 g active starter and 10 g salt over it, then fold and knead until it is all incorporated.',
          cues: []
        },
        {
          id: 's-rest', type: 'fixed', name: 'Rest', durationMin: 15, handsOn: false,
          notes: 'Covered. Let it relax before the real knead.', cues: []
        },
        {
          id: 's-knead', type: 'active', name: 'Proper knead', durationMin: 5,
          notes: 'The consistency should come together nicely here.',
          cues: ['Comes together smooth and cohesive']
        },
        {
          id: 's-bulk', type: 'bulk', name: 'Bulk ferment', targetTempC: 24,
          notes: 'Target 24 °C. Colder is fine — it just takes longer, and the tracker works out how much longer.',
          cues: ['Domed, not flat', 'Jiggles as one mass', 'Bubbles visible at the edges and surface', 'Feels alive and airy, not soupy']
        },
        {
          id: 's-folds', type: 'repeat', name: 'Coil folds', reps: 4, intervalMin: 30,
          duringStageId: 's-bulk', offsetMin: 0,
          notes: 'Wet hands. Lift the dough from the middle, let it tuck under itself. Quarter turn and repeat.',
          cues: []
        },
        {
          id: 's-shape', type: 'active', name: 'Shape', durationMin: 20,
          notes: 'Shape it and get it into the banneton or a lined bowl, seam up.', cues: []
        },
        {
          id: 's-cold', type: 'cold-proof', name: 'Cold proof', minMin: 480, maxMin: 960,
          notes: 'Into the fridge, overnight. This is the part of the schedule that can stretch.',
          cues: ['Cold right through', 'Holds a poke and springs back slowly']
        },
        {
          id: 's-bake', type: 'bake', name: 'Bake', preheatMin: 60,
          steps: [
            { id: 'b1', label: 'Covered', tempC: 230, durationMin: 30 },
            { id: 'b2', label: 'Uncovered', tempC: 220, durationMin: 15 }
          ],
          notes: 'Dutch oven, straight from the fridge. An ice cube dropped in alongside gives you steam — blisters and a better spring.',
          cues: []
        }
      ]
    });
  }

  function normalizeStage(s) {
    var t = TYPES.indexOf(s.type) >= 0 ? s.type : 'fixed';
    var o = {
      id: s.id || uid('s'),
      type: t,
      name: (s.name || TYPE_LABEL[t] || 'Stage').toString(),
      notes: s.notes == null ? '' : String(s.notes),
      cues: Array.isArray(s.cues) ? s.cues.filter(function (c) { return String(c).trim(); }).map(String) : [],
      handsOn: s.handsOn == null ? HANDS_ON_DEFAULT[t] : !!s.handsOn
    };
    if (t === 'fixed') o.durationMin = Math.max(0, num(s.durationMin, 30));
    if (t === 'active') o.durationMin = s.durationMin == null || s.durationMin === '' ? null : Math.max(0, num(s.durationMin, 10));
    if (t === 'repeat') {
      o.reps = Math.max(1, Math.round(num(s.reps, 4)));
      o.intervalMin = Math.max(1, num(s.intervalMin, 30));
      o.duringStageId = s.duringStageId || null;
      o.offsetMin = Math.max(0, num(s.offsetMin, 0));
    }
    if (t === 'bulk') o.targetTempC = num(s.targetTempC, 24);
    if (t === 'cold-proof') {
      o.minMin = Math.max(0, num(s.minMin, 480));
      o.maxMin = Math.max(o.minMin, num(s.maxMin, 960));
    }
    if (t === 'bake') {
      o.preheatMin = Math.max(0, num(s.preheatMin, 60));
      var steps = Array.isArray(s.steps) && s.steps.length ? s.steps : [{ label: 'Bake', tempC: 230, durationMin: 40 }];
      o.steps = steps.map(function (b) {
        return {
          id: b.id || uid('b'), label: b.label || 'Step',
          tempC: num(b.tempC, 230), durationMin: Math.max(0, num(b.durationMin, 20))
        };
      });
    }
    if (t === 'starter-feed') {
      o.role = s.role === 'revival' ? 'revival' : 'final';
      o.feeds = Math.max(1, Math.round(num(s.feeds, o.role === 'revival' ? 2 : 1)));
      o.gapHours = Math.max(0.5, num(s.gapHours, 12));
      o.peakHours = Math.max(0.5, num(s.peakHours, 6));
      o.ratio = s.ratio == null ? '1:5:5' : String(s.ratio);
      o.fridgeOnly = o.role === 'revival' ? (s.fridgeOnly == null ? true : !!s.fridgeOnly) : !!s.fridgeOnly;
      o.peakAtStageId = s.peakAtStageId || null;
    }
    return o;
  }

  function normalizeTemplate(t) {
    t = t || {};
    var stages = (Array.isArray(t.stages) ? t.stages : []).map(normalizeStage);
    var ids = {};
    stages.forEach(function (s) { ids[s.id] = true; });
    /* Reordering is safe because references are by id; deleting is not, so
     * dangling references are dropped here rather than blowing up the planner. */
    stages.forEach(function (s) {
      if (s.duringStageId && !ids[s.duringStageId]) s.duringStageId = null;
      if (s.peakAtStageId && !ids[s.peakAtStageId]) s.peakAtStageId = null;
    });
    return {
      id: t.id || uid('tpl'),
      name: t.name || 'Untitled process',
      description: t.description == null ? '' : String(t.description),
      builtin: !!t.builtin,
      updatedAt: t.updatedAt || Date.now(),
      stages: stages
    };
  }

  function duplicateTemplate(t, name) {
    var c = normalizeTemplate(clone(t));
    var map = {};
    c.stages.forEach(function (s) { var n = uid('s'); map[s.id] = n; s.id = n; });
    c.stages.forEach(function (s) {
      if (s.duringStageId) s.duringStageId = map[s.duringStageId] || null;
      if (s.peakAtStageId) s.peakAtStageId = map[s.peakAtStageId] || null;
    });
    c.id = uid('tpl'); c.builtin = false;
    c.name = name || (t.name + ' copy');
    c.updatedAt = Date.now();
    return c;
  }

  function blankStage(type) {
    return normalizeStage({ type: type, name: TYPE_LABEL[type] || 'Stage' });
  }

  // ------------------------------------------------------------ durations

  /* Minutes a stage occupies in the chain. `ctx.bulkTempC` and `ctx.coldMin`
   * are the two knobs the planner turns. */
  function stageDurationMin(stage, ctx) {
    ctx = ctx || {};
    switch (stage.type) {
      case 'fixed': return stage.durationMin;
      case 'active': return stage.durationMin == null ? 0 : stage.durationMin;
      case 'bulk': return M.hoursAt(ctx.bulkTempC == null ? stage.targetTempC : ctx.bulkTempC) * 60;
      case 'cold-proof': return ctx.coldMin == null ? (stage.minMin + stage.maxMin) / 2 : ctx.coldMin;
      case 'bake': return stage.steps.reduce(function (a, b) { return a + b.durationMin; }, 0);
      case 'repeat': return stage.duringStageId ? 0 : Math.max(0, (stage.reps - 1) * stage.intervalMin);
      default: return 0;
    }
  }

  /* Stages that occupy the dough's timeline, in order. Starter feeds sit on
   * their own chain and folds hang off their host, so neither is in here. */
  function chainStages(template) {
    return template.stages.filter(function (s) {
      if (s.type === 'starter-feed') return false;
      if (s.type === 'repeat' && s.duringStageId) return false;
      return true;
    });
  }

  function findStage(template, id) {
    return template.stages.filter(function (s) { return s.id === id; })[0] || null;
  }

  // ---------------------------------------------------------------- lines

  /* One line of what-to-do, for the timeline rows and the .ics description. */
  function firstLine(s) {
    var n = (s.notes || '').trim();
    if (!n) return '';
    var m = n.match(/^[^.!?\n]+[.!?]?/);
    return (m ? m[0] : n).trim();
  }

  function detailFor(stage, extra) {
    switch (stage.type) {
      case 'bulk': return extra && extra.hours != null
        ? 'About ' + fmtHours(extra.hours) + ' at ' + n1(extra.tempC) + ' °C — the tracker re-reads it as you log temperatures.'
        : firstLine(stage);
      case 'cold-proof': return 'Fridge for ' + fmtHours((extra && extra.min != null ? extra.min : stage.minMin) / 60) + '.';
      case 'starter-feed': return 'Feed ' + stage.ratio + (extra && extra.peakAt ? ' — peak around ' + hhmm(extra.peakAt) : '');
      default: return firstLine(stage);
    }
  }

  function n1(v) { return (Math.round(v * 10) / 10).toString(); }
  function fmtHours(h) {
    var mins = Math.round(h * 60), hh = Math.floor(mins / 60), mm = mins % 60;
    return (hh ? hh + ' h' : '') + (hh && mm ? ' ' : '') + (mm ? mm + ' min' : (hh ? '' : '0 min'));
  }
  function hhmm(ms) {
    var d = new Date(ms);
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
  }

  // ------------------------------------------------------------ the pass

  function isNight(ms) {
    var h = new Date(ms).getHours();
    return h >= NIGHT_START || h < NIGHT_END;
  }

  /* The most recent EVENING_HOUR o'clock at or before `ms`. Where a night-time
   * starter feed gets moved to: the last civilised moment before it. */
  function previousEvening(ms) {
    var d = new Date(ms);
    var e = new Date(d.getFullYear(), d.getMonth(), d.getDate(), EVENING_HOUR, 0, 0, 0);
    if (e.getTime() > ms) e.setDate(e.getDate() - 1);
    return e.getTime();
  }

  function ev(o) {
    o.id = o.id || uid('e');
    o.cues = o.cues || [];
    o.actualStart = null; o.actualEnd = null; o.log = '';
    return o;
  }

  /* One backwards walk. Deterministic: same inputs, same times out.
   * Returns the flattened event list plus the chain start. */
  function backwardsPass(template, opts) {
    var finishAt = opts.finishAt;
    var ctx = { bulkTempC: opts.bulkTempC, coldMin: opts.coldMin };
    var chain = chainStages(template);
    var events = [];
    var starts = {}, ends = {};

    var cursor = finishAt;
    for (var i = chain.length - 1; i >= 0; i--) {
      var s = chain[i];
      var dur = stageDurationMin(s, ctx);
      var end = cursor, start = end - dur * MIN;
      starts[s.id] = start; ends[s.id] = end;
      cursor = start;
    }

    /* Everything from the moment the loaf leaves the fridge is pinned by the
     * finish time — flexing the cold proof cannot move it. */
    var coldStage = chain.filter(function (s) { return s.type === 'cold-proof'; })[0];
    var pinFrom = coldStage ? ends[coldStage.id] : finishAt;

    chain.forEach(function (s) {
      var start = starts[s.id], end = ends[s.id];
      var movable = start < pinFrom;

      if (s.type === 'bake') {
        if (s.preheatMin > 0) {
          events.push(ev({
            stageId: s.id, kind: 'preheat', type: 'bake', name: 'Preheat the oven',
            detail: 'Oven and dutch oven to ' + Math.round(s.steps[0].tempC) + ' °C.',
            notes: s.notes, cues: [], start: start - s.preheatMin * MIN, end: start,
            durationMin: s.preheatMin, chain: false, anchor: s.id, anchorOffsetMin: -s.preheatMin,
            handsOn: true, judgement: false, movable: false
          }));
        }
        var c = start;
        s.steps.forEach(function (b, bi) {
          events.push(ev({
            stageId: s.id, stepId: b.id, kind: 'bake-step', type: 'bake',
            name: s.name + ' — ' + b.label,
            detail: Math.round(b.tempC) + ' °C for ' + Math.round(b.durationMin) + ' min' + (bi === 0 ? '. Ice cube in for steam if you want blisters.' : '.'),
            notes: bi === 0 ? s.notes : '', cues: bi === s.steps.length - 1 ? s.cues : [],
            start: c, end: c + b.durationMin * MIN, durationMin: b.durationMin,
            chain: false, anchor: s.id, anchorOffsetMin: (c - start) / MIN,
            tempC: b.tempC, handsOn: true, judgement: false, movable: false
          }));
          c += b.durationMin * MIN;
        });
      }

      var extra = s.type === 'bulk' ? { hours: (end - start) / HOUR, tempC: ctx.bulkTempC == null ? s.targetTempC : ctx.bulkTempC }
        : s.type === 'cold-proof' ? { min: (end - start) / MIN } : null;

      events.push(ev({
        stageId: s.id, kind: 'stage', type: s.type, name: s.name,
        detail: detailFor(s, extra), notes: s.notes, cues: s.cues,
        start: start, end: end, durationMin: (end - start) / MIN,
        chain: true, chainIndex: chain.indexOf(s),
        /* A bake owns its sub-steps: the timeline nests them under this row
         * rather than repeating the same window twice. */
        container: s.type === 'bake' && s.steps.length > 0,
        handsOn: s.handsOn, movable: movable,
        judgement: s.type === 'bulk' || s.type === 'cold-proof' || s.cues.length > 0,
        bulkTempC: s.type === 'bulk' ? (ctx.bulkTempC == null ? s.targetTempC : ctx.bulkTempC) : undefined,
        coldMinMin: s.type === 'cold-proof' ? s.minMin : undefined,
        coldMaxMin: s.type === 'cold-proof' ? s.maxMin : undefined
      }));
    });

    /* Repeats that run inside another stage — folds during bulk. */
    template.stages.forEach(function (s) {
      if (s.type !== 'repeat' || !s.duringStageId) return;
      var hostStart = starts[s.duringStageId];
      if (hostStart == null) return;
      for (var r = 0; r < s.reps; r++) {
        var off = s.offsetMin + r * s.intervalMin;
        var t = hostStart + off * MIN;
        events.push(ev({
          stageId: s.id, kind: 'rep', type: 'repeat',
          name: s.name + ' ' + (r + 1) + '/' + s.reps,
          detail: firstLine(s), notes: s.notes, cues: s.cues,
          start: t, end: t, durationMin: 0,
          chain: false, anchor: s.duringStageId, anchorOffsetMin: off,
          repIndex: r, repCount: s.reps,
          handsOn: s.handsOn, judgement: s.cues.length > 0,
          movable: t < pinFrom
        }));
      }
    });

    /* Starter feeds. The final feed is placed so peak lands exactly when the
     * dough asks for it; revival feeds chain backwards from there. */
    var feedTargets = {};
    template.stages.forEach(function (s) {
      if (s.type !== 'starter-feed' || s.role !== 'final') return;
      var anchorId = s.peakAtStageId || (chain.filter(function (c) { return c.type === 'bulk'; })[0] || {}).id;
      var neededAt = starts[anchorId] != null ? starts[anchorId] : cursor;
      feedTargets[s.id] = neededAt;
      var at = neededAt - s.peakHours * HOUR;
      events.push(ev({
        stageId: s.id, kind: 'feed', type: 'starter-feed', name: s.name,
        detail: detailFor(s, { peakAt: at + s.peakHours * HOUR }), notes: s.notes, cues: s.cues,
        start: at, end: at, durationMin: 0, chain: false, feedIndex: 0, feedRole: 'final',
        peakAt: at + s.peakHours * HOUR, neededAt: neededAt, peakHours: s.peakHours,
        anchorStageId: anchorId,
        handsOn: s.handsOn, judgement: s.cues.length > 0, movable: true
      }));
    });

    template.stages.forEach(function (s) {
      if (s.type !== 'starter-feed' || s.role !== 'revival') return;
      if (s.fridgeOnly && !opts.fromFridge) return;
      /* Revival hangs off the earliest final feed; without one, off the chain start. */
      var finals = events.filter(function (e) { return e.feedRole === 'final'; })
        .sort(function (a, b) { return a.start - b.start; });
      var anchorAt = finals.length ? finals[0].start : cursor;
      for (var f = s.feeds; f >= 1; f--) {
        var at = anchorAt - f * s.gapHours * HOUR;
        events.push(ev({
          stageId: s.id, kind: 'feed', type: 'starter-feed',
          name: s.name + ' ' + (s.feeds - f + 1) + '/' + s.feeds,
          detail: 'Feed ' + s.ratio + '. ' + firstLine(s), notes: s.notes, cues: s.cues,
          start: at, end: at, durationMin: 0, chain: false,
          feedIndex: s.feeds - f, feedRole: 'revival', revivalBackFrom: f * s.gapHours,
          handsOn: s.handsOn, judgement: false, movable: true
        }));
      }
    });

    events.sort(function (a, b) { return a.start - b.start || (a.chain === b.chain ? 0 : a.chain ? 1 : -1); });
    return { events: events, chainStart: cursor, starts: starts, ends: ends, coldMin: opts.coldMin };
  }

  /* Naming every offending step is a wall of text, and a wall of text at 3am
   * is the same as saying nothing. Name the first few and count the rest. */
  function nameTimes(list, cap) {
    return list.slice(0, cap).map(function (e) { return e.name + ' at ' + hhmm(e.start); }).join(', ') +
      (list.length > cap ? ', and ' + (list.length - cap) + ' more' : '');
  }

  function nightHits(events, movableOnly) {
    return events.filter(function (e) {
      if (!e.handsOn) return false;
      if (movableOnly && !e.movable) return false;
      if (e.kind === 'feed') return false;          // feeds get their own pass
      return isNight(e.start);
    });
  }

  // --------------------------------------------------------------- planner

  /* Reverse planner. Walks the template backwards from the finish time, then
   * uses the cold proof as a shock absorber to push hands-on work out of the
   * middle of the night. Returns everything needed to explain itself. */
  function planBackwards(template, opts) {
    template = normalizeTemplate(template);
    opts = opts || {};
    var finishAt = opts.finishAt;
    var bulkTempC = num(opts.bulkTempC, 22);
    var fromFridge = !!opts.fromFridge;

    var cold = chainStages(template).filter(function (s) { return s.type === 'cold-proof'; })[0] || null;
    var baseCold = cold ? (cold.minMin + cold.maxMin) / 2 : null;

    function run(coldMin) {
      return backwardsPass(template, {
        finishAt: finishAt, bulkTempC: bulkTempC, coldMin: coldMin, fromFridge: fromFridge
      });
    }

    var adjustments = [], problems = [], options = [];
    var chosenCold = baseCold;
    var pass = run(baseCold);
    var hits = nightHits(pass.events, true);

    /* The shock absorber. Scan the whole allowed cold-proof range on a
     * 15-minute grid; prefer a clean plan, then the smallest change. */
    if (hits.length && cold) {
      var best = null;
      for (var c = cold.minMin; c <= cold.maxMin + 0.001; c += 15) {
        var cand = run(c);
        var h = nightHits(cand.events, true).length;
        var score = [h, Math.abs(c - baseCold)];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
          best = { coldMin: c, pass: cand, hits: h, score: score };
        }
      }
      if (best && best.hits < hits.length) {
        chosenCold = best.coldMin; pass = best.pass;
        var delta = best.coldMin - baseCold;
        adjustments.push({
          kind: 'cold-proof',
          text: 'Cold proof ' + (delta > 0 ? 'stretched to ' : 'squeezed to ') + fmtHours(best.coldMin / 60) +
            ' (' + (delta > 0 ? '+' : '') + Math.round(delta) + ' min on the midpoint) to keep the bench work out of the night.'
        });
      }
      hits = nightHits(pass.events, true);
    }

    /* Still stuck. Say so plainly and cost out the ways out. */
    if (hits.length) {
      problems.push({
        kind: 'unsociable',
        text: 'The cold proof cannot absorb this. ' + nameTimes(hits, 3) + '.'
      });
      options = escapeOptions(template, {
        finishAt: finishAt, bulkTempC: bulkTempC, fromFridge: fromFridge,
        cold: cold, baseCold: baseCold
      });
    }

    /* Anything pinned by the finish time that lands at night is the user's own
     * choice of bake time — flag it, do not pretend to fix it. */
    var pinnedNight = pass.events.filter(function (e) {
      return e.handsOn && !e.movable && e.kind !== 'feed' && isNight(e.start);
    });
    if (pinnedNight.length) {
      problems.push({
        kind: 'pinned-night',
        text: nameTimes(pinnedNight, 3) +
          ' — that follows straight from the finish time you asked for. Move the bake time to move it.'
      });
    }

    /* Feeds. A feed at 04:15 is not a schedule, it is an alarm clock. */
    var events = pass.events;
    var finalFeeds = events.filter(function (e) { return e.feedRole === 'final'; });
    var shifted = false;
    finalFeeds.forEach(function (f) {
      if (!isNight(f.start)) return;
      var was = f.start;
      var moved = previousEvening(was);
      var needH = (f.neededAt - moved) / HOUR;
      f.start = f.end = moved;
      f.peakAt = f.neededAt;
      f.movedFrom = was;
      f.requiredPeakHours = needH;
      f.detail = 'Feed ' + (findStage(template, f.stageId) || {}).ratio + ' — needs about ' + fmtHours(needH) + ' to peak from here.';
      shifted = true;
      adjustments.push({
        kind: 'feed',
        text: f.name + ' moved from ' + hhmm(was) + ' to ' + hhmm(moved) + '. That is ' + fmtHours(needH) +
          ' before you need it, not ' + fmtHours(f.peakHours) + ' — feed it stiffer or stand it somewhere cooler, or accept it slightly past peak.'
      });
    });

    /* Revival feeds hang off the final feed, so they move with it. */
    if (shifted) {
      var earliestFinal = finalFeeds.slice().sort(function (a, b) { return a.start - b.start; })[0];
      events.forEach(function (e) {
        if (e.feedRole !== 'revival') return;
        e.start = e.end = earliestFinal.start - e.revivalBackFrom * HOUR;
      });
    }
    events.forEach(function (e) {
      if (e.feedRole !== 'revival' || !isNight(e.start)) return;
      var was2 = e.start;
      e.start = e.end = previousEvening(was2);
      adjustments.push({ kind: 'feed', text: e.name + ' moved from ' + hhmm(was2) + ' to ' + hhmm(e.start) + ' to keep it off the night shift.' });
    });

    events.sort(function (a, b) { return a.start - b.start || (a.chain === b.chain ? 0 : a.chain ? 1 : -1); });

    return {
      template: template,
      events: events,
      days: groupByDay(events),
      adjustments: adjustments,
      problems: problems,
      options: options,
      params: {
        finishAt: finishAt, bulkTempC: bulkTempC, fromFridge: fromFridge,
        coldMin: chosenCold, baseColdMin: baseCold,
        bulkHours: M.hoursAt(bulkTempC), templateId: template.id
      }
    };
  }

  /* When the cold proof runs out of give: three concrete ways out, each with
   * the number attached. No option is offered unless it actually works. */
  function escapeOptions(template, o) {
    var out = [];
    function clean(bulkTempC, finishAt) {
      var range = o.cold ? [o.cold.minMin, o.cold.maxMin] : [o.baseCold, o.baseCold];
      var step = o.cold ? 15 : 1;
      for (var c = range[0]; c <= range[1] + 0.001; c += step) {
        var p = backwardsPass(template, { finishAt: finishAt, bulkTempC: bulkTempC, coldMin: c, fromFridge: o.fromFridge });
        if (!nightHits(p.events, true).length) return { coldMin: c, pass: p };
      }
      return null;
    }
    var t;
    for (t = o.bulkTempC - 0.5; t >= 16; t -= 0.5) {
      if (clean(t, o.finishAt)) {
        out.push({
          kind: 'cooler-bulk', bulkTempC: t,
          text: 'Bulk at ' + n1(t) + ' °C instead of ' + n1(o.bulkTempC) + ' — ' + fmtHours(M.hoursAt(t)) +
            ' rather than ' + fmtHours(M.hoursAt(o.bulkTempC)) + ', so the mix starts earlier in the day.'
        });
        break;
      }
    }
    for (t = o.bulkTempC + 0.5; t <= 28; t += 0.5) {
      if (clean(t, o.finishAt)) {
        out.push({
          kind: 'warmer-bulk', bulkTempC: t,
          text: 'Bulk at ' + n1(t) + ' °C instead of ' + n1(o.bulkTempC) + ' — ' + fmtHours(M.hoursAt(t)) +
            ' rather than ' + fmtHours(M.hoursAt(o.bulkTempC)) + ', so the mix starts later in the day.'
        });
        break;
      }
    }
    var bestShift = null;
    for (var d = 15; d <= 360; d += 15) {
      [-1, 1].forEach(function (sign) {
        if (bestShift) return;
        var f = o.finishAt + sign * d * MIN;
        if (clean(o.bulkTempC, f)) bestShift = { finishAt: f, shiftMin: sign * d };
      });
      if (bestShift) break;
    }
    if (bestShift) {
      out.push({
        kind: 'bake-time', finishAt: bestShift.finishAt,
        text: 'Out of the oven at ' + hhmm(bestShift.finishAt) + ' instead — ' +
          Math.abs(bestShift.shiftMin) + ' min ' + (bestShift.shiftMin > 0 ? 'later' : 'earlier') + ' clears it.'
      });
    }
    return out;
  }

  // -------------------------------------------------------- forward planner

  /* Forward planner. Same walk as the reverse one, anchored at the front
   * instead of the back: the first thing you have to do lands on `startAt` and
   * the loaf comes out of the oven whenever it comes out. This is what a full
   * bake needs — you pick the loaf, not the deadline — so the schedule has to
   * fall out of "now" rather than out of a finish time.
   *
   * It reuses `backwardsPass` rather than walking the stages a second time.
   * Once bulkTempC and coldMin are fixed every offset inside a pass is fixed
   * too, so the whole plan is linear in finishAt: one probe measures the lead
   * time, a second run lands it on the start. One planner, one arithmetic. */
  function planForward(template, opts) {
    template = normalizeTemplate(template);
    opts = opts || {};
    var startAt = opts.startAt == null ? Date.now() : opts.startAt;
    var bulkTempC = num(opts.bulkTempC, 22);
    var fromFridge = !!opts.fromFridge;

    var cold = chainStages(template).filter(function (s) { return s.type === 'cold-proof'; })[0] || null;
    var baseCold = cold ? (cold.minMin + cold.maxMin) / 2 : null;

    function anchored(coldMin) {
      function run(finishAt) {
        return backwardsPass(template, {
          finishAt: finishAt, bulkTempC: bulkTempC, coldMin: coldMin, fromFridge: fromFridge
        });
      }
      var probe = run(startAt);
      if (!probe.events.length) return probe;
      return run(startAt + (startAt - probe.events[0].start));
    }

    /* The pinning is the mirror image of the reverse plan's. There the finish
     * time nails everything from the fridge onwards; here the start time nails
     * everything up to it, and the bake is what floats. `movable` in a pass
     * means "before the cold proof ends", so the steps the cold proof can still
     * rescue are exactly the ones the pass calls unmovable. */
    function lateNight(events) {
      return events.filter(function (e) {
        return e.handsOn && !e.movable && e.kind !== 'feed' && isNight(e.start);
      });
    }

    var adjustments = [], problems = [];
    var chosenCold = baseCold;
    var pass = anchored(baseCold);
    var hits = lateNight(pass.events);

    if (hits.length && cold) {
      var best = null;
      for (var c = cold.minMin; c <= cold.maxMin + 0.001; c += 15) {
        var cand = anchored(c);
        var h = lateNight(cand.events).length;
        var score = [h, Math.abs(c - baseCold)];
        if (!best || score[0] < best.score[0] || (score[0] === best.score[0] && score[1] < best.score[1])) {
          best = { coldMin: c, pass: cand, hits: h, score: score };
        }
      }
      if (best && best.hits < hits.length) {
        chosenCold = best.coldMin; pass = best.pass;
        var delta = best.coldMin - baseCold;
        adjustments.push({
          kind: 'cold-proof',
          text: 'Cold proof ' + (delta > 0 ? 'stretched to ' : 'squeezed to ') + fmtHours(best.coldMin / 60) +
            ' (' + (delta > 0 ? '+' : '') + Math.round(delta) + ' min on the midpoint) so the oven is not on in the middle of the night.'
        });
      }
      hits = lateNight(pass.events);
    }

    if (hits.length) {
      problems.push({
        kind: 'unsociable',
        text: 'The cold proof cannot absorb this. ' + nameTimes(hits, 3) + '.'
      });
    }

    /* Everything before the fridge follows straight from starting now, and the
     * step you are about to do is not news. Report the rest; do not pretend the
     * schedule can move a start time you chose. */
    var early = pass.events.filter(function (e) {
      return e.handsOn && e.movable && e.start > startAt && isNight(e.start);
    });
    if (early.length) {
      problems.push({
        kind: 'from-start',
        text: nameTimes(early, 3) +
          ' — that follows from starting now. Start later, or plan backwards from when you want the loaf out.'
      });
    }

    /* One knob is genuinely free in a forward plan: when you start. If the
     * night cannot be cleared from now, find the smallest later start that
     * clears it. That is a real answer; "try again" is not. `probe` stops the
     * search recursing into itself. */
    var options = [];
    if (problems.length && !opts.probe) {
      for (var d = 30; d <= 720; d += 30) {
        var at = startAt + d * MIN;
        var cand2 = planForward(template, {
          startAt: at, bulkTempC: bulkTempC, fromFridge: fromFridge, probe: true
        });
        if (cand2.problems.length) continue;
        options.push({
          kind: 'start-later', startAt: at,
          text: 'Start at ' + hhmm(at) + ' instead — ' + fmtHours(d / 60) +
            ' from now, and nothing lands in the small hours.'
        });
        break;
      }
    }

    var events = pass.events;
    var finishAt = events.reduce(function (a, e) { return e.chain && e.end > a ? e.end : a; }, startAt);

    return {
      template: template,
      events: events,
      days: groupByDay(events),
      adjustments: adjustments,
      problems: problems,
      options: options,
      params: {
        direction: 'forward', startAt: startAt, finishAt: finishAt,
        bulkTempC: bulkTempC, fromFridge: fromFridge,
        coldMin: chosenCold, baseColdMin: baseCold,
        bulkHours: M.hoursAt(bulkTempC), templateId: template.id
      }
    };
  }

  function groupByDay(events) {
    var days = [], byKey = {};
    events.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (e) {
      var d = new Date(e.start);
      var key = d.getFullYear() + '-' + d.getMonth() + '-' + d.getDate();
      if (!byKey[key]) {
        byKey[key] = { key: key, dateMs: new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime(), events: [] };
        days.push(byKey[key]);
      }
      byKey[key].events.push(e);
    });
    return days;
  }

  // ------------------------------------------------------- live projection

  /* Reconciliation. Walks the committed event list and rebuilds every time from
   * whatever actually happened upstream. Real elapsed time always wins; a stage
   * that has not happened yet is pushed by the drift above it.
   *
   * `bulkState` is BFModel.stateAt(...) for the running bulk, or null. When it
   * is present the bulk's end comes from the accumulator, not from the plan. */
  function projectTimeline(bake, now, bulkState) {
    var events = bake.events.map(function (e) { return Object.assign({}, e); });
    var byId = {};
    events.forEach(function (e) { byId[e.id] = e; });

    var chain = events.filter(function (e) { return e.chain; })
      .sort(function (a, b) { return a.chainIndex - b.chainIndex; });

    var cursor = null;
    var starts = {};
    chain.forEach(function (e, i) {
      var start = e.actualStart != null ? e.actualStart
        : (cursor != null ? cursor : e.plannedStart != null ? e.plannedStart : e.start);
      var dur = e.durationMin * MIN;
      var end;
      if (e.actualEnd != null) {
        end = e.actualEnd;
      } else if (e.type === 'bulk' && bulkState && !bulkState.empty) {
        end = bulkState.predictedEnd;
        e.fromAccumulator = true;
      } else {
        end = start + dur;
      }
      if (end < start) end = start;
      e.start = start; e.end = end;
      starts[e.stageId] = start;
      cursor = end;
      e.order = i;
    });

    /* Satellites follow their anchor's live start. */
    events.forEach(function (e) {
      if (e.chain) return;
      if (e.anchor && starts[e.anchor] != null) {
        var base = starts[e.anchor] + (e.anchorOffsetMin || 0) * MIN;
        e.start = e.actualStart != null ? e.actualStart : base;
        e.end = e.actualEnd != null ? e.actualEnd : e.start + e.durationMin * MIN;
      } else if (e.actualStart != null) {
        e.start = e.actualStart;
        e.end = e.actualEnd != null ? e.actualEnd : e.start + e.durationMin * MIN;
      }
    });

    events.forEach(function (e) {
      e.status = e.actualEnd != null ? 'done'
        : e.actualStart != null ? 'running'
          : e.start <= now ? 'due' : 'future';
      e.ready = e.status === 'running' ? now >= e.end : false;
      if (e.type === 'bulk' && bulkState && !bulkState.empty && e.status === 'running') {
        e.ready = bulkState.ready;
      }
    });

    events.sort(function (a, b) { return a.start - b.start || (a.chain === b.chain ? 0 : a.chain ? 1 : -1); });

    /* Current = the first chain stage still open. Everything else on screen
     * hangs off this one. */
    var current = chain.filter(function (e) { return e.actualEnd == null; })[0] || null;
    var currentIdx = current ? chain.indexOf(current) : chain.length;
    var next = chain[currentIdx + 1] || null;
    /* Reps living inside the current stage — the sub-countdown under the bulk. */
    var subs = current ? events.filter(function (e) {
      return !e.chain && e.anchor === current.stageId && e.kind === 'rep';
    }).sort(function (a, b) { return a.start - b.start; }) : [];
    var nextSub = subs.filter(function (e) { return e.actualEnd == null; })[0] || null;

    return {
      events: events, chain: chain, current: current, next: next,
      subs: subs, nextSub: nextSub,
      started: chain.some(function (e) { return e.actualStart != null; }),
      finished: current == null,
      finishAt: chain.length ? chain[chain.length - 1].end : null
    };
  }

  /* Commit a plan as a live bake. Planned times are frozen alongside the live
   * ones so the timeline can show how far the day drifted. */
  function commitPlan(planResult, name) {
    var events = planResult.events.map(function (e) {
      var c = Object.assign({}, e);
      c.plannedStart = e.start; c.plannedEnd = e.end;
      c.actualStart = null; c.actualEnd = null; c.log = '';
      return c;
    });
    return {
      id: uid('pb'), name: name || planResult.template.name,
      templateId: planResult.template.id,
      template: clone(planResult.template),
      params: planResult.params,
      adjustments: planResult.adjustments,
      createdAt: Date.now(), status: 'active',
      events: events, bulkBakeId: null, notes: ''
    };
  }

  // ------------------------------------------------------------------ ics

  function icsEscape(s) {
    return String(s == null ? '' : s)
      .replace(/\\/g, '\\\\').replace(/;/g, '\;').replace(/,/g, '\\,')
      .replace(/\r?\n/g, '\\n');
  }
  function icsStamp(ms) {
    return new Date(ms).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
  }
  /* RFC 5545 wants lines folded at 75 octets; everything here is ASCII-ish so
   * counting characters is close enough and never splits mid-escape. */
  function fold(line) {
    if (line.length <= 74) return line;
    var out = [line.slice(0, 74)], rest = line.slice(74);
    while (rest.length > 73) { out.push(' ' + rest.slice(0, 73)); rest = rest.slice(73); }
    if (rest.length) out.push(' ' + rest);
    return out.join('\r\n');
  }

  function toICS(events, name, nowMs) {
    var now = icsStamp(nowMs == null ? Date.now() : nowMs);
    var L = ['BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Bulk Ferment Tracker//Process//EN',
      'CALSCALE:GREGORIAN', 'METHOD:PUBLISH', 'X-WR-CALNAME:' + icsEscape(name)];
    events.slice().sort(function (a, b) { return a.start - b.start; }).forEach(function (e) {
      if (e.container) return;              // its sub-steps carry the detail
      var start = e.start;
      /* A zero-length event is a moment, not a slot — give it 10 minutes so it
       * is actually visible in a calendar grid. */
      var end = e.end > e.start ? e.end : e.start + 10 * MIN;
      var desc = [e.detail, e.notes].filter(function (x) { return x && x.trim(); }).join('\n\n');
      if (e.cues && e.cues.length) desc += (desc ? '\n\n' : '') + 'Look for: ' + e.cues.join('; ');
      L.push('BEGIN:VEVENT');
      L.push('UID:' + e.id + '@bulkferment');
      L.push('DTSTAMP:' + now);
      L.push('DTSTART:' + icsStamp(start));
      L.push('DTEND:' + icsStamp(end));
      L.push(fold('SUMMARY:' + icsEscape(name + ' · ' + e.name)));
      if (desc) L.push(fold('DESCRIPTION:' + icsEscape(desc)));
      L.push('END:VEVENT');
    });
    L.push('END:VCALENDAR');
    return L.join('\r\n') + '\r\n';
  }

  // ---------------------------------------------------------------- misc

  /* Time-weighted mean dough temperature of a finished bulk — the default the
   * planner offers next time. */
  function averageTemp(readings) {
    var rs = M.sortReadings(readings || []).filter(function (r) { return r.temp != null; });
    if (!rs.length) return null;
    if (rs.length === 1) return rs[0].temp;
    var num2 = 0, den = 0;
    for (var i = 1; i < rs.length; i++) {
      var dt = rs[i].t - rs[i - 1].t;
      num2 += dt * (rs[i].temp + rs[i - 1].temp) / 2;
      den += dt;
    }
    return den ? num2 / den : rs[0].temp;
  }

  /* Move one row and let everything else fall in behind it. Chain rows drag the
   * whole downstream block; a fold or a feed moves on its own. */
  function nudgeEvent(planResult, eventId, newStart) {
    var e = planResult.events.filter(function (x) { return x.id === eventId; })[0];
    if (!e) return planResult;
    var delta = newStart - e.start;
    if (!delta) return planResult;
    if (e.chain) {
      var from = e.chainIndex;
      planResult.events.forEach(function (x) {
        var idx = x.chain ? x.chainIndex : (x.anchor ? chainIndexOf(planResult, x.anchor) : null);
        if (idx != null && idx >= from) { x.start += delta; x.end += delta; }
      });
    } else {
      e.start += delta; e.end += delta;
      e.anchorOffsetMin = e.anchor ? (e.anchorOffsetMin || 0) + delta / MIN : e.anchorOffsetMin;
    }
    planResult.events.sort(function (a, b) { return a.start - b.start; });
    planResult.days = groupByDay(planResult.events);
    planResult.nudged = true;
    return planResult;
  }
  function chainIndexOf(planResult, stageId) {
    var c = planResult.events.filter(function (x) { return x.chain && x.stageId === stageId; })[0];
    return c ? c.chainIndex : null;
  }

  return {
    MIN: MIN, HOUR: HOUR, TYPES: TYPES, TYPE_LABEL: TYPE_LABEL,
    NIGHT_START: NIGHT_START, NIGHT_END: NIGHT_END, EVENING_HOUR: EVENING_HOUR,
    defaultTemplate: defaultTemplate, normalizeTemplate: normalizeTemplate,
    normalizeStage: normalizeStage, duplicateTemplate: duplicateTemplate, blankStage: blankStage,
    stageDurationMin: stageDurationMin, chainStages: chainStages, findStage: findStage,
    isNight: isNight, previousEvening: previousEvening,
    backwardsPass: backwardsPass, planBackwards: planBackwards, planForward: planForward,
    groupByDay: groupByDay,
    projectTimeline: projectTimeline, commitPlan: commitPlan,
    toICS: toICS, averageTemp: averageTemp, nudgeEvent: nudgeEvent,
    fmtHours: fmtHours, firstLine: firstLine, uid: uid, clone: clone
  };
});
