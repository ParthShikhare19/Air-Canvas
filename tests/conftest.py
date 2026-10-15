import math
import os
import sys
import tempfile

import cv2
import numpy as np
import pytest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from backend import create_app  # noqa: E402


@pytest.fixture(scope="session")
def app_instance():
    folder = tempfile.mkdtemp()
    app = create_app({
        "DATABASE": os.path.join(folder, "test.db"),
        "DRAWING_DIR": os.path.join(folder, "drawings"),
        "TESTING": True,
        "MODEL_COMPLEXITY": 0,
    })
    return app


@pytest.fixture()
def client(app_instance):
    with app_instance.test_client() as c:
        yield c


def png_bytes(width=200, height=120):
    img = np.full((height, width, 3), 255, np.uint8)
    cv2.line(img, (10, 10), (width - 10, height - 10), (0, 0, 255), 4)
    return cv2.imencode(".png", img)[1].tobytes()


def jpeg_bytes(width=64, height=48):
    return cv2.imencode(".jpg", np.zeros((height, width, 3), np.uint8))[1].tobytes()


# ---- a synthetic hand, built in "units" where wrist -> middle knuckle = 0.21 ----
KNUCKLES = {"index": (-0.05, -0.20), "middle": (0.0, -0.21), "ring": (0.05, -0.20), "pinky": (0.09, -0.17)}
DIRECTIONS = {"index": (-0.15, -1.0), "middle": (0.0, -1.0), "ring": (0.12, -1.0), "pinky": (0.25, -1.0)}


def make_hand(thumb=False, index=False, middle=False, ring=False, pinky=False,
              pinch=False, thumb_up=False, angle_deg=0.0, width=1280, height=720):
    """Return 21 normalised landmarks for an upright hand, optionally rotated about the wrist."""
    pts = [None] * 21
    pts[0] = (0.0, 0.0)
    flags = {"index": index, "middle": middle, "ring": ring, "pinky": pinky}
    base = {"index": 5, "middle": 9, "ring": 13, "pinky": 17}
    for name, first in base.items():
        mx, my = KNUCKLES[name]
        dx, dy = DIRECTIONS[name]
        n = math.hypot(dx, dy)
        dx, dy = dx / n, dy / n
        if flags[name]:      # straight finger
            pts[first] = (mx, my)
            pts[first + 1] = (mx + dx * 0.07, my + dy * 0.07)
            pts[first + 2] = (mx + dx * 0.115, my + dy * 0.115)
            pts[first + 3] = (mx + dx * 0.15, my + dy * 0.15)
        else:                # curled into the palm
            pts[first] = (mx, my)
            pts[first + 1] = (mx + dx * 0.06, my + dy * 0.06)
            pts[first + 2] = (mx + 0.01, my + 0.01)
            pts[first + 3] = (mx, my + 0.03)
    pts[1] = (-0.04, -0.03)
    pts[2] = (-0.07, -0.08)
    if thumb_up:
        pts[3], pts[4] = (-0.08, -0.15), (-0.085, -0.23)
    elif thumb:
        pts[3], pts[4] = (-0.14, -0.13), (-0.21, -0.17)
    else:
        pts[3], pts[4] = (-0.04, -0.12), (-0.02, -0.15)
    if pinch:                # thumb tip touches the index fingertip
        ix, iy = pts[8]
        pts[4] = (ix + 0.005, iy + 0.005)

    theta = math.radians(angle_deg)
    cos, sin = math.cos(theta), math.sin(theta)
    scale = 1000.0 * 0.21 / 0.21   # 1 unit = 1000 px, so the hand is ~210 px
    out = []
    for x, y in pts:
        rx, ry = x * cos - y * sin, x * sin + y * cos
        out.append([(640 + rx * scale) / width, (500 + ry * scale) / height, 0.0])
    return out
