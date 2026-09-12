# CLAUDE.md

**TrackMyLoaf** — sourdough bulk ferment tracker. A static single-page app for
running a real bake — used on a phone, in a kitchen, at odd hours.

## How this project ships

**Cloudflare is connected to the GitHub repo.** Pushing to `main` deploys. There
is no build step, no CI, and no `wrangler.toml` — the repo root is served as-is.

    git push origin main    →  Cloudflare deploys automatically

Remote: `https://github.com/brucehere365/bulk-ferment-tracker.git`

**The repo is connected as a Cloudflare _Pages_ project**, added September 2026.
Pages is what serves the site and what runs `functions/`; its check is green and
it publishes a preview URL per branch.

⚠️ **Workers Builds was never disconnected, so both integrations are live** and
every commit still gets one red `Workers Builds: bulk-ferment-tracker` check
beside the green `Cloudflare Pages` one. It fails instantly — PR #3 recorded
`started_at == completed_at == 05:55:30`, PR #2 the same at `08:11:37` on a
wholly unrelated diff — because Workers Builds wants a `wrangler` config this
repo does not and should not have.

**That red check is not yours. Do not try to fix it in the repo**, and above all
do not add a `wrangler.toml`: it would make Workers Builds pass by turning the
project into something Pages should not serve. The fix is one dashboard action —
disconnect Workers Builds from the repo — and until someone does it, judge CI by
the Pages check alone.

Moving to Pages changed the origin, and `localStorage` does not follow an origin,
so bakes left on the old Workers URL are not visible on the new one. They are not
gone: export a JSON backup from the old address and restore it here. See the
storage section.

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
  static site, and `functions/` is server-side — it only runs on Pages.
  `node_modules/`, `package.json`, `package-lock.json` are gitignored.
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
them**, which is why `settingsSheet()` is reachable from the start screen — the
screen you are on when a bake has gone missing — and not only from the menu.

Restore **merges and never deletes**: unknown bakes are added, and a bake
present in both keeps whichever copy has more readings. A restore that replaced
state would be its own data loss.

## Sync — the one server, and it is optional

`functions/api/sync.js` is a Cloudflare Pages Function, and the only
server-side code in the project. It exists because a bake that lives in one
browser dies with that browser.

**It is off until a code is entered**, and everything above works untouched with
it off. Sync only ever *adds* a copy somewhere else; it must never become the
reason a bake is lost. If it is unconfigured the endpoint returns 503 and the
app carries on storing locally, silently.

* **A code is one baker, not one kitchen.** Every device that types the same
  code shares one set of bakes; a different code is a separate set the server
  has no path to merge with it, because the KV key *is* the hash of the code.
  Two people therefore get a code each — that is how accounts are handed out
  here, and it is why there is no registration to lock down.
  **Never suggest sharing one code between two bakers.** They would also share
  `activeId`, so one of them starting a bulk moves the other's live view onto
  it. `settingsSheet()` warns about this and `ui.tests.js` asserts the warning.
* **Setup is manual and one-off**, in the Cloudflare dashboard: create a KV
  namespace, bind it to the Pages project as `BAKES`. The setup steps are in a
  comment at the top of the function. **Pages keeps Production and Preview
  bindings separately**, so a namespace bound only to Production leaves every
  `*.pages.dev` branch preview 503ing while production works — bind both, or
  expect sync to look broken exactly where you test it.
* **Never tell someone sync is working because the app accepted their code.**
  It accepts any code of 8 characters offline. Only a completed round trip
  proves anything, which is why `syncState.at` — not `syncState.code` — is what
  `settingsSheet()` reads before it says a word about bakes being saved off the
  phone, and why turning sync on toasts "Checking the server…" rather than a
  success it has not yet earned. `ui.tests.js` asserts that distinction.
* **The code is a shared secret, not authentication.** Anyone who knows it can
  read those bakes, and the sync sheet says exactly that. Minimum 8 characters.
  The code is never stored: the KV key is `SHA-256(salt + '\x00' + code)`, so a
  dump of the namespace does not hand over the codes. That separator is written
  as an escape on purpose — a raw NUL byte there made git treat `sync.js` as
  binary and put one editor's normalisation between every baker and their
  bakes. For anything stronger,
  put Cloudflare Access in front of the whole site — that, not a rewrite onto
  Supabase or any other auth provider, is the next step up if one is wanted.
* **POST only.** A GET would put the code in a query string and from there into
  browser history and every log in between.
* **The server merges; it does not last-write-wins.** Union of both sides, and
  where a bake is on both, the copy with more readings wins — the same rule
  `mergeBackup()` applies to a restored file. Both phones converge on the union
  rather than whichever synced last.
* **Deletions travel as tombstones** (`state.deleted`), or deleting a bake on
  one phone would have the other sync it straight back — which reads as a bug
  and teaches you not to trust the delete button.
* `save()` calls `syncSoon()` (4 s debounce), and applying a merge calls
  `save()`. `syncApplying` is what stops two phones pushing each other back and
  forth forever. `ui.tests.js` asserts that specifically.
* Failures are quiet by design. Offline is the normal state of a kitchen, not
  an error worth shouting about; the next save picks it up.

