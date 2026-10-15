import math

import numpy as np
import pytest

from backend.shapes import recognize

RNG = np.random.default_rng(11)


def noisy(points, sigma=2.5):
    return (np.asarray(points) + RNG.normal(0, sigma, (len(points), 2))).tolist()


def polyline(corners, per=25, closed=True):
    c = list(corners) + ([corners[0]] if closed else [])
    out = []
    for a, b in zip(c[:-1], c[1:]):
        for k in range(per):
            out.append(np.add(a, np.subtract(b, a) * k / per))
    out.append(c[-1])
    return np.array(out)


def circle(r=120, overshoot=0.1, n=90):
    t = np.linspace(0, 2 * math.pi * (1 + overshoot), n)
    return np.column_stack([400 + r * np.cos(t), 300 + r * np.sin(t)])


CASES = {
    "circle": lambda: circle(),
    "ellipse": lambda: np.column_stack([400 + 170 * np.cos(np.linspace(0, 6.6, 90)),
                                        300 + 80 * np.sin(np.linspace(0, 6.6, 90))]),
    "square": lambda: polyline([(300, 200), (500, 200), (500, 400), (300, 400)]),
    "rectangle": lambda: polyline([(250, 200), (550, 200), (550, 350), (250, 350)]),
    "triangle": lambda: polyline([(400, 150), (550, 420), (250, 420)]),
    "line": lambda: polyline([(100, 100), (700, 420)], per=40, closed=False),
}


@pytest.mark.parametrize("expected", CASES)
def test_recognises_clean_shapes_despite_hand_tremor(expected):
    hits = sum(recognize(noisy(CASES[expected]()))["shape"] == expected for _ in range(15))
    assert hits >= 14


def test_tilted_rectangle_is_still_a_rectangle():
    pts = polyline([(300, 200), (520, 260), (480, 400), (260, 340)])
    assert recognize(noisy(pts, 1.5))["shape"] == "rectangle"


def test_freehand_things_are_left_alone():
    zigzag = polyline([(100, 100), (200, 300), (300, 100), (400, 300), (500, 100)], per=15, closed=False)
    arc = np.column_stack([400 + 150 * np.cos(np.linspace(0, math.pi, 60)),
                           300 + 150 * np.sin(np.linspace(0, math.pi, 60))])
    star = [(400 + (150 if k % 2 == 0 else 60) * math.cos(-math.pi / 2 + k * math.pi / 5),
             300 + (150 if k % 2 == 0 else 60) * math.sin(-math.pi / 2 + k * math.pi / 5)) for k in range(10)]
    for pts in (zigzag, arc, polyline(star)):
        assert recognize(noisy(pts, 2))["shape"] == "none"


def test_tiny_or_degenerate_input_is_ignored():
    assert recognize([])["shape"] == "none"
    assert recognize([[0, 0]] * 20)["shape"] == "none"
    assert recognize(noisy(circle(r=4, n=20), 1))["shape"] == "none"


def test_snapped_shapes_are_clean_geometry():
    square = recognize(noisy(CASES["square"](), 3))
    xs = sorted({round(p[0]) for p in square["points"]})
    assert len(square["points"]) == 5 and square["points"][0] == square["points"][-1]
    sides = [math.dist(square["points"][i], square["points"][i + 1]) for i in range(4)]
    assert max(sides) - min(sides) < 1.0                       # all sides equal
    assert len(xs) <= 4                                         # axis aligned

    circ = recognize(noisy(circle(), 3))
    ring = circ["points"][:-1]                                  # last point repeats the first
    centre = (np.mean([p[0] for p in ring]), np.mean([p[1] for p in ring]))
    radii = [math.dist(p, centre) for p in ring]
    assert max(radii) - min(radii) < 2.0                        # a perfect circle

    line = recognize(noisy(CASES["line"](), 2))
    assert len(line["points"]) == 2
