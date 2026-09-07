# HR Sessions

Track heart-rate sessions on Bangle.js 2, tagged by activity.

## Usage

Open the app. With no Session active it shows the home screen: three live
heart-rate rows — `Now` (instant), `1m` and `10m` (1-minute and 10-minute
rolling averages) — updating continuously, with a green **Start** button at
the bottom. The HRM sensor runs whenever the app is open, so the readings
are live even before a Session begins.

Tap **Start** to open the Activity picker — a scrollable list of activities
shown in alphabetical order. The list is hard-coded in the `ACTIVITIES`
array in `app.ts` (the single place to edit it) and sorted for display at
runtime, so it can be written in any order there. Selecting one starts a new
Session — a
Session File is created on-watch and tagged with the chosen activity and
start time, and the active-session screen shows the activity name above the
same three live rows. Heart-rate samples are periodically written to the
Session File as the Session runs, and the file rotates to a new part under
the same Session before it reaches ~125 KB.

Tap **Stop session** to finalize it: everything captured is flushed to the
file, a brief "tracked" confirmation appears, and the app returns to the
home screen (the sensor keeps running for the live readings).

Session Files are CSV, named `hrsessions.log<date><track>.csv`, and
persist in the watch's storage: the first line is `<activity>,<started-epoch-ms>`,
and each following line is one `<epoch-ms>,<bpm>` sample. A Session that
rotated across parts reuses the exact same header line on every part.

## Ambient tracking

While the app is open with no Session running, heart rate is still saved —
to an **Ambient File**, one per stretch of no-Session time. A stretch starts
when the app opens and when a Session stops; it ends when the app closes or a
Session starts. So one app-open can produce several Ambient Files if you run
Sessions in between. Same CSV shape as a Session File, named
`hrsessions.amb<date><track>.csv` with an `ambient,<open-epoch-ms>` first
line. Short stretches are dropped: no file unless it lasted at least a minute
*and* the sensor actually locked on. Nothing runs once the app is closed, so
each Ambient File is final the moment its stretch ends. There's no control
for this — it's automatic.

## Exporting sessions

The Session and Ambient Files are plain CSV in the watch's storage, so
getting one off the watch needs no app-specific tooling: connect with the
[Espruino Web IDE](https://www.espruino.com/ide/) or the
[App Loader](https://banglejs.com/apps/) and download `hrsessions.log*.csv`
or `hrsessions.amb*.csv` from the storage view, then open it in any
spreadsheet or text editor.

(For this project's own laptop, `../tools/pull-sessions.js` automates that
pull over BLE — see `../tools/README.md`. It is a personal helper, not part
of this app.)

## Installing permanently

By default `app.js` only ever reaches the watch as a RAM-upload from the
Espruino Web IDE's dev loop — it vanishes on reboot and never shows up in
the launcher. To install `hrsessions` for real (survives reboot, appears in
the launcher with its icon), write the app's files directly to the watch's
Storage. This is a one-time hand install — this app is private-only, so
there's no App Loader listing or install link, and the App Loader tooling
itself isn't used here either.

1. Open the [Espruino Web IDE](https://www.espruino.com/ide/) and connect
   to the watch.
2. Open the Storage pane (the tab showing the watch's files) and upload
   two files: this repo's `app.js`, using the Storage pane's "upload as" /
   rename option to write it to Storage as `hrsessions.app.js` (matching
   the `storage` entry in `metadata.json` — the launcher's `.info` file
   points at this name, so it must land under it, not as plain `app.js`);
   and `hrsessions.info`, uploaded as-is under its own name. Note
   `app.png` is not part of this on-watch install at all — it's a
   repo/README preview image only; the on-watch icon comes from
   `hrsessions.img`, written in the next step.
3. Write the icon once: open the IDE's left-hand REPL (still connected to
   the watch) and paste in the entire contents of `app-icon.js`, then
   press enter. The paste itself writes `hrsessions.img` to Storage as its
   last step — there's nothing to copy out of the console by hand. The
   final line it prints is the result of a sanity check
   (`require("Storage").read("hrsessions.img").length`): a plausible
   positive number (roughly in the hundreds of bytes for a 48×48 1bpp
   image) means the write succeeded; `undefined` or a suspiciously small
   number means re-paste the file.
4. Reboot the watch, or close and reopen the launcher. `HR Sessions`
   should now appear with the heart icon, and opening it should work
   exactly as it did from a RAM upload.
5. Sanity check: any existing `hrsessions.log*.csv` (Session Files) and
   `hrsessions.amb*.csv` (Ambient Files) already in Storage should still
   be listed, untouched, in the Storage pane.

To reinstall after a code change: repeat step 2 with the freshly built
`app.js` (step 3 only needs re-running if the icon itself changes). On any
future version bump, also update the matching `id`/`name`/`shortName`/
`version`/`src`/`type` fields in `hrsessions.info` (nothing currently keeps
it in sync with `metadata.json` automatically) and re-upload it alongside
`app.js`.

## Development

Source is TypeScript, compiled via the vendored `typescript/` build
pipeline (this is the same toolchain [espruino/BangleApps](https://github.com/espruino/BangleApps)
uses, vendored here rather than forking the whole monorepo).

```
cd typescript
npm ci
npm run build
```

This generates `app.js` at the repo root from `app.ts`. Deploy `app.js`
to a physical Bangle.js 2 (or the emulator) via the
[Espruino Web IDE](https://www.espruino.com/ide/) to test.
