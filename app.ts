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
// batch would push the current file past ~130KB. A later spec (continuous
// live monitoring + idle/home screen) splits Sampling's startSampling/
// stopSampling into two independently-lifecycled halves:
// startLiveMonitoring/stopLiveMonitoring (HRM power, capture timer, ring
// buffer -- now app-lifetime, started once at launch) and
// startPersistence/stopPersistence (Session File, write queue, flush timer
// -- still strictly Session-scoped). The boot-time native Activity menu is
// replaced by a custom-drawn idle/home screen (drawHomeScreen/
// showHomeScreen) showing the same live bpm rows whenever no Session is
// active, with a bottom button opening an Activity picker (showActivityPicker,
// renamed from showActivityMenu). Originally the native E.showMenu, later
// hand-drawn instead once its always-on title bar turned out to not be
// suppressable via any menu option.

// ===== State =====

type Activity =
  | "Jogging" | "Biking" | "Sleeping" | "Eating" | "Walking"
  | "Swimming" | "Meditation" | "Breathing" | "Gym" | "Relaxing";

// The full activity list - where you add, remove, or rename an activity.
// Written in any order; keep the Activity union above in sync (the build
// fails right here if a name is missing from it).
const ACTIVITIES: Activity[] = [
  "Jogging", "Biking", "Sleeping", "Eating", "Walking",
  "Swimming", "Meditation", "Breathing", "Gym", "Relaxing",
];
// Sorted once at load, so the picker always reads A->Z no matter the order
// above. drawActivityPicker (render), onActivityPickerTouch (tap hit-test)
// and onActivityPickerDrag (scroll math) all index into this same array, so
// one sort here keeps them mutually consistent. Case-insensitive, so a name
// added in any case (e.g. "yoga") still sorts where you'd expect, not after
// every capitalised entry.
ACTIVITIES.sort((a, b) => {
  const al = a.toLowerCase(), bl = b.toLowerCase();
  return al < bl ? -1 : al > bl ? 1 : 0;
});

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
// Also relied on verbatim by HR_AVG_10MIN_WINDOW_MS below (the "10m"
// label) - changing this for retention/memory reasons would silently change
// what "10m" means on screen too.
const HR_BUFFER_WINDOW_MS = 600000; // 600s
// The two rolling-average windows. The 10-min window reuses the ring
// buffer's own eviction window verbatim (both are 600s) rather than defining
// a second, independent constant that could drift out of sync with it.
const HR_AVG_1MIN_WINDOW_MS = 60000;
const HR_AVG_10MIN_WINDOW_MS = HR_BUFFER_WINDOW_MS;
// 10s: batches writes without holding too much unflushed data at once. Not
// a safety-critical number - no crash-recovery is attempted for a Session
// interrupted by reset/power loss (accepted epic behavior), so this just
// bounds how much of the tail end of a Session could be lost in that case.
const HR_FLUSH_INTERVAL_MS = 10000;
// ~122KB, comfortably under the epic's ~130KB BLE-transfer memory-crash
// threshold with margin for the batch that triggers the check.
const HR_ROTATION_THRESHOLD_BYTES = 125000;
// Ambient-storage warm-up floor: an app-open span that doesn't clear BOTH of
// these leaves no file at all - a quick glance at the watch costs zero flash
// writes. Checked once per flush tick in flushAmbient(), not per sample.
const AMBIENT_MIN_SPAN_MS = 60000;
const AMBIENT_MIN_REAL_SAMPLES = 30;
// Hard cap on the pre-file RAM buffer. Normally the buffer only holds the
// warm-up window (~60s) before the file opens and drains it, but a span
// where the sensor never locks on (watch off-wrist, app left open on a
// table) never opens a file - without this cap ambientQueue would grow ~1
// entry/sec forever. Oldest entries are dropped past the cap, mirroring the
// ring buffer; a span that never qualifies produces nothing anyway.
const AMBIENT_QUEUE_MAX = 120;

