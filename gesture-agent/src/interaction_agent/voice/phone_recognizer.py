"""Pinned ZIPA phone recognition for host-retained voice recordings.

This is the Python executor for the same model and frontend used by the native
Passage experiment. Model identity is read from the shared manifest; executor
identity is reported separately so persisted evidence does not confuse the
graph with the runtime that opened it.
"""

from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Final

import numpy as np
import onnxruntime as ort
from numpy.typing import NDArray

from interaction_agent.paths import VOICE_MODEL_ROOT
from interaction_agent.voice.pronunciation import load_wav

FloatArray = NDArray[np.float32]

MODEL_FILENAME: Final = "VoiceZIPAModel.onnx"
MANIFEST_FILENAME: Final = "VoiceZIPAModelManifest.json"
TOKENS_FILENAME: Final = "VoiceZIPATokens.txt"
LICENSE_FILENAME: Final = "VoiceZIPALicense.txt"
EXECUTOR_IDENTIFIER: Final = f"onnxruntime-python {ort.__version__}"

SAMPLE_RATE: Final = 16_000
FRAME_LENGTH: Final = 400
FRAME_SHIFT: Final = 160
FFT_LENGTH: Final = 512
FILTER_COUNT: Final = 80
PREEMPHASIS: Final = np.float32(0.97)
CHUNK_SECONDS: Final = 12
OVERLAP_SECONDS: Final = 0.4

PAIRED_PHONES: Final = frozenset(("aɪ", "aʊ", "dʒ", "eɪ", "oʊ", "tʃ", "ɔɪ"))
MODIFIERS: Final = frozenset(
    ("ː", "˞", "ˠ", "ˤ", "̃", "̚", "̥", "̩", "̪", "̴", "̺", "ʰ", "ʲ", "ʷ")
)


@dataclass(frozen=True)
class PhoneRecognition:
    phones: tuple[str, ...]
    model_identifier: str
    model_hash: str
    runtime_identifier: str


