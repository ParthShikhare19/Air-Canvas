import io
import json

from tests.conftest import jpeg_bytes, make_hand, png_bytes

STROKES = [{"color": "#ff3b6b", "size": 10, "points": [[10, 10, 0], [200, 120, 300], [400, 90, 600]]},
           {"color": "#35c4ff", "size": 6, "points": [[50, 300, 0]]}]


def save(client, strokes=None, title="My sketch", width=1280, height=720):
    return client.post("/api/drawings", content_type="multipart/form-data", data={
        "image": (io.BytesIO(png_bytes()), "d.png"),
        "strokes": json.dumps(STROKES if strokes is None else strokes),
        "width": str(width), "height": str(height), "title": title})


# ---------------------------------------------------------------- pages ----
def test_home_page(client):
    res = client.get("/")
    assert res.status_code == 200 and b"Air Canvas" in res.data


def test_health(client):
    body = client.get("/api/health").get_json()
    assert body["status"] == "ok" and "MediaPipe" in body["tracker"]


# ----------------------------------------------------------- hand tracking --
def test_real_mediapipe_finds_no_hand_in_a_black_frame(client):
    body = client.post("/api/hand", data=jpeg_bytes(320, 240)).get_json()
    assert body["found"] is False and body["width"] == 320


def test_bad_frames_are_rejected(client):
    assert client.post("/api/hand", data=b"").status_code == 400
    assert client.post("/api/hand", data=b"not an image").status_code == 400


def test_hand_endpoint_returns_gesture_and_landmarks(client, app_instance):
    fake = {"landmarks": make_hand(index=True, width=64, height=48), "handedness": "Right", "score": 0.97}
    tracker = app_instance.extensions["tracker"]
    original = tracker.process
    tracker.process = lambda frame: (fake, 4.2)
    try:
        body = client.post("/api/hand", data=jpeg_bytes(64, 48)).get_json()
    finally:
        tracker.process = original
    assert body["found"] and body["hand"]["gesture"] == "point"
    assert len(body["hand"]["landmarks"]) == 21
    assert body["hand"]["handedness"] == "Right" and body["inference_ms"] == 4.2


def test_tracker_reset(client):
    assert client.post("/api/hand/reset").get_json() == {"reset": True}


# ------------------------------------------------------------------ shapes --
def test_shape_endpoint_recognises_a_square(client):
    pts = []
    for a, b in [((300, 200), (500, 200)), ((500, 200), (500, 400)), ((500, 400), (300, 400)), ((300, 400), (300, 200))]:
        pts += [[a[0] + (b[0] - a[0]) * k / 20, a[1] + (b[1] - a[1]) * k / 20] for k in range(20)]
    body = client.post("/api/shape", json={"points": pts}).get_json()
    assert body["shape"] == "square" and len(body["points"]) == 5


def test_shape_endpoint_validation(client):
    assert client.post("/api/shape", json={}).status_code == 400
    assert client.post("/api/shape", json={"points": "nope"}).status_code == 400
    assert client.post("/api/shape", json={"points": [["a", "b"]]}).status_code == 400
    assert client.post("/api/shape", json={"points": [[1, 1]] * 6000}).status_code == 400
    assert client.post("/api/shape", json={"points": [[1, 1], [2, 2]]}).get_json()["shape"] == "none"


# ---------------------------------------------------------------- drawings --
def test_drawing_lifecycle(client):
    created = save(client)
    assert created.status_code == 201
    drawing_id = created.get_json()["id"]
    image_url = created.get_json()["image"]

    assert client.get(image_url).status_code == 200
    listed = [d for d in client.get("/api/drawings").get_json() if d["id"] == drawing_id][0]
    assert listed["title"] == "My sketch" and listed["stroke_count"] == 2

    full = client.get("/api/drawings/%d" % drawing_id).get_json()
    assert full["strokes"][0]["color"] == "#ff3b6b" and full["width"] == 1280

    renamed = client.patch("/api/drawings/%d" % drawing_id, json={"title": "Renamed"})
    assert renamed.get_json()["title"] == "Renamed"
    assert client.patch("/api/drawings/%d" % drawing_id, json={"title": " "}).status_code == 400

    assert client.delete("/api/drawings/%d" % drawing_id).status_code == 200
    assert client.get("/api/drawings/%d" % drawing_id).status_code == 404
    assert client.get(image_url).status_code in (404, 500)


def test_svg_export_is_valid_and_escaped(client):
    drawing_id = save(client, title="<script>alert(1)</script>").get_json()["id"]
    res = client.get("/api/drawings/%d/export.svg" % drawing_id)
    text = res.data.decode()
    assert res.mimetype == "image/svg+xml"
    assert text.startswith("<svg") and text.count("<path") == 2
    assert "<script>" not in text and "&lt;script&gt;" in text


def test_save_validation(client):
    assert save(client, strokes=[]).status_code == 400
    assert save(client, strokes=[{"color": "red", "size": 5, "points": [[1, 1]]}]).status_code == 400
    assert save(client, strokes=[{"color": "#ffffff", "size": 5, "points": []}]).status_code == 400
    assert save(client, strokes=[{"color": "#ffffff", "size": 5, "points": [["x", 1]]}]).status_code == 400
    assert save(client, width=10).status_code == 400
    bad = client.post("/api/drawings", content_type="multipart/form-data",
                      data={"image": (io.BytesIO(b"hello"), "d.png"), "strokes": json.dumps(STROKES)})
    assert bad.status_code == 400
    assert client.post("/api/drawings", data={}).status_code == 400


def test_unknown_drawings_and_unsafe_paths(client):
    assert client.get("/api/drawings/9999").status_code == 404
    assert client.delete("/api/drawings/9999").status_code == 404
    assert client.get("/api/drawings/9999/export.svg").status_code == 404
    assert client.get("/drawings/../../config.py").status_code == 404
    assert client.get("/drawings/notahash.png").status_code == 404
