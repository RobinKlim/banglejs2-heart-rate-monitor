// hrsessions - heart-rate session tracker for Bangle.js 2
//
// Single compiled source file, organized into four sections plus top-level
// wiring (see the architecture spine / epic context for the full design):
//   State    - session data, leaf module, calls nothing else
//   Storage  - Session File persistence, leaf module, calls nothing else
//   Sampling - HRM sampling: throttles raw hardware events down to ~1/sec
//              into a time-windowed ring buffer (Story 1.4) and a
//              since-last-flush queue that is periodically written to the
//              Session File (Story 1.5), with size-triggered rotation to a
//              new file under the same Session before ~130KB.
//   UI       - screen drawing, calls State/Sampling, never Storage
//
// Story 1.1 implements enough of State/Storage/UI for: app launch shows the
// Activity menu, selecting an Activity opens a new Session File and writes
// its header line. Story 1.2 adds the active-session screen (hand-drawn,
// no title/header) and its touch-driven "Stop session" zone, which resets
// in-memory Session state and returns to the Activity menu. Story 1.4 adds
// the Sampling layer: HRM power and the ~1s capture timer turn on in
// onActivitySelected and off in stopSession, so the sensor is never left
// running once a Session ends. Story 1.5 moves Storage.open() ownership
// into Sampling's startSampling() and implements the epic's exact 4-step
// stop sequence (HRM off, timers cleared, final flush, file reference
// dropped), so nothing captured is ever left unwritten when a Session ends.
// A follow-up spec adds size-triggered rotation: flushSamples() opens a new
// file under the same Session (same header, next track letter) before a
// batch would push the current file past ~130KB.

// ===== State =====

type Activity = "Jogging" | "Biking" | "Sleeping" | "Eating";

const ACTIVITIES: Activity[] = ["Jogging", "Biking", "Sleeping", "Eating"];

// Single source of truth for the running Session's activity, set once when
// a Session starts.
let currentActivity: Activity | undefined;

// ===== Storage =====

// Opens a new appendable Session File for `activity` and writes its header
// line (the actual `<activity>,<started-epoch-ms>` values, not labels).
// The <track> suffix is the highest track already used for today's date,
// plus one - NOT a plain count of existing files. A plain count collides
// as soon as any today's-date file is missing a slot (deletion, a failed
// write, etc.): confirmed on-device, where a missing "g" track caused the
// next count-based track to recompute an already-used letter and silently
// overwrite that file. Scanning for the actual highest track used is
// gap-safe regardless of how a file went missing.
function openSessionFile(activity: Activity, startedEpochMs: number): StorageFile {
  const date = new Date().toISOString().substr(0, 10).replace(/-/g, "");
  const prefix = "hrsessions.log" + date;
  const existing = require("Storage").list(new RegExp("^" + prefix));
  let maxTrack = -1;
  for (let i = 0; i < existing.length; i++) {
    const fname = existing[i];
    if (fname === undefined) continue;
    const trackVal = parseInt(fname.charAt(prefix.length), 36);
    if (!isNaN(trackVal) && trackVal > maxTrack) maxTrack = trackVal;
  }
  const track = (maxTrack + 1).toString(36);
  const name = prefix + track + ".csv";
  const file = require("Storage").open(name, "w");
  file.write(activity + "," + startedEpochMs + "\n");
  console.log("hrsessions: opened " + name + " (" + activity + ")");
  return file;
}

// ===== Sampling =====

type HrSample = { t: number; bpm: number };

