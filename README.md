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
