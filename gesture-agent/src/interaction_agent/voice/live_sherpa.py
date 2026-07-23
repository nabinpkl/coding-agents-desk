import argparse
import ctypes
import importlib
import logging
import queue
import sys
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from types import ModuleType
from typing import Any, Final

import numpy as np
import sounddevice as sd
from numpy.typing import NDArray

from interaction_agent.paths import VOICE_MODEL_ROOT
from interaction_agent.voice.config import DEFAULT_TRANSCRIPTION_PREAMP
from interaction_agent.voice.recording import (
    DEFAULT_BLOCK_SIZE,
    DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE,
)


LOGGER = logging.getLogger("voice_agent.live_sherpa")

FloatArray = NDArray[np.float32]
AudioQueueItem = tuple[int, FloatArray] | None

DEFAULT_MODEL_NAME: Final = (
    "sherpa-onnx-nemotron-speech-streaming-en-0.6b-560ms-int8-2026-04-25"
)
DEFAULT_MODEL_DIR: Final = VOICE_MODEL_ROOT / DEFAULT_MODEL_NAME
QUEUE_BLOCKS: Final = 96
FINAL_TAIL_SECONDS: Final = 0.5
MIN_PREAMP_GAIN: Final = 1.0
MAX_PREAMP_GAIN: Final = 32.0


@dataclass(frozen=True)
class SherpaModelPaths:
    root: Path
    tokens: Path
    encoder: Path
    decoder: Path
    joiner: Path


@dataclass(frozen=True)
class TranscriptState:
    partial: str = ""
    finalized: tuple[str, ...] = ()

    def append_final(self, text: str) -> "TranscriptState":
        stripped = text.strip()
        if not stripped:
            return self
        return TranscriptState(partial="", finalized=(*self.finalized, stripped))

    def with_partial(self, text: str) -> "TranscriptState":
        return TranscriptState(partial=text.strip(), finalized=self.finalized)

    def full_text(self) -> str:
        pieces = [*self.finalized]
        if self.partial:
            pieces.append(self.partial)
        return " ".join(pieces).strip()


@dataclass(frozen=True)
class LiveTranscriptionSnapshot:
    is_active: bool
    preamp_gain: float
    partial: str
    finalized: tuple[str, ...]
    full_text: str
    dropped_blocks: int
    last_error: str | None


