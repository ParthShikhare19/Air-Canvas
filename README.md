# Air Canvas: draw in the air with your hand

A full-stack web app where you **draw with your index finger in front of the webcam**.
A hand-tracking AI reads 21 points on your hand, a gesture engine decides what your hand
is doing, and the canvas follows. Wobbly circles and squares are **snapped into perfect
shapes**, and drawings can be saved, replayed and exported as PNG or SVG.

**Open-source tools at the core: [MediaPipe Hands](https://github.com/google-ai-edge/mediapipe)**
(Google, hand tracking) **and [OpenCV](https://opencv.org)** (shape recognition).
It runs fully **offline**: the hand model is bundled inside the MediaPipe package, so there are
no API keys, no cloud and no downloads at demo time.

## Why it is more than "a finger follows the mouse"
| Feature | What it shows |
|---|---|
| Hand tracking: 21 landmarks per frame | Real computer vision with a two-stage neural network |
| **Gesture engine** written from scratch (`backend/gestures.py`) | Geometry on landmarks, works when the hand is tilted or rotated |
| **One Euro filter** on the fingertip (`filters.js`) | Removes hand tremor without making fast strokes lag |
| **On-canvas toolbar** you press by hovering with two fingers | Hands-free UI with dwell-time selection |
| **Shape snapping** (`backend/shapes.py`, OpenCV) | Draw a wobbly circle, get a perfect one (also square, rectangle, triangle, ellipse, line) |
| Vector strokes (`board.js`) | Undo / redo, "erase whole stroke", replay animation, SVG export |
| Hold-to-confirm gestures with a progress ring | Clear, save and undo can never fire by accident |
| REST API + SQLite gallery + 64 automated tests | Full-stack engineering |
| Mouse fallback | Works even if the camera fails during your demo |

## Gestures
| Hand | Action |
|---|---|
| ☝️ One finger | **Draw** |
| ✌️ Two fingers | **Choose** from the top toolbar (hover about half a second over a button) |
| 🤏 Pinch | **Erase** every stroke the circle touches |
| 3️⃣ Three fingers, hold 0.7 s | **Undo** |
| 🖐️ Open palm, hold 1.2 s | **Clear** the canvas (Undo brings it back) |
| 👍 Thumbs up, hold 1 s | **Save** the drawing to the gallery |
| ✊ Fist / hand out of view | Pause |

The toolbar contains 8 colours, brush size, shape snapping on/off and undo.

## Tech stack
| Layer | Technology |
|---|---|
| Frontend | HTML5, CSS3, vanilla JavaScript, Canvas 2D, `getUserMedia` (webcam) |
| Backend | Python 3, Flask REST API |
| Hand tracking | MediaPipe Hands (palm detector + 21-point landmark network) |
| Shape recognition | OpenCV (`approxPolyDP`, `minAreaRect`, `fitEllipse`) + NumPy |
| Database | SQLite (Python standard library) |
| Testing | pytest (+ optional Node test for the drawing logic) |

## Folder structure
```
air-canvas/
├── app.py                     # entry point:  python app.py
├── config.py                  # settings (model complexity, limits)
├── requirements.txt
├── README.md · LICENSE
├── backend/
│   ├── __init__.py            # Flask app factory, creates the hand tracker once
│   ├── hand_tracker.py        # MediaPipe Hands wrapper
│   ├── gestures.py            # landmarks -> gesture (point, two, pinch, ...)
│   ├── shapes.py              # wobbly stroke -> perfect shape (OpenCV)
│   ├── strokes.py             # validation of drawing data + SVG export
│   ├── database.py            # SQLite: saved drawings
│   └── routes.py              # pages + REST API
├── frontend/
│   ├── templates/index.html
│   └── static/
│       ├── css/style.css
│       └── js/
│           ├── filters.js     # One Euro filter (smoothing)
│           ├── board.js       # vector strokes, undo/redo, erase, replay
│           └── app.js         # camera loop, gesture state machine, UI
├── tests/                     # pytest suite (+ tests/js/board.test.js)
└── instance/                  # database and saved PNGs are created here
```

## Setup and run
Requires **Python 3.9 to 3.12** (MediaPipe does not yet support 3.13) and a webcam is
recommended (the mouse works as a fallback).

**Windows**
```
python -m venv venv
venv\Scripts\activate
pip install -r requirements.txt
python app.py
```
**macOS / Linux**
```
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python app.py
```
Open **http://127.0.0.1:5000** (use `127.0.0.1` or `localhost`: browsers only allow the
camera on those addresses over plain HTTP). The first start takes a few seconds while
MediaPipe loads. Run the tests with `pytest -v`.

## Tips for the best tracking
* Sit about **50 to 80 cm** from the camera so your hand fills roughly a quarter of the picture.
* Use **good front light** (a window or lamp in front of you, not behind).
* A plain background helps. Keep your **palm facing the camera**.
* If gestures feel twitchy, raise `PINCH_RATIO` / `EXTENDED_RATIO` slightly in `backend/gestures.py`,
  or set `MODEL_COMPLEXITY=0` (faster) / `1` (more accurate, default).

## Suggested demo script (4 minutes)
1. Open the app and show the green *MediaPipe ready* badge. Say: "Runs locally, no cloud."
2. **Start camera.** Raise one finger and draw. Turn on **Show hand** to reveal the 21 tracked points.
3. Use **two fingers** over the top bar to change colour, then draw again.
4. Draw a wobbly **circle**, **square** and **triangle**: watch them snap into perfect shapes.
5. **Pinch** to erase a stroke. Hold **three fingers** to undo.
6. Hold a **thumbs up** to save. Open *Saved drawings*, press **Replay**, then download the **SVG**.
7. Hold an **open palm** to clear. Open `backend/gestures.py` and `backend/shapes.py` and run `pytest -v`.

> Do a full dry run first and allow the camera in your browser. If the room lighting is bad,
> switch the background to **Whiteboard** and demonstrate with the mouse as a backup.

## How it works (viva notes)
```
camera frame (mirrored) -> POST /api/hand -> MediaPipe -> 21 landmarks
   -> gesture rules -> JSON -> browser: One Euro filter on the fingertip
   -> gesture state machine -> strokes (vectors) -> canvas
finished stroke -> POST /api/shape -> OpenCV -> clean shape replaces the stroke
```
* **MediaPipe Hands** uses two neural networks: a *palm detector* finds the hand in the whole
  frame, then a *landmark model* predicts 21 3-D points (wrist, 4 joints per finger). After the
  first detection it only runs the landmark model around the previous hand position
  (*tracking mode*), so it takes just a few milliseconds per frame on a CPU.
* **Gesture rules** use distances, not "higher than". A finger is *extended* if its tip is farther
  from the wrist than its middle joint (PIP). The thumb is extended if its tip is far from the
  base of the index finger. A **pinch** is thumb tip close to index tip, relative to hand size.
  Using distances makes it work when the hand is rotated. A closed fist also puts the thumb
  near the index finger, so a pinch additionally requires the index finger not to be curled.
* **Why mirror the video?** So moving your hand right moves the cursor right, like a mirror.
* **Debouncing:** a gesture must repeat for 3 frames before it counts, and destructive actions
  need a hold with a visible progress ring. Otherwise the transition frames between two gestures
  would trigger random actions.
* **One Euro filter:** a hand in mid-air trembles by a few pixels. A plain average removes that
  but adds lag. This filter smooths strongly when the finger moves slowly and weakly when it
  moves fast. (Casiez et al., CHI 2012.) In our test it removed about 60% of the jitter while
  lagging only 8 px at 1200 px/s.
* **Vector strokes:** each stroke is a list of points, not pixels. That is what makes undo,
  "erase the whole stroke", replay and SVG export possible.
* **Shape snapping:** resample the stroke to evenly spaced points, smooth it, then:
  open and straight -> line; closed -> compute circularity `4*pi*area/perimeter^2` (circle 1.0,
  square 0.785) and simplify the outline with **Douglas-Peucker** (`approxPolyDP`). 4 corners that fill
  their bounding box -> rectangle/square, 3 corners -> triangle, smooth and round -> circle or
  ellipse (`fitEllipse`). Zig-zags, arcs and stars are deliberately left freehand.
* **Why the AI runs on the server:** the browser stays a thin client and the Python side is easy to
  test and extend. A round trip on localhost takes a few milliseconds.

**Likely questions**
* *Why not train your own model?* MediaPipe's models were trained on large hand datasets;
  using a pre-trained model is standard practice, and the project's own logic (gestures, filtering,
  shape recognition) is written and tested here.
