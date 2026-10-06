import unittest
from types import SimpleNamespace
from transcribe import normalize_words, normalize_batch, decode_options, check_model


class TimingProtocol(unittest.TestCase):
    def test_actual_packet_emitter_advertises_review_and_retains_folded_and_all_untimed_text(self):
        import contextlib
        import io
        import json
        import sys
        import tempfile
        import wave
        from pathlib import Path
        from unittest.mock import patch
        import transcribe

        class Tokenizer:
            @staticmethod
            def from_file(_path):
                return Tokenizer()

            def encode(self, text):
                return SimpleNamespace(ids=list(range(len(text))))

        # Only the external model generator is replaced. Actual PCM validation,
        # decode options, normalization and JSON packet emission execute below.
        class Model:
            def __init__(self, *_args, **_kwargs):
                pass

            def transcribe(self, *_args, **_kwargs):
                return iter([
                    SimpleNamespace(start=0.1, end=0.5, text="One folded", words=[
                        SimpleNamespace(word="One", start=0.1, end=0.3),
                        SimpleNamespace(word=" folded", start=0.3, end=0.3)]),
                    SimpleNamespace(start=0.5, end=0.8, text="Lead next", words=[
                        SimpleNamespace(word="Lead", start=0.5, end=0.5),
                        SimpleNamespace(word=" next", start=0.6, end=0.8)]),
                    SimpleNamespace(start=0.8, end=0.9, text="!", words=[
                        SimpleNamespace(word="!", start=0.8, end=0.8)]),
                ]), SimpleNamespace(language="en")

        with tempfile.TemporaryDirectory() as temporary:
            audio = str(Path(temporary) / "unit.wav")
            with wave.open(audio, "wb") as wav:
                wav.setnchannels(1)
                wav.setsampwidth(2)
                wav.setframerate(16000)
                wav.writeframes(b"\x00\x00" * 16000)
            output = io.StringIO()
            with patch.dict(sys.modules, {
                "faster_whisper": SimpleNamespace(WhisperModel=Model),
                "tokenizers": SimpleNamespace(Tokenizer=Tokenizer),
            }), patch.object(transcribe, "check_model", return_value={"modelChoice": "small", "modelId": "unit", "modelDigest": "unit-digest"}), patch.object(transcribe, "preflight", return_value={"pythonVersion": "3.12.15", "telemetryDisabled": True}), contextlib.redirect_stdout(output):
                transcribe.transcribe({"modelDirectory": temporary, "audioPath": audio, "durationMs": 1000, "language": "en"})
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertIs(events[0].get("wordTimingReview"), True)
        self.assertIs(events[-1].get("wordTimingReview"), True)
        self.assertIs(events[-1]["conditionOnPreviousText"], False)
        self.assertEqual(events[1]["words"], [{"text": "One folded", "startMs": 100, "endMs": 300, "timingNeedsReview": True}])
        self.assertEqual(events[2]["words"], [{"text": " next", "startMs": 600, "endMs": 800}])
        self.assertEqual(events[2]["leadingUntimedText"], "Lead")
        self.assertEqual((events[3]["words"], events[3]["leadingUntimedText"]), ([], "!"))
        self.assertEqual(events[-1]["untimedWordCount"], 3)


