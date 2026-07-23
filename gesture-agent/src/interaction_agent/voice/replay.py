import logging
import threading
from collections import deque
from dataclasses import dataclass
from typing import Any

import numpy as np
import sounddevice as sd

from interaction_agent.voice.devices import device_name, query_device_info
from interaction_agent.voice.recording import (
    DEFAULT_BLOCK_SIZE,
    DEFAULT_CHANNELS,
    DEFAULT_SAMPLE_RATE,
    FloatArray,
)


LOGGER = logging.getLogger("voice_agent.replay")


@dataclass(frozen=True)
class VoiceReplaySnapshot:
    is_active: bool
    output_device_name: str
    output_device_index: int | None
    volume: float
    buffered_samples: int
    dropped_samples: int
    underrun_blocks: int
    last_error: str | None


class VoiceReplayMonitor:
    def __init__(
        self,
        sample_rate: int = DEFAULT_SAMPLE_RATE,
        channels: int = DEFAULT_CHANNELS,
        block_size: int = DEFAULT_BLOCK_SIZE,
        volume: float = 0.25,
        buffer_seconds: float = 0.75,
        output_device_index: int | None = None,
    ) -> None:
        self.sample_rate = sample_rate
        self.channels = channels
        self.block_size = block_size
        self.volume = max(0.0, min(1.0, volume))
        self.output_device_index = output_device_index
        self.buffer_max_samples = max(block_size, int(sample_rate * buffer_seconds))
        self.buffer: deque[float] = deque(maxlen=self.buffer_max_samples)
        self.lock = threading.Lock()
        self.stream: sd.OutputStream | None = None
        self.is_active = False
        self.dropped_samples = 0
        self.underrun_blocks = 0
        self.last_error: str | None = None
        self.output_device_name = self.query_output_device_name()

    def start(self) -> None:
        if self.stream is not None:
            with self.lock:
                self.is_active = True
            return

        with self.lock:
            self.buffer.clear()
            self.is_active = True
            self.dropped_samples = 0
            self.underrun_blocks = 0
            self.last_error = None

        try:
            self.stream = sd.OutputStream(
                samplerate=self.sample_rate,
                channels=self.channels,
                blocksize=self.block_size,
                dtype="float32",
                device=self.output_device_index,
                callback=self.on_output_block,
            )
            self.stream.start()
            self.output_device_name = self.query_output_device_name()
        except Exception as exc:
            LOGGER.exception("failed to start voice replay monitor")
            with self.lock:
                self.is_active = False
                self.last_error = str(exc)
            if self.stream is not None:
                self.stream.close()
                self.stream = None

    def set_output_device(self, device_index: int | None) -> None:
        with self.lock:
            if self.is_active:
                raise RuntimeError("stop recording before changing output devices")
            self.output_device_index = device_index
            self.output_device_name = self.query_output_device_name()

    def stop(self) -> None:
        with self.lock:
            self.is_active = False
            self.buffer.clear()

        if self.stream is None:
            return

        self.stream.stop()
        self.stream.close()
        self.stream = None

    def submit_audio(self, samples: FloatArray, sample_rate: int) -> None:
        with self.lock:
            if not self.is_active:
                return

            if sample_rate != self.sample_rate:
                self.last_error = (
                    f"replay sample_rate mismatch: expected {self.sample_rate}, got {sample_rate}"
                )
                return

            overflow = max(0, len(self.buffer) + samples.size - self.buffer_max_samples)
            self.dropped_samples += overflow
            self.buffer.extend(float(sample) for sample in samples)

    def adjust_volume(self, delta: float) -> float:
        with self.lock:
            self.volume = max(0.0, min(1.0, self.volume + delta))
            return self.volume

    def set_volume(self, volume: float) -> float:
        with self.lock:
            self.volume = max(0.0, min(1.0, volume))
            return self.volume

    def snapshot(self) -> VoiceReplaySnapshot:
        with self.lock:
            return VoiceReplaySnapshot(
                is_active=self.is_active,
                output_device_name=self.output_device_name,
                output_device_index=self.output_device_index,
                volume=self.volume,
                buffered_samples=len(self.buffer),
                dropped_samples=self.dropped_samples,
                underrun_blocks=self.underrun_blocks,
                last_error=self.last_error,
            )

    def on_output_block(
        self,
        outdata: FloatArray,
        frames: int,
        time_info: Any,
        status: sd.CallbackFlags,
    ) -> None:
        del time_info

        output = np.zeros(frames, dtype=np.float32)
        with self.lock:
            if status:
                self.underrun_blocks += 1

            for index in range(frames):
                if not self.buffer:
                    if self.is_active:
                        self.underrun_blocks += 1
                    break
                output[index] = self.buffer.popleft() * self.volume

        if outdata.ndim == 2:
            outdata[:] = output.reshape(-1, 1)
        else:
            outdata[:] = output

    def query_output_device_name(self) -> str:
        info = query_device_info(self.output_device_index, "output")
        return device_name(info, "default output")
