/* Bulk Ferment Tracker — UI.
 * All state lives in localStorage. Nothing about the bulk is derived from a
 * running timer: every number on screen is recomputed from stored timestamps,
 * so a backgrounded tab or a sleeping phone changes nothing. */
(function () {
  'use strict';

  var M = window.BFModel;
  var H = M.MS_PER_HOUR;
  var KEY = 'bft.v1';

  // ------------------------------------------------------------- storage
  function blank() {
    return { version: 1, activeId: null, bakes: [], settings: { leadMin: 30, sound: true, notify: false, wakeLock: true, useJar: true } };
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
      return s;
    } catch (e) { console.warn('Could not read saved state, starting fresh.', e); return blank(); }
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
  var view = 'start';
  var openBakeId = null;

  function render() {
    var app = document.getElementById('app');
    var bake = activeBake();
    if (view === 'live' && !bake) view = 'start';
    var html = view === 'live' ? liveView(bake) : view === 'history' ? historyView() : startView();
    app.innerHTML = html;
    bindAll(app);
    if (view === 'live') { syncAlerts(); ensureWakeLock(); } else { releaseWakeLock(); }
  }

  function startView() {
    var has = state.bakes.length > 0;
    return '' +
      '<div class="topbar"><h1>Bulk Ferment Tracker<span class="sub">The clock is a suggestion.</span></h1>' +
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
    var readings = M.sortReadings(bake.readings).slice().reverse();
    var byId = {};
    st.replay.points.forEach(function (p) { byId[p.id] = p; });

    return '' +
      '<div class="topbar">' +
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
      '<div class="section-title">Readings</div>' +
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
      }).join('') + '</ul>' +
      '<div class="cues">' +
      '<div class="lede">The clock is a suggestion. The dough decides.</div>' +
      '<ul><li>Domed, not flat</li><li>Jiggles as one mass</li>' +
      '<li>Bubbles visible at the edges and surface</li>' +
      '<li>Feels alive and airy, not soupy</li></ul></div>';
  }

  function historyView() {
    var done = state.bakes.filter(function (b) { return b.id !== state.activeId; })
      .sort(function (a, b) { return b.startedAt - a.startedAt; });
    var body = done.length ? done.map(bakeCard).join('') :
      '<div class="empty">No finished bakes yet.</div>';
    return '<div class="topbar"><button class="iconbtn" data-act="back">Back</button><h1>History</h1>' +
      (done.length ? '<button class="iconbtn" data-act="csv">CSV</button>' : '') + '</div>' + body;
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

  function startBake(form) {
    var temp = parseFloat(form.temp.value);
    if (isNaN(temp) || temp < M.TEMP_MIN || temp > M.TEMP_MAX) {
      document.getElementById('starterr').textContent = 'Enter a dough temperature between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + '°C.';
      return;
    }
    var now = Date.now();
    var bake = {
      id: uid(), name: (form.name.value || '').trim() || defaultName(),
      notes: (form.notes.value || '').trim(), startedAt: now, status: 'active',
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

  // -------------------------------------------------------------- alerts
  var timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function syncAlerts() {
    clearTimers();
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
      var delay = Math.min(at - now, 2147483000);
      timers.push(setTimeout(function () { syncAlerts(); }, delay + 500));
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
          var b = state.bakes.filter(function (x) { return x.id === el.dataset.id; })[0];
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
      case 'back': view = state.activeId ? 'live' : 'start'; openBakeId = null; render(); break;
      case 'csv': exportCSV(); break;
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
    if (view === 'live' && !document.getElementById('sheet-root').firstChild) render();
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

  view = state.activeId ? 'live' : (state.bakes.length ? 'start' : 'start');
  render();
})();
