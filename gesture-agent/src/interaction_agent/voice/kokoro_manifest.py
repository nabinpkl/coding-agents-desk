"""Pinned Kokoro model and American-English voice inventory.

The sidecar downloads these files into the host's configured model directory.
Every byte is checked before PyTorch sees it. The model repository declares
Apache-2.0 in its immutable Hugging Face metadata.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Final

KOKORO_PACKAGE_VERSION: Final = "0.9.4"
KOKORO_REPOSITORY: Final = "hexgrad/Kokoro-82M"
KOKORO_REVISION: Final = "f3ff3571791e39611d31c381e3a41a3af07b4987"
KOKORO_MODEL_FILENAME: Final = "kokoro-v1_0.pth"
KOKORO_MODEL_SHA256: Final = (
    "496dba118d1a58f5f3db2efc88dbdc216e0483fc89fe6e47ee1f2c53f18ad1e4"
)
KOKORO_CONFIG_FILENAME: Final = "config.json"
KOKORO_CONFIG_SHA256: Final = (
    "5abb01e2403b072bf03d04fde160443e209d7a0dad49a423be15196b9b43c17f"
)
KOKORO_LICENSE: Final = "Apache-2.0"
KOKORO_SAMPLE_RATE: Final = 24_000
KOKORO_MAX_PHONEME_CHARACTERS: Final = 510
DEFAULT_KOKORO_VOICE: Final = "af_heart"
MINIMUM_KOKORO_SPEED: Final = 0.5
DEFAULT_KOKORO_SPEED: Final = 1.0
MAXIMUM_KOKORO_SPEED: Final = 2.0


@dataclass(frozen=True)
class KokoroVoice:
    identifier: str
    name: str
    hash: str

    @property
    def filename(self) -> str:
        return f"voices/{self.identifier}.pt"


KOKORO_VOICES: Final = (
    KokoroVoice(
        "af_alloy",
        "Alloy",
        "6d877149dd8b348fbad12e5845b7e43d975390e9f3b68a811d1d86168bef5aa3",
    ),
    KokoroVoice(
        "af_aoede",
        "Aoede",
        "c03bd1a4c3716c2d8eaa3d50022f62d5c31cfbd6e15933a00b17fefe13841cc4",
    ),
    KokoroVoice(
        "af_bella",
        "Bella",
        "8cb64e02fcc8de0327a8e13817e49c76c945ecf0052ceac97d3081480e8e48d6",
    ),
    KokoroVoice(
        "af_heart",
        "Heart",
        "0ab5709b8ffab19bfd849cd11d98f75b60af7733253ad0d67b12382a102cb4ff",
    ),
    KokoroVoice(
        "af_jessica",
        "Jessica",
        "cdfdccb8cc975aa34ee6b89642963b0064237675de0e41a30ae64cc958dd4e87",
    ),
    KokoroVoice(
        "af_kore",
        "Kore",
        "8bfbc512321c3db49dff984ac675fa5ac7eaed5a96cc31104d3a9080e179d69d",
    ),
    KokoroVoice(
        "af_nicole",
        "Nicole",
        "c5561808bcf5250fe8c5f5de32caf2d94f27e57e95befdb098c5c85991d4c5da",
    ),
    KokoroVoice(
        "af_nova",
        "Nova",
        "e0233676ddc21908c37a1f102f6b88a59e4e5c1bd764983616eb9eda629dbcd2",
    ),
    KokoroVoice(
        "af_river",
        "River",
        "e149459bd9c084416b74756b9bd3418256a8b839088abb07d463730c369dab8f",
    ),
    KokoroVoice(
        "af_sarah",
        "Sarah",
        "49bd364ea3be9eb3e9685e8f9a15448c4883112a7c0ff7ab139fa4088b08cef9",
    ),
    KokoroVoice(
        "af_sky",
        "Sky",
        "c799548aed06e0cb0d655a85a01b48e7f10484d71663f9a3045a5b9362e8512c",
    ),
    KokoroVoice(
        "am_adam",
        "Adam",
        "ced7e284aba12472891be1da3ab34db84cc05cc02b5889535796dbf2d8b0cb34",
    ),
    KokoroVoice(
        "am_echo",
        "Echo",
        "8bcfdc852bc985fb45c396c561e571ffb9183930071f962f1b50df5c97b161e8",
    ),
    KokoroVoice(
        "am_eric",
        "Eric",
        "ada66f0eefff34ec921b1d7474d7ac8bec00cd863c170f1c534916e9b8212aae",
    ),
    KokoroVoice(
        "am_fenrir",
        "Fenrir",
        "98e507eca1db08230ae3b6232d59c10aec9630022d19accac4f5d12fcec3c37a",
    ),
    KokoroVoice(
        "am_liam",
        "Liam",
        "c82550757ddb31308b97f30040dda8c2d609a9e2de6135848d0a948368138518",
    ),
    KokoroVoice(
        "am_michael",
        "Michael",
        "9a443b79a4b22489a5b0ab7c651a0bcd1a30bef675c28333f06971abbd47bd37",
    ),
    KokoroVoice(
        "am_onyx",
        "Onyx",
        "e8452be16cd0f6da7b4579eaf7b1e4506e92524882053d86d72b96b9a7fed584",
    ),
    KokoroVoice(
        "am_puck",
        "Puck",
        "dd1d8973f4ce4b7d8ae407c77a435f485dabc052081b80ea75c4f30b84f36223",
    ),
    KokoroVoice(
        "am_santa",
        "Santa",
        "7f2f7582fa2b1f160e90aafe6d0b442a685e773608b6667e545d743b073e97a7",
    ),
)

KOKORO_VOICE_BY_IDENTIFIER: Final = {voice.identifier: voice for voice in KOKORO_VOICES}
