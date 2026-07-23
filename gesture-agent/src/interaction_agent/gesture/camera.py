import logging
import platform
from typing import Final

from interaction_agent.gesture.cache import configure_cache

configure_cache()

import cv2


LOGGER = logging.getLogger("gesture_agent.camera")

CAMERA_INDEX: Final = 0


def camera_backend() -> int:
    if platform.system() == "Darwin" and hasattr(cv2, "CAP_AVFOUNDATION"):
        return cv2.CAP_AVFOUNDATION

    return cv2.CAP_ANY


def open_camera() -> cv2.VideoCapture:
    backend = camera_backend()
    LOGGER.info("opening camera index=%s backend=%s", CAMERA_INDEX, backend)

    cap = cv2.VideoCapture(CAMERA_INDEX, backend)
    if cap.isOpened():
        LOGGER.info("camera opened")
        return cap

    LOGGER.error("camera did not open")
    if platform.system() == "Darwin":
        LOGGER.error(
            "macOS camera permission is controlled by the app launching this "
            "script. Allow that app in System Settings > Privacy & Security > "
            "Camera, then restart the script."
        )

    return cap
