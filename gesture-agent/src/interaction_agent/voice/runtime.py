import tempfile
import time
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from math import isfinite
from numbers import Real
from pathlib import Path
from typing import Any, Final
from uuid import uuid4

import numpy as np
from numpy.typing import NDArray

from interaction_agent.paths import VOICE_MODEL_ROOT
from interaction_agent.voice.timing import emit_voice_timing


FAST_MODEL = "mlx-community/whisper-large-v3-turbo-q4"
BEST_MODEL = "mlx-community/whisper-large-v3-turbo"
SUPPORTED_MODELS = {FAST_MODEL, BEST_MODEL}
MODEL_COMPLETE_MARKER: Final = ".complete"
SUPPORTED_AUDIO_SUFFIXES = {
    ".flac",
    ".mp3",
    ".mp4",
    ".mpeg",
    ".mpga",
    ".m4a",
    ".ogg",
    ".wav",
    ".webm",
}
SUPPORTED_RESPONSE_FORMATS = {"json", "text", "srt", "verbose_json", "vtt"}
SUPPORTED_TIMESTAMP_GRANULARITIES = {"segment", "word"}
MAX_TRANSCRIPTION_COMPRESSION_RATIO: Final = 2.4
TRANSCRIPTION_DURATION_TOLERANCE_SECONDS: Final = 1.0
_MLX_INFERENCE_EXECUTOR = ThreadPoolExecutor(
    max_workers=1,
    thread_name_prefix="mlx-inference",
)
_MLX_MODELS_SEEN: set[str] = set()
_RUNTIME_READY_AT = time.perf_counter()


class VoiceRuntimeError(ValueError):
    pass


@dataclass(frozen=True)
class VoiceTranscriptionOptions:
    model: str
    purpose: str = "unspecified"
    language: str | None = "en"
    prompt: str | None = None
    temperature: float = 0.0
    word_timestamps: bool = False
    preamp_gain: float = 1.0
    condition_on_previous_text: bool = True


def validate_model(model: str) -> str:
    if model in SUPPORTED_MODELS:
        return model

    supported_models = ", ".join(sorted(SUPPORTED_MODELS))
    raise VoiceRuntimeError(
        f"Unsupported transcription model: {model}. Supported models: {supported_models}"
    )


def local_model_dir(model: str) -> Path:
    safe_name = model.replace("/", "__")
    return VOICE_MODEL_ROOT / f"mlx-{safe_name}"


def ensure_local_model(model: str) -> Path:
    validated_model = validate_model(model)
    model_dir = local_model_dir(validated_model)
    marker = model_dir / MODEL_COMPLETE_MARKER
    if marker.exists():
        return model_dir

    from huggingface_hub import snapshot_download

    model_dir.mkdir(parents=True, exist_ok=True)
    snapshot_download(
        repo_id=validated_model,
        local_dir=model_dir,
        max_workers=4,
    )
    marker.write_text(validated_model + "\n")
    return model_dir


def validate_temperature(temperature: float) -> float:
    if not 0 <= temperature <= 1:
        raise VoiceRuntimeError("temperature must be between 0 and 1")
    return temperature


def audio_suffix_for(filename: str | None, audio_format: str | None = None) -> str:
    if audio_format:
        suffix = f".{audio_format.lstrip('.').lower()}"
    else:
        suffix = Path(filename or "audio.m4a").suffix.lower() or ".m4a"

    if suffix not in SUPPORTED_AUDIO_SUFFIXES:
        raise VoiceRuntimeError(f"Unsupported audio format: {suffix}")

    return suffix


def duration_from_segments(segments: list[dict[str, Any]] | None) -> float | None:
    if not segments:
        return None

    end = segments[-1].get("end")
    if isinstance(end, (int, float)):
        return float(end)

    return None


def format_timestamp(seconds: float, separator: str) -> str:
    milliseconds = round(seconds * 1000)
    hours = milliseconds // 3_600_000
    milliseconds %= 3_600_000
    minutes = milliseconds // 60_000
    milliseconds %= 60_000
    whole_seconds = milliseconds // 1_000
    milliseconds %= 1_000

    return f"{hours:02}:{minutes:02}:{whole_seconds:02}{separator}{milliseconds:03}"


def format_srt(segments: list[dict[str, Any]] | None) -> str:
    if not segments:
        return ""

    captions = []
    for index, segment in enumerate(segments, start=1):
        start = float(segment["start"])
        end = float(segment["end"])
        text = str(segment["text"]).strip()
        captions.append(
            "\n".join(
                [
                    str(index),
                    f"{format_timestamp(start, ',')} --> {format_timestamp(end, ',')}",
                    text,
                ]
            )
        )

    return "\n\n".join(captions) + "\n"


