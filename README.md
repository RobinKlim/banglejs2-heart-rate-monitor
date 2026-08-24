# HR Sessions

Track heart-rate sessions on Bangle.js 2, tagged by activity.

## Usage

Open the app. With no Session active, a menu of Activities is shown:
Jogging, Biking, Sleeping, Eating. Selecting one starts a new Session:
a Session File is created on-watch and tagged with the chosen activity
and start time, and the live instant heart rate is shown on-screen while
tracking. Heart-rate samples are periodically saved to the Session File
as the Session runs. Tap "Stop session" to finalize it — everything
captured is flushed to the file and the sensor turns off.

Session Files are CSV, named `hrsessions.log<date><track>.csv`, and
persist in the watch's storage: the first line is `<activity>,<started-epoch-ms>`,
and each following line is one `<epoch-ms>,<bpm>` sample.

Exporting a Session off-watch, and 1-minute/5-minute rolling averages,
are not implemented yet (planned for later stories).

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