class SherpaLiveTranscriber:
    def __init__(
        self,
        model_dir: Path = DEFAULT_MODEL_DIR,
        num_threads: int = 2,
        preamp_gain: float = DEFAULT_TRANSCRIPTION_PREAMP,
    ) -> None:
        model_paths = resolve_model_paths(model_dir)
        sherpa_onnx = import_sherpa_onnx()
        self.recognizer = create_recognizer(
            sherpa_onnx=sherpa_onnx,
            model_paths=model_paths,
            num_threads=num_threads,
        )
        self.lock = threading.Lock()
        self.audio_queue: queue.Queue[AudioQueueItem] = queue.Queue(maxsize=QUEUE_BLOCKS)
        self.state = TranscriptState()
        self.worker: threading.Thread | None = None
        self.is_active = False
        self.preamp_gain = clamp_preamp_gain(preamp_gain)
        self.dropped_blocks = 0
        self.last_error: str | None = None

    def start_session(self) -> None:
        self.finish_session()
        with self.lock:
            self.state = TranscriptState()
            self.is_active = True
            self.dropped_blocks = 0
            self.last_error = None

        stream = self.recognizer.create_stream()
        self.worker = threading.Thread(
            target=self._run_worker,
            args=(stream,),
            name="sherpa-live-transcriber",
            daemon=True,
        )
        self.worker.start()

    def submit_audio(self, samples: FloatArray, sample_rate: int) -> None:
        with self.lock:
            if not self.is_active:
                return
            preamp_gain = self.preamp_gain

        prepared_samples = prepare_audio_for_recognizer(samples, preamp_gain)
        try:
            self.audio_queue.put_nowait((sample_rate, prepared_samples))
        except queue.Full:
            with self.lock:
                self.dropped_blocks += 1

    def adjust_preamp_gain(self, delta: float) -> float:
        with self.lock:
            self.preamp_gain = clamp_preamp_gain(self.preamp_gain + delta)
            return self.preamp_gain

    def set_preamp_gain(self, gain: float) -> float:
        with self.lock:
            self.preamp_gain = clamp_preamp_gain(gain)
            return self.preamp_gain

    def finish_session(self) -> LiveTranscriptionSnapshot:
        worker = self.worker
        if worker is None:
            with self.lock:
                self.is_active = False
            return self.snapshot()

        with self.lock:
            was_active = self.is_active
            self.is_active = False

        if was_active:
            self._enqueue_stop()
        worker.join(timeout=5.0)
        if worker.is_alive():
            # The worker is hung on the shared recognizer. Keep the reference so
            # the next start_session does not stack a second worker on the same
            # recognizer (which would interleave into garbled transcripts), and
            # fail loud rather than pretending the session stopped.
            with self.lock:
                self.last_error = "live transcription worker did not stop cleanly"
            raise RuntimeError("live transcription worker did not stop cleanly")
        self.worker = None
        return self.snapshot()

    def snapshot(self) -> LiveTranscriptionSnapshot:
        with self.lock:
            state = self.state
            return LiveTranscriptionSnapshot(
                is_active=self.is_active,
                preamp_gain=self.preamp_gain,
                partial=state.partial,
                finalized=state.finalized,
                full_text=state.full_text(),
                dropped_blocks=self.dropped_blocks,
                last_error=self.last_error,
            )

    def _run_worker(self, stream: Any) -> None:
        state = TranscriptState()
        last_sample_rate = DEFAULT_SAMPLE_RATE
        try:
            while True:
                item = self.audio_queue.get()
                if item is None:
                    state = finish_stream(
                        recognizer=self.recognizer,
                        stream=stream,
                        sample_rate=last_sample_rate,
                        state=state,
                    )
                    with self.lock:
                        self.state = state
                    return

                sample_rate, samples = item
                last_sample_rate = sample_rate
                state = accept_and_decode(
                    recognizer=self.recognizer,
                    stream=stream,
                    sample_rate=sample_rate,
                    samples=samples,
                    state=state,
                )
                with self.lock:
                    self.state = state
        except Exception as exc:
            LOGGER.exception("live transcription worker failed")
            with self.lock:
                self.last_error = str(exc)
                self.is_active = False

    def _enqueue_stop(self) -> None:
        while True:
            try:
                self.audio_queue.put_nowait(None)
                return
            except queue.Full:
                try:
                    self.audio_queue.get_nowait()
                except queue.Empty:
                    return


def import_sherpa_onnx() -> ModuleType:
    preload_onnxruntime()
    return importlib.import_module("sherpa_onnx")


def preload_onnxruntime() -> None:
    onnxruntime = importlib.import_module("onnxruntime")
    runtime_dir = Path(onnxruntime.__file__).resolve().parent / "capi"
    library_paths = [
        *runtime_dir.glob("libonnxruntime*.dylib"),
        *runtime_dir.glob("libonnxruntime*.so*"),
        *runtime_dir.glob("onnxruntime*.dll"),
    ]
    if not library_paths:
        raise RuntimeError(f"onnxruntime shared library not found in {runtime_dir}")

    for library_path in sorted(library_paths):
        ctypes.CDLL(str(library_path), mode=ctypes.RTLD_GLOBAL)


def resolve_model_paths(model_dir: Path) -> SherpaModelPaths:
    encoder = first_existing(
        [
            model_dir / "encoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            model_dir / "encoder-epoch-99-avg-1.int8.onnx",
            model_dir / "encoder.int8.onnx",
        ]
    )
    decoder = first_existing(
        [
            model_dir / "decoder-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            model_dir / "decoder-epoch-99-avg-1.int8.onnx",
            model_dir / "decoder.int8.onnx",
            model_dir / "decoder.onnx",
        ]
    )
    joiner = first_existing(
        [
            model_dir / "joiner-epoch-99-avg-1-chunk-16-left-128.int8.onnx",
            model_dir / "joiner-epoch-99-avg-1.int8.onnx",
            model_dir / "joiner.int8.onnx",
        ]
    )
    paths = SherpaModelPaths(
        root=model_dir,
        tokens=model_dir / "tokens.txt",
        encoder=encoder or model_dir / "encoder*.onnx",
        decoder=decoder or model_dir / "decoder*.onnx",
        joiner=joiner or model_dir / "joiner*.onnx",
    )
    missing = [
        path
        for path in [paths.tokens, paths.encoder, paths.decoder, paths.joiner]
        if not path.exists()
    ]
    if missing:
        missing_text = "\n".join(str(path) for path in missing)
        raise FileNotFoundError(
            "Sherpa streaming model files are missing. Run `just download-voice-model`.\n"
            f"{missing_text}"
        )
    return paths


