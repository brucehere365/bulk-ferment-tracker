# CLAUDE.md

**TrackMyLoaf** — sourdough bulk ferment tracker. A static single-page app for
running a real bake — used on a phone, in a kitchen, at odd hours.

## How this project ships

**Cloudflare is connected to the GitHub repo.** Pushing to `main` deploys. There
is no build step, no CI, and no `wrangler.toml` — the repo root is served as-is.

    git push origin main    →  Cloudflare deploys automatically

Remote: `https://github.com/brucehere365/bulk-ferment-tracker.git`

⚠️ **The connection is currently Cloudflare _Workers_ Builds, not Pages**, and
its check fails on every commit — instantly, with `started_at == completed_at`,
because Workers Builds expects a `wrangler` config this repo does not and should
not have. It has failed the same way since at least August, on unrelated diffs.
The site is served from a Workers URL rather than `*.pages.dev`.

Do not "fix" that red check by adding a `wrangler.toml`. The fix is a dashboard
change — connect the repo as a **Pages** project and disconnect Workers Builds.
When that happens, **the origin changes**, and `localStorage` does not follow an
origin: every bake on the old URL becomes invisible. Export a JSON backup from
the old address first and restore it on the new one. See the storage section.

Consequences worth remembering:

* **A push is a deploy.** Never push speculative or half-finished work to `main`.
  Work on a branch, merge when it is actually done.
* **The site is these files**, and adding one means updating *two* other places:

      index.html  model.js  app.js  styles.css
      sw.js  manifest.webmanifest  icon-{180,192,512}.png  icon-maskable-512.png

  A new script needs a `<script>` tag in `index.html` — forget it and the app
  boots into a blank screen — **and** an entry in `SHELL` in `sw.js`, or it
  will not be there offline. `ui.tests.js` asserts the second one for every
  local path `index.html` references, because the first is easy to remember
  and the second is not.
* `*.tests.js`, `README.md`, `CLAUDE.md` are in the repo but are not part of the
  site. `node_modules/`, `package.json`, `package-lock.json` are gitignored.
* The service worker is **network-first**, so a deploy reaches an
  already-installed phone without a hard refresh. Verified in a real browser:
  change a file, reload, the change is live with no version bump. Do not invert
  this to cache-first for speed — a fast stale answer about a bake is worse
  than a slow correct one.

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

## Storage — losing a bake is the one failure this app may not have

It has happened twice in real use, so the rules here are not negotiable.

* `localStorage` is the source of truth: synchronous, and re-read on render.
* **Every write leaves the copy it replaced at `bft.v1.prev`.** One generation
  of undo, and `load()` falls back to it.
* **A payload that will not parse is quarantined at `bft.v1.corrupt`, never
  overwritten.** Half a bake is recoverable by hand; `blank()` is not.
* **A write that does not read back did not happen.** `save()` reads the key
  straight after writing it and sets `storageBroken` if they differ — Private
  Browsing and a full quota both fail exactly here, and both used to fail
  silently.
* **Never save a blank state over anything.** Booting with nothing found sets
  `bootedEmpty`, and the boot `save()` is skipped. The old unconditional boot
  save is precisely what turned one unreadable payload into permanent loss.
* Everything is mirrored into **IndexedDB** (`bft` / `state` / `current`), best
  effort. On boot `recoverFromMirror()` adopts the mirror if it is newer or
  holds more bakes — which is the case exactly when `localStorage` was cleared
  underneath us.
* When `storageBroken`, the live view shows a persistent `.alarmbar`, not just
  a toast, and `commit()` suppresses its cheerful "Logged." A toast you might
  miss cannot be the only warning that a bake is not being written down.

None of that crosses an origin. `localStorage` is per-origin, so a new URL, a
different browser, or an iOS Home Screen icon beside a Safari tab each hold a
separate, empty app. **The JSON backup is the only thing that moves between
them**, which is why `storageSheet()` is reachable from the start screen — the
screen you are on when a bake has gone missing — and not only from the menu.

Restore **merges and never deletes**: unknown bakes are added, and a bake
present in both keeps whichever copy has more readings. A restore that replaced
state would be its own data loss.

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

## Installed, not just visited

`manifest.webmanifest` + `sw.js` make this a real installable app. That is not
decoration — **on iOS, Safari wipes the storage of a site you have not opened
for seven days, and a Home Screen install is exempt.** Installation is therefore
part of the data-durability story above, which is why `storageSheet()` is where
the app raises it: iOS gets the taps described (Safari never fires
`beforeinstallprompt`), Chrome gets a real Install button from the captured
event, and an already-installed app gets told it is safe.

`sw.js` carries its own retirement instructions in a comment at the top — a
tombstone worker that unregisters itself. Browsers always revalidate `sw.js`,
so that is the escape hatch if the worker ever needs to go.

Offline is genuine and tested in a real browser: kill the server outright,
reload, and the app still renders, still lands on the running bulk, and still
logs a temperature that persists. Google Fonts is the one thing allowed to
fail — every stack in `styles.css` has a real fallback.

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
    node ui.tests.js    # real DOM driven by clicks — 102 (needs: npm i jsdom)

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
