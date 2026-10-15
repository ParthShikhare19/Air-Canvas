"""Turn 21 hand landmarks into a gesture name. Pure Python, no AI model needed.

Landmark numbering (MediaPipe):  0 wrist | 1-4 thumb | 5-8 index | 9-12 middle |
13-16 ring | 17-20 pinky   (each finger: MCP knuckle, PIP, DIP, TIP)

Rules are based on distances, not on "tip is higher than knuckle", so they keep
working when the hand is tilted or rotated:

  * a finger is EXTENDED when its tip is farther from the wrist than its middle
    joint (PIP). Curled fingers fold back toward the palm.
  * the thumb is extended when its tip is far from the base of the index finger;
    a "thumbs up" is a fist whose thumb points clearly upward.
  * PINCH = thumb tip and index tip are close, compared with the hand's size, AND the
    index finger is not folded into the palm. (In a closed fist the thumb also rests
    on the index finger; without the second check a fist would count as a pinch.)

Gestures:   point (draw) · two (choose from the toolbar) · pinch (erase) ·
            open_palm (hold to clear) · thumbs_up (hold to save) ·
            three (hold to undo) · fist · unknown
"""
import math

WRIST, THUMB_MCP, THUMB_TIP = 0, 2, 4
INDEX_MCP, INDEX_TIP = 5, 8
MIDDLE_MCP = 9
# (pip, tip) joints of index, middle, ring, pinky
FINGER_JOINTS = [(6, 8), (10, 12), (14, 16), (18, 20)]

EXTENDED_RATIO = 1.12      # tip distance / pip distance (from the wrist)
THUMB_RATIO = 0.62         # thumb tip to index knuckle, relative to hand size
PINCH_RATIO = 0.30         # thumb tip to index tip, relative to hand size
PINCH_INDEX_OPEN = 0.90    # index tip / index PIP distance from the wrist (fist is about 0.7)


def _dist(a, b):
    return math.hypot(a[0] - b[0], a[1] - b[1])


def analyze(landmarks, width=1, height=1):
    """landmarks: 21 x [x, y, z] with x, y in 0..1. width/height of the frame are
    needed so distances are measured in pixels, not in stretched 0..1 units."""
    pts = [(p[0] * width, p[1] * height) for p in landmarks]
    hand_size = _dist(pts[WRIST], pts[MIDDLE_MCP]) or 1e-6

    fingers = [_dist(pts[THUMB_TIP], pts[INDEX_MCP]) / hand_size > THUMB_RATIO]
    for pip, tip in FINGER_JOINTS:
        fingers.append(_dist(pts[tip], pts[WRIST]) > _dist(pts[pip], pts[WRIST]) * EXTENDED_RATIO)
    thumb, index, middle, ring, pinky = fingers

    pinch_ratio = _dist(pts[THUMB_TIP], pts[INDEX_TIP]) / hand_size
    index_open = _dist(pts[INDEX_TIP], pts[WRIST]) / (_dist(pts[6], pts[WRIST]) or 1e-6)

    # thumb pointing roughly up in the picture (image y grows downward)
    dx = pts[THUMB_TIP][0] - pts[THUMB_MCP][0]
    dy = pts[THUMB_TIP][1] - pts[THUMB_MCP][1]
    thumb_up = dy < -0.45 * hand_size and abs(dx) <= 1.2 * abs(dy)

    if pinch_ratio < PINCH_RATIO and index_open > PINCH_INDEX_OPEN:
        gesture = "pinch"
    elif index and middle and ring and pinky:
        gesture = "open_palm"
    elif index and middle and ring:
        gesture = "three"
    elif index and middle and not ring and not pinky:
        gesture = "two"
    elif index and not (middle or ring or pinky):
        gesture = "point"
    elif thumb_up and not (index or middle or ring or pinky):
        gesture = "thumbs_up"
    elif not (index or middle or ring or pinky):
        gesture = "fist"
    else:
        gesture = "unknown"

    index_tip = landmarks[INDEX_TIP]
    thumb_tip = landmarks[THUMB_TIP]
    return {
        "gesture": gesture,
        "fingers": dict(zip(("thumb", "index", "middle", "ring", "pinky"), fingers)),
        "pinch_ratio": round(pinch_ratio, 3),
        "cursor": [index_tip[0], index_tip[1]],                       # index fingertip
        "pinch_point": [(index_tip[0] + thumb_tip[0]) / 2,            # between the two tips
                        (index_tip[1] + thumb_tip[1]) / 2],
        "palm": [landmarks[MIDDLE_MCP][0], landmarks[MIDDLE_MCP][1]],
    }
