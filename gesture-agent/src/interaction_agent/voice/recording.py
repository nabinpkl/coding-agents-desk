import json
import os
import threading
import wave
from collections import deque
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, Final

import numpy as np
import sounddevice as sd
from numpy.typing import NDArray

from interaction_agent.paths import VOICE_RECORDING_ROOT
from interaction_agent.voice.devices import device_name, query_device_info
from interaction_agent.voice.signals import VoiceSignalAnalysis, analyze_audio

FloatArray = NDArray[np.float32]
AudioSink = Callable[[FloatArray, int], None]

DEFAULT_SAMPLE_RATE: Final = 16_000
DEFAULT_CHANNELS: Final = 1
DEFAULT_BLOCK_SIZE: Final = 512
RECENT_SAMPLE_SECONDS: Final = 2.0


def timestamp_in_utc(value: str) -> datetime:
    """Parse a persisted timestamp as an absolute UTC instant.

    Recordings created before UTC timestamps were enforced contain offset-less
    local wall time. ``astimezone`` deliberately interprets those values in the
    Mac's local timezone; aware timestamps retain their recorded offset.
    """
    return datetime.fromisoformat(value).astimezone(UTC)


@dataclass(frozen=True)
class VoiceMeterSnapshot:
    input_device_name: str
    input_device_index: int | None
    input_latency_seconds: float | None
    rms: float
    peak: float
    decibels: float
    zero_crossing_rate: float
    sample_rate: int
    is_recording: bool
    is_monitoring: bool
    recording_seconds: float
    recording_samples: int
    recent_rms: tuple[float, ...]
    recent_audio: tuple[float, ...]
    dropped_blocks: int


@dataclass(frozen=True)
class VoiceRecordingResult:
    wav_path: Path
    json_path: Path
    analysis: VoiceSignalAnalysis


@dataclass(frozen=True)
class VoiceInputDeviceInfo:
    name: str
    index: int | None
    latency_seconds: float | None