const HR_SAMPLE_INTERVAL_MS = 1000;
// Also relied on verbatim by HR_AVG_5MIN_WINDOW_MS below (Story 1.6's "5m"
// label) - changing this for retention/memory reasons would silently change
// what "5m" means on screen too.
const HR_BUFFER_WINDOW_MS = 300000; // 300s
// Story 1.6's two rolling-average windows. The 5-min window reuses the ring
// buffer's own eviction window verbatim (both are 300s) rather than defining
// a second, independent constant that could drift out of sync with it.
const HR_AVG_1MIN_WINDOW_MS = 60000;
const HR_AVG_5MIN_WINDOW_MS = HR_BUFFER_WINDOW_MS;
// 10s: batches writes without holding too much unflushed data at once. Not
// a safety-critical number - no crash-recovery is attempted for a Session
// interrupted by reset/power loss (accepted epic behavior), so this just
// bounds how much of the tail end of a Session could be lost in that case.
const HR_FLUSH_INTERVAL_MS = 10000;
// ~122KB, comfortably under the epic's ~130KB BLE-transfer memory-crash
// threshold with margin for the batch that triggers the check.
const HR_ROTATION_THRESHOLD_BYTES = 125000;

// Time-windowed ring buffer of captured samples, the sole source for the
// live instant reading (and, in Story 1.6, the 1-min/5-min rolling
// averages). Evicts by timestamp, not by a fixed slot count.
let hrRingBuffer: HrSample[] = [];

// Since-last-flush queue: the sole source for periodic writes to the
// Session File. Independent of hrRingBuffer - Storage never touches the
// ring buffer, and the ring buffer's time-based eviction never applies
// here. Drained (not evicted) on every successful flush.
let hrWriteQueue: HrSample[] = [];

// Latest raw reading from the HRM hardware, updated on every 'HRM' event.
// Cheap store only - no buffer writes here, so a slow future consumer of
// the buffer can never delay sample processing.
let latestBpm: number | undefined;

let sampleIntervalId: IntervalId | undefined;
let flushIntervalId: IntervalId | undefined;

// The open Session File for the active Session, or undefined when idle.
// Sampling is the sole owner of Storage.open() - see startSampling/
// stopSampling below.
let currentFile: StorageFile | undefined;

// Every filename opened this Session, in order (the first file plus any
// rotations) - lets logSessionFile() dump the whole Session, not just
// whichever file happens to be current when it's stopped.
let sessionFileNames: string[] = [];

// The running Session's activity/start-epoch, captured once in
// startSampling() and reused verbatim as the header of every rotated file
// (see rotateSessionFile below) - a rotated file is fully self-describing
// on its own, with no cross-file bookkeeping.
let sessionActivity: Activity | undefined;
let sessionStartedEpochMs: number | undefined;

// In-memory running byte count of currentFile, checked against
// HR_ROTATION_THRESHOLD_BYTES on every flush instead of calling
// StorageFile.getLength() per flush (documented as slow). Established via
// one getLength() call right after opening or rotating a file, then kept
// current by adding each flushed batch's length.
let currentFileSize = 0;

// Rounded here, once, at the point bpm first enters the system, so every
// downstream consumer (ring buffer, write queue, persisted CSV rows) sees
// a clean integer - avoids float noise bloating persisted file size.
function onHrmSample(hrm: { bpm: number; confidence: number; raw: Uint8Array }): void {
  latestBpm = Math.round(hrm.bpm);
}

// Runs on its own ~1s timer (not synchronously inside the HRM handler) and
// pushes the latest raw reading into both the ring buffer and the
// since-last-flush queue, throttling the raw hardware event rate down to
// one sample per second.
function captureSample(): void {
  if (latestBpm === undefined) return;
  // Rounded: on this hardware Date.now() can return sub-millisecond
  // precision as a float (confirmed on-device - not a formatting quirk),
  // which would otherwise persist as garbage-looking decimals in the CSV.
  const now = Math.round(Date.now());
  const sample: HrSample = { t: now, bpm: latestBpm };
  hrRingBuffer.push(sample);
  hrWriteQueue.push(sample);
  const cutoff = now - HR_BUFFER_WINDOW_MS;
  while (hrRingBuffer.length > 0) {
    const oldest = hrRingBuffer[0];
    if (oldest === undefined || oldest.t >= cutoff) break;
    hrRingBuffer.shift();
  }
}

