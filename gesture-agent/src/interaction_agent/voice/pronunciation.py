"""Reference-vs-learner pronunciation closeness without speech-to-text.

Both utterances are turned into MFCC sequences and aligned with dynamic time
warping. The length-normalized alignment cost is the pronunciation distance,
and the per-step costs along the warping path show where the learner diverges
from the reference. This is the v0 (MFCC) variant; self-supervised embeddings
(wav2vec2 / HuBERT) are the validated upgrade for the same DTW pipeline.
"""

import argparse
import sys
import wave
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Final

import numpy as np

from interaction_agent.voice.signals import EPSILON, FloatArray, normalize_audio


FRAME_SECONDS: Final = 0.025
HOP_SECONDS: Final = 0.010
PRE_EMPHASIS: Final = 0.97
MEL_FILTER_COUNT: Final = 26
MFCC_COEFFICIENT_COUNT: Final = 13


@dataclass(frozen=True)
class PronunciationFrameCost:
    reference_seconds: float
    learner_seconds: float
    cost: float

    def to_json_payload(self) -> dict[str, float]:
        return {
            "referenceSeconds": self.reference_seconds,
            "learnerSeconds": self.learner_seconds,
            "cost": self.cost,
        }


@dataclass(frozen=True)
class PronunciationComparison:
    distance: float
    closeness: float
    reference_frame_count: int
    learner_frame_count: int
    path_length: int
    coefficient_count: int
    trace: list[PronunciationFrameCost]

    def to_json_payload(self) -> dict[str, Any]:
        return {
            "distance": self.distance,
            "closeness": self.closeness,
            "referenceFrameCount": self.reference_frame_count,
            "learnerFrameCount": self.learner_frame_count,
            "pathLength": self.path_length,
            "coefficientCount": self.coefficient_count,
            "trace": [step.to_json_payload() for step in self.trace],
        }


def load_wav(path: Path) -> tuple[FloatArray, int]:
    with wave.open(str(path), "rb") as wav:
        sample_rate = wav.getframerate()
        channels = wav.getnchannels()
        raw = wav.readframes(wav.getnframes())

    samples = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        samples = samples.reshape(-1, channels).mean(axis=1)
    return samples.astype(np.float32), sample_rate


def hz_to_mel(hz: FloatArray) -> FloatArray:
    return (2595.0 * np.log10(1.0 + hz / 700.0)).astype(np.float32)


def mel_to_hz(mel: FloatArray) -> FloatArray:
    return (700.0 * (np.power(10.0, mel / 2595.0) - 1.0)).astype(np.float32)


def mel_filterbank(sample_rate: int, frame_length: int) -> FloatArray:
    bin_count = frame_length // 2 + 1
    mel_min = hz_to_mel(np.array([0.0], dtype=np.float32))[0]
    mel_max = hz_to_mel(np.array([sample_rate / 2.0], dtype=np.float32))[0]
    mel_points = np.linspace(mel_min, mel_max, MEL_FILTER_COUNT + 2, dtype=np.float32)
    hz_points = mel_to_hz(mel_points)
    bins = np.floor((frame_length + 1) * hz_points / sample_rate).astype(np.int32)
    bins = np.clip(bins, 0, bin_count - 1)

    filterbank = np.zeros((MEL_FILTER_COUNT, bin_count), dtype=np.float32)
    for index in range(1, MEL_FILTER_COUNT + 1):
        left, center, right = bins[index - 1], bins[index], bins[index + 1]
        for position in range(left, center):
            if center > left:
                filterbank[index - 1, position] = (position - left) / (center - left)
        for position in range(center, right):
            if right > center:
                filterbank[index - 1, position] = (right - position) / (right - center)
    return filterbank


def dct_matrix() -> FloatArray:
    indices = np.arange(MEL_FILTER_COUNT, dtype=np.float32)
    coefficients = np.arange(MFCC_COEFFICIENT_COUNT, dtype=np.float32).reshape(-1, 1)
    return np.cos(np.pi / MEL_FILTER_COUNT * (indices + 0.5) * coefficients).astype(np.float32)


def mfcc_features(audio: FloatArray, sample_rate: int) -> FloatArray:
    mono = normalize_audio(audio)
    if mono.size == 0:
        return np.zeros((0, MFCC_COEFFICIENT_COUNT), dtype=np.float32)

    emphasized = np.append(mono[0], mono[1:] - PRE_EMPHASIS * mono[:-1]).astype(np.float32)
    frame_length = max(1, int(sample_rate * FRAME_SECONDS))
    hop_length = max(1, int(sample_rate * HOP_SECONDS))
    if emphasized.size < frame_length:
        emphasized = np.pad(emphasized, (0, frame_length - emphasized.size))

    window = np.hamming(frame_length).astype(np.float32)
    filterbank = mel_filterbank(sample_rate, frame_length)
    transform = dct_matrix()

    rows: list[FloatArray] = []
    for start in range(0, emphasized.size - frame_length + 1, hop_length):
        frame = emphasized[start:start + frame_length] * window
        spectrum = np.abs(np.fft.rfft(frame)).astype(np.float32)
        power = np.square(spectrum) / frame_length
        mel_energy = filterbank @ power
        log_mel = np.log(mel_energy + EPSILON)
        rows.append((transform @ log_mel).astype(np.float32))

    features = np.asarray(rows, dtype=np.float32)
    return cepstral_mean_variance_normalize(features)


