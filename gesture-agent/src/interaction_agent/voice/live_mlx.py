import logging
import queue
import tempfile
import threading
import time
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np

from interaction_agent.voice.config import (
    DEFAULT_FINAL_TRANSCRIPTION_MODEL,
    DEFAULT_LIVE_MLX_CHUNK_SECONDS,
    DEFAULT_LIVE_MLX_INTERVAL_SECONDS,
    DEFAULT_LIVE_MLX_MIN_SECONDS,
    DEFAULT_TRANSCRIPTION_PREAMP,
)
from interaction_agent.voice.live_sherpa import (
    MAX_PREAMP_GAIN,
    MIN_PREAMP_GAIN,
    prepare_audio_for_recognizer,
)
from interaction_agent.voice.recording import DEFAULT_SAMPLE_RATE, FloatArray
from interaction_agent.voice.runtime import (
    VoiceTranscriptionOptions,
    transcribe_audio_path,
    transcript_text,
)


LOGGER = logging.getLogger("voice_agent.live_mlx")

AudioQueueItem = tuple[int, FloatArray] | None
QUEUE_BLOCKS: Final = 512
STOP_JOIN_SECONDS: Final = 8.0


@dataclass(frozen=True)
class MlxLiveTranscriptSnapshot:
    is_active: bool
    is_decoding: bool
    preamp_gain: float
    model: str
    preview_text: str
    chunk_seconds: float
    interval_seconds: float
    decoded_chunks: int
    dropped_blocks: int
    last_decode_seconds: float
    last_error: str | None


class MlxLiveChunkTranscriber:
    def __init__(
        self,
        model: str = DEFAULT_FINAL_TRANSCRIPTION_MODEL,
        chunk_seconds: float = DEFAULT_LIVE_MLX_CHUNK_SECONDS,
        interval_seconds: float = DEFAULT_LIVE_MLX_INTERVAL_SECONDS,
        min_seconds: float = DEFAULT_LIVE_MLX_MIN_SECONDS,
        preamp_gain: float = DEFAULT_TRANSCRIPTION_PREAMP,
    ) -> None:
        self.model = model
        self.chunk_seconds = max(1.0, chunk_seconds)
        self.interval_seconds = max(0.5, interval_seconds)
        self.min_seconds = max(0.25, min(min_seconds, self.chunk_seconds))
        self.preamp_gain = clamp_preamp_gain(preamp_gain)
        self.lock = threading.Lock()
        self.audio_queue: queue.Queue[AudioQueueItem] = queue.Queue(maxsize=QUEUE_BLOCKS)
        self.worker: threading.Thread | None = None
        self.is_active = False
        self.is_decoding = False
        self.preview_text = ""
        self.decoded_chunks = 0
        self.dropped_blocks = 0
        self.last_decode_seconds = 0.0
        self.last_error: str | None = None

    def start_session(self) -> None:
        self.finish_session()
        with self.lock:
            self.is_active = True
            self.is_decoding = False
            self.preview_text = ""
            self.decoded_chunks = 0
            self.dropped_blocks = 0
            self.last_decode_seconds = 0.0
            self.last_error = None

        self.worker = threading.Thread(
            target=self._run_worker,
            name="mlx-live-chunk-transcriber",
            daemon=True,
        )
        self.worker.start()

    def submit_audio(self, samples: FloatArray, sample_rate: int) -> None:
        with self.lock:
            if not self.is_active:
                return

        try:
            self.audio_queue.put_nowait((sample_rate, samples.copy()))
        except queue.Full:
            try:
                self.audio_queue.get_nowait()
                self.audio_queue.put_nowait((sample_rate, samples.copy()))
            except queue.Empty:
                pass
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

    def finish_session(self) -> MlxLiveTranscriptSnapshot:
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
        worker.join(timeout=STOP_JOIN_SECONDS)
        if worker.is_alive():
            with self.lock:
                self.last_error = "mlx preview worker is still decoding"
        else:
            self.worker = None
        return self.snapshot()

    def snapshot(self) -> MlxLiveTranscriptSnapshot:
        with self.lock:
            return MlxLiveTranscriptSnapshot(
                is_active=self.is_active,
                is_decoding=self.is_decoding,
                preamp_gain=self.preamp_gain,
                model=self.model,
                preview_text=self.preview_text,
                chunk_seconds=self.chunk_seconds,
                interval_seconds=self.interval_seconds,
                decoded_chunks=self.decoded_chunks,
                dropped_blocks=self.dropped_blocks,
                last_decode_seconds=self.last_decode_seconds,
                last_error=self.last_error,
            )

    def _run_worker(self) -> None:
        chunks: list[FloatArray] = []
        total_samples = 0
        sample_rate = DEFAULT_SAMPLE_RATE
        last_decode_started = 0.0
        try:
            while True:
                item = self.audio_queue.get()
                if item is None:
                    self._decode_buffer(chunks, sample_rate)
                    return

                sample_rate, samples = item
                chunks.append(samples.reshape(-1).astype(np.float32))
                total_samples += samples.size
                max_samples = int(sample_rate * self.chunk_seconds)
                while total_samples > max_samples and chunks:
                    dropped = chunks.pop(0)
                    total_samples -= dropped.size

                now = time.monotonic()
                buffered_seconds = total_samples / max(1, sample_rate)
                if buffered_seconds < self.min_seconds:
                    continue
                if now - last_decode_started < self.interval_seconds:
                    continue

                last_decode_started = now
                self._decode_buffer(chunks, sample_rate)
        except Exception as exc:
            LOGGER.exception("mlx live preview worker failed")
            with self.lock:
                self.last_error = str(exc)
                self.is_active = False
                self.is_decoding = False

    def _decode_buffer(self, chunks: list[FloatArray], sample_rate: int) -> None:
        if not chunks:
            return

        with self.lock:
            preamp_gain = self.preamp_gain
            self.is_decoding = True

        audio = np.concatenate(chunks).astype(np.float32)
        if audio.size < int(sample_rate * self.min_seconds):
            with self.lock:
                self.is_decoding = False
            return

        started_at = time.monotonic()
        audio = prepare_audio_for_recognizer(audio, preamp_gain)
        temp_path = write_temp_wav(audio, sample_rate)
        try:
            result = transcribe_audio_path(
                temp_path,
                VoiceTranscriptionOptions(model=self.model),
            )
            text = transcript_text(result)
            elapsed = time.monotonic() - started_at
            with self.lock:
                if text:
                    self.preview_text = text
                self.decoded_chunks += 1
                self.last_decode_seconds = elapsed
                self.last_error = None
                self.is_decoding = False
        except Exception as exc:
            LOGGER.exception("mlx live preview decode failed")
            with self.lock:
                self.last_error = str(exc)
                self.is_decoding = False
        finally:
            temp_path.unlink(missing_ok=True)

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


def clamp_preamp_gain(gain: float) -> float:
    return max(MIN_PREAMP_GAIN, min(MAX_PREAMP_GAIN, gain))


def write_temp_wav(samples: FloatArray, sample_rate: int) -> Path:
    audio_i16 = (np.clip(samples, -1.0, 1.0) * 32767.0).astype(np.int16)
    handle = tempfile.NamedTemporaryFile(
        prefix="gesture-agent-live-mlx-",
        suffix=".wav",
        delete=False,
    )
    path = Path(handle.name)
    handle.close()
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(audio_i16.tobytes())
    return path