// Accessor for the most recent captured sample - the interface the
// deferred display story (and manual on-device verification) uses.
function getLatestHrSample(): HrSample | undefined {
  return hrRingBuffer[hrRingBuffer.length - 1];
}

// Plain arithmetic mean of whatever real samples in hrRingBuffer fall within
// the last `windowMs` - no smoothing, no weighting, no interpolation for
// gaps, no padding before a full window exists. Same undefined-safe loop
// shape as the eviction loop in captureSample() above. Returns undefined
// (never a fabricated number) until at least one real sample falls within
// the window, mirroring the instant reading's existing placeholder pattern.
function computeRollingAverage(windowMs: number): number | undefined {
  const cutoff = Date.now() - windowMs;
  let sum = 0;
  let count = 0;
  for (let i = 0; i < hrRingBuffer.length; i++) {
    const s = hrRingBuffer[i];
    // bpm <= 0 samples are the HRM sensor's warm-up readings (confirmed
    // on-device: ~10-15s of bpm=0 before the sensor locks on) - excluded
    // here so they don't drag the displayed average artificially low right
    // after a session starts. This is display-averaging-only: captureSample()
    // still records every raw sample (including zeros) to hrRingBuffer and
    // the persisted CSV, and the instant "Now" reading is untouched.
    if (s === undefined || s.t < cutoff || s.bpm <= 0) continue;
    sum += s.bpm;
    count++;
  }
  return count === 0 ? undefined : sum / count;
}

// Opens a new file under the same Session, reusing the exact same header
// (sessionActivity/sessionStartedEpochMs, captured once in startSampling)
// so the rotated file is fully self-describing on its own. Reuses
// openSessionFile()'s gap-safe track scheme (Story 1.5) for the new file's
// name, so a collision-free name is automatic. No-ops if called outside an
// active Session (sessionActivity/sessionStartedEpochMs unset) - can't
// happen mid-Session, since both are only cleared in stopSampling().
function rotateSessionFile(): void {
  if (sessionActivity === undefined || sessionStartedEpochMs === undefined) return;
  currentFile = openSessionFile(sessionActivity, sessionStartedEpochMs);
  currentFileSize = currentFile.getLength();
  const name: string = (currentFile as any).name;
  sessionFileNames.push(name);
  console.log("hrsessions: rotated to " + name);
}

// Writes everything queued since the last flush to the Session File as
// `t,bpm` rows, then clears the queue. The queue is only cleared once
// write() above has completed without throwing - if it throws, the queue
// stays populated and is retried (folded in with newly-arrived samples) on
// the next flush tick, for free, via normal JS control flow. Rotates to a
// new file first, before writing, if this batch would push the current
// file past HR_ROTATION_THRESHOLD_BYTES.
function flushSamples(): void {
  if (currentFile === undefined || hrWriteQueue.length === 0) return;
  let text = "";
  for (let i = 0; i < hrWriteQueue.length; i++) {
    const s = hrWriteQueue[i];
    if (s === undefined) continue;
    text += s.t + "," + s.bpm + "\n";
  }
  // text.length as a byte count assumes ASCII-only content (digits, commas,
  // newlines) - true for the current t,bpm row format. A future non-ASCII
  // field would need a different size measure here.
  if (currentFileSize + text.length > HR_ROTATION_THRESHOLD_BYTES) {
    rotateSessionFile();
  }
  // Non-null assertion: rotateSessionFile() always assigns a real file (it
  // no-ops only if sessionActivity/sessionStartedEpochMs are unset, which
  // can't happen mid-Session), but calling it invalidates TS's narrowing of
  // the top-of-function `currentFile === undefined` check.
  currentFile!.write(text);
  currentFileSize += text.length;
  console.log("hrsessions: flushed " + hrWriteQueue.length + " samples");
  hrWriteQueue = [];
}

