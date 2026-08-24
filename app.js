var ACTIVITIES = ["Jogging", "Biking", "Sleeping", "Eating"];
var currentActivity;
function openSessionFile(activity, startedEpochMs) {
    var date = new Date().toISOString().substr(0, 10).replace(/-/g, "");
    var existing = require("Storage").list(new RegExp("^hrsessions\\.log" + date));
    var track = existing.length.toString(36);
    var name = "hrsessions.log" + date + track + ".csv";
    var file = require("Storage").open(name, "w");
    file.write(activity + "," + startedEpochMs + "\n");
    return file;
}
var STOP_ZONE_HEIGHT = 40;
function showActivityMenu() {
    var menu = {};
    ACTIVITIES.forEach(function (activity) {
        menu[activity] = function () {
            onActivitySelected(activity);
        };
    });
    E.showMenu(menu);
}
function drawActiveSessionScreen(activity) {
    var w = g.getWidth();
    var h = g.getHeight();
    g.clear();
    g.setFont("6x8", 1);
    g.setFontAlign(0, -1);
    g.drawString("Current session:", w / 2, 4);
    g.setFont("6x8", 2);
    g.setFontAlign(0, 0);
    g.drawString(activity, w / 2, h / 2);
    g.setColor(g.theme.fg);
    g.fillRect(0, h - STOP_ZONE_HEIGHT, w, h);
    g.setColor(g.theme.bg);
    g.drawString("Stop session", w / 2, h - STOP_ZONE_HEIGHT / 2);
    g.setColor(g.theme.fg);
    g.setFontAlign(-1, -1);
    g.setFont("6x8", 1);
}
function showActiveSessionScreen(activity) {
    drawActiveSessionScreen(activity);
    Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
}
function onActivitySelected(activity) {
    if (currentActivity !== undefined)
        return;
    var startedEpochMs = Math.round(Date.now());
    openSessionFile(activity, startedEpochMs);
    currentActivity = activity;
    E.showMenu();
    showActiveSessionScreen(activity);
}
function onSessionScreenTouch(_button, xy) {
    if (xy && xy.y >= g.getHeight() - STOP_ZONE_HEIGHT) {
        stopSession();
    }
}
function stopSession() {
    currentActivity = undefined;
    Bangle.setUI();
    showActivityMenu();
}
showActivityMenu();
