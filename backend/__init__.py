"""Flask application factory."""
import os

from flask import Flask

from config import Config
from . import database
from .hand_tracker import HandTracker
from .routes import api, pages


def create_app(test_config=None):
    app = Flask(
        __name__,
        template_folder=os.path.join("..", "frontend", "templates"),
        static_folder=os.path.join("..", "frontend", "static"),
    )
    app.config.from_object(Config)
    if test_config:
        app.config.update(test_config)

    os.makedirs(os.path.dirname(app.config["DATABASE"]), exist_ok=True)
    os.makedirs(app.config["DRAWING_DIR"], exist_ok=True)
    database.init_app(app)

    # The hand tracker is created once and shared by all requests.
    app.extensions["tracker"] = HandTracker(
        model_complexity=app.config["MODEL_COMPLEXITY"],
        min_detection=app.config["MIN_DETECTION_CONFIDENCE"],
        min_tracking=app.config["MIN_TRACKING_CONFIDENCE"],
    )

    app.register_blueprint(pages)
    app.register_blueprint(api, url_prefix="/api")
    return app
