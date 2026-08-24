// hrsessions - heart-rate session tracker for Bangle.js 2
//
// Single compiled source file, organized into four sections plus top-level
// wiring (see the architecture spine / epic context for the full design):
//   State    - session data, leaf module, calls nothing else
//   Storage  - Session File persistence, leaf module, calls nothing else
//   Sampling - HRM sampling (not yet implemented - Story 1.4/1.6)
//   UI       - screen drawing, calls State/Sampling, never Storage
//
// Story 1.1 implements enough of State/Storage/UI for: app launch shows the
// Activity menu, selecting an Activity opens a new Session File and writes
// its header line. Story 1.2 adds the active-session screen (hand-drawn,
// no title/header) and its touch-driven "Stop session" zone, which resets
// in-memory Session state and returns to the Activity menu. The Session
// File itself is not touched on stop yet - the four-step stop sequence
// (unsubscribe HRM, stop flush timer, flush queue, close file) is Story 1.5.

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
}

function showActiveSessionScreen(activity: Activity): void {
  drawActiveSessionScreen(activity);
  Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
}

// ===== Top-level wiring =====

function onActivitySelected(activity: Activity): void {
  const startedEpochMs = Math.round(Date.now());
  openSessionFile(activity, startedEpochMs);
  currentActivity = activity;
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
  Bangle.setUI();
  showActivityMenu();
}

showActivityMenu();
