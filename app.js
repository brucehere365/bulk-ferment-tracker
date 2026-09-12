/* Bulk Ferment Tracker — UI.
 * All state lives in localStorage. Nothing about the bulk is derived from a
 * running timer: every number on screen is recomputed from stored timestamps,
 * so a backgrounded tab or a sleeping phone changes nothing. */
(function () {
  'use strict';

  var M = window.BFModel;
  var H = M.MS_PER_HOUR;
  var KEY = 'bft.v1';
  var PREV = 'bft.v1.prev';       // the write before the current one
  var QUAR = 'bft.v1.corrupt';    // a payload that would not parse, kept rather than dropped

  /* ----------------------------------------------------------- storage
   * Losing a bake mid-bulk is the one failure this app is not allowed to
   * have, and every way it has actually happened was storage-shaped:
   *
   *   - one key, so a single bad write took everything with it;
   *   - a read error falling through to a blank state, which the next save
   *     then wrote over the top of — the loss made permanent one line later;
   *   - one origin, so a different URL, or a Home Screen icon beside a Safari
   *     tab, is a different empty app holding none of your bakes.
   *
   * So: every write leaves the copy it replaced behind, a payload that will
   * not parse is quarantined instead of overwritten, a write that does not
   * read back is reported rather than assumed, and the whole state is
   * mirrored into IndexedDB so a cleared localStorage is still recoverable.
   * None of that helps across origins — that is what the JSON backup is for,
   * and why it is reachable from the screen you land on with nothing. */

  function blank() {
    return {
      version: 3, activeId: null, bakes: [], deleted: {}, savedAt: 0,
      settings: { sound: true, notify: false }
    };
  }

  /* v2 carried recipe templates and multi-stage bakes alongside the bulk
   * ferments. Those are gone; the bulk ferments they wrapped are ordinary
   * bakes and stay exactly as they were. */
  function normalize(s) {
    var d = blank();
    s.settings = Object.assign(d.settings, s.settings || {});
    s.bakes = s.bakes || [];
    s.deleted = s.deleted || {};
    delete s.templates; delete s.processes; delete s.activeProcessId; delete s.draft;
    s.version = 3;
    s.savedAt = s.savedAt || 0;
    return s;
  }

  function readKey(k) {
    var raw;
    try { raw = localStorage.getItem(k); }
    catch (e) { return null; }              // storage blocked outright
    if (!raw) return null;
    try { return normalize(JSON.parse(raw)); }
    catch (e) {
      /* Keep it. A half-written payload is still most of a bake, and a human
       * can get it back out of the console; blank() cannot. */
      if (k === KEY) { try { localStorage.setItem(QUAR, raw); } catch (e2) {} }
      console.warn('Saved state at ' + k + ' would not parse — kept a copy at ' + QUAR + '.', e);
      return null;
    }
  }

  var bootedEmpty = false;        // nothing was found; do not save over anything yet
  var recoveredFrom = null;       // which copy we are running on, if not the main one
  function load() {
    var s = readKey(KEY);
    if (!s) { s = readKey(PREV); if (s) recoveredFrom = 'the previous save'; }
    if (!s) { s = blank(); bootedEmpty = true; }
    return s;
  }
  var state = load();

  var storageBroken = false;
  function save() {
    state.savedAt = Date.now();
    var text = JSON.stringify(state);
    try {
      var current = localStorage.getItem(KEY);
      if (current && current !== text) localStorage.setItem(PREV, current);
      localStorage.setItem(KEY, text);
      /* A write that does not read back did not happen. Private Browsing and
       * a full quota both fail here, and both used to fail quietly. */
      if (localStorage.getItem(KEY) !== text) throw new Error('write did not read back');
      if (storageBroken) toast('Saving again.');
      storageBroken = false;
      bootedEmpty = false;
    } catch (e) {
      storageBroken = true;
      console.error('Could not save state.', e);
      toast('Not saving — this browser is blocking storage. Export a backup.');
    }
    idbPut(text);
    syncSoon();
  }

  /* The mirror. Best effort by design: localStorage stays the source of truth
   * because it is synchronous and the app re-reads it on every render. This
   * exists purely so that "localStorage got cleared" is survivable. */
  var idb = null, idbTried = false, idbQueue = [];
  function idbOpen(cb) {
    if (idbTried) return cb(idb);
    if (typeof indexedDB === 'undefined' || !indexedDB) { idbTried = true; return cb(null); }
    idbQueue.push(cb);
    if (idbQueue.length > 1) return;        // an open is already in flight
    var req;
    try { req = indexedDB.open('bft', 1); }
    catch (e) { idbTried = true; return flushIdb(null); }
    req.onupgradeneeded = function () { req.result.createObjectStore('state'); };
    req.onsuccess = function () { idb = req.result; idbTried = true; flushIdb(idb); };
    req.onerror = function () { idbTried = true; flushIdb(null); };
    req.onblocked = function () { idbTried = true; flushIdb(null); };
  }
  function flushIdb(db) {
    var q = idbQueue; idbQueue = [];
    q.forEach(function (cb) { cb(db); });
  }
  function idbPut(text) {
    idbOpen(function (db) {
      if (!db) return;
      try { db.transaction('state', 'readwrite').objectStore('state').put(text, 'current'); }
      catch (e) { /* the mirror is allowed to fail; localStorage is the record */ }
    });
  }
  function idbGet(cb) {
    idbOpen(function (db) {
      if (!db) return cb(null);
      try {
        var r = db.transaction('state', 'readonly').objectStore('state').get('current');
        r.onsuccess = function () { cb(r.result || null); };
        r.onerror = function () { cb(null); };
      } catch (e) { cb(null); }
    });
  }

  /* On boot, ask the mirror whether it knows more than localStorage does. It
   * does exactly when localStorage was cleared underneath us — which is the
   * case this whole layer exists for. */
  function recoverFromMirror() {
    idbGet(function (text) {
      if (!text) return;
      var m;
      try { m = normalize(JSON.parse(text)); } catch (e) { return; }
      var gained = m.bakes.length - state.bakes.length;
      if ((m.savedAt || 0) <= (state.savedAt || 0) && gained <= 0) return;
      var wasEmpty = bootedEmpty;
      state = m;
      save();
      view = state.activeId ? 'live' : view;
      render();
      toast(wasEmpty
        ? 'Recovered ' + m.bakes.length + ' bake' + (m.bakes.length === 1 ? '' : 's') + ' from the backup copy.'
        : 'Restored a newer saved copy.');
    });
  }

  /* Chrome and Firefox will exempt an origin from eviction under storage
   * pressure if you ask. Safari ignores it; adding to the Home Screen is what
   * does the equivalent there. Cheap either way. */
  function askForPersistence() {
    try {
      if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    } catch (e) { /* not supported; nothing to fall back to */ }
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
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function n1(v) { return (Math.round(v * 10) / 10).toString(); }

  /* Phone keyboards in most of Europe put a comma where the decimal point
   * goes, and `parseFloat('23,5')` is 23. Both separators mean the same thing
   * in a kitchen, so every number typed into this app comes through here. */
  function parseNum(v) {
    var s = String(v == null ? '' : v).trim().replace(/,/g, '.');
    return s === '' ? NaN : parseFloat(s);
  }

  /* Night is the same layout dimmed, not a different app, and it is automatic:
   * 23:00 to 06:00 are the hours this thing actually gets read in, and a
   * Day/Night pin was one more decision on a screen that should ask for none. */
  function isNight() {
    var h = new Date().getHours();
    return h >= 23 || h < 6;
  }
  function applyTheme() {
    var night = isNight();
    document.documentElement.classList.toggle('night', night);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', night ? '#191614' : '#F7F1E8');
  }

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
      s.push('<line x1="' + padL + '" y1="' + Y(v).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(v).toFixed(1) + '" class="c-grid" stroke-width="1"/>');
      s.push('<text x="' + (padL - 5) + '" y="' + (Y(v) + 3.5).toFixed(1) + '" class="c-axis" font-size="9.5" text-anchor="end">' + v + '</text>');
    }
    // time ticks
    var hSpan = span / H;
    var stepH = [0.5, 1, 2, 3, 4, 6, 8, 12].filter(function (x) { return hSpan / x <= 6; })[0] || 24;
    var base = new Date(t0); base.setMinutes(0, 0, 0);
    for (var t = base.getTime(); t <= tEnd; t += stepH * H) {
      if (t < t0) continue;
      s.push('<line x1="' + X(t).toFixed(1) + '" y1="' + padT + '" x2="' + X(t).toFixed(1) + '" y2="' + (HT - padB) + '" class="c-vgrid" stroke-width="1"/>');
      s.push('<text x="' + X(t).toFixed(1) + '" y="' + (HT - padB + 13) + '" class="c-axis" font-size="9.5" text-anchor="middle">' + clock(t) + '</text>');
    }

    // target band — moves vertically with the current temperature
    var bandLo = Y(st.target * 1.04), bandHi = Y(st.target * 0.96);
    s.push('<rect x="' + padL + '" y="' + bandLo.toFixed(1) + '" width="' + (W - padL - padR) + '" height="' + Math.max(3, bandHi - bandLo).toFixed(1) + '" class="c-band"/>');
    s.push('<line x1="' + padL + '" y1="' + Y(st.target).toFixed(1) + '" x2="' + (W - padR) + '" y2="' + Y(st.target).toFixed(1) + '" class="c-target" stroke-width="1" stroke-dasharray="3 5"/>');
    s.push('<text x="' + (padL + 3) + '" y="' + (Y(st.target) - 4).toFixed(1) + '" class="c-target-text" font-size="9.5">target ' + Math.round(st.target) + '%</text>');

    // temperature, right axis — subdued context
    s.push('<path d="' + path(ser.history, function (p) { return Y2(p.temp); }) + '" fill="none" class="c-temp" stroke-width="1.2" stroke-linejoin="round"/>');
    ser.tempMarks.forEach(function (m) {
      s.push('<rect x="' + (X(m.t) - 2).toFixed(1) + '" y="' + (Y2(m.temp) - 2).toFixed(1) + '" width="4" height="4" class="c-temp-mark"/>');
    });
    [tMin + (tMax - tMin) * 0.12, (tMin + tMax) / 2, tMax - (tMax - tMin) * 0.12].forEach(function (tv) {
      s.push('<text x="' + (W - padR + 4) + '" y="' + (Y2(tv) + 3.5).toFixed(1) + '" class="c-temp-axis" font-size="9.5">' + n1(Math.round(tv * 2) / 2) + '°</text>');
    });

    // modelled rise so far
    s.push('<path d="' + path(ser.history, function (p) { return Y(p.rise); }) + '" fill="none" class="c-rise" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>');

    // projection
    if (ser.projection.length && !opts.historic) {
      s.push('<path d="' + path(ser.projection, function (p) { return Y(p.rise); }) + '" fill="none" class="c-proj" stroke-width="2" stroke-dasharray="4 6" stroke-linecap="round"/>');
    }

    // jar readings
    ser.observed.forEach(function (o) {
      s.push('<circle cx="' + X(o.t).toFixed(1) + '" cy="' + Y(o.rise).toFixed(1) + '" r="4.6" class="c-jar" stroke-width="2.2"/>');
    });

    // now
    s.push('<line x1="' + X(now).toFixed(1) + '" y1="' + padT + '" x2="' + X(now).toFixed(1) + '" y2="' + (HT - padB) + '" class="c-now" stroke-width="1" stroke-dasharray="2 3"/>');
    s.push('<text x="' + X(now).toFixed(1) + '" y="' + (padT - 4) + '" class="c-now-text" font-size="9.5" text-anchor="' + (opts.historic ? 'end' : 'middle') + '">' + (opts.historic ? 'end' : 'now') + '</text>');

    // predicted end
    if (st.predictedEnd >= t0 && st.predictedEnd <= tEnd) {
      var xe = X(st.predictedEnd), ye = Y(st.target);
      s.push('<line x1="' + xe.toFixed(1) + '" y1="' + ye.toFixed(1) + '" x2="' + xe.toFixed(1) + '" y2="' + (HT - padB) + '" class="c-end" stroke-width="1"/>');
      s.push('<circle cx="' + xe.toFixed(1) + '" cy="' + ye.toFixed(1) + '" r="4" class="c-end-dot"/>');
      var right = xe > W * 0.6;
      s.push('<text x="' + (right ? xe - 6 : xe + 6).toFixed(1) + '" y="' + (ye + 15).toFixed(1) + '" class="c-end-text" font-size="10.5" text-anchor="' + (right ? 'end' : 'start') + '">' + clock(st.predictedEnd) + '</text>');
    }
    s.push('</svg>');

    return '<div class="chartwrap">' + s.join('') +
      '<div class="legend">' +
      '<span><i style="border-color:var(--ink)"></i>rise %</span>' +
      (opts.historic ? '' : '<span><i style="border-color:var(--muted-2);border-top-style:dashed"></i>projected</span>') +
      (ser.observed.length ? '<span><i style="border:2px solid var(--accent);border-radius:50%;width:8px;height:8px;vertical-align:-1px"></i>jar reading</span>' : '') +
      '<span><i style="border-color:var(--temp-line)"></i>dough temp</span>' +
      '</div></div>';
  }


  var view = 'start';
  var lastView = null;

  /* Two screens, and which one you get is not a choice you make: either a bulk
   * is running or it is not. There is no nav, because there is nowhere to go. */
  var VIEWS = {
    start: function () { return startView(); },
    live: function () { return liveView(activeBake()); }
  };

  function render() {
    var app = document.getElementById('app');
    if (view === 'live' && !activeBake()) view = 'start';
    applyTheme();
    /* Entrance animations belong to arriving at a view, not to the clock. */
    app.className = view === lastView ? '' : 'enter';
    lastView = view;
    app.innerHTML = (VIEWS[view] || VIEWS.start)();
    bindAll(app);
    if (view === 'live') syncAlerts(); else clearTimers();
  }

  // ---------------------------------------------------------- start view
  /* There is one thing this app does, so opening it either lands you on the
   * bulk you are already running or on the form that starts one. No mode
   * picker: nobody wants to choose anything at 6am with dough on the bench. */
  function startView() {
    return '' +
      '<div class="topbar">' +
      '<h1><span class="sub">' + new Date().toLocaleDateString(undefined, { weekday: 'long' }) +
      ' · the dough decides</span>Bulk <b>ferment</b></h1>' +
      '<button class="iconbtn" data-act="menu" aria-label="Settings">•••</button></div>' +
      '<div class="hero setup"><div class="label">No bake running</div>' +
      '<div class="remain" style="margin-top:8px">Take the dough temperature and start the clock.</div></div>' +
      '<form id="startform">' +
      '<label class="field">Dough temperature °C' +
      /* Text, not number: a `type=number` field silently discards a comma, and
       * half the phones that open this app put a comma on the decimal key. */
      '<input name="temp" type="text" inputmode="decimal" autocomplete="off" placeholder="24.5" required></label>' +
      '<div class="err" id="starterr"></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn primary" type="submit">Start bulk</button>' +
      '</form>' +
      /* Settings are reachable from the screen you land on when a bake has gone
       * missing, because that is the screen you are on when you need the
       * backup — not only from a menu that needs a running bake to exist. */
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="menu">Settings</button>';
  }

  function defaultName() {
    return new Date().toLocaleDateString(undefined, { day: 'numeric', month: 'short' }) + ' bake';
  }

  function lastTempAt(bake) {
    var withTemp = M.sortReadings(bake.readings).filter(function (r) { return r.temp != null; });
    return withTemp.length ? withTemp[withTemp.length - 1].t : bake.startedAt;
  }

  /* Newest first, each one editable: a mistyped temperature is not a cosmetic
   * problem — 42 where you meant 24 throws the whole projection out — so there
   * has to be a way back to the number without abandoning the bake. */
  function readingsList(bake) {
    var readings = M.sortReadings(bake.readings).slice().reverse();
    return '<div class="section-title">Readings</div>' +
      '<ul class="readings">' + readings.map(function (r) {
        if (r.temp == null) return '';
        var sub = [];
        if (r.gapTemp != null) sub.push('gap held at ' + n1(r.gapTemp) + '°');
        if (M.isExtrapolated(r.temp)) sub.push('outside the table');
        return '<li class="reading"><span class="when">' + clock(r.t) + '</span>' +
          '<span class="what"><b>' + n1(r.temp) + '°C</b><em>' + esc(sub.join(' · ')) + '</em></span>' +
          '<button class="edit" data-act="edit" data-id="' + r.id + '" aria-label="Fix this reading">Fix</button></li>';
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

    return '' +
      '<div class="topbar">' +
      '<h1><span class="sub">Started ' + clock(bake.startedAt) + ' · ' + dur(now - bake.startedAt) + ' in</span>' + esc(bake.name) + '</h1>' +
      '<button class="iconbtn" data-act="menu" aria-label="Settings">•••</button></div>' +
      /* A toast you might not be looking at is not enough to tell someone the
       * bake in front of them is not being written down. */
      (storageBroken
        ? '<button class="alarmbar" data-act="menu">Not saving. This browser is blocking storage — ' +
          'tap to export a backup before you lose this bake.</button>' : '') +
      hero +
      '<div class="stats">' +
      '<div class="stat"><div class="k">Progress</div><div class="v">' + Math.round(st.progress * 100) + '<small>%</small></div>' +
      '<div class="progressbar' + (st.ready ? ' ready' : '') + '"><i style="width:' + pct + '%"></i></div></div>' +
      '<div class="stat"><div class="k">Dough temp</div><div class="v">' + n1(st.currentTemp) + '<small>°C</small></div>' +
      (st.extrapolated ? '<span class="flag">outside the table</span>' : '<div class="k" style="margin-top:8px">as of ' + clock(lastTempAt(bake)) + '</div>') + '</div>' +
      /* Both of these come from temperature and progress alone — no jar, nothing
       * to log. They are what you hold the bowl up against: the dough should be
       * about this far up now, and this far up when it is done. */
      '<div class="stat"><div class="k">Risen by now</div><div class="v">' + Math.round(st.expectedRise) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">what the bowl should show</div></div>' +
      '<div class="stat"><div class="k">Risen when ready</div><div class="v">' + Math.round(st.target) + '<small>%</small></div>' +
      '<div class="k" style="margin-top:8px">at ' + n1(st.currentTemp) + '°C</div></div>' +
      '</div>' +
      chartSVG(bake.readings, now) +
      (st.gapPending ? '<p class="note center">No reading for ' + dur(st.sinceLastMs) + ' — the next entry will ask what happened in between.</p>' : '') +
      /* Invariant 4: the bulk never ends itself. The tap that ends it is the
       * primary button and the only one, because deciding the dough is done is
       * the whole job — logging another temperature is just refining the guess. */
      '<div class="actions" style="grid-template-columns:1fr">' +
      '<button class="btn primary" data-act="finish">Preshape now — finish bulk</button>' +
      '<button class="btn" data-act="logtemp">Log temperature</button>' +
      '</div>' +
      readingsList(bake) +
      '<div class="cues">' +
      '<div class="lede">The clock is a suggestion. The dough decides.</div>' +
      '<ul><li>Domed, not flat</li><li>Jiggles as one mass</li>' +
      '<li>Bubbles visible at the edges and surface</li>' +
      '<li>Feels alive and airy, not soupy</li></ul></div>';
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
      '<input id="numval" type="text" inputmode="decimal" autocomplete="off" ' +
      'value="' + (opts.value == null ? '' : opts.value) + '">' +
      '<span class="unit">' + esc(opts.unit) + '</span>' +
      '</div>' +
      keypad() +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row">' +
      '<button class="btn ghost" data-act="cancel">Cancel</button>' +
      '<button class="btn primary" data-act="save">Save</button></div>';
    openSheet(html, function (sheet) {
      var input = sheet.querySelector('#numval');
      sheet.addEventListener('click', function (e) {
        var act = e.target.dataset.act;
        if (act === 'inc' || act === 'dec') {
          var v = parseNum(input.value);
          if (isNaN(v)) v = opts.value == null ? 0 : opts.value;
          v = M.clamp(v + (act === 'inc' ? 1 : -1) * opts.step, opts.min, opts.max);
          input.value = Math.round(v * 100) / 100;
        }
        if (act === 'cancel') closeSheet();
        if (act === 'save') {
          var val = parseNum(input.value);
          if (isNaN(val)) return err('Enter a number.');
          opts.onSave(val, sheet);
        }
      });
      /* The field opens on the last reading as a starting point, so the first
       * key typed replaces it rather than appending to it. */
      var fresh = true;
      sheet.addEventListener('click', function (e) {
        var key = e.target.closest('[data-key]');
        if (!key) return;
        var ch = key.dataset.key;
        if (fresh && ch !== 'del') input.value = '';
        fresh = false;
        var cur = input.value;
        if (ch === 'del') input.value = cur.slice(0, -1);
        else if (ch === '.') { if (cur.indexOf('.') < 0) input.value = (cur || '0') + '.'; }
        else input.value = cur === '0' ? ch : cur + ch;
      });
      /* A comma typed on the phone's own keyboard becomes a point as it lands,
       * so what you see in the big field is what gets saved. */
      input.addEventListener('input', function () {
        fresh = false;
        if (input.value.indexOf(',') >= 0) input.value = input.value.replace(/,/g, '.');
      });
      input.addEventListener('keydown', function (e) { if (e.key === 'Enter') sheet.querySelector('[data-act="save"]').click(); });
    });
  }

  /* Every temperature in the app comes through here, so the keys are 70px
   * and the value is big enough to read with the phone flat on the counter. */
  function keypad() {
    var keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', 'del'];
    return '<div class="keypad">' + keys.map(function (k) {
      return '<button type="button" class="' + (k === 'del' ? 'del' : '') + '" data-key="' + k + '"' +
        (k === 'del' ? ' aria-label="Delete"' : '') + '>' + (k === 'del' ? '\u232B' : k) + '</button>';
    }).join('') + '</div>';
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
      '<input id="gaptemp" type="text" inputmode="decimal" autocomplete="off"></label>' +
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
            var v = parseNum(sheet.querySelector('#gaptemp').value);
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

  function commit(bake, fields) {
    var reading = {
      id: uid(), t: Date.now(),
      temp: fields.temp == null ? null : fields.temp,
      rise: null,
      gapTemp: fields.gapTemp == null ? null : fields.gapTemp
    };
    var v = M.validateReading(bake.readings, reading);
    if (!v.ok) return err(v.message);
    var before = M.stateAt(bake.readings, Date.now());
    bake.readings.push(reading);
    save(); closeSheet(); render();
    /* If the write failed, save() has already said so and that is the more
     * important thing on screen. Never follow it with "Logged." */
    if (storageBroken) return;
    var after = M.stateAt(bake.readings, Date.now());
    if (!before.empty && !after.ready) {
      var shift = after.predictedEnd - before.predictedEnd;
      if (Math.abs(shift) > 4 * 60000) {
        toast('Preshape moved ' + dur(Math.abs(shift)) + ' ' + (shift > 0 ? 'later' : 'earlier') + ' — now ' + clock(after.predictedEnd));
      } else { toast('Logged.'); }
    } else { toast('Logged.'); }
  }

  /* Fixing a reading is the same keypad you logged it on — one number, no
   * form. The time it was taken is not editable: it is what actually happened,
   * and the only thing anyone ever needs to correct is a fat-fingered digit. */
  function editReading(id) {
    var bake = activeBake();
    var r = bake.readings.filter(function (x) { return x.id === id; })[0];
    if (!r || r.temp == null) return;
    numberSheet({
      title: 'Reading at ' + clock(r.t),
      hint: 'Everything after it is recalculated from the first reading.',
      value: r.temp, step: 0.5, min: M.TEMP_MIN, max: M.TEMP_MAX, unit: '°C',
      onSave: function (v) {
        var cand = { id: id, t: r.t, temp: v, rise: r.rise, gapTemp: r.gapTemp };
        var ok = M.validateReading(bake.readings, cand);
        if (!ok.ok) return err(ok.message);
        var i = bake.readings.findIndex(function (x) { return x.id === id; });
        bake.readings[i] = cand;
        save(); closeSheet(); render(); toast('Recalculated.');
      }
    });
  }

  /* Asked once, on a genuinely fresh install, because handing someone a link
   * and a code only works if the app they open actually asks for the code.
   * Skippable in one tap: sync is optional and the app is fully usable without
   * it, so this must never be a gate in front of starting a bulk. */
  function firstRunSheet() {
    openSheet(
      '<h2>Do you have a code?</h2>' +
      '<p class="hint">A code keeps your bakes off this phone as well as on it, so they are ' +
      'still here on another device — or if this browser forgets them. If someone gave you ' +
      'one, type it in.</p>' +
      '<p class="hint">One code each. A different code is a completely separate set of bakes, ' +
      'so yours and theirs never mix. Anyone who knows a code can read those bakes, so make ' +
      'it long — at least ' + SYNC_MIN + ' characters.</p>' +
      '<label class="field">Your private code' +
      '<input id="synccode" type="text" inputmode="text" autocomplete="off" autocapitalize="none" ' +
      'spellcheck="false" placeholder="your-own-long-phrase"></label>' +
      '<div class="err" id="sheeterr"></div>' +
      '<div class="row">' +
      '<button class="btn ghost" data-act="firstrun-skip">Just this phone</button>' +
      '<button class="btn primary" data-act="firstrun-save">Turn on</button></div>' +
      '<div class="spacer"></div>' +
      '<p class="note">You can change this later under Settings.</p>',
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          var a = e.target.closest('[data-act]');
          var act = a && a.dataset.act;
          if (act === 'firstrun-skip') {
            syncState.asked = true; writeSync(); closeSheet();
            toast('Bakes stay on this phone. Settings can change that.');
          }
          if (act === 'firstrun-save') {
            var v = (sheet.querySelector('#synccode').value || '').trim();
            if (v.length < SYNC_MIN) return err('At least ' + SYNC_MIN + ' characters.');
            saveSyncCode(v);
            closeSheet();
            toast('On. Your bakes are saved under that code.');
            syncNow(true);
          }
        });
      });
  }

  /* One sheet, because there was nowhere obvious for any of this to live and
   * the code in particular was three taps deep inside something called Backup.
   * It goes first here: it is the only setting you have to enter to get the
   * app working across your phones, and the only one anyone hands to a friend. */
  function settingsSheet() {
    var s = state.settings;
    var on = !!syncState.code;
    var n = state.bakes.length;
    openSheet(
      '<h2>Settings</h2>' +

      '<div class="section-title">Your code</div>' +
      '<p class="hint">' + (on
        ? 'On. Your bakes are saved off this phone and appear on any device you type this code into.'
        : 'Off. Bakes are saved on this phone only.') + '</p>' +
      '<p class="hint">One code each. Someone baking with a different code has their own separate ' +
      'bakes that never touch yours — that is how you give a friend an account. Never share yours: ' +
      'two people on one code share a single set of bakes, including which one is running now. ' +
      'Anyone who knows it can read your bakes, so make it long. At least ' + SYNC_MIN + ' characters.</p>' +
      '<label class="field">Your private code' +
      '<input id="synccode" type="text" inputmode="text" autocomplete="off" autocapitalize="none" ' +
      'spellcheck="false" value="' + esc(syncState.code || '') + '" placeholder="your-own-long-phrase"></label>' +
      /* err() writes here, so it has to exist before anything goes wrong. */
      '<div class="err" id="sheeterr">' + esc(syncState.error || '') + '</div>' +
      '<div class="row">' +
      '<button class="btn primary" data-act="sync-save">' + (on ? 'Save' : 'Turn on') + '</button>' +
      (on ? '<button class="btn ghost" data-act="sync-off">Turn off</button>' : '') + '</div>' +
      (on && syncState.at ? '<p class="note">Last saved to the server ' + clock(syncState.at) + dayTag(syncState.at) + '.</p>' : '') +

      '<div class="section-title">Alarm</div>' +
      '<div class="toggle"><div class="t">Sound<em>Beeps when the bulk is ready.</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.sound + '" data-act="t-sound"><i></i></button></div>' +
      '<div class="toggle"><div class="t">Notification<em>' + notifyStatus() + '</em></div>' +
      '<button class="switch" role="switch" aria-checked="' + !!s.notify + '" data-act="t-notify"><i></i></button></div>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="testalarm">Test the alarm</button>' +

      '<div class="section-title">Your bakes</div>' +
      '<p class="hint">' + n + ' bake' + (n === 1 ? '' : 's') + ' on this phone' +
      (state.savedAt ? ', last saved ' + clock(state.savedAt) + dayTag(state.savedAt) : '') + '.' +
      (storageBroken ? ' This browser is refusing to save — export a backup now.' : '') +
      (recoveredFrom ? ' Running on ' + esc(recoveredFrom) + '; the main copy would not load.' : '') + '</p>' +
      '<p class="hint">A backup file is the only thing that moves your bakes to a different web ' +
      'address, since stored bakes do not follow one. Restoring merges: it adds what is missing ' +
      'and never deletes what is here.</p>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="backup-export">Export a backup</button>' +
      '<div class="spacer"></div>' +
      '<button class="btn small ghost" data-act="backup-import">Restore from a backup</button>' +
      installBlock() +

      (activeBake()
        ? '<div class="section-title">This bake</div>' +
          '<button class="btn small danger" data-act="abandon">Abandon this bake</button>'
        : ''),
      function (sheet) {
        sheet.addEventListener('click', function (e) {
          var a = e.target.closest('[data-act]');
          var act = a && a.dataset.act;
          if (act === 't-sound') { s.sound = !s.sound; save(); settingsSheet(); }
          if (act === 't-notify') {
            if (!s.notify && 'Notification' in window) {
              Notification.requestPermission().then(function (p) {
                s.notify = p === 'granted'; save(); settingsSheet();
                if (p !== 'granted') toast('Notifications are blocked in browser settings.');
              });
            } else { s.notify = false; save(); settingsSheet(); }
          }
          if (act === 'testalarm') { alarm('end'); toast('That is the sound.'); }
          if (act === 'backup-export') exportBackup();
          if (act === 'backup-import') importBackup();
          if (act === 'install' && installPrompt) {
            installPrompt.prompt();
            installPrompt = null;
            closeSheet();
          }
          if (act === 'sync-off') {
            saveSyncCode(null); syncState.at = 0; syncState.error = null;
            closeSheet(); toast('Off. Nothing new leaves this phone.');
          }
          if (act === 'sync-save') {
            var v = (sheet.querySelector('#synccode').value || '').trim();
            if (v.length < SYNC_MIN) return err('At least ' + SYNC_MIN + ' characters.');
            saveSyncCode(v);
            syncState.error = null;
            closeSheet();
            toast('On. Saving this phone’s bakes.');
            syncNow(true);
          }
          if (act === 'abandon') {
            confirmSheet('Abandon this bake?', 'The bake stops here and the readings are kept.', 'Abandon',
              function () { finishBake(true); });
          }
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

  /* Finished bakes are kept, not deleted — there is nowhere in the app to look
   * at them, but a mis-tap on the primary button must never be what destroys
   * one, and sync needs them to still exist to agree about them. */
  function finishBake(abandoned) {
    var bake = activeBake();
    if (!bake) return;
    bake.finishedAt = Date.now();
    bake.status = abandoned ? 'abandoned' : 'done';
    state.activeId = null;
    save(); closeSheet();
    view = 'start'; render();
    toast(abandoned ? 'Bake abandoned.' : 'Bulk finished. Go shape it.');
  }

  function startBake(form) {
    var f = form.elements;
    var temp = parseNum(f.temp.value);
    if (isNaN(temp) || temp < M.TEMP_MIN || temp > M.TEMP_MAX) {
      document.getElementById('starterr').textContent = 'Enter a dough temperature between ' + M.TEMP_MIN + ' and ' + M.TEMP_MAX + '°C.';
      return;
    }
    var now = Date.now();
    var bake = {
      id: uid(), name: defaultName(), startedAt: now, status: 'active',
      readings: [{ id: uid(), t: now, temp: temp, rise: null, gapTemp: null }],
      alerts: { end: null }
    };
    state.bakes.push(bake); state.activeId = bake.id;
    save(); view = 'live'; render();
    unlockAudio();
    toast('Bulk started at ' + n1(temp) + '°C.');
  }

  // ------------------------------------------------------------- backup
  /* The only copy that survives a new URL, a new phone or a wiped browser.
   * CSV is for reading afterwards; this is for getting the bake back. */
  function download(text, filename, mime) {
    var blob = new Blob([text], { type: mime });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  function exportBackup() {
    var payload = { app: 'trackmyloaf', version: 3, exportedAt: new Date().toISOString(), state: state };
    download(JSON.stringify(payload, null, 2),
      'trackmyloaf-backup-' + new Date().toISOString().slice(0, 10) + '.json', 'application/json');
    toast('Backup saved — ' + state.bakes.length + ' bake' + (state.bakes.length === 1 ? '' : 's') + '.');
  }

  /* Merge, never replace. Restoring onto a browser that already has bakes must
   * not throw them away, and the same bake logged on two phones should end up
   * as the copy that saw more of it rather than whichever loaded last. */
  function mergeBackup(incoming) {
    var byId = {};
    state.bakes.forEach(function (b) { byId[b.id] = b; });
    /* Deletions travel as tombstones both ways, so a bake removed here is not
     * resurrected by a restore, and one removed there is removed here. */
    Object.keys(incoming.deleted || {}).forEach(function (id) {
      if (!state.deleted[id]) state.deleted[id] = incoming.deleted[id];
    });
    var removed = 0;
    state.bakes = state.bakes.filter(function (b) {
      if (!state.deleted[b.id]) return true;
      delete byId[b.id]; removed++; return false;
    });
    var added = 0, updated = 0;
    (incoming.bakes || []).forEach(function (b) {
      if (!b || !b.id || state.deleted[b.id]) return;
      var mine = byId[b.id];
      if (!mine) { state.bakes.push(b); byId[b.id] = b; added++; return; }
      if ((b.readings || []).length > (mine.readings || []).length) {
        state.bakes[state.bakes.indexOf(mine)] = b; updated++;
      }
    });
    if (state.activeId && !byId[state.activeId]) state.activeId = null;
    if (!activeBake() && incoming.activeId && byId[incoming.activeId]) state.activeId = incoming.activeId;
    save();
    return { added: added, updated: updated, removed: removed };
  }

  function importBackup() {
    var input = document.createElement('input');
    input.type = 'file';
    input.accept = 'application/json,.json';
    input.addEventListener('change', function () {
      var file = input.files && input.files[0];
      if (!file) return;
      var reader = new FileReader();
      reader.onload = function () {
        var parsed;
        try { parsed = JSON.parse(reader.result); }
        catch (e) { return toast('That file is not a TrackMyLoaf backup.'); }
        var incoming = parsed && parsed.state ? parsed.state : parsed;
        if (!incoming || !incoming.bakes) return toast('That file has no bakes in it.');
        var r = mergeBackup(normalize(incoming));
        closeSheet();
        view = state.activeId ? 'live' : 'history';
        render();
        toast(r.added || r.updated
          ? 'Restored ' + r.added + ' bake' + (r.added === 1 ? '' : 's') +
            (r.updated ? ', updated ' + r.updated : '') + '.'
          : 'Nothing new in that backup — you already have all of it.');
      };
      reader.onerror = function () { toast('Could not read that file.'); };
      reader.readAsText(file);
    });
    input.click();
  }

  // --------------------------------------------------------------- sync
  /* Optional, off until a code is entered. Everything above still works
   * untouched with it off — this only ever adds a copy somewhere else, and can
   * never be the reason a bake is lost.
   *
   * A code is one baker's private bucket, not a shared room. Every device that
   * types the same code shares one set of bakes; a different code is a wholly
   * separate set the server never merges with it. Two people therefore get two
   * codes — one code between them would also share `activeId`, so starting a
   * bulk on one phone would move the other phone's live view onto it. The copy
   * in settingsSheet() says so, because the mistake is easy and silent. */
  var SYNC_KEY = 'bft.sync';
  var SYNC_MIN = 8;
  var syncState = { code: null, at: 0, error: null, busy: false, asked: false };
  try {
    var rawSync = JSON.parse(localStorage.getItem(SYNC_KEY) || 'null');
    if (rawSync) {
      syncState.code = rawSync.code || null;
      syncState.asked = !!rawSync.asked;
    }
  } catch (e) { /* no sync configured */ }

  /* `asked` outlives a cleared code on purpose: turning sync off is an answer,
   * and the first-run sheet must not come back and ask again. */
  function writeSync() {
    try {
      if (syncState.code || syncState.asked) {
        localStorage.setItem(SYNC_KEY, JSON.stringify({ code: syncState.code, asked: syncState.asked }));
      } else { localStorage.removeItem(SYNC_KEY); }
    } catch (e) { /* the code is a convenience; losing it costs one retype */ }
  }
  function saveSyncCode(code) {
    syncState.code = code || null;
    syncState.asked = true;
    writeSync();
  }

  var syncTimer = null;
  var syncApplying = false;
  /* Coalesced: logging three readings in a minute is one push, not three.
   * save() calls this, and applying a merge calls save(), so the flag is what
   * stops two phones pushing each other back and forth forever. */
  function syncSoon() {
    if (!syncState.code || syncApplying) return;
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { syncNow(false); }, 4000);
  }

  function syncNow(loud) {
    if (!syncState.code || syncState.busy) return;
    if (typeof fetch !== 'function') return;
    syncState.busy = true;
    fetch('api/sync', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code: syncState.code, state: state })
    }).then(function (res) {
      if (!res.ok) {
        return res.json()['catch'](function () { return {}; }).then(function (b) {
          throw new Error(b.error === 'sync-not-configured'
            ? 'Sync is not set up on the server yet.'
            : b.error === 'code-too-short' ? 'That code is too short.'
            : 'Sync failed (' + res.status + ').');
        });
      }
      return res.json();
    }).then(function (body) {
      syncState.busy = false;
      syncState.error = null;
      syncState.at = Date.now();
      syncApplying = true;
      var r;
      try { r = mergeBackup(normalize(body.state || {})); }
      finally { syncApplying = false; }
      if (r.added || r.updated || r.removed) {
        render();
        if (r.added || r.updated) {
          toast('Synced — ' + (r.added ? r.added + ' new' : r.updated + ' updated') + ' from your other device.');
        }
      } else if (loud) { toast('Synced. Everything already matches.'); }
    })['catch'](function (e) {
      syncState.busy = false;
      /* Offline is the normal case in a kitchen, not an error worth shouting
       * about. syncSoon() will pick it up next time something is logged. */
      syncState.error = e && e.message ? e.message : 'Sync failed.';
      if (loud) toast(syncState.error);
    });
  }

  /* Installed to the Home Screen, iOS stops wiping this app's storage after
   * seven idle days — which is the single most useful thing anyone can do
   * about losing a bake, so it is said where the storage conversation is
   * rather than in a banner nobody asked for. */
  function isInstalled() {
    try {
      return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
        navigator.standalone === true;
    } catch (e) { return false; }
  }
  function isIOS() {
    return /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  }
  /* Chrome hands over a prompt to fire later; Safari never will, so there the
   * only honest thing is to describe the taps. */
  var installPrompt = null;
  window.addEventListener('beforeinstallprompt', function (e) {
    e.preventDefault();
    installPrompt = e;
  });
  window.addEventListener('appinstalled', function () { installPrompt = null; });

  function installBlock() {
    if (isInstalled()) return '<p class="note">Running from the Home Screen — this browser keeps your bakes indefinitely.</p>';
    return '<div class="section-title">Keep it on the Home Screen</div>' +
      '<p class="hint">' + (isIOS()
        ? 'Safari clears the storage of sites you have not opened for seven days, and that takes your bakes with it. ' +
          'Added to the Home Screen it is exempt, and it opens without the browser bars. Share → Add to Home Screen.'
        : 'It opens faster, works with no signal, and the browser stops treating your bakes as disposable.') + '</p>' +
      (installPrompt ? '<div class="spacer"></div><button class="btn" data-act="install">Install on this phone</button>' : '');
  }

  // -------------------------------------------------------------- alerts
  var timers = [];
  function clearTimers() { timers.forEach(clearTimeout); timers = []; }

  function syncAlerts() {
    clearTimers();
    syncBulkAlerts();
  }

  function later(at) {
    timers.push(setTimeout(function () { syncAlerts(); }, Math.min(at - Date.now(), 2147483000) + 500));
  }

  /* One alarm, when the bulk is ready. A configurable heads-up was a number to
   * choose before you could use the app, for a warning you get by looking. */
  function syncBulkAlerts() {
    var bake = activeBake();
    if (!bake || !bake.readings.length) return;
    var now = Date.now();
    var st = M.stateAt(bake.readings, now);
    if (st.empty) return;
    bake.alerts = bake.alerts || { end: null };
    if (now >= st.predictedEnd) maybeFire(bake, st.predictedEnd);
    else later(st.predictedEnd);
  }

  /* Fired state is remembered against the time it fired for, so a moving
   * prediction re-arms the alert only if it moves materially (>15 min) later. */
  function maybeFire(bake, at) {
    var prev = bake.alerts.end;
    if (prev != null && at - prev < 15 * 60000) return;
    bake.alerts.end = at; save();
    var title = 'Ready — go read the dough.';
    alarm();
    notify(title, 'Domed, jiggly, bubbles at the edges. The dough decides.');
    toast(title);
  }

  var actx;
  function unlockAudio() {
    try {
      if (!actx) actx = new (window.AudioContext || window.webkitAudioContext)();
      if (actx.state === 'suspended') actx.resume();
    } catch (e) { /* no audio available */ }
  }
  function alarm() {
    if (!state.settings.sound) return;
    unlockAudio();
    if (!actx) return;
    var beeps = 6, freq = 940;
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

  // ------------------------------------------------------------- binding
  function bindAll(root) {
    root.querySelectorAll('[data-act]').forEach(function (el) {
      if (el.dataset.bound) return;
      el.dataset.bound = '1';
      var act = el.dataset.act;
      el.addEventListener('click', function () { dispatch(act, el.dataset.id, el); });
    });
    var form = root.querySelector('#startform');
    if (form && !form.dataset.bound) {
      form.dataset.bound = '1';
      form.addEventListener('submit', function (e) { e.preventDefault(); startBake(form); });
    }
  }

  function dispatch(act, id) {
    switch (act) {
      case 'logtemp': unlockAudio(); logTemp(); break;
      case 'edit': editReading(id); break;
      case 'menu': closeSheet(); settingsSheet(); break;
      case 'finish':
        /* Invariant 4: only ever an explicit tap, and the primary button on the
         * live view is a big one, so it asks before it ends the bulk. */
        confirmSheet('Finish this bulk?', 'The clock stops and you go back to the start screen.',
          'Finish', function () { finishBake(false); });
        break;
    }
  }

  // ---------------------------------------------------------------- boot
  function tick() {
    var busy = document.getElementById('sheet-root').firstChild;
    if (view === 'live' && !busy) render();
    else syncAlerts();
  }
  setInterval(tick, 15000);
  document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { render(); syncNow(false); }
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

  /* Persist on boot so the v2 migration is durable even if the first thing you
   * do is close the tab — but never when we booted with nothing. That save
   * used to run unconditionally, so a single unreadable payload became a
   * blank state and then, one line later, a permanently blank one. */
  if (!bootedEmpty) save();
  view = state.activeId ? 'live' : 'start';
  render();
  askForPersistence();
  recoverFromMirror();
  syncNow(false);
  if (recoveredFrom) toast('The main saved copy would not load — running on ' + recoveredFrom + '.');

  /* Only on a truly fresh install: nothing stored, nothing running, and never
   * answered before. An install that already has bakes has been in use, and
   * interrupting that with a modal would be the app nagging rather than asking. */
  if (bootedEmpty && !syncState.code && !syncState.asked && !state.bakes.length) firstRunSheet();
})();
