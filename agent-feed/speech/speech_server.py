# The speech process: an agent's text made into speech on this Mac and pushed to every page
# listening, which plays it into its own mix. Started and restarted by the sidecar's supervisor
# beside the audio process. The sidecar sends a Bot session's announcements to `/say`
# (`agent-feed/sidecar/src/push/sessionSpeech.ts`).
#
# One resident Kitten TTS nano 0.8 (fp32 ONNX, CPU, about 240 MB) with espeak-ng in-process for
# pronunciation. A message is cut into pieces, the first a few words long so it is heard soon, and
# each piece is made and pushed once what was pushed before it is within LEAD_S of finishing on the
# page. Making is many times faster than playing, so sending a whole message at once put tens of
# seconds of audio in flight (96 KB a second of it), and a stop or the next message waited behind
# all of it. Messages are made one at a time, in the order they arrived, so two never interleave.
#
#   GET  /listen   the push stream: frames of uint32 LE header length, JSON header (with the speed
#                  the piece was made at), uint32 LE PCM byte length, float32 PCM at 24 kHz. An empty
#                  frame at once and every 5 s after keeps it alive.
#   POST /say      <- {text, tone?, ref?}  -> {listeners, durationMs, cancelled} once the whole message is
#                  made (or cancelled), or 409 nobody_listening with no stream open (nothing is made).
#                  `tone` (attention or done) rides the first piece's header; the page plays it before
#                  the words. `ref` names the caller's message, so it can be cancelled by that name.
#   GET  /events   the control stream: one JSON object a line, {"stop": message} when a message is
#                  cancelled, a bare newline at once and every 5 s after. Its own stream so a stop is
#                  never queued behind audio still on its way down /listen.
#   POST /cancel   <- {message} or {ref}  the rest of that message is not made, and every page is told
#                  to drop what it holds of it: on /events at once, and on /listen as a stop frame
#                  ({stop: message}, no audio) for a page that has no control stream
#   POST /ack      <- the page's timings for a message's first piece, logged
#   GET  /speed    -> {speed}; POST /speed <- {speed} sets how fast every later message is spoken
#                  (Kitten's own rate, so the pitch stays; clamped to SPEEDS)
#   GET  /ping     204, for the page to time a round trip
#
# Usage: python speech_server.py --port 7690 --models <dir with model.onnx, voices.npz, symbols.json>

import argparse
import itertools
import json
import os
import queue
import re
import select
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import espeakng_loader
import numpy as np
import onnxruntime as ort
from phonemizer.backend.espeak.wrapper import EspeakWrapper

# espeak-ng's library and data ship inside espeakng_loader; the phonemizer is told before it loads.
EspeakWrapper.set_library(espeakng_loader.get_library_path())
os.environ["ESPEAK_DATA_PATH"] = espeakng_loader.get_data_path()
from phonemizer.backend import EspeakBackend  # noqa: E402  (needs the library set first)

SAMPLE_RATE = 24_000
VOICE = "expr-voice-3-f"  # Kitten's "Luna"
SPEEDS = (0.5, 4.0)  # the rates /speed accepts; 1 is the model's own pace, higher is faster
# The fastest the model itself is asked for. Past it, it barely speeds up (measured 2026-10-21, with
# the silence the page trims taken out: 2x 3.0 s, 3x 2.5 s, 4x 2.2 s for one sentence), so a piece is
# made at no more than this and stamped with it, and the page stretches it the rest of the way.
MODEL_MAX_SPEED = 2.0
FIRST_WORDS = 4  # the first piece, short so it is heard soon
MAX_WORDS = 8  # every later piece, at most
KEEPALIVE_S = 5.0
# How far ahead of the page's playback a message is sent: room for a network hiccup, and all that is
# in flight to throw away when it is stopped.
LEAD_S = 3.0
CLAUSE = re.compile(r"[^,.!?;:]+[,.!?;:]?")


def trimmed(audio: np.ndarray) -> np.ndarray:
    """A piece without the silence Kitten leaves around it, kept to 30 ms before the first sound and 60 ms
    after the last. A page trims by the same rule before it plays a piece, so pacing by the untrimmed
    length ran ahead of the page by about a third, measured, and let its buffer run dry every few
    seconds. Trimmed here, what this paces by is what the page plays, and the silence is not sent at
    all. Trimming twice changes nothing."""
    loud = np.flatnonzero(np.abs(audio) > 0.01)
    if loud.size == 0:
        return audio[:1]
    return audio[max(0, loud[0] - 720) : min(len(audio), loud[-1] + 1440)]


