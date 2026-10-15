"""Application settings."""
import os

BASE_DIR = os.path.abspath(os.path.dirname(__file__))


class Config:
    DATABASE = os.path.join(BASE_DIR, "instance", "air_canvas.db")
    DRAWING_DIR = os.path.join(BASE_DIR, "instance", "drawings")

    # MediaPipe Hands. model_complexity: 0 = fastest, 1 = more accurate fingertips.
    MODEL_COMPLEXITY = int(os.environ.get("MODEL_COMPLEXITY", 1))
    MIN_DETECTION_CONFIDENCE = 0.6
    MIN_TRACKING_CONFIDENCE = 0.5

    MAX_CONTENT_LENGTH = 12 * 1024 * 1024
    MAX_STROKES = 2000
    MAX_POINTS_PER_STROKE = 5000
