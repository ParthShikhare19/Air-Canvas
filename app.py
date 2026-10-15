"""Entry point:  python app.py  ->  http://127.0.0.1:5000"""
from backend import create_app

app = create_app()

if __name__ == "__main__":
    # threaded=True keeps the page responsive while a frame is being analysed
    app.run(host="127.0.0.1", port=5000, debug=False, threaded=True)
