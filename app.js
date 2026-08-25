var ACTIVITIES = ["Jogging", "Biking", "Sleeping", "Eating", "Walking", "Swimming"];
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
var HR_BUFFER_WINDOW_MS = 600000;
var HR_AVG_1MIN_WINDOW_MS = 60000;
var HR_AVG_10MIN_WINDOW_MS = HR_BUFFER_WINDOW_MS;
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
    if (currentFile !== undefined)
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
function computeRollingAverage(windowMs) {
    var cutoff = Date.now() - windowMs;
    var sum = 0;
    var count = 0;
    for (var i = 0; i < hrRingBuffer.length; i++) {
        var s = hrRingBuffer[i];
        if (s === undefined || s.t < cutoff || s.bpm <= 0)
            continue;
        sum += s.bpm;
        count++;
    }
    return count === 0 ? undefined : sum / count;
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
function startLiveMonitoring() {
    Bangle.setHRMPower(true, "hrsessions");
    sampleIntervalId = setInterval(captureSample, HR_SAMPLE_INTERVAL_MS);
}
function stopLiveMonitoring() {
    Bangle.setHRMPower(false, "hrsessions");
    if (sampleIntervalId !== undefined)
        clearInterval(sampleIntervalId);
    sampleIntervalId = undefined;
    latestBpm = undefined;
    hrRingBuffer = [];
}
function startPersistence(activity, startedEpochMs) {
    hrWriteQueue = [];
    sessionActivity = activity;
    sessionStartedEpochMs = startedEpochMs;
    currentFile = openSessionFile(activity, startedEpochMs);
    currentFileSize = currentFile.getLength();
    sessionFileNames = [currentFile.name];
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
function stopPersistence() {
    if (flushIntervalId !== undefined)
        clearInterval(flushIntervalId);
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
var BUTTON_ZONE_HEIGHT = 40;
var TRACKED_CONFIRMATION_DISMISS_MS = 2500;
var ACTIVITY_Y = 4;
var ACTIVITY_BAND_HEIGHT = 24;
var NOW_Y = 44;
var AVG_1MIN_Y = 72;
var AVG_10MIN_Y = 100;
var ACTIVE_SCREEN_ROW_Y_OFFSET = 8;
var ROW_CLEAR_MARGIN = 10;
var ROW_FONT_SCALE = 2;
var COLOR_GREEN = "#00a000";
var COLOR_RED = "#c00000";
var COLOR_WHITE = "#ffffff";
var COLOR_BLACK = "#000000";
function formatBpmLine(label, value) {
    if (value === undefined || !isFinite(value))
        return label + ": -- bpm";
    return label + ": " + Math.round(value) + " bpm";
}
var redrawIntervalId;
function drawInstantReading(yOffset) {
    if (yOffset === void 0) { yOffset = 0; }
    var w = g.getWidth();
    var y = NOW_Y + yOffset;
    var latest = getLatestHrSample();
    var bpm = latest === undefined ? undefined : Math.round(latest.bpm);
    g.setColor(g.theme.bg);
    g.fillRect(0, y - ROW_CLEAR_MARGIN, w, y + ROW_CLEAR_MARGIN);
    g.setColor(g.theme.fg);
    g.setFont("6x8", ROW_FONT_SCALE);
    g.setFontAlign(0, 0);
    g.drawString(formatBpmLine("Now", bpm), w / 2, y);
    g.setFontAlign(-1, -1);
}
function drawRollingAverages(yOffset) {
    if (yOffset === void 0) { yOffset = 0; }
    var w = g.getWidth();
    var avg1 = computeRollingAverage(HR_AVG_1MIN_WINDOW_MS);
    var avg10 = computeRollingAverage(HR_AVG_10MIN_WINDOW_MS);
    var y1 = AVG_1MIN_Y + yOffset;
    var y10 = AVG_10MIN_Y + yOffset;
    g.setColor(g.theme.bg);
    g.fillRect(0, y1 - ROW_CLEAR_MARGIN, w, y1 + ROW_CLEAR_MARGIN);
    g.fillRect(0, y10 - ROW_CLEAR_MARGIN, w, y10 + ROW_CLEAR_MARGIN);
    g.setColor(g.theme.fg);
    g.setFont("6x8", ROW_FONT_SCALE);
    g.setFontAlign(0, 0);
    g.drawString(formatBpmLine("1m", avg1), w / 2, y1);
    g.drawString(formatBpmLine("10m", avg10), w / 2, y10);
    g.setFontAlign(-1, -1);
}
function redrawLiveReadings() {
    var yOffset = currentActivity !== undefined ? ACTIVE_SCREEN_ROW_Y_OFFSET : 0;
    drawInstantReading(yOffset);
    drawRollingAverages(yOffset);
}
function startLiveReadingsRedraw() {
    redrawIntervalId = setInterval(redrawLiveReadings, 1000);
}
function stopLiveReadingsRedraw() {
    if (redrawIntervalId !== undefined)
        clearInterval(redrawIntervalId);
    redrawIntervalId = undefined;
}
function drawHomeScreen() {
    var w = g.getWidth();
    var h = g.getHeight();
    g.clear();
    drawInstantReading();
    drawRollingAverages();
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
function onHomeScreenTouch(_button, xy) {
    if (xy && xy.y >= g.getHeight() - BUTTON_ZONE_HEIGHT) {
        showActivityPicker();
    }
}
function showHomeScreen() {
    drawHomeScreen();
    Bangle.setUI({ mode: "custom", touch: onHomeScreenTouch });
}
var PICKER_VISIBLE_ROWS = 4;
var pickerScrollOffset = 0;
function drawActivityPicker() {
    var w = g.getWidth();
    var h = g.getHeight();
    var rowH = h / PICKER_VISIBLE_ROWS;
    g.clear();
    g.setColor(g.theme.fg);
    g.setFont("6x8", 2);
    g.setFontAlign(0, 0);
    ACTIVITIES.forEach(function (activity, i) {
        var y = i * rowH - pickerScrollOffset;
        if (y + rowH < 0 || y > h)
            return;
        if (i > 0)
            g.drawLine(0, y, w, y);
        g.drawString(activity, w / 2, y + rowH / 2);
    });
    var contentH = ACTIVITIES.length * rowH;
    var maxScroll = Math.max(0, contentH - h);
    if (maxScroll > 0) {
        var thumbH = Math.max(16, (h / contentH) * h);
        var thumbY = (pickerScrollOffset / maxScroll) * (h - thumbH);
        g.setColor(g.theme.fg);
        g.fillRect(w - 4, thumbY, w - 1, thumbY + thumbH);
    }
    g.setFontAlign(-1, -1);
}
function onActivityPickerTouch(_button, xy) {
    if (!xy)
        return;
    var rowH = g.getHeight() / PICKER_VISIBLE_ROWS;
    var activity = ACTIVITIES[Math.floor((xy.y + pickerScrollOffset) / rowH)];
    if (activity !== undefined)
        onActivitySelected(activity);
}
function onActivityPickerDrag(event) {
    var h = g.getHeight();
    var rowH = h / PICKER_VISIBLE_ROWS;
    var contentH = ACTIVITIES.length * rowH;
    var maxScroll = Math.max(0, contentH - h);
    pickerScrollOffset = Math.min(maxScroll, Math.max(0, pickerScrollOffset - event.dy));
    drawActivityPicker();
}
function onActivityPickerSwipe(directionLR) {
    if (directionLR === 0)
        return;
    startLiveReadingsRedraw();
    showHomeScreen();
}
function showActivityPicker() {
    stopLiveReadingsRedraw();
    pickerScrollOffset = 0;
    drawActivityPicker();
    Bangle.setUI({
        mode: "custom",
        touch: onActivityPickerTouch,
        swipe: onActivityPickerSwipe,
        drag: onActivityPickerDrag,
    });
}
function drawActivityHeader(activity) {
    var w = g.getWidth();
    g.setColor(COLOR_WHITE);
    g.fillRect(0, 0, w - 1, ACTIVITY_BAND_HEIGHT - 1);
    g.setColor(COLOR_BLACK);
    g.setFont("6x8", 2);
    g.setFontAlign(0, -1);
    g.drawString(activity, w / 2, ACTIVITY_Y);
}
function drawActiveSessionScreen(activity) {
    var w = g.getWidth();
    var h = g.getHeight();
    g.clear();
    drawActivityHeader(activity);
    drawInstantReading(ACTIVE_SCREEN_ROW_Y_OFFSET);
    drawRollingAverages(ACTIVE_SCREEN_ROW_Y_OFFSET);
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
function showActiveSessionScreen(activity) {
    drawActiveSessionScreen(activity);
    Bangle.setUI({ mode: "custom", touch: onSessionScreenTouch });
}
function drawTrackedConfirmationScreen(activity) {
    var w = g.getWidth();
    g.clear();
    drawActivityHeader(activity);
    var cx = w / 2, cy = 90;
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
function showTrackedConfirmationScreen(activity) {
    stopLiveReadingsRedraw();
    drawTrackedConfirmationScreen(activity);
    Bangle.setUI({ mode: "custom" });
    setTimeout(function () {
        startLiveReadingsRedraw();
        showHomeScreen();
    }, TRACKED_CONFIRMATION_DISMISS_MS);
}
function onActivitySelected(activity) {
    if (currentActivity !== undefined) {
        console.log("hrsessions: ignored " + activity + " tap - already active: " + currentActivity);
        return;
    }
    startLiveReadingsRedraw();
    var startedEpochMs = Math.round(Date.now());
    startPersistence(activity, startedEpochMs);
    currentActivity = activity;
    showActiveSessionScreen(activity);
}
function onSessionScreenTouch(_button, xy) {
    if (xy && xy.y >= g.getHeight() - BUTTON_ZONE_HEIGHT) {
        stopSession();
    }
}
function stopSession() {
    var stoppedActivity = currentActivity;
    currentActivity = undefined;
    stopPersistence();
    showTrackedConfirmationScreen(stoppedActivity);
}
Bangle.on("HRM", onHrmSample);
startLiveMonitoring();
startLiveReadingsRedraw();
showHomeScreen();