// Opens the Session File, powers on the HRM sensor, and starts both the
// ~1s capture timer and the periodic flush timer. Resets the ring buffer
// and write queue so a new Session never sees stale samples from a
// previous one. Sole call site of Storage.open() (via openSessionFile) -
// Sampling owns the file handle for the Session's whole lifetime.
function startSampling(activity: Activity, startedEpochMs: number): void {
  hrRingBuffer = [];
  hrWriteQueue = [];
  latestBpm = undefined;
  sessionActivity = activity;
  sessionStartedEpochMs = startedEpochMs;
  currentFile = openSessionFile(activity, startedEpochMs);
  currentFileSize = currentFile.getLength();
  sessionFileNames = [(currentFile as any).name];
  Bangle.setHRMPower(true, "hrsessions");
  sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
  flushIntervalId = setInterval(flushSamples, HR_FLUSH_INTERVAL_MS);
}

// The epic's exact 4-step stop sequence: (1) HRM powered off first, so no
// more raw events can update latestBpm after this point and the last
// written row's timestamp is the true session end time - there is no
// removeListener typing on Bangle in the vendored types (same gap noted in
// Story 1.4), so powering off achieves the same "unsubscribe" goal; (2)
// both timers cleared; (3) one final flushSamples() call to catch
// anything queued since the last periodic flush; (4) the file reference
// dropped (there is no .close() - "closing" means "stop writing to it").
// Debug aid: dumps every file from the just-finalized Session (the first
// file plus any rotations - see sessionFileNames) to the console, so a
// single console copy after Stop shows everything needed to confirm a
// test, not just whichever file happens to be current. `.name` isn't in
// the vendored StorageFile type but is present at runtime (confirmed via
// Espruino's own object inspector output).
function logSessionFile(): void {
  for (let i = 0; i < sessionFileNames.length; i++) {
    const name = sessionFileNames[i];
    if (name === undefined) continue;
    console.log("hrsessions: --- " + name + " ---");
    const readFile = require("Storage").open(name, "r");
    let line: string | undefined;
    while ((line = readFile.readLine()) !== undefined) {
      console.log(line);
    }
    console.log("hrsessions: --- end " + name + " ---");
  }
}

function stopSampling(): void {
  Bangle.setHRMPower(false, "hrsessions"); // (1)
  if (sampleIntervalId !== undefined) clearInterval(sampleIntervalId); // (2)
  if (flushIntervalId !== undefined) clearInterval(flushIntervalId); // (2)
  sampleIntervalId = undefined;
  flushIntervalId = undefined;
  flushSamples(); // (3)
  logSessionFile();
  currentFile = undefined; // (4)
  latestBpm = undefined;
  hrRingBuffer = []; // don't let a stale reading answer getLatestHrSample() between sessions
  hrWriteQueue = [];
  // Don't let stale state (same reasoning as the ring buffer/write queue
  // above) answer between Sessions or feed a rotation after this Session
  // has ended.
  sessionActivity = undefined;
  sessionStartedEpochMs = undefined;
  currentFileSize = 0;
  sessionFileNames = [];
  console.log("hrsessions: stopped");
}

// ===== UI =====

const STOP_ZONE_HEIGHT = 40;

// Layout constants for the active-session screen's three stacked bpm rows
// plus the activity name above them. First draft (Y-positions and font
// scale are explicitly flagged "Ask First" in the polish spec) - every
// prior screen-layout choice in this project has needed on-device visual
// iteration (clipped text, misaligned labels), so expect the same here.
// The activity name is now top-aligned at the very top of the screen
// (where the removed "Current session:" label used to be), and the three
// bpm rows are enlarged (scale 2) now that removing the label frees up
// vertical space.
const ACTIVITY_Y = 4;
const NOW_Y = 44;
const AVG_1MIN_Y = 72;
const AVG_5MIN_Y = 100;
// Half-height of each bpm row's clear-band (fillRect Y ± this), and the
// font scale they're drawn at - shared by drawInstantReading and
// drawRollingAverages so the three rows stay visually identical.
const ROW_CLEAR_MARGIN = 10;
const ROW_FONT_SCALE = 2;

