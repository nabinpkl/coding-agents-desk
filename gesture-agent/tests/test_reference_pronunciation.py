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
from interaction_agent.voice.reference_pronunciation import (
    reference_pronunciation as resolve_reference_pronunciation,
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

    def test_uppercase_initialism_uses_cmudict_letter_pronunciations(self) -> None:
        entries = parse_cmu_dictionary(
            """\
A  EY1
C  S IY1
S  EH1 S
"""
        )
        words, unknown = pronunciations(
            "ACS",
            entries=entries,
            mapping={
                "EY1": "eɪ",
                "S": "s",
                "IY1": "i",
                "EH1": "ɛ",
            },
        )
        self.assertEqual(
            words,
            (WordPronunciation("acs", ("eɪ", "s", "i", "ɛ", "s"), True),),
        )
        self.assertEqual(unknown, ())

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

    def test_kokoro_pronunciation_preserves_cmu_stress_and_punctuation(self) -> None:
        pronunciation = resolve_reference_pronunciation("Think, thank.")
        self.assertEqual(
            tuple(word.kokoro_ipa for word in pronunciation.words),
            ("θˈɪŋk", "θˈæŋk"),
        )
        self.assertEqual(pronunciation.passage_ipa, "θˈɪŋk, θˈæŋk.")
        self.assertEqual(pronunciation.unknown_words, ())
        self.assertEqual(len(pronunciation.synthesis_mapping_hash), 64)

    def test_kokoro_pronunciation_spells_uppercase_initialism_from_cmudict(
        self,
    ) -> None:
        pronunciation = resolve_reference_pronunciation("Choose auto-ACS.")
        self.assertEqual(pronunciation.words[-1].word, "acs")
        self.assertTrue(pronunciation.words[-1].is_known)
        self.assertEqual(pronunciation.words[-1].kokoro_ipa, "ˈA sˈi ˈɛs")
        self.assertEqual(pronunciation.unknown_words, ())
        self.assertTrue(pronunciation.passage_ipa.endswith("ˈA sˈi ˈɛs."))


if __name__ == "__main__":
    unittest.main()
