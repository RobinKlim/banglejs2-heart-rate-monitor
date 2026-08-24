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
var HR_SAMPLE_INTERVAL_MS = 1000;
var HR_BUFFER_WINDOW_MS = 300000;
var hrRingBuffer = [];
var latestBpm;
var sampleIntervalId;
function onHrmSample(hrm) {
    latestBpm = hrm.bpm;
}
function captureSample() {
    if (latestBpm === undefined)
        return;
    var now = Date.now();
    hrRingBuffer.push({ t: now, bpm: latestBpm });
    var cutoff = now - HR_BUFFER_WINDOW_MS;
    while (hrRingBuffer.length > 0) {
        var oldest = hrRingBuffer[0];
        if (oldest === undefined || oldest.t >= cutoff)
            break;
        hrRingBuffer.shift();
    }
}
function getLatestHrSample() {
    return hrRingBuffer[hrRingBuffer.length - 1];
}
function startSampling() {
    hrRingBuffer = [];
    latestBpm = undefined;
    Bangle.setHRMPower(true, "hrsessions");
    sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
}
function stopSampling() {
    if (sampleIntervalId !== undefined)
        clearInterval(sampleIntervalId);
    sampleIntervalId = undefined;
    Bangle.setHRMPower(false, "hrsessions");
    latestBpm = undefined;
    hrRingBuffer = [];
}
var STOP_ZONE_HEIGHT = 40;
var redrawIntervalId;
function drawInstantReading() {
    var w = g.getWidth();
    var y = g.getHeight() / 2 + 28;
    var latest = getLatestHrSample();
    var bpm = latest === undefined ? undefined : Math.round(latest.bpm);
    var text = bpm === undefined || !isFinite(bpm) ? "-- bpm" : bpm + " bpm";
    g.setColor(g.theme.bg);
    g.fillRect(0, y - 8, w, y + 8);
    g.setColor(g.theme.fg);
    g.setFont("6x8", 1);
    g.setFontAlign(0, 0);
    g.drawString(text, w / 2, y);
    g.setFontAlign(-1, -1);
}
function startInstantReadingRedraw() {
    redrawIntervalId = setInterval(drawInstantReading, 1000);
}
function stopInstantReadingRedraw() {
    if (redrawIntervalId !== undefined)
        clearInterval(redrawIntervalId);
    redrawIntervalId = undefined;
}
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
    drawInstantReading();
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
function showActiveSessionScreen(activity) {
    drawActiveSessionScreen(activity);
    Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
    startInstantReadingRedraw();
}
function onActivitySelected(activity) {
    if (currentActivity !== undefined)
        return;
    var startedEpochMs = Math.round(Date.now());
    openSessionFile(activity, startedEpochMs);
    currentActivity = activity;
    startSampling();
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
    stopSampling();
    stopInstantReadingRedraw();
    Bangle.setUI();
    showActivityMenu();
}
Bangle.on("HRM", onHrmSample);
showActivityMenu();
