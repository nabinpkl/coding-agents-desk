# The speech process: an agent's text made into speech on this Mac and pushed to every page
# listening, which plays it into its own mix. Started and restarted by the sidecar's supervisor
# beside the audio process. The sidecar sends a Bot session's announcements, and replies read out
# loud, to `/say` (`agent-feed/sidecar/src/push/sessionSpeech.ts`), and a reply one page plays on its
# own device to `/render`.
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
#   POST /say      <- {text, tone?, ref?, voice?, process?}  -> {listeners, durationMs, cancelled} once the
#                  whole message is made (or cancelled), or 409 nobody_listening with no stream open
#                  (nothing is made). `tone` (attention or done) rides the first frame's header; the page
#                  plays it before the words. `ref` names the caller's message, so it can be cancelled by
#                  that name. `voice` says it in one of GET /voices rather than the voice in use (a Bot's
#                  session has its own), 400 unknown_voice otherwise; `process` overrides `on` for it.
#   GET  /listeners -> {listeners}: how many push streams are open now, the count /say checks first
#   GET  /events   the control stream: one JSON object a line, {"stop": message} when a message is
#                  cancelled, a bare newline at once and every 5 s after. Its own stream so a stop is
#                  never queued behind audio still on its way down /listen.
#   POST /render   <- {text, ref}  -> 200, the message's speech as the body: float32 mono PCM at 24 kHz,
#                  each frame written as it is made, unpaced, then the body ends. For one page to play
#                  on its own device (the feed's speaker), so it skips /listen and the line /say keeps:
#                  it runs beside a message being said, on the same model (two streams at once measured
#                  sound and in time, 2026-10-22). Made in the voice in use.
#   POST /cancel   <- {message} or {ref}  the rest of that message is not made, and every page is told
#                  to drop what it holds of it: on /events at once, and on /listen as a stop frame
#                  ({stop: message}, no audio) for a page that has no control stream. A ref naming a
#                  /render stops making it, and its body ends.
#   GET  /voices   -> {voice, voices: [{name, locale, gender, description}]}: the voice in use, and
#                  every voice it can switch to
#   POST /voice    <- {voice}  -> {voice}: speaks every later message in that voice
#   GET  /processing -> {tuning, ranges}; POST /processing <- some of `tuning` -> the same: EXPERIMENT,
#                  whether speech is processed to be loud and clear (`Processing`) and how, kept on disk;
#                  /say's own `voice` and `process` override the voice in use and `on`, per message
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
# How long a /render write may sit blocked before its reader counts as gone: the sidecar never says
# when the page hung up, it only stops reading.
RENDER_WRITE_TIMEOUT_S = 10.0


def log(line: str) -> None:
    print(f"[speech] {line}", flush=True)


# EXPERIMENT: processing the voice so it is heard loud and clear over the page's noise. Each voice is
# brought to one level, its tone shaped, its quiet syllables lifted by a compressor, and its peaks held
# under a soft limiter. Measured offline on eight voices with the defaults below (2026-10-24): about
# 7 dB louder, quiet syllables about 8 dB up, voices within 1.4 dB of each other, the limiter
# touching under 1% of samples, and about 0.2 ms of work per 80 ms frame.
#
# Tuned live from the panel (`GET`/`POST /processing`): each frame reads the settings as they are,
# so a change is heard in the message already playing, LEAD_S after it is made.