// Shared formatter for a labeled bpm row ("Now"/"1m"/"5m"), used by both
// drawInstantReading and drawRollingAverages so all three rows render
// identically. Placeholder ("-- bpm"), never a fabricated number, until a
// real value is available.
function formatBpmLine(label: string, value: number | undefined): string {
  if (value === undefined || !isFinite(value)) return label + ": -- bpm";
  return label + ": " + Math.round(value) + " bpm";
}

// Redraw timer covering all three live bpm rows (instant, 1-min, 5-min),
// independent of both the HRM event handler and Sampling's own ~1s capture
// timer -- started alongside the active-session screen and stopped in
// stopSession, mirroring the Sampling timers' lifecycle exactly (started
// together, stopped together). One shared ~1Hz timer per the epic's stated
// UI design, not three.
let redrawIntervalId: IntervalId | undefined;

// Repaints only its own small text band (never the whole screen) so the
// activity name and Stop zone never flicker on every tick. Reads the latest
// captured sample straight from Sampling; before the first real sample
// lands this shows a placeholder, never a fabricated number.
function drawInstantReading(): void {
  const w = g.getWidth();
  const latest = getLatestHrSample();
  const bpm = latest === undefined ? undefined : Math.round(latest.bpm);
  g.setColor(g.theme.bg);
  g.fillRect(0, NOW_Y - ROW_CLEAR_MARGIN, w, NOW_Y + ROW_CLEAR_MARGIN);
  g.setColor(g.theme.fg);
  g.setFont("6x8", ROW_FONT_SCALE);
  g.setFontAlign(0, 0);
  g.drawString(formatBpmLine("Now", bpm), w / 2, NOW_Y);
  g.setFontAlign(-1, -1); // restore to a neutral default; don't assume what a caller draws next
}

// Same clear-band-then-draw pattern as drawInstantReading, for the 1-min/
// 5-min rows. Both are a plain arithmetic mean of hrRingBuffer samples
// within their window (computeRollingAverage) - no smoothing, no weighting.
function drawRollingAverages(): void {
  const w = g.getWidth();
  const avg1 = computeRollingAverage(HR_AVG_1MIN_WINDOW_MS);
  const avg5 = computeRollingAverage(HR_AVG_5MIN_WINDOW_MS);
  g.setColor(g.theme.bg);
  g.fillRect(0, AVG_1MIN_Y - ROW_CLEAR_MARGIN, w, AVG_1MIN_Y + ROW_CLEAR_MARGIN);
  g.fillRect(0, AVG_5MIN_Y - ROW_CLEAR_MARGIN, w, AVG_5MIN_Y + ROW_CLEAR_MARGIN);
  g.setColor(g.theme.fg);
  g.setFont("6x8", ROW_FONT_SCALE);
  g.setFontAlign(0, 0);
  g.drawString(formatBpmLine("1m", avg1), w / 2, AVG_1MIN_Y);
  g.drawString(formatBpmLine("5m", avg5), w / 2, AVG_5MIN_Y);
  g.setFontAlign(-1, -1); // restore to a neutral default; don't assume what a caller draws next
}

// Redraw-timer callback: repaints all three live bpm rows every tick.
function redrawLiveReadings(): void {
  drawInstantReading();
  drawRollingAverages();
}

function startLiveReadingsRedraw(): void {
  redrawIntervalId = setInterval(redrawLiveReadings, 1000);
}

function stopLiveReadingsRedraw(): void {
  if (redrawIntervalId !== undefined) clearInterval(redrawIntervalId);
  redrawIntervalId = undefined;
}

