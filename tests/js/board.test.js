// Optional: run with  node tests/js/board.test.js   (needs Node.js, no packages)
const path = require("path"); process.chdir(__dirname);
const assert = require("assert");
const Board = require(path.join(__dirname, "../../frontend/static/js/board.js"));
const createOneEuro = require(path.join(__dirname, "../../frontend/static/js/filters.js"));

const b = Board.createBoard(1280, 720);
function draw(pts, color) { b.begin(color || "#ff0000", 8, pts[0][0], pts[0][1], 0); pts.slice(1).forEach((p, i) => b.add(p[0], p[1], (i + 1) * 20)); return b.end(2); }

draw([[100,100],[200,100],[300,100]]);
draw([[100,300],[200,300],[300,300]], "#00ff00");
assert.equal(b.strokes.length, 2, "two strokes");

// erase touches only the first
assert.equal(b.eraseAt(200, 105, 20), 1); b.commitErase();
assert.equal(b.strokes.length, 1);
assert.equal(b.strokes[0].color, "#00ff00");
// erase merged into ONE undo step, even across several calls
b.eraseAt(200, 300, 20); b.eraseAt(210, 300, 20); b.commitErase();
assert.equal(b.strokes.length, 0);
assert.ok(b.undo()); assert.equal(b.strokes.length, 1, "undo restores erased stroke");
assert.ok(b.undo()); assert.equal(b.strokes.length, 2, "undo restores first erase");
assert.ok(b.redo()); assert.equal(b.strokes.length, 1, "redo works");
b.undo(); b.undo(); b.undo();
assert.equal(b.strokes.length, 0, "back to the start");
assert.ok(!b.undo(), "nothing left to undo");

// segments between sparse points are hit too
draw([[0,500],[1000,500]]);
assert.equal(b.eraseAt(500, 505, 10), 1, "erase hits a long segment between two points");
b.commitErase(); b.undo();

// clear + undo
assert.ok(b.clear()); assert.equal(b.strokes.length, 0); b.undo(); assert.equal(b.strokes.length, 1);

// too-short gesture strokes are dropped, a mouse dot (min 1) is kept
b.begin("#fff", 8, 5, 5, 0); assert.equal(b.end(4), null);
b.begin("#fff", 8, 5, 5, 0); assert.ok(b.end(1));

// tiny jitter ignored
b.begin("#fff", 8, 10, 10, 0); assert.equal(b.add(10.5, 10.5, 5), false); b.end(1);

// resize scales strokes (including those only in undo history)
const c = Board.createBoard(1000, 500);
c.begin("#fff", 8, 100, 100, 0); c.add(200, 200, 10); c.end(2);
c.setSize(2000, 1000); assert.deepEqual(c.strokes[0].points[0].slice(0,2), [200, 200]);

// load scales saved strokes
const d = Board.createBoard(1280, 960);
d.load([{ color: "#abcdef", size: 5, points: [[640, 360, 0], [1280, 720, 100]] }], 1280, 720);
assert.deepEqual(d.strokes[0].points[1].slice(0,2), [1280, 960]);

// replay timeline
const strokes = [
  { color: "#fff", size: 5, points: [[0,0,0],[10,10,500],[20,20,1000]] },
  { color: "#fff", size: 5, points: [[0,0,0],[5,5,100]] },
];
const tl = Board.buildTimeline(strokes, 250, 2500);
assert.equal(tl.entries.length, 2);
assert.equal(Board.strokesAt(tl, 0).length, 1);
assert.equal(Board.strokesAt(tl, 500)[0].points.length, 2, "partial stroke at 500ms");
assert.equal(Board.strokesAt(tl, tl.total).length, 2, "everything shown at the end");
// strokes without timing still replay progressively
const flat = Board.buildTimeline([{ color: "#fff", size: 5, points: [[0,0,0],[1,1,0],[2,2,0],[3,3,0]] }]);
assert.ok(Board.strokesAt(flat, flat.entries[0].dur / 2)[0].points.length < 4);

// One Euro filter: noise on a still hand is reduced a lot, a fast move is still followed
const f = createOneEuro(2.0, 0.015, 1.0);
let seed = 1; const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5;
let rawDev = 0, filtDev = 0, n = 0;
for (let i = 0; i < 200; i++) {
  const raw = 500 + rnd() * 8, out = f.filter(raw, i * 33);
  if (i > 20) { rawDev += Math.abs(raw - 500); filtDev += Math.abs(out - 500); n++; }
}
console.log("jitter on a still hand:  raw", (rawDev/n).toFixed(2), "px  ->  filtered", (filtDev/n).toFixed(2), "px");
assert.ok(filtDev < rawDev * 0.5, "filter removes most of the jitter");
const g = createOneEuro(2.0, 0.015, 1.0);
let last = 0; for (let i = 0; i < 30; i++) last = g.filter(i * 40, i * 33);   // 1200 px/s sweep
console.log("lag while moving fast:   ", (29 * 40 - last).toFixed(1), "px behind the finger");
assert.ok(29 * 40 - last < 60, "fast movement is not laggy");

console.log("board + filter tests passed");
