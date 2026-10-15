/* Air Canvas: browser side.
 *
 * Flow per camera frame:
 *   mirror + grab the frame -> POST /api/hand -> landmarks + gesture back
 *   -> smooth the fingertip (One Euro filter) -> gesture state machine
 *   -> draw / pick colour / erase / clear / save / undo
 * Strokes live in board.js as vectors; this file wires hand input to them.
 */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const stage = $("stage");
  const ctx = stage.getContext("2d");
  const video = $("video");
  const cap = document.createElement("canvas");      // off-screen frame grabber
  const cctx = cap.getContext("2d");

  /* ---------------- constants ---------------- */
  const LOGICAL_W = 1280;           // drawing units; the canvas keeps this width
  const TOOLBAR_H = 84;             // height of the on-canvas toolbar
  const ERASE_R = 34;               // eraser radius
  const STABLE_FRAMES = 3;          // a gesture must repeat this often before it counts
  const LOST_MS = 450;              // hand missing this long -> stop drawing
  const HOVER_MS = 450;             // dwell time to press a toolbar button
  const REPLAY_SPEED = 1.5;
  const COLORS = ["#ff3b6b", "#ffb020", "#f4f84a", "#31e08b", "#35c4ff", "#b57cff", "#ffffff", "#111111"];
  const SIZES = [4, 10, 20];
  const HOLDS = {                   // gestures that must be held (so they never fire by accident)
    open_palm: { ms: 1200, label: "Clearing…" },
    thumbs_up: { ms: 1000, label: "Saving…" },
    three: { ms: 700, label: "Undo" },
  };
  const HAND_LINES = [[0, 1], [1, 2], [2, 3], [3, 4], [0, 5], [5, 6], [6, 7], [7, 8], [5, 9], [9, 10],
    [10, 11], [11, 12], [9, 13], [13, 14], [14, 15], [15, 16], [13, 17], [17, 18], [18, 19], [19, 20], [0, 17]];
  const GESTURE_TEXT = {
    point: "☝ drawing", two: "✌ choosing", pinch: "🤏 erasing", open_palm: "🖐 open palm",
    thumbs_up: "👍 thumbs up", three: "3 fingers", fist: "✊ fist", unknown: "…", none: "no hand",
  };

  const board = Board.createBoard(LOGICAL_W, 720);
  const fx = createOneEuro(2.0, 0.015, 1.0);
  const fy = createOneEuro(2.0, 0.015, 1.0);
  const settings = { color: COLORS[0], size: 10, snap: true, glow: true, skeleton: true, bg: "camera" };

  const state = {
    running: false, loopActive: false, stream: null,
    hand: null, cursor: null, lastHandAt: 0, fps: 0,
    raw: "none", stable: "none", cand: "none", candN: 0, pending: [],
    strokeT0: 0, hold: null, hover: null, mouse: false,
    snapped: 0, flash: null, replay: null,
  };

  const TOOLBAR = COLORS.map((c) => ({ type: "color", value: c }))
    .concat([{ type: "size" }, { type: "snap" }, { type: "undo" }]);

  /* ---------------- helpers ---------------- */
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const hint = (text) => { $("hint").textContent = text; };

  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  async function api(url, options) {
    const res = await fetch(url, options);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || "Request failed.");
    return data;
  }

  function flash(text, x, y) {
    state.flash = { text, x: x === undefined ? board.width / 2 : x,
                    y: y === undefined ? TOOLBAR_H + 46 : y, until: performance.now() + 1500 };
  }

  /* ---------------- settings / UI sync ---------------- */
  function syncUI() {
    document.querySelectorAll(".sw").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.color === settings.color)));
    $("size").value = settings.size;
    $("size-out").textContent = settings.size;
    $("opt-snap").checked = settings.snap;
    $("opt-glow").checked = settings.glow;
    $("opt-hand").checked = settings.skeleton;
    document.querySelectorAll(".seg-btn").forEach((b) => {
      const on = b.dataset.bg === settings.bg;
      b.classList.toggle("active", on);
      b.setAttribute("aria-pressed", String(on));
    });
    $("k-strokes").textContent = board.strokes.length;
    $("k-snapped").textContent = state.snapped;
  }

  COLORS.forEach((c) => {
    const b = el("button", "sw");
    b.style.background = c;
    b.dataset.color = c;
    b.setAttribute("aria-label", "Colour " + c);
    b.addEventListener("click", () => { settings.color = c; syncUI(); });
    $("swatches").appendChild(b);
  });
  $("size").addEventListener("input", () => { settings.size = +$("size").value; syncUI(); });
  $("opt-snap").addEventListener("change", () => { settings.snap = $("opt-snap").checked; });
  $("opt-glow").addEventListener("change", () => { settings.glow = $("opt-glow").checked; });
  $("opt-hand").addEventListener("change", () => { settings.skeleton = $("opt-hand").checked; });
  document.querySelectorAll(".seg-btn").forEach((b) => {
    b.addEventListener("click", () => { settings.bg = b.dataset.bg; syncUI(); });
  });

  /* ---------------- editing actions ---------------- */
  function doUndo() { if (board.undo()) flash("Undo"); syncUI(); }
  function doRedo() { if (board.redo()) flash("Redo"); syncUI(); }
  function doClear() { if (board.clear()) flash("Cleared (Undo brings it back)"); syncUI(); }

  function exportStrokes() {
    return board.strokes.map((s) => ({
      color: s.color, size: s.size, straight: s.straight, shape: s.shape,
      points: s.points.map((p) => [+p[0].toFixed(1), +p[1].toFixed(1), Math.round(p[2] || 0)]),
    }));
  }

  function renderExport() {                       // white background, no glow
    const c = document.createElement("canvas");
    c.width = board.width; c.height = board.height;
    const x = c.getContext("2d");
    x.fillStyle = "#ffffff";
    x.fillRect(0, 0, c.width, c.height);
    board.strokes.forEach((s) => Board.drawStroke(x, s, false));
    return c;
  }

  const toBlob = (canvas) => new Promise((r) => canvas.toBlob(r, "image/png"));

  async function doSave() {
    if (!board.strokes.length) { hint("Nothing to save yet. Draw something first."); return; }
    const form = new FormData();
    form.append("image", await toBlob(renderExport()), "drawing.png");
    form.append("strokes", JSON.stringify(exportStrokes()));
    form.append("width", board.width);
    form.append("height", board.height);
    const stamp = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    form.append("title", $("title").value.trim() || "Drawing " + stamp);
    try {
      await api("/api/drawings", { method: "POST", body: form });
      flash("Saved ✓");
      hint("Saved. Find it in “Saved drawings”.");
      $("title").value = "";
      refreshGallery();
    } catch (e) { hint("Could not save: " + e.message); }
  }

  async function downloadPng() {
    if (!board.strokes.length) { hint("Nothing to download yet."); return; }
    const url = URL.createObjectURL(await toBlob(renderExport()));
    const a = el("a");
    a.href = url; a.download = "air-canvas.png";
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  $("btn-undo").addEventListener("click", doUndo);
  $("btn-redo").addEventListener("click", doRedo);
  $("btn-clear").addEventListener("click", doClear);
  $("btn-save").addEventListener("click", doSave);
  $("btn-png").addEventListener("click", downloadPng);
  document.addEventListener("keydown", (e) => {
    if (e.target.tagName === "INPUT" && e.target.type === "text") return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "z") { e.preventDefault(); e.shiftKey ? doRedo() : doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "y") { e.preventDefault(); doRedo(); }
    else if (e.key === "Escape") stopReplay();
  });

  /* ---------------- strokes + shape snapping ---------------- */
  function startStroke(points, now) {
    board.begin(settings.color, settings.size, points[0][0], points[0][1], 0);
    state.strokeT0 = now;
    points.slice(1).forEach((p) => board.add(p[0], p[1], now - state.strokeT0));
  }

  function finishStroke(minPoints) {
    const s = board.end(minPoints);
    if (s && settings.snap && s.points.length >= 8) snapStroke(s);
    syncUI();
  }

  async function snapStroke(stroke) {
    try {
      const res = await api("/api/shape", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ points: stroke.points.map((p) => [p[0], p[1]]) }),
      });
      if (res.shape === "none" || !board.strokes.includes(stroke)) return;
      const duration = stroke.points[stroke.points.length - 1][2] || 0;
      const n = res.points.length;
      stroke.points = res.points.map((p, i) => [p[0], p[1], n > 1 ? (duration * i) / (n - 1) : 0]);
      stroke.straight = true;
      stroke.shape = res.shape;
      state.snapped++;
      const mid = stroke.points[Math.floor(n / 2)];
      flash(res.shape[0].toUpperCase() + res.shape.slice(1) + " ✓", mid[0], Math.max(mid[1] - 30, TOOLBAR_H + 30));
      syncUI();
    } catch (e) { /* snapping is a bonus; keep the freehand stroke */ }
  }

  /* ---------------- toolbar on the canvas ---------------- */
  function toolbarIndex(x, y) {
    if (y < 0 || y >= TOOLBAR_H) return -1;
    return clamp(Math.floor(x / (board.width / TOOLBAR.length)), 0, TOOLBAR.length - 1);
  }

  function activateTool(i) {
    const tool = TOOLBAR[i];
    if (tool.type === "color") settings.color = tool.value;
    else if (tool.type === "size") settings.size = SIZES[(SIZES.indexOf(settings.size) + 1) % SIZES.length] || SIZES[0];
    else if (tool.type === "snap") { settings.snap = !settings.snap; flash("Shape snapping " + (settings.snap ? "on" : "off")); }
    else if (tool.type === "undo") doUndo();
    syncUI();
  }

  function drawToolbar(now) {
    const W = board.width, n = TOOLBAR.length, cw = W / n;
    ctx.save();
    ctx.fillStyle = "rgba(12, 15, 24, 0.80)";
    ctx.fillRect(0, 0, W, TOOLBAR_H);
    ctx.textAlign = "center";
    ctx.font = "600 14px system-ui, sans-serif";
    TOOLBAR.forEach((tool, i) => {
      const cx = i * cw + cw / 2, cy = 36;
      if (state.hover && state.hover.i === i) {
        const p = state.hover.fired ? 1 : clamp((now - state.hover.start) / HOVER_MS, 0, 1);
        ctx.fillStyle = "rgba(255,255,255,0.12)";
        ctx.fillRect(i * cw + 4, 4, cw - 8, TOOLBAR_H - 8);
        ctx.fillStyle = "#35c4ff";
        ctx.fillRect(i * cw + 10, TOOLBAR_H - 12, (cw - 20) * p, 5);
      }
      if (tool.type === "color") {
        ctx.beginPath(); ctx.arc(cx, cy + 4, 20, 0, Math.PI * 2);
        ctx.fillStyle = tool.value; ctx.fill();
        if (tool.value === settings.color) {
          ctx.lineWidth = 4; ctx.strokeStyle = "#ffffff";
          ctx.beginPath(); ctx.arc(cx, cy + 4, 27, 0, Math.PI * 2); ctx.stroke();
        } else { ctx.lineWidth = 1.5; ctx.strokeStyle = "rgba(255,255,255,.35)"; ctx.beginPath(); ctx.arc(cx, cy + 4, 20, 0, Math.PI * 2); ctx.stroke(); }
      } else {
        ctx.fillStyle = "#eceff6"; ctx.strokeStyle = "#eceff6"; ctx.lineWidth = 3;
        if (tool.type === "size") {
          ctx.beginPath(); ctx.arc(cx, cy, Math.min(settings.size / 2 + 2, 20), 0, Math.PI * 2); ctx.fill();
        } else if (tool.type === "snap") {
          ctx.strokeStyle = settings.snap ? "#31e08b" : "#7c879d";
          ctx.strokeRect(cx - 18, cy - 14, 17, 17);
          ctx.beginPath(); ctx.arc(cx + 8, cy + 3, 10, 0, Math.PI * 2); ctx.stroke();
        } else {                                           // undo arrow
          ctx.beginPath(); ctx.arc(cx, cy + 2, 14, Math.PI * 1.1, Math.PI * 2.1); ctx.stroke();
          ctx.beginPath(); ctx.moveTo(cx - 20, cy + 2); ctx.lineTo(cx - 8, cy + 2); ctx.lineTo(cx - 14, cy - 10); ctx.closePath(); ctx.fill();
        }
        ctx.fillStyle = "#9aa5bb";
        ctx.fillText(tool.type === "size" ? "Size" : tool.type === "snap" ? "Snap" : "Undo", cx, TOOLBAR_H - 20);
      }
    });
    ctx.restore();
  }

  function hoverTool(x, y, now) {
    const i = toolbarIndex(x, y);
    if (i < 0) { state.hover = null; return; }
    if (!state.hover || state.hover.i !== i) { state.hover = { i, start: now, fired: false }; return; }
    if (!state.hover.fired && now - state.hover.start >= HOVER_MS) {
      state.hover.fired = true;
      activateTool(i);
    }
  }

  /* ---------------- gesture state machine ---------------- */
  function updateGestureUI() {
    const g = state.stable;
    const pill = $("pill-gesture");
    pill.textContent = GESTURE_TEXT[g] || g;
    pill.classList.toggle("live", g !== "none");
    document.querySelectorAll(".card").forEach((c) => c.classList.toggle("active", c.dataset.gesture === g));
  }

  function setStable(g, now) {
    const old = state.stable;
    if (old === "point") finishStroke(4);
    if (old === "pinch") { board.commitErase(); syncUI(); }
    state.hold = null;
    state.hover = null;
    state.stable = g;
    if (g === "point" && state.pending.length && state.pending[0][1] >= TOOLBAR_H) {
      startStroke(state.pending.filter((p) => p[1] >= TOOLBAR_H), now);   // keep the first frames too
    }
    state.pending = [];
    updateGestureUI();
  }

  function stabilize(raw, now) {
    if (raw === state.cand) state.candN++; else { state.cand = raw; state.candN = 1; }
    if (raw === "point" && state.stable !== "point") state.pending.push(state.cursor.slice());
    else if (raw !== "point") state.pending = [];
    if (raw !== state.stable && state.candN >= STABLE_FRAMES) setStable(raw, now);
  }

  function runHold(g) {
    if (g === "open_palm") doClear();
    else if (g === "thumbs_up") doSave();
    else if (g === "three") doUndo();
  }

  function act(now) {
    const g = state.stable;
    const x = state.cursor[0], y = state.cursor[1];
    if (g === "point" && state.raw === "point") {
      if (y < TOOLBAR_H) { if (board.current) finishStroke(4); }      // fingertip entered the toolbar
      else if (!board.current) startStroke([[x, y]], now);
      else board.add(x, y, now - state.strokeT0);
    } else if (g === "two") {
      hoverTool(x, y, now);
    } else if (g === "pinch") {
      if (board.eraseAt(x, y, ERASE_R)) syncUI();
    }
    const cfg = HOLDS[g];
    if (cfg) {
      if (!state.hold || state.hold.g !== g) state.hold = { g, start: now, fired: false };
      if (!state.hold.fired && now - state.hold.start >= cfg.ms) { state.hold.fired = true; runHold(g); }
    } else state.hold = null;
  }

  function onFrame(res, now) {
    if (!res.found) {
      state.hand = null;
      state.raw = "none";
      if (now - state.lastHandAt > LOST_MS) {
        if (state.stable !== "none") setStable("none", now);
        fx.reset(); fy.reset(); state.cursor = null;
      }
      return;
    }
    const h = res.hand;
    state.hand = h;
    state.lastHandAt = now;
    state.raw = h.gesture;
    const p = h.gesture === "pinch" ? h.pinch_point : h.cursor;
    state.cursor = [fx.filter(p[0] * board.width, now), fy.filter(p[1] * board.height, now)];
    stabilize(h.gesture, now);
    act(now);
  }

  /* ---------------- camera + tracking loop ---------------- */
  function grabFrame() {
    if (video.readyState < 2 || !video.videoWidth) return Promise.resolve(null);
    const scale = Math.min(1, 640 / video.videoWidth);
    cap.width = Math.round(video.videoWidth * scale);
    cap.height = Math.round(video.videoHeight * scale);
    cctx.save();
    cctx.translate(cap.width, 0);            // mirror: raise your right hand, it appears on the right
    cctx.scale(-1, 1);
    cctx.drawImage(video, 0, 0, cap.width, cap.height);
    cctx.restore();
    return new Promise((resolve) => cap.toBlob(resolve, "image/jpeg", 0.7));
  }

  async function trackingLoop() {
    if (state.loopActive) return;
    state.loopActive = true;
    let last = performance.now();
    while (state.running) {
      const blob = await grabFrame();
      if (!blob) { await sleep(15); continue; }
      let res;
      try {
        res = await api("/api/hand", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: blob });
      } catch (e) {
        hint("Tracking stopped: " + e.message);
        stopCamera();
        break;
      }
      const now = performance.now();
      $("pill-ms").textContent = res.inference_ms.toFixed(0) + " ms";
      onFrame(res, now);
      state.fps = state.fps ? state.fps * 0.85 + (1000 / (now - last)) * 0.15 : 1000 / (now - last);
      last = now;
      $("pill-fps").textContent = state.fps.toFixed(0) + " fps";
    }
    state.loopActive = false;
  }

  async function startCamera() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      hint("The camera needs a secure address: open http://127.0.0.1:5000 or http://localhost:5000.");
      return;
    }
    try {
      state.stream = await navigator.mediaDevices.getUserMedia({
        video: { width: { ideal: 640 }, height: { ideal: 480 }, facingMode: "user" }, audio: false });
    } catch (e) {
      hint("Camera unavailable (" + (e.message || e.name) + "). Allow camera access, or draw with the mouse.");
      return;
    }
    video.srcObject = state.stream;
    await video.play();
    if (!video.videoWidth) await new Promise((r) => { video.onloadedmetadata = r; });
    board.setSize(LOGICAL_W, Math.round((LOGICAL_W * video.videoHeight) / video.videoWidth));
    await api("/api/hand/reset", { method: "POST" }).catch(() => {});
    state.running = true;
    $("btn-start").disabled = true;
    $("btn-stop").disabled = false;
    hint("Raise one index finger to draw. Two fingers over the top bar choose colours.");
    trackingLoop();
  }

  function stopCamera() {
    state.running = false;
    if (state.stream) { state.stream.getTracks().forEach((t) => t.stop()); state.stream = null; }
    if (board.current) finishStroke(4);
    board.commitErase();
    syncUI();
    state.hand = null; state.cursor = null; state.hold = null; state.hover = null;
    state.stable = "none"; state.raw = "none"; state.candN = 0; state.pending = [];
    fx.reset(); fy.reset();
    $("btn-start").disabled = false;
    $("btn-stop").disabled = true;
    $("pill-fps").textContent = "– fps";
    $("pill-ms").textContent = "– ms";
    updateGestureUI();
  }

  $("btn-start").addEventListener("click", startCamera);
  $("btn-stop").addEventListener("click", () => { stopCamera(); hint("Camera stopped. You can still draw with the mouse."); });

  /* ---------------- mouse / touch (works without a camera) ---------------- */
  function canvasPoint(e) {
    const r = stage.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * board.width, y: ((e.clientY - r.top) / r.height) * board.height };
  }
  stage.addEventListener("pointerdown", (e) => {
    e.preventDefault();
    const p = canvasPoint(e);
    const tool = toolbarIndex(p.x, p.y);
    if (tool >= 0) { activateTool(tool); return; }
    stage.setPointerCapture(e.pointerId);
    state.mouse = true;
    startStroke([[p.x, p.y]], performance.now());
  });
  stage.addEventListener("pointermove", (e) => {
    if (!state.mouse || !board.current) return;
    const p = canvasPoint(e);
    board.add(p.x, p.y, performance.now() - state.strokeT0);
  });
  function mouseUp() {
    if (!state.mouse) return;
    state.mouse = false;
    finishStroke(1);
  }
  stage.addEventListener("pointerup", mouseUp);
  stage.addEventListener("pointercancel", mouseUp);

  /* ---------------- drawing the scene ---------------- */
  function drawHand() {
    const h = state.hand;
    if (!h || !settings.skeleton) return;
    const W = board.width, H = board.height;
    ctx.save();
    ctx.strokeStyle = "rgba(255,255,255,0.55)";
    ctx.lineWidth = 2;
    HAND_LINES.forEach(([a, b]) => {
      ctx.beginPath();
      ctx.moveTo(h.landmarks[a][0] * W, h.landmarks[a][1] * H);
      ctx.lineTo(h.landmarks[b][0] * W, h.landmarks[b][1] * H);
      ctx.stroke();
    });
    ctx.fillStyle = "rgba(53,196,255,0.9)";
    h.landmarks.forEach((p) => { ctx.beginPath(); ctx.arc(p[0] * W, p[1] * H, 3.5, 0, Math.PI * 2); ctx.fill(); });
    ctx.restore();
  }

  function drawCursor() {
    if (!state.cursor || !state.hand) return;
    const [x, y] = state.cursor;
    ctx.save();
    if (state.raw === "pinch") {
      ctx.setLineDash([8, 6]); ctx.lineWidth = 3; ctx.strokeStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(x, y, ERASE_R, 0, Math.PI * 2); ctx.stroke();
    } else if (state.raw === "two") {
      ctx.lineWidth = 3; ctx.strokeStyle = "#35c4ff";
      ctx.beginPath(); ctx.arc(x, y, 18, 0, Math.PI * 2); ctx.stroke();
    } else if (state.raw === "point") {
      ctx.fillStyle = settings.color;
      ctx.beginPath(); ctx.arc(x, y, Math.max(settings.size / 2, 5), 0, Math.PI * 2); ctx.fill();
      ctx.lineWidth = 2; ctx.strokeStyle = "#ffffff";
      ctx.beginPath(); ctx.arc(x, y, Math.max(settings.size / 2, 5) + 4, 0, Math.PI * 2); ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,255,255,.5)";
      ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();
  }

  function drawHold(now) {
    const hd = state.hold;
    if (!hd || !state.hand) return;
    const cfg = HOLDS[hd.g];
    const p = hd.fired ? 1 : clamp((now - hd.start) / cfg.ms, 0, 1);
    const cx = state.hand.palm[0] * board.width, cy = state.hand.palm[1] * board.height;
    ctx.save();
    ctx.lineWidth = 10;
    ctx.strokeStyle = "rgba(255,255,255,0.2)";
    ctx.beginPath(); ctx.arc(cx, cy, 62, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = hd.fired ? "#31e08b" : "#ff3b6b";
    ctx.beginPath(); ctx.arc(cx, cy, 62, -Math.PI / 2, -Math.PI / 2 + Math.PI * 2 * p); ctx.stroke();
    ctx.font = "700 22px system-ui, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "#ffffff";
    ctx.fillText(hd.fired ? "Done ✓" : cfg.label, cx, cy - 78);
    ctx.restore();
  }

  function drawFlash(now) {
    const f = state.flash;
    if (!f || now > f.until) return;
    ctx.save();
    ctx.globalAlpha = clamp((f.until - now) / 400, 0, 1);
    ctx.font = "700 24px system-ui, sans-serif";
    ctx.textAlign = "center";
    const w = ctx.measureText(f.text).width + 28;
    ctx.fillStyle = "rgba(12,15,24,.88)";
    ctx.fillRect(f.x - w / 2, f.y - 24, w, 44);
    ctx.fillStyle = "#ffffff";
    ctx.fillText(f.text, f.x, f.y + 6);
    ctx.restore();
  }

  function drawBackground() {
    const W = board.width, H = board.height;
    const cameraOn = settings.bg === "camera" && state.running && video.readyState >= 2;
    if (cameraOn) {
      ctx.save();
      ctx.translate(W, 0); ctx.scale(-1, 1);          // mirrored, like a mirror
      ctx.drawImage(video, 0, 0, W, H);
      ctx.restore();
      ctx.fillStyle = "rgba(8, 10, 16, 0.30)";          // dim a little so neon strokes pop
      ctx.fillRect(0, 0, W, H);
    } else if (settings.bg === "white") {
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, W, H);
    } else {
      const g = ctx.createLinearGradient(0, 0, 0, H);
      g.addColorStop(0, "#1a2030"); g.addColorStop(1, "#0b0d14");
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = "#6f7b93";
      ctx.font = "600 26px system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText("Press “Start camera”, or draw here with your mouse", W / 2, H / 2);
      ctx.textAlign = "start";
    }
  }

  function drawScene(now) {
    if (stage.width !== board.width || stage.height !== board.height) {
      stage.width = board.width; stage.height = board.height;
    }
    drawBackground();
    const glow = settings.glow && settings.bg === "camera";
    if (state.replay) {
      const elapsed = (now - state.replay.start) * REPLAY_SPEED;
      Board.strokesAt(state.replay.timeline, elapsed).forEach((s) => Board.drawStroke(ctx, s, glow));
      if (elapsed > state.replay.timeline.total + 900) stopReplay();
    } else {
      board.render(ctx, glow);
    }
    drawToolbar(now);
    if (state.running) { drawHand(); drawCursor(); drawHold(now); }
    drawFlash(now);
  }
  (function frame(now) { drawScene(now || performance.now()); requestAnimationFrame(frame); })();

  /* ---------------- replay ---------------- */
  function startReplay() {
    if (!board.strokes.length) return;
    state.replay = { timeline: Board.buildTimeline(board.strokes), start: performance.now() };
    $("btn-stop-replay").hidden = false;
  }
  function stopReplay() {
    state.replay = null;
    $("btn-stop-replay").hidden = true;
  }
  $("btn-stop-replay").addEventListener("click", stopReplay);

  /* ---------------- saved drawings gallery ---------------- */
  async function loadDrawing(id) {
    const d = await api("/api/drawings/" + id);
    board.load(d.strokes, d.width, d.height);
    syncUI();
    hint("Loaded “" + d.title + "”. Undo brings back what was on the canvas before.");
  }

  async function refreshGallery() {
    let rows;
    try { rows = await api("/api/drawings"); } catch (e) { return; }
    const box = $("gallery");
    box.replaceChildren();
    $("gallery-empty").hidden = rows.length > 0;
    rows.forEach((r) => {
      const item = el("div", "shot");
      const img = el("img");
      img.src = "/drawings/" + r.filename;
      img.alt = "Saved drawing: " + r.title;
      item.appendChild(img);

      const meta = el("div", "meta");
      meta.appendChild(el("div", "name", r.title));
      meta.appendChild(el("div", "muted small", r.ts.slice(0, 16) + " · " + r.stroke_count + " strokes"));
      const acts = el("div", "acts");
      const button = (label, fn) => {
        const b = el("button", "btn small", label);
        b.addEventListener("click", fn);
        acts.appendChild(b);
      };
      const link = (label, href, download) => {
        const a = el("a", "btn small", label);
        a.href = href; a.download = download;
        acts.appendChild(a);
      };
      button("Load", () => loadDrawing(r.id).catch((e) => hint(e.message)));
      button("Replay", async () => { await loadDrawing(r.id); startReplay(); });
      link("PNG", "/drawings/" + r.filename, "drawing_" + r.id + ".png");
      link("SVG", "/api/drawings/" + r.id + "/export.svg", "drawing_" + r.id + ".svg");
      button("Delete", async () => {
        if (!confirm("Delete “" + r.title + "”?")) return;
        await api("/api/drawings/" + r.id, { method: "DELETE" });
        refreshGallery();
      });
      meta.appendChild(acts);
      item.appendChild(meta);
      box.appendChild(item);
    });
  }

  /* ---------------- start-up ---------------- */
  async function init() {
    syncUI();
    updateGestureUI();
    try {
      const h = await api("/api/health");
      const pill = $("pill-model");
      pill.textContent = "MediaPipe ready";
      pill.classList.add("ok");
    } catch (e) {
      const pill = $("pill-model");
      pill.textContent = "Server error";
      pill.classList.add("bad");
    }
    refreshGallery();
  }
  init();
})();
