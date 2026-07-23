from dataclasses import dataclass
from typing import Any, Final

import numpy as np
from numpy.typing import NDArray


FloatArray = NDArray[np.float32]

FRAME_SECONDS: Final = 0.030
HOP_SECONDS: Final = 0.010
EPSILON: Final = 1e-8
ROLLOFF_PERCENTILE: Final = 0.85


@dataclass(frozen=True)
class VoiceSignalFrame:
    elapsed_seconds: float
    rms: float
    peak: float
    decibels: float
    zero_crossing_rate: float
    spectral_centroid_hz: float
    spectral_rolloff_hz: float
    spectral_flatness: float
    low_band_ratio: float
    mid_band_ratio: float
    high_band_ratio: float

    def to_json_payload(self) -> dict[str, float]:
        return {
            "elapsedSeconds": self.elapsed_seconds,
            "rms": self.rms,
            "peak": self.peak,
            "decibels": self.decibels,
            "zeroCrossingRate": self.zero_crossing_rate,
            "spectralCentroidHz": self.spectral_centroid_hz,
            "spectralRolloffHz": self.spectral_rolloff_hz,
            "spectralFlatness": self.spectral_flatness,
            "lowBandRatio": self.low_band_ratio,
            "midBandRatio": self.mid_band_ratio,
            "highBandRatio": self.high_band_ratio,
        }


@dataclass(frozen=True)
class VoiceSignalSummary:
    duration_seconds: float
    sample_rate: int
    sample_count: int
    frame_count: int
    mean_rms: float
    max_rms: float
    peak_amplitude: float
    mean_decibels: float
    silence_ratio: float
    mean_zero_crossing_rate: float
    mean_spectral_centroid_hz: float

    def to_json_payload(self) -> dict[str, float | int]:
        return {
            "durationSeconds": self.duration_seconds,
            "sampleRate": self.sample_rate,
            "sampleCount": self.sample_count,
            "frameCount": self.frame_count,
            "meanRms": self.mean_rms,
            "maxRms": self.max_rms,
            "peakAmplitude": self.peak_amplitude,
            "meanDecibels": self.mean_decibels,
            "silenceRatio": self.silence_ratio,
            "meanZeroCrossingRate": self.mean_zero_crossing_rate,
            "meanSpectralCentroidHz": self.mean_spectral_centroid_hz,
        }


@dataclass(frozen=True)
class VoiceSignalAnalysis:
    summary: VoiceSignalSummary
    frames: list[VoiceSignalFrame]

    def to_json_payload(self) -> dict[str, Any]:
        return {
            "summary": self.summary.to_json_payload(),
            "frames": [frame.to_json_payload() for frame in self.frames],
        }


def normalize_audio(audio: FloatArray) -> FloatArray:
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    if mono.size == 0:
        return mono

    peak = float(np.max(np.abs(mono)))
    if peak <= EPSILON:
        return mono

    return np.clip(mono / peak * 0.95, -1.0, 1.0).astype(np.float32)


def analyze_audio(audio: FloatArray, sample_rate: int) -> VoiceSignalAnalysis:
    mono = np.asarray(audio, dtype=np.float32).reshape(-1)
    frame_length = max(1, int(sample_rate * FRAME_SECONDS))
    hop_length = max(1, int(sample_rate * HOP_SECONDS))
    frames = build_signal_frames(mono, sample_rate, frame_length, hop_length)
    return VoiceSignalAnalysis(
        summary=build_summary(mono, sample_rate, frames),
        frames=frames,
    )


def build_signal_frames(
    audio: FloatArray,
    sample_rate: int,
    frame_length: int,
    hop_length: int,
) -> list[VoiceSignalFrame]:
    if audio.size == 0:
        return []

    padded = audio
    if padded.size < frame_length:
        padded = np.pad(padded, (0, frame_length - padded.size))

    window = np.hanning(frame_length).astype(np.float32)
    frequencies = np.fft.rfftfreq(frame_length, d=1 / sample_rate).astype(np.float32)
    signal_frames: list[VoiceSignalFrame] = []

    for start in range(0, max(1, padded.size - frame_length + 1), hop_length):
        frame = padded[start:start + frame_length]
        if frame.size < frame_length:
            frame = np.pad(frame, (0, frame_length - frame.size))

        elapsed_seconds = start / sample_rate
        signal_frames.append(analyze_frame(frame, window, frequencies, elapsed_seconds))

    return signal_frames