class Timings(unittest.TestCase):

    def test_zero_duration_word_merges_without_fabricating_timing(self):
        (words, count) = normalize_words(
            [
                SimpleNamespace(word="Hello", start=0.1, end=0.5),
                SimpleNamespace(word=",", start=0.5, end=0.5),
                SimpleNamespace(word="world", start=0.5, end=1.0),
            ],
            1000,
        )
        self.assertEqual(
            words,
            [
                {"text": "Hello,", "startMs": 100, "endMs": 500, "timingNeedsReview": True},
                {"text": "world", "startMs": 500, "endMs": 1000},
            ],
        )
        self.assertEqual(count, 1)

    def test_folded_lexical_material_marks_only_its_receiving_anchor(self):
        words, count = normalize_words(
            [SimpleNamespace(word="One", start=0.1, end=0.3),
             SimpleNamespace(word=" folded clause", start=0.3, end=0.3),
             SimpleNamespace(word=" Next", start=0.4, end=0.7)], 1000,
        )
        self.assertEqual(words, [
            {"text": "One folded clause", "startMs": 100, "endMs": 300, "timingNeedsReview": True},
            {"text": " Next", "startMs": 400, "endMs": 700},
        ])
        self.assertEqual(count, 1)

    def test_direct_leading_fold_is_reviewed_but_batch_transfer_does_not_flag_unmodified_word(self):
        values = [SimpleNamespace(word="Lead", start=0.1, end=0.1),
                  SimpleNamespace(word=" word", start=0.2, end=0.5)]
        words, count = normalize_words(values, 1000)
        self.assertEqual(words, [{"text": "Lead word", "startMs": 200, "endMs": 500, "timingNeedsReview": True}])
        words, count, leading = normalize_batch(values, 1000)
        self.assertEqual(words, [{"text": " word", "startMs": 200, "endMs": 500}])
        self.assertEqual((count, leading), (1, "Lead"))

    def test_batch_leading_and_trailing_folds_keep_review_on_remaining_material(self):
        words, count, leading = normalize_batch(
            [SimpleNamespace(word="Lead", start=0.1, end=0.1),
             SimpleNamespace(word=" word", start=0.2, end=0.5),
             SimpleNamespace(word="!", start=0.5, end=0.5)], 1000,
        )
        self.assertEqual(words, [{"text": " word!", "startMs": 200, "endMs": 500, "timingNeedsReview": True}])
        self.assertEqual((count, leading), (2, "Lead"))

    def test_all_untimed_batch_retains_text_without_creating_any_timed_anchor(self):
        words, count, leading = normalize_batch(
            [SimpleNamespace(word="Untimed", start=0.1, end=0.1),
             SimpleNamespace(word="!", start=0.1, end=0.1)], 1000,
        )
        self.assertEqual((words, count, leading), ([], 2, "Untimed!"))

    def test_leading_untimed_punctuation_is_explicit_for_previous_batch_anchor(self):
        words, count, leading = normalize_batch(
            [
                SimpleNamespace(word=".", start=0.3, end=0.3),
                SimpleNamespace(word=" Next", start=0.4, end=0.7),
            ],
            1000,
        )
        self.assertEqual(words, [{"text": " Next", "startMs": 400, "endMs": 700}])
        self.assertEqual(leading, ".")
        self.assertEqual(count, 1)

    def test_nonfinite_word_is_rejected(self):
        with self.assertRaises(ValueError):
            normalize_words(
                [SimpleNamespace(word="bad", start=float("nan"), end=1.0)], 1000
            )

    def test_source_bound_is_respected(self):
        (words, count) = normalize_words(
            [SimpleNamespace(word="end", start=0.9, end=1.2)], 1000
        )
        self.assertEqual(words, [{"text": "end", "startMs": 900, "endMs": 1000}])


class QualityOptions(unittest.TestCase):
    def test_decoder_does_not_feed_generated_text_into_later_windows(self):
        # This protects the documented upstream repetition-loop boundary while
        # retaining the same explicit vocabulary and initial prompt.
        class Tokenizer:
            def encode(self, text):
                return SimpleNamespace(ids=list(range(len(text))))

        for language in ["auto", "en", "zh"]:
            options = decode_options(language, "example", Tokenizer())
            self.assertIs(options["condition_on_previous_text"], False)
            self.assertEqual(options["hotwords"], "example")

    def test_simplified_prompt_and_bounded_hotwords_use_actual_tokenizer(self):
        import os
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(
            os.path.expanduser(
                "~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json"
            )
        )
        options = decode_options("zh", "跑步，健康", tokenizer)
        self.assertIn("简体中文", options["initial_prompt"])
        self.assertEqual(options["hotwords"], "跑步，健康")
        self.assertLessEqual(
            len(tokenizer.encode(options["initial_prompt"]).ids)
            + len(tokenizer.encode(options["hotwords"]).ids),
            128,
        )
        self.assertIsNone(decode_options("en", "", tokenizer)["initial_prompt"])
        for vocabulary in [
            "词" * 1001,
            ",".join(["word"] * 65),
            "复杂" * 200,
            "bad\x00value",
        ]:
            with self.assertRaises(ValueError):
                decode_options("zh", vocabulary, tokenizer)

    @unittest.skipUnless(
        __import__("os").environ.get("CLIPDECK_TURBO_MODEL"),
        "explicit local stronger model required",
    )
    def test_stronger_manifest_is_fully_verified_and_unknown_choice_rejected(self):
        import os

        check_model(os.environ["CLIPDECK_TURBO_MODEL"], "turbo")
        with self.assertRaises(ValueError):
            check_model(os.environ["CLIPDECK_TURBO_MODEL"], "anything")


if __name__ == "__main__":
    unittest.main()
