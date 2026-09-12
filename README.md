# Sourdough — bulk ferment tracker

Single-page tool for the one part of a bake that a clock cannot tell you: how
far along the bulk actually is. You enter dough temperatures by hand from a
probe; it accumulates fermentation progress and keeps re-predicting when you
need to be at the bench.

That is the whole app, and deliberately so. Recipe templates, the
stage-by-stage full bake and the reverse planner went in v3; logging aliquot-jar
readings, the history screen, the CSV export and most of the settings went in
v4. All of it is in the git history if it is ever wanted back.

What is left: start a loaf, see when it will be ready, get pinged, do not lose
it, one code each.

## Deploy

Static, no build step. Drag this folder into Cloudflare Pages (or serve it
anywhere). Dev files are not part of the site — that is:

    index.html   model.js   app.js   styles.css
    sw.js   manifest.webmanifest   icon-*.png

Adding a file to the site means listing it in **both** `index.html` and the
`SHELL` array in `sw.js`, or it will be missing offline.

All state lives in `localStorage` on the device. The only server-side code is
the optional sync endpoint in `functions/`, which runs on Cloudflare Pages and
is off until you turn it on. No accounts.

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

## Install it

It is a real installable app: `manifest.webmanifest` and `sw.js`.

* **iPhone** — open it in Safari, Share → Add to Home Screen. Safari never
  offers this itself, so the app describes the taps under Backup and restore.
* **Android** — Chrome offers an install prompt; there is also an Install
  button in the same place.

Installing is not cosmetic. It exempts the app from the 7-day storage wipe
above, it opens without browser chrome, and it is the prerequisite for iOS
notifications if they are ever added.

**Offline works properly.** The whole site is precached, so a bulk can be
tracked with the phone in aeroplane mode — verified by killing the server
outright and reloading. The one thing allowed to fail is Google Fonts; every
stack has a real fallback.

The worker is **network-first**, so a deploy reaches an already-installed phone
without a hard refresh — the cache is a fallback, never the first answer.

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

Both rise numbers on the live view — what the bowl should show now, and what it
should show when the bulk is done — come from temperature and progress alone.
There is no jar to keep and nothing to log. The calibration factor is still in
the model and still honours a `rise` on an old reading; with none to learn from
it stays at 1.

## UI — `app.js`

Two screens and no nav. Opening the app lands you on the bulk you are running,
or on the one field that starts one. A fresh install asks once for a code, and
takes "just this phone" for an answer. Settings — your code, the alarm, the
backup — are one tap behind the `•••` on either screen.

Every number is recomputed from stored timestamps against `Date.now()`, never
from a running timer, so a backgrounded tab or a slept phone changes nothing.
Fixing a reading replays the whole bake from the first one rather than patching
it.

Log temperature is the one primary button on the live view; ending the bulk sits
beside it as an ordinary button and confirms first. A bulk never ends itself. A
finished bake is kept rather than deleted — a mis-tap must not be what destroys
one — there is simply nowhere in the app to look at it.

Temperatures are typed on a big keypad, or on the phone's own keyboard. Both
`23.5` and `23,5` mean the same thing — every number the app reads goes through
`parseNum()`, and no numeric field is a `type="number"` (which silently discards
a comma).

The bulk never auto-completes. The app can say ready. It cannot say done.

## Sync (optional)

Off unless you turn it on. You pick a private code, and every device you type it
into shares one set of bakes through `functions/api/sync.js`, a Cloudflare Pages
Function.

One code is one baker. Someone else baking on a different code gets a wholly
separate set: the KV key is the hash of the code, so there is no path between
them. That is how you hand out accounts without running a signup form. Do not
share one code between two people — you would also share which bake is running
now, and their dough would take over your live view.

It needs a one-off setup in the Cloudflare dashboard: create a KV namespace and
bind it to the Pages project as `BAKES`. Steps are in a comment at the top of
that file. Until then the endpoint returns 503 and the app just stores locally.

The code is a shared secret, not a login — anyone who knows it can read those
bakes — so make it long. It is never stored; the key is a salted SHA-256 of it.
Merging is the union of both sides, the copy with more readings wins, and
deletions travel as tombstones so a deleted bake does not come back.

## Tests

    node tests.js        # the fermentation model — 56 assertions
    node sync.tests.js   # the sync endpoint against a fake KV — 25
    node ui.tests.js     # the real DOM, driven by clicks (needs: npm i jsdom)

`ui.tests.js` clicks real buttons, reads real `localStorage`, reloads the page
in a second JSDOM, and drives an advanceable `Date.now` so "five hours later"
costs nothing. jsdom is the only dev dependency and is gitignored.
