// hrsessions - heart-rate session tracker for Bangle.js 2
//
// Single compiled source file, organized into four sections plus top-level
// wiring (see the architecture spine / epic context for the full design):
//   State    - session data, leaf module, calls nothing else
//   Storage  - Session File persistence, leaf module, calls nothing else
//   Sampling - HRM sampling (not yet implemented - Story 1.4/1.6)
//   UI       - screen drawing, calls State/Sampling, never Storage
//
// This story (1.1) implements enough of State/Storage/UI for: app launch
// shows the Activity menu, selecting an Activity opens a new Session File
// and writes its header line, then shows a minimal confirmation screen.
// Stopping/finalizing a Session is out of scope here (Story 1.2).

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

function showActivityMenu(): void {
  const menu: Menu = {};
  ACTIVITIES.forEach((activity) => {
    menu[activity] = () => {
      onActivitySelected(activity);
    };
  });
  E.showMenu(menu);
}

function showSessionStartedScreen(activity: Activity): void {
  E.showMessage(activity + "\nSession started", "hrsessions");
}

// ===== Top-level wiring =====

function onActivitySelected(activity: Activity): void {
  const startedEpochMs = Math.round(Date.now());
  openSessionFile(activity, startedEpochMs);
  currentActivity = activity;
  E.showMenu(); // remove the Activity menu
  showSessionStartedScreen(activity);
}

showActivityMenu();
