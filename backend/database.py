"""SQLite storage for saved drawings (standard library only)."""
import json
import sqlite3

from flask import current_app, g

SCHEMA = """
CREATE TABLE IF NOT EXISTS drawings (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    ts           TEXT    NOT NULL DEFAULT (datetime('now', 'localtime')),
    title        TEXT    NOT NULL,
    width        INTEGER NOT NULL,
    height       INTEGER NOT NULL,
    stroke_count INTEGER NOT NULL,
    filename     TEXT    NOT NULL,
    strokes      TEXT    NOT NULL
);
"""


def get_db():
    if "db" not in g:
        g.db = sqlite3.connect(current_app.config["DATABASE"])
        g.db.row_factory = sqlite3.Row
    return g.db


def close_db(_exc=None):
    db = g.pop("db", None)
    if db is not None:
        db.close()


def init_app(app):
    app.teardown_appcontext(close_db)
    with app.app_context():
        get_db().executescript(SCHEMA)
        get_db().commit()


def add_drawing(title, width, height, strokes, filename):
    db = get_db()
    cur = db.execute(
        "INSERT INTO drawings (title, width, height, stroke_count, filename, strokes) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (title, width, height, len(strokes), filename, json.dumps(strokes)))
    db.commit()
    return cur.lastrowid


def list_drawings():
    rows = get_db().execute(
        "SELECT id, ts, title, width, height, stroke_count, filename "
        "FROM drawings ORDER BY id DESC").fetchall()
    return [dict(r) for r in rows]


def get_drawing(drawing_id):
    row = get_db().execute("SELECT * FROM drawings WHERE id = ?", (drawing_id,)).fetchone()
    if row is None:
        return None
    data = dict(row)
    data["strokes"] = json.loads(data["strokes"])
    return data


def rename_drawing(drawing_id, title):
    db = get_db()
    cur = db.execute("UPDATE drawings SET title = ? WHERE id = ?", (title, drawing_id))
    db.commit()
    return cur.rowcount > 0


def delete_drawing(drawing_id):
    db = get_db()
    db.execute("DELETE FROM drawings WHERE id = ?", (drawing_id,))
    db.commit()