def format_vtt(segments: list[dict[str, Any]] | None) -> str:
    if not segments:
        return "WEBVTT\n\n"

    cues = ["WEBVTT"]
    for segment in segments:
        start = float(segment["start"])
        end = float(segment["end"])
        text = str(segment["text"]).strip()
        cues.append(
            "\n".join(
                [
                    f"{format_timestamp(start, '.')} --> {format_timestamp(end, '.')}",
                    text,
                ]
            )
        )

    return "\n\n".join(cues) + "\n"


def transcribe_audio_path(
    audio_path: Path,
    options: VoiceTranscriptionOptions,
) -> dict[str, Any]:
    """Run one transcription through the process-wide MLX inference owner."""
    validate_model(options.model)
    validate_temperature(options.temperature)
    if not isfinite(options.preamp_gain) or options.preamp_gain <= 0:
        raise VoiceRuntimeError("preamp_gain must be finite and greater than zero")

    submitted_at = time.perf_counter()
    return _MLX_INFERENCE_EXECUTOR.submit(
        _transcribe_audio_path_owned,
        audio_path,
        options,
        submitted_at,
    ).result()


def _transcribe_audio_path_owned(
    audio_path: Path,
    options: VoiceTranscriptionOptions,
    submitted_at: float,
) -> dict[str, Any]:
    """Perform MLX work on the executor's single worker thread."""
    started_at = time.perf_counter()
    mlx_import_ms = 0.0
    model_resolution_ms = 0.0
    model_cache_hit: bool | None = None
    model_resident_before_call: bool | None = None
    model_resident_after_call: bool | None = None
    audio_prepare_ms = 0.0
    mlx_call_ms = 0.0
    validation_ms = 0.0
    cold_start = options.model not in _MLX_MODELS_SEEN
    mlx_attempted = False
    success = False
    error_type: str | None = None

    try:
        mlx_import_started_at = time.perf_counter()
        import mlx_whisper
        from mlx_whisper.transcribe import ModelHolder

        mlx_import_ms = _elapsed_ms(mlx_import_started_at)
        model_dir = local_model_dir(options.model)
        model_cache_hit = (model_dir / MODEL_COMPLETE_MARKER).exists()
        model_resolution_started_at = time.perf_counter()
        local_model = ensure_local_model(options.model)
        model_resolution_ms = _elapsed_ms(model_resolution_started_at)
        model_path = str(local_model)
        model_resident_before_call = (
            ModelHolder.model is not None
            and ModelHolder.model_path == model_path
        )

        whisper_options: dict[str, Any] = {
            "path_or_hf_repo": model_path,
            "temperature": options.temperature,
            "word_timestamps": options.word_timestamps,
            "condition_on_previous_text": options.condition_on_previous_text,
        }

        if options.language is not None:
            whisper_options["language"] = options.language

        if options.prompt is not None:
            whisper_options["initial_prompt"] = options.prompt

        audio_prepare_started_at = time.perf_counter()
        audio: str | NDArray[np.float32] = str(audio_path)
        if options.preamp_gain != 1:
            loaded_audio = load_audio_for_transcription(audio_path)
            audio = np.clip(
                loaded_audio * options.preamp_gain,
                -1,
                1,
            ).astype(np.float32)
        audio_prepare_ms = _elapsed_ms(audio_prepare_started_at)

        _MLX_MODELS_SEEN.add(options.model)
        mlx_attempted = True
        mlx_started_at = time.perf_counter()
        result = mlx_whisper.transcribe(audio, **whisper_options)
        mlx_call_ms = _elapsed_ms(mlx_started_at)
        model_resident_after_call = (
            ModelHolder.model is not None
            and ModelHolder.model_path == model_path
        )
        if not isinstance(result, dict):
            raise VoiceRuntimeError("Unexpected transcription result")

        validation_started_at = time.perf_counter()
        validate_transcription_result(result)
        validation_ms = _elapsed_ms(validation_started_at)
        success = True
        return result
    except Exception as exc:
        error_type = type(exc).__name__
        raise
    finally:
        memory_fields = (
            _mlx_memory_fields()
            if mlx_attempted
            else {
                "activeMemoryBytes": None,
                "cacheMemoryBytes": None,
                "peakMemoryBytes": None,
            }
        )
        emit_voice_timing(
            "mlxTranscription",
            purpose=options.purpose,
            model=options.model,
            coldStart=cold_start,
            success=success,
            errorType=error_type,
            queueWaitMs=max(0.0, (started_at - submitted_at) * 1000),
            runtimeAgeAtSubmitMs=max(
                0.0,
                (submitted_at - _RUNTIME_READY_AT) * 1000,
            ),
            runtimeAgeAtExecutorStartMs=max(
                0.0,
                (started_at - _RUNTIME_READY_AT) * 1000,
            ),
            mlxImportMs=mlx_import_ms,
            modelResolutionMs=model_resolution_ms,
            modelCacheHit=model_cache_hit,
            modelResidentBeforeCall=model_resident_before_call,
            modelResidentAfterCall=model_resident_after_call,
            audioPrepareMs=audio_prepare_ms,
            mlxCallMs=mlx_call_ms,
            validationMs=validation_ms,
            executorMs=_elapsed_ms(started_at),
            totalMs=_elapsed_ms(submitted_at),
            **memory_fields,
        )