## The app is one thing

Two screens, one sheet, and no nav — which screen you get is not a choice
anyone makes:

* `view = 'start'` — one temperature field and **Start bulk**. Where you land
  with nothing running.
* `view = 'live'` — the running bulk. Where you land if there is one.
* `settingsSheet()` — the code, the alarm, the backup. Reachable in one tap
  from the `•••` on **both** screens, because the screen you are on when a bake
  has gone missing is the screen the backup has to be reachable from.
* `firstRunSheet()` — asked once on a genuinely fresh install (`bootedEmpty`, no
  code, never answered, no bakes). Handing someone a link and a code only works
  if the app they open asks for the code. It is skippable in one tap and the
  answer is remembered in `bft.sync` as `asked`, which outlives a cleared code:
  turning sync off is an answer, and a modal that returns every launch until you
  give in is nagging, not asking. Never make it a gate in front of starting a
  bulk.

**v3 removed recipe templates, the stage-by-stage full bake, and the forward and
reverse planners**, along with `process.js` and `process.tests.js`.

**v4 removed the rest of the second app**: the aliquot jar *input* side (rise
logging, the calibration factor on screen, the one-off rise, the reset), the
History screen and its bake cards, the CSV export, the crumb note, the nav pill,
the screen-wake toggle, the Day/Night pins, the configurable lead-time alert,
the bake name and notes fields, and the separate `syncSheet()` and
`storageSheet()`.

**Rise % and the chart are not part of that and must stay.** The first cut took
them out with the jar and it was wrong: `st.expectedRise` and `st.target` come
from temperature and progress alone — no jar, nothing to log — and they are what
the baker holds the bowl up against. The chart has no controls either. What made
this app confusing was *things to decide and tap*, not things to read. Weigh any
future cut on that line: information stays, decisions go.

Both were deliberate, and the second was asked for in those words: *"it feels
way too complex and I don't even understand what you've built."* **Do not
reintroduce any of it because a stray reference survives somewhere.** The
removed code is all in the git history.

What is left is the thing that was asked for: start a loaf, see when it will be
ready, get pinged, do not lose it, one code each. Weigh anything new against
that sentence.

`load()` drops the old `templates`, `processes`, `activeProcessId` and `draft`
keys on read. Nothing v4 removed is dropped from stored state — old bakes keep
their `rise`, `crumb`, `notes` and `useJar` fields untouched and the model still
reads a `rise` if one is there, so a v3 install loses nothing by upgrading.

## Invariants — do not break these

1. **`model.js` is the fermentation model and nothing else may predict a bulk.**
   Bulk length is always `BFModel.hoursAt(T)` = `1 / r(T)` from the fitted curve.
   Never hardcode a duration, and never write "doubled" as a target — target
   rise comes from `targetRisePct(T)`, which falls as temperature rises. The
   calibration factor is still in the model and still correct; with no rise
   readings to learn from it simply stays at 1.
2. **Nothing is derived from a running timer.** Every number on screen is
   recomputed from stored timestamps plus `Date.now()`. A backgrounded tab, a
   slept phone or a reload must change nothing. `ui.tests.js` asserts this with
   a real page reload and with a `Date.now` it pushes hours forward.
3. **Edits never patch state — they replay it.** `BFModel.replay()` recomputes
   from the first reading every time. Fixing a mistyped temperature is not
   cosmetic: 42 where you meant 24 throws the whole projection out, which is why
   the Fix button survived a cut that took almost everything else with it.
4. **The bulk never auto-completes.** It waits for an explicit tap. The app can
   say *ready*; it cannot say *done*. This is a product rule, not an
   implementation detail.
5. **Entrance animations are gated behind `#app.enter`.** The live view
   re-renders from stored timestamps on a tick (invariant 2), so any unguarded
   entrance animation restarts every time — the hero would pulse, the chart
   would redraw itself, the progress bar would sweep from zero. `render()` adds `enter` only when the view
   actually changes. Anything that animates on arrival goes under that selector.
6. **Cue lists are instructions, not a checklist.** Small print you read before
   you decide. Nothing to tick.
7. **One primary button on the live view, and it is Log temperature.** An
   earlier version made *ending the bulk* primary; the owner changed it, and the
   reasoning holds — a temperature goes in many times across a bulk, the bulk
   ends once, so the big button should be the one actually pressed. Ending it is
   an ordinary button that confirms first. `ui.tests.js` asserts the count and
   which button carries it, so do not swap them back on aesthetic grounds.

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
part of the data-durability story above, which is why `settingsSheet()` is where
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

    node tests.js        # fermentation model — 56 assertions
    node sync.tests.js   # the real Pages Function against a fake KV — 25
    node ui.tests.js     # real DOM driven by clicks — 121 (needs: npm i jsdom)

Run all three before pushing, since a push deploys.

`sync.tests.js` imports `functions/api/sync.js` and drives it with real
Request objects — the merge it tests is the merge that runs on Cloudflare. It
matters more than its size suggests: that endpoint is the one place two phones'
bakes are reconciled, so a wrong merge silently loses a bake on one of them.

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