def first_existing(paths: list[Path]) -> Path | None:
    for path in paths:
        if path.exists():
            return path
    return None


def create_recognizer(
    sherpa_onnx: ModuleType,
    model_paths: SherpaModelPaths,
    num_threads: int,
) -> Any:
    return sherpa_onnx.OnlineRecognizer.from_transducer(
        tokens=str(model_paths.tokens),
        encoder=str(model_paths.encoder),
        decoder=str(model_paths.decoder),
        joiner=str(model_paths.joiner),
        num_threads=num_threads,
        sample_rate=DEFAULT_SAMPLE_RATE,
        decoding_method="greedy_search",
        enable_endpoint_detection=False,
        rule1_min_trailing_silence=1.8,
        rule2_min_trailing_silence=0.8,
        rule3_min_utterance_length=12.0,
        provider="cpu",
    )


def clamp_preamp_gain(gain: float) -> float:
    return max(MIN_PREAMP_GAIN, min(MAX_PREAMP_GAIN, gain))


def prepare_audio_for_recognizer(samples: FloatArray, preamp_gain: float) -> FloatArray:
    mono = np.asarray(samples, dtype=np.float32).reshape(-1)
    if mono.size == 0:
        return mono.copy()

    clean = np.nan_to_num(mono, nan=0.0, posinf=0.0, neginf=0.0)
    return np.clip(clean * preamp_gain, -1.0, 1.0).astype(np.float32)


def accept_and_decode(
    recognizer: Any,
    stream: Any,
    sample_rate: int,
    samples: FloatArray,
    state: TranscriptState,
) -> TranscriptState:
    stream.accept_waveform(sample_rate, samples)
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)

    result = recognizer.get_result(stream).strip()
    next_state = state.with_partial(result)
    if recognizer.is_endpoint(stream):
        next_state = next_state.append_final(result)
        recognizer.reset(stream)

    return next_state


def finish_stream(
    recognizer: Any,
    stream: Any,
    sample_rate: int,
    state: TranscriptState,
) -> TranscriptState:
    tail = np.zeros(int(sample_rate * FINAL_TAIL_SECONDS), dtype=np.float32)
    stream.accept_waveform(sample_rate, tail)
    stream.input_finished()
    while recognizer.is_ready(stream):
        recognizer.decode_stream(stream)

    return state.append_final(recognizer.get_result(stream))


def print_state(state: TranscriptState, last_rendered: str) -> str:
    text = state.full_text()
    if text == last_rendered:
        return last_rendered

    sys.stdout.write("\r" + " " * max(len(last_rendered), 1) + "\r")
    sys.stdout.write(text)
    sys.stdout.flush()
    return text


def read_wav(path: Path) -> tuple[int, FloatArray]:
    with wave.open(str(path), "rb") as wav_file:
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
        sample_rate = wav_file.getframerate()
        frames = wav_file.readframes(wav_file.getnframes())

    if sample_width != 2:
        raise ValueError(f"Only 16-bit PCM WAV files are supported: {path}")

    samples_i16 = np.frombuffer(frames, dtype=np.int16)
    if channels > 1:
        samples_i16 = samples_i16.reshape(-1, channels).mean(axis=1).astype(np.int16)

    samples = samples_i16.astype(np.float32) / 32768.0
    return sample_rate, samples


def stream_wav_file(
    recognizer: Any,
    wav_path: Path,
    chunk_seconds: float,
    preamp_gain: float,
) -> TranscriptState:
    sample_rate, samples = read_wav(wav_path)
    stream = recognizer.create_stream()
    state = TranscriptState()
    last_rendered = ""
    chunk_size = max(1, int(sample_rate * chunk_seconds))

    for start in range(0, samples.size, chunk_size):
        chunk = prepare_audio_for_recognizer(
            samples[start:start + chunk_size],
            preamp_gain,
        )
        state = accept_and_decode(recognizer, stream, sample_rate, chunk, state)
        last_rendered = print_state(state, last_rendered)

    state = finish_stream(recognizer, stream, sample_rate, state)
    print_state(state, last_rendered)
    sys.stdout.write("\n")
    return state


