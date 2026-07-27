from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from interaction_agent.voice import reference_pronunciation
from interaction_agent.voice.reference_pronunciation import (
    ReferencePronunciationError,
    WordPronunciation,
    group_phones,
    parse_cmu_dictionary,
    pronunciations,
    reference_alignment,
    transcript_words,
)


class ReferencePronunciationTests(unittest.TestCase):
    def test_tokenizer_matches_passage_contractions_and_punctuation(self) -> None:
        self.assertEqual(
            transcript_words("  I'd thought—then, I wouldn't stop.  "),
            ("i'd", "thought", "then", "i", "wouldn't", "stop"),
        )

    def test_first_dictionary_pronunciation_wins_and_unknowns_remain(self) -> None:
        entries = parse_cmu_dictionary(
            """\
THOUGHT  TH AO1 T
THOUGHT(2)  TH AO2 T
ABOUT  AH0 B AW1 T
"""
        )
        words, unknown = pronunciations(
            "Thought about mystery.",
            entries=entries,
            mapping={
                "TH": "θ",
                "AO1": "ɔ",
                "T": "t",
                "AH0": "ə",
                "B": "b",
                "AW1": "aʊ",
            },
        )
        self.assertEqual(words[0].phones, ("θ", "ɔ", "t"))
        self.assertFalse(words[2].is_known)
        self.assertEqual(unknown, ("mystery",))

    def test_grouping_matches_native_passage_insertion_assignment(self) -> None:
        groups = group_phones(
            ("a", "x", "y", "z", "b"),
            (
                WordPronunciation("one", ("a",), True),
                WordPronunciation("two", ("b",), True),
            ),
        )
        self.assertEqual(groups[0].heard_phones, ("a", "x", "y"))
        self.assertEqual(groups[1].heard_phones, ("z", "b"))
        self.assertEqual(
            tuple(phone for group in groups for phone in group.heard_phones),
            ("a", "x", "y", "z", "b"),
        )

    def test_raw_phones_remain_unassigned_without_reference_anchors(self) -> None:
        groups = group_phones(
            ("f", "oʊ", "n"),
            (WordPronunciation("unknownword", (), False),),
        )
        self.assertEqual(groups[0].word, "unknownword")
        self.assertEqual(groups[0].heard_phones, ())
        self.assertEqual(groups[1].word, None)
        self.assertEqual(groups[1].heard_phones, ("f", "oʊ", "n"))

    def test_malformed_mapping_is_a_reference_failure(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            mapping_path = Path(temporary_directory) / "mapping.json"
            mapping_path.write_text("[]", encoding="utf-8")
            reference_pronunciation._load_pronunciation_assets.cache_clear()
            with (
                patch.dict(
                    os.environ,
                    {"VOICE_PHONE_MAPPING_PATH": str(mapping_path)},
                ),
                self.assertRaisesRegex(
                    ReferencePronunciationError,
                    "malformed",
                ),
            ):
                reference_alignment("Thank", ["θ", "æ", "ŋ", "k"])
        reference_pronunciation._load_pronunciation_assets.cache_clear()

    def test_pinned_assets_align_a_real_transcript_word(self) -> None:
        alignment = reference_alignment(
            "Thank",
            ["θ", "æ", "ŋ", "k"],
        )
        self.assertEqual(len(alignment.groups), 1)
        self.assertEqual(alignment.groups[0].word, "thank")
        self.assertEqual(
            alignment.groups[0].reference_phones,
            ("θ", "æ", "ŋ", "k"),
        )
        self.assertEqual(alignment.unknown_words, ())
        self.assertTrue(alignment.dictionary_identifier.startswith("CMUdict@"))


if __name__ == "__main__":
    unittest.main()
