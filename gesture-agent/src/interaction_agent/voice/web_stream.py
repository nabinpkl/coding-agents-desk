"""Framework-free glue for the browser<->backend voice WebSocket and REST layer.

Pure helpers over the reusable voice modules: base64 PCM decoding, meter math,
recording id <-> filesystem mapping, and client message parsing against the
``wire.py`` Pydantic models. No ASR or signal logic is reimplemented here; this
only decodes frames and reads what ``recording.py`` already persisted.
"""

import base64
import json
import re
from pathlib import Path
from typing import Final

import numpy as np
from numpy.typing import NDArray
from pydantic import ValidationError

from interaction_agent.paths import VOICE_RECORDING_ROOT
from interaction_agent.voice.recording import VoiceRecordingResult
from interaction_agent.voice.wire import (
    AudioFrameMessage,
    Recording,
    SessionStartMessage,
    SessionStopMessage,
)


FloatArray = NDArray[np.float32]

ClientWireMessage = SessionStartMessage | AudioFrameMessage | SessionStopMessage

RECORDING_ID_PATTERN: Final = re.compile(r"^session-\d{8}-\d{6}-\d{6}$")


class VoiceWireError(ValueError):
    """A client frame was malformed or a recording id was not well-formed."""


def decode_pcm(pcm_base64: str, encoding: str, channels: int = 1) -> FloatArray:
    """Decode a base64 PCM payload into mono float32 samples in [-1, 1]."""
    if encoding not in ("int16", "float32"):
        raise VoiceWireError(f"unsupported PCM encoding: {encoding!r}")
    if channels != 1:
        # The buffer carries no channel layout, so interleaved audio would be
        # silently misread as mono at the wrong rate. Reject it instead.
        raise VoiceWireError(f"only mono PCM is supported, got {channels} channels")

    try:
        raw = base64.b64decode(pcm_base64, validate=True)
        if encoding == "int16":
            samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
        else:
            samples = np.frombuffer(raw, dtype=np.float32)
    except ValueError as exc:
        raise VoiceWireError(f"malformed {encoding} PCM frame: {exc}") from exc

    return np.ascontiguousarray(samples, dtype=np.float32)


def compute_meter(samples: FloatArray) -> tuple[float, float]:
    """Return (rms, peak) for one audio frame."""
    if samples.size == 0:
        return 0.0, 0.0

    rms = float(np.sqrt(np.mean(np.square(samples, dtype=np.float64))))
    peak = float(np.max(np.abs(samples)))
    return rms, peak


def parse_client_message(raw: str) -> ClientWireMessage:
    """Parse and validate one client WebSocket text frame. Fails loud."""
    try:
        data = json.loads(raw)
    except json.JSONDecodeError as exc:
        raise VoiceWireError(f"client frame is not valid JSON: {exc}") from exc

    if not isinstance(data, dict):
        raise VoiceWireError("client frame must be a JSON object")

    kind = data.get("type")
    try:
        if kind == "sessionStart":
            return SessionStartMessage.model_validate(data)
        if kind == "audioFrame":
            return AudioFrameMessage.model_validate(data)
        if kind == "sessionStop":
            return SessionStopMessage.model_validate(data)
    except ValidationError as exc:
        raise VoiceWireError(f"invalid {kind} frame: {exc}") from exc

    raise VoiceWireError(f"unknown client message type: {kind!r}")


def recording_id_from_result(result: VoiceRecordingResult) -> str:
    """The stable public id for a persisted recording is its wav file stem."""
    return result.wav_path.stem


def _validate_recording_id(recording_id: str) -> str:
    if not RECORDING_ID_PATTERN.match(recording_id):
        raise VoiceWireError(f"invalid recording id: {recording_id!r}")
    return recording_id


def recording_wav_path(recording_id: str) -> Path:
    return VOICE_RECORDING_ROOT / f"{_validate_recording_id(recording_id)}.wav"


def recording_json_path(recording_id: str) -> Path:
    return VOICE_RECORDING_ROOT / f"{_validate_recording_id(recording_id)}.json"


def load_recording(recording_id: str) -> Recording:
    """Build a wire ``Recording`` from the sidecar JSON ``recording.py`` wrote."""
    json_path = recording_json_path(recording_id)
    if not json_path.exists():
        raise FileNotFoundError(f"recording not found: {recording_id}")

    payload = json.loads(json_path.read_text(encoding="utf-8"))
    summary = payload["summary"]
    transcript = payload.get("transcript")
    transcript_text = transcript["text"] if isinstance(transcript, dict) else None

    return Recording(
        id=recording_id,
        created_at=str(payload["createdAt"]),
        duration_seconds=float(summary["durationSeconds"]),
        transcript=transcript_text,
        sample_rate=int(summary["sampleRate"]),
    )


def list_recording_ids() -> list[str]:
    if not VOICE_RECORDING_ROOT.exists():
        return []

    ids = [
        path.stem
        for path in VOICE_RECORDING_ROOT.glob("session-*.json")
        if RECORDING_ID_PATTERN.match(path.stem)
    ]
    return sorted(ids)


def load_all_recordings() -> list[Recording]:
    return [load_recording(recording_id) for recording_id in list_recording_ids()]
