import os
from dataclasses import dataclass
from typing import Final

DEFAULT_REPLAY_VOLUME: Final = 0.25
DEFAULT_REPLAY_BUFFER_SECONDS: Final = 0.75
DEFAULT_TRANSCRIPTION_PREAMP: Final = 4.0
DEFAULT_FINAL_TRANSCRIPTION_MODEL: Final = "mlx-community/whisper-large-v3-turbo-q4"
DEFAULT_LIVE_MLX_CHUNK_SECONDS: Final = 6.0
DEFAULT_LIVE_MLX_INTERVAL_SECONDS: Final = 2.0
DEFAULT_LIVE_MLX_MIN_SECONDS: Final = 1.5
DEFAULT_REFERENCE_SPEECH_CACHE_BYTES: Final = 2 * 1024 * 1024 * 1024


@dataclass(frozen=True)
class VoiceRuntimeConfig:
    replay_volume: float
    replay_buffer_seconds: float
    transcription_preamp: float
    final_transcription_model: str
    live_mlx_chunk_seconds: float
    live_mlx_interval_seconds: float
    live_mlx_min_seconds: float
    reference_speech_cache_bytes: int


def load_voice_runtime_config() -> VoiceRuntimeConfig:
    return VoiceRuntimeConfig(
        replay_volume=float_env("VOICE_REPLAY_VOLUME", DEFAULT_REPLAY_VOLUME),
        replay_buffer_seconds=float_env(
            "VOICE_REPLAY_BUFFER_SECONDS",
            DEFAULT_REPLAY_BUFFER_SECONDS,
        ),
        transcription_preamp=float_env(
            "VOICE_TRANSCRIPTION_PREAMP",
            DEFAULT_TRANSCRIPTION_PREAMP,
        ),
        final_transcription_model=os.environ.get(
            "VOICE_FINAL_TRANSCRIPTION_MODEL",
            DEFAULT_FINAL_TRANSCRIPTION_MODEL,
        ),
        live_mlx_chunk_seconds=float_env(
            "VOICE_LIVE_MLX_CHUNK_SECONDS",
            DEFAULT_LIVE_MLX_CHUNK_SECONDS,
        ),
        live_mlx_interval_seconds=float_env(
            "VOICE_LIVE_MLX_INTERVAL_SECONDS",
            DEFAULT_LIVE_MLX_INTERVAL_SECONDS,
        ),
        live_mlx_min_seconds=float_env(
            "VOICE_LIVE_MLX_MIN_SECONDS",
            DEFAULT_LIVE_MLX_MIN_SECONDS,
        ),
        reference_speech_cache_bytes=int_env(
            "VOICE_REFERENCE_SPEECH_CACHE_BYTES",
            DEFAULT_REFERENCE_SPEECH_CACHE_BYTES,
        ),
    )


def float_env(name: str, default: float) -> float:
    raw_value = os.environ.get(name)
    if raw_value is None or raw_value == "":
        return default

    try:
        return float(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be a number") from exc


def int_env(name: str, default: int) -> int:
    raw_value = os.environ.get(name)
    if raw_value is None or raw_value == "":
        return default
    try:
        value = int(raw_value)
    except ValueError as exc:
        raise ValueError(f"{name} must be an integer") from exc
    if value <= 0:
        raise ValueError(f"{name} must be greater than zero")
    return value
