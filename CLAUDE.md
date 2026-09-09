# CLAUDE.md

**TrackMyLoaf** — sourdough bulk ferment tracker. A static single-page app for
running a real bake — used on a phone, in a kitchen, at odd hours.

## How this project ships

**Cloudflare Pages is connected to the GitHub repo.** Pushing to `main` deploys.
There is no build step, no CI, no `wrangler.toml` — Cloudflare serves the repo
root as-is.

    git push origin main    →  Cloudflare Pages builds and deploys automatically

Remote: `https://github.com/brucehere365/bulk-ferment-tracker.git`

Consequences worth remembering:

* **A push is a deploy.** Never push speculative or half-finished work to `main`.
  Work on a branch, merge when it is actually done.
* **The site is exactly four files.** `index.html`, `model.js`, `app.js`,
  `styles.css`. Adding a new script means adding a `<script>` tag to
  `index.html` — forget it and the app boots into a blank screen.
* `*.tests.js`, `README.md`, `CLAUDE.md` are in the repo but are not part of the
  site. `node_modules/`, `package.json`, `package-lock.json` are gitignored.
* After a deploy, a phone with the old `index.html` cached will not pull a newly
  added script. Hard-refresh when the file list changes.

## Architecture

Plain ES5-style JavaScript, no framework, no bundler, no dependencies at
runtime. One pure module and one UI file.

| file | what it is |
|---|---|
| `model.js` | Fermentation model. Pure. `window.BFModel` / `require`. |
| `app.js` | All UI and all storage. The only file that touches the DOM or `localStorage`. |
| `styles.css` | The whole design system: tokens, day and night themes, line art. |

`model.js` takes `now` as a parameter and owns no clock, no DOM and no storage.
That is what makes it testable in node and what lets the UI recompute everything
from stored timestamps after the phone has been asleep.

The one external dependency is Google Fonts (Outfit, Space Mono, Instrument
Serif). Every stack has a real fallback — a kitchen with no signal still gets a
readable app. All other visuals are flat colour, gradients, or inline SVG; the
line illustrations are CSS `mask` data-URIs in `styles.css`, so they inherit
whatever ink colour their card uses and work unchanged in the night theme.

State lives entirely in `localStorage` under the key `bft.v1` (the key kept its
name through the v2 and v3 schema bumps). There is no backend and no accounts.

## The app is one thing

There are three screens and no mode picker:

* `view = 'start'` — the form that begins a bulk. Where you land with nothing
  running.
* `view = 'live'` — the running bulk. Where you land if there is one.
* `view = 'history'` — finished bakes, their charts and the CSV export.

**v3 removed recipe templates, the stage-by-stage full bake, and the forward and
reverse planners**, along with `process.js` and `process.tests.js`. That was a
deliberate simplification, not an accident — do not reintroduce a recipe store,
a stage runner or a second chart because a stray reference to one survives
somewhere. The removed code is in the git history if it is ever wanted back.
`load()` drops the old `templates`, `processes`, `activeProcessId` and `draft`
keys on read; the bulk ferments a v2 install had are ordinary bakes and survive
untouched.

## Invariants — do not break these

1. **`model.js` is the fermentation model and nothing else may predict a bulk.**
   Bulk length is always `BFModel.hoursAt(T)` = `1 / r(T)` from the fitted curve.
   Never hardcode a duration, and never write "doubled" as a target — target
   rise comes from `targetRisePct(T)`, which falls as temperature rises.
2. **Nothing is derived from a running timer.** Every number on screen is
   recomputed from stored timestamps plus `Date.now()`. A backgrounded tab, a
   slept phone or a reload must change nothing. `ui.tests.js` asserts this with
   a real page reload and with a `Date.now` it pushes hours forward.
3. **Edits never patch state — they replay it.** `BFModel.replay()` recomputes
   from the first reading every time. Calibration is causal: a factor learned at
   reading *k* only affects intervals after *k*.
4. **The bulk never auto-completes.** It waits for an explicit tap. The app can
   say *ready*; it cannot say *done*. This is a product rule, not an
   implementation detail.
5. **Entrance animations are gated behind `#app.enter`.** The live view
   re-renders once a second from stored timestamps (invariant 2), so any
   unguarded entrance animation restarts every second — the hero would pulse,
   the chart would redraw itself, the progress bar would sweep from zero.
   `render()` adds `enter` only when the view actually changes. Anything that
   animates on arrival goes under that selector.
6. **Cue lists are instructions, not a checklist.** Small print you read before
   you decide. Nothing to tick — the tap that ends the bulk is the primary
   button, and there is only ever one of those.

## Numbers the user types

Every one of them goes through `parseNum()`, which accepts a comma or a full
stop as the decimal separator — phone keyboards in most of Europe offer a comma,
and `parseFloat('23,5')` is 23, which is a wrong dough temperature rather than a
rejected one.

**No numeric field is a `type="number"`.** Such a field silently discards a
comma before JS ever sees it, so temperatures and rise percentages are
`type="text" inputmode="decimal"` and validated in JS. Range checks live in
`M.validateReading()` and the call sites, not in `min`/`max` attributes.

The keypad in `numberSheet()` writes a `.`, and a comma typed on the device's own
keyboard is rewritten to `.` on `input`, so the big field always shows what will
be saved.

## The phone, not the browser

This is read one-handed on a phone. Two things in `styles.css` exist only for
that and must not be dropped:

* `touch-action: manipulation` on everything tappable. Two quick taps on the
  keypad — how you type 44 — otherwise register as double-tap-to-zoom and leave
  the whole app at 2× mid-reading. It also removes the 300 ms tap delay.
* **No field under 16px.** Safari zooms the page to reach anything smaller, and
  never zooms back out. `input, textarea, select { font-size: max(16px, 1em) }`
  is the floor; a later, more specific rule can still undercut it, so check.

The viewport meta deliberately does *not* set `maximum-scale` or
`user-scalable=no`: modern Safari ignores both, and on Android they would break
legitimate pinch-zoom. `touch-action` is the fix.

## Tests

    node tests.js       # fermentation model — 56 assertions
    node ui.tests.js    # real DOM driven by clicks — 69 (needs: npm i jsdom)

Run both before pushing, since a push deploys.

`ui.tests.js` clicks real buttons and reads real `localStorage`, including a
full page reload in a second JSDOM. Its `boot()` installs an advanceable
`Date.now`, so `advance(3)` is three hours of dough at no cost — and it is also
the honest test of invariant 2, since nothing but the clock moves. jsdom is the
only dev dependency and is gitignored.

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
* Colour carries meaning and never decorates: periwinkle progress, dusty pink
  dough temp, butter targets, sage ready/expected, pale blue in-flight,
  terracotta at most once per screen. A hue means the same thing on every view.
* Night is the same layout dimmed, not a second design. Auto between 23:00 and
  06:00, with Day/Night pins in the menu; `html.night` re-points the tokens and
  nothing else.