def _elapsed_ms(started_at: float) -> float:
    return max(0.0, (time.perf_counter() - started_at) * 1000)


def _mlx_memory_fields() -> dict[str, int | None]:
    try:
        import mlx.core as mx

        return {
            "activeMemoryBytes": int(mx.get_active_memory()),
            "cacheMemoryBytes": int(mx.get_cache_memory()),
            "peakMemoryBytes": int(mx.get_peak_memory()),
        }
    except Exception:
        return {
            "activeMemoryBytes": None,
            "cacheMemoryBytes": None,
            "peakMemoryBytes": None,
        }


def validate_transcription_result(
    result: dict[str, Any],
    *,
    audio_duration_seconds: float | None = None,
    require_usable_text: bool = False,
) -> str:
    """Reject structurally corrupt or unusable Whisper output."""
    text_value = result.get("text")
    if not isinstance(text_value, str):
        raise VoiceRuntimeError("Invalid transcription text")
    text = text_value.strip()

    duration_limit: float | None = None
    if audio_duration_seconds is not None:
        duration = _finite_transcription_number(
            audio_duration_seconds,
            "audio duration",
        )
        if duration < 0:
            raise VoiceRuntimeError("Invalid transcription audio duration")
        duration_limit = duration + TRANSCRIPTION_DURATION_TOLERANCE_SECONDS

    result_duration = result.get("duration")
    if result_duration is not None:
        duration = _finite_transcription_number(
            result_duration,
            "duration",
        )
        if duration < 0 or (
            duration_limit is not None and duration > duration_limit
        ):
            raise VoiceRuntimeError("Invalid transcription duration")

    segments = result.get("segments")
    if segments is not None:
        if not isinstance(segments, list):
            raise VoiceRuntimeError("Invalid transcription segments")
        previous_start = 0.0
        previous_end = 0.0
        for index, segment in enumerate(segments):
            if not isinstance(segment, dict):
                raise VoiceRuntimeError(
                    f"Invalid transcription segment {index}"
                )
            start = _finite_transcription_number(
                segment.get("start"),
                f"segment {index} start",
            )
            end = _finite_transcription_number(
                segment.get("end"),
                f"segment {index} end",
            )
            if (
                start < 0
                or end < start
                or start < previous_start
                or end < previous_end
                or (duration_limit is not None and end > duration_limit)
            ):
                raise VoiceRuntimeError(
                    f"Invalid transcription segment {index} timing"
                )
            previous_start = start
            previous_end = end

            if "avg_logprob" in segment:
                _finite_transcription_number(
                    segment["avg_logprob"],
                    f"segment {index} average log probability",
                )
            if "compression_ratio" in segment:
                compression_ratio = _finite_transcription_number(
                    segment["compression_ratio"],
                    f"segment {index} compression ratio",
                )
                if not 0 <= compression_ratio <= MAX_TRANSCRIPTION_COMPRESSION_RATIO:
                    raise VoiceRuntimeError(
                        f"Invalid transcription segment {index} compression ratio"
                    )
            if "no_speech_prob" in segment:
                no_speech_probability = _finite_transcription_number(
                    segment["no_speech_prob"],
                    f"segment {index} no-speech probability",
                )
                if not 0 <= no_speech_probability <= 1:
                    raise VoiceRuntimeError(
                        f"Invalid transcription segment {index} no-speech probability"
                    )

    if require_usable_text and not any(character.isalnum() for character in text):
        raise VoiceRuntimeError("The transcription contained no usable speech")

    return text


def _finite_transcription_number(value: object, field: str) -> float:
    if isinstance(value, bool) or not isinstance(value, Real):
        raise VoiceRuntimeError(f"Invalid transcription {field}")
    number = float(value)
    if not isfinite(number):
        raise VoiceRuntimeError(f"Invalid transcription {field}")
    return number


def load_audio_for_transcription(audio_path: Path) -> NDArray[np.float32]:
    """Decode and resample with the same loader used by MLX Whisper."""
    from mlx_whisper.audio import load_audio

    return np.asarray(load_audio(str(audio_path)), dtype=np.float32)


def transcribe_audio_bytes(
    audio: bytes,
    audio_format: str,
    options: VoiceTranscriptionOptions,
) -> dict[str, Any]:
    suffix = audio_suffix_for(None, audio_format)
    temp_dir = Path(tempfile.gettempdir()) / "gesture-agent-voice"
    temp_dir.mkdir(exist_ok=True)
    audio_path = temp_dir / f"{uuid4().hex}{suffix}"
    audio_path.write_bytes(audio)

    try:
        return transcribe_audio_path(audio_path, options)
    finally:
        audio_path.unlink(missing_ok=True)


def transcript_text(result: dict[str, Any]) -> str:
    return str(result.get("text", "")).strip()
