# Bulk Ferment Tracker

Single-page tracker for sourdough bulk fermentation. You enter dough temperatures
by hand from a probe; it accumulates fermentation progress and keeps re-predicting
when you need to be at the bench for preshape.

## Deploy

Static, no build step. Drag this folder into Cloudflare Pages (or serve it
anywhere). `harness`/dev files are not included — the site is:

    index.html   model.js   app.js   styles.css

All state lives in `localStorage` on the device. No backend, no accounts.

Alerts are scheduled in the page, so the tab has to stay open overnight — that
is what the screen wake lock toggle is for. Everything on screen is recomputed
from stored timestamps on wake, so a slept phone loses no progress.

## Model

`model.js` is pure and has no DOM dependency. The reference table (The Sourdough
Journey's Dough Temping Guide) is the single source of truth; both curves are
least-squares fitted from it at load, and the fit is printed to the console.

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
model changes. Logging a one-off rise from the menu switches it back on.

## Tests

    node tests.js

Unit tests plus three worked scenarios printed as tables: steady 22 °C, 24 °C
falling to 19 °C, and a jar reading that says the dough is running fast.
