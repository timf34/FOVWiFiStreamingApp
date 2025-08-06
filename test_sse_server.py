# save as test_sse_server.py
from flask import Flask, Response
import time, json

app = Flask(__name__)

@app.route("/stream")
def stream():
    def event_stream():
        while True:
            data = {
                "x": 12.34,
                "y": 56.78,
                "t": time.time()
            }
            yield f"data: {json.dumps(data)}\n\n"
            time.sleep(0.2)  # ~5fps
    return Response(event_stream(), mimetype="text/event-stream")

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=5000, threaded=True)
