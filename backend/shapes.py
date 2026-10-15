"""Shape snapping: turn a wobbly hand-drawn stroke into a clean shape (OpenCV).

Steps
  1. Resample the stroke to evenly spaced points (drawing speed must not matter).
  2. Open stroke?  Straight enough -> LINE, otherwise leave it as a freehand curve.
  3. Closed stroke?  Measure it with
        circularity = 4*pi*area / perimeter^2   (1.0 = perfect circle, 0.785 = square)
     and simplify the outline with Douglas-Peucker (cv2.approxPolyDP):
        4 corners and fills its bounding rectangle -> RECTANGLE / SQUARE
        3 corners                                  -> TRIANGLE
        smooth and round                           -> CIRCLE or ELLIPSE (cv2.fitEllipse)
"""
import math

import cv2
import numpy as np

MIN_POINTS = 8
MIN_LENGTH = 60.0          # pixels (logical 1280 px wide canvas)


def _resample(points, n=120):
    pts = np.asarray(points, dtype=float)
    seg = np.hypot(*np.diff(pts, axis=0).T)
    dist = np.concatenate([[0.0], np.cumsum(seg)])
    if dist[-1] == 0:
        return np.repeat(pts[:1], n, axis=0)
    t = np.linspace(0, dist[-1], n)
    return np.column_stack([np.interp(t, dist, pts[:, 0]), np.interp(t, dist, pts[:, 1])])


def _smooth(pts, window=9):
    """Moving average over a closed outline. Hand tremor adds tiny zig-zags that
    would inflate the perimeter and fool the circularity measure."""
    k = np.ones(window) / window
    pad = window // 2
    ext = np.vstack([pts[-pad:], pts, pts[:pad]])
    return np.column_stack([np.convolve(ext[:, 0], k, mode="valid"),
                            np.convolve(ext[:, 1], k, mode="valid")])


def _none():
    return {"shape": "none", "points": []}


def _result(name, pts, closed=True):
    pts = [[round(float(x), 1), round(float(y), 1)] for x, y in pts]
    if closed:
        pts.append(list(pts[0]))
    return {"shape": name, "points": pts}


def _line(pts, length):
    vx, vy, x0, y0 = cv2.fitLine(pts.astype(np.float32), cv2.DIST_L2, 0, 0.01, 0.01).ravel()
    normal = np.array([-vy, vx])
    deviation = np.abs((pts - [x0, y0]) @ normal).max()
    if deviation / length > 0.07:
        return _none()
    direction = np.array([vx, vy])
    a = np.array([x0, y0]) + direction * ((pts[0] - [x0, y0]) @ direction)
    b = np.array([x0, y0]) + direction * ((pts[-1] - [x0, y0]) @ direction)
    return _result("line", [a, b], closed=False)


def _ellipse_points(cx, cy, w, h, angle_deg, n=72):
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    a, b, phi = w / 2.0, h / 2.0, math.radians(angle_deg)
    x = cx + a * np.cos(t) * math.cos(phi) - b * np.sin(t) * math.sin(phi)
    y = cy + a * np.cos(t) * math.sin(phi) + b * np.sin(t) * math.cos(phi)
    return np.column_stack([x, y])


def recognize(points):
    """points: list of [x, y]. Returns {"shape": name, "points": [[x, y], ...]}.
    shape is one of line, circle, ellipse, rectangle, square, triangle, none."""
    pts = np.asarray(points, dtype=float)[:, :2] if len(points) else np.zeros((0, 2))
    if len(pts) < MIN_POINTS:
        return _none()
    length = float(np.hypot(*np.diff(pts, axis=0).T).sum())
    spread = float(np.hypot(*(pts.max(axis=0) - pts.min(axis=0))))
    if length < MIN_LENGTH or spread < 40:        # too short, or just a jittery dot
        return _none()

    closure = float(np.hypot(*(pts[0] - pts[-1])) / length)   # 0 = ends meet, 1 = straight
    if closure > 0.6:
        return _line(pts, length)
    if closure > 0.25:
        return _none()                                         # an open curve: keep freehand

    outline = _smooth(_resample(pts, 120)).astype(np.float32).reshape(-1, 1, 2)
    area = cv2.contourArea(outline)
    perimeter = cv2.arcLength(outline, True)
    if perimeter < MIN_LENGTH or area < 1:
        return _none()
    circularity = 4 * math.pi * area / perimeter ** 2

    corners = cv2.approxPolyDP(outline, 0.04 * perimeter, True)
    n, convex = len(corners), cv2.isContourConvex(corners)

    rect = cv2.minAreaRect(outline)
    (cx, cy), (rw, rh), _angle = rect
    extent = area / (rw * rh) if rw * rh > 0 else 0

    if n == 4 and convex and extent >= 0.88:
        box = cv2.boxPoints(rect)
        angle = rect[2] % 90
        if angle < 10 or angle > 80:                           # almost upright: snap to axes
            x0, y0 = box.min(axis=0)
            x1, y1 = box.max(axis=0)
            box = np.array([[x0, y0], [x1, y0], [x1, y1], [x0, y1]])
            rw, rh = x1 - x0, y1 - y0
        name = "square" if abs(rw - rh) / max(rw, rh) < 0.12 else "rectangle"
        if name == "square":                                   # make all sides equal
            side = (rw + rh) / 2.0
            mx, my = box.mean(axis=0)
            box = box - [mx, my]
            box = box * (side / max(rw, rh, 1e-6)) + [mx, my]
        return _result(name, box)

    if n == 3 and convex:
        return _result("triangle", corners.reshape(-1, 2))

    if circularity >= 0.80 and (n >= 5 or extent < 0.84):
        (ex, ey), (aw, ah), ang = cv2.fitEllipse(outline)
        ratio = min(aw, ah) / max(aw, ah)
        if ratio > 0.82:
            return _result("circle", _ellipse_points(ex, ey, (aw + ah) / 2, (aw + ah) / 2, 0))
        return _result("ellipse", _ellipse_points(ex, ey, aw, ah, ang))

    return _none()