def log(line: str) -> None:
    print(f"[speech] {line}", flush=True)


class Voice:
    """Kitten and espeak-ng, loaded once. `make` is safe from any thread; runs take turns."""

    def __init__(self, models: Path):
        symbols = json.loads((models / "symbols.json").read_text())
        self.index = {symbol: i for i, symbol in enumerate(symbols)}  # last wins, as in Kitten's own code
        self.styles = np.load(models / "voices.npz")[VOICE]
        self.session = ort.InferenceSession(str(models / "model.onnx"), providers=["CPUExecutionProvider"])
        self.espeak = EspeakBackend(language="en-us", preserve_punctuation=True, with_stress=True)
        self.lock = threading.Lock()
        self.speed = 0.8  # what the experiment settled on before there was a slider

    def make(self, piece: str, speed: float | None = None) -> tuple[np.ndarray, float, float]:
        """`piece` as samples at SAMPLE_RATE (at `speed`, or the current one), with ms spent
        pronouncing and in the model."""
        started = time.perf_counter()
        phonemes = self.espeak.phonemize([piece])[0]
        pronounced = time.perf_counter()
        tokens = " ".join(re.findall(r"\w+|[^\w\s]", phonemes))
        ids = [0] + [self.index[c] for c in tokens if c in self.index] + [10, 0]
        row = min(len(piece), self.styles.shape[0] - 1)
        with self.lock:
            out = self.session.run(None, {
                "input_ids": np.array([ids], dtype=np.int64),
                "style": self.styles[row : row + 1],
                "speed": np.array([speed or self.speed], dtype=np.float32),
            })[0]
        done = time.perf_counter()
        return np.asarray(out, dtype=np.float32).reshape(-1), (pronounced - started) * 1000, (done - pronounced) * 1000


def pieces(text: str) -> list[str]:
    """The first few words (up to the first clause's end), then clauses of at most MAX_WORDS words."""
    words = text.split()
    first_clause = CLAUSE.match(text)
    head = min(FIRST_WORDS, len(first_clause.group(0).split()) if first_clause else len(words))
    out = [" ".join(words[:head])]
    for clause in CLAUSE.findall(" ".join(words[head:])):
        clause_words = clause.split()
        out += [" ".join(clause_words[i : i + MAX_WORDS]) for i in range(0, len(clause_words), MAX_WORDS)]
    return [piece for piece in out if piece]


def frame(header: dict, pcm: bytes) -> bytes:
    encoded = json.dumps(header).encode()
    return struct.pack("<I", len(encoded)) + encoded + struct.pack("<I", len(pcm)) + pcm


KEEPALIVE = frame({}, b"")


