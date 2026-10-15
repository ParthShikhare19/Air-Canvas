"""HTTP routes: `pages` serves the UI, `api` is the JSON REST API."""
import json
import os
import re
import uuid

import cv2
import numpy as np
from flask import (Blueprint, Response, current_app, jsonify, render_template,
                   request, send_from_directory)

from . import database, gestures, shapes
from .strokes import clean_strokes, strokes_to_svg

pages = Blueprint("pages", __name__)
api = Blueprint("api", __name__)

IMAGE_NAME = re.compile(r"^[0-9a-f]{32}\.png$")


def _error(message, status=400):
    return jsonify({"error": message}), status


def _decode(data):
    if not data:
        return None
    return cv2.imdecode(np.frombuffer(data, np.uint8), cv2.IMREAD_COLOR)


# ---------------------------------------------------------------- pages ----
@pages.route("/")
def index():
    return render_template("index.html")


@pages.route("/drawings/<name>")
def drawing_file(name):
    if not IMAGE_NAME.match(name):
        return _error("Not found.", 404)
    return send_from_directory(current_app.config["DRAWING_DIR"], name)


# ------------------------------------------------------------ hand AI -----
@api.get("/health")
def health():
    import mediapipe
    return jsonify({"status": "ok", "tracker": "MediaPipe Hands",
                    "mediapipe": mediapipe.__version__,
                    "model_complexity": current_app.config["MODEL_COMPLEXITY"]})


@api.post("/hand")
def hand():
    """Body = one JPEG frame. Returns the 21 landmarks and the recognised gesture."""
    frame = _decode(request.get_data())
    if frame is None:
        return _error("Send a JPEG or PNG frame in the request body.")
    tracker = current_app.extensions["tracker"]
    found, ms = tracker.process(frame)
    body = {"found": found is not None, "inference_ms": round(ms, 1),
            "width": int(frame.shape[1]), "height": int(frame.shape[0])}
    if found:
        info = gestures.analyze(found["landmarks"], frame.shape[1], frame.shape[0])
        info.update({"landmarks": [[p[0], p[1]] for p in found["landmarks"]],
                     "handedness": found["handedness"], "score": found["score"]})
        body["hand"] = info
    return jsonify(body)


@api.post("/hand/reset")
def hand_reset():
    current_app.extensions["tracker"].reset()
    return jsonify({"reset": True})


@api.post("/shape")
def shape():
    """Body {"points": [[x, y], ...]} -> recognised clean shape (or "none")."""
    body = request.get_json(silent=True) or {}
    points = body.get("points")
    limit = current_app.config["MAX_POINTS_PER_STROKE"]
    if not isinstance(points, list) or len(points) > limit:
        return _error("points must be a list of [x, y] pairs.")
    try:
        cleaned = [[float(p[0]), float(p[1])] for p in points]
    except (TypeError, ValueError, IndexError):
        return _error("points must be a list of [x, y] pairs.")
    return jsonify(shapes.recognize(cleaned))


# ------------------------------------------------------------- drawings ---
@api.get("/drawings")
def list_drawings():
    return jsonify(database.list_drawings())


@api.post("/drawings")
def create_drawing():
    """multipart form: image (PNG), strokes (JSON), width, height, title."""
    image = _decode(request.files["image"].read()) if "image" in request.files else None
    if image is None:
        return _error("Attach the drawing as a PNG in the 'image' field.")
    try:
        strokes = clean_strokes(json.loads(request.form.get("strokes", "[]")),
                                current_app.config["MAX_STROKES"],
                                current_app.config["MAX_POINTS_PER_STROKE"])
        width = int(request.form.get("width", image.shape[1]))
        height = int(request.form.get("height", image.shape[0]))
    except (ValueError, json.JSONDecodeError) as exc:
        return _error(str(exc))
    if not strokes:
        return _error("The drawing is empty.")
    if not (100 <= width <= 4000 and 100 <= height <= 4000):
        return _error("Unreasonable canvas size.")

    folder = current_app.config["DRAWING_DIR"]
    os.makedirs(folder, exist_ok=True)
    name = uuid.uuid4().hex + ".png"
    cv2.imwrite(os.path.join(folder, name), image)
    title = request.form.get("title", "").strip()[:60] or "Untitled drawing"
    drawing_id = database.add_drawing(title, width, height, strokes, name)
    return jsonify({"id": drawing_id, "image": "/drawings/" + name}), 201


@api.get("/drawings/<int:drawing_id>")
def get_drawing(drawing_id):
    row = database.get_drawing(drawing_id)
    return jsonify(row) if row else _error("Drawing not found.", 404)


@api.patch("/drawings/<int:drawing_id>")
def rename_drawing(drawing_id):
    title = str((request.get_json(silent=True) or {}).get("title", "")).strip()[:60]
    if not title:
        return _error("Give the drawing a title.")
    if not database.rename_drawing(drawing_id, title):
        return _error("Drawing not found.", 404)
    return jsonify({"id": drawing_id, "title": title})


@api.delete("/drawings/<int:drawing_id>")
def delete_drawing(drawing_id):
    row = database.get_drawing(drawing_id)
    if row is None:
        return _error("Drawing not found.", 404)
    path = os.path.join(current_app.config["DRAWING_DIR"], row["filename"])
    if os.path.exists(path):
        os.remove(path)
    database.delete_drawing(drawing_id)
    return jsonify({"deleted": drawing_id})


@api.get("/drawings/<int:drawing_id>/export.svg")
def export_svg(drawing_id):
    row = database.get_drawing(drawing_id)
    if row is None:
        return _error("Drawing not found.", 404)
    svg = strokes_to_svg(row["strokes"], row["width"], row["height"], row["title"])
    return Response(svg, mimetype="image/svg+xml",
                    headers={"Content-Disposition": "attachment; filename=drawing_%d.svg" % drawing_id})
