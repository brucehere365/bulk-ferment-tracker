# Sourdough — bulk ferment tracker

Single-page tool for the one part of a bake that a clock cannot tell you: how
far along the bulk actually is. You enter dough temperatures by hand from a
probe; it accumulates fermentation progress and keeps re-predicting when you
need to be at the bench.

That is the whole app. Recipe templates, the stage-by-stage full bake and the
reverse planner were removed — they are in the git history if they are ever
wanted back.

## Deploy

Static, no build step. Drag this folder into Cloudflare Pages (or serve it
anywhere). Dev files are not part of the site — that is:

    index.html   model.js   app.js   styles.css

All state lives in `localStorage` on the device. No backend, no accounts.

## Not losing a bake

Bakes are stored in the browser, so the app is careful about it:

* Every save keeps the copy it replaced, and falls back to it if the current
  one will not load.
* A payload that will not parse is quarantined rather than overwritten, and a
  boot that finds nothing writes nothing — so one bad write cannot cascade into
  permanent loss.
* A write that does not read back is reported on screen and stays there. If the
  browser is blocking storage, the app says so instead of saying "Logged".
* Everything is mirrored into IndexedDB. If `localStorage` is cleared, the next
  load brings the bakes back from the mirror.

**None of that crosses an origin.** `localStorage` belongs to one URL, so a new
address, a different browser, or an iOS Home Screen icon sitting beside a Safari
tab each hold their own separate, empty copy of the app. Export a JSON backup
before changing where the app is hosted — that file is the only thing that moves
bakes between them. Restoring merges: it adds what is missing and never deletes
what is already there.

On iOS, Safari also wipes site storage after 7 days of not visiting. Adding the
app to the Home Screen exempts it from that.

Alerts are scheduled in the page, so the tab has to stay open overnight — that
is what the screen wake lock toggle is for. Everything on screen is recomputed
from stored timestamps on wake, so a slept phone loses no progress.

## Model — `model.js`

Pure, no DOM dependency. The reference table (The Sourdough Journey's Dough
Temping Guide) is the single source of truth; both curves are least-squares
fitted from it at load, and the fit is printed to the console.

* `r(T) = a·exp(b·T)` — fraction of a bulk completed per hour, fitted on `ln(1/hours)`.
* Progress accumulates by the trapezoid rule between consecutive readings, so
  time already spent warm is never given back.
* `predictedEnd = now + (1 − progress) / r(currentTemp)`.
* Target rise % is read off the *current* temperature, fitted the same way.
* Aliquot jar readings produce a calibration factor, clamped to 0.6–1.6 and
  damped 50% toward each new value, applied to rates after that reading.

The jar is optional, per bake — there is a toggle on the start screen and in the
live view's menu. With it off, the rise button, the calibration line and the jar
legend disappear; temperature alone drives the prediction and nothing about the
model changes.

## UI — `app.js`

Three screens: the start form, the live view, and history. Opening the app lands
you on the bulk you are running, or on the form that starts one.

Every number is recomputed from stored timestamps against `Date.now()`, never
from a running timer, so a backgrounded tab or a slept phone changes nothing.
Editing a reading replays the whole bake from the first one rather than patching
it, and calibration stays causal: a factor learned at reading *k* only affects
intervals after *k*.

Temperatures are typed on a big keypad, or on the phone's own keyboard. Both
`23.5` and `23,5` mean the same thing — every number the app reads goes through
`parseNum()`, and no numeric field is a `type="number"` (which silently discards
a comma).

The bulk never auto-completes. The app can say ready. It cannot say done.

## Tests

    node tests.js       # the fermentation model — 56 assertions
    node ui.tests.js    # the real DOM, driven by clicks (needs: npm i jsdom)

`ui.tests.js` clicks real buttons, reads real `localStorage`, reloads the page
in a second JSDOM, and drives an advanceable `Date.now` so "five hours later"
costs nothing. jsdom is the only dev dependency and is gitignored.
