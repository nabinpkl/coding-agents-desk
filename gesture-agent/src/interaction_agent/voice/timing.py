from __future__ import annotations

import json
from typing import TypeAlias


VoiceTimingValue: TypeAlias = str | bool | int | float | None


def emit_voice_timing(
    stage: str,
    **fields: VoiceTimingValue,
) -> None:
    """Emit one flushable, content-free timing event for host log forwarding."""
    payload: dict[str, VoiceTimingValue] = {
        "event": "voice-timing",
        "stage": stage,
    }
    payload.update(
        {
            key: round(value, 3) if isinstance(value, float) else value
            for key, value in fields.items()
        }
    )
    print(
        json.dumps(payload, separators=(",", ":"), sort_keys=True),
        flush=True,
    )