def analyze_frame(
    frame: FloatArray,
    window: FloatArray,
    frequencies: FloatArray,
    elapsed_seconds: float,
) -> VoiceSignalFrame:
    rms = float(np.sqrt(np.mean(np.square(frame))))
    peak = float(np.max(np.abs(frame))) if frame.size else 0.0
    decibels = float(20 * np.log10(max(rms, EPSILON)))
    zero_crossings = np.count_nonzero(np.diff(np.signbit(frame)))
    zero_crossing_rate = float(zero_crossings / max(1, frame.size - 1))

    spectrum = np.abs(np.fft.rfft(frame * window)).astype(np.float32)
    spectrum_sum = float(np.sum(spectrum))
    if spectrum_sum <= EPSILON:
        spectral_centroid = 0.0
        spectral_rolloff = 0.0
        spectral_flatness = 0.0
        low_ratio = 0.0
        mid_ratio = 0.0
        high_ratio = 0.0
    else:
        spectral_centroid = float(np.sum(frequencies * spectrum) / spectrum_sum)
        spectral_rolloff = rolloff_frequency(frequencies, spectrum, spectrum_sum)
        spectral_flatness = float(
            np.exp(np.mean(np.log(spectrum + EPSILON)))
            / (np.mean(spectrum) + EPSILON)
        )
        low_ratio = band_ratio(frequencies, spectrum, 0.0, 300.0, spectrum_sum)
        mid_ratio = band_ratio(frequencies, spectrum, 300.0, 1500.0, spectrum_sum)
        high_ratio = band_ratio(frequencies, spectrum, 1500.0, 4000.0, spectrum_sum)

    return VoiceSignalFrame(
        elapsed_seconds=elapsed_seconds,
        rms=rms,
        peak=peak,
        decibels=decibels,
        zero_crossing_rate=zero_crossing_rate,
        spectral_centroid_hz=spectral_centroid,
        spectral_rolloff_hz=spectral_rolloff,
        spectral_flatness=spectral_flatness,
        low_band_ratio=low_ratio,
        mid_band_ratio=mid_ratio,
        high_band_ratio=high_ratio,
    )


def rolloff_frequency(
    frequencies: FloatArray,
    spectrum: FloatArray,
    spectrum_sum: float,
) -> float:
    threshold = spectrum_sum * ROLLOFF_PERCENTILE
    cumulative = np.cumsum(spectrum)
    index = int(np.searchsorted(cumulative, threshold))
    index = min(index, frequencies.size - 1)
    return float(frequencies[index])


def band_ratio(
    frequencies: FloatArray,
    spectrum: FloatArray,
    low_hz: float,
    high_hz: float,
    spectrum_sum: float,
) -> float:
    mask = (frequencies >= low_hz) & (frequencies < high_hz)
    return float(np.sum(spectrum[mask]) / max(spectrum_sum, EPSILON))


def build_summary(
    audio: FloatArray,
    sample_rate: int,
    frames: list[VoiceSignalFrame],
) -> VoiceSignalSummary:
    duration_seconds = audio.size / sample_rate if sample_rate > 0 else 0.0
    if not frames:
        return VoiceSignalSummary(
            duration_seconds=duration_seconds,
            sample_rate=sample_rate,
            sample_count=int(audio.size),
            frame_count=0,
            mean_rms=0.0,
            max_rms=0.0,
            peak_amplitude=float(np.max(np.abs(audio))) if audio.size else 0.0,
            mean_decibels=0.0,
            silence_ratio=1.0,
            mean_zero_crossing_rate=0.0,
            mean_spectral_centroid_hz=0.0,
        )

    rms_values = np.array([frame.rms for frame in frames], dtype=np.float32)
    decibel_values = np.array([frame.decibels for frame in frames], dtype=np.float32)
    zcr_values = np.array(
        [frame.zero_crossing_rate for frame in frames],
        dtype=np.float32,
    )
    centroid_values = np.array(
        [frame.spectral_centroid_hz for frame in frames],
        dtype=np.float32,
    )
    silence_ratio = float(np.mean(rms_values < 0.015))

    return VoiceSignalSummary(
        duration_seconds=duration_seconds,
        sample_rate=sample_rate,
        sample_count=int(audio.size),
        frame_count=len(frames),
        mean_rms=float(np.mean(rms_values)),
        max_rms=float(np.max(rms_values)),
        peak_amplitude=float(np.max(np.abs(audio))) if audio.size else 0.0,
        mean_decibels=float(np.mean(decibel_values)),
        silence_ratio=silence_ratio,
        mean_zero_crossing_rate=float(np.mean(zcr_values)),
        mean_spectral_centroid_hz=float(np.mean(centroid_values)),
    )
