# HR Sessions

Track heart-rate sessions on Bangle.js 2, tagged by activity.

## Usage

Open the app. With no Session active, a menu of Activities is shown:
Jogging, Biking, Sleeping, Eating. Selecting one starts a new Session:
a Session File is created on-watch and tagged with the chosen activity
and start time.

Session Files are CSV, named `hrsessions.log<date><track>.csv`, and
persist in the watch's storage until exported.

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
