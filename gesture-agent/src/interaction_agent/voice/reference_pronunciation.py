"""CMUdict reference phones and transcript-guided ZIPA phone grouping.

ZIPA emits one unconstrained phone sequence with no word boundaries. The
grouping here mirrors the native Passage surface: align that sequence against
the transcript's CMUdict phones, assign insertions to the nearest word anchor,
and retain phones with no possible anchor in an explicit unassigned group.
This is sequence alignment for display, not acoustic forced alignment.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Final, Literal

from interaction_agent.paths import PROJECT_ROOT

CMU_DICTIONARY_SHA256: Final = (
    "81917843c7f44ce2b094ac63873c2c7a4cf802040792c455ba3ca406891c3d22"
)
CMU_DICTIONARY_FILENAME: Final = "VoiceCMUDictionary.txt"
PHONE_MAPPING_FILENAME: Final = "arpabet-model-phone-map.json"
_ALTERNATE_PRONUNCIATION_SUFFIX: Final = re.compile(r"\(\d+\)$")


class ReferencePronunciationError(RuntimeError):
    """The pinned pronunciation assets are absent, stale, or malformed."""


@dataclass(frozen=True)
class WordPronunciation:
    word: str
    phones: tuple[str, ...]
    is_known: bool


@dataclass(frozen=True)
class WordPhoneGroup:
    word: str | None
    heard_phones: tuple[str, ...]
    reference_phones: tuple[str, ...]
    has_reference_pronunciation: bool


@dataclass(frozen=True)
class ReferenceAlignment:
    groups: tuple[WordPhoneGroup, ...]
    unknown_words: tuple[str, ...]
    dictionary_identifier: str
    dictionary_hash: str


@dataclass(frozen=True)
class _ReferencePhone:
    phone: str
    word_index: int


@dataclass(frozen=True)
class _AlignmentStep:
    kind: Literal["paired", "inserted", "deleted"]
    observed_phone: str | None
    reference_index: int | None


@dataclass(frozen=True)
class _PronunciationAssets:
    entries: dict[str, tuple[str, ...]]
    mapping: dict[str, str]
    source: str
    source_revision: str


def transcript_words(transcript: str) -> tuple[str, ...]:
    """Match the native tokenizer: Unicode letters and straight apostrophes."""
    normalized = "".join(
        character.lower()
        if character.isalpha() or character == "'"
        else " "
        for character in transcript
    )
    return tuple(
        word.strip("'")
        for word in normalized.split()
        if word.strip("'")
    )


def parse_cmu_dictionary(text: str) -> dict[str, tuple[str, ...]]:
    """Keep CMUdict's first pronunciation for each lowercase word."""
    entries: dict[str, tuple[str, ...]] = {}
    for line in text.splitlines():
        fields = line.split()
        if len(fields) < 2:
            continue
        word = _ALTERNATE_PRONUNCIATION_SUFFIX.sub("", fields[0]).lower()
        entries.setdefault(word, tuple(fields[1:]))
    return entries


def pronunciations(
    transcript: str,
    *,
    entries: dict[str, tuple[str, ...]],
    mapping: dict[str, str],
) -> tuple[tuple[WordPronunciation, ...], tuple[str, ...]]:
    words: list[WordPronunciation] = []
    unknown_words: set[str] = set()
    for word in transcript_words(transcript):
        symbols = entries.get(word)
        if symbols is None:
            unknown_words.add(word)
            words.append(WordPronunciation(word=word, phones=(), is_known=False))
            continue
        try:
            phones = tuple(mapping[symbol] for symbol in symbols)
        except KeyError as exc:
            raise ReferencePronunciationError(
                f"phone mapping does not cover CMUdict symbol {exc.args[0]}"
            ) from exc
        words.append(WordPronunciation(word=word, phones=phones, is_known=True))
    return tuple(words), tuple(sorted(unknown_words))