class ZIPAModelError(RuntimeError):
    """The pinned assets or inference output violate the ZIPA contract."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        while chunk := handle.read(1024 * 1024):
            digest.update(chunk)
    return digest.hexdigest()


def _asset_root() -> Path:
    configured = os.environ.get("VOICE_ZIPA_MODEL_ROOT", "").strip()
    return Path(configured) if configured else VOICE_MODEL_ROOT / "zipa"


def parse_tokens(path: Path, expected_count: int) -> list[str]:
    indexed: dict[int, str] = {}
    for row, line in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        parts = line.split()
        if len(parts) != 2:
            raise ZIPAModelError(f"ZIPA token row {row} is malformed")
        token, raw_identifier = parts
        identifier = int(raw_identifier)
        if identifier in indexed:
            raise ZIPAModelError(f"ZIPA token ID {identifier} is duplicated")
        indexed[identifier] = token
    if set(indexed) != set(range(expected_count)):
        raise ZIPAModelError(
            f"ZIPA token IDs are not contiguous from 0 through {expected_count - 1}"
        )
    return [indexed[index] for index in range(expected_count)]


def merge_phone_units(tokens: list[str]) -> list[str]:
    phones: list[str] = []
    for token in tokens:
        if token in MODIFIERS and phones or phones and phones[-1] + token in PAIRED_PHONES:
            phones[-1] += token
        else:
            phones.append("ɡ" if token == "g" else token)
    return phones


def _reflected_indices(indices: NDArray[np.int64], sample_count: int) -> NDArray[np.int64]:
    reflected = indices.copy()
    negative = reflected < 0
    reflected[negative] = -reflected[negative] - 1
    high = reflected >= sample_count
    reflected[high] = 2 * sample_count - reflected[high] - 1
    return reflected


def _mel_scale(frequency: NDArray[np.float64] | float) -> NDArray[np.float64]:
    return 1127.0 * np.log1p(np.asarray(frequency, dtype=np.float64) / 700.0)


def _povey_window() -> FloatArray:
    phase = 2.0 * np.pi * np.arange(FRAME_LENGTH) / (FRAME_LENGTH - 1)
    return np.asarray((0.5 - 0.5 * np.cos(phase)) ** 0.85, dtype=np.float32)


def _mel_filters() -> FloatArray:
    low = float(_mel_scale(20.0))
    high = float(_mel_scale(SAMPLE_RATE / 2))
    delta = (high - low) / (FILTER_COUNT + 1)
    bins = _mel_scale(np.arange(FFT_LENGTH // 2) * SAMPLE_RATE / FFT_LENGTH)
    filters = np.empty((FILTER_COUNT, FFT_LENGTH // 2), dtype=np.float32)
    for index in range(FILTER_COUNT):
        left = low + index * delta
        center = low + (index + 1) * delta
        right = low + (index + 2) * delta
        rising = (bins - left) / (center - left)
        falling = (right - bins) / (right - center)
        filters[index] = np.maximum(0.0, np.minimum(rising, falling))
    return filters


POVEY_WINDOW: Final = _povey_window()
MEL_FILTERS: Final = _mel_filters()


def extract_filterbank(samples: FloatArray) -> FloatArray:
    """Exact 16 kHz, 80-bin frontend mirrored from VoiceZIPAFilterbank."""
    samples = np.ascontiguousarray(samples, dtype=np.float32).reshape(-1)
    if samples.size < FRAME_LENGTH:
        raise ZIPAModelError("ZIPA requires at least 25 ms of audio")
    frame_count = (samples.size + FRAME_SHIFT // 2) // FRAME_SHIFT
    left_padding = FRAME_LENGTH // 2 - FRAME_SHIFT // 2
    features = np.empty((frame_count, FILTER_COUNT), dtype=np.float32)
    offsets = np.arange(FRAME_LENGTH, dtype=np.int64)
    for frame_index in range(frame_count):
        start = frame_index * FRAME_SHIFT - left_padding
        indices = _reflected_indices(offsets + start, samples.size)
        centered = samples[indices].copy()
        centered -= np.mean(centered, dtype=np.float32)
        previous = np.concatenate((centered[:1], centered[:-1]))
        windowed = (centered - PREEMPHASIS * previous) * POVEY_WINDOW
        spectrum = np.fft.fft(windowed, n=FFT_LENGTH)[: FFT_LENGTH // 2]
        powers = np.asarray(
            spectrum.real * spectrum.real + spectrum.imag * spectrum.imag,
            dtype=np.float32,
        )
        energy = MEL_FILTERS @ powers
        features[frame_index] = np.log(
            np.maximum(energy, np.finfo(np.float32).eps)
        )
    return features


def _resample(samples: FloatArray, source_rate: int) -> FloatArray:
    if source_rate == SAMPLE_RATE:
        return np.ascontiguousarray(samples, dtype=np.float32)
    if source_rate <= 0:
        raise ZIPAModelError(f"invalid source sample rate {source_rate}")
    output_count = max(1, round(samples.size * SAMPLE_RATE / source_rate))
    source_positions = np.arange(samples.size, dtype=np.float64)
    output_positions = np.arange(output_count, dtype=np.float64) * (
        source_rate / SAMPLE_RATE
    )
    return np.asarray(
        np.interp(output_positions, source_positions, samples),
        dtype=np.float32,
    )


class ZIPAPhoneRecognizer:
    """Hash-verifying, sidecar-lifetime ONNX session."""

    def __init__(self, asset_root: Path | None = None) -> None:
        root = asset_root or _asset_root()
        manifest_path = root / MANIFEST_FILENAME
        if not manifest_path.exists():
            raise ZIPAModelError(f"ZIPA manifest is missing at {manifest_path}")
        manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
        self.model_identifier = str(manifest["identifier"])
        self.model_hash = str(manifest["modelSHA256"])
        self.blank_token_id = int(manifest["blankTokenID"])
        vocabulary_size = int(manifest["vocabularySize"])
        if int(manifest["sampleRate"]) != SAMPLE_RATE:
            raise ZIPAModelError("ZIPA manifest sample rate is not 16000")
        if int(manifest["filterbankBins"]) != FILTER_COUNT:
            raise ZIPAModelError("ZIPA manifest filterbank size is not 80")

        expected_hashes = {
            MODEL_FILENAME: self.model_hash,
            TOKENS_FILENAME: str(manifest["tokensSHA256"]),
            LICENSE_FILENAME: str(manifest["licenseSHA256"]),
        }
        for filename, expected_hash in expected_hashes.items():
            path = root / filename
            if not path.exists():
                raise ZIPAModelError(f"ZIPA asset is missing: {path}")
            actual_hash = _sha256(path)
            if actual_hash != expected_hash:
                raise ZIPAModelError(
                    f"ZIPA {filename} SHA-256 mismatch: "
                    f"expected {expected_hash}, got {actual_hash}"
                )
        self.tokens = parse_tokens(root / TOKENS_FILENAME, vocabulary_size)
        if self.tokens[self.blank_token_id] != "<blk>":
            raise ZIPAModelError("ZIPA blank token is not <blk>")

        options = ort.SessionOptions()
        options.graph_optimization_level = ort.GraphOptimizationLevel.ORT_ENABLE_ALL
        options.intra_op_num_threads = 2
        self.session = ort.InferenceSession(
            str(root / MODEL_FILENAME),
            sess_options=options,
            providers=["CPUExecutionProvider"],
        )

    def _infer_chunk(self, samples: FloatArray) -> list[str]:
        features = extract_filterbank(samples)
        outputs = self.session.run(
            ["log_probs", "log_probs_len"],
            {
                "x": features[np.newaxis, :, :],
                "x_lens": np.asarray([features.shape[0]], dtype=np.int64),
            },
        )
        probabilities = np.asarray(outputs[0])
        valid_frames = int(np.asarray(outputs[1]).reshape(-1)[0])
        if (
            probabilities.ndim != 3
            or probabilities.shape[0] != 1
            or probabilities.shape[2] != len(self.tokens)
            or valid_frames <= 0
            or valid_frames > probabilities.shape[1]
        ):
            raise ZIPAModelError(
                f"ZIPA returned invalid output shapes "
                f"{probabilities.shape}, {np.asarray(outputs[1]).shape}"
            )
        winners = np.argmax(probabilities[0, :valid_frames], axis=1)
        decoded: list[int] = []
        previous = -1
        for winner_value in winners:
            winner = int(winner_value)
            if winner != self.blank_token_id and winner != previous:
                decoded.append(winner)
            previous = winner
        tokens = [
            self.tokens[identifier]
            for identifier in decoded
            if self.tokens[identifier] != "▁"
            and not self.tokens[identifier].startswith("<")
        ]
        return merge_phone_units(tokens)

    def analyze_wav(self, wav_path: Path) -> PhoneRecognition:
        samples, source_rate = load_wav(wav_path)
        prepared = _resample(samples, source_rate)
        chunk_samples = CHUNK_SECONDS * SAMPLE_RATE
        overlap_samples = int(OVERLAP_SECONDS * SAMPLE_RATE)
        step_samples = chunk_samples - overlap_samples
        phones: list[str] = []
        offset = 0
        while offset < prepared.size:
            end = min(prepared.size, offset + chunk_samples)
            chunk = self._infer_chunk(prepared[offset:end])
            maximum_overlap = min(8, len(phones), len(chunk))
            overlap = next(
                (
                    count
                    for count in range(maximum_overlap, 0, -1)
                    if phones[-count:] == chunk[:count]
                ),
                0,
            )
            phones.extend(chunk[overlap:])
            if end == prepared.size:
                break
            offset += step_samples
        return PhoneRecognition(
            phones=tuple(phones),
            model_identifier=self.model_identifier,
            model_hash=self.model_hash,
            runtime_identifier=EXECUTOR_IDENTIFIER,
        )