def cepstral_mean_variance_normalize(features: FloatArray) -> FloatArray:
    if features.shape[0] == 0:
        return features
    mean = features.mean(axis=0, keepdims=True)
    std = features.std(axis=0, keepdims=True)
    return ((features - mean) / (std + EPSILON)).astype(np.float32)


def cosine_distance_matrix(reference: FloatArray, learner: FloatArray) -> FloatArray:
    reference_unit = reference / (np.linalg.norm(reference, axis=1, keepdims=True) + EPSILON)
    learner_unit = learner / (np.linalg.norm(learner, axis=1, keepdims=True) + EPSILON)
    similarity = reference_unit @ learner_unit.T
    return np.clip(1.0 - similarity, 0.0, 2.0).astype(np.float32)


def dynamic_time_warp(distances: FloatArray) -> tuple[float, list[tuple[int, int]]]:
    rows, columns = distances.shape
    accumulated = np.full((rows + 1, columns + 1), np.inf, dtype=np.float64)
    accumulated[0, 0] = 0.0
    for i in range(1, rows + 1):
        for j in range(1, columns + 1):
            best = min(accumulated[i - 1, j], accumulated[i, j - 1], accumulated[i - 1, j - 1])
            accumulated[i, j] = distances[i - 1, j - 1] + best

    path: list[tuple[int, int]] = []
    i, j = rows, columns
    while i > 0 and j > 0:
        path.append((i - 1, j - 1))
        step = min(accumulated[i - 1, j], accumulated[i, j - 1], accumulated[i - 1, j - 1])
        if step == accumulated[i - 1, j - 1]:
            i, j = i - 1, j - 1
        elif step == accumulated[i - 1, j]:
            i -= 1
        else:
            j -= 1
    path.reverse()
    return float(accumulated[rows, columns]), path


def compare_features(reference: FloatArray, learner: FloatArray) -> PronunciationComparison:
    if reference.shape[0] == 0 or learner.shape[0] == 0:
        raise ValueError("both utterances must contain at least one analysis frame")

    distances = cosine_distance_matrix(reference, learner)
    total_cost, path = dynamic_time_warp(distances)
    distance = total_cost / max(1, len(path))
    trace = [
        PronunciationFrameCost(
            reference_seconds=reference_index * HOP_SECONDS,
            learner_seconds=learner_index * HOP_SECONDS,
            cost=float(distances[reference_index, learner_index]),
        )
        for reference_index, learner_index in path
    ]
    return PronunciationComparison(
        distance=distance,
        closeness=float(np.exp(-distance)),
        reference_frame_count=reference.shape[0],
        learner_frame_count=learner.shape[0],
        path_length=len(path),
        coefficient_count=MFCC_COEFFICIENT_COUNT,
        trace=trace,
    )


def compare_recordings(reference_path: Path, learner_path: Path) -> PronunciationComparison:
    reference_audio, reference_rate = load_wav(reference_path)
    learner_audio, learner_rate = load_wav(learner_path)
    reference = mfcc_features(reference_audio, reference_rate)
    learner = mfcc_features(learner_audio, learner_rate)
    return compare_features(reference, learner)


def most_divergent_steps(
    comparison: PronunciationComparison,
    limit: int = 5,
) -> list[PronunciationFrameCost]:
    return sorted(comparison.trace, key=lambda step: step.cost, reverse=True)[:limit]


def main() -> int:
    parser = argparse.ArgumentParser(
        description="Score how close a learner WAV pronounces the same words as a reference WAV.",
    )
    parser.add_argument("reference", type=Path, help="reference (target) WAV file")
    parser.add_argument("learner", type=Path, help="learner WAV file to score")
    parser.add_argument("--top", type=int, default=5, help="number of divergent segments to print")
    arguments = parser.parse_args()

    comparison = compare_recordings(arguments.reference, arguments.learner)
    print(f"reference frames: {comparison.reference_frame_count}")
    print(f"learner frames:   {comparison.learner_frame_count}")
    print(f"aligned steps:    {comparison.path_length}")
    print(f"distance:         {comparison.distance:.4f} (length-normalized DTW cost, lower is closer)")
    print(f"closeness:        {comparison.closeness:.3f} (heuristic 0-1, uncalibrated)")
    print("most divergent segments (reference -> learner, cost):")
    for step in most_divergent_steps(comparison, arguments.top):
        print(f"  {step.reference_seconds:6.2f}s -> {step.learner_seconds:6.2f}s   {step.cost:.3f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
