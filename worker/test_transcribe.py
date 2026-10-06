import unittest
from types import SimpleNamespace
from transcribe import normalize_words, normalize_batch, decode_options, check_model


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
                {"text": "Hello,", "startMs": 100, "endMs": 500},
                {"text": "world", "startMs": 500, "endMs": 1000},
            ],
        )
        self.assertEqual(count, 1)

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