* *Limitations?* One hand at a time; poor light, motion blur or fingers hidden behind the palm reduce
  accuracy; shape snapping covers 6 basic shapes; thresholds were tuned on a few hands and may need
  adjusting for yours.
* *Privacy?* Frames go only to your own machine (`127.0.0.1`) and are never stored.

## REST API
| Method | Endpoint | Description |
|---|---|---|
| POST | `/api/hand` | Body = one JPEG frame. Returns 21 landmarks, gesture, cursor, inference time |
| POST | `/api/hand/reset` | Forget the previous hand position |
| POST | `/api/shape` | `{"points": [[x, y], ...]}` -> recognised clean shape |
| GET / POST | `/api/drawings` | List / save a drawing (PNG + stroke data) |
| GET / PATCH / DELETE | `/api/drawings/<id>` | Load / rename / delete |
| GET | `/api/drawings/<id>/export.svg` | Download as SVG |
| GET | `/api/health` | Status |

## Troubleshooting
| Problem | Fix |
|---|---|
| `pip install` fails | Use Python 3.9 to 3.12 (not 3.13) and a fresh virtual environment |
| "Camera unavailable" | Allow camera access, close Zoom/Teams, open via `127.0.0.1` or `localhost` |
| Port 5000 busy (macOS AirPlay) | Change the port at the bottom of `app.py` |
| Hand not detected | More light, move back a little, palm toward the camera |
| Drawing is shaky | Hold still a moment, or ask for more smoothing: lower `minCutoff` in `app.js` (`createOneEuro(2.0, ...)`) |
| Slow / laggy | `MODEL_COMPLEXITY=0` (environment variable) and close other heavy apps |

## Future work
Two-hand gestures (zoom, rotate), more shapes, handwriting recognition, shared whiteboards over
WebSockets, custom gesture training from landmarks.

## License
Project code: MIT (see `LICENSE`). MediaPipe and OpenCV: Apache-2.0.