# Each number the panel can set: (lowest, highest, step). The panel draws its sliders from these.
TUNING_RANGES = {
    "loudnessDb": (0.0, 24.0, 0.5),  # the gain put back after the compressor
    "thresholdDb": (-50.0, -10.0, 1.0),  # where the compressor starts turning speech down
    "ratio": (1.0, 10.0, 0.5),  # how hard it turns speech down past that
    "releaseMs": (20.0, 400.0, 5.0),  # how fast it lets go: fast lifts each quiet syllable
    "boomCutHz": (40.0, 300.0, 5.0),  # below this the boom is cut, 24 dB down at less than half of it
    "mudDb": (-9.0, 0.0, 0.5),  # the dip around 300 Hz, where a voice turns muddy
    "presenceDb": (0.0, 10.0, 0.5),  # the lift around 3 kHz, where consonants are
}
TUNING_DEFAULTS = {
    "on": False,
    "evenLevels": True,  # each voice brought to one level first, from its measured level
    "loudnessDb": 16.0,
    "thresholdDb": -30.0,
    "ratio": 4.0,
    "releaseMs": 50.0,
    "boomCutHz": 140.0,
    "mudDb": -2.5,
    "presenceDb": 4.0,
}
LEVEL_TARGET_DB = -20.5  # the measured median speech level; every voice is brought to it first
KNEE_DB = 6.0
ATTACK_S = 0.005
COMPRESSOR_BLOCK = 120  # 5 ms
CLIP_START, CEILING = 0.6, 0.95
TONE_TAPS = 1024


