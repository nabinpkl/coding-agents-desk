# The speech process: an agent's text made into speech on this Mac and pushed to every page
# listening, which plays it into its own mix. Started and restarted by the sidecar's supervisor
# beside the audio process. The sidecar sends a Bot session's announcements, and replies read out
# loud, to `/say` (`agent-feed/sidecar/src/push/sessionSpeech.ts`).
#
# One resident Phonon 31M English (Gradium, Apache-2.0) on the Mac's GPU, through its `ptts` runtime:
# about 235 MB, measured 2026-10-21. It reads text through its own tokenizer, so a word like "tmux" or
# "ADR" is not guessed from spelling rules, and it makes speech one 80 ms frame at a time. Each frame
# is pushed as it is made, so the first is heard within milliseconds, and the rest are paced to LEAD_S
# ahead of the page's playback: making runs 8 to 16 times faster than playing, and sending ahead of
# that would put tens of seconds in flight for a stop to wait behind. Messages are made one at a
# time, in the order they arrived, so two never interleave.
#
#   GET  /listen   the push stream: frames of uint32 LE header length, JSON header, uint32 LE PCM byte
#                  length, float32 mono PCM at 24 kHz, made at the voice's own pace (the page stretches
#                  it to its speed). An empty frame at once and every 5 s after keeps it alive.
#   POST /say      <- {text, tone?, ref?}  -> {listeners, durationMs, cancelled} once the whole message is
#                  made (or cancelled), or 409 nobody_listening with no stream open (nothing is made).
#                  `tone` (attention or done) rides the first frame's header; the page plays it before
#                  the words. `ref` names the caller's message, so it can be cancelled by that name.
#   GET  /events   the control stream: one JSON object a line, {"stop": message} when a message is
#                  cancelled, a bare newline at once and every 5 s after. Its own stream so a stop is
#                  never queued behind audio still on its way down /listen.
#   POST /cancel   <- {message} or {ref}  the rest of that message is not made, and every page is told
#                  to drop what it holds of it: on /events at once, and on /listen as a stop frame
#                  ({stop: message}, no audio) for a page that has no control stream
#   GET  /voices   -> {voice, voices: [{name, locale, gender, description}]}: the voice in use, and
#                  every voice it can switch to
#   POST /voice    <- {voice}  -> {voice}: speaks every later message in that voice
#   POST /ack      <- the page's timings for a message's first frame, logged
#   GET  /speed    -> {speed}; POST /speed <- {speed}: how fast the pages play speech (they stretch it),
#                  which is how this paces what it sends and how long it reports a message plays
#   GET  /ping     204, for the page to time a round trip
#
# Usage: python speech_server.py --port 7690 --models <dir that `fetch_voice.py` filled>

import argparse
import itertools
import json
import os
import queue
import select
import struct
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import numpy as np
import ptts

SAMPLE_RATE = 24_000
# The voice built into the model's checkpoint; every other one is read from the catalog beside it.
BUILT_IN_VOICE = "default"
SPEEDS = (0.5, 4.0)  # the playback speeds /speed accepts; 1 is the voice's own pace
KEEPALIVE_S = 5.0
# How far ahead of the page's playback a message is sent: room for a network hiccup, and all that is
# in flight to throw away when it is stopped.
LEAD_S = 3.0


def log(line: str) -> None:
    print(f"[speech] {line}", flush=True)


class Voice:
    """Phonon on the GPU, the voices it can speak in, and the one in use. Read by one message at a time."""

    def __init__(self, models: Path):
        catalog = models / "voices"
        self.catalog = [json.loads(line) for line in (catalog / "voices.jsonl").read_text().splitlines() if line.strip()]
        # On the GPU or not at all: the CPU took 15 s for a paragraph the GPU made in 0.9 s (2026-10-21).
        self.tts = ptts.TTS(str(models), lang="en", quant="f32", device="metal", voice_catalog=str(catalog))
        self.name = BUILT_IN_VOICE
        self.speed = 1.0  # how fast the pages play it, told by them on every connection

    def choices(self) -> list[dict]:
        built_in = {"name": BUILT_IN_VOICE, "locale": None, "gender": None, "description": "The model's own voice"}
        keep = ("name", "locale", "gender", "description")
        return [built_in] + [{key: row.get(key) for key in keep} for row in self.catalog]

    def knows(self, name: str) -> bool:
        return any(choice["name"] == name for choice in self.choices())


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
        """Makes and pushes `text` frame by frame, after any message before it, paced to LEAD_S ahead of
        the page's playback. Returns how long it plays, in ms, and whether it was cancelled part way;
        it returns about LEAD_S before the page finishes playing it."""
        # Numbered before waiting its turn, so a cancel by ref reaches a message still waiting.
        message = next(self.ids)
        if ref:
            self.refs[ref] = message
        with self.say_lock:
            received = time.perf_counter()
            voice, speed = self.voice.name, self.voice.speed
            played_s = 0.0
            # When what has been pushed of this message finishes playing on the page.
            played_by = time.monotonic()
            with self.voice.tts.stream(text, voice=voice) as audio:
                for index, chunk in enumerate(audio):
                    wait = played_by - LEAD_S - time.monotonic()
                    if wait > 0:
                        with self.changed:
                            self.changed.wait_for(lambda: message in self.cancelled, timeout=wait)
                    if message in self.cancelled:
                        log(f"#{message}: cancelled after {played_s:.1f} s of it")
                        return played_s * 1000, True
                    pcm = np.asarray(chunk, dtype="<f4").reshape(-1)
                    plays_s = len(pcm) / SAMPLE_RATE / speed
                    played_s += plays_s
                    played_by = max(played_by, time.monotonic()) + plays_s
                    header = {"message": message, "index": index}
                    if index == 0:
                        mac_ms = (time.perf_counter() - received) * 1000
                        header.update({"text": text[:200], "voice": voice, "macMs": round(mac_ms, 1), **({"tone": tone} if tone else {})})
                        log(f"#{message}: first audio out after {mac_ms:.0f} ms, in {voice}, to {self.listening()} listener(s)")
                    self.push(frame(header, pcm.tobytes()))
            return played_s * 1000, message in self.cancelled


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
            elif self.path.startswith("/voices"):
                self.answer(200, {"voice": channel.voice.name, "voices": channel.voice.choices()})
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
            elif self.path.split("?")[0] == "/voice":  # exactly, so /voices is not taken for it
                name = body.get("voice")
                if not isinstance(name, str) or not channel.voice.knows(name):
                    self.refuse(400, "unknown_voice", f"expected {{ voice }} naming one of GET /voices, not {name!r}")
                    return
                if name != channel.voice.name:
                    channel.voice.name = name
                    log(f"voice {name}")
                self.answer(200, {"voice": channel.voice.name})
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
    # Warm up: the first run builds the GPU's kernels, so it is paid here, not by the first message.
    voice.tts.synth("Warming up the voice.")
    server = ThreadingHTTPServer(("127.0.0.1", args.port), handler_for(Channel(voice), args.port))
    server.daemon_threads = True
    log(f"ready on 127.0.0.1:{args.port}: Phonon on {voice.tts.device}, {len(voice.catalog)} catalog voices, from {args.models}")
    server.serve_forever()


if __name__ == "__main__":
    main()
