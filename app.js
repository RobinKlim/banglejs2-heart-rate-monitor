var ACTIVITIES = ["Jogging", "Biking", "Sleeping", "Eating"];
var currentActivity;
function openSessionFile(activity, startedEpochMs) {
    var date = new Date().toISOString().substr(0, 10).replace(/-/g, "");
    var prefix = "hrsessions.log" + date;
    var existing = require("Storage").list(new RegExp("^" + prefix));
    var maxTrack = -1;
    for (var i = 0; i < existing.length; i++) {
        var fname = existing[i];
        if (fname === undefined)
            continue;
        var trackVal = parseInt(fname.charAt(prefix.length), 36);
        if (!isNaN(trackVal) && trackVal > maxTrack)
            maxTrack = trackVal;
    }
    var track = (maxTrack + 1).toString(36);
    var name = prefix + track + ".csv";
    var file = require("Storage").open(name, "w");
    file.write(activity + "," + startedEpochMs + "\n");
    console.log("hrsessions: opened " + name + " (" + activity + ")");
    return file;
}
var HR_SAMPLE_INTERVAL_MS = 1000;
var HR_BUFFER_WINDOW_MS = 300000;
var HR_FLUSH_INTERVAL_MS = 10000;
var HR_ROTATION_THRESHOLD_BYTES = 125000;
var hrRingBuffer = [];
var hrWriteQueue = [];
var latestBpm;
var sampleIntervalId;
var flushIntervalId;
var currentFile;
var sessionFileNames = [];
var sessionActivity;
var sessionStartedEpochMs;
var currentFileSize = 0;
function onHrmSample(hrm) {
    latestBpm = Math.round(hrm.bpm);
}
function captureSample() {
    if (latestBpm === undefined)
        return;
    var now = Math.round(Date.now());
    var sample = { t: now, bpm: latestBpm };
    hrRingBuffer.push(sample);
    hrWriteQueue.push(sample);
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
function rotateSessionFile() {
    if (sessionActivity === undefined || sessionStartedEpochMs === undefined)
        return;
    currentFile = openSessionFile(sessionActivity, sessionStartedEpochMs);
    currentFileSize = currentFile.getLength();
    var name = currentFile.name;
    sessionFileNames.push(name);
    console.log("hrsessions: rotated to " + name);
}
function flushSamples() {
    if (currentFile === undefined || hrWriteQueue.length === 0)
        return;
    var text = "";
    for (var i = 0; i < hrWriteQueue.length; i++) {
        var s = hrWriteQueue[i];
        if (s === undefined)
            continue;
        text += s.t + "," + s.bpm + "\n";
    }
    if (currentFileSize + text.length > HR_ROTATION_THRESHOLD_BYTES) {
        rotateSessionFile();
    }
    currentFile.write(text);
    currentFileSize += text.length;
    console.log("hrsessions: flushed " + hrWriteQueue.length + " samples");
    hrWriteQueue = [];
}
function startSampling(activity, startedEpochMs) {
    hrRingBuffer = [];
    hrWriteQueue = [];
    latestBpm = undefined;
    sessionActivity = activity;
    sessionStartedEpochMs = startedEpochMs;
    currentFile = openSessionFile(activity, startedEpochMs);
    currentFileSize = currentFile.getLength();
    sessionFileNames = [currentFile.name];
    Bangle.setHRMPower(true, "hrsessions");
    sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
    flushIntervalId = setInterval(flushSamples, HR_FLUSH_INTERVAL_MS);
}
function logSessionFile() {
    for (var i = 0; i < sessionFileNames.length; i++) {
        var name = sessionFileNames[i];
        if (name === undefined)
            continue;
        console.log("hrsessions: --- " + name + " ---");
        var readFile = require("Storage").open(name, "r");
        var line = void 0;
        while ((line = readFile.readLine()) !== undefined) {
            console.log(line);
        }
        console.log("hrsessions: --- end " + name + " ---");
    }
}
function stopSampling() {
    Bangle.setHRMPower(false, "hrsessions");
    if (sampleIntervalId !== undefined)
        clearInterval(sampleIntervalId);
    if (flushIntervalId !== undefined)
        clearInterval(flushIntervalId);
    sampleIntervalId = undefined;
    flushIntervalId = undefined;
    flushSamples();
    logSessionFile();
    currentFile = undefined;
    latestBpm = undefined;
    hrRingBuffer = [];
    hrWriteQueue = [];
    sessionActivity = undefined;
    sessionStartedEpochMs = undefined;
    currentFileSize = 0;
    sessionFileNames = [];
    console.log("hrsessions: stopped");
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
    if (currentActivity !== undefined) {
        console.log("hrsessions: ignored " + activity + " tap - already active: " + currentActivity);
        return;
    }
    var startedEpochMs = Math.round(Date.now());
    startSampling(activity, startedEpochMs);
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
    stopSampling();
    stopInstantReadingRedraw();
    Bangle.setUI();
    showActivityMenu();
}
Bangle.on("HRM", onHrmSample);
showActivityMenu();