// Time-windowed ring buffer of captured samples, the sole source for the
// live instant reading (and, in Story 1.6, the 1-min/10-min rolling
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

// Ambient storage: a parallel, lighter write path used only while the app is
// open with NO Session (currentFile === undefined). One immutable CSV per
// app-open span. Deliberately separate from the Session vars above - the
// shipped/tested Session path is not touched.
let ambientFile: StorageFile | undefined;
let ambientQueue: HrSample[] = [];
let ambientFileSize = 0;
let ambientOpenEpochMs: number | undefined;
// Count of bpm>0 samples seen this span - one half of the warm-up floor.
let ambientRealSamples = 0;
let ambientFlushId: IntervalId | undefined;

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
  // Route the sample to whichever write path is live: the Session queue when
  // a Session is active (currentFile !== undefined), otherwise the ambient
  // queue while an app-open span is running. The ring-buffer push above is
  // unconditional - live monitoring runs for the app's whole lifetime.
  if (currentFile !== undefined) {
    hrWriteQueue.push(sample);
  } else if (ambientOpenEpochMs !== undefined) {
    ambientQueue.push(sample);
    if (sample.bpm > 0) ambientRealSamples++;
    // Bound the pre-file buffer: a span whose sensor never locks on never
    // opens a file, so without this the queue grows without limit.
    if (ambientQueue.length > AMBIENT_QUEUE_MAX) ambientQueue.shift();
  }
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

// Powers on the HRM sensor and starts the ~1s capture timer. Runs for the
// app's whole lifetime - started once at launch, not per-Session - so live
// bpm data (ring buffer) is available on the idle/home screen even when no
// Session is active. Persistence (Session File, write queue, flush timer)
// is entirely separate - see startPersistence/stopPersistence below.
function startLiveMonitoring(): void {
  Bangle.setHRMPower(true, "hrsessions");
  sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
}

// Counterpart to startLiveMonitoring() - not currently called anywhere
// (the app never stops live monitoring while running; see the spec's
// deferred-work.md for the explicit app-close cleanup follow-up), kept for
// symmetry and any future caller.
function stopLiveMonitoring(): void {
  Bangle.setHRMPower(false, "hrsessions");
  if (sampleIntervalId !== undefined) clearInterval(sampleIntervalId);
  sampleIntervalId = undefined;
  latestBpm = undefined;
  hrRingBuffer = [];
}

// Opens the Session File and starts the periodic flush timer. Resets the
// write queue so a new Session never sees stale samples from a previous
// one. Sole call site of Storage.open() (via openSessionFile) - Sampling
// owns the file handle for the Session's whole lifetime. Session-lifetime
// only - never touches the HRM sensor or the capture timer, both of which
// are already running continuously via startLiveMonitoring().
function startPersistence(activity: Activity, startedEpochMs: number): void {
  hrWriteQueue = [];
  sessionActivity = activity;
  sessionStartedEpochMs = startedEpochMs;
  currentFile = openSessionFile(activity, startedEpochMs);
  currentFileSize = currentFile.getLength();
  sessionFileNames = [(currentFile as any).name];
  flushIntervalId = setInterval(flushSamples, HR_FLUSH_INTERVAL_MS);
}

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

// Session-lifetime counterpart to startPersistence() - never touches the
// HRM sensor or the capture timer, both of which keep running via
// startLiveMonitoring() regardless of Session state. Flush timer cleared,
// one final flushSamples() call to catch anything queued since the last
// periodic flush, then the file reference dropped (there is no .close() -
// "closing" means "stop writing to it").
function stopPersistence(): void {
  if (flushIntervalId !== undefined) clearInterval(flushIntervalId);
  flushIntervalId = undefined;
  flushSamples();
  logSessionFile();
  currentFile = undefined;
  hrWriteQueue = [];
  sessionActivity = undefined;
  sessionStartedEpochMs = undefined;
  currentFileSize = 0;
  sessionFileNames = [];
  console.log("hrsessions: stopped");
}

