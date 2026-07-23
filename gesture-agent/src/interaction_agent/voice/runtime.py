import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final
from uuid import uuid4

from interaction_agent.paths import VOICE_MODEL_ROOT


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


class VoiceRuntimeError(ValueError):
    pass


@dataclass(frozen=True)
class VoiceTranscriptionOptions:
    model: str
    language: str | None = "en"
    prompt: str | None = None
    temperature: float = 0.0
    word_timestamps: bool = False


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
    import mlx_whisper

    local_model = ensure_local_model(options.model)
    temperature = validate_temperature(options.temperature)
    whisper_options: dict[str, Any] = {
        "path_or_hf_repo": str(local_model),
        "temperature": temperature,
        "word_timestamps": options.word_timestamps,
    }

    if options.language is not None:
        whisper_options["language"] = options.language

    if options.prompt is not None:
        whisper_options["initial_prompt"] = options.prompt

    result = mlx_whisper.transcribe(str(audio_path), **whisper_options)
    if not isinstance(result, dict):
        raise VoiceRuntimeError("Unexpected transcription result")

    return result


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
