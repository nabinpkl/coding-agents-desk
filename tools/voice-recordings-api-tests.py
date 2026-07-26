"""Live checks for the voice sidecar's recordings REST surface.

Covers what the panel's recordings list depends on and what unit tests cannot
see: newest-first ordering, wav playback, delete, and that all of it is
readable from the embedded webview's cross-origin (interactionfeed://) context.

Needs a running voice server. `just voice-recordings-smoke` starts one against a
scratch data root and runs this; it is deliberately out of `just check`, which
stays fast and does not spin up the Python voice stack.

Usage: voice-recordings-api-tests.py [base-url]   (default http://127.0.0.1:7699)
"""

from __future__ import annotations

import base64
import json
import struct
import sys
import time
import urllib.error
import urllib.request

BASE = (sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:7699").rstrip("/")
# The embedded panel's origin. Every assertion runs through it so a CORS
# regression fails here rather than only in the webview.
ORIGIN = "interactionfeed://app"

failures = []


def check(label, condition, detail=""):
    print(f"{'PASS' if condition else 'FAIL'}  {label}{f'  [{detail}]' if detail else ''}")
    if not condition:
        failures.append(label)


def call(method, path, body=None):
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(f"{BASE}{path}", data=data, method=method)
    request.add_header("Origin", ORIGIN)
    if data is not None:
        request.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, response.read(), dict(response.headers)
    except urllib.error.HTTPError as error:
        return error.code, error.read(), dict(error.headers)


def save(transcript):
    """Persist 0.1 s of silence, which is enough to produce a real wav on disk."""
    samples = 1600
    pcm = base64.b64encode(struct.pack(f"<{samples}h", *([0] * samples))).decode()
    status, payload, _ = call(
        "POST",
        "/recordings",
        {
            "pcm": pcm,
            "sampleRate": 16000,
            "encoding": "int16",
            "transcript": transcript,
        },
    )
    if status != 200:
        raise SystemExit(f"save failed: {status} {payload!r}")
    return json.loads(payload)["id"]


older = save("older take")
time.sleep(1.1)  # recording ids carry second resolution; keep the two distinct
newer = save("newer take")

_, payload, _ = call("GET", "/recordings")
listed = [r["id"] for r in json.loads(payload)["recordings"]]
check("list returns both recordings", sorted(listed) == sorted([older, newer]), str(listed))
check("newest recording is first", listed[0] == newer, f"first={listed[0]} newest={newer}")

status, payload, headers = call("GET", f"/recordings/{newer}/audio")
check("audio returns 200", status == 200, str(status))
check("audio is a wav", headers.get("content-type") == "audio/wav", str(headers.get("content-type")))
check("audio has bytes", len(payload) > 44, f"{len(payload)} bytes")
check("audio starts with RIFF", payload[:4] == b"RIFF", repr(payload[:4]))
check(
    "audio is cross-origin readable",
    headers.get("access-control-allow-origin") == ORIGIN,
    str(headers.get("access-control-allow-origin")),
)

status, _, _ = call("GET", "/recordings/session-19700101-000000-000000/audio")
check("audio 404s for an unknown id", status == 404, str(status))
status, _, _ = call("GET", "/recordings/..%2f..%2fetc%2fpasswd/audio")
check("audio rejects a traversal id", status in (400, 404, 422), str(status))

status, _, headers = call("DELETE", f"/recordings/{older}")
check("delete returns 204", status == 204, str(status))
check(
    "delete is cross-origin allowed",
    headers.get("access-control-allow-origin") == ORIGIN,
    str(headers.get("access-control-allow-origin")),
)

status, _, _ = call("GET", f"/recordings/{older}")
check("deleted recording is gone", status == 404, str(status))
status, _, _ = call("GET", f"/recordings/{older}/audio")
check("deleted audio is gone", status == 404, str(status))
_, payload, _ = call("GET", "/recordings")
remaining = [r["id"] for r in json.loads(payload)["recordings"]]
check("list drops the deleted recording", remaining == [newer], str(remaining))
status, _, _ = call("DELETE", f"/recordings/{older}")
check("second delete 404s", status == 404, str(status))

print()
if failures:
    print(f"{len(failures)} FAILED: {', '.join(failures)}")
    sys.exit(1)
print("all checks passed")