def group_phones(
    observed_phones: tuple[str, ...],
    words: tuple[WordPronunciation, ...],
) -> tuple[WordPhoneGroup, ...]:
    """Align raw phones to reference words while retaining every observation."""
    if not words:
        if not observed_phones:
            return ()
        return (
            WordPhoneGroup(
                word=None,
                heard_phones=observed_phones,
                reference_phones=(),
                has_reference_pronunciation=False,
            ),
        )

    reference = tuple(
        _ReferencePhone(phone=phone, word_index=word_index)
        for word_index, word in enumerate(words)
        for phone in word.phones
    )
    heard_by_word: list[list[str]] = [[] for _ in words]
    unassigned: list[str] = []
    if not reference:
        unassigned.extend(observed_phones)
    else:
        steps = _alignment_steps(observed_phones, reference)
        next_anchors = _next_reference_anchors(steps, reference)
        previous_anchor: tuple[int, int] | None = None
        for step_index, step in enumerate(steps):
            if step.kind == "paired":
                assert step.reference_index is not None
                assert step.observed_phone is not None
                word_index = reference[step.reference_index].word_index
                heard_by_word[word_index].append(step.observed_phone)
                previous_anchor = (word_index, step_index)
            elif step.kind == "inserted":
                assert step.observed_phone is not None
                anchor = _nearest_anchor(
                    step_index,
                    previous_anchor,
                    next_anchors[step_index],
                )
                if anchor is None:
                    unassigned.append(step.observed_phone)
                else:
                    heard_by_word[anchor[0]].append(step.observed_phone)
            else:
                assert step.reference_index is not None
                previous_anchor = (
                    reference[step.reference_index].word_index,
                    step_index,
                )

    groups = [
        WordPhoneGroup(
            word=word.word,
            heard_phones=tuple(heard_by_word[word_index]),
            reference_phones=word.phones,
            has_reference_pronunciation=word.is_known,
        )
        for word_index, word in enumerate(words)
    ]
    if unassigned:
        groups.append(
            WordPhoneGroup(
                word=None,
                heard_phones=tuple(unassigned),
                reference_phones=(),
                has_reference_pronunciation=False,
            )
        )
    return tuple(groups)


def reference_alignment(
    transcript: str,
    observed_phones: list[str],
) -> ReferenceAlignment:
    assets = _load_pronunciation_assets()
    words, unknown_words = pronunciations(
        transcript,
        entries=assets.entries,
        mapping=assets.mapping,
    )
    return ReferenceAlignment(
        groups=group_phones(tuple(observed_phones), words),
        unknown_words=unknown_words,
        dictionary_identifier=f"{assets.source}@{assets.source_revision}",
        dictionary_hash=CMU_DICTIONARY_SHA256,
    )


def _alignment_steps(
    observed_phones: tuple[str, ...],
    reference: tuple[_ReferencePhone, ...],
) -> tuple[_AlignmentStep, ...]:
    row_width = len(reference) + 1
    costs = [0] * ((len(observed_phones) + 1) * row_width)
    for observed_index in range(len(observed_phones) + 1):
        costs[observed_index * row_width] = observed_index
    for reference_index in range(len(reference) + 1):
        costs[reference_index] = reference_index

    for observed_index in range(1, len(observed_phones) + 1):
        for reference_index in range(1, len(reference) + 1):
            substitution_cost = int(
                observed_phones[observed_index - 1]
                != reference[reference_index - 1].phone
            )
            diagonal = (
                costs[(observed_index - 1) * row_width + reference_index - 1]
                + substitution_cost
            )
            insertion = (
                costs[(observed_index - 1) * row_width + reference_index] + 1
            )
            deletion = (
                costs[observed_index * row_width + reference_index - 1] + 1
            )
            costs[observed_index * row_width + reference_index] = min(
                diagonal,
                insertion,
                deletion,
            )

    observed_index = len(observed_phones)
    reference_index = len(reference)
    reversed_steps: list[_AlignmentStep] = []
    while observed_index > 0 or reference_index > 0:
        current = costs[observed_index * row_width + reference_index]
        if observed_index > 0 and reference_index > 0:
            substitution_cost = int(
                observed_phones[observed_index - 1]
                != reference[reference_index - 1].phone
            )
            diagonal = (
                costs[(observed_index - 1) * row_width + reference_index - 1]
                + substitution_cost
            )
            if current == diagonal:
                reversed_steps.append(
                    _AlignmentStep(
                        kind="paired",
                        observed_phone=observed_phones[observed_index - 1],
                        reference_index=reference_index - 1,
                    )
                )
                observed_index -= 1
                reference_index -= 1
                continue
        if observed_index > 0:
            insertion = (
                costs[(observed_index - 1) * row_width + reference_index] + 1
            )
            if current == insertion:
                reversed_steps.append(
                    _AlignmentStep(
                        kind="inserted",
                        observed_phone=observed_phones[observed_index - 1],
                        reference_index=None,
                    )
                )
                observed_index -= 1
                continue
        if reference_index <= 0:
            raise AssertionError("alignment backtrace lost its reference anchor")
        reversed_steps.append(
            _AlignmentStep(
                kind="deleted",
                observed_phone=None,
                reference_index=reference_index - 1,
            )
        )
        reference_index -= 1
    return tuple(reversed(reversed_steps))


