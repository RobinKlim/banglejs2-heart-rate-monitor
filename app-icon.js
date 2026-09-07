// hrsessions launcher icon — single source of truth for the pixel art.
//
// This file is NOT part of the app.ts/app.js build. It is meant to be
// pasted, as-is, into the Espruino Web IDE's left-hand REPL while
// connected to the watch. The paste writes "hrsessions.img" to Storage
// itself as its last step and prints a length sanity check — there is
// nothing to copy out of the console by hand.
//
// See README.md's "Installing permanently" section for the full steps.
//
// A funny-but-related icon: a heart silhouette, worn out from tracking all
// those workouts — dizzy "X X" eyes and an open, panting mouth.
//
// 16x16 source grid (. = off, # = on). Scaled 3x nearest-neighbor to 48x48
// below rather than hand-authored at 48x48, so the design stays auditable
// from this grid alone. Rows 5-7 punch the two dizzy eyes into the heart's
// shoulders; rows 9-10 punch the open, panting mouth.
var ICON_GRID_16 = [
    "..##........##..",
    ".####......####.",
    "######....######",
    "#######..#######",
    "################",
    "###.#.####.#.###",
    "####.#####.#####",
    ".##.#.####.#.##.",
    ".##############.",
    "..####....####..",
    "..#####..#####..",
    "...##########...",
    "....########....",
    ".....######.....",
    "......####......",
    ".......##.......",
];

// Scale each source pixel into a 3x3 block, nearest-neighbor, so 16x16
// becomes 48x48.
function scale3x(grid) {
    var out = [];
    for (var y = 0; y < grid.length; y++) {
        var row = grid[y];
        var scaledRow = "";
        for (var x = 0; x < row.length; x++) {
            var c = row.charAt(x);
            scaledRow += c + c + c;
        }
        out.push(scaledRow);
        out.push(scaledRow);
        out.push(scaledRow);
    }
    return out;
}

var ICON_GRID_48 = scale3x(ICON_GRID_16).join("\n");

// Graphics.createImage() turns the ascii-art string into a simple 1bpp
// image object ("." /space = 0, anything else = 1). Drawing that onto an
// offscreen 48x48 1bpp buffer and exporting the buffer with .asImage("string")
// produces a self-contained image string (header + packed pixel bytes) —
// this is the same "string" image format Bangle.getLogo() returns, and it's
// exactly what the on-watch launcher (apps/launch) reads raw out of
// Storage and passes straight to g.drawImage(). That's why it — and not
// the plain Graphics.createImage() result — is what gets written to the
// "hrsessions.img" Storage file.
var iconOffscreen = Graphics.createArrayBuffer(48, 48, 1, { msb: true });
iconOffscreen.drawImage(Graphics.createImage(ICON_GRID_48), 0, 0);

// Write straight to Storage here rather than just returning the string —
// the Web IDE's REPL doesn't reliably surface a reusable "$N" reference
// for a pasted multi-statement block's final value, so there is nothing
// safe to copy out of the console by hand. Writing directly means pasting
// this whole file is the entire step.
require("Storage").write("hrsessions.img", iconOffscreen.asImage("string"));
require("Storage").read("hrsessions.img").length; // sanity check: should print a plausible positive byte count, not undefined
