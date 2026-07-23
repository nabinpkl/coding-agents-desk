import logging
from typing import Any, Final

from interaction_agent.gesture.cache import configure_cache

configure_cache()

import mediapipe as mp

from interaction_agent.paths import GESTURE_MODEL_ROOT

LOGGER = logging.getLogger("gesture_agent.models")

HAND_MODEL_PATH: Final = GESTURE_MODEL_ROOT / "hand_landmarker.task"
FACE_MODEL_PATH: Final = GESTURE_MODEL_ROOT / "face_landmarker.task"


def create_hand_landmarker() -> Any:
    if not HAND_MODEL_PATH.exists():
        raise FileNotFoundError(
            f"Missing MediaPipe model at {HAND_MODEL_PATH}. Run `just download-model`."
        )

    base_options = mp.tasks.BaseOptions(
        model_asset_path=str(HAND_MODEL_PATH),
        delegate=mp.tasks.BaseOptions.Delegate.CPU,
    )
    options = mp.tasks.vision.HandLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_hands=1,
        min_hand_detection_confidence=0.7,
        min_hand_presence_confidence=0.7,
        min_tracking_confidence=0.7,
    )
    return mp.tasks.vision.HandLandmarker.create_from_options(options)


def create_face_landmarker() -> Any:
    if not FACE_MODEL_PATH.exists():
        raise FileNotFoundError(
            f"Missing MediaPipe model at {FACE_MODEL_PATH}. Run `just download-model`."
        )

    base_options = mp.tasks.BaseOptions(
        model_asset_path=str(FACE_MODEL_PATH),
        delegate=mp.tasks.BaseOptions.Delegate.CPU,
    )
    options = mp.tasks.vision.FaceLandmarkerOptions(
        base_options=base_options,
        running_mode=mp.tasks.vision.RunningMode.VIDEO,
        num_faces=1,
        min_face_detection_confidence=0.5,
        min_face_presence_confidence=0.5,
        min_tracking_confidence=0.5,
    )
    return mp.tasks.vision.FaceLandmarker.create_from_options(options)


def create_landmarkers() -> tuple[Any, Any]:
    LOGGER.info("initializing hand landmarker model=%s", HAND_MODEL_PATH)
    hand_landmarker = create_hand_landmarker()
    LOGGER.info("initializing face landmarker model=%s", FACE_MODEL_PATH)
    face_landmarker = create_face_landmarker()
    return hand_landmarker, face_landmarker
