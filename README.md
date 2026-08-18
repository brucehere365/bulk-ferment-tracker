# Sourdough — process & bulk ferment tracker

Single-page tool for running a sourdough bake. Three ways in:

* **Bulk ferment only** — the original tracker. You enter dough temperatures by
  hand from a probe; it accumulates fermentation progress and keeps re-predicting
  when you need to be at the bench.
* **Full bake** — a whole process, starter feed to oven, ticked off stage by
  stage. The bulk stage hands off to the tracker above, unchanged.
* **Plan backwards** — say when you want bread out of the oven; get a schedule.

## Deploy

Static, no build step. Drag this folder into Cloudflare Pages (or serve it
anywhere). Dev files are not part of the site — that is:

    index.html   model.js   process.js   app.js   styles.css

All state lives in `localStorage` on the device. No backend, no accounts.

Alerts are scheduled in the page, so the tab has to stay open overnight — that
is what the screen wake lock toggle is for. Everything on screen is recomputed
from stored timestamps on wake, so a slept phone loses no progress.

## Model — `model.js`

Pure, no DOM dependency, untouched by the process work. The reference table (The
Sourdough Journey's Dough Temping Guide) is the single source of truth; both
curves are least-squares fitted from it at load, and the fit is printed to the
console.

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

## Process — `process.js`

Also pure. Templates, the reverse planner, timeline projection and `.ics`
export. It never predicts a bulk itself: bulk length is always
`BFModel.hoursAt(T)`, and once a bulk is running the accumulator's
`predictedEnd` replaces the estimate outright.

### Templates

An ordered list of stages, stored in `localStorage`, duplicable, and
importable/exportable as JSON. Seeded with **Bruce's Loaf**; every number in it
is editable. Stage types:

| type | what it is |
|---|---|
| `fixed` | a set duration — autolyse, bench rest |
| `active` | hands-on; duration optional, and really an instruction |
| `repeat` | N reps at M-minute intervals, optionally *during* another stage |
| `bulk` | hands off to the accumulator; no duration of its own |
| `cold-proof` | a *range*, and the schedule's shock absorber |
| `bake` | ordered sub-steps with temp and duration, plus a preheat |
| `starter-feed` | a feed with a ratio and a time-to-peak |

References between stages (a fold's host, a feed's target) are by id, so
reordering is safe and deleting clears the dangling link.

### Reverse planner

Walks the template backwards from the finish time. Fixed and active stages
subtract their durations; the bake subtracts its steps and schedules the preheat
ahead of it; the cold proof starts at the midpoint of its range; the bulk
subtracts `1 / r(T)` hours; the final starter feed is placed so peak lands when
the dough asks for it, with revival feeds chaining back before it.

Then it checks whether any hands-on step landed between 23:00 and 06:00. If so
it scans the whole cold-proof range on a 15-minute grid for the smallest change
that clears the night. If nothing does, it says so and prices the ways out — a
cooler bulk, a warmer one, a different bake time — each only offered if it
actually works. A night-time starter feed is moved back to the previous 21:00
and reported with the time-to-peak that move now demands.

Anything pinned by the finish time itself (preheat, the bake) cannot be moved by
flexing the cold proof, so it is flagged rather than silently planned.

### Live tracker

The projection is rebuilt from scratch on every render from two facts per stage:
when it actually started and when it actually ended. Real elapsed time always
overrides the plan and every downstream time shifts with it. Folds hang off
their host stage's live start; the bulk's end comes from the accumulator.

Bulk, cold proof, and any stage with a cue checklist never auto-complete. The
app can say ready. It cannot say done.

## Tests

    node tests.js           # the fermentation model
    node process.tests.js   # templates, reverse planner, reconciliation, .ics
    node ui.tests.js        # the real DOM, driven by clicks (needs: npm i jsdom)

`process.tests.js` prints the worked example — out of the oven Friday 09:45,
bulk at 22 °C, starter from the fridge — as a day-grouped timeline before
asserting against it, so the arithmetic is readable rather than just green.
