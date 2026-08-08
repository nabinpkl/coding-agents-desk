"""Host-owned CMUdict-to-Kokoro reference speech artifacts.

`ReferenceSpeechArtifactStore` is the external interface. Callers identify a
versioned practice passage and a passage/word scope; the module owns pronunciation,
direct-token synthesis, provenance, atomic persistence, and cache reuse.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import tempfile
import threading
import wave
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Final, Literal, Protocol

import numpy as np

if TYPE_CHECKING:
    import torch
    from kokoro import KModel

from interaction_agent.paths import VOICE_MODEL_ROOT, VOICE_REFERENCE_SPEECH_ROOT
from interaction_agent.voice.config import load_voice_runtime_config
from interaction_agent.voice.kokoro_manifest import (
    DEFAULT_KOKORO_SPEED,
    DEFAULT_KOKORO_VOICE,
    KOKORO_CONFIG_FILENAME,
    KOKORO_CONFIG_SHA256,
    KOKORO_LICENSE,
    KOKORO_MAX_PHONEME_CHARACTERS,
    KOKORO_MODEL_FILENAME,
    KOKORO_MODEL_SHA256,
    KOKORO_PACKAGE_VERSION,
    KOKORO_REPOSITORY,
    KOKORO_REVISION,
    KOKORO_SAMPLE_RATE,
    KOKORO_VOICE_BY_IDENTIFIER,
    KOKORO_VOICES,
    MAXIMUM_KOKORO_SPEED,
    MINIMUM_KOKORO_SPEED,
    KokoroVoice,
)
from interaction_agent.voice.reference_pronunciation import (
    ReferencePronunciationError,
    reference_pronunciation,
)
from interaction_agent.voice.practice_passages import PracticePassageStore

ARTIFACT_SCHEMA_VERSION: Final = 1
ARTIFACT_ID_PATTERN: Final = re.compile(r"^[0-9a-f]{64}$")
CHUNK_PAUSE_SECONDS: Final = 0.05
KOKORO_PREWARM_IPA: Final = "həlˈoʊ"


class ReferenceSpeechError(RuntimeError):
    """A visible reference-speech contract or synthesis failure."""


class ReferenceSpeechSynthesisError(ReferenceSpeechError):
    """The validated request could not be executed by the pinned runtime."""


class ReferenceSpeechRevisionConflict(ReferenceSpeechError):
    """A caller used a word scope from an older intended-text revision."""


@dataclass(frozen=True)
class ReferenceSpeechScope:
    kind: Literal["passage", "word"]
    index: int | None = None


@dataclass(frozen=True)
class ReferenceSpeechArtifact:
    id: str
    audio_hash: str
    text: str
    ipa: str
    duration_seconds: float
    sample_rate: int
    cache_hit: bool
    voice_identifier: str
    speed: float
    model_identifier: str
    model_hash: str
    voice_hash: str
    dictionary_identifier: str
    dictionary_hash: str
    synthesis_mapping_hash: str
    synthesized_at: str


@dataclass(frozen=True)
class _CacheEntry:
    artifact_id: str
    metadata_path: Path
    audio_path: Path
    size: int
    last_accessed: float


@dataclass
class _ReferenceSpeechAudioLease:
    """Keep one cached WAV present until its response finishes."""

    path: Path
    _release_callback: Callable[[], None]
    _released: bool = False

    def release(self) -> None:
        if self._released:
            return
        self._released = True
        self._release_callback()


class ReferenceSpeechSynthesizer(Protocol):
    @property
    def status(self) -> Literal["unavailable", "preparing", "ready", "failed"]: ...

    @property
    def error(self) -> str | None: ...

    def prewarm(self) -> bool: ...

    def synthesize(
        self,
        chunks: tuple[str, ...],
        voice: KokoroVoice,
        speed: float,
    ) -> np.ndarray: ...


class KokoroDirectSynthesizer:
    """Pinned Kokoro runtime that never constructs or invokes a G2P pipeline."""

    def __init__(self, model_root: Path = VOICE_MODEL_ROOT) -> None:
        self._root = model_root / "kokoro" / KOKORO_REVISION
        self._status: Literal["unavailable", "preparing", "ready", "failed"] = (
            "unavailable"
        )
        self._error: str | None = None
        self._model: KModel | None = None
        self._vocabulary: frozenset[str] | None = None
        self._voice_packs: dict[str, torch.FloatTensor] = {}
        self._inference_warm = False

    @property
    def status(self) -> Literal["unavailable", "preparing", "ready", "failed"]:
        return self._status

    @property
    def error(self) -> str | None:
        return self._error

    def prewarm(self) -> bool:
        """Exercise the retained model and default voice once."""
        if self._inference_warm:
            return False
        voice = KOKORO_VOICE_BY_IDENTIFIER[DEFAULT_KOKORO_VOICE]
        self.synthesize(
            (KOKORO_PREWARM_IPA,),
            voice,
            DEFAULT_KOKORO_SPEED,
        )
        return True

    def synthesize(
        self,
        chunks: tuple[str, ...],
        voice: KokoroVoice,
        speed: float,
    ) -> np.ndarray:
        try:
            self._prepare_model()
            voice_pack = self._prepare_voice(voice)
            import torch
            from kokoro import KPipeline

            assert self._model is not None
            assert self._vocabulary is not None
            audio_chunks: list[np.ndarray] = []
            for index, chunk in enumerate(chunks):
                unsupported = sorted(set(chunk) - self._vocabulary)
                if unsupported:
                    formatted = " ".join(repr(symbol) for symbol in unsupported)
                    raise ReferenceSpeechError(
                        f"Kokoro does not support IPA symbols: {formatted}"
                    )
                with torch.inference_mode():
                    output = KPipeline.infer(
                        self._model,
                        chunk,
                        voice_pack,
                        speed,
                    )
                audio = output.audio.detach().cpu().numpy().astype(np.float32)
                if audio.size == 0:
                    raise ReferenceSpeechError("Kokoro returned empty audio")
                if index:
                    audio_chunks.append(
                        np.zeros(
                            round(KOKORO_SAMPLE_RATE * CHUNK_PAUSE_SECONDS),
                            dtype=np.float32,
                        )
                    )
                audio_chunks.append(audio)
            self._inference_warm = True
            self._status = "ready"
            self._error = None
            return np.concatenate(audio_chunks)
        except Exception as exc:
            self._status = "failed"
            self._error = f"Kokoro synthesis failed: {exc}"
            raise ReferenceSpeechSynthesisError(self._error) from exc

    def _prepare_model(self) -> None:
        if self._model is not None:
            self._status = "ready"
            return
        self._status = "preparing"
        config_path = self._download_verified(
            KOKORO_CONFIG_FILENAME,
            KOKORO_CONFIG_SHA256,
        )
        model_path = self._download_verified(
            KOKORO_MODEL_FILENAME,
            KOKORO_MODEL_SHA256,
        )
        config = json.loads(config_path.read_text(encoding="utf-8"))
        vocabulary = config.get("vocab")
        if not isinstance(vocabulary, dict):
            raise ReferenceSpeechError("Kokoro config has no vocabulary")
        self._vocabulary = frozenset(str(symbol) for symbol in vocabulary)
        from kokoro import KModel

        self._model = (
            KModel(
                repo_id=KOKORO_REPOSITORY,
                config=str(config_path),
                model=str(model_path),
            )
            .to("cpu")
            .eval()
        )
        self._status = "ready"
        self._error = None

    def prepare_assets(
        self,
        voices: tuple[KokoroVoice, ...] = KOKORO_VOICES,
    ) -> None:
        """Download, hash-check, and load the pinned model and requested voices."""
        self._prepare_model()
        for voice in voices:
            self._prepare_voice(voice)

    def _prepare_voice(self, voice: KokoroVoice) -> torch.FloatTensor:
        if voice.identifier in self._voice_packs:
            return self._voice_packs[voice.identifier]
        voice_path = self._download_verified(voice.filename, voice.hash)
        import torch

        pack = torch.load(voice_path, map_location="cpu", weights_only=True)
        self._voice_packs[voice.identifier] = pack
        return pack

    def _download_verified(self, filename: str, expected_hash: str) -> Path:
        from huggingface_hub import hf_hub_download

        self._root.mkdir(parents=True, exist_ok=True)
        path = Path(
            hf_hub_download(
                repo_id=KOKORO_REPOSITORY,
                filename=filename,
                revision=KOKORO_REVISION,
                local_dir=self._root,
            )
        )
        actual_hash = _sha256_file(path)
        if actual_hash != expected_hash:
            path.unlink(missing_ok=True)
            raise ReferenceSpeechError(f"Kokoro asset hash mismatch for {filename}")
        return path


class ReferenceSpeechArtifactStore:
    """Resolve a versioned practice-passage scope into one durable host WAV."""

    def __init__(
        self,
        *,
        root: Path = VOICE_REFERENCE_SPEECH_ROOT,
        passage_loader: Callable[[str], object] | None = None,
        synthesizer: ReferenceSpeechSynthesizer | None = None,
        cache_max_bytes: int | None = None,
    ) -> None:
        self._root = root
        self._artifact_root = root / "artifacts"
        self._passage_loader = (
            passage_loader
            if passage_loader is not None
            else PracticePassageStore().get_passage
        )
        self._synthesizer = synthesizer or KokoroDirectSynthesizer()
        self._cache_max_bytes = (
            cache_max_bytes
            if cache_max_bytes is not None
            else load_voice_runtime_config().reference_speech_cache_bytes
        )
        if self._cache_max_bytes <= 0:
            raise ValueError("reference-speech cache limit must be greater than zero")
        self._cache_lock = threading.Lock()
        self._synthesis_lock = threading.Lock()
        self._leased_artifacts: dict[str, int] = {}

    def prewarm(self) -> bool:
        """Maintain the cache, then warm the retained synthesizer."""
        with self._cache_lock:
            self._prune()
        with self._synthesis_lock:
            return self._synthesizer.prewarm()

    def state(self) -> dict[str, object]:
        with self._cache_lock:
            cache_size = self._cache_size()
        return {
            "schemaVersion": ARTIFACT_SCHEMA_VERSION,
            "status": self._synthesizer.status,
            "error": self._synthesizer.error,
            "language": "en-US",
            "voices": [
                {
                    "identifier": voice.identifier,
                    "name": voice.name,
                    "language": "en-US",
                }
                for voice in KOKORO_VOICES
            ],
            "defaultVoiceIdentifier": DEFAULT_KOKORO_VOICE,
            "speed": {
                "minimum": MINIMUM_KOKORO_SPEED,
                "defaultValue": DEFAULT_KOKORO_SPEED,
                "maximum": MAXIMUM_KOKORO_SPEED,
            },
            "modelIdentifier": f"{KOKORO_REPOSITORY}@{KOKORO_REVISION}",
            "modelHash": KOKORO_MODEL_SHA256,
            "runtimeIdentifier": f"kokoro-python {KOKORO_PACKAGE_VERSION}",
            "license": KOKORO_LICENSE,
            "cacheBytes": cache_size,
            "cacheMaximumBytes": self._cache_max_bytes,
        }

    def create(
        self,
        *,
        passage_id: str,
        passage_revision: int,
        scope: ReferenceSpeechScope,
        voice_identifier: str,
        speed: float,
    ) -> ReferenceSpeechArtifact:
        voice = KOKORO_VOICE_BY_IDENTIFIER.get(voice_identifier)
        if voice is None:
            raise ReferenceSpeechError("That Kokoro voice is unavailable")
        if not np.isfinite(speed):
            raise ReferenceSpeechError("Reference speed must be finite")
        if speed < MINIMUM_KOKORO_SPEED or speed > MAXIMUM_KOKORO_SPEED:
            raise ReferenceSpeechError(
                f"Reference speed must be between {MINIMUM_KOKORO_SPEED} and "
                f"{MAXIMUM_KOKORO_SPEED}"
            )
        passage = self._passage_loader(passage_id)
        current_revision = getattr(passage, "revision", None)
        if current_revision != passage_revision:
            raise ReferenceSpeechRevisionConflict(
                "The practice passage changed; refresh before playing reference speech"
            )
        intended_text = getattr(passage, "intended_text", None)
        if not isinstance(intended_text, str) or not intended_text.strip():
            raise ReferenceSpeechError(
                "This practice passage has no intended text to pronounce"
            )
        try:
            pronunciation = reference_pronunciation(intended_text)
        except ReferencePronunciationError as exc:
            raise ReferenceSpeechError(str(exc)) from exc

        if scope.kind == "passage":
            if scope.index is not None:
                raise ReferenceSpeechError("Passage scope cannot include an index")
            if pronunciation.unknown_words:
                unknown = ", ".join(pronunciation.unknown_words)
                raise ReferenceSpeechError(
                    f"CMUdict has no pronunciation for: {unknown}"
                )
            text = pronunciation.text
            ipa = pronunciation.passage_ipa
        elif scope.kind == "word":
            if scope.index is None or scope.index < 0:
                raise ReferenceSpeechError("Word scope requires a valid index")
            try:
                word = pronunciation.words[scope.index]
            except IndexError as exc:
                raise ReferenceSpeechError("The requested word is stale") from exc
            if not word.is_known:
                raise ReferenceSpeechError(
                    f"CMUdict has no pronunciation for: {word.word}"
                )
            text = word.word
            ipa = word.kokoro_ipa
        else:
            raise ReferenceSpeechError("Unsupported reference-speech scope")
        if not ipa:
            raise ReferenceSpeechError("The reference pronunciation is empty")

        chunks = chunk_kokoro_ipa(ipa)
        identity = {
            "schemaVersion": ARTIFACT_SCHEMA_VERSION,
            "text": text,
            "ipa": ipa,
            "chunks": list(chunks),
            "voiceIdentifier": voice.identifier,
            "voiceHash": voice.hash,
            "speed": f"{speed:.2f}",
            "modelIdentifier": f"{KOKORO_REPOSITORY}@{KOKORO_REVISION}",
            "modelHash": KOKORO_MODEL_SHA256,
            "dictionaryIdentifier": pronunciation.dictionary_identifier,
            "dictionaryHash": pronunciation.dictionary_hash,
            "synthesisMappingHash": pronunciation.synthesis_mapping_hash,
            "sampleRate": KOKORO_SAMPLE_RATE,
        }
        artifact_id = hashlib.sha256(
            json.dumps(
                identity,
                ensure_ascii=False,
                sort_keys=True,
                separators=(",", ":"),
            ).encode("utf-8")
        ).hexdigest()
        with self._cache_lock:
            cached = self._load_cached(artifact_id)
            if cached is not None:
                return cached

        with self._synthesis_lock:
            with self._cache_lock:
                cached = self._load_cached(artifact_id)
                if cached is not None:
                    return cached
            audio = self._synthesizer.synthesize(chunks, voice, speed)
            synthesized_at = datetime.now(UTC).isoformat()
            duration = audio.size / KOKORO_SAMPLE_RATE
            metadata = {
                **identity,
                "id": artifact_id,
                "durationSeconds": duration,
                "synthesizedAt": synthesized_at,
            }
            with self._cache_lock:
                self._persist(artifact_id, audio, metadata)
                metadata_path = self._artifact_root / f"{artifact_id}.json"
                audio_path = self._artifact_root / f"{artifact_id}.wav"
                artifact_size = (
                    metadata_path.stat().st_size + audio_path.stat().st_size
                )
                if artifact_size > self._cache_max_bytes:
                    metadata_path.unlink(missing_ok=True)
                    audio_path.unlink(missing_ok=True)
                    raise ReferenceSpeechSynthesisError(
                        "Generated reference speech exceeds the "
                        f"reference-speech cache limit of {self._cache_max_bytes} bytes"
                    )
                self._prune(protected_artifact_ids=frozenset({artifact_id}))
            return self._artifact_from_metadata(metadata, cache_hit=False)

    def audio_path(self, artifact_id: str) -> Path:
        """Resolve a cached WAV for local inspection without a response lease."""
        if ARTIFACT_ID_PATTERN.fullmatch(artifact_id) is None:
            raise ReferenceSpeechError("Invalid reference-speech artifact ID")
        with self._cache_lock:
            if self._load_cached(artifact_id) is None:
                raise ReferenceSpeechError("Reference-speech artifact not found")
            return self._artifact_root / f"{artifact_id}.wav"

    def lease_audio(self, artifact_id: str) -> _ReferenceSpeechAudioLease:
        """Resolve a WAV and defer its eviction until the caller releases it."""
        if ARTIFACT_ID_PATTERN.fullmatch(artifact_id) is None:
            raise ReferenceSpeechError("Invalid reference-speech artifact ID")
        with self._cache_lock:
            if self._load_cached(artifact_id) is None:
                raise ReferenceSpeechError("Reference-speech artifact not found")
            self._leased_artifacts[artifact_id] = (
                self._leased_artifacts.get(artifact_id, 0) + 1
            )
            path = self._artifact_root / f"{artifact_id}.wav"
        return _ReferenceSpeechAudioLease(
            path=path,
            _release_callback=lambda: self._release_audio(artifact_id),
        )

    def _release_audio(self, artifact_id: str) -> None:
        with self._cache_lock:
            lease_count = self._leased_artifacts.get(artifact_id)
            if lease_count is None:
                raise RuntimeError("reference-speech audio lease was not active")
            if lease_count == 1:
                del self._leased_artifacts[artifact_id]
            else:
                self._leased_artifacts[artifact_id] = lease_count - 1
            self._prune()

    def _load_cached(self, artifact_id: str) -> ReferenceSpeechArtifact | None:
        metadata_path = self._artifact_root / f"{artifact_id}.json"
        audio_path = self._artifact_root / f"{artifact_id}.wav"
        if not metadata_path.is_file() or not audio_path.is_file():
            metadata_path.unlink(missing_ok=True)
            audio_path.unlink(missing_ok=True)
            return None
        try:
            metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
            if metadata.get("id") != artifact_id:
                raise ValueError("artifact identity mismatch")
            if metadata.get("audioHash") != _sha256_file(audio_path):
                raise ValueError("artifact audio hash mismatch")
            artifact = self._artifact_from_metadata(metadata, cache_hit=True)
        except (
            OSError,
            UnicodeDecodeError,
            json.JSONDecodeError,
            TypeError,
            ValueError,
            KeyError,
        ):
            metadata_path.unlink(missing_ok=True)
            audio_path.unlink(missing_ok=True)
            return None
        os.utime(metadata_path)
        return artifact

    def _persist(
        self,
        artifact_id: str,
        audio: np.ndarray,
        metadata: dict[str, object],
    ) -> None:
        self._artifact_root.mkdir(parents=True, exist_ok=True)
        pcm = (np.clip(audio, -1.0, 1.0) * np.iinfo(np.int16).max).astype("<i2")
        wav_target = self._artifact_root / f"{artifact_id}.wav"
        json_target = self._artifact_root / f"{artifact_id}.json"
        wav_fd, wav_name = tempfile.mkstemp(
            prefix=f".{artifact_id}-",
            suffix=".wav",
            dir=self._artifact_root,
        )
        json_fd, json_name = tempfile.mkstemp(
            prefix=f".{artifact_id}-",
            suffix=".json",
            dir=self._artifact_root,
        )
        os.close(wav_fd)
        os.close(json_fd)
        wav_temp = Path(wav_name)
        json_temp = Path(json_name)
        try:
            with wave.open(str(wav_temp), "wb") as output:
                output.setnchannels(1)
                output.setsampwidth(2)
                output.setframerate(KOKORO_SAMPLE_RATE)
                output.writeframes(pcm.tobytes())
            metadata["audioHash"] = _sha256_file(wav_temp)
            json_temp.write_text(
                json.dumps(
                    metadata,
                    ensure_ascii=False,
                    sort_keys=True,
                    separators=(",", ":"),
                ),
                encoding="utf-8",
            )
            wav_temp.replace(wav_target)
            json_temp.replace(json_target)
        finally:
            wav_temp.unlink(missing_ok=True)
            json_temp.unlink(missing_ok=True)

    def _artifact_from_metadata(
        self,
        metadata: dict[str, object],
        *,
        cache_hit: bool,
    ) -> ReferenceSpeechArtifact:
        return ReferenceSpeechArtifact(
            id=_metadata_string(metadata, "id"),
            audio_hash=_metadata_string(metadata, "audioHash"),
            text=_metadata_string(metadata, "text"),
            ipa=_metadata_string(metadata, "ipa"),
            duration_seconds=_metadata_float(metadata, "durationSeconds"),
            sample_rate=_metadata_int(metadata, "sampleRate"),
            cache_hit=cache_hit,
            voice_identifier=_metadata_string(metadata, "voiceIdentifier"),
            speed=_metadata_float(metadata, "speed"),
            model_identifier=_metadata_string(metadata, "modelIdentifier"),
            model_hash=_metadata_string(metadata, "modelHash"),
            voice_hash=_metadata_string(metadata, "voiceHash"),
            dictionary_identifier=_metadata_string(
                metadata,
                "dictionaryIdentifier",
            ),
            dictionary_hash=_metadata_string(metadata, "dictionaryHash"),
            synthesis_mapping_hash=_metadata_string(
                metadata,
                "synthesisMappingHash",
            ),
            synthesized_at=_metadata_string(metadata, "synthesizedAt"),
        )

    def _cache_size(self) -> int:
        if not self._artifact_root.is_dir():
            return 0
        return sum(
            path.stat().st_size
            for path in self._artifact_root.iterdir()
            if path.is_file()
        )

    def _prune(
        self,
        *,
        protected_artifact_ids: frozenset[str] = frozenset(),
    ) -> None:
        """Remove incomplete files, then evict complete pairs by last access."""
        if not self._artifact_root.is_dir():
            return

        paths_by_artifact: dict[str, dict[str, Path]] = {}
        for path in tuple(self._artifact_root.iterdir()):
            if not path.is_file():
                continue
            if (
                path.suffix not in {".json", ".wav"}
                or ARTIFACT_ID_PATTERN.fullmatch(path.stem) is None
            ):
                path.unlink()
                continue
            paths_by_artifact.setdefault(path.stem, {})[path.suffix] = path

        entries: list[_CacheEntry] = []
        for artifact_id, paths in paths_by_artifact.items():
            metadata_path = paths.get(".json")
            audio_path = paths.get(".wav")
            if metadata_path is None or audio_path is None:
                for path in paths.values():
                    path.unlink(missing_ok=True)
                continue
            entries.append(
                _CacheEntry(
                    artifact_id=artifact_id,
                    metadata_path=metadata_path,
                    audio_path=audio_path,
                    size=metadata_path.stat().st_size + audio_path.stat().st_size,
                    last_accessed=metadata_path.stat().st_mtime,
                )
            )

        total = sum(entry.size for entry in entries)
        for entry in sorted(entries, key=lambda candidate: candidate.last_accessed):
            if total <= self._cache_max_bytes:
                break
            if (
                entry.artifact_id in protected_artifact_ids
                or entry.artifact_id in self._leased_artifacts
            ):
                continue
            entry.metadata_path.unlink(missing_ok=True)
            entry.audio_path.unlink(missing_ok=True)
            total -= entry.size


def chunk_kokoro_ipa(ipa: str) -> tuple[str, ...]:
    """Split only between words while respecting Kokoro's hard character cap."""
    units = ipa.split()
    if not units:
        raise ReferenceSpeechError("The reference pronunciation is empty")
    chunks: list[str] = []
    current = ""
    for unit in units:
        if len(unit) > KOKORO_MAX_PHONEME_CHARACTERS:
            raise ReferenceSpeechError("One reference word exceeds Kokoro's limit")
        candidate = unit if not current else f"{current} {unit}"
        if len(candidate) <= KOKORO_MAX_PHONEME_CHARACTERS:
            current = candidate
            continue
        chunks.append(current)
        current = unit
    chunks.append(current)
    return tuple(chunks)


def _sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as input_file:
        for chunk in iter(lambda: input_file.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _metadata_string(metadata: dict[str, object], key: str) -> str:
    value = metadata[key]
    if not isinstance(value, str):
        raise TypeError(f"reference-speech metadata {key} is not a string")
    return value


def _metadata_float(metadata: dict[str, object], key: str) -> float:
    value = metadata[key]
    if not isinstance(value, int | float | str) or isinstance(value, bool):
        raise TypeError(f"reference-speech metadata {key} is not numeric")
    return float(value)


def _metadata_int(metadata: dict[str, object], key: str) -> int:
    value = metadata[key]
    if not isinstance(value, int) or isinstance(value, bool):
        raise TypeError(f"reference-speech metadata {key} is not an integer")
    return value


def main() -> None:
    """Prepare and verify every pinned Kokoro runtime asset."""
    synthesizer = KokoroDirectSynthesizer()
    synthesizer.prepare_assets()
    print(
        f"Prepared {KOKORO_REPOSITORY}@{KOKORO_REVISION} "
        f"with {len(KOKORO_VOICES)} voices"
    )


if __name__ == "__main__":
    main()
