"""Hand tracking with MediaPipe Hands (open source, Google).

MediaPipe uses two small neural networks:
  1. a palm detector finds the hand in the whole picture
  2. a landmark model predicts 21 3-D points on that hand (wrist, each finger joint, fingertips)
Once a hand is found, later frames only run the landmark model on the area where the
hand was before (tracking mode), which is why it is fast enough for live video.
"""
import os
import threading
import time
import warnings

# Silence the very chatty TensorFlow Lite / protobuf start-up messages.
os.environ.setdefault("GLOG_minloglevel", "2")
os.environ.setdefault("TF_CPP_MIN_LOG_LEVEL", "3")
warnings.filterwarnings("ignore", category=UserWarning, module="google.protobuf")

import cv2  # noqa: E402
import mediapipe as mp  # noqa: E402


class HandTracker:
    def __init__(self, model_complexity=1, min_detection=0.6, min_tracking=0.5):
        self._settings = dict(
            static_image_mode=False,      # False = track between frames (faster, smoother)
            max_num_hands=1,              # one drawing hand keeps gestures unambiguous
            model_complexity=model_complexity,
            min_detection_confidence=min_detection,
            min_tracking_confidence=min_tracking,
        )
        self._lock = threading.Lock()     # a MediaPipe graph is not thread-safe
        self._hands = mp.solutions.hands.Hands(**self._settings)

    def reset(self):
        """Forget the previous hand position (call when the camera restarts)."""
        with self._lock:
            self._hands.close()
            self._hands = mp.solutions.hands.Hands(**self._settings)

    def process(self, bgr):
        """Return (hand, milliseconds). hand is None when no hand is visible, otherwise
        {"landmarks": [[x, y, z] * 21] (x, y normalised 0..1), "handedness", "score"}."""
        rgb = cv2.cvtColor(bgr, cv2.COLOR_BGR2RGB)
        rgb.flags.writeable = False
        start = time.perf_counter()
        with self._lock:
            result = self._hands.process(rgb)
        ms = (time.perf_counter() - start) * 1000.0
        if not result.multi_hand_landmarks:
            return None, ms
        landmarks = [[round(p.x, 4), round(p.y, 4), round(p.z, 4)]
                     for p in result.multi_hand_landmarks[0].landmark]
        side = result.multi_handedness[0].classification[0]
        return {"landmarks": landmarks, "handedness": side.label,
                "score": round(float(side.score), 3)}, ms
