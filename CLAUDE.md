# CLAUDE.md

Sourdough process & bulk ferment tracker. A static single-page app for running a
real bake — used on a phone, in a kitchen, at odd hours.

## How this project ships

**Cloudflare Pages is connected to the GitHub repo.** Pushing to `main` deploys.
There is no build step, no CI, no `wrangler.toml` — Cloudflare serves the repo
root as-is.

    git push origin main    →  Cloudflare Pages builds and deploys automatically

Remote: `https://github.com/brucehere365/bulk-ferment-tracker.git`

Consequences worth remembering:

* **A push is a deploy.** Never push speculative or half-finished work to `main`.
  Work on a branch, merge when it is actually done.
* **The site is exactly five files.** `index.html`, `model.js`, `process.js`,
  `app.js`, `styles.css`. Adding a new script means adding a `<script>` tag to
  `index.html` — forget it and the app boots into a blank screen.
* `*.tests.js`, `README.md`, `CLAUDE.md` are in the repo but are not part of the
  site. `node_modules/`, `package.json`, `package-lock.json` are gitignored.
* After a deploy, a phone with the old `index.html` cached will not pull a newly
  added script. Hard-refresh when the file list changes.

## Architecture

Plain ES5-style JavaScript, no framework, no bundler, no dependencies at
runtime. Two pure modules and one UI file.

| file | what it is |
|---|---|
| `model.js` | Fermentation model. Pure. `window.BFModel` / `require`. |
| `process.js` | Templates, reverse planner, timeline projection, `.ics`. Pure. `window.BFProcess`. |
| `app.js` | All UI and all storage. The only file that touches the DOM or `localStorage`. |
| `styles.css` | Dark, one accent colour. |

The pure modules take `now` as a parameter and own no clocks, no DOM and no
storage. That is what makes them testable in node and what lets the UI recompute
everything from stored timestamps after the phone has been asleep.

State lives entirely in `localStorage` under the key `bft.v1` (the key kept its
name through the v2 schema bump). There is no backend and no accounts.

## Invariants — do not break these

1. **`model.js` is the fermentation model and nothing else may predict a bulk.**
   Bulk length is always `BFModel.hoursAt(T)` = `1 / r(T)` from the fitted curve.
   Never hardcode a duration, and never write "doubled" as a target — target
   rise comes from `targetRisePct(T)`, which falls as temperature rises.
2. **Nothing is derived from a running timer.** Every number on screen is
   recomputed from stored timestamps plus `Date.now()`. A backgrounded tab, a
   slept phone or a reload must change nothing. `ui.tests.js` asserts this with
   a real page reload.
3. **Edits never patch state — they replay it.** `BFModel.replay()` recomputes
   from the first reading every time. Calibration is causal: a factor learned at
   reading *k* only affects intervals after *k*.
4. **The bulk stage of a full bake reuses the tracker, it does not reimplement
   it.** Starting the bulk creates a real bake record in `state.bakes` and sets
   `state.activeId`, so `logTemp`, `logRise`, the unattended-gap question,
   calibration, reading edits and the preshape alarm are the existing functions
   on the existing data. If you find yourself writing a second chart or a second
   temperature log, stop.
5. **Judgement stages never auto-complete.** Bulk, cold proof and any stage with
   a cue checklist wait for an explicit tap. The app can say *ready*; it cannot
   say *done*. This is a product rule, not an implementation detail.
6. **The reverse planner does not silently produce a plan that has you shaping
   at 3am.** If the cold proof cannot absorb it, say so and offer costed
   alternatives.

## The three modes

Picked from the home screen; a bake already in progress resumes straight from
there.

* **Bulk ferment only** — the original tool, unchanged. `view = 'live'`.
* **Full bake** — run a committed plan stage by stage. `view = 'process'`.
* **Plan backwards** — finish time in, schedule out. `view = 'planner'`.

## Templates

An ordered list of stages, duplicable, JSON import/export, seeded with **Bruce's
Loaf**. Every number in the seed is a starting point, not a spec — all editable.

Stage types: `fixed`, `active`, `repeat`, `bulk`, `cold-proof`, `bake`,
`starter-feed`.

* A `repeat` can run **during** another stage (`duringStageId`) — coil folds
  inside the bulk window, with their own alerts and their own tick-offs.
* `cold-proof` is a **range**, not a duration. It is the schedule's shock
  absorber and the only thing the planner is allowed to stretch or squeeze.
* Inter-stage references (`duringStageId`, `peakAtStageId`) are **by id**, so
  reordering is safe. `normalizeTemplate()` drops dangling references after a
  delete — always route edits through it.

## Reverse planner

Walks the template backwards from the finish time. Bake subtracts its steps and
schedules preheat ahead of it; cold proof starts at its range midpoint; bulk
subtracts `1 / r(T)`; the final starter feed is placed so peak lands when the
dough needs it, with revival feeds chaining back before that.

Then the unsociable-hours pass: anything hands-on between **23:00 and 06:00**
triggers a scan of the whole cold-proof range on a 15-minute grid for the
smallest flex that clears the night. If nothing does, it reports the problem and
prices the escapes — cooler bulk, warmer bulk, different bake time — each
offered only if it actually works. A night-time starter feed moves back to the
previous 21:00 and reports the time-to-peak that move now demands. Steps pinned
by the finish time itself (preheat, the bake) are flagged, not silently planned.

## Reconciliation

`BFProcess.projectTimeline()` rebuilds every time from two facts per stage:
`actualStart` and `actualEnd`. Real elapsed time always overrides the plan and
everything downstream shifts with it. Satellites (folds, bake sub-steps,
preheat) follow their anchor's live start. Once the bulk has readings, its end
comes from the accumulator's `predictedEnd` rather than the plan's estimate, and
the timeline says so on screen.

## Tests

    node tests.js           # fermentation model — 56 assertions
    node process.tests.js   # templates, planner, reconciliation, .ics — 60
    node ui.tests.js        # real DOM driven by clicks — 101 (needs: npm i jsdom)

Run all three before pushing, since a push deploys.

`process.tests.js` prints the worked example — out of the oven Friday 09:45,
bulk at 22 °C, starter from the fridge — as a day-grouped timeline **before**
asserting on it, so the arithmetic is readable rather than merely green. Keep
that habit: when the planner changes, read the printed timeline, do not just
trust the pass count.

`ui.tests.js` clicks real buttons and reads real `localStorage`, including a
full page reload in a second JSDOM. jsdom is the only dev dependency and is
gitignored.

### jsdom gotcha

jsdom does not implement the named getter on `HTMLFormElement`, so `form.temp`
is `undefined` there while it works in browsers. Use `form.elements.temp`
throughout — equivalent in browsers and testable.

## Conventions

* ES5 style: `var`, `function`, no arrow functions, no `const`/`let`, no
  template literals. Match the surrounding code.
* Views are string-building functions returning HTML; `bindAll()` wires
  `[data-act]` to `dispatch()`. Escape all user text with `esc()`.
* Sheets are bottom-anchored modals via `openSheet()`; `numberSheet()` is the
  big-tap number entry used for every temperature.
* Comments explain **why**, not what. Keep them sparse and specific.
* Tone in user-facing copy: plain, calm, never chirpy. "The clock is a
  suggestion. The dough decides." No dashboards, no exclamation marks, nothing
  that blinks. This gets read one-handed at 3am.