class Channel:
    """The open push streams, and the messages being made for them."""

    def __init__(self, voice: Voice):
        self.voice = voice
        self.listeners: list[queue.Queue[bytes]] = []
        self.watchers: list[queue.Queue[bytes]] = []  # the control streams
        self.listeners_lock = threading.Lock()
        self.changed = threading.Condition()  # told when a message is cancelled, to end a paced wait
        self.say_lock = threading.Lock()
        self.ids = itertools.count(1)
        self.cancelled: set[int] = set()
        # The newest message each caller's ref named: a ref is reused (one per Bot, one for reading
        # a reply aloud), and cancelling it means the latest.
        self.refs: dict[str, int] = {}

    def listening(self) -> int:
        with self.listeners_lock:
            return len(self.listeners)

    def push(self, data: bytes) -> None:
        with self.listeners_lock:
            for listener in self.listeners:
                listener.put(data)

    def tell(self, event: dict) -> None:
        line = (json.dumps(event) + "\n").encode()
        with self.listeners_lock:
            for watcher in self.watchers:
                watcher.put(line)

    def cancel(self, message: int) -> None:
        """Stops making `message` and tells every page to drop what it already has of it."""
        with self.changed:
            self.cancelled.add(message)
            self.changed.notify_all()
        self.tell({"stop": message})
        self.push(frame({"stop": message}, b""))
        log(f"cancel #{message}")

    def say(self, text: str, tone: str | None = None, ref: str | None = None) -> tuple[float, bool]:
        """Makes and pushes `text` piece by piece, after any message before it, paced to LEAD_S ahead
        of the page's playback. Returns how long it plays, in ms, and whether it was cancelled part
        way; it returns about LEAD_S before the page finishes playing it."""
        # Numbered before waiting its turn, so a cancel by ref reaches a message still waiting.
        message = next(self.ids)
        if ref:
            self.refs[ref] = message
        with self.say_lock:
            received = time.perf_counter()
            parts = pieces(text)
            duration_ms = 0.0
            # When what has been pushed of this message finishes playing on the page.
            played_by = time.monotonic()
            for i, piece in enumerate(parts):
                wait = played_by - LEAD_S - time.monotonic()
                if wait > 0:
                    with self.changed:
                        self.changed.wait_for(lambda: message in self.cancelled, timeout=wait)
                if message in self.cancelled:
                    log(f"#{message}: cancelled, {len(parts) - i} piece(s) not made")
                    return duration_ms, True
                # Stamped on the piece: the page stretches it from this to the listener's speed.
                speed = min(self.voice.speed, MODEL_MAX_SPEED)
                audio, espeak_ms, model_ms = self.voice.make(piece, speed)
                audio = trimmed(audio)
                # As the page plays it: the pause it leaves after a clause, and stretched from the speed
                # it was made at to the listener's.
                pause = 0.28 if re.search(r"[.!?]$", piece) else 0.12 if re.search(r"[,;:]$", piece) else 0.0
                plays_s = (len(audio) / SAMPLE_RATE + pause) * speed / self.voice.speed
                duration_ms += plays_s * 1000
                played_by = max(played_by, time.monotonic()) + plays_s
                mac_ms = (time.perf_counter() - received) * 1000
                self.push(frame({
                    "message": message, "index": i, "last": i == len(parts) - 1, "text": piece, "speed": speed,
                    **({"tone": tone} if tone and i == 0 else {}),
                    "espeakMs": round(espeak_ms, 2), "modelMs": round(model_ms, 1), "macMs": round(mac_ms, 1),
                }, audio.tobytes()))
                if i == 0:
                    log(f"#{message}: first piece out after {mac_ms:.0f} ms (model {model_ms:.0f} ms) "
                        f"to {self.listening()} listener(s)")
            return duration_ms, message in self.cancelled