class VoiceInputRecorder:
    def __init__(
        self,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        channels: int = DEFAULT_CHANNELS,
        block_size: int = DEFAULT_BLOCK_SIZE,
        recording_audio_sink: AudioSink | None = None,
        input_device_index: int | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.block_size = block_size
        self.recording_audio_sink = recording_audio_sink
        self.input_device_index = input_device_index
        self.stream: sd.InputStream | None = None
        self.lock = threading.Lock()
        self.is_recording = False
        self.is_monitoring = False
        self.recording_started_at: datetime | None = None
        self.monitoring_started_at: datetime | None = None
        self.monitoring_samples = 0
        self.recording_chunks: list[FloatArray] = []
        self.recent_samples: deque[float] = deque(
            maxlen=int(sample_rate * RECENT_SAMPLE_SECONDS)
        )
        self.recent_rms: deque[float] = deque(maxlen=96)
        self.last_rms = 0.0
        self.last_peak = 0.0
        self.last_decibels = -120.0
        self.last_zero_crossing_rate = 0.0
        self.dropped_blocks = 0
        self.last_result: VoiceRecordingResult | None = None
        self.input_device = VoiceInputDeviceInfo(
            name="not opened",
            index=None,
            latency_seconds=None,
        )

    def start_stream(self) -> None:
        if self.stream is not None:
            return

        self.stream = sd.InputStream(
            samplerate=self.sample_rate,
            channels=self.channels,
            blocksize=self.block_size,
            dtype="float32",
            device=self.input_device_index,
            callback=self.on_audio_block,
        )
        self.stream.start()
        self.input_device = query_input_device_info(
            self.stream,
            self.input_device_index,
        )

    def stop_stream(self) -> None:
        if self.stream is None:
            return

        self.stream.stop()
        self.stream.close()
        self.stream = None

    def set_input_device(self, device_index: int | None) -> None:
        snapshot = self.snapshot()
        if snapshot.is_recording or snapshot.is_monitoring:
            raise RuntimeError("stop recording or monitoring before changing input devices")

        previous_device_index = self.input_device_index
        was_streaming = self.stream is not None
        if was_streaming:
            self.stop_stream()
        self.input_device_index = device_index
        if was_streaming:
            try:
                self.start_stream()
            except Exception:
                self.input_device_index = previous_device_index
                self.start_stream()
                raise

    def start_recording(self) -> None:
        with self.lock:
            if self.is_monitoring:
                raise RuntimeError("stop monitoring before recording")
            self.recording_chunks = []
            self.recording_started_at = datetime.now(UTC)
            self.is_recording = True
            self.last_result = None

    def stop_recording(self) -> VoiceRecordingResult | None:
        with self.lock:
            if not self.is_recording:
                return None

            chunks = [chunk.copy() for chunk in self.recording_chunks]
            started_at = self.recording_started_at or datetime.now(UTC)
            self.is_recording = False
            self.recording_started_at = None
            self.recording_chunks = []

        if chunks:
            audio = np.concatenate(chunks).astype(np.float32)
        else:
            audio = np.array([], dtype=np.float32)

        if audio.size == 0:
            return None

        result = save_voice_recording(audio, self.sample_rate, started_at)
        with self.lock:
            self.last_result = result
        return result

    def toggle_recording(self) -> VoiceRecordingResult | None:
        if self.snapshot().is_recording:
            return self.stop_recording()

        self.start_recording()
        return None

    def start_monitoring(self) -> None:
        with self.lock:
            if self.is_recording:
                raise RuntimeError("stop recording before monitoring")
            self.monitoring_started_at = datetime.now(UTC)
            self.monitoring_samples = 0
            self.is_monitoring = True

    def stop_monitoring(self) -> None:
        with self.lock:
            self.is_monitoring = False
            self.monitoring_started_at = None
            self.monitoring_samples = 0

    def on_audio_block(
        self,
        indata: FloatArray,
        frames: int,
        time_info: Any,
        status: sd.CallbackFlags,
    ) -> None:
        del frames
        del time_info

        block = np.asarray(indata, dtype=np.float32)
        if block.ndim == 2:
            mono = np.mean(block, axis=1).astype(np.float32)
        else:
            mono = block.reshape(-1).astype(np.float32)

        rms = float(np.sqrt(np.mean(np.square(mono)))) if mono.size else 0.0
        peak = float(np.max(np.abs(mono))) if mono.size else 0.0
        decibels = float(20 * np.log10(max(rms, 1e-8)))
        zero_crossings = np.count_nonzero(np.diff(np.signbit(mono)))
        zcr = float(zero_crossings / max(1, mono.size - 1))

        with self.lock:
            if status:
                self.dropped_blocks += 1

            self.last_rms = rms
            self.last_peak = peak
            self.last_decibels = decibels
            self.last_zero_crossing_rate = zcr
            self.recent_rms.append(rms)
            self.recent_samples.extend(float(sample) for sample in mono)
            should_submit_audio = self.is_recording or self.is_monitoring
            if self.is_recording:
                self.recording_chunks.append(mono.copy())
            if self.is_monitoring:
                self.monitoring_samples += mono.size
            if should_submit_audio and self.recording_audio_sink is not None:
                self.recording_audio_sink(mono.copy(), self.sample_rate)

    def snapshot(self) -> VoiceMeterSnapshot:
        with self.lock:
            recording_samples = sum(chunk.size for chunk in self.recording_chunks)
            recording_seconds = (
                recording_samples / self.sample_rate
                if self.sample_rate > 0
                else 0.0
            )
            monitoring_seconds = (
                self.monitoring_samples / self.sample_rate
                if self.is_monitoring and self.sample_rate > 0
                else 0.0
            )
            active_seconds = monitoring_seconds if self.is_monitoring else recording_seconds
            active_samples = self.monitoring_samples if self.is_monitoring else recording_samples
            return VoiceMeterSnapshot(
                input_device_name=self.input_device.name,
                input_device_index=self.input_device.index,
                input_latency_seconds=self.input_device.latency_seconds,
                rms=self.last_rms,
                peak=self.last_peak,
                decibels=self.last_decibels,
                zero_crossing_rate=self.last_zero_crossing_rate,
                sample_rate=self.sample_rate,
                is_recording=self.is_recording,
                is_monitoring=self.is_monitoring,
                recording_seconds=active_seconds,
                recording_samples=active_samples,
                recent_rms=tuple(self.recent_rms),
                recent_audio=tuple(self.recent_samples),
                dropped_blocks=self.dropped_blocks,
            )


def save_voice_recording(
    audio: FloatArray,
    sample_rate: int,
    started_at: datetime,
    *,
    source: str = "browserDev",
    status: str = "completed",
    client_session_id: str | None = None,
    transport: dict[str, Any] | None = None,
) -> VoiceRecordingResult:
    started_at = started_at.astimezone(UTC)
    timestamp = started_at.strftime("%Y%m%d-%H%M%S-%f")
    VOICE_RECORDING_ROOT.mkdir(parents=True, exist_ok=True)
    wav_path = VOICE_RECORDING_ROOT / f"session-{timestamp}.wav"
    json_path = VOICE_RECORDING_ROOT / f"session-{timestamp}.json"
    write_wav(wav_path, audio, sample_rate)
    analysis = analyze_audio(audio, sample_rate)
    write_recording_metadata(
        json_path,
        {
            "schemaVersion": 4,
            "createdAt": started_at.isoformat(),
            "wavPath": str(wav_path),
            "passageID": None,
            "source": source,
            "status": status,
            "clientSessionID": client_session_id,
            "transport": transport,
            "transcription": {
                "status": "pending",
                "text": None,
                "error": None,
                "engine": None,
            },
            "phoneAnalysis": {
                "status": "pending",
                "phones": [],
                "error": None,
                "modelIdentifier": None,
                "modelHash": None,
                "runtimeIdentifier": None,
                "analyzedAt": None,
            },
            **analysis.to_json_payload(),
        },
    )
    return VoiceRecordingResult(
        wav_path=wav_path,
        json_path=json_path,
        analysis=analysis,
    )


def save_voice_recording_transcript(
    result: VoiceRecordingResult,
    transcript_text: str,
    engine: str = "sherpa-onnx-streaming",
) -> None:
    update_recording_metadata(
        result.json_path,
        {
            "transcript": {
                "engine": engine,
                "text": transcript_text,
            },
            "transcription": {
                "status": "completed",
                "text": transcript_text,
                "error": None,
                "engine": engine,
            },
        },
    )


def write_recording_metadata(path: Path, payload: dict[str, Any]) -> None:
    """Atomically replace one recording metadata document."""
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(path.suffix + ".tmp")
    temporary.write_text(
        json.dumps(payload, indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    os.replace(temporary, path)


def update_recording_metadata(
    path: Path,
    updates: dict[str, Any],
) -> dict[str, Any]:
    payload = json.loads(path.read_text(encoding="utf-8"))
    payload.update(updates)
    write_recording_metadata(path, payload)
    return payload


def write_wav(path: Path, audio: FloatArray, sample_rate: int) -> None:
    pcm = np.clip(audio, -1.0, 1.0)
    pcm_i16 = (pcm * 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wav_file:
        wav_file.setnchannels(1)
        wav_file.setsampwidth(2)
        wav_file.setframerate(sample_rate)
        wav_file.writeframes(pcm_i16.tobytes())


def query_input_device_info(
    stream: sd.InputStream,
    device_index: int | None,
) -> VoiceInputDeviceInfo:
    latency_seconds: float | None = None
    try:
        latency = stream.latency
        if isinstance(latency, tuple):
            latency_seconds = float(latency[0])
        else:
            latency_seconds = float(latency)
    except Exception:
        latency_seconds = None

    device_info = query_device_info(device_index, "input")
    name = device_name(device_info, "default input")

    return VoiceInputDeviceInfo(
        name=name,
        index=int(device_index) if device_index is not None else None,
        latency_seconds=latency_seconds,
    )