// --- Ambient storage (no-Session persistence) ---

// Mirrors openSessionFile()'s gap-safe tracked-name scheme with an "amb"
// prefix and a fixed "ambient" header marker instead of an Activity. NOT a
// refactor of openSessionFile - the duplication is deliberate so the shipped
// Session path stays untouched. Still UTC (the same separately-deferred item
// as openSessionFile), but derives the date from openEpochMs, not "now", so
// every part of one span - even one that rotates across midnight - shares a
// stable prefix and a consistent track set.
function openAmbientFile(openEpochMs: number): StorageFile {
  const date = new Date(openEpochMs).toISOString().substr(0, 10).replace(/-/g, "");
  const prefix = "hrsessions.amb" + date;
  const existing = require("Storage").list(new RegExp("^" + prefix.replace(/\./g, "\\.")));
  let maxTrack = -1;
  for (let i = 0; i < existing.length; i++) {
    const fname = existing[i];
    if (fname === undefined) continue;
    // Parse the whole track segment (prefix .. first "."), not just its first
    // char - a busy day can produce more than 36 spans, and a one-char base-36
    // read would then alias "10" back to "1" and collide. Splitting on "." also
    // drops the ".csv" and any trailing StorageFile marker byte.
    const seg = fname.substring(prefix.length).split(".")[0];
    const trackVal = parseInt(seg === undefined ? "" : seg, 36);
    if (!isNaN(trackVal) && trackVal > maxTrack) maxTrack = trackVal;
  }
  const track = (maxTrack + 1).toString(36);
  const name = prefix + track + ".csv";
  const file = require("Storage").open(name, "w");
  file.write("ambient," + openEpochMs + "\n");
  console.log("hrsessions: opened " + name + " (ambient)");
  return file;
}

// Ambient counterpart to rotateSessionFile(): a long open span that crosses
// the size ceiling continues in a new tracked file, same "ambient,<openEpochMs>"
// header. No-ops outside an active span.
function rotateAmbientFile(): void {
  if (ambientOpenEpochMs === undefined) return;
  ambientFile = openAmbientFile(ambientOpenEpochMs);
  ambientFileSize = ambientFile.getLength();
  console.log("hrsessions: ambient rotated to " + (ambientFile as any).name);
}

// Ambient counterpart to flushSamples(). Two differences: (1) the warm-up
// floor gate at the top - until the span clears BOTH thresholds, samples stay
// in ambientQueue and nothing is written to flash; (2) it opens its own file
// lazily, on the first flush that qualifies.
function flushAmbient(): void {
  if (ambientOpenEpochMs === undefined || ambientQueue.length === 0) return;
  if (ambientFile === undefined) {
    if (ambientRealSamples < AMBIENT_MIN_REAL_SAMPLES) return;
    if (Math.round(Date.now()) - ambientOpenEpochMs < AMBIENT_MIN_SPAN_MS) return;
    ambientFile = openAmbientFile(ambientOpenEpochMs);
    ambientFileSize = ambientFile.getLength();
  }
  let text = "";
  for (let i = 0; i < ambientQueue.length; i++) {
    const s = ambientQueue[i];
    if (s === undefined) continue;
    text += s.t + "," + s.bpm + "\n";
  }
  if (ambientFileSize + text.length > HR_ROTATION_THRESHOLD_BYTES) {
    rotateAmbientFile();
  }
  ambientFile!.write(text);
  ambientFileSize += text.length;
  console.log("hrsessions: ambient flushed " + ambientQueue.length + " samples");
  ambientQueue = [];
}