def _next_reference_anchors(
    steps: tuple[_AlignmentStep, ...],
    reference: tuple[_ReferencePhone, ...],
) -> tuple[tuple[int, int] | None, ...]:
    anchors: list[tuple[int, int] | None] = [None] * len(steps)
    next_anchor: tuple[int, int] | None = None
    for step_index in range(len(steps) - 1, -1, -1):
        reference_index = steps[step_index].reference_index
        if reference_index is not None:
            next_anchor = (reference[reference_index].word_index, step_index)
        anchors[step_index] = next_anchor
    return tuple(anchors)


def _nearest_anchor(
    step_index: int,
    previous: tuple[int, int] | None,
    following: tuple[int, int] | None,
) -> tuple[int, int] | None:
    if previous is None:
        return following
    if following is None:
        return previous
    if step_index - previous[1] <= following[1] - step_index:
        return previous
    return following


def _asset_path(filename: str, environment_name: str) -> Path:
    override = os.environ.get(environment_name, "").strip()
    candidates = (
        Path(override) if override else None,
        PROJECT_ROOT / filename,
        PROJECT_ROOT.parent / "client" / "AgentDeskClient" / filename,
        PROJECT_ROOT.parent / "client" / "voice-phone-calibration" / filename,
    )
    for candidate in candidates:
        if candidate is not None and candidate.is_file():
            return candidate
    raise ReferencePronunciationError(
        f"{filename} is missing; set {environment_name} to its pinned asset"
    )


@lru_cache(maxsize=1)
def _load_pronunciation_assets() -> _PronunciationAssets:
    dictionary_path = _asset_path(
        CMU_DICTIONARY_FILENAME,
        "VOICE_CMU_DICTIONARY_PATH",
    )
    try:
        dictionary_data = dictionary_path.read_bytes()
    except OSError as exc:
        raise ReferencePronunciationError(
            "VoiceCMUDictionary.txt could not be read"
        ) from exc
    dictionary_hash = hashlib.sha256(dictionary_data).hexdigest()
    if dictionary_hash != CMU_DICTIONARY_SHA256:
        raise ReferencePronunciationError(
            "VoiceCMUDictionary.txt does not match its pinned revision"
        )
    try:
        dictionary_text = dictionary_data.decode("utf-8")
    except UnicodeDecodeError as exc:
        raise ReferencePronunciationError(
            "VoiceCMUDictionary.txt is not valid UTF-8"
        ) from exc
    entries = parse_cmu_dictionary(dictionary_text)
    if not entries:
        raise ReferencePronunciationError(
            "VoiceCMUDictionary.txt contains no pronunciations"
        )

    mapping_path = _asset_path(
        PHONE_MAPPING_FILENAME,
        "VOICE_PHONE_MAPPING_PATH",
    )
    try:
        mapping_document = json.loads(mapping_path.read_text(encoding="utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ReferencePronunciationError(
            "arpabet-model-phone-map.json could not be loaded"
        ) from exc
    if not isinstance(mapping_document, dict):
        raise ReferencePronunciationError(
            "arpabet-model-phone-map.json is malformed"
        )
    mapping = mapping_document.get("mapping")
    source = mapping_document.get("source")
    source_revision = mapping_document.get("sourceRevision")
    if (
        mapping_document.get("schemaVersion") != 1
        or not isinstance(mapping, dict)
        or not mapping
        or not all(
            isinstance(symbol, str)
            and symbol
            and isinstance(phone, str)
            and phone
            for symbol, phone in mapping.items()
        )
        or not isinstance(source, str)
        or not source
        or not isinstance(source_revision, str)
        or not source_revision
    ):
        raise ReferencePronunciationError(
            "arpabet-model-phone-map.json is malformed"
        )
    return _PronunciationAssets(
        entries=entries,
        mapping=mapping,
        source=source,
        source_revision=source_revision,
    )