def stream_microphone(
    recognizer: Any,
    sample_rate: int,
    block_size: int,
    device: int | None,
    duration_seconds: float | None,
    preamp_gain: float,
) -> TranscriptState:
    audio_queue: queue.Queue[AudioQueueItem] = queue.Queue(maxsize=QUEUE_BLOCKS)

    def on_audio_block(
        indata: FloatArray,
        frames: int,
        time_info: Any,
        status: sd.CallbackFlags,
    ) -> None:
        del frames
        del time_info
        if status:
            LOGGER.warning("input stream status=%s", status)

        block = np.asarray(indata, dtype=np.float32)
        if block.ndim == 2:
            mono = np.mean(block, axis=1).astype(np.float32)
        else:
            mono = block.reshape(-1).astype(np.float32)

        try:
            audio_queue.put_nowait((sample_rate, mono.copy()))
        except queue.Full:
            LOGGER.warning("dropping audio block because recognizer queue is full")

    stream = recognizer.create_stream()
    state = TranscriptState()
    last_rendered = ""
    started_at = time.monotonic()

    with sd.InputStream(
        samplerate=sample_rate,
        channels=DEFAULT_CHANNELS,
        blocksize=block_size,
        dtype="float32",
        device=device,
        callback=on_audio_block,
    ):
        LOGGER.info("listening sample_rate=%s block_size=%s", sample_rate, block_size)
        while True:
            if (
                duration_seconds is not None
                and time.monotonic() - started_at >= duration_seconds
            ):
                break

            try:
                item = audio_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            if item is None:
                break

            item_sample_rate, samples = item
            state = accept_and_decode(
                recognizer,
                stream,
                item_sample_rate,
                prepare_audio_for_recognizer(samples, preamp_gain),
                state,
            )
            last_rendered = print_state(state, last_rendered)

    state = finish_stream(recognizer, stream, sample_rate, state)
    print_state(state, last_rendered)
    sys.stdout.write("\n")
    return state


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Stream microphone audio through sherpa-onnx and print live transcripts.",
    )
    parser.add_argument("--model-dir", type=Path, default=DEFAULT_MODEL_DIR)
    parser.add_argument("--wav", type=Path, default=None)
    parser.add_argument("--chunk-seconds", type=float, default=0.25)
    parser.add_argument("--sample-rate", type=int, default=DEFAULT_SAMPLE_RATE)
    parser.add_argument("--block-size", type=int, default=DEFAULT_BLOCK_SIZE)
    parser.add_argument("--num-threads", type=int, default=2)
    parser.add_argument("--device", type=int, default=None)
    parser.add_argument("--duration", type=float, default=None)
    parser.add_argument("--preamp", type=float, default=DEFAULT_TRANSCRIPTION_PREAMP)
    return parser.parse_args()


def run() -> int:
    logging.basicConfig(
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(message)s",
    )
    arguments = parse_arguments()
    model_paths = resolve_model_paths(arguments.model_dir)
    sherpa_onnx = import_sherpa_onnx()
    recognizer = create_recognizer(
        sherpa_onnx=sherpa_onnx,
        model_paths=model_paths,
        num_threads=arguments.num_threads,
    )

    if arguments.wav is not None:
        stream_wav_file(
            recognizer=recognizer,
            wav_path=arguments.wav,
            chunk_seconds=arguments.chunk_seconds,
            preamp_gain=arguments.preamp,
        )
        return 0

    try:
        stream_microphone(
            recognizer=recognizer,
            sample_rate=arguments.sample_rate,
            block_size=arguments.block_size,
            device=arguments.device,
            duration_seconds=arguments.duration,
            preamp_gain=arguments.preamp,
        )
    except KeyboardInterrupt:
        sys.stdout.write("\n")
        LOGGER.info("voice live transcription stopped")
    return 0


def main() -> None:
    raise SystemExit(run())


if __name__ == "__main__":
    main()