// Begins a new app-open span: fresh open epoch, empty buffer, floor re-armed,
// no file yet. Called at app launch and after a Session stops. Mirrors
// startPersistence() but never touches the HRM sensor or Session state.
function startAmbientSpan(): void {
  if (ambientFlushId !== undefined) clearInterval(ambientFlushId); // defensive: never leak a timer
  ambientOpenEpochMs = Math.round(Date.now());
  ambientQueue = [];
  ambientRealSamples = 0;
  ambientFileSize = 0;
  ambientFile = undefined;
  ambientFlushId = setInterval(flushAmbient, HR_FLUSH_INTERVAL_MS);
}

// Ends the current span: stop the flush timer, one final flush (which may
// legitimately be the one that crosses the floor for a >=60s span ending as a
// Session starts), then drop all span state. Mirrors stopPersistence().
function endAmbientSpan(): void {
  if (ambientFlushId !== undefined) clearInterval(ambientFlushId);
  ambientFlushId = undefined;
  flushAmbient();
  ambientFile = undefined;
  ambientQueue = [];
  ambientOpenEpochMs = undefined;
  ambientRealSamples = 0;
  ambientFileSize = 0;
}

// ===== UI =====

const BUTTON_ZONE_HEIGHT = 40;
// How long the tracked-confirmation screen stays up before auto-returning
// to the idle screen.
const TRACKED_CONFIRMATION_DISMISS_MS = 2500;

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
// Height of the white band drawn behind the activity name (black text) -
// covers the scale-2 "6x8" glyph height (16px) plus top/bottom padding.
const ACTIVITY_BAND_HEIGHT = 24;
const NOW_Y = 44;
const AVG_1MIN_Y = 72;
const AVG_10MIN_Y = 100;
// Shifts the three bpm rows down on the active-session screen only, so the
// gap above them (below the white activity band) matches the gap below
// them (above the Stop-session button) - the home screen has no activity
// band, so its rows use no offset and keep the values above as-is.
// Derived for the 176px Bangle.js 2 screen: the row block spans
// NOW_Y-ROW_CLEAR_MARGIN..AVG_10MIN_Y+ROW_CLEAR_MARGIN (76px) inside the
// region between ACTIVITY_BAND_HEIGHT and h-BUTTON_ZONE_HEIGHT (112px);
// splitting the 36px slack evenly gives an 18px gap on each side, which is
// +8px more than the un-offset top gap of 10px (NOW_Y-ROW_CLEAR_MARGIN
// minus ACTIVITY_BAND_HEIGHT) - hence the +8 offset applied below.
const ACTIVE_SCREEN_ROW_Y_OFFSET = 8;
// Half-height of each bpm row's clear-band (fillRect Y ± this), and the
// font scale they're drawn at - shared by drawInstantReading and
// drawRollingAverages so the three rows stay visually identical.
const ROW_CLEAR_MARGIN = 10;
const ROW_FONT_SCALE = 2;

// Shared button colors - "go" green for the Pick-activity button, "stop"
// red for the Stop-session button, white text on both so it's readable
// regardless of the light/dark theme underneath. Also reused by the
// activity-name band (black text on white).
const COLOR_GREEN = "#00a000";
const COLOR_RED = "#c00000";
const COLOR_WHITE = "#ffffff";
const COLOR_BLACK = "#000000";

// Shared formatter for a labeled bpm row ("Now"/"1m"/"10m"), used by both
// drawInstantReading and drawRollingAverages so all three rows render
// identically. Placeholder ("-- bpm"), never a fabricated number, until a
// real value is available.
function formatBpmLine(label: string, value: number | undefined): string {
  if (value === undefined || !isFinite(value)) return label + ": -- bpm";
  return label + ": " + Math.round(value) + " bpm";
}

// Redraw timer covering all three live bpm rows (instant, 1-min, 10-min),
// independent of both the HRM event handler and Sampling's own ~1s capture
// timer -- app-lifetime like live monitoring itself (started once at
// launch), paused only around the Activity picker (showActivityPicker/
// onActivitySelected) so our own ticks can't draw underneath it. One shared
// ~1Hz timer per the epic's stated UI design, not three.
let redrawIntervalId: IntervalId | undefined;