function showActivityMenu(): void {
  const menu: Menu = {};
  ACTIVITIES.forEach((activity) => {
    menu[activity] = () => {
      onActivitySelected(activity);
    };
  });
  E.showMenu(menu);
}

// Hand-drawn (no E.showMessage) so no title-bar chrome is ever rendered via
// E.showMessage's title argument or a menu's "" key -- the activity name
// below is this screen's own content, not a title bar. Also draws a
// tappable "Stop session" zone at the bottom, whose height is compared
// against touch y-coordinates in onSessionScreenTouch.
function drawActiveSessionScreen(activity: Activity): void {
  const w = g.getWidth();
  const h = g.getHeight();
  g.clear(); // resets fg/bg to g.theme.fg/g.theme.bg

  // Activity name, top-aligned at the very top of the screen - the
  // "Current session:" label that used to occupy this spot is gone (the
  // Stop-session button already makes the screen's purpose obvious), so the
  // activity name now anchors at the label's old y=4 position instead of
  // sharing the screen with it.
  g.setFont("6x8", 2);
  g.setFontAlign(0, -1);
  g.drawString(activity, w / 2, ACTIVITY_Y);

  // Instant HR reading plus 1-min/5-min rolling averages, stacked below the
  // activity name -- drawn once here so all three placeholders are visible
  // immediately, not just after the first redraw tick; the redraw timer
  // (started in showActiveSessionScreen) keeps them current afterwards.
  drawInstantReading();
  drawRollingAverages();

  // Stop zone: theme-inverted fill with theme-background-colored text, so
  // it stays legible in both light and dark themes. Font/align set
  // explicitly (not inherited from whatever drew before) since
  // drawInstantReading() also touches both.
  g.setColor(g.theme.fg);
  g.fillRect(0, h - STOP_ZONE_HEIGHT, w, h);
  g.setColor(g.theme.bg);
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  g.drawString("Stop session", w / 2, h - STOP_ZONE_HEIGHT / 2);

  g.setColor(g.theme.fg);
  g.setFontAlign(-1, -1);
  g.setFont("6x8", 1);
}

function showActiveSessionScreen(activity: Activity): void {
  drawActiveSessionScreen(activity);
  Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
  startLiveReadingsRedraw();
}

// ===== Top-level wiring =====

// startSampling() (which opens the Session File) runs before currentActivity
// is set, not after - if it throws, currentActivity is never left stuck
// set, so the Story 1.3 guard above doesn't permanently block every future
// activity selection.
function onActivitySelected(activity: Activity): void {
  if (currentActivity !== undefined) {
    console.log("hrsessions: ignored " + activity + " tap - already active: " + currentActivity);
    return;
  }
  const startedEpochMs = Math.round(Date.now());
  startSampling(activity, startedEpochMs);
  currentActivity = activity;
  E.showMenu(); // remove the Activity menu
  showActiveSessionScreen(activity);
}

function onSessionScreenTouch(_button?: number, xy?: TouchCallbackXY): void {
  if (xy && xy.y >= g.getHeight() - STOP_ZONE_HEIGHT) {
    stopSession();
  }
}

// Resets in-memory Session state and returns to the Activity menu.
// stopSampling() runs the epic's 4-step stop sequence (HRM off, timers
// cleared, final flush, file reference dropped) before any in-memory state
// here is cleared. Clear the custom UI/touch handler before switching
// screens so a stray touch can't retrigger this after the menu is shown.
function stopSession(): void {
  currentActivity = undefined;
  stopSampling();
  stopLiveReadingsRedraw();
  Bangle.setUI();
  showActivityMenu();
}

// Registered once at module load, not per-session - it's cheap and inert
// whenever the HRM is powered off, so there's no need to add/remove it per
// start/stop and no risk of listener accumulation across sessions.
Bangle.on("HRM", onHrmSample);

showActivityMenu();
