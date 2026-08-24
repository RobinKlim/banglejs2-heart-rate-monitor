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
function showActivityMenu() {
    var menu = {};
    ACTIVITIES.forEach(function (activity) {
        menu[activity] = function () {
            onActivitySelected(activity);
        };
    });
    E.showMenu(menu);
}
function showSessionStartedScreen(activity) {
    E.showMessage(activity + "\nSession started", "hrsessions");
}
function onActivitySelected(activity) {
    var startedEpochMs = Math.round(Date.now());
    openSessionFile(activity, startedEpochMs);
    currentActivity = activity;
    E.showMenu();
    showSessionStartedScreen(activity);
}
showActivityMenu();