// Repaints only its own small text band (never the whole screen) so the
// activity name and Stop zone never flicker on every tick. Reads the latest
// captured sample straight from Sampling; before the first real sample
// lands this shows a placeholder, never a fabricated number.
function drawInstantReading(yOffset: number = 0): void {
  const w = g.getWidth();
  const y = NOW_Y + yOffset;
  const latest = getLatestHrSample();
  const bpm = latest === undefined ? undefined : Math.round(latest.bpm);
  g.setColor(g.theme.bg);
  g.fillRect(0, y - ROW_CLEAR_MARGIN, w, y + ROW_CLEAR_MARGIN);
  g.setColor(g.theme.fg);
  g.setFont("6x8", ROW_FONT_SCALE);
  g.setFontAlign(0, 0);
  g.drawString(formatBpmLine("Now", bpm), w / 2, y);
  g.setFontAlign(-1, -1); // restore to a neutral default; don't assume what a caller draws next
}

// Same clear-band-then-draw pattern as drawInstantReading, for the 1-min/
// 10-min rows. Both are a plain arithmetic mean of hrRingBuffer samples
// within their window (computeRollingAverage) - no smoothing, no weighting.
function drawRollingAverages(yOffset: number = 0): void {
  const w = g.getWidth();
  const avg1 = computeRollingAverage(HR_AVG_1MIN_WINDOW_MS);
  const avg10 = computeRollingAverage(HR_AVG_10MIN_WINDOW_MS);
  const y1 = AVG_1MIN_Y + yOffset;
  const y10 = AVG_10MIN_Y + yOffset;
  g.setColor(g.theme.bg);
  g.fillRect(0, y1 - ROW_CLEAR_MARGIN, w, y1 + ROW_CLEAR_MARGIN);
  g.fillRect(0, y10 - ROW_CLEAR_MARGIN, w, y10 + ROW_CLEAR_MARGIN);
  g.setColor(g.theme.fg);
  g.setFont("6x8", ROW_FONT_SCALE);
  g.setFontAlign(0, 0);
  g.drawString(formatBpmLine("1m", avg1), w / 2, y1);
  g.drawString(formatBpmLine("10m", avg10), w / 2, y10);
  g.setFontAlign(-1, -1); // restore to a neutral default; don't assume what a caller draws next
}

// Redraw-timer callback: repaints all three live bpm rows every tick, at
// the active-session screen's offset whenever a Session is running (the
// only currentActivity !== undefined signal already available), or at the
// home screen's un-offset position otherwise - the same shared timer
// serves whichever screen is actually showing.
function redrawLiveReadings(): void {
  const yOffset = currentActivity !== undefined ? ACTIVE_SCREEN_ROW_Y_OFFSET : 0;
  drawInstantReading(yOffset);
  drawRollingAverages(yOffset);
}

function startLiveReadingsRedraw(): void {
  redrawIntervalId = setInterval(redrawLiveReadings, 1000);
}

function stopLiveReadingsRedraw(): void {
  if (redrawIntervalId !== undefined) clearInterval(redrawIntervalId);
  redrawIntervalId = undefined;
}

// Idle/home screen: mirrors the active-session screen's structure (same
// drawInstantReading()/drawRollingAverages() calls, same bottom button
// zone) but with no activity name/header, since no Session is active.
function drawHomeScreen(): void {
  const w = g.getWidth();
  const h = g.getHeight();
  g.clear(); // resets fg/bg to g.theme.fg/g.theme.bg

  drawInstantReading();
  drawRollingAverages();

  // Bottom button: strong green "go" fill, matching the active-session
  // screen's red Stop button. Black text (not white like Stop's) - white on
  // this particular green didn't have enough contrast, per on-device
  // feedback. "6x8" scale 2, same as Stop's (the only font/scale combo
  // proven to actually exist on this device, after two smaller-scale
  // attempts failed on-device).
  g.setColor(COLOR_GREEN);
  g.fillRect(0, h - BUTTON_ZONE_HEIGHT, w, h);
  g.setColor(COLOR_BLACK);
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  g.drawString("Start", w / 2, h - BUTTON_ZONE_HEIGHT / 2);

  g.setColor(g.theme.fg);
  g.setFontAlign(-1, -1);
  g.setFont("6x8", 1);
}

