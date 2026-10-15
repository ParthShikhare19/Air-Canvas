import pytest

from backend.gestures import analyze
from tests.conftest import make_hand

POSES = {
    "point":     dict(index=True),
    "two":       dict(index=True, middle=True),
    "three":     dict(index=True, middle=True, ring=True),
    "open_palm": dict(thumb=True, index=True, middle=True, ring=True, pinky=True),
    "fist":      dict(),
    "pinch":     dict(pinch=True, index=True),                                        # others curled
    "pinch_ok":  dict(pinch=True, index=True, middle=True, ring=True, pinky=True),   # "OK" sign
}


@pytest.mark.parametrize("name", POSES)
@pytest.mark.parametrize("angle", [0, 25, -40, 90, 180])
def test_gestures_survive_rotation_in_a_widescreen_frame(name, angle):
    hand = make_hand(angle_deg=angle, **POSES[name])
    expected = "pinch" if name.startswith("pinch") else name
    assert analyze(hand, 1280, 720)["gesture"] == expected


def test_thumbs_up():
    hand = make_hand(thumb_up=True)
    assert analyze(hand, 1280, 720)["gesture"] == "thumbs_up"


def test_fist_with_tucked_thumb_is_not_thumbs_up():
    assert analyze(make_hand(), 1280, 720)["gesture"] == "fist"


def test_pointing_while_thumb_is_out_is_still_point():
    assert analyze(make_hand(thumb=True, index=True), 1280, 720)["gesture"] == "point"


def test_cursor_is_the_index_fingertip_and_pinch_point_is_between_tips():
    hand = make_hand(index=True)
    info = analyze(hand, 1280, 720)
    assert info["cursor"] == [hand[8][0], hand[8][1]]
    pinched = analyze(make_hand(pinch=True), 1280, 720)
    assert pinched["pinch_ratio"] < 0.3


def test_finger_flags():
    info = analyze(make_hand(index=True, middle=True), 1280, 720)
    assert info["fingers"] == {"thumb": False, "index": True, "middle": True, "ring": False, "pinky": False}


def test_pixel_aspect_matters():
    """The same hand must give the same answer in a square and in a wide frame."""
    sq = analyze(make_hand(index=True, width=1000, height=1000), 1000, 1000)
    wide = analyze(make_hand(index=True, width=1920, height=720), 1920, 720)
    assert sq["gesture"] == wide["gesture"] == "point"
    assert abs(sq["pinch_ratio"] - wide["pinch_ratio"]) < 0.02


def test_a_closed_fist_is_never_mistaken_for_a_pinch():
    """The thumb rests on the curled index finger in a fist, so the tips are close
    together. That must not trigger the eraser."""
    info = analyze(make_hand(), 1280, 720)
    assert info["pinch_ratio"] < 0.3          # the tips really are close...
    assert info["gesture"] == "fist"          # ...and it is still a fist
