import unicodedata
from dataclasses import dataclass
from typing import Any, Literal

import sounddevice as sd


@dataclass(frozen=True)
class AudioDeviceChoice:
    index: int | None
    name: str
    input_channels: int
    output_channels: int
    is_default: bool


DeviceKind = Literal["input", "output"]


def query_device_choices(kind: DeviceKind) -> tuple[AudioDeviceChoice, ...]:
    default_index = query_default_device_index(kind)
    default_info = query_device_info(default_index, kind)
    default_name = device_name(default_info, f"default {kind}")
    choices = [
        AudioDeviceChoice(
            index=None,
            name=default_name,
            input_channels=channel_count(default_info, "max_input_channels"),
            output_channels=channel_count(default_info, "max_output_channels"),
            is_default=True,
        )
    ]

    try:
        devices = sd.query_devices()
    except Exception:
        return tuple(choices)

    for index, info in enumerate(devices):
        if not isinstance(info, dict):
            continue
        input_channels = channel_count(info, "max_input_channels")
        output_channels = channel_count(info, "max_output_channels")
        if kind == "input" and input_channels <= 0:
            continue
        if kind == "output" and output_channels <= 0:
            continue
        choices.append(
            AudioDeviceChoice(
                index=index,
                name=device_name(info, f"{kind} {index}"),
                input_channels=input_channels,
                output_channels=output_channels,
                is_default=index == default_index,
            )
        )

    return tuple(choices)


def query_default_device_index(kind: DeviceKind) -> int | None:
    try:
        raw_index = sd.default.device[0 if kind == "input" else 1]
    except Exception:
        return None

    if raw_index is None:
        return None
    index = int(raw_index)
    return index if index >= 0 else None


def query_device_info(
    device_index: int | None,
    kind: DeviceKind,
) -> dict[str, Any]:
    try:
        info = sd.query_devices(device_index, kind=kind)
    except Exception:
        return {}
    return info if isinstance(info, dict) else {}


def device_name(info: dict[str, Any], fallback: str) -> str:
    name = info.get("name")
    if not isinstance(name, str) or not name:
        return fallback
    normalized = normalize_device_label(name)
    return normalized or fallback


def channel_count(info: dict[str, Any], key: str) -> int:
    value = info.get(key)
    return int(value) if isinstance(value, int | float) else 0


def normalize_device_label(name: str) -> str:
    translated = name.translate(
        str.maketrans(
            {
                "’": "'",
                "‘": "'",
                "“": '"',
                "”": '"',
                "–": "-",
                "—": "-",
            }
        )
    )
    normalized = unicodedata.normalize("NFKD", translated)
    return normalized.encode("ascii", "ignore").decode("ascii").strip()