def tone_filter(boom_cut_hz: float, mud_db: float, presence_db: float) -> np.ndarray:
    """A minimum-phase filter for the voice's tone: the boom below `boom_cut_hz` cut, a dip of `mud_db`
    around 300 Hz, and `presence_db` of lift around 3 kHz. Minimum phase, so it adds no delay before
    the first sound."""
    n = 8192
    octave = np.log2(np.maximum(np.abs(np.fft.fftfreq(n, 1 / SAMPLE_RATE)), 1.0))
    db = np.interp(octave, [np.log2(boom_cut_hz * 0.43), np.log2(boom_cut_hz)], [-24.0, 0.0])
    for center, gain, width_octaves in ((300, mud_db, 1.2), (3000, presence_db, 1.5)):
        db = db + gain * np.exp(-0.5 * ((octave - np.log2(center)) / (width_octaves / 2.355)) ** 2)
    cepstrum = np.fft.ifft(np.log(10 ** (db / 20))).real
    folded = np.zeros(n)
    folded[0], folded[n // 2] = cepstrum[0], cepstrum[n // 2]
    folded[1 : n // 2] = 2 * cepstrum[1 : n // 2]
    impulse = np.fft.ifft(np.exp(np.fft.fft(folded))).real[:TONE_TAPS]
    impulse[-TONE_TAPS // 4 :] *= np.hanning(TONE_TAPS // 2)[TONE_TAPS // 4 :]  # taper the tail it is cut at
    return impulse.astype(np.float32)


class Tuning:
    """The processing's settings: set live from the panel, and kept on disk so a restart keeps them."""

    def __init__(self, path: Path):
        self.path = path
        saved = json.loads(path.read_text()) if path.exists() else {}
        self.values = {**TUNING_DEFAULTS, **{key: value for key, value in saved.items() if key in TUNING_DEFAULTS}}
        self.lock = threading.Lock()
        self.filter_key: tuple[float, float, float] | None = None
        self.filter = np.zeros(TONE_TAPS, dtype=np.float32)

    def state(self) -> dict:
        ranges = {key: {"min": low, "max": high, "step": step} for key, (low, high, step) in TUNING_RANGES.items()}
        return {"tuning": dict(self.values), "ranges": ranges}

    def update(self, changes: dict) -> None:
        """Sets what `changes` names, each number held to its range; refuses what is not a setting."""
        checked: dict = {}
        for key, value in changes.items():
            if key in ("on", "evenLevels"):
                if not isinstance(value, bool):
                    raise ValueError(f"{key} is true or false, not {value!r}")
                checked[key] = value
            elif key in TUNING_RANGES:
                if isinstance(value, bool) or not isinstance(value, (int, float)):
                    raise ValueError(f"{key} is a number, not {value!r}")
                low, high, _ = TUNING_RANGES[key]
                checked[key] = float(min(high, max(low, value)))
            else:
                raise ValueError(f"there is no setting {key!r}")
        with self.lock:
            self.values = {**self.values, **checked}
            saving = json.dumps(self.values, indent=1) + "\n"
            written = self.path.with_name(self.path.name + ".incoming")
            written.write_text(saving)
            os.replace(written, self.path)

    def tone(self) -> np.ndarray:
        """The tone filter for the settings as they are now, made again only when they change."""
        values = self.values
        key = (values["boomCutHz"], values["mudDb"], values["presenceDb"])
        if key != self.filter_key:
            self.filter, self.filter_key = tone_filter(*key), key
        return self.filter


class Processing:
    """One message's processing, carried from frame to frame: level, tone, compressor, limiter."""

    def __init__(self, tuning: Tuning, level_db: float | None):
        self.tuning = tuning
        even = tuning.values["evenLevels"] and level_db is not None
        self.gain = 10 ** ((float(np.clip(LEVEL_TARGET_DB - level_db, -6, 6)) if even else 0.0) / 20)
        self.tail = np.zeros(TONE_TAPS - 1, dtype=np.float32)  # what the tone filter still rings with
        self.reduction_db = 0.0

    def tone(self, x: np.ndarray) -> np.ndarray:
        size = len(x) + TONE_TAPS - 1
        nfft = 1 << (size - 1).bit_length()
        y = np.fft.irfft(np.fft.rfft(x, nfft) * np.fft.rfft(self.tuning.tone(), nfft), nfft)[:size].astype(np.float32)
        y[: len(self.tail)] += self.tail
        self.tail = y[len(x) :].copy()
        return y[: len(x)]

    def compress(self, x: np.ndarray) -> np.ndarray:
        values = self.tuning.values
        threshold, ratio = values["thresholdDb"], values["ratio"]
        attack = np.exp(-COMPRESSOR_BLOCK / (ATTACK_S * SAMPLE_RATE))
        release = np.exp(-COMPRESSOR_BLOCK / (values["releaseMs"] / 1000 * SAMPLE_RATE))
        reductions = np.empty(len(x), dtype=np.float32)
        for start in range(0, len(x), COMPRESSOR_BLOCK):
            block = x[start : start + COMPRESSOR_BLOCK]
            over = 20 * np.log10(np.sqrt(np.mean(block**2)) + 1e-9) - threshold
            if over <= -KNEE_DB / 2:
                wanted = 0.0
            elif over < KNEE_DB / 2:
                wanted = (1 / ratio - 1) * (over + KNEE_DB / 2) ** 2 / (2 * KNEE_DB)
            else:
                wanted = (1 / ratio - 1) * over
            coefficient = attack if wanted < self.reduction_db else release
            before = self.reduction_db
            self.reduction_db = coefficient * before + (1 - coefficient) * wanted
            reductions[start : start + len(block)] = np.linspace(before, self.reduction_db, len(block), endpoint=False)
        return x * 10 ** ((reductions + values["loudnessDb"]) / 20)

    @staticmethod
    def limit(x: np.ndarray) -> np.ndarray:
        over = np.abs(x) > CLIP_START
        span = CEILING - CLIP_START
        y = x.copy()
        y[over] = np.sign(x[over]) * (CLIP_START + span * np.tanh((np.abs(x[over]) - CLIP_START) / span))
        return y

    def run(self, pcm: np.ndarray) -> np.ndarray:
        return self.limit(self.compress(self.tone(pcm * self.gain))).astype("<f4")

    def flush(self) -> np.ndarray:
        """The last few milliseconds the tone filter still holds once the message has been made."""
        out = self.limit(self.compress(self.tail)).astype("<f4")
        self.tail = np.zeros_like(self.tail)
        return out


class Voice:
    """Phonon on the GPU, the voices it can speak in, and the one in use. Read by one message at a time."""

    def __init__(self, models: Path):
        catalog = models / "voices"
        self.catalog = [json.loads(line) for line in (catalog / "voices.jsonl").read_text().splitlines() if line.strip()]
        # On the GPU: about 35% of one core while it speaks, where the CPU route takes 250% to 540% (ADR-0150).
        self.tts = ptts.TTS(str(models), lang="en", quant="f32", device="metal", voice_catalog=str(catalog))
        # EXPERIMENT: more voices in catalogs beside the model's (blends of catalog voices, and the
        # catalog's character and other-language voices), spoken by naming one in /say's `voice`.
        for folder in ("voice-blends", "voice-catalog-extra"):
            extra = models.parent / folder / "voices.jsonl"
            if extra.exists():
                self.tts.add_voice_catalog(str(extra))
                self.catalog += [json.loads(line) for line in extra.read_text().splitlines() if line.strip()]
        # EXPERIMENT: each voice's measured speech level, for Processing, and the processing's settings.
        levels = models.parent / "voice-levels.json"
        self.levels: dict[str, float] = json.loads(levels.read_text()) if levels.exists() else {}
        self.tuning = Tuning(models.parent / "speech-tuning.json")
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
        # Each /render being made, by its caller's ref, set when it is cancelled.
        self.renders: dict[str, threading.Event] = {}

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

    def say(
        self, text: str, tone: str | None = None, ref: str | None = None, in_voice: str | None = None, process: bool | None = None
    ) -> tuple[float, bool]:
        """Makes and pushes `text` frame by frame, after any message before it, paced to LEAD_S ahead of
        the page's playback. Returns how long it plays, in ms, and whether it was cancelled part way;
        it returns about LEAD_S before the page finishes playing it."""
        # Numbered before waiting its turn, so a cancel by ref reaches a message still waiting.
        message = next(self.ids)
        if ref:
            self.refs[ref] = message
        with self.say_lock:
            received = time.perf_counter()
            voice, speed = in_voice or self.voice.name, self.voice.speed
            processed = self.voice.tuning.values["on"] if process is None else process
            processing = Processing(self.voice.tuning, self.voice.levels.get(voice)) if processed else None
            played_s = 0.0
            # When what has been pushed of this message finishes playing on the page.
            played_by = time.monotonic()
            with self.voice.tts.stream(text, voice=voice) as audio:
                index = -1
                for index, chunk in enumerate(audio):
                    wait = played_by - LEAD_S - time.monotonic()
                    if wait > 0:
                        with self.changed:
                            self.changed.wait_for(lambda: message in self.cancelled, timeout=wait)
                    if message in self.cancelled:
                        log(f"#{message}: cancelled after {played_s:.1f} s of it")
                        return played_s * 1000, True
                    pcm = np.asarray(chunk, dtype="<f4").reshape(-1)
                    if processing:
                        pcm = processing.run(pcm)
                    plays_s = len(pcm) / SAMPLE_RATE / speed
                    played_s += plays_s
                    played_by = max(played_by, time.monotonic()) + plays_s
                    header = {"message": message, "index": index}
                    if index == 0:
                        mac_ms = (time.perf_counter() - received) * 1000
                        header.update({"text": text[:200], "voice": voice, "macMs": round(mac_ms, 1), **({"tone": tone} if tone else {})})
                        log(f"#{message}: first audio out after {mac_ms:.0f} ms, in {voice}{', processed' if processing else ''}, to {self.listening()} listener(s)")
                    self.push(frame(header, pcm.tobytes()))
            if processing and index >= 0 and message not in self.cancelled:
                pcm = processing.flush()
                played_s += len(pcm) / SAMPLE_RATE / speed
                self.push(frame({"message": message, "index": index + 1}, pcm.tobytes()))
            return played_s * 1000, message in self.cancelled

    def render(self, text: str, ref: str, write) -> None:
        """Makes `text` for one caller, handing each frame's PCM to `write` as it is made, until it is
        all made or `ref` is cancelled. Outside the line `say` keeps, so it never waits behind one."""
        stop = threading.Event()
        self.renders[ref] = stop
        started = time.perf_counter()
        made_s = 0.0
        processing = Processing(self.voice.tuning, self.voice.levels.get(self.voice.name)) if self.voice.tuning.values["on"] else None
        try:
            with self.voice.tts.stream(text, voice=self.voice.name) as audio:
                for index, chunk in enumerate(audio):
                    if stop.is_set():
                        log(f"render {ref}: cancelled after {made_s:.1f} s of it")
                        return
                    pcm = np.asarray(chunk, dtype="<f4").reshape(-1)
                    if processing:
                        pcm = processing.run(pcm)
                    if index == 0:
                        log(f"render {ref}: first audio out after {(time.perf_counter() - started) * 1000:.0f} ms, in {self.voice.name}")
                    made_s += len(pcm) / SAMPLE_RATE
                    write(pcm.tobytes())
            if processing:
                write(processing.flush().tobytes())
            log(f"render {ref}: {made_s:.1f} s of speech in {time.perf_counter() - started:.1f} s")
        finally:
            if self.renders.get(ref) is stop:
                del self.renders[ref]


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
            elif self.path.startswith("/processing"):
                self.answer(200, channel.voice.tuning.state())
            elif self.path.startswith("/listeners"):  # ahead of /listen, which it starts with
                self.answer(200, {"listeners": channel.listening()})
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
                elif "voice" in body and not (isinstance(body["voice"], str) and channel.voice.knows(body["voice"])):
                    self.refuse(400, "unknown_voice", f"expected voice to name one of GET /voices, not {body['voice']!r}")
                elif "process" in body and not isinstance(body["process"], bool):
                    self.refuse(400, "invalid_message", f"expected process as true or false, not {body['process']!r}")
                elif channel.listening() == 0:
                    self.refuse(409, "nobody_listening", "no page is listening to the Mac, so nothing was said")
                else:
                    heard_by = channel.listening()
                    tone = body.get("tone") if body.get("tone") in ("attention", "done") else None
                    ref = body.get("ref") if isinstance(body.get("ref"), str) else None
                    duration_ms, cancelled = channel.say(text, tone, ref, body.get("voice"), body.get("process"))
                    self.answer(200, {"listeners": heard_by, "durationMs": round(duration_ms), "cancelled": cancelled})
            elif self.path.startswith("/render"):
                text, ref = body.get("text"), body.get("ref")
                if not isinstance(text, str) or not text.strip() or not isinstance(ref, str) or not ref:
                    self.refuse(400, "invalid_message", "expected { text, ref } with something to say")
                    return
                self.send_response(200)
                self.send_header("content-type", "application/octet-stream")
                self.send_header("cache-control", "no-store")
                self.end_headers()  # no length: the body ends when the connection does
                self.connection.settimeout(RENDER_WRITE_TIMEOUT_S)

                def write(pcm: bytes) -> None:
                    self.wfile.write(pcm)
                    self.wfile.flush()

                try:
                    channel.render(text, ref, write)
                except (BrokenPipeError, ConnectionResetError, TimeoutError):
                    log(f"render {ref}: the reader went away")
            elif self.path.split("?")[0] == "/voice":  # exactly, so /voices is not taken for it
                name = body.get("voice")
                if not isinstance(name, str) or not channel.voice.knows(name):
                    self.refuse(400, "unknown_voice", f"expected {{ voice }} naming one of GET /voices, not {name!r}")
                    return
                if name != channel.voice.name:
                    channel.voice.name = name
                    log(f"voice {name}")
                self.answer(200, {"voice": channel.voice.name})
            elif self.path.startswith("/processing"):
                if not isinstance(body, dict):
                    self.refuse(400, "invalid_tuning", "expected an object of settings")
                    return
                try:
                    channel.voice.tuning.update(body)
                except ValueError as error:
                    self.refuse(400, "invalid_tuning", str(error))
                    return
                log(f"tuning {json.dumps(body)}")
                self.answer(200, channel.voice.tuning.state())
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
                rendering = channel.renders.get(ref) if isinstance(ref, str) else None
                if rendering:
                    rendering.set()
                    self.answer(204)
                    return
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
