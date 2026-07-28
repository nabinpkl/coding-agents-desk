import os
from pathlib import Path
from typing import Final

PROJECT_ROOT: Final = Path(__file__).resolve().parents[2]

# The data root is env-overridable because the shipped voice sidecar runs from a
# read-only bundled source tree, so its models/recordings/uploads must live in a
# writable, per-user location (the host points VOICE_DATA_ROOT at Application
# Support). Standalone dev falls back to the in-repo ``data/`` directory.
_DATA_ROOT_ENV: Final = os.environ.get("VOICE_DATA_ROOT", "").strip()
DATA_ROOT: Final = Path(_DATA_ROOT_ENV) if _DATA_ROOT_ENV else PROJECT_ROOT / "data"

GESTURE_DATA_ROOT: Final = DATA_ROOT / "gesture"
GESTURE_MODEL_ROOT: Final = GESTURE_DATA_ROOT / "models"
GESTURE_PATTERN_ROOT: Final = GESTURE_DATA_ROOT / "patterns"
GESTURE_RECORDING_ROOT: Final = GESTURE_DATA_ROOT / "recordings"
GESTURE_SCREENSHOT_ROOT: Final = GESTURE_DATA_ROOT / "screenshots"

VOICE_DATA_ROOT: Final = DATA_ROOT / "voice"
# The Sherpa/MLX model directory is separately overridable (VOICE_MODEL_ROOT)
# because models are large and fetch-and-cached outside the data tree; falls
# back to ``<data>/voice/models``.
_MODEL_ROOT_ENV: Final = os.environ.get("VOICE_MODEL_ROOT", "").strip()
VOICE_MODEL_ROOT: Final = (
    Path(_MODEL_ROOT_ENV) if _MODEL_ROOT_ENV else VOICE_DATA_ROOT / "models"
)
VOICE_RECORDING_ROOT: Final = VOICE_DATA_ROOT / "recordings"
VOICE_UPLOAD_ROOT: Final = VOICE_DATA_ROOT / "uploads"
VOICE_REFERENCE_SPEECH_ROOT: Final = VOICE_DATA_ROOT / "reference-speech"

VIDEO_DATA_ROOT: Final = DATA_ROOT / "videos"
VIDEO_CLIP_ROOT: Final = VIDEO_DATA_ROOT / "clips"