def handler_for(channel: Channel, port: int) -> type[BaseHTTPRequestHandler]:
    # Only the sidecar and the audio process call this, server to server, so no browser ever should.
    # A browser does not treat loopback as a boundary: any page open in it can POST here (a
    # text/plain body needs no preflight), and a page whose name is re-pointed at 127.0.0.1 (DNS
    # rebinding) could read /listen. So the Host must name this port on loopback, and a request
    # carrying either header a browser adds to what a page sends is refused.
    hosts = {f"127.0.0.1:{port}", f"localhost:{port}"}

    class Handler(BaseHTTPRequestHandler):
        def foreign(self) -> bool:
            host = self.headers.get("host", "")
            if host not in hosts:
                self.refuse(400, "host-not-allowed", f"host not allowed: {host}")
                return True
            if self.headers.get("origin") is not None or self.headers.get("sec-fetch-site") is not None:
                self.refuse(403, "browser-request", "the speech process takes no request from a browser")
                return True
            return False

        def answer(self, status: int, body: dict | None = None) -> None:
            data = json.dumps(body).encode() if body is not None else b""
            self.send_response(status)
            if body is not None:
                self.send_header("content-type", "application/json")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def refuse(self, status: int, code: str, message: str) -> None:
            self.answer(status, {"error": {"code": code, "message": message, "retryable": status >= 500}})

        def do_GET(self) -> None:
            if self.foreign():
                return
            if self.path.startswith("/ping"):
                self.answer(204)
            elif self.path.startswith("/speed"):
                self.answer(200, {"speed": channel.voice.speed})
            elif self.path.startswith("/listen"):
                self.stream(channel.listeners, "listener", KEEPALIVE, "application/octet-stream")
            elif self.path.startswith("/events"):
                self.stream(channel.watchers, "watcher", b"\n", "application/x-ndjson")
            else:
                self.refuse(404, "route-not-found", f"the speech process has no route GET {self.path}")

        def stream(self, subscribers: list, kind: str, keepalive: bytes, content_type: str) -> None:
            inbox: queue.Queue[bytes] = queue.Queue()
            with channel.listeners_lock:
                subscribers.append(inbox)
                count = len(subscribers)
            log(f"{kind} joined ({count})")
            self.send_response(200)
            self.send_header("content-type", content_type)
            self.send_header("cache-control", "no-store")
            self.end_headers()
            try:
                # Something at once, so the page's stream opens now rather than at the first keepalive.
                self.wfile.write(keepalive)
                self.wfile.flush()
                while True:
                    try:
                        data = inbox.get(timeout=KEEPALIVE_S)
                    except queue.Empty:
                        data = keepalive
                    self.wfile.write(data)
                    self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                with channel.listeners_lock:
                    subscribers.remove(inbox)
                    count = len(subscribers)
                log(f"{kind} left ({count})")

        def do_POST(self) -> None:
            if self.foreign():
                return
            try:
                body = json.loads(self.rfile.read(int(self.headers.get("content-length") or 0)) or b"{}")
            except json.JSONDecodeError:
                self.refuse(400, "invalid_message", "body is not JSON")
                return
            if self.path.startswith("/say"):
                text = body.get("text")
                if not isinstance(text, str) or not text.strip():
                    self.refuse(400, "invalid_message", "expected { text } with something to say")
                elif channel.listening() == 0:
                    self.refuse(409, "nobody_listening", "no page is listening to the Mac, so nothing was said")
                else:
                    heard_by = channel.listening()
                    tone = body.get("tone") if body.get("tone") in ("attention", "done") else None
                    ref = body.get("ref") if isinstance(body.get("ref"), str) else None
                    duration_ms, cancelled = channel.say(text, tone, ref)
                    self.answer(200, {"listeners": heard_by, "durationMs": round(duration_ms), "cancelled": cancelled})
            elif self.path.startswith("/speed"):
                speed = body.get("speed")
                if not isinstance(speed, (int, float)) or isinstance(speed, bool):
                    self.refuse(400, "invalid_speed", "expected { speed } as a number")
                    return
                channel.voice.speed = round(min(SPEEDS[1], max(SPEEDS[0], float(speed))), 2)
                log(f"speed {channel.voice.speed}")
                self.answer(200, {"speed": channel.voice.speed})
            elif self.path.startswith("/cancel"):
                ref = body.get("ref")
                message = channel.refs.get(ref) if isinstance(ref, str) else body.get("message")
                if isinstance(message, int) and not isinstance(message, bool):
                    channel.cancel(message)
                # Nothing by that name is not an error: whatever it named is already gone.
                self.answer(204)
            elif self.path.startswith("/ack"):
                log(f"heard #{body.get('message')}: {json.dumps(body)}")
                self.answer(204)
            else:
                self.refuse(404, "route-not-found", f"the speech process has no route POST {self.path}")

        def log_message(self, *args: object) -> None:
            pass  # one line per request would bury the lines that say something

    return Handler


def leave_with_parent() -> None:
    """Exits once the process that started this one exits. The supervisor stops this on its way out,
    but one killed outright cannot, and an orphan would hold the port its replacement needs. Told by
    kqueue rather than found by polling: the kernel announces a process's exit."""
    parent = os.getppid()
    events = select.kqueue()
    try:
        events.control([select.kevent(parent, select.KQ_FILTER_PROC, select.KQ_EV_ADD, select.KQ_NOTE_EXIT)], 0)
        events.control(None, 1)  # blocks until the parent exits
    except ProcessLookupError:
        pass  # it was already gone
    log(f"the process that started this ({parent}) is gone; leaving")
    os._exit(0)


def main() -> None:
    parser = argparse.ArgumentParser(description="AgentDesk's speech process")
    parser.add_argument("--port", type=int, required=True)
    parser.add_argument("--models", type=Path, required=True)
    args = parser.parse_args()
    threading.Thread(target=leave_with_parent, daemon=True, name="leave-with-parent").start()
    voice = Voice(args.models)
    # Warm up: the first runs of the model are slow, so they are paid here, not by the first message.
    for text in ("Warming up.", "The build finished on", "The build finished on the Mac, all the tests passed."):
        voice.make(text)
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(Channel(voice), args.port))
    server.daemon_threads = True
    log(f"ready on 127.0.0.1:{args.port}, models from {args.models}")
    server.serve_forever()


if __name__ == "__main__":
    main()