function onHomeScreenTouch(_button?: number, xy?: TouchCallbackXY): void {
  if (xy && xy.y >= g.getHeight() - BUTTON_ZONE_HEIGHT) {
    showActivityPicker();
  }
}

function showHomeScreen(): void {
  drawHomeScreen();
  Bangle.setUI({ mode: "custom", touch: onHomeScreenTouch });
}

// Hand-drawn Activity picker (previously the native E.showMenu) - switched
// off native menus entirely because Bangle.js 2's built-in menu widget
// always draws its own top bar (hamburger/back icon), which is baked into
// the widget itself and isn't suppressable via any Menu/MenuOptions field.
// Hand-drawing it, like the other two screens, is the only way to get a
// header-free picker. Fixed-height rows (screen height / PICKER_VISIBLE_ROWS,
// the row size from when there were exactly 4 activities) rather than
// dividing evenly by ACTIVITIES.length, so extra activities scroll instead
// of every row shrinking - dragged via onActivityPickerDrag below.
const PICKER_VISIBLE_ROWS = 4;

// Vertical scroll position in px, 0 = top of the list. Reset to 0 each time
// the picker opens (showActivityPicker) so it never reopens mid-scroll from
// a previous visit.
let pickerScrollOffset = 0;

function drawActivityPicker(): void {
  const w = g.getWidth();
  const h = g.getHeight();
  const rowH = h / PICKER_VISIBLE_ROWS;
  g.clear();
  g.setColor(g.theme.fg);
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  ACTIVITIES.forEach((activity, i) => {
    const y = i * rowH - pickerScrollOffset;
    if (y + rowH < 0 || y > h) return; // fully outside the viewport - skip
    if (i > 0) g.drawLine(0, y, w, y);
    g.drawString(activity, w / 2, y + rowH / 2);
  });
  // Scroll indicator: a thin bar on the right edge, sized/positioned by how
  // much of the full list is currently visible. Only drawn when there's
  // more content than fits on screen, so it's absent for a short list.
  const contentH = ACTIVITIES.length * rowH;
  const maxScroll = Math.max(0, contentH - h);
  if (maxScroll > 0) {
    const thumbH = Math.max(16, (h / contentH) * h);
    const thumbY = (pickerScrollOffset / maxScroll) * (h - thumbH);
    g.setColor(g.theme.fg);
    g.fillRect(w - 4, thumbY, w - 1, thumbY + thumbH);
  }
  g.setFontAlign(-1, -1); // restore to a neutral default; don't assume what a caller draws next
}

function onActivityPickerTouch(_button?: number, xy?: TouchCallbackXY): void {
  if (!xy) return;
  const rowH = g.getHeight() / PICKER_VISIBLE_ROWS;
  const activity = ACTIVITIES[Math.floor((xy.y + pickerScrollOffset) / rowH)];
  if (activity !== undefined) onActivitySelected(activity);
}

// Drags the list with the finger (drag up reveals rows below, the standard
// mobile-scroll convention), clamped so it can never scroll past the first
// or last row.
function onActivityPickerDrag(event: { x: number; y: number; dx: number; dy: number; b: 1 | 0 }): void {
  const h = g.getHeight();
  const rowH = h / PICKER_VISIBLE_ROWS;
  const contentH = ACTIVITIES.length * rowH;
  const maxScroll = Math.max(0, contentH - h);
  pickerScrollOffset = Math.min(maxScroll, Math.max(0, pickerScrollOffset - event.dy));
  drawActivityPicker();
}

