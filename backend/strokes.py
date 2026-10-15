"""Validation of drawing data coming from the browser, and SVG export.

Strokes are vector data: {"color": "#rrggbb", "size": 8, "points": [[x, y, t], ...]}.
Keeping vectors (instead of pixels) is what makes undo, erase, replay and SVG export possible.
"""
import re
from xml.sax.saxutils import escape

COLOR = re.compile(r"^#[0-9a-fA-F]{6}$")


def clean_strokes(raw, max_strokes=2000, max_points=5000):
    """Return a sanitised copy of the strokes or raise ValueError."""
    if not isinstance(raw, list):
        raise ValueError("strokes must be a list")
    if len(raw) > max_strokes:
        raise ValueError("too many strokes")
    cleaned = []
    for s in raw:
        if not isinstance(s, dict) or not COLOR.match(str(s.get("color", ""))):
            raise ValueError("invalid stroke colour")
        try:
            size = float(s.get("size", 8))
        except (TypeError, ValueError):
            raise ValueError("invalid stroke size")
        points = s.get("points")
        if not isinstance(points, list) or not 1 <= len(points) <= max_points:
            raise ValueError("invalid stroke points")
        pts = []
        for p in points:
            try:
                pts.append([round(float(p[0]), 1), round(float(p[1]), 1),
                            round(float(p[2]), 0) if len(p) > 2 else 0])
            except (TypeError, ValueError, IndexError):
                raise ValueError("invalid point")
        cleaned.append({"color": s["color"].lower(), "size": min(max(size, 1), 80),
                        "points": pts, "straight": bool(s.get("straight", False)),
                        "shape": str(s.get("shape") or "")[:16] or None})
    return cleaned


def _path(points, straight):
    if len(points) == 1:
        x, y = points[0][:2]
        return "M%.1f %.1f l0.1 0" % (x, y)
    d = ["M%.1f %.1f" % tuple(points[0][:2])]
    if straight or len(points) == 2:
        d += ["L%.1f %.1f" % tuple(p[:2]) for p in points[1:]]
    else:                                   # smooth curve through the mid-points
        for a, b in zip(points[1:-1], points[2:]):
            d.append("Q%.1f %.1f %.1f %.1f" % (a[0], a[1], (a[0] + b[0]) / 2, (a[1] + b[1]) / 2))
        d.append("L%.1f %.1f" % tuple(points[-1][:2]))
    return " ".join(d)


def strokes_to_svg(strokes, width, height, title="Air Canvas drawing", background="#ffffff"):
    parts = ['<svg xmlns="http://www.w3.org/2000/svg" width="%d" height="%d" viewBox="0 0 %d %d">'
             % (width, height, width, height),
             "<title>%s</title>" % escape(title),
             '<rect width="100%%" height="100%%" fill="%s"/>' % background]
    for s in strokes:
        parts.append('<path d="%s" fill="none" stroke="%s" stroke-width="%.1f" '
                     'stroke-linecap="round" stroke-linejoin="round"/>'
                     % (_path(s["points"], s.get("straight")), s["color"], s["size"]))
    parts.append("</svg>")
    return "\n".join(parts)
