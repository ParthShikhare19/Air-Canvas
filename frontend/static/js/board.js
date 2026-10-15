/* The drawing model. Strokes are stored as vectors, not pixels:
 *     { id, color, size, points: [[x, y, t], ...], straight, shape }
 * (x, y in canvas units, t = milliseconds since the stroke began)
 *
 * Keeping vectors is what makes undo / redo, "erase a whole stroke", replay
 * and SVG export possible. This file has no DOM code except drawStroke(),
 * which only needs a canvas 2D context.
 */
(function (root) {
  "use strict";

  function distToSegment(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function strokeLength(s) {
    let total = 0;
    for (let i = 1; i < s.points.length; i++) {
      total += Math.hypot(s.points[i][0] - s.points[i - 1][0], s.points[i][1] - s.points[i - 1][1]);
    }
    return total;
  }

  /** Paint one stroke. Freehand strokes are smoothed with quadratic curves
   *  through the mid-points; snapped shapes keep their sharp corners. */
  function drawStroke(ctx, s, glow) {
    const p = s.points;
    ctx.save();
    ctx.lineCap = "round";
    ctx.lineJoin = "round";
    ctx.strokeStyle = s.color;
    ctx.fillStyle = s.color;
    ctx.lineWidth = s.size;
    if (glow) { ctx.shadowColor = s.color; ctx.shadowBlur = s.size * 1.4 + 8; }
    if (p.length === 1) {
      ctx.beginPath();
      ctx.arc(p[0][0], p[0][1], s.size / 2, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      ctx.moveTo(p[0][0], p[0][1]);
      if (s.straight || p.length === 2) {
        for (let i = 1; i < p.length; i++) ctx.lineTo(p[i][0], p[i][1]);
      } else {
        for (let i = 1; i < p.length - 1; i++) {
          const mx = (p[i][0] + p[i + 1][0]) / 2, my = (p[i][1] + p[i + 1][1]) / 2;
          ctx.quadraticCurveTo(p[i][0], p[i][1], mx, my);
        }
        ctx.lineTo(p[p.length - 1][0], p[p.length - 1][1]);
      }
      ctx.stroke();
    }
    ctx.restore();
  }

  function createBoard(width, height) {
    const b = {
      width, height,
      strokes: [],
      current: null,           // the stroke being drawn right now
      undoStack: [],           // each entry = list of strokes before a change
      redoStack: [],
      nextId: 1,
      _erase: null,
    };

    const snapshot = () => b.strokes.slice();
    function remember() {
      b.undoStack.push(snapshot());
      if (b.undoStack.length > 60) b.undoStack.shift();
      b.redoStack.length = 0;
    }

    b.setSize = function (w, h) {
      const sx = w / b.width, sy = h / b.height;
      const all = b.current ? b.strokes.concat([b.current]) : b.strokes;
      const seen = new Set();
      [...all, ...b.undoStack.flat(), ...b.redoStack.flat()].forEach((s) => {
        if (seen.has(s)) return;
        seen.add(s);
        s.points.forEach((p) => { p[0] *= sx; p[1] *= sy; });
      });
      b.width = w; b.height = h;
    };

    b.begin = function (color, size, x, y, t) {
      b.current = { id: b.nextId++, color, size, points: [[x, y, t || 0]], straight: false, shape: null };
    };

    b.add = function (x, y, t) {
      const c = b.current;
      if (!c) return false;
      const last = c.points[c.points.length - 1];
      if (Math.hypot(x - last[0], y - last[1]) < 2) return false;   // ignore sub-pixel jitter
      c.points.push([x, y, t || 0]);
      return true;
    };

    /** Finish the current stroke. Returns it, or null if it was too short. */
    b.end = function (minPoints) {
      const c = b.current;
      b.current = null;
      if (!c || c.points.length < (minPoints || 1)) return null;
      remember();
      b.strokes.push(c);
      return c;
    };

    /** Remove every stroke that touches the circle (x, y, r). Several calls while the
     *  pinch is held are merged into one undo step by commitErase(). */
    b.eraseAt = function (x, y, r) {
      if (!b._erase) b._erase = { before: snapshot(), removed: 0 };
      const keep = [];
      let removed = 0;
      b.strokes.forEach((s) => {
        const reach = r + s.size / 2;
        let hit = false;
        if (s.points.length === 1) {
          hit = Math.hypot(s.points[0][0] - x, s.points[0][1] - y) <= reach;
        } else {
          for (let i = 1; i < s.points.length && !hit; i++) {
            hit = distToSegment(x, y, s.points[i - 1][0], s.points[i - 1][1],
                                s.points[i][0], s.points[i][1]) <= reach;
          }
        }
        if (hit) removed++; else keep.push(s);
      });
      if (removed) { b.strokes = keep; b._erase.removed += removed; }
      return removed;
    };

    b.commitErase = function () {
      const e = b._erase;
      b._erase = null;
      if (e && e.removed > 0) { b.undoStack.push(e.before); b.redoStack.length = 0; }
    };

    b.undo = function () {
      if (!b.undoStack.length) return false;
      b.redoStack.push(snapshot());
      b.strokes = b.undoStack.pop();
      return true;
    };

    b.redo = function () {
      if (!b.redoStack.length) return false;
      b.undoStack.push(snapshot());
      b.strokes = b.redoStack.pop();
      return true;
    };

    b.clear = function () {
      if (!b.strokes.length) return false;
      remember();
      b.strokes = [];
      return true;
    };

    /** Replace the drawing with saved strokes (scaled to the current canvas size). */
    b.load = function (strokes, srcW, srcH) {
      remember();
      const sx = b.width / (srcW || b.width), sy = b.height / (srcH || b.height);
      b.strokes = strokes.map((s) => ({
        id: b.nextId++, color: s.color, size: s.size,
        points: s.points.map((p) => [p[0] * sx, p[1] * sy, p[2] || 0]),
        straight: !!s.straight, shape: s.shape || null,
      }));
    };

    b.render = function (ctx, glow) {
      b.strokes.forEach((s) => drawStroke(ctx, s, glow));
      if (b.current) drawStroke(ctx, b.current, glow);
    };

    return b;
  }

  /* ---- replay: play the drawing back stroke by stroke ---- */
  function buildTimeline(strokes, gap, maxStroke) {
    gap = gap === undefined ? 250 : gap;
    maxStroke = maxStroke || 2500;
    let cursor = 0;
    const entries = strokes.map((s) => {
      const last = s.points[s.points.length - 1][2] || 0;
      const dur = Math.max(150, Math.min(last || 600, maxStroke));
      const entry = { stroke: s, start: cursor, dur, scale: last > 0 ? dur / last : 0 };
      cursor += dur + gap;
      return entry;
    });
    return { entries, total: Math.max(0, cursor - gap) };
  }

  /** Which strokes (and how much of the one being drawn) exist at `elapsed` ms. */
  function strokesAt(timeline, elapsed) {
    const out = [];
    for (const e of timeline.entries) {
      if (elapsed < e.start) break;
      const local = elapsed - e.start;
      if (local >= e.dur) { out.push(e.stroke); continue; }
      const pts = e.stroke.points;
      let part;
      if (e.scale > 0) part = pts.filter((p) => (p[2] || 0) * e.scale <= local);
      else part = pts.slice(0, Math.max(1, Math.ceil(pts.length * local / e.dur)));
      if (!part.length) part = [pts[0]];
      out.push(Object.assign({}, e.stroke, { points: part }));
    }
    return out;
  }

  const api = { createBoard, drawStroke, buildTimeline, strokesAt, strokeLength, distToSegment };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Board = api;
})(typeof window !== "undefined" ? window : globalThis);