// Any horizontal swipe (either direction) goes back to the idle/home
// screen - deliberately direction-agnostic. This is the only swipe handler
// in the app, so there's no other gesture it could collide with, and it
// sidesteps needing to pin down Bangle.js's directionLR sign convention
// (a prior left-only version fired on the wrong physical gesture).
function onActivityPickerSwipe(directionLR: number): void {
  if (directionLR === 0) return; // vertical-only swipe, not a left/right one
  startLiveReadingsRedraw();
  showHomeScreen();
}

function showActivityPicker(): void {
  stopLiveReadingsRedraw(); // avoid our redraw ticks drawing under the picker
  pickerScrollOffset = 0;
  drawActivityPicker();
  Bangle.setUI({
    mode: "custom",
    touch: onActivityPickerTouch,
    swipe: onActivityPickerSwipe,
    drag: onActivityPickerDrag,
  });
}

// Black-on-white activity-name header, shared verbatim by the
// active-session screen and the tracked-confirmation screen so the two can
// never visually drift apart (per this feature's own "Always"). Top-aligned
// at the very top of the screen - the "Current session:" label that used to
// occupy this spot is gone (the Stop-session button already makes the
// active-session screen's purpose obvious), so the activity name anchors at
// the label's old y=4 position instead of sharing the screen with it. Black
// text on a white band, a fixed-look header regardless of the light/dark
// theme.
function drawActivityHeader(activity: Activity): void {
  const w = g.getWidth();
  g.setColor(COLOR_WHITE);
  g.fillRect(0, 0, w - 1, ACTIVITY_BAND_HEIGHT - 1);
  g.setColor(COLOR_BLACK);
  g.setFont("6x8", 2);
  g.setFontAlign(0, -1);
  g.drawString(activity, w / 2, ACTIVITY_Y);
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

  drawActivityHeader(activity);

  // Instant HR reading plus 1-min/10-min rolling averages, stacked below the
  // activity name -- drawn once here so all three placeholders are visible
  // immediately, not just after the first redraw tick; the redraw timer
  // (started in showActiveSessionScreen) keeps them current afterwards.
  drawInstantReading(ACTIVE_SCREEN_ROW_Y_OFFSET);
  drawRollingAverages(ACTIVE_SCREEN_ROW_Y_OFFSET);

  // Stop zone: strong red fill (matching the home screen's green Start
  // button) with white text, so it stays legible in both light and dark
  // themes. Font/align set explicitly (not inherited from whatever drew
  // before) since drawInstantReading() also touches both.
  g.setColor(COLOR_RED);
  g.fillRect(0, h - BUTTON_ZONE_HEIGHT, w, h);
  g.setColor(COLOR_WHITE);
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  g.drawString("Stop", w / 2, h - BUTTON_ZONE_HEIGHT / 2);

  g.setColor(g.theme.fg);
  g.setFontAlign(-1, -1);
  g.setFont("6x8", 1);
}

function showActiveSessionScreen(activity: Activity): void {
  drawActiveSessionScreen(activity);
  Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
  // No startLiveReadingsRedraw() call here - the redraw timer is already
  // app-lifetime, started once at launch (and resumed in onActivitySelected
  // after the picker paused it).
}

// Confirmation screen shown between "Stop" and the idle screen -
// acknowledges the just-stopped Session was actually saved. Reuses
// drawActivityHeader() verbatim (same header as the active-session screen -
// the two can never visually drift apart) plus a hand-drawn checkmark
// (g.fillPoly - a plain filled polygon, always part of Graphics, no icon
// font or asset dependency) and "Tracked!" text. First-draft checkmark
// geometry, adapted from the fillPoly doc example's own checkmark-shaped
// sample - expect on-device coordinate iteration like every other
// screen-layout choice in this file.
function drawTrackedConfirmationScreen(activity: Activity): void {
  const w = g.getWidth();
  g.clear();
  drawActivityHeader(activity);
  const cx = w / 2, cy = 90;
  g.setColor(COLOR_GREEN);
  g.fillPoly([
    cx - 30, cy - 4, cx - 10, cy + 20, cx + 34, cy - 28,
    cx + 26, cy - 36, cx - 10, cy, cx - 22, cy - 12,
  ]);
  g.setColor(g.theme.fg);
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  g.drawString("Tracked!", w / 2, 140);
  g.setFontAlign(-1, -1);
}

