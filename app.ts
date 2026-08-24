// hrsessions - heart-rate session tracker for Bangle.js 2
//
// Single compiled source file, organized into four sections plus top-level
// wiring (see the architecture spine / epic context for the full design):
//   State    - session data, leaf module, calls nothing else
//   Storage  - Session File persistence, leaf module, calls nothing else
//   Sampling - HRM sampling: throttles raw hardware events down to ~1/sec
//              into a time-windowed ring buffer (Story 1.4). Persisting
//              samples to the Session File is Story 1.5; rolling averages
//              are Story 1.6.
//   UI       - screen drawing, calls State/Sampling, never Storage
//
// Story 1.1 implements enough of State/Storage/UI for: app launch shows the
// Activity menu, selecting an Activity opens a new Session File and writes
// its header line. Story 1.2 adds the active-session screen (hand-drawn,
// no title/header) and its touch-driven "Stop session" zone, which resets
// in-memory Session state and returns to the Activity menu. The Session
// File itself is not touched on stop yet - the four-step stop sequence
// (unsubscribe HRM, stop flush timer, flush queue, close file) is Story 1.5.
// Story 1.4 adds the Sampling layer: HRM power and the ~1s capture timer
// turn on in onActivitySelected and off in stopSession, so the sensor is
// never left running once a Session ends.

// ===== State =====

type Activity = "Jogging" | "Biking" | "Sleeping" | "Eating";

const ACTIVITIES: Activity[] = ["Jogging", "Biking", "Sleeping", "Eating"];

// Single source of truth for the running Session's activity, set once when
// a Session starts.
let currentActivity: Activity | undefined;

// ===== Storage =====

// Opens a new appendable Session File for `activity` and writes its header
// line (the actual `<activity>,<started-epoch-ms>` values, not labels).
// The <track> suffix increments past any existing file for today's date,
// so a second Session on the same day never collides with the first.
function openSessionFile(activity: Activity, startedEpochMs: number): StorageFile {
  const date = new Date().toISOString().substr(0, 10).replace(/-/g, "");
  const existing = require("Storage").list(new RegExp("^hrsessions\\.log" + date));
  const track = existing.length.toString(36);
  const name = "hrsessions.log" + date + track + ".csv";
  const file = require("Storage").open(name, "w");
  file.write(activity + "," + startedEpochMs + "\n");
  return file;
}

// ===== Sampling =====

type HrSample = { t: number; bpm: number };

const HR_SAMPLE_INTERVAL_MS = 1000;
const HR_BUFFER_WINDOW_MS = 300000; // 300s

// Time-windowed ring buffer of captured samples, the sole source for the
// live instant reading (and, in Story 1.6, the 1-min/5-min rolling
// averages). Evicts by timestamp, not by a fixed slot count.
let hrRingBuffer: HrSample[] = [];

// Latest raw reading from the HRM hardware, updated on every 'HRM' event.
// Cheap store only - no buffer writes here, so a slow future consumer of
// the buffer can never delay sample processing.
let latestBpm: number | undefined;

let sampleIntervalId: IntervalId | undefined;

function onHrmSample(hrm: { bpm: number; confidence: number; raw: Uint8Array }): void {
  latestBpm = hrm.bpm;
}

// Runs on its own ~1s timer (not synchronously inside the HRM handler) and
// pushes the latest raw reading into the ring buffer, throttling the raw
// hardware event rate down to one sample per second.
function captureSample(): void {
  if (latestBpm === undefined) return;
  const now = Date.now();
  hrRingBuffer.push({ t: now, bpm: latestBpm });
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

// Powers on the HRM sensor and starts the ~1s capture timer. Resets the
// ring buffer so a new Session never sees stale samples from a previous
// one.
function startSampling(): void {
  hrRingBuffer = [];
  latestBpm = undefined;
  Bangle.setHRMPower(true, "hrsessions");
  sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
}

// Powers off the HRM sensor and clears the capture timer - HRM is never
// left running once a Session ends.
function stopSampling(): void {
  if (sampleIntervalId !== undefined) clearInterval(sampleIntervalId);
  sampleIntervalId = undefined;
  Bangle.setHRMPower(false, "hrsessions");
  latestBpm = undefined;
  hrRingBuffer = []; // don't let a stale reading answer getLatestHrSample() between sessions
}

// ===== UI =====

const STOP_ZONE_HEIGHT = 40;

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
// E.showMessage's title argument or a menu's "" key -- "Current session:"
// below is this screen's own content, not a title bar. Also draws a
// tappable "Stop session" zone at the bottom, whose height is compared
// against touch y-coordinates in onSessionScreenTouch.
function drawActiveSessionScreen(activity: Activity): void {
  const w = g.getWidth();
  const h = g.getHeight();
  g.clear(); // resets fg/bg to g.theme.fg/g.theme.bg

  // Label at scale 1: at scale 2 "Current session:" (17 chars) is ~204px,
  // wider than the 176px screen, so a centered draw clips its left edge.
  g.setFont("6x8", 1);
  g.setFontAlign(0, -1);
  g.drawString("Current session:", w / 2, 4);

  // Activity name dead-center on screen, independent of the label above it.
  g.setFont("6x8", 2);
  g.setFontAlign(0, 0);
  g.drawString(activity, w / 2, h / 2);

  // Stop zone: theme-inverted fill with theme-background-colored text, so
  // it stays legible in both light and dark themes.
  g.setColor(g.theme.fg);
  g.fillRect(0, h - STOP_ZONE_HEIGHT, w, h);
  g.setColor(g.theme.bg);
  g.drawString("Stop session", w / 2, h - STOP_ZONE_HEIGHT / 2);

  g.setColor(g.theme.fg);
  g.setFontAlign(-1, -1);
  g.setFont("6x8", 1);
}

function showActiveSessionScreen(activity: Activity): void {
  drawActiveSessionScreen(activity);
  Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
}

// ===== Top-level wiring =====

function onActivitySelected(activity: Activity): void {
  if (currentActivity !== undefined) return;
  const startedEpochMs = Math.round(Date.now());
  openSessionFile(activity, startedEpochMs);
  currentActivity = activity;
  startSampling();
  E.showMenu(); // remove the Activity menu
  showActiveSessionScreen(activity);
}

function onSessionScreenTouch(_button?: number, xy?: TouchCallbackXY): void {
  if (xy && xy.y >= g.getHeight() - STOP_ZONE_HEIGHT) {
    stopSession();
  }
}

// Resets in-memory Session state and returns to the Activity menu. No
// file-close call here - the Session File is left as-is (Story 1.5 owns the
// four-step stop sequence). Clear the custom UI/touch handler before
// switching screens so a stray touch can't retrigger this after the menu
// is shown.
function stopSession(): void {
  currentActivity = undefined;
  stopSampling();
  Bangle.setUI();
  showActivityMenu();
}

// Registered once at module load, not per-session - it's cheap and inert
// whenever the HRM is powered off, so there's no need to add/remove it per
// start/stop and no risk of listener accumulation across sessions.
Bangle.on("HRM", onHrmSample);

showActivityMenu();
