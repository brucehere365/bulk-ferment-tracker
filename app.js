/* Bulk Ferment Tracker — UI.
 * All state lives in localStorage. Nothing about the bulk is derived from a
 * running timer: every number on screen is recomputed from stored timestamps,
 * so a backgrounded tab or a sleeping phone changes nothing. */
(function () {
  'use strict';

  var M = window.BFModel;
  var P = window.BFProcess;
  var H = M.MS_PER_HOUR;
  var MIN = 60000;
  var KEY = 'bft.v1';

  // ------------------------------------------------------------- storage
  function blank() {
    return {
      version: 2, activeId: null, bakes: [],
      templates: [P.defaultTemplate()], processes: [], activeProcessId: null, draft: null,
      settings: { leadMin: 30, sound: true, notify: false, wakeLock: true, useJar: true }
    };
  }
  var state = load();
  function load() {
    try {
      var raw = localStorage.getItem(KEY);
      if (!raw) return blank();
      var s = JSON.parse(raw);
      var d = blank();
      s.settings = Object.assign(d.settings, s.settings || {});
      s.bakes = s.bakes || [];
      /* v1 knew only about bulk ferments. Its bakes are untouched; it just
       * gains the seed template and an empty process list. */
      s.templates = (s.templates && s.templates.length ? s.templates : [P.defaultTemplate()]).map(P.normalizeTemplate);
      s.processes = s.processes || [];
      s.activeProcessId = s.activeProcessId || null;
      s.draft = s.draft || null;
      s.version = 2;
      return s;
    } catch (e) { console.warn('Could not read saved state, starting fresh.', e); return blank(); }
  }
  function activeProcess() {
    return state.processes.filter(function (p) { return p.id === state.activeProcessId; })[0] || null;
  }
  function findTemplate(id) {
    return state.templates.filter(function (t) { return t.id === id; })[0] || null;
  }
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); }
    catch (e) { toast('Could not save — storage is full or blocked.'); }
  }
  function uid() { return Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }
  function activeBake() {
    return state.bakes.filter(function (b) { return b.id === state.activeId; })[0] || null;
  }

  // -------------------------------------------------------------- format
  function two(n) { return String(n).padStart(2, '0'); }
  function clock(ms) { var d = new Date(ms); return two(d.getHours()) + ':' + two(d.getMinutes()); }
  function dayTag(ms, ref) {
    var a = new Date(ms), b = new Date(ref == null ? Date.now() : ref);
    var d = Math.round((new Date(a.getFullYear(), a.getMonth(), a.getDate()) - new Date(b.getFullYear(), b.getMonth(), b.getDate())) / 86400000);
    return d === 0 ? '' : d === 1 ? ' tomorrow' : d === -1 ? ' yesterday' : ' ' + a.toLocaleDateString(undefined, { weekday: 'short' });
  }
  function dur(ms) {
    var neg = ms < 0; ms = Math.abs(ms);
    var mins = Math.round(ms / 60000), h = Math.floor(mins / 60), m = mins % 60;
    return (neg ? '-' : '') + (h ? h + 'h ' : '') + m + 'm';
  }
  function dateStr(ms) { return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }); }
  function localInput(ms) {
    var d = new Date(ms - d0(ms));
    return d.toISOString().slice(0, 16);
  }
  function d0(ms) { return new Date(ms).getTimezoneOffset() * 60000; }
  function fromLocalInput(v) { var t = new Date(v).getTime(); return isNaN(t) ? null : t; }
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n1(v) { return (Math.round(v * 10) / 10).toString(); }

  var toastTimer;
  function toast(msg) {
    var el = document.getElementById('toast');
    el.textContent = msg; el.classList.add('on');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('on'); }, 2600);
  }

  // --------------------------------------------------------------- chart
  function chartSVG(readings, now, opts) {
    opts = opts || {};
    var ser = M.buildSeries(readings, now);
    if (!ser) return '<div class="chart-empty">No readings yet.</div>';
    var st = ser.state;
    var W = 360, HT = 236, padL = 34, padR = 34, padT = 14, padB = 26;
    var t0 = ser.history[0].t;
    var tEnd = opts.historic ? now : Math.max(now, st.predictedEnd);
    var span = Math.max(tEnd - t0, 45 * 60000);
    tEnd = t0 + span * 1.04;
    span = tEnd - t0;
    var X = function (t) { return padL + (t - t0) / span * (W - padL - padR); };

    var riseVals = ser.history.map(function (p) { return p.rise; })
      .concat(ser.observed.map(function (o) { return o.rise; }), [st.target, st.expectedRise, 10]);
    var yMax = Math.max.apply(null, riseVals) * 1.14;
    var Y = function (v) { return HT - padB - (v / yMax) * (HT - padB - padT); };

    var temps = ser.history.map(function (p) { return p.temp; });
    var tMin = Math.min.apply(null, temps), tMax = Math.max.apply(null, temps);
    if (tMax - tMin < 3) { var mid = (tMin + tMax) / 2; tMin = mid - 1.6; tMax = mid + 1.6; }
    else { var pd = (tMax - tMin) * 0.3; tMin -= pd; tMax += pd; }
    var Y2 = function (v) { return HT - padB - ((v - tMin) / (tMax - tMin)) * (HT - padB - padT); };

    function path(pts, acc) {
      return pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.t).toFixed(1) + ' ' + acc(p).toFixed(1); }).join(' ');
    }
    var s = [];
    s.push('<svg viewBox="0 0 ' + W + ' ' + HT + '" role="img" aria-label="Rise and temperature over time">');

    // rise gridlines + left axis
    var rStep = yMax <= 45 ? 10 : yMax <= 90 ? 20 : yMax <= 140 ? 25 : 50;
    for (var v = 0; v <= yMax; v += rStep) {
      s.push('<line x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(v).toFixed(1) + '" stroke="#2a2521" stroke-width="1"/>');
      s.push('<text x="' + (padL - 5) + '" y="' + (Y(v) + 3.5).toFixed(1) + '" fill="#7d746c" font-size="9.5" text-anchor="end">' + v + '</text>');
    }
    // time ticks
    var hSpan = span / H;
    var stepH = [0.5, 1, 2, 3, 4, 6, 8, 12].filter(function (x) { return hSpan / x <= 6; })[0] || 24;
    var base = new Date(t0); base.setMinutes(0, 0, 0);
    for (var t = base.getTime(); t <= tEnd; t += stepH * H) {
      if (t < t0) continue;
      s.push('<line x1="' + X(t).toFixed(1) + '" y1="' + padT + '" x2="' + X(t).toFixed(1) + '" y2="' + (HT - padB) + '" stroke="#221e1b" stroke-width="1"/>');
      s.push('<text x="' + X(t).toFixed(1) + '" y="' + (HT - padB + 13) + '" fill="#7d746c" font-size="9.5" text-anchor="middle">' + clock(t) + '</text>');
    }

    // target band — moves vertically with the current temperature
    var bandLo = Y(st.target * 1.04), bandHi = Y(st.target * 0.96);
    s.push('<rect x="' + padL + '" y="' + bandLo.toFixed(1) + '" width="' + (W - padL - padR) + '" height="' + Math.max(3, bandHi - bandLo).toFixed(1) + '" fill="#ff8f3f" opacity="0.13"/>');
    s.push('<line x1="' + padL + '" y1="' + Y(st.target).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(st.target).toFixed(1) + '" stroke="#ff8f3f" stroke-width="1" opacity="0.5" stroke-dasharray="1 3"/>');
    s.push('<text x="' + (padL + 3) + '" y="' + (Y(st.target) - 4).toFixed(1) + '" fill="#c9834c" font-size="9.5">target ' + Math.round(st.target) + '%</text>');

    // temperature, right axis — subdued context
    s.push('<path d="' + path(ser.history, function (p) { return Y2(p.temp); }) + '" fill="none" stroke="#79a7c4" stroke-width="1.2" opacity="0.75" stroke-linejoin="round"/>');
    ser.tempMarks.forEach(function (m) {
      s.push('<rect x="' + (X(m.t) - 2).toFixed(1) + '" y="' + (Y2(m.temp) - 2).toFixed(1) + '" width="4" height="4" fill="#79a7c4" opacity="0.95"/>');
    });
    [tMin + (tMax - tMin) * 0.12, (tMin + tMax) / 2, tMax - (tMax - tMin) * 0.12].forEach(function (tv) {
      s.push('<text x="' + (W - padR + 4) + '" y="' + (Y2(tv) + 3.5).toFixed(1) + '" fill="#5d7c91" font-size="9.5">' + n1(Math.round(tv * 2) / 2) + '°</text>');
    });

    // modelled rise so far
    s.push('<path d="' + path(ser.history, function (p) { return Y(p.rise); }) + '" fill="none" stroke="#ff8f3f" stroke-width="2.4" stroke-linejoin="round" stroke-linecap="round"/>');

    // projection
    if (ser.projection.length && !opts.historic) {
      s.push('<path d="' + path(ser.projection, function (p) { return Y(p.rise); }) + '" fill="none" stroke="#ff8f3f" stroke-width="2" stroke-dasharray="5 4" opacity="0.8"/>');
    }

    // jar readings
    ser.observed.forEach(function (o) {
      s.push('<circle cx="' + X(o.t).toFixed(1) + '" cy="' + Y(o.rise).toFixed(1) + '" r="4.6" fill="#12100e" stroke="#ffd166" stroke-width="2.2"/>');
    });

    // now
    s.push('<line x1="' + X(now).toFixed(1) + '" y1="' + padT + '" x2="' + X(now).toFixed(1) + '" y2="' + (HT - padB) + '" stroke="#f6f0e7" stroke-width="1" opacity="0.45" stroke-dasharray="2 3"/>');
    s.push('<text x="' + X(now).toFixed(1) + '" y="' + (padT - 4) + '" fill="#a49a90" font-size="9.5" text-anchor="' + (opts.historic ? 'end' : 'middle') + '">' + (opts.historic ? 'end' : 'now') + '</text>');

    // predicted end
    if (st.predictedEnd >= t0 && st.predictedEnd <= tEnd) {
      var xe = X(st.predictedEnd), ye = Y(st.target);
      s.push('<line x1="' + xe.toFixed(1) + '" y1="' + ye.toFixed(1) + '" x2="' + xe.toFixed(1) + '" y2="' + (HT - padB) + '" stroke="#ff8f3f" stroke-width="1" opacity="0.45"/>');
      s.push('<circle cx="' + xe.toFixed(1) + '" cy="' + ye.toFixed(1) + '" r="4" fill="#ff8f3f"/>');
      var right = xe > W * 0.6;
      s.push('<text x="' + (right ? xe - 6 : xe + 6).toFixed(1) + '" y="' + (ye + 15).toFixed(1) + '" fill="#ff8f3f" font-size="10.5" font-weight="600" text-anchor="' + (right ? 'end' : 'start') + '">' + clock(st.predictedEnd) + '</text>');
    }
    s.push('</svg>');

    return '<div class="chartwrap">' + s.join('') +
      '<div class="legend">' +
      '<span><i style="border-color:#ff8f3f"></i>rise %</span>' +
      (opts.historic ? '' : '<span><i style="border-color:#ff8f3f;border-top-style:dashed"></i>projected</span>') +
      (ser.observed.length ? '<span><i style="border:2px solid #ffd166;border-radius:50%;width:8px;height:8px;vertical-align:-1px"></i>jar reading</span>' : '') +
      '<span><i style="border-color:#79a7c4"></i>dough temp</span>' +
      '</div></div>';
  }

  // ---------------------------------------------------------------- views
  var view = 'home';
  var openBakeId = null;
  var editingTemplateId = null;
  var timelineOpen = true;

  var VIEWS = {
    home: function () { return homeView(); },
    start: function () { return startView(); },
    live: function () { return liveView(activeBake()); },
    history: function () { return historyView(); },
    templates: function () { return templatesView(); },
    editor: function () { return editorView(findTemplate(editingTemplateId)); },
    planner: function () { return plannerView(); },
    process: function () { return processView(activeProcess()); }
  };

  function render() {
    var app = document.getElementById('app');
    if (view === 'live' && !activeBake()) view = 'home';
    if (view === 'process' && !activeProcess()) view = 'home';
    if (view === 'editor' && !findTemplate(editingTemplateId)) view = 'templates';
    app.innerHTML = (VIEWS[view] || VIEWS.home)();
    bindAll(app);
    var awake = view === 'live' || view === 'process';
    if (awake) { syncAlerts(); ensureWakeLock(); } else { clearTimers(); releaseWakeLock(); }
  }

  // ----------------------------------------------------------- home view
  /* Three ways in. If something is already running you land on it, with a way
   * back out — nobody wants a mode picker at 6am with dough on the bench. */
  function homeView() {
    var proc = activeProcess();
    var bulk = activeBake();
    return '' +
      '<div class="topbar"><h1>Sourdough<span class="sub">The clock is a suggestion.</span></h1>' +
      (state.bakes.length || state.processes.length ? '<button class="iconbtn" data-act="history">History</button>' : '') + '</div>' +
      (proc ? resumeCard('process', proc) : '') +
      (bulk && !proc ? resumeCard('bulk', bulk) : '') +
      '<div class="section-title">' + (proc || bulk ? 'Or start something else' : 'What are you doing?') + '</div>' +
      '<div class="modes">' +
      modeCard('mode-full', 'Full bake', 'Run the whole process, starter feed to oven, ticking stages off as you go.') +
      modeCard('mode-plan', 'Plan backwards', 'Say when you want bread out of the oven. Get a schedule that works back from it.') +
      modeCard('mode-bulk', 'Bulk ferment only', 'Just the temperature-driven bulk tracker. Log temps, watch the prediction move.') +
      '</div>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="templates">Processes &amp; templates</button>';
  }

  function modeCard(act, title, body) {
    return '<button class="mode" data-act="' + act + '"><b>' + esc(title) + '</b><em>' + esc(body) + '</em></button>';
  }

  function resumeCard(kind, item) {
    var now = Date.now();
    if (kind === 'bulk') {
      var st = M.stateAt(item.readings, now);
      return '<button class="resume" data-act="resume-bulk">' +
        '<span class="tag">Bulk running</span><b>' + esc(item.name) + '</b>' +
        '<em>' + (st.empty ? 'No readings yet.' : st.ready ? 'Ready — go read the dough.' : dur(st.msRemaining) + ' to preshape, around ' + clock(st.predictedEnd) + dayTag(st.predictedEnd, now)) + '</em></button>';
    }
    var tl = projectProcess(item, now);
    var cur = tl.current;
    return '<button class="resume" data-act="resume-process">' +
      '<span class="tag">Bake in progress</span><b>' + esc(item.name) + '</b>' +
      '<em>' + (cur ? cur.name + (cur.status === 'running' ? ' — ' + dur(now - cur.start) + ' in' : ' — not started yet') : 'Every stage ticked off.') + '</em></button>';
  }

  function startView() {
    var has = state.bakes.length > 0;
    return '' +
      '<div class="topbar"><button class="iconbtn" data-act="home">Back</button>' +
      '<h1>Bulk ferment<span class="sub">The clock is a suggestion.</span></h1>' +
      (has ? '<button class="iconbtn" data-act="history">History</button>' : '') + '</div>' +
      '<div class="hero"><div class="label">No bake running</div>' +
      '<div class="remain" style="margin-top:8px">Take the dough temperature and start the clock.</div></div>' +
      '<form id="startform">' +
      '<label class="field">Bake name<input name="name" placeholder="' + esc(defaultName()) + '" autocomplete="off"></label>' +
      '<label class="field">Notes — flour, hydration, starter<textarea name="notes" placeholder="80% AP / 20% wholewheat, 75% hydration, 20% levain at peak"></textarea></label>' +
      '<div class="toggle" style="margin-top:14px"><div class="t">Aliquot jar' +
      '<em>Off is fine — temperature alone drives the whole prediction. You can switch it on mid-bake.</em></div>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + !!state.settings.useJar + '" data-act="t-jar-start"><i></i></button></div>' +
      '<label class="field">First dough temperature °C — this timestamps the start' +
      '<input name="temp" type="number" inputmode="decimal" step="0.1" min="10" max="35" placeholder="24.5" required></label>' +
      '<div class="err" id="starterr"></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn primary" type="submit">Start bulk</button>' +
      '</form>' +
      (has ? '<p class="note center">' + state.bakes.length + ' bake' + (state.bakes.length > 1 ? 's' : '') + ' in history.</p>' : '');
  }

  function defaultName() {
    return new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' bake';
  }

  /* A bake tracked without an aliquot jar hides the jar controls entirely.
   * The model is unchanged: temperature alone drives the whole prediction. */
  function usesJar(bake) { return !bake || bake.useJar !== false; }

  function lastTempAt(bake) {
    var withTemp = M.sortReadings(bake.readings).filter(function (r) { return r.temp != null; });
    return withTemp.length ? withTemp[withTemp.length - 1].t : bake.startedAt;
  }

  /* The readings list, newest first, each one editable. Shared by the
   * standalone live view and by the bulk stage inside a full bake — a
   * mistyped temperature has to be correctable from wherever you logged it. */
  function readingsList(bake) {
    var rep = M.replay(bake.readings);
    var byId = {};
    rep.points.forEach(function (p) { byId[p.id] = p; });
    var readings = M.sortReadings(bake.readings).slice().reverse();
    return '<div class="section-title">Readings</div>' +
      '<ul class="readings">' + readings.map(function (r) {
        var p = byId[r.id] || {};
        var bits = [];
        if (r.temp != null) bits.push('<b>' + n1(r.temp) + '°C</b>');
        if (r.rise != null) bits.push('<b>jar ' + n1(r.rise) + '%</b>');
        var sub = [];
        if (r.gapTemp != null) sub.push('gap held at ' + n1(r.gapTemp) + '°');
        if (p.progress != null) sub.push(Math.round(p.progress * 100) + '% through');
        if (r.temp != null && M.isExtrapolated(r.temp)) sub.push('extrapolated');
        return '<li class="reading"><span class="when">' + clock(r.t) + '</span>' +
          '<span class="what">' + bits.join(' · ') + '<em>' + esc(sub.join(' · ')) + '</em></span>' +
          '<button class="edit" data-act="edit" data-id="' + r.id + '" aria-label="Edit reading">Edit</button></li>';
      }).join('') + '</ul>';
  }

  function liveView(bake) {
    var now = Date.now();
    var st = M.stateAt(bake.readings, now);
    var pct = Math.max(0, Math.min(100, st.progress * 100));
    var hero;
    if (st.ready) {
      hero = '<div class="hero ready"><div class="label">Preshape</div>' +
        '<div class="time">Ready — go read the dough.</div>' +
        '<div class="remain">Hit 100% ' + dur(now - st.predictedEnd) + ' ago, at ' + clock(st.predictedEnd) + '.</div></div>';
    } else {
      hero = '<div class="hero"><div class="label">Preshape at</div>' +
        '<div class="time">' + clock(st.predictedEnd) + '</div>' +
        '<div class="remain"><strong>' + dur(st.msRemaining) + '</strong> to go' + dayTag(st.predictedEnd, now) + '</div></div>';
    }

    var calLine = M.calibrationPhrase(st.cal);
    var jar = usesJar(bake);

    return '' +
      '<div class="topbar">' +
      '<button class="iconbtn" data-act="home" aria-label="Home">Home</button>' +
      '<h1>' + esc(bake.name) + '<span class="sub">Started ' + clock(bake.startedAt) + ' · ' + dur(now - bake.startedAt) + ' in</span></h1>' +
      '<button class="iconbtn" data-act="menu" aria-label="Menu">•••</button></div>' +
      hero +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Progress</div><div class="v">' + Math.round(st.progress * 100) + '<small>%</small></div>' +
      '<div class="progressbar' + (st.ready ? ' ready' : '') + '"><i style="width:' + pct + '%"></i></div></div>' +
      '<div class="stat"><div class="k">Dough temp</div><div class="v">' + n1(st.currentTemp) + '<small>°C</small></div>' +
      (st.extrapolated ? '<span class="flag">extrapolated</span>' : '<div class="k" style="margin-top:8px">as of ' + clock(lastTempAt(bake)) + '</div>') + '</div>' +
      '<div class="stat"><div class="k">Target rise</div><div class="v">' + Math.round(st.target) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">at ' + n1(st.currentTemp) + '°C</div></div>' +
      '<div class="stat"><div class="k">Expected rise now</div><div class="v">' + Math.round(st.expectedRise) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">' + (jar ? 'jar should be here' : 'dough should be here') + '</div></div>' +
      ((jar || st.calibrated) ? '<div class="stat wide"><div class="v">' + esc(calLine) + '</div>' +
        (st.calibrated ? '<button class="btn small ghost" style="width:auto;flex:0 0 auto" data-act="resetcal">Reset</button>' : '') + '</div>' : '') +
      '</div>' +
      chartSVG(bake.readings, now) +
      (st.gapPending ? '<p class="note center">No reading for ' + dur(st.sinceLastMs) + ' — the next entry will ask what happened in between.</p>' : '') +
      '<div class="actions"' + (jar ? '' : ' style="grid-template-columns:1fr"') + '>' +
      '<button class="btn primary" data-act="logtemp">Log temp</button>' +
      (jar ? '<button class="btn" data-act="lograise">Log rise %</button>' : '') +
      '</div>' +
      readingsList(bake) +
      '<div class="cues">' +
      '<div class="lede">The clock is a suggestion. The dough decides.</div>' +
      '<ul><li>Domed, not flat</li><li>Jiggles as one mass</li>' +
      '<li>Bubbles visible at the edges and surface</li>' +
      '<li>Feels alive and airy, not soupy</li></ul></div>';
  }

  function historyView() {
    var procs = state.processes.filter(function (p2) { return p2.id !== state.activeProcessId; })
      .sort(function (a, b) { return b.createdAt - a.createdAt; });
    /* A bulk that belongs to a full bake is shown inside that bake, not twice. */
    var owned = {};
    state.processes.forEach(function (p2) { if (p2.bulkBakeId) owned[p2.bulkBakeId] = true; });
    var done = state.bakes.filter(function (b) { return b.id !== state.activeId && !owned[b.id]; })
      .sort(function (a, b) { return b.startedAt - a.startedAt; });

    var body = '';
    if (procs.length) body += '<div class="section-title">Full bakes</div>' + procs.map(procCard).join('');
    if (done.length) body += '<div class="section-title">Bulk ferments</div>' + done.map(bakeCard).join('');
    if (!body) body = '<div class="empty">No finished bakes yet.</div>';

    return '<div class="topbar"><button class="iconbtn" data-act="back">Back</button><h1>History</h1>' +
      (procs.length ? '<button class="iconbtn" data-act="csv-stages">Stages</button>' : '') +
      (done.length || procs.length ? '<button class="iconbtn" data-act="csv">CSV</button>' : '') + '</div>' + body;
  }

  function procCard(p2) {
    var open = openBakeId === p2.id;
    var tl = projectProcess(p2, p2.finishedAt || Date.now());
    var ticked = tl.chain.filter(function (e) { return e.actualEnd != null; }).length;
    var rec = bulkRecord(p2);
    var notes = p2.events.filter(function (e) { return e.log; });
    var late = tl.events.filter(function (e) { return e.actualEnd != null && e.plannedEnd != null; })
      .map(function (e) { return e.actualEnd - e.plannedEnd; });
    var drift = late.length ? late[late.length - 1] : null;

    return '<div class="bake">' +
      '<h3>' + esc(p2.name) + '</h3>' +
      '<div class="meta">' + dateStr(p2.createdAt) + ' · ' + esc(p2.template.name) + ' · ' + (p2.status || 'active') + '</div>' +
      '<div class="kv">' +
      '<span>stages <b>' + ticked + '/' + tl.chain.length + '</b></span>' +
      '<span>planned bulk <b>' + n1(p2.params.bulkTempC) + '°C</b></span>' +
      (rec ? '<span>bulk ran <b>' + dur((rec.finishedAt || Date.now()) - rec.startedAt) + '</b></span>' : '') +
      (drift != null ? '<span>finished <b>' + dur(Math.abs(drift)) + ' ' + (drift > 0 ? 'late' : 'early') + '</b></span>' : '') +
      '</div>' +
      (p2.adjustments && p2.adjustments.length
        ? '<div class="note" style="margin-bottom:8px">Planner moved: ' + esc(p2.adjustments.map(function (a) { return a.text; }).join(' ')) + '</div>' : '') +
      (open
        ? '<ul class="timeline compact">' + tl.chain.map(function (e) {
          return '<li class="tlrow ' + (e.actualEnd != null ? 'done' : 'future') + '">' +
            '<span class="when">' + (e.actualStart != null ? clock(e.actualStart) : '—') + '</span>' +
            '<span class="what"><b>' + esc(e.name) + '</b><em>' +
            (e.actualEnd != null ? 'took ' + dur(e.actualEnd - e.actualStart) +
              ' · planned ' + clock(e.plannedStart) : 'never ticked off') + '</em>' +
            (e.log ? '<em class="cue">' + esc(e.log) + '</em>' : '') + '</span></li>';
        }).join('') + '</ul>' +
        (notes.length ? '' : '<p class="note">No stage notes on this one.</p>') +
        (rec && rec.readings.length ? '<div class="section-title">Bulk</div>' + chartSVG(rec.readings, rec.finishedAt || Date.now(), { historic: true }) : '') +
        '<label class="field">Crumb result — how did it actually bake?' +
        '<textarea data-act="crumb" data-id="' + (rec ? rec.id : p2.id) + '" placeholder="Open even crumb, slight gumminess at the base…">' + esc((rec && rec.crumb) || p2.crumb || '') + '</textarea></label>' +
        '<div class="rowbtns">' +
        '<button class="btn small ghost" data-act="closebake">Close</button>' +
        '<button class="btn small ghost" data-act="proc-ics-old" data-id="' + p2.id + '">.ics</button>' +
        '<button class="btn small danger" data-act="delproc" data-id="' + p2.id + '">Delete</button></div>'
        : '<button class="btn small ghost" data-act="openproc" data-id="' + p2.id + '">Open</button>') +
      '</div>';
  }

  function bakeCard(b) {
    var open = openBakeId === b.id;
    var end = b.finishedAt || (b.readings.length ? M.sortReadings(b.readings).slice(-1)[0].t : b.startedAt);
    var rep = M.replay(b.readings);
    var st = b.readings.length ? M.stateAt(b.readings, end) : null;
    return '<div class="bake">' +
      '<h3>' + esc(b.name) + '</h3>' +
      '<div class="meta">' + dateStr(b.startedAt) + ' · started ' + clock(b.startedAt) + ' · ran ' + dur(end - b.startedAt) + '</div>' +
      '<div class="kv">' +
      '<span>progress <b>' + Math.round(rep.progress * 100) + '%</b></span>' +
      '<span>readings <b>' + b.readings.length + '</b></span>' +
      (usesJar(b) || Math.abs(rep.cal - 1) > 0.005 ? '<span>calibration <b>' + (Math.round(rep.cal * 100) / 100) + '×</b></span>' : '') +
      (st ? '<span>final temp <b>' + n1(st.currentTemp) + '°C</b></span>' : '') +
      '</div>' +
      (usesJar(b) || Math.abs(rep.cal - 1) > 0.005 ? '<div class="note" style="margin-bottom:8px">' + esc(M.calibrationPhrase(rep.cal)) + '</div>' : '') +
      (b.notes ? '<div class="note">' + esc(b.notes) + '</div>' : '') +
      (open ? (b.readings.length ? chartSVG(b.readings, end, { historic: true }) : '') +
        '<label class="field">Crumb result — how did it actually bake?' +
        '<textarea data-act="crumb" data-id="' + b.id + '" placeholder="Open even crumb, slight gumminess at the base…">' + esc(b.crumb || '') + '</textarea></label>' +
        '<div class="row" style="display:flex;gap:10px;margin-top:12px">' +
        '<button class="btn small ghost" data-act="closebake">Close</button>' +
        '<button class="btn small danger" data-act="delbake" data-id="' + b.id + '">Delete bake</button></div>'
        : '<button class="btn small ghost" data-act="openbake" data-id="' + b.id + '">Open</button>') +
      '</div>';
  }

  // ------------------------------------------------------- templates view
  function templatesView() {
    return '<div class="topbar"><button class="iconbtn" data-act="home">Back</button><h1>Processes</h1>' +
      '<button class="iconbtn" data-act="tpl-import">Import</button></div>' +
      '<p class="note">A process is an ordered list of stages. Edit them, reorder them, throw stages away. ' +
      'Every number in here is a starting point.</p>' +
      state.templates.map(function (t) {
        var chain = P.chainStages(t);
        var bulk = t.stages.filter(function (x) { return x.type === 'bulk'; })[0];
        return '<div class="bake"><h3>' + esc(t.name) + '</h3>' +
          '<div class="meta">' + t.stages.length + ' stages' +
          (bulk ? ' · bulk from the temperature model' : ' · no bulk stage') +
          ' · about ' + P.fmtHours(chain.reduce(function (a, x) { return a + P.stageDurationMin(x, {}); }, 0) / 60) + ' end to end</div>' +
          (t.description ? '<div class="note" style="margin-bottom:8px">' + esc(t.description) + '</div>' : '') +
          '<div class="rowbtns">' +
          '<button class="btn small ghost" data-act="tpl-edit" data-id="' + t.id + '">Edit</button>' +
          '<button class="btn small ghost" data-act="tpl-dupe" data-id="' + t.id + '">Duplicate</button>' +
          '<button class="btn small ghost" data-act="tpl-export" data-id="' + t.id + '">Export</button>' +
          (state.templates.length > 1 ? '<button class="btn small danger" data-act="tpl-del" data-id="' + t.id + '">Delete</button>' : '') +
          '</div></div>';
      }).join('') +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="tpl-new">New empty process</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="tpl-reseed">Restore “Bruce’s Loaf” to the seeded version</button>';
  }

  // ---------------------------------------------------------- stage editor
  /* A one-line summary of what a stage will actually do, so the list reads as
   * a recipe rather than a data structure. */
  function stageSummary(s, tpl) {
    switch (s.type) {
      case 'fixed': return Math.round(s.durationMin) + ' min timer';
      case 'active': return s.durationMin == null ? 'hands-on, no timer' : 'hands-on, about ' + Math.round(s.durationMin) + ' min';
      case 'repeat':
        var host = s.duringStageId && P.findStage(tpl, s.duringStageId);
        return '×' + s.reps + ', every ' + Math.round(s.intervalMin) + ' min' +
          (host ? ' — during ' + host.name + (s.offsetMin ? ', from +' + Math.round(s.offsetMin) + ' min' : ', from its start') : ' — on its own');
      case 'bulk': return 'target ' + n1(s.targetTempC) + ' °C → about ' + P.fmtHours(M.hoursAt(s.targetTempC)) + ', re-read live from the dough temp';
      case 'cold-proof': return P.fmtHours(s.minMin / 60) + ' to ' + P.fmtHours(s.maxMin / 60) + ' — the schedule flexes here';
      case 'bake': return 'preheat ' + Math.round(s.preheatMin) + ' min · ' +
        s.steps.map(function (b) { return Math.round(b.tempC) + ' °C ' + Math.round(b.durationMin) + ' min ' + b.label.toLowerCase(); }).join(' → ');
      case 'starter-feed': return (s.role === 'revival' ? s.feeds + ' feed' + (s.feeds > 1 ? 's' : '') + ' ' + n1(s.gapHours) + ' h apart' : 'one feed') +
        ' · ' + s.ratio + ' · ' + P.fmtHours(s.peakHours) + ' to peak' +
        (s.fridgeOnly ? ' · only from the fridge' : '');
      default: return '';
    }
  }

  function editorView(tpl) {
    if (!tpl) return '';
    return '<div class="topbar"><button class="iconbtn" data-act="templates">Back</button>' +
      '<h1>' + esc(tpl.name) + '<span class="sub">' + tpl.stages.length + ' stages</span></h1>' +
      '<button class="iconbtn" data-act="tpl-meta" data-id="' + tpl.id + '">Name</button></div>' +
      '<ul class="stagelist">' + tpl.stages.map(function (st, i) {
        return '<li class="stagerow' + (st.type === 'bulk' ? ' bulkrow' : '') + '">' +
          '<div class="ord">' + (i + 1) + '</div>' +
          '<div class="body" data-act="st-edit" data-id="' + st.id + '">' +
          '<b>' + esc(st.name) + '<span class="pill">' + esc(P.TYPE_LABEL[st.type]) + '</span></b>' +
          '<em>' + esc(stageSummary(st, tpl)) + '</em>' +
          (st.cues.length ? '<em class="cue">Cues: ' + esc(st.cues.join(' · ')) + '</em>' : '') +
          '</div>' +
          '<div class="movers">' +
          '<button class="mv" data-act="st-up" data-id="' + st.id + '"' + (i === 0 ? ' disabled' : '') + ' aria-label="Move up">↑</button>' +
          '<button class="mv" data-act="st-down" data-id="' + st.id + '"' + (i === tpl.stages.length - 1 ? ' disabled' : '') + ' aria-label="Move down">↓</button>' +
          '</div></li>';
      }).join('') + '</ul>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="st-add">Add a stage</button>' +
      '<p class="note">Tap a stage to edit it. The bulk stage has no duration on purpose — its length comes from the ' +
      'temperature model and, once it is running, from the readings you log.</p>';
  }

  function stageSheet(tplId, stageId) {
    var tpl = findTemplate(tplId);
    var st = P.findStage(tpl, stageId);
    if (!st) return;
    var hosts = tpl.stages.filter(function (x) { return x.id !== st.id && (x.type === 'bulk' || x.type === 'fixed' || x.type === 'cold-proof'); });
    var anchors = tpl.stages.filter(function (x) { return x.type !== 'starter-feed' && x.type !== 'repeat'; });

    function f(label, id, val, attrs) {
      return '<label class="field">' + label + '<input id="' + id + '" ' + (attrs || '') + ' value="' + esc(val == null ? '' : val) + '"></label>';
    }
    var body = '';
    if (st.type === 'fixed') body += f('Duration, minutes', 'f-dur', st.durationMin, 'type="number" inputmode="numeric" step="5" min="0"');
    if (st.type === 'active') body += f('Duration, minutes — leave blank for “until it is done”', 'f-dur', st.durationMin, 'type="number" inputmode="numeric" step="5" min="0"');
    if (st.type === 'repeat') {
      body += f('How many times', 'f-reps', st.reps, 'type="number" inputmode="numeric" step="1" min="1"');
      body += f('Every … minutes', 'f-int', st.intervalMin, 'type="number" inputmode="numeric" step="5" min="1"');
      body += '<label class="field">Runs during<select id="f-host"><option value="">On its own, in sequence</option>' +
        hosts.map(function (h) { return '<option value="' + h.id + '"' + (h.id === st.duringStageId ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') +
        '</select></label>';
      body += f('First one at … minutes into that stage', 'f-off', st.offsetMin, 'type="number" inputmode="numeric" step="5" min="0"');
    }
    if (st.type === 'bulk') {
      body += f('Expected dough temperature °C', 'f-temp', st.targetTempC, 'type="number" inputmode="decimal" step="0.5" min="10" max="35"');
      body += '<p class="hint">At ' + n1(st.targetTempC) + ' °C the model gives ' + P.fmtHours(M.hoursAt(st.targetTempC)) +
        ' and a target rise of ' + Math.round(M.targetRisePct(st.targetTempC)) + '%. There is no duration field here on purpose.</p>';
    }
    if (st.type === 'cold-proof') {
      body += f('Shortest, hours', 'f-min', st.minMin / 60, 'type="number" inputmode="decimal" step="0.5" min="0"');
      body += f('Longest, hours', 'f-max', st.maxMin / 60, 'type="number" inputmode="decimal" step="0.5" min="0"');
      body += '<p class="hint">The planner stretches and squeezes inside this range to keep the bench work out of the night.</p>';
    }
    if (st.type === 'bake') {
      body += f('Preheat, minutes', 'f-pre', st.preheatMin, 'type="number" inputmode="numeric" step="5" min="0"');
      body += '<div class="section-title">Steps</div>' +
        st.steps.map(function (b, i) {
          return '<div class="bakestep">' +
            '<input data-bs="label" data-i="' + i + '" value="' + esc(b.label) + '" placeholder="Covered">' +
            '<input data-bs="tempC" data-i="' + i + '" type="number" inputmode="numeric" step="5" value="' + b.tempC + '"><span>°C</span>' +
            '<input data-bs="durationMin" data-i="' + i + '" type="number" inputmode="numeric" step="5" value="' + b.durationMin + '"><span>min</span>' +
            (st.steps.length > 1 ? '<button class="mv" data-act="bs-del" data-i="' + i + '" aria-label="Remove step">✕</button>' : '') +
            '</div>';
        }).join('') +
        '<button class="btn small ghost" data-act="bs-add">Add a bake step</button>';
    }
    if (st.type === 'starter-feed') {
      body += '<label class="field">Role<select id="f-role">' +
        '<option value="final"' + (st.role === 'final' ? ' selected' : '') + '>Final feed — must be at peak for the dough</option>' +
        '<option value="revival"' + (st.role === 'revival' ? ' selected' : '') + '>Revival feeds — waking it up beforehand</option></select></label>';
      body += f('Ratio', 'f-ratio', st.ratio, 'type="text" autocomplete="off" placeholder="1:5:5"');
      body += f('Hours to peak', 'f-peak', st.peakHours, 'type="number" inputmode="decimal" step="0.5" min="0.5"');
      if (st.role === 'revival') {
        body += f('How many feeds', 'f-feeds', st.feeds, 'type="number" inputmode="numeric" step="1" min="1"');
        body += f('Hours between them', 'f-gap', st.gapHours, 'type="number" inputmode="decimal" step="1" min="0.5"');
      } else {
        body += '<label class="field">At peak in time for<select id="f-anchor">' +
          anchors.map(function (h) { return '<option value="' + h.id + '"' + (h.id === st.peakAtStageId ? ' selected' : '') + '>' + esc(h.name) + '</option>'; }).join('') +
          '</select></label>';
      }
      body += '<div class="toggle"><div class="t">Only when the starter comes from the fridge' +
        '<em>Skipped entirely if you tell the planner it is already active.</em></div>' +
        '<button type="button" class="switch" role="switch" aria-checked="' + !!st.fridgeOnly + '" data-act="f-fridge"><i></i></button></div>';
    }

    openSheet(
      '<h2>' + esc(st.name) + '</h2>' +
      '<p class="hint">' + esc(P.TYPE_LABEL[st.type]) + '. ' + esc(stageSummary(st, tpl)) + '</p>' +
      f('Name', 'f-name', st.name, 'type="text" autocomplete="off"') +
      body +
      '<label class="field">Notes — shown on screen while the stage is running<textarea id="f-notes">' + esc(st.notes) + '</textarea></label>' +
      '<label class="field">Cue checklist, one per line — a stage with cues always waits for you' +
      '<textarea id="f-cues" placeholder="Domed, not flat&#10;Jiggles as one mass">' + esc(st.cues.join('\n')) + '</textarea></label>' +
      '<div class="toggle"><div class="t">Hands-on<em>The planner keeps hands-on moments out of 23:00–06:00.</em></div>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + !!st.handsOn + '" data-act="f-handson"><i></i></button></div>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="st-save">Save</button></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn small danger" data-act="st-del">Delete this stage</button>',
      function (sheet) {
        var handsOn = !!st.handsOn, fridgeOnly = !!st.fridgeOnly;
        var steps = P.clone(st.steps || []);
        function redrawSteps() { closeSheet(); st.steps = steps; saveTemplates(); stageSheet(tplId, stageId); }
        sheet.addEventListener('input', function (e) {
          var bs = e.target.dataset.bs;
          if (bs) {
            var i = +e.target.dataset.i;
            steps[i][bs] = bs === 'label' ? e.target.value : parseFloat(e.target.value);
          }
        });
        sheet.addEventListener('click', function (e) {
          var btn = e.target.closest('[data-act]');
          var act = btn && btn.dataset.act;
          if (act === 'cancel') return closeSheet();
          if (act === 'f-handson') { handsOn = !handsOn; btn.setAttribute('aria-checked', handsOn); return; }
          if (act === 'f-fridge') { fridgeOnly = !fridgeOnly; btn.setAttribute('aria-checked', fridgeOnly); return; }
          if (act === 'bs-add') { steps.push({ label: 'Uncovered', tempC: 220, durationMin: 15 }); return redrawSteps(); }
          if (act === 'bs-del') { steps.splice(+btn.dataset.i, 1); return redrawSteps(); }
          if (act === 'st-del') {
            closeSheet();
            confirmSheet('Delete “' + st.name + '”?', 'Anything that referred to it — a fold that ran during it, a feed timed for it — loses that link.', 'Delete', function () {
              tpl.stages = tpl.stages.filter(function (x) { return x.id !== stageId; });
              saveTemplates(); render(); toast('Stage deleted.');
            });
            return;
          }
          if (act !== 'st-save') return;

          var v = function (sel) { var el = sheet.querySelector(sel); return el ? el.value : null; };
          var nu = function (sel, d) { var el = sheet.querySelector(sel); if (!el) return d; var x = parseFloat(el.value); return isFinite(x) ? x : d; };
          var next = { id: st.id, type: st.type, name: (v('#f-name') || '').trim() || st.name, handsOn: handsOn };
          next.notes = v('#f-notes') || '';
          next.cues = (v('#f-cues') || '').split('\n').map(function (c) { return c.trim(); }).filter(Boolean);

          if (st.type === 'fixed') next.durationMin = nu('#f-dur', st.durationMin);
          if (st.type === 'active') {
            var raw = v('#f-dur');
            next.durationMin = raw == null || raw === '' ? null : nu('#f-dur', 0);
          }
          if (st.type === 'repeat') {
            next.reps = nu('#f-reps', st.reps);
            next.intervalMin = nu('#f-int', st.intervalMin);
            next.duringStageId = v('#f-host') || null;
            next.offsetMin = nu('#f-off', 0);
          }
          if (st.type === 'bulk') {
            var t = nu('#f-temp', st.targetTempC);
            if (t < M.TEMP_MIN || t > M.TEMP_MAX) return err('Dough temperature has to be between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + ' °C.');
            next.targetTempC = t;
          }
          if (st.type === 'cold-proof') {
            var lo = nu('#f-min', 8) * 60, hi = nu('#f-max', 16) * 60;
            if (hi < lo) return err('The longest cold proof cannot be shorter than the shortest.');
            next.minMin = lo; next.maxMin = hi;
          }
          if (st.type === 'bake') {
            next.preheatMin = nu('#f-pre', st.preheatMin);
            next.steps = steps.filter(function (b) { return isFinite(b.tempC) && isFinite(b.durationMin); });
            if (!next.steps.length) return err('A bake needs at least one step.');
          }
          if (st.type === 'starter-feed') {
            next.role = v('#f-role') || st.role;
            next.ratio = v('#f-ratio') || st.ratio;
            next.peakHours = nu('#f-peak', st.peakHours);
            next.fridgeOnly = fridgeOnly;
            if (next.role === 'revival') { next.feeds = nu('#f-feeds', st.feeds); next.gapHours = nu('#f-gap', st.gapHours); }
            else { next.peakAtStageId = v('#f-anchor') || st.peakAtStageId; next.feeds = 1; }
          }
          var i = tpl.stages.findIndex(function (x) { return x.id === stageId; });
          tpl.stages[i] = P.normalizeStage(next);
          saveTemplates(); closeSheet(); render(); toast('Saved.');
        });
      });
  }

  function saveTemplates() {
    var t = findTemplate(editingTemplateId);
    if (t) { t.updatedAt = Date.now(); state.templates[state.templates.indexOf(t)] = P.normalizeTemplate(t); }
    save();
  }

  function addStageSheet() {
    var tpl = findTemplate(editingTemplateId);
    openSheet('<h2>Add a stage</h2><p class="hint">It goes on the end; move it with the arrows.</p>' +
      '<div class="choices">' + P.TYPES.map(function (ty) {
        return '<button class="btn" data-newtype="' + ty + '">' + esc(P.TYPE_LABEL[ty]) + '</button>';
      }).join('') + '</div>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button></div>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          if (e.target.dataset.act === 'cancel') return closeSheet();
          var ty = e.target.dataset.newtype;
          if (!ty) return;
          var st = P.blankStage(ty);
          tpl.stages.push(st);
          saveTemplates(); closeSheet(); render();
          stageSheet(tpl.id, st.id);
        });
      });
  }

  function moveStage(id, dir) {
    var tpl = findTemplate(editingTemplateId);
    var i = tpl.stages.findIndex(function (x) { return x.id === id; });
    var j = i + dir;
    if (i < 0 || j < 0 || j >= tpl.stages.length) return;
    var st = tpl.stages.splice(i, 1)[0];
    tpl.stages.splice(j, 0, st);
    saveTemplates(); render();
  }

  function templateMetaSheet(id) {
    var tpl = findTemplate(id);
    openSheet('<h2>Process</h2>' +
      '<label class="field">Name<input id="m-name" type="text" value="' + esc(tpl.name) + '"></label>' +
      '<label class="field">Description<textarea id="m-desc">' + esc(tpl.description) + '</textarea></label>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="m-save">Save</button></div>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          if (e.target.dataset.act === 'cancel') return closeSheet();
          if (e.target.dataset.act !== 'm-save') return;
          tpl.name = sheet.querySelector('#m-name').value.trim() || tpl.name;
          tpl.description = sheet.querySelector('#m-desc').value.trim();
          tpl.builtin = false;
          saveTemplates(); closeSheet(); render(); toast('Saved.');
        });
      });
  }

  // ----------------------------------------------------------- JSON in/out
  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function slug(s) { return String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'process'; }

  function exportTemplate(id) {
    var t = findTemplate(id);
    download(JSON.stringify({ kind: 'bulk-ferment-template', version: 2, template: t }, null, 2),
      slug(t.name) + '.json', 'application/json');
    toast('Exported ' + t.name + '.');
  }

  function importTemplate() {
    var input = document.createElement('input');
    input.type = 'file'; input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        try {
          var data = JSON.parse(reader.result);
          var raw = data && data.template ? data.template : data;
          if (!raw || !Array.isArray(raw.stages) || !raw.stages.length) throw new Error('no stages');
          var t = P.duplicateTemplate(P.normalizeTemplate(raw), raw.name || 'Imported process');
          state.templates.push(t); save(); render();
          toast('Imported “' + t.name + '” — ' + t.stages.length + ' stages.');
        } catch (e) {
          toast('That file is not a process export.');
        }
      };
      reader.readAsText(file);
    });
    input.click();
  }

  // --------------------------------------------------------- planner view
  /* Defaults come from what actually happened last time: the time-weighted mean
   * dough temperature of the most recent bulk, not a guess. */
  function lastBulkTemp() {
    var done = state.bakes.filter(function (b) { return b.readings && b.readings.length > 1; })
      .sort(function (a, b) { return b.startedAt - a.startedAt; })[0];
    return done ? P.averageTemp(done.readings) : null;
  }

  function defaultFinish() {
    var d = new Date();
    d.setDate(d.getDate() + 2);
    d.setHours(9, 45, 0, 0);
    return d.getTime();
  }

  function plannerView() {
    var d = state.draft;
    var lastT = lastBulkTemp();
    var params = (d && d.params) || {
      finishAt: defaultFinish(),
      bulkTempC: lastT == null ? 22 : Math.round(lastT * 2) / 2,
      fromFridge: true,
      templateId: (state.templates[0] || {}).id
    };
    var form = '<form id="planform">' +
      '<label class="field">Process' +
      '<select name="templateId">' + state.templates.map(function (t) {
        return '<option value="' + t.id + '"' + (t.id === params.templateId ? ' selected' : '') + '>' + esc(t.name) + '</option>';
      }).join('') + '</select></label>' +
      '<label class="field">Bread out of the oven at' +
      '<input name="finishAt" type="datetime-local" value="' + localInput(params.finishAt) + '" required></label>' +
      '<label class="field">Expected dough temperature during bulk °C' +
      '<input name="bulkTempC" type="number" inputmode="decimal" step="0.5" min="10" max="35" value="' + params.bulkTempC + '" required></label>' +
      '<p class="hint">' + (lastT == null
        ? 'No finished bulk to learn from yet — 22 °C is a reasonable kitchen.'
        : 'Your last bulk averaged ' + n1(lastT) + ' °C.') +
      ' At ' + n1(params.bulkTempC) + ' °C the model gives ' + P.fmtHours(M.hoursAt(params.bulkTempC)) + ' of bulk.</p>' +
      '<div class="toggle"><div class="t">Starter is in the fridge' +
      '<em>' + (params.fromFridge ? 'Revival feeds will be scheduled first.' : 'Already at room temperature and active — revival feeds skipped.') + '</em></div>' +
      '<button type="button" class="switch" role="switch" aria-checked="' + !!params.fromFridge + '" data-act="t-fridge"><i></i></button></div>' +
      '<div class="err" id="planerr"></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn primary" type="submit">' + (d ? 'Work it out again' : 'Work it out') + '</button>' +
      '</form>';

    return '<div class="topbar"><button class="iconbtn" data-act="home">Back</button>' +
      '<h1>Plan backwards<span class="sub">From the oven, not from the mix.</span></h1></div>' +
      form + (d ? draftBlock(d) : '');
  }

  function draftBlock(d) {
    var out = '<div class="section-title">The schedule</div>';

    d.problems.forEach(function (pr) {
      out += '<div class="callout warn"><b>' + (pr.kind === 'pinned-night' ? 'That bake time puts you in the kitchen at night' : 'The cold proof cannot absorb this') + '</b>' + esc(pr.text) + '</div>';
    });
    if (d.options.length) {
      out += '<div class="callout"><b>Ways out</b><ul>' +
        d.options.map(function (o) {
          return '<li>' + esc(o.text) + ' <button class="linkbtn" data-act="opt-apply" data-id="' + o.kind + '">Use this</button></li>';
        }).join('') + '</ul></div>';
    }
    if (d.adjustments.length) {
      out += '<div class="callout"><b>What it moved for you</b><ul>' +
        d.adjustments.map(function (a) { return '<li>' + esc(a.text) + '</li>'; }).join('') + '</ul></div>';
    }

    var bulk = d.events.filter(function (e) { return e.chain && e.type === 'bulk'; })[0];
    if (bulk) {
      out += '<p class="note">Bulk is ' + P.fmtHours((bulk.end - bulk.start) / H) + ' because that is 1 ÷ r(' +
        n1(d.params.bulkTempC) + ' °C) from the fitted curve. Run colder and it lengthens; the live tracker will re-read it from the dough.</p>';
    }

    out += '<ul class="plan">';
    d.days.forEach(function (day) {
      out += '<li class="planday">' + new Date(day.dateMs).toLocaleDateString(undefined, { weekday: 'long', day: 'numeric', month: 'short' }) + '</li>';
      day.events.forEach(function (e) {
        if (e.container) return;
        out += planRow(e);
      });
    });
    out += '</ul>';

    out += '<div class="actions">' +
      '<button class="btn primary" data-act="plan-start">Start this plan</button>' +
      '<button class="btn" data-act="plan-ics">Export .ics</button></div>' +
      '<p class="note">Drag a row sideways to move it — everything after it follows. Tap it to type an exact time.</p>';
    return out;
  }

  function planRow(e) {
    var night = P.isNight(e.start) && e.handsOn;
    return '<li class="planrow' + (night ? ' night' : '') + (e.kind === 'rep' || e.kind === 'bake-step' ? ' sub' : '') + '" data-drag="' + e.id + '">' +
      '<span class="when">' + clock(e.start) + '</span>' +
      '<span class="what"><b>' + esc(e.name) + '</b><em>' + esc(e.detail || '') + '</em>' +
      (e.end > e.start ? '<em class="til">until ' + clock(e.end) + dayTag(e.end, e.start) + ' · ' + dur(e.end - e.start) + '</em>' : '') +
      '</span><span class="grip" aria-hidden="true">⋮⋮</span></li>';
  }

  function computePlan(form) {
    var f = form.elements;
    var tpl = findTemplate(f.templateId.value);
    var finishAt = fromLocalInput(f.finishAt.value);
    var bulkTempC = parseFloat(f.bulkTempC.value);
    var fridgeBtn = document.querySelector('[data-act="t-fridge"]');
    var fromFridge = fridgeBtn ? fridgeBtn.getAttribute('aria-checked') === 'true' : true;
    var e = document.getElementById('planerr');
    if (!tpl) { e.textContent = 'Pick a process.'; return; }
    if (finishAt == null) { e.textContent = 'That finish time is not valid.'; return; }
    if (!isFinite(bulkTempC) || bulkTempC < M.TEMP_MIN || bulkTempC > M.TEMP_MAX) {
      e.textContent = 'Bulk temperature has to be between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + ' °C.'; return;
    }
    state.draft = P.planBackwards(tpl, { finishAt: finishAt, bulkTempC: bulkTempC, fromFridge: fromFridge });
    save(); render();
    var first = state.draft.events[0];
    toast('Starts ' + clock(first.start) + dayTag(first.start) + ' with ' + first.name.toLowerCase() + '.');
  }

  function applyOption(kind) {
    var d = state.draft;
    var o = d.options.filter(function (x) { return x.kind === kind; })[0];
    if (!o) return;
    var params = Object.assign({}, d.params);
    if (o.bulkTempC != null) params.bulkTempC = o.bulkTempC;
    if (o.finishAt != null) params.finishAt = o.finishAt;
    state.draft = P.planBackwards(findTemplate(params.templateId), params);
    save(); render(); toast('Replanned.');
  }

  function nudgeSheet(id) {
    var e = state.draft.events.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    openSheet('<h2>' + esc(e.name) + '</h2>' +
      '<p class="hint">' + (e.chain ? 'Everything after this moves with it.' : 'This one moves on its own.') + '</p>' +
      '<label class="field">Starts at<input id="nz-time" type="datetime-local" value="' + localInput(e.start) + '"></label>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="nz-save">Move it</button></div>',
      function (sheet) {
        sheet.addEventListener('click', function (ev2) {
          if (ev2.target.dataset.act === 'cancel') return closeSheet();
          if (ev2.target.dataset.act !== 'nz-save') return;
          var t = fromLocalInput(sheet.querySelector('#nz-time').value);
          if (t == null) return err('That time is not valid.');
          P.nudgeEvent(state.draft, id, t);
          save(); closeSheet(); render(); toast('Moved — the rest followed.');
        });
      });
  }

  // ------------------------------------------------------- process: state
  function bulkRecord(proc) {
    if (!proc || !proc.bulkBakeId) return null;
    return state.bakes.filter(function (b) { return b.id === proc.bulkBakeId; })[0] || null;
  }
  function projectProcess(proc, now) {
    var rec = bulkRecord(proc);
    var st = rec && rec.readings.length ? M.stateAt(rec.readings, now) : null;
    return P.projectTimeline(proc, now, st);
  }
  function procEvent(proc, id) {
    return proc.events.filter(function (e) { return e.id === id; })[0] || null;
  }
  function chainOf(proc) {
    return proc.events.filter(function (e) { return e.chain; })
      .sort(function (a, b) { return a.chainIndex - b.chainIndex; });
  }

  /* Ticking a stage off writes the real time and hands the baton on. The next
   * stage starts exactly when this one ended — that is the whole reconciliation:
   * projectTimeline rebuilds every downstream projection from these two facts. */
  function completeStage(proc, id) {
    var now = Date.now();
    var chain = chainOf(proc);
    var e = procEvent(proc, id);
    if (!e) return;
    if (!e.chain) {
      e.actualStart = e.actualStart == null ? now : e.actualStart;
      e.actualEnd = now;
      save(); render(); toast(e.name + ' — done.');
      return;
    }
    if (e.actualStart == null) e.actualStart = now;
    e.actualEnd = now;
    var next = chain[chain.findIndex(function (x) { return x.id === e.id; }) + 1];
    if (e.type === 'bulk') endBulkRecord(proc);
    if (!next) { finishProcess(proc); return; }
    if (next.type === 'bulk') { save(); beginBulk(proc, next, now); return; }
    next.actualStart = now;
    save(); render();
    toast(e.name + ' done · ' + next.name + ' now.');
  }

  function startStage(proc, id) {
    var now = Date.now();
    var e = procEvent(proc, id);
    if (!e) return;
    if (e.type === 'bulk') return beginBulk(proc, e, now);
    e.actualStart = now;
    save(); render(); toast(e.name + ' started.');
  }

  /* The handoff. A bulk stage does not get its own timer — it gets the existing
   * engine: a real bake record, a first dough temperature, the same accumulator,
   * chart and alerts the standalone tracker uses. */
  function beginBulk(proc, ev, at) {
    var lastT = lastBulkTemp();
    var stage = P.findStage(proc.template, ev.stageId) || {};
    numberSheet({
      title: 'Dough temperature',
      hint: 'This starts the bulk and the accumulator. Target for this process is ' + n1(stage.targetTempC == null ? 24 : stage.targetTempC) + ' °C.',
      value: Math.round((lastT == null ? (stage.targetTempC == null ? 24 : stage.targetTempC) : lastT) * 10) / 10,
      step: 0.5, min: M.TEMP_MIN, max: M.TEMP_MAX, unit: '°C',
      onSave: function (temp) {
        var now = Date.now();
        var bake = {
          id: uid(), name: proc.name + ' — bulk', notes: proc.template.name,
          startedAt: now, status: 'active',
          readings: [{ id: uid(), t: now, temp: temp, rise: null, gapTemp: null }],
          alerts: { lead: null, end: null }, crumb: '', finalCal: 1,
          useJar: !!state.settings.useJar, processId: proc.id
        };
        state.bakes.push(bake);
        state.activeId = bake.id;
        proc.bulkBakeId = bake.id;
        var e = procEvent(proc, ev.id);
        e.actualStart = now;
        save(); closeSheet(); render(); unlockAudio();
        toast('Bulk started at ' + n1(temp) + ' °C — the model takes it from here.');
      }
    });
  }

  function endBulkRecord(proc) {
    var rec = bulkRecord(proc);
    if (!rec) return;
    rec.finishedAt = Date.now();
    rec.finalCal = M.replay(rec.readings).cal;
    rec.status = 'done';
    if (state.activeId === rec.id) state.activeId = null;
  }

  function finishProcess(proc) {
    endBulkRecord(proc);
    proc.status = 'done';
    proc.finishedAt = Date.now();
    state.activeProcessId = null;
    save(); view = 'history'; openBakeId = proc.id; render();
    toast('Bake finished. Add the crumb note when you cut it.');
  }

  // -------------------------------------------------------- process: view
  function processView(proc) {
    var now = Date.now();
    var tl = projectProcess(proc, now);
    var cur = tl.current;
    var rec = bulkRecord(proc);
    var inBulk = cur && cur.type === 'bulk' && rec && rec.readings.length;

    var head = '<div class="topbar">' +
      '<h1>' + esc(proc.name) + '<span class="sub">' + esc(proc.template.name) +
      (tl.started ? ' · ' + tl.chain.filter(function (e) { return e.actualEnd != null; }).length + '/' + tl.chain.length + ' done' : ' · not started') +
      '</span></h1>' +
      '<button class="iconbtn" data-act="home" aria-label="Home">Home</button>' +
      '<button class="iconbtn" data-act="proc-menu" aria-label="Menu">•••</button></div>';

    if (!cur) {
      return head + '<div class="hero ready"><div class="label">Finished</div>' +
        '<div class="time">Every stage ticked off.</div></div>' +
        '<button class="btn primary" data-act="proc-finish">Close this bake</button>' +
        processTimeline(proc, tl, now);
    }

    return head + feedBand(tl, now) + nowCard(proc, tl, cur, rec, now) +
      (inBulk ? bulkTakeover(rec, now) : '') +
      nextCard(tl, now) +
      processTimeline(proc, tl, now);
  }

  /* Starter feeds run on their own clock, days before the dough exists. They
   * are not in the chain, so the Now card would sail straight past them —
   * this band puts a due feed in front of you until you tick it. */
  function feedBand(tl, now) {
    /* Once the stage the final feed was timed for has begun, the starter is in
     * the dough and no feed prompt is worth the screen space. */
    var target = tl.events.filter(function (e) { return e.feedRole === 'final'; })[0];
    var consumed = target && tl.chain.filter(function (e) {
      return e.stageId === target.anchorStageId && e.actualStart != null;
    })[0];
    if (consumed) return '';
    var feeds = tl.events.filter(function (e) { return e.kind === 'feed' && e.actualEnd == null; })
      .sort(function (a, b) { return a.start - b.start; });
    if (!feeds.length) return '';
    var due = feeds.filter(function (e) { return e.start <= now; });
    var upcoming = feeds.filter(function (e) { return e.start > now; })[0];
    function band(e, isDue) {
      return '<div class="subcount' + (isDue ? ' due' : '') + '">' +
        '<span class="k">' + esc(e.name) + '</span>' +
        '<span class="v">' + (isDue ? 'due ' : 'in ' + dur(e.start - now) + ' · ') + clock(e.start) + dayTag(e.start, now) + '</span>' +
        '<button class="btn small" data-act="proc-tick" data-id="' + e.id + '">Done</button></div>';
    }
    var out = due.map(function (e) { return band(e, true); }).join('');
    if (!due.length && upcoming && !tl.started) out += band(upcoming, false);
    return out;
  }

  function nowCard(proc, tl, cur, rec, now) {
    var running = cur.actualStart != null;
    var timed = cur.durationMin > 0 && cur.type !== 'bulk' && cur.type !== 'cold-proof';
    var judgement = cur.judgement;
    var st = rec && rec.readings.length ? M.stateAt(rec.readings, now) : null;

    var hero;
    if (!running) {
      hero = '<div class="hero"><div class="label">Up now</div>' +
        '<div class="time small">' + esc(cur.name) + '</div>' +
        '<div class="remain">' + (tl.started ? 'Planned for ' + clock(cur.start) + dayTag(cur.start, now) : 'Start when you are ready.') + '</div></div>';
    } else if (cur.type === 'bulk' && st) {
      hero = st.ready
        ? '<div class="hero ready"><div class="label">' + esc(cur.name) + '</div>' +
          '<div class="time">Ready — go read the dough.</div>' +
          '<div class="remain">Hit 100% ' + dur(now - st.predictedEnd) + ' ago. It is still your call.</div></div>'
        : '<div class="hero"><div class="label">' + esc(cur.name) + ' ends about</div>' +
          '<div class="time">' + clock(st.predictedEnd) + '</div>' +
          '<div class="remain"><strong>' + dur(st.msRemaining) + '</strong> to go' + dayTag(st.predictedEnd, now) +
          ' · ' + Math.round(st.progress * 100) + '% through</div></div>';
    } else {
      var left = cur.end - now;
      var over = left <= 0;
      hero = '<div class="hero' + (over ? ' ready' : '') + '"><div class="label">' + esc(cur.name) +
        (timed ? (over ? ' — time is up' : ' ends at') : '') + '</div>' +
        (timed && !over ? '<div class="time">' + clock(cur.end) + '</div>' : '<div class="time small">' + (over ? 'Ready when you are.' : dur(now - cur.start) + ' in') + '</div>') +
        '<div class="remain">' + (timed && !over ? '<strong>' + dur(left) + '</strong> to go' : 'Running ' + dur(now - cur.start)) +
        (judgement ? ' · you decide when it is done' : '') + '</div></div>';
    }

    var sub = '';
    if (tl.nextSub) {
      var s2 = tl.nextSub;
      var due = s2.start - now;
      sub = '<div class="subcount' + (due <= 0 ? ' due' : '') + '">' +
        '<span class="k">' + esc(s2.name) + '</span>' +
        '<span class="v">' + (due <= 0 ? 'due now' : 'in ' + dur(due)) + ' · ' + clock(s2.start) + '</span>' +
        '<button class="btn small" data-act="proc-tick" data-id="' + s2.id + '">Done</button></div>';
    }

    var body = '';
    if (cur.notes) body += '<div class="doing">' + esc(cur.notes) + '</div>';
    if (cur.cues.length) {
      body += '<div class="cuebox"><div class="lede">Before you call it:</div><ul>' +
        cur.cues.map(function (c) { return '<li>' + esc(c) + '</li>'; }).join('') + '</ul>' +
        '<div class="note">The app can say ready. It cannot say done.</div></div>';
    }

    var btn = !running
      ? '<button class="btn primary" data-act="proc-start" data-id="' + cur.id + '">Start ' + esc(cur.name.toLowerCase()) + '</button>'
      : '<button class="btn primary" data-act="proc-tick" data-id="' + cur.id + '">' +
        (cur.judgement ? 'Confirm ' + esc(cur.name.toLowerCase()) + ' is done' : 'Done — next stage') + '</button>';

    return hero + sub + body +
      '<div class="actions" style="grid-template-columns:1fr">' + btn + '</div>' +
      '<button class="btn small ghost" data-act="proc-note" data-id="' + cur.id + '">' +
      (cur.log ? 'Note: ' + esc(cur.log.slice(0, 40)) + (cur.log.length > 40 ? '…' : '') : 'Scribble a note on this stage') + '</button>';
  }

  /* The bulk stage does not get a reimplementation. It gets the tracker. */
  function bulkTakeover(rec, now) {
    var st = M.stateAt(rec.readings, now);
    var jar = usesJar(rec);
    return '<div class="section-title">Bulk — live from the dough</div>' +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Progress</div><div class="v">' + Math.round(st.progress * 100) + '<small>%</small></div>' +
      '<div class="progressbar' + (st.ready ? ' ready' : '') + '"><i style="width:' + Math.max(0, Math.min(100, st.progress * 100)) + '%"></i></div></div>' +
      '<div class="stat"><div class="k">Dough temp</div><div class="v">' + n1(st.currentTemp) + '<small>°C</small></div>' +
      (st.extrapolated ? '<span class="flag">extrapolated</span>' : '<div class="k" style="margin-top:8px">as of ' + clock(lastTempAt(rec)) + '</div>') + '</div>' +
      '<div class="stat"><div class="k">Target rise</div><div class="v">' + Math.round(st.target) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">at ' + n1(st.currentTemp) + '°C</div></div>' +
      '<div class="stat"><div class="k">Expected rise now</div><div class="v">' + Math.round(st.expectedRise) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">' + (jar ? 'jar should be here' : 'dough should be here') + '</div></div>' +
      ((jar || st.calibrated) ? '<div class="stat wide"><div class="v">' + esc(M.calibrationPhrase(st.cal)) + '</div>' +
        (st.calibrated ? '<button class="btn small ghost" style="width:auto;flex:0 0 auto" data-act="resetcal">Reset</button>' : '') + '</div>' : '') +
      '</div>' +
      chartSVG(rec.readings, now) +
      (st.gapPending ? '<p class="note center">No reading for ' + dur(st.sinceLastMs) + ' — the next entry will ask what happened in between.</p>' : '') +
      '<div class="actions"' + (jar ? '' : ' style="grid-template-columns:1fr"') + '>' +
      '<button class="btn primary" data-act="logtemp">Log temp</button>' +
      (jar ? '<button class="btn" data-act="lograise">Log rise %</button>' : '') +
      '</div>' +
      readingsList(rec);
  }

  function nextCard(tl, now) {
    if (!tl.next) return '';
    return '<div class="nextup"><span class="k">Next up</span>' +
      '<b>' + esc(tl.next.name) + '</b>' +
      '<em>' + clock(tl.next.start) + dayTag(tl.next.start, now) + ' · ' + esc(tl.next.detail || '') + '</em></div>';
  }

  function processTimeline(proc, tl, now) {
    var subsBy = {};
    tl.events.forEach(function (e) {
      if (e.chain || !e.anchor) return;
      (subsBy[e.anchor] = subsBy[e.anchor] || []).push(e);
    });
    var feeds = tl.events.filter(function (e) { return e.kind === 'feed'; });

    function row(e, isSub) {
      var cls = 'tlrow ' + e.status + (isSub ? ' sub' : '');
      var stamp = e.actualEnd != null
        ? 'done ' + clock(e.actualEnd) + (e.plannedStart != null && Math.abs(e.actualEnd - (e.plannedEnd == null ? e.actualEnd : e.plannedEnd)) > 6 * MIN
          ? ' · ' + dur(Math.abs(e.actualEnd - e.plannedEnd)) + (e.actualEnd > e.plannedEnd ? ' late' : ' early') : '')
        : (e.end > e.start ? 'until ' + clock(e.end) : '');
      return '<li class="' + cls + '">' +
        '<span class="when">' + clock(e.start) + '<em>' + dayTag(e.start, now).trim() + '</em></span>' +
        '<span class="what"><b>' + esc(e.name) + '</b>' +
        '<em>' + esc(stamp) + (e.fromAccumulator ? ' · from the dough, not the plan' : '') + '</em>' +
        (e.log ? '<em class="cue">' + esc(e.log) + '</em>' : '') + '</span>' +
        (e.actualEnd == null && e.status !== 'future'
          ? '<button class="edit" data-act="proc-tick" data-id="' + e.id + '">Tick</button>'
          : '<button class="edit" data-act="proc-note" data-id="' + e.id + '">Note</button>') +
        '</li>';
    }

    var out = '<div class="section-title">Timeline' +
      '<button class="linkbtn" data-act="tl-toggle">' + (timelineOpen ? 'hide' : 'show') + '</button></div>';
    if (!timelineOpen) return out;
    out += '<ul class="timeline">';
    feeds.forEach(function (e) { out += row(e, false); });
    tl.chain.forEach(function (e) {
      out += row(e, false);
      (subsBy[e.stageId] || []).sort(function (a, b) { return a.start - b.start; })
        .forEach(function (sb) { out += row(sb, true); });
    });
    out += '</ul>';
    return out;
  }

  function stageNoteSheet(proc, id) {
    var e = procEvent(proc, id);
    if (!e) return;
    openSheet('<h2>' + esc(e.name) + '</h2>' +
      '<p class="hint">Dough temp at the mix, how it felt, what the kitchen was doing. Kept with the bake.</p>' +
      '<label class="field">Note<textarea id="sn-text" placeholder="Dough 23.4 °C at mix. Kitchen cold, window open all afternoon.">' + esc(e.log || '') + '</textarea></label>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="sn-save">Save</button></div>',
      function (sheet) {
        sheet.addEventListener('click', function (ev2) {
          if (ev2.target.dataset.act === 'cancel') return closeSheet();
          if (ev2.target.dataset.act !== 'sn-save') return;
          e.log = sheet.querySelector('#sn-text').value.trim();
          save(); closeSheet(); render(); toast('Noted.');
        });
      });
  }

  function processMenuSheet() {
    var proc = activeProcess();
    var s = state.settings;
    openSheet('<h2>' + esc(proc.name) + '</h2>' +
      '<div class="toggle"><div class="t">Alarm sound<em>Every timed stage and every fold.</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.sound + '" data-act="t-sound"><i></i></button></div>' +
      '<div class="toggle"><div class="t">Browser notification<em>' + notifyStatus() + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.notify + '" data-act="t-notify"><i></i></button></div>' +
      '<div class="toggle"><div class="t">Keep screen awake<em>' + ('wakeLock' in navigator ? 'Held while this view is open.' : 'Not supported in this browser.') + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.wakeLock + '" data-act="t-wake"><i></i></button></div>' +
      '<label class="field">Lead-time alert, minutes before a stage ends' +
      '<input id="lead" type="number" inputmode="numeric" step="5" min="0" max="180" value="' + s.leadMin + '"></label>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="proc-ics">Export the rest of this bake as .ics</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="history">History &amp; export</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small" data-act="proc-finish">Finish this bake</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small danger" data-act="proc-abandon">Abandon this bake</button>',
      function (sheet) {
        sheet.querySelector('#lead').addEventListener('change', function (e) {
          state.settings.leadMin = M.clamp(parseInt(e.target.value, 10) || 0, 0, 180);
          save(); syncAlerts(); toast('Alert set for ' + state.settings.leadMin + ' min before.');
        });
        sheet.addEventListener('click', function (e) {
          var act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
          if (act === 't-sound') { s.sound = !s.sound; save(); processMenuSheet(); }
          if (act === 't-wake') { s.wakeLock = !s.wakeLock; save(); processMenuSheet(); if (s.wakeLock) ensureWakeLock(); else releaseWakeLock(); }
          if (act === 't-notify') {
            if (!s.notify && 'Notification' in window) {
              Notification.requestPermission().then(function (pm) {
                s.notify = pm === 'granted'; save(); processMenuSheet();
                if (pm !== 'granted') toast('Notifications are blocked in browser settings.');
              });
            } else { s.notify = false; save(); processMenuSheet(); }
          }
          if (act === 'proc-abandon') {
            closeSheet();
            confirmSheet('Abandon this bake?', 'It stays in history with everything you ticked off, but the tracking stops here.', 'Abandon', function () {
              endBulkRecord(proc);
              proc.status = 'abandoned'; proc.finishedAt = Date.now();
              state.activeProcessId = null;
              save(); view = 'home'; render(); toast('Bake abandoned.');
            });
          }
        });
      });
  }

  // --------------------------------------------------------------- sheets
  function openSheet(html, onMount) {
    var root = document.getElementById('sheet-root');
    root.innerHTML = '<div class="backdrop" data-close="1"><div class="sheet">' + html + '</div></div>';
    bindAll(root);
    root.querySelector('.backdrop').addEventListener('click', function (e) {
      if (e.target.dataset.close) closeSheet();
    });
    if (onMount) onMount(root.querySelector('.sheet'));
  }
  function closeSheet() { document.getElementById('sheet-root').innerHTML = ''; }

  function numberSheet(opts) {
    // opts: title, hint, value, step, unit, min, max, extraHTML, onSave(value, sheet)
    var html = '<h2>' + esc(opts.title) + '</h2>' +
      (opts.hint ? '<p class="hint">' + esc(opts.hint) + '</p>' : '') +
      (opts.extraHTML || '') +
      '<div class="numrow">' +
      '<button type="button" data-act="dec" aria-label="Decrease">−</button>' +
      '<input id="numval" type="number" inputmode="decimal" step="' + opts.step + '" value="' + (opts.value == null ? '' : opts.value) + '">' +
      '<button type="button" data-act="inc" aria-label="Increase">+</button>' +
      '</div>' +
      '<div class="center hint">' + esc(opts.unit) + '</div>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row">' +
      '<button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="save">Save</button></div>';
    openSheet(html, function (sheet) {
      var input = sheet.querySelector('#numval');
      setTimeout(function () { input.focus(); input.select(); }, 60);
      sheet.addEventListener('click', function (e) {
        var act = e.target.dataset.act;
        if (act === 'inc' || act === 'dec') {
          var v = parseFloat(input.value);
          if (isNaN(v)) v = opts.value == null ? 0 : opts.value;
          v = M.clamp(v + (act === 'inc' ? 1 : -1) * opts.step, opts.min, opts.max);
          input.value = Math.round(v * 100) / 100;
        }
        if (act === 'cancel') closeSheet();
        if (act === 'save') {
          var val = parseFloat(input.value);
          if (isNaN(val)) return err('Enter a number.');
          opts.onSave(val, sheet);
        }
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('[data-act="save"]').click(); });
    });
  }
  function err(msg) {
    var el = document.getElementById('sheeterr');
    if (el) el.textContent = msg;
    return false;
  }

  /* Gap question. Runs before a new entry when the dough has been unattended. */
  function askGap(bake, st, done) {
    var lastTemp = n1(st.currentTemp);
    openSheet(
      '<h2>It has been ' + dur(st.sinceLastMs) + '</h2>' +
      '<p class="hint">Has it been steady around ' + lastTemp + '°C since your last reading at ' + clock(st.lastAt) + '?</p>' +
      '<div class="choices">' +
      '<button class="btn" data-gap="steady">Yes — steady around ' + lastTemp + '°</button>' +
      '<button class="btn" data-gap="cooler">No — it was cooler</button>' +
      '<button class="btn" data-gap="warmer">No — it was warmer</button>' +
      '</div>' +
      '<div id="gapinterim" hidden>' +
      '<label class="field">Roughly what temperature across those hours?' +
      '<input id="gaptemp" type="number" inputmode="decimal" step="0.5" min="10" max="35"></label>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="gapsave">Apply across the gap</button></div></div>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          var g = e.target.dataset.gap;
          if (g === 'steady') { closeSheet(); done(null); return; }
          if (g === 'cooler' || g === 'warmer') {
            sheet.querySelector('#gapinterim').hidden = false;
            var i = sheet.querySelector('#gaptemp');
            i.value = Math.round((st.currentTemp + (g === 'cooler' ? -2 : 2)) * 2) / 2;
            i.focus(); i.select();
            return;
          }
          if (e.target.dataset.act === 'cancel') closeSheet();
          if (e.target.dataset.act === 'gapsave') {
            var v = parseFloat(sheet.querySelector('#gaptemp').value);
            if (isNaN(v) || v < M.TEMP_MIN || v > M.TEMP_MAX) return err('Enter a temperature between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + '°C.');
            closeSheet(); done(v);
          }
        });
      });
  }

  function withGap(bake, next) {
    var st = M.stateAt(bake.readings, Date.now());
    if (!st.empty && st.gapPending) askGap(bake, st, next);
    else next(null);
  }

  function logTemp() {
    var bake = activeBake();
    withGap(bake, function (gapTemp) {
      var st = M.stateAt(bake.readings, Date.now());
      numberSheet({
        title: 'Dough temperature',
        hint: gapTemp != null ? 'The gap will be counted at ' + n1(gapTemp) + '°C.' : 'Probe reading, right now.',
        value: st.empty ? 24 : Math.round(st.currentTemp * 10) / 10,
        step: 0.5, min: M.TEMP_MIN, max: M.TEMP_MAX, unit: '°C',
        onSave: function (v) { commit(bake, { temp: v, gapTemp: gapTemp }); }
      });
    });
  }

  function logRise() {
    var bake = activeBake();
    withGap(bake, function (gapTemp) {
      var st = M.stateAt(bake.readings, Date.now());
      var lastRise = M.sortReadings(bake.readings).filter(function (r) { return r.rise != null; }).slice(-1)[0];
      numberSheet({
        title: 'Aliquot jar rise %',
        hint: 'Model expects about ' + Math.round(st.expectedRise) + '% right now (target ' + Math.round(st.target) + '%).',
        value: lastRise ? Math.round(Math.max(lastRise.rise, st.expectedRise)) : Math.round(st.expectedRise),
        step: 5, min: 0, max: 400, unit: '% above the starting mark',
        onSave: function (v) { commit(bake, { rise: v, gapTemp: gapTemp }); }
      });
    });
  }

  function commit(bake, fields) {
    var reading = {
      id: uid(), t: Date.now(),
      temp: fields.temp == null ? null : fields.temp,
      rise: fields.rise == null ? null : fields.rise,
      gapTemp: fields.gapTemp == null ? null : fields.gapTemp
    };
    var v = M.validateReading(bake.readings, reading);
    if (!v.ok) return err(v.message);
    var before = M.stateAt(bake.readings, Date.now());
    if (reading.rise != null) bake.useJar = true;   // jar is clearly to hand
    bake.readings.push(reading);
    save(); closeSheet(); render();
    var after = M.stateAt(bake.readings, Date.now());
    if (!before.empty && !after.ready) {
      var shift = after.predictedEnd - before.predictedEnd;
      if (Math.abs(shift) > 4 * 60000) {
        toast('Preshape moved ' + dur(Math.abs(shift)) + ' ' + (shift > 0 ? 'later' : 'earlier') + ' — now ' + clock(after.predictedEnd));
      } else { toast('Logged.'); }
    } else { toast('Logged.'); }
  }

  function editReading(id) {
    var bake = activeBake();
    var r = bake.readings.filter(function (x) { return x.id === id; })[0];
    if (!r) return;
    openSheet(
      '<h2>Edit reading</h2>' +
      '<p class="hint">Everything after this is recalculated from scratch.</p>' +
      '<label class="field">Time<input id="e-time" type="datetime-local" value="' + localInput(r.t) + '"></label>' +
      '<label class="field">Dough temp °C — blank to leave it out' +
      '<input id="e-temp" type="number" inputmode="decimal" step="0.1" min="10" max="35" value="' + (r.temp == null ? '' : r.temp) + '"></label>' +
      '<label class="field">Jar rise % — blank to leave it out' +
      '<input id="e-rise" type="number" inputmode="decimal" step="1" min="0" max="400" value="' + (r.rise == null ? '' : r.rise) + '"></label>' +
      '<label class="field">Interim temp across the gap before this reading °C' +
      '<input id="e-gap" type="number" inputmode="decimal" step="0.5" min="10" max="35" value="' + (r.gapTemp == null ? '' : r.gapTemp) + '"></label>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="esave">Save</button></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn small danger" data-act="edel">Delete this reading</button>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          var act = e.target.dataset.act;
          if (act === 'cancel') return closeSheet();
          if (act === 'edel') {
            if (bake.readings.length === 1) return err('The first reading is what started the bake. Abandon the bake instead.');
            bake.readings = bake.readings.filter(function (x) { return x.id !== id; });
            bake.startedAt = M.sortReadings(bake.readings)[0].t;
            save(); closeSheet(); render(); toast('Deleted — recalculated.');
            return;
          }
          if (act === 'esave') {
            var num = function (sel) { var v = parseFloat(sheet.querySelector(sel).value); return isNaN(v) ? null : v; };
            var t = fromLocalInput(sheet.querySelector('#e-time').value);
            if (t == null) return err('That time is not valid.');
            var cand = { id: id, t: t, temp: num('#e-temp'), rise: num('#e-rise'), gapTemp: num('#e-gap') };
            var v = M.validateReading(bake.readings, cand);
            if (!v.ok) return err(v.message);
            if (M.sortReadings(bake.readings)[0].id === id && cand.temp == null) return err('The first reading needs a temperature.');
            var i = bake.readings.findIndex(function (x) { return x.id === id; });
            bake.readings[i] = cand;
            bake.startedAt = M.sortReadings(bake.readings)[0].t;
            save(); closeSheet(); render(); toast('Recalculated from the first reading.');
          }
        });
      });
  }

  function menuSheet() {
    var s = state.settings;
    openSheet(
      '<h2>Bake &amp; alerts</h2>' +
      '<div class="toggle"><div class="t">Alarm sound<em>Beeps at the lead time and again at the end.</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.sound + '" data-act="t-sound"><i></i></button></div>' +
      '<div class="toggle"><div class="t">Browser notification<em>' + notifyStatus() + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.notify + '" data-act="t-notify"><i></i></button></div>' +
      '<div class="toggle"><div class="t">Keep screen awake<em>' + ('wakeLock' in navigator ? 'Held while the live view is open.' : 'Not supported in this browser.') + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.wakeLock + '" data-act="t-wake"><i></i></button></div>' +
      '<label class="field">Lead-time alert, minutes before preshape' +
      '<input id="lead" type="number" inputmode="numeric" step="5" min="0" max="180" value="' + s.leadMin + '"></label>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="testalarm">Test the alarm</button>' +
      '<div class="section-title">Bake</div>' +
      '<div class="toggle"><div class="t">Aliquot jar' +
      '<em>' + (usesJar(activeBake()) ? 'Rise button and calibration are showing.' : 'Hidden. Temperature alone is driving the prediction.') + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + usesJar(activeBake()) + '" data-act="t-jar"><i></i></button></div>' +
      (usesJar(activeBake()) ? '' : '<div class="spacer"></div><button class="btn small ghost" data-act="lograise-once">Log a one-off rise %</button>') +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="history">History &amp; export</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small" data-act="finish">Finish this bake</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small danger" data-act="abandon">Abandon this bake</button>',
      function (sheet) {
        sheet.querySelector('#lead').addEventListener('change', function (e) {
          state.settings.leadMin = M.clamp(parseInt(e.target.value, 10) || 0, 0, 180);
          save(); syncAlerts(); toast('Alert set for ' + state.settings.leadMin + ' min before.');
        });
        sheet.addEventListener('click', function (e) {
          var act = e.target.closest('[data-act]') && e.target.closest('[data-act]').dataset.act;
          if (act === 't-sound') { s.sound = !s.sound; save(); menuSheet(); }
          if (act === 't-jar') {
            var b = activeBake();
            b.useJar = !usesJar(b); s.useJar = b.useJar; save(); render(); menuSheet();
          }
          if (act === 'lograise-once') { logRise(); }
          if (act === 't-wake') { s.wakeLock = !s.wakeLock; save(); menuSheet(); if (s.wakeLock) ensureWakeLock(); else releaseWakeLock(); }
          if (act === 't-notify') {
            if (!s.notify && 'Notification' in window) {
              Notification.requestPermission().then(function (p) {
                s.notify = p === 'granted'; save(); menuSheet();
                if (p !== 'granted') toast('Notifications are blocked in browser settings.');
              });
            } else { s.notify = false; save(); menuSheet(); }
          }
          if (act === 'testalarm') { alarm('lead'); toast('That is the sound.'); }
          if (act === 'finish') finishBake(false);
          if (act === 'abandon') confirmSheet('Abandon this bake?', 'The readings are kept in history, but the bake stops here.', 'Abandon', function () { finishBake(true); });
        });
      });
  }
  function notifyStatus() {
    if (!('Notification' in window)) return 'Not supported in this browser.';
    return Notification.permission === 'granted' ? 'Permission granted.' : Notification.permission === 'denied' ? 'Blocked in browser settings.' : 'Will ask permission.';
  }

  function confirmSheet(title, body, cta, onYes) {
    openSheet('<h2>' + esc(title) + '</h2><p class="hint">' + esc(body) + '</p>' +
      '<div class="row"><button class="btn ghost" data-act="cancel">Keep going</button>' +
      '<button class="btn danger" data-act="yes">' + esc(cta) + '</button></div>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          if (e.target.dataset.act === 'cancel') closeSheet();
          if (e.target.dataset.act === 'yes') { closeSheet(); onYes(); }
        });
      });
  }

  function finishBake(abandoned) {
    var bake = activeBake();
    if (!bake) return;
    var rep = M.replay(bake.readings);
    bake.finishedAt = Date.now();
    bake.finalCal = rep.cal;
    bake.status = abandoned ? 'abandoned' : 'done';
    state.activeId = null;
    save(); closeSheet();
    view = 'history'; openBakeId = bake.id; render();
    toast(abandoned ? 'Bake abandoned.' : 'Bake finished — add the crumb result when you cut it.');
  }

  function startPlan() {
    var d = state.draft;
    var proc = P.commitPlan(d, findTemplate(d.params.templateId).name + ' — ' +
      new Date(d.params.finishAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short' }));
    state.processes.push(proc);
    state.activeProcessId = proc.id;
    state.draft = null;
    save(); view = 'process'; render(); unlockAudio();
    var first = chainOf(proc)[0];
    toast('Plan armed. First up: ' + (proc.events[0] || first).name + ' at ' + clock((proc.events[0] || first).plannedStart) + '.');
  }

  function startBake(form) {
    var f = form.elements;
    var temp = parseFloat(f.temp.value);
    if (isNaN(temp) || temp < M.TEMP_MIN || temp > M.TEMP_MAX) {
      document.getElementById('starterr').textContent = 'Enter a dough temperature between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + '°C.';
      return;
    }
    var now = Date.now();
    var bake = {
      id: uid(), name: (f.name.value || '').trim() || defaultName(),
      notes: (f.notes.value || '').trim(), startedAt: now, status: 'active',
      readings: [{ id: uid(), t: now, temp: temp, rise: null, gapTemp: null }],
      alerts: { lead: null, end: null }, crumb: '', finalCal: 1,
      useJar: !!state.settings.useJar
    };
    state.bakes.push(bake); state.activeId = bake.id;
    save(); view = 'live'; render();
    unlockAudio();
    toast('Bulk started at ' + n1(temp) + '°C.');
  }

  // ---------------------------------------------------------------- CSV
  function exportCSV() {
    var rows = [['bake_id', 'bake_name', 'status', 'started_at', 'notes', 'crumb', 'final_calibration',
      'reading_at', 'hours_in', 'dough_temp_c', 'gap_temp_c', 'observed_rise_pct',
      'progress_pct', 'target_rise_pct', 'modelled_rise_pct', 'calibration_at_reading']];
    state.bakes.slice().sort(function (a, b) { return a.startedAt - b.startedAt; }).forEach(function (b) {
      var rep = M.replay(b.readings);
      rep.points.forEach(function (p) {
        rows.push([b.id, b.name, b.status || 'active', new Date(b.startedAt).toISOString(), b.notes || '', b.crumb || '',
          round(rep.cal, 3), new Date(p.t).toISOString(), round((p.t - b.startedAt) / H, 3),
          p.temp == null ? '' : round(p.temp, 2), p.gapTemp == null ? '' : p.gapTemp,
          p.rise == null ? '' : p.rise, round(p.progress * 100, 2),
          p.target == null ? '' : round(p.target, 2), p.modeledRise == null ? '' : round(p.modeledRise, 2),
          round(p.cal, 3)]);
      });
    });
    var csv = rows.map(function (r) {
      return r.map(function (c) {
        c = String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\n');
    var blob = new Blob([csv], { type: 'text/csv' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'bulk-ferment-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
    toast('Exported ' + (rows.length - 1) + ' readings.');
  }
  function round(v, n) { var p = Math.pow(10, n); return Math.round(v * p) / p; }

  /* Planned against actual, one row per stage. This is the file that answers
   * "does the plan hold up in my kitchen" after a few bakes. */
  function exportStagesCSV() {
    var rows = [['bake_id', 'bake_name', 'template', 'status', 'bulk_temp_planned_c', 'cold_proof_h',
      'stage_order', 'stage', 'type', 'planned_start', 'planned_end', 'planned_min',
      'actual_start', 'actual_end', 'actual_min', 'drift_min', 'note']];
    state.processes.slice().sort(function (a, b) { return a.createdAt - b.createdAt; }).forEach(function (p2) {
      var tl = projectProcess(p2, p2.finishedAt || Date.now());
      tl.events.forEach(function (e, i) {
        if (e.container) return;
        rows.push([p2.id, p2.name, p2.template.name, p2.status || 'active',
          round(p2.params.bulkTempC, 1), round(p2.params.coldMin / 60, 2),
          e.chain ? e.chainIndex : '', e.name, e.type,
          e.plannedStart == null ? '' : new Date(e.plannedStart).toISOString(),
          e.plannedEnd == null ? '' : new Date(e.plannedEnd).toISOString(),
          e.plannedEnd == null ? '' : round((e.plannedEnd - e.plannedStart) / MIN, 1),
          e.actualStart == null ? '' : new Date(e.actualStart).toISOString(),
          e.actualEnd == null ? '' : new Date(e.actualEnd).toISOString(),
          e.actualEnd == null || e.actualStart == null ? '' : round((e.actualEnd - e.actualStart) / MIN, 1),
          e.actualEnd == null || e.plannedEnd == null ? '' : round((e.actualEnd - e.plannedEnd) / MIN, 1),
          e.log || '']);
      });
    });
    download(toCSV(rows), 'bakes-stages-' + new Date().toISOString().slice(0, 10) + '.csv', 'text/csv');
    toast('Exported ' + (rows.length - 1) + ' stages.');
  }

  function toCSV(rows) {
    return rows.map(function (r) {
      return r.map(function (c) {
        c = String(c);
        return /[",\n]/.test(c) ? '"' + c.replace(/"/g, '""') + '"' : c;
      }).join(',');
    }).join('\n');
  }

  // -------------------------------------------------------------- alerts
  var timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function syncAlerts() {
    clearTimers();
    syncBulkAlerts();
    if (view === 'process') syncProcessAlerts();
  }

  function later(at) {
    timers.push(setTimeout(function () { syncAlerts(); }, Math.min(at - Date.now(), 2147483000) + 500));
  }

  function syncBulkAlerts() {
    var bake = activeBake();
    if (!bake || !bake.readings.length) return;
    var now = Date.now();
    var st = M.stateAt(bake.readings, now);
    if (st.empty) return;
    bake.alerts = bake.alerts || { lead: null, end: null };
    var targets = {
      lead: st.predictedEnd - state.settings.leadMin * 60000,
      end: st.predictedEnd
    };
    Object.keys(targets).forEach(function (kind) {
      var at = targets[kind];
      if (kind === 'lead' && state.settings.leadMin <= 0) return;
      if (now >= at) { maybeFire(bake, kind, at, st); return; }
      later(at);
    });
  }

  /* Process alerts. Same mechanism as the bulk's: the fired time is remembered
   * against the moment it fired for, so a projection that drifts by a few
   * minutes does not re-alarm, and one that moves materially later does. */
  function syncProcessAlerts() {
    var proc = activeProcess();
    if (!proc) return;
    var now = Date.now();
    var tl = projectProcess(proc, now);
    proc.fired = proc.fired || {};
    var cur = tl.current;
    var jobs = [];

    /* The running stage's own timer — the bulk is excluded, the accumulator
     * already owns that alert. */
    if (cur && cur.actualStart != null && cur.durationMin > 0 && cur.type !== 'bulk') {
      if (state.settings.leadMin > 0 && cur.durationMin * MIN > state.settings.leadMin * MIN * 1.5) {
        jobs.push({ key: cur.id + ':lead', at: cur.end - state.settings.leadMin * MIN, kind: 'lead',
          title: state.settings.leadMin + ' minutes left on ' + cur.name,
          body: (cur.detail || cur.notes || '') });
      }
      jobs.push({ key: cur.id + ':end', at: cur.end, kind: 'end',
        title: cur.name + ' — time is up',
        body: cur.judgement ? 'Check it before you move on. ' + cur.cues.join('; ') : 'On to ' + (tl.next ? tl.next.name.toLowerCase() : 'the next thing') + '.' });
    }

    /* Every fold rep and every feed gets its own. */
    tl.events.forEach(function (e) {
      if (e.actualEnd != null) return;
      if (e.kind !== 'rep' && e.kind !== 'feed') return;
      if (e.start < now - 6 * H) return;
      jobs.push({ key: e.id + ':at', at: e.start, kind: 'end',
        title: e.name, body: e.detail || e.notes || '' });
    });

    jobs.forEach(function (j) {
      if (now >= j.at) {
        var prev = proc.fired[j.key];
        if (prev != null && j.at - prev < 15 * MIN) return;
        proc.fired[j.key] = j.at; save();
        alarm(j.kind);
        notify(j.title, j.body);
        toast(j.title);
        return;
      }
      later(j.at);
    });
  }

  /* Fired state is remembered against the time it fired for, so a moving
   * prediction re-arms the alert only if it moves materially (>15 min) later. */
  function maybeFire(bake, kind, at, st) {
    var prev = bake.alerts[kind];
    if (prev != null && at - prev < 15 * 60000) return;
    bake.alerts[kind] = at; save();
    var title = kind === 'lead'
      ? state.settings.leadMin + ' minutes to preshape'
      : 'Ready — go read the dough.';
    var body = kind === 'lead'
      ? esc(bake.name) + ' — ' + Math.round(st.progress * 100) + '% through at ' + n1(st.currentTemp) + '°C. Preshape around ' + clock(st.predictedEnd) + '.'
      : 'Domed, jiggly, bubbles at the edges. The dough decides.';
    alarm(kind);
    notify(title, body.replace(/&amp;/g, '&'));
    toast(title);
  }

  var actx;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { /* no audio available */ }
  }
  function alarm(kind) {
    if (!state.settings.sound) return;
    unlockAudio();
    if (!actx) return;
    var beeps = kind === 'end' ? 6 : 3;
    var freq = kind === 'end' ? 940 : 680;
    for (var i = 0; i < beeps; i++) {
      var t0 = actx.currentTime + i * 0.42;
      var o = actx.createOscillator(), g = actx.createGain();
      o.type = 'sine'; o.frequency.value = freq;
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.5, t0 + 0.03);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + 0.34);
      o.connect(g); g.connect(actx.destination);
      o.start(t0); o.stop(t0 + 0.36);
    }
    if (navigator.vibrate) navigator.vibrate([220, 120, 220, 120, 400]);
  }
  function notify(title, body) {
    if (!state.settings.notify || !('Notification' in window) || Notification.permission !== 'granted') return;
    try { new Notification(title, { body: body, tag: 'bft-alert', requireInteraction: true }); }
    catch (e) { /* some browsers require a service worker; the alarm still sounds */ }
  }

  // ------------------------------------------------------------ wake lock
  var wl = null;
  function ensureWakeLock() {
    if (!state.settings.wakeLock || !('wakeLock' in navigator) || wl || document.hidden) return;
    navigator.wakeLock.request('screen').then(function (lock) {
      wl = lock;
      lock.addEventListener('release', function () { wl = null; });
    }).catch(function () { /* denied or unsupported — not worth interrupting for */ });
  }
  function releaseWakeLock() { if (wl) { try { wl.release(); } catch (e) {} wl = null; } }

  // ------------------------------------------------------------- binding
  function bindAll(root) {
    root.querySelectorAll('[data-act]').forEach(function (el) {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      var act = el.dataset.act;
      if (act === 'crumb') {
        el.addEventListener('change', function () {
          var b = state.bakes.filter(function (x) { return x.id === el.dataset.id; })[0] ||
            state.processes.filter(function (x) { return x.id === el.dataset.id; })[0];
          if (b) { b.crumb = el.value; save(); toast('Crumb note saved.'); }
        });
        return;
      }
      el.addEventListener('click', function () { dispatch(act, el.dataset.id, el); });
    });
    var form = root.querySelector('#startform');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', function (e) { e.preventDefault(); startBake(form); });
    }
    var pform = root.querySelector('#planform');
    if (pform && !pform.dataset.bound) {
      pform.dataset.bound = '1';
      pform.addEventListener('submit', function (e) { e.preventDefault(); computePlan(pform); });
    }
    bindDrag(root);
  }

  /* Drag a plan row sideways to move it; everything after follows. A tap that
   * never moved opens the exact-time sheet instead — thumbs are imprecise and
   * this gets used at odd hours. */
  var PX_PER_MIN = 2.4;
  function bindDrag(root) {
    root.querySelectorAll('[data-drag]').forEach(function (el) {
      if (el.dataset.dbound) return;
      el.dataset.dbound = '1';
      var id = el.dataset.drag;
      var startX = 0, startT = 0, pending = 0, moved = false, active = false;
      var whenEl = el.querySelector('.when');

      el.addEventListener('pointerdown', function (e) {
        if (e.target.closest('button')) return;
        var evt = state.draft && state.draft.events.filter(function (x) { return x.id === id; })[0];
        if (!evt) return;
        active = true; moved = false; startX = e.clientX; startT = evt.start; pending = startT;
        try { el.setPointerCapture(e.pointerId); } catch (err) { /* not capturable, drag still works */ }
        el.classList.add('dragging');
      });

      el.addEventListener('pointermove', function (e) {
        if (!active) return;
        var dx = e.clientX - startX;
        if (!moved && Math.abs(dx) < 6) return;
        moved = true;
        var mins = Math.round(dx / PX_PER_MIN / 5) * 5;
        pending = startT + mins * MIN;
        whenEl.firstChild.nodeValue = clock(pending);
        el.classList.toggle('shifted', mins !== 0);
      });

      function finish() {
        if (!active) return;
        active = false;
        el.classList.remove('dragging', 'shifted');
        if (!moved) return nudgeSheet(id);
        if (pending === startT) return render();
        P.nudgeEvent(state.draft, id, pending);
        save(); render();
        toast('Moved to ' + clock(pending) + ' — the rest followed.');
      }
      el.addEventListener('pointerup', finish);
      el.addEventListener('pointercancel', finish);
    });
  }

  function dispatch(act, id, el) {
    switch (act) {
      case 'logtemp': unlockAudio(); logTemp(); break;
      case 'lograise': unlockAudio(); logRise(); break;
      case 'edit': editReading(id); break;
      case 'menu': menuSheet(); break;
      case 't-jar-start':
        /* toggled in place — re-rendering here would wipe what is typed above */
        state.settings.useJar = el.getAttribute('aria-checked') !== 'true';
        el.setAttribute('aria-checked', state.settings.useJar);
        save();
        break;
      case 'history': closeSheet(); view = 'history'; render(); break;
      case 'home': closeSheet(); view = 'home'; openBakeId = null; render(); break;
      case 'back':
        closeSheet();
        view = state.activeProcessId ? 'process' : state.activeId ? 'live' : 'home';
        openBakeId = null; render(); break;

      // ------------------------------------------------------------ modes
      case 'mode-bulk': view = 'start'; render(); break;
      case 'mode-plan': view = 'planner'; render(); break;
      case 'mode-full':
        if (state.activeProcessId) { view = 'process'; render(); break; }
        view = 'planner'; render();
        toast('A full bake starts from a plan — set the finish time.');
        break;
      case 'resume-bulk': view = 'live'; render(); break;
      case 'resume-process': view = 'process'; render(); break;

      // -------------------------------------------------------- templates
      case 'templates': closeSheet(); view = 'templates'; render(); break;
      case 'tpl-edit': editingTemplateId = id; view = 'editor'; render(); break;
      case 'tpl-meta': templateMetaSheet(id); break;
      case 'tpl-dupe':
        var dupe = P.duplicateTemplate(findTemplate(id));
        state.templates.push(dupe); save();
        editingTemplateId = dupe.id; view = 'editor'; render();
        toast('Duplicated — edit away, the original is untouched.');
        break;
      case 'tpl-del':
        confirmSheet('Delete this process?', 'Bakes already run from it keep their own frozen copy, so history is safe.', 'Delete', function () {
          state.templates = state.templates.filter(function (t) { return t.id !== id; });
          save(); render(); toast('Deleted.');
        });
        break;
      case 'tpl-new':
        var fresh = P.normalizeTemplate({ name: 'New process', stages: [P.blankStage('fixed')] });
        state.templates.push(fresh); save();
        editingTemplateId = fresh.id; view = 'editor'; render();
        break;
      case 'tpl-export': exportTemplate(id); break;
      case 'tpl-import': importTemplate(); break;
      case 'tpl-reseed':
        confirmSheet('Restore the seeded process?', 'Adds a fresh copy of “Bruce’s Loaf” as it ships. Nothing you have edited is touched.', 'Restore', function () {
          var seed = P.duplicateTemplate(P.defaultTemplate(), "Bruce's Loaf");
          state.templates.push(seed); save(); render(); toast('Seeded copy added.');
        });
        break;
      case 'st-edit': stageSheet(editingTemplateId, id); break;
      case 'st-up': moveStage(id, -1); break;
      case 'st-down': moveStage(id, 1); break;
      case 'st-add': addStageSheet(); break;

      // ---------------------------------------------------------- planner
      case 't-fridge':
        el.setAttribute('aria-checked', el.getAttribute('aria-checked') !== 'true');
        break;
      case 'opt-apply': applyOption(id); break;
      case 'plan-ics':
        download(P.toICS(state.draft.events, findTemplate(state.draft.params.templateId).name),
          slug(findTemplate(state.draft.params.templateId).name) + '-' +
          new Date(state.draft.params.finishAt).toISOString().slice(0, 10) + '.ics', 'text/calendar');
        toast('Calendar file exported.');
        break;
      case 'plan-start':
        if (state.activeProcessId) {
          confirmSheet('There is a bake running', 'Starting this plan abandons the one in progress.', 'Start anyway', function () {
            var old = activeProcess();
            endBulkRecord(old); old.status = 'abandoned'; old.finishedAt = Date.now();
            startPlan();
          });
        } else startPlan();
        break;

      // ---------------------------------------------------------- process
      case 'proc-menu': processMenuSheet(); break;
      case 'proc-start': startStage(activeProcess(), id); break;
      case 'proc-tick': completeStage(activeProcess(), id); break;
      case 'proc-note': stageNoteSheet(activeProcess(), id); break;
      case 'tl-toggle': timelineOpen = !timelineOpen; render(); break;
      case 'proc-finish':
        closeSheet();
        confirmSheet('Finish this bake?', 'Anything still unticked stays unticked in history.', 'Finish', function () {
          finishProcess(activeProcess());
        });
        break;
      case 'proc-ics':
        var pr = activeProcess();
        var tlx = projectProcess(pr, Date.now());
        download(P.toICS(tlx.events.filter(function (e) { return e.actualEnd == null; }), pr.name),
          slug(pr.name) + '.ics', 'text/calendar');
        closeSheet(); toast('Calendar file exported.');
        break;
      case 'openproc': openBakeId = id; render(); break;
      case 'delproc':
        confirmSheet('Delete this bake?', 'The timeline, the stage notes and the bulk readings go with it.', 'Delete', function () {
          var gone = state.processes.filter(function (x) { return x.id === id; })[0];
          if (gone && gone.bulkBakeId) state.bakes = state.bakes.filter(function (b) { return b.id !== gone.bulkBakeId; });
          state.processes = state.processes.filter(function (x) { return x.id !== id; });
          if (state.activeProcessId === id) state.activeProcessId = null;
          openBakeId = null; save(); render(); toast('Deleted.');
        });
        break;
      case 'proc-ics-old':
        var op = state.processes.filter(function (x) { return x.id === id; })[0];
        download(P.toICS(projectProcess(op, Date.now()).events, op.name), slug(op.name) + '.ics', 'text/calendar');
        toast('Calendar file exported.');
        break;
      case 'csv': exportCSV(); break;
      case 'csv-stages': exportStagesCSV(); break;
      case 'openbake': openBakeId = id; render(); break;
      case 'closebake': openBakeId = null; render(); break;
      case 'delbake':
        confirmSheet('Delete this bake?', 'The readings and crumb note go with it. This cannot be undone.', 'Delete', function () {
          state.bakes = state.bakes.filter(function (b) { return b.id !== id; });
          if (state.activeId === id) state.activeId = null;
          openBakeId = null; save(); render(); toast('Deleted.');
        });
        break;
      case 'resetcal':
        confirmSheet('Reset calibration to 1.0?', 'The jar readings stay on the chart, but they stop steering the projection until you log a new one.', 'Reset', function () {
          var bake = activeBake();
          bake.readings.forEach(function (r) { if (r.rise != null) r.ignoreCal = true; });
          save(); render(); toast('Back to the table.');
        });
        break;
    }
  }

  // ---------------------------------------------------------------- boot
  function tick() {
    var busy = document.getElementById('sheet-root').firstChild;
    if ((view === 'live' || view === 'process') && !busy) render();
    else syncAlerts();
  }
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { render(); ensureWakeLock(); }
    else releaseWakeLock();
  });
  window.addEventListener('focus', function () { if (view === 'live') render(); });
  window.addEventListener('pageshow', function () { render(); });
  document.addEventListener('pointerdown', function once() {
    unlockAudio();
    document.removeEventListener('pointerdown', once);
  });

  console.log('%cBulk Ferment Tracker — model fit from the Dough Temping Guide', 'font-weight:bold');
  console.log('rate  r(T) = %s * exp(%s * T)   per hour   R² = %s   rmse %s h⁻¹',
    M.RATE_FIT.a.toPrecision(4), M.RATE_FIT.b.toPrecision(5), M.RATE_FIT.r2.toFixed(4), M.RATE_FIT.rmse.toPrecision(3));
  console.log('rise  P(T) = %s * exp(%s * T)   %%        R² = %s   rmse %s pp',
    M.RISE_FIT.a.toPrecision(5), M.RISE_FIT.b.toPrecision(5), M.RISE_FIT.r2.toFixed(4), M.RISE_FIT.rmse.toPrecision(3));
  console.table(M.TABLE.slice().sort(function (a, b) { return a.c - b.c; }).map(function (r) {
    return {
      '°C': r.c, 'table h': r.hours, 'fitted h': +M.hoursAt(r.c).toFixed(2), 'Δh': +(M.hoursAt(r.c) - r.hours).toFixed(2),
      'table %': r.rise, 'fitted %': +M.targetRisePct(r.c).toFixed(1), 'Δ%': +(M.targetRisePct(r.c) - r.rise).toFixed(1)
    };
  }));

  /* Persist on boot so the seeded template and any v1 migration are durable
   * even if the first thing you do is close the tab. */
  save();
  view = state.activeProcessId ? 'process' : state.activeId ? 'live' : 'home';
  render();
})();