// Pauses the shared live-readings redraw timer before showing this screen
// (same pause/resume pattern showActivityPicker/onActivitySelected already
// use for the same reason) so its ~1Hz ticks can never draw bpm rows over
// this screen, then resumes it right before showHomeScreen() once the fixed
// ~2.5s auto-dismiss timer elapses. No touch handler is registered
// (Bangle.setUI({mode:"custom"}) with no touch/swipe) - dismissal is
// auto-only, a tap during the ~2.5s window is a no-op.
function showTrackedConfirmationScreen(activity: Activity): void {
  stopLiveReadingsRedraw();
  drawTrackedConfirmationScreen(activity);
  Bangle.setUI({ mode: "custom" });
  setTimeout(() => {
    startLiveReadingsRedraw();
    showHomeScreen();
  }, TRACKED_CONFIRMATION_DISMISS_MS);
}

// ===== Top-level wiring =====

// startPersistence() (which opens the Session File) runs before
// currentActivity is set, not after - if it throws, currentActivity is
// never left stuck set, so the Story 1.3 guard above doesn't permanently
// block every future activity selection.
function onActivitySelected(activity: Activity): void {
  if (currentActivity !== undefined) {
    console.log("hrsessions: ignored " + activity + " tap - already active: " + currentActivity);
    return;
  }
  startLiveReadingsRedraw(); // resume, paused by showActivityPicker()
  const startedEpochMs = Math.round(Date.now());
  startPersistence(activity, startedEpochMs);
  // End the ambient span AFTER startPersistence: if it throws, the ambient
  // span is left running untouched. captureSample() already routes to the
  // Session queue the instant currentFile is set, so no sample is lost here.
  endAmbientSpan();
  currentActivity = activity;
  showActiveSessionScreen(activity);
}

function onSessionScreenTouch(_button?: number, xy?: TouchCallbackXY): void {
  if (xy && xy.y >= g.getHeight() - BUTTON_ZONE_HEIGHT) {
    stopSession();
  }
}

// Resets in-memory Session state and shows the tracked-confirmation screen
// (which auto-returns to the idle/home screen on its own ~2.5s timer).
// currentActivity is captured into stoppedActivity before it's cleared, so
// the confirmation screen shows the just-stopped Session's activity name,
// not a cleared/undefined one - stopSession is reached only via the Stop
// button, which is only shown while a Session is active, so currentActivity
// is always set here. stopPersistence() finalizes the Session File (flush
// timer cleared, final flush, file reference dropped) before any in-memory
// state here is cleared. Live monitoring (HRM/capture timer) is never
// stopped here - it keeps running app-lifetime, so the bpm rows never blank
// out during this transition; only the redraw timer is paused, by
// showTrackedConfirmationScreen itself.
function stopSession(): void {
  const stoppedActivity = currentActivity!;
  currentActivity = undefined;
  stopPersistence();
  startAmbientSpan(); // app is still open with no Session - resume ambient capture
  showTrackedConfirmationScreen(stoppedActivity);
}

// Registered once at module load, not per-session - it's cheap and inert
// whenever the HRM is powered off, so there's no need to add/remove it per
// start/stop and no risk of listener accumulation across sessions.
Bangle.on("HRM", onHrmSample);

// Live monitoring (HRM power, capture timer) and the redraw timer both
// start once here, at app launch, and run for the app's whole lifetime -
// independent of whether a Session is active. The idle/home screen is
// shown first; selecting an activity starts persistence on top of the
// already-running live monitoring.
startLiveMonitoring();
startAmbientSpan();
startLiveReadingsRedraw();
showHomeScreen();
