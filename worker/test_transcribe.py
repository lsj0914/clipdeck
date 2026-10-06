import unittest
from types import SimpleNamespace
from transcribe import normalize_words, normalize_batch, decode_options, check_model
class AudioCapacity(unittest.TestCase):
    def test_seam_sorts_crossing_anchors_and_retains_a_wordless_owned_packet(self):
        import numpy as np
        import contextlib
        import io
        import json
        import sys
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import transcribe
        class Tokenizer:
            @staticmethod
            def from_file(_path):
                return Tokenizer()
            def encode(self, text, add_special_tokens=False):
                return SimpleNamespace(ids=list(range(len(text))))
        for wordless in (False, True):
            with self.subTest(wordless=wordless), tempfile.TemporaryDirectory() as directory:
                source = Path(directory) / "crossing.pcm"
                with source.open("wb") as file:
                    file.truncate(302 * 16000 * 2)
                class Model:
                    calls = 0
                    def __init__(self, *_args, **_kwargs):
                        pass
                    def transcribe(self, *_args, **_kwargs):
                        self.calls += 1
                        if self.calls == 1:
                            start, end = (299.9, 299.99) if wordless else (299.8, 300.1)
                            packets = [SimpleNamespace(start=start, end=end, text="First",
                                words=[SimpleNamespace(word="First", start=start, end=end)])]
                        elif wordless:
                            packets = [SimpleNamespace(start=1.8, end=2.4, text="Untimed",
                                    words=[SimpleNamespace(word="Untimed", start=1.8, end=1.8)]),
                                SimpleNamespace(start=2.45, end=2.6, text="Second",
                                    words=[SimpleNamespace(word="Second", start=2.45, end=2.6)])]
                        else:
                            packets = [SimpleNamespace(start=1.75, end=2.5, text="Second",
                                words=[SimpleNamespace(word="Second", start=1.75, end=2.5)])]
                        return iter(packets), SimpleNamespace(language="en")
                output = io.StringIO()
                with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=Model),
                    "tokenizers": SimpleNamespace(Tokenizer=Tokenizer)}), \
                    patch.object(transcribe, "check_model", return_value={}), patch.object(transcribe, "preflight", return_value={}), \
                    contextlib.redirect_stdout(output):
                    transcribe.transcribe({"modelDirectory": directory, "audioPath": str(source), "audioFormat": "s16le",
                        "durationMs": 302000, "language": "en"})
                events = [json.loads(line) for line in output.getvalue().splitlines()]
                packets = [event for event in events if event["type"] == "segment"]
                words = [word for packet in packets for word in packet["words"]]
                self.assertEqual([word["startMs"] for word in words], sorted(word["startMs"] for word in words))
                if wordless:
                    untimed = [packet for packet in packets if packet["text"] == "Untimed"]
                    self.assertEqual(len(untimed), 1)
                    self.assertEqual(untimed[0]["words"], [])
                    self.assertEqual([(word["startMs"], word["endMs"]) for word in words], [(299900, 299990), (300450, 300600)])
                else:
                    self.assertEqual([word["text"] for word in words], ["Second", "First"])
                    self.assertEqual([(word["startMs"], word["endMs"]) for word in words], [(299750, 300500), (299800, 300100)])
                    self.assertTrue(all(word["timingNeedsReview"] for word in words))
                self.assertEqual(events[-1]["type"], "complete")

    def test_leading_untimed_overlap_does_not_reject_chronological_anchors_at_five_minutes(self):
        import numpy as np
        import contextlib
        import io
        import json
        import sys
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import transcribe
        class Tokenizer:
            @staticmethod
            def from_file(_path):
                return Tokenizer()
            def encode(self, text, add_special_tokens=False):
                return SimpleNamespace(ids=list(range(len(text))))
        class Model:
            calls = 0
            def __init__(self, *_args, **_kwargs):
                pass
            def transcribe(self, *_args, **_kwargs):
                self.calls += 1
                segment = (SimpleNamespace(start=299.8, end=299.99, text="Previous",
                    words=[SimpleNamespace(word="Previous", start=299.8, end=299.99)])
                    if self.calls == 1 else SimpleNamespace(start=0.0, end=2.3, text=" lead next",
                        words=[SimpleNamespace(word=" lead", start=0.0, end=0.0),
                            SimpleNamespace(word=" next", start=2.1, end=2.3)]))
                return iter([segment]), SimpleNamespace(language="en")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "five-minute-seam.pcm"
            with source.open("wb") as file:
                file.truncate(301 * 16000 * 2)
            output = io.StringIO()
            with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=Model),
                "tokenizers": SimpleNamespace(Tokenizer=Tokenizer)}), \
                patch.object(transcribe, "check_model", return_value={}), patch.object(transcribe, "preflight", return_value={}), \
                contextlib.redirect_stdout(output):
                transcribe.transcribe({"modelDirectory": directory, "audioPath": str(source), "audioFormat": "s16le",
                    "durationMs": 301000, "language": "en"})
        segments = [json.loads(line) for line in output.getvalue().splitlines() if json.loads(line)["type"] == "segment"]
        self.assertEqual(len(segments), 2)
        self.assertEqual(segments[1]["leadingUntimedText"], " lead")
        self.assertEqual(segments[1]["words"], [{"text": " next", "startMs": 300100,
            "endMs": 300300, "timingNeedsReview": True}])
        self.assertEqual((segments[1]["startMs"], segments[1]["endMs"]), (300100, 300300))

    def test_overlap_emits_each_measured_anchor_once_on_the_original_timeline(self):
        import contextlib
        import io
        import json
        import sys
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import numpy as np
        import transcribe

        class Tokenizer:
            @staticmethod
            def from_file(_path):
                return Tokenizer()
            def encode(self, text, add_special_tokens=False):
                return SimpleNamespace(ids=list(range(len(text))))

        lengths = []
        class Model:
            calls = 0
            def __init__(self, *_args, **_kwargs):
                pass
            def transcribe(self, audio, **_kwargs):
                offset = [0, 1.75, 3.75][self.calls]
                self.calls += 1
                lengths.append(len(audio))
                anchors = [("One", 0.1, 0.5), (" boundary", 1.8, 2.2),
                    (" other", 3.8, 4.2), (" end.", 4.5, 4.8)]
                words = [SimpleNamespace(word=text, start=start-offset, end=end-offset)
                    for text, start, end in anchors if offset <= start and end <= offset + len(audio)/16000]
                return iter([SimpleNamespace(start=words[0].start, end=words[-1].end,
                    text="".join(word.word for word in words), words=words)]), SimpleNamespace(language="en")

        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "bounded.pcm"
            np.zeros(80000, dtype="<i2").tofile(source)
            output = io.StringIO()
            with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=Model),
                "tokenizers": SimpleNamespace(Tokenizer=Tokenizer)}), \
                patch.object(transcribe, "check_model", return_value={"modelChoice": "small"}), \
                patch.object(transcribe, "preflight", return_value={}), \
                patch.object(transcribe, "AUDIO_CHUNK_MS", 2000), \
                patch.object(transcribe, "AUDIO_OVERLAP_MS", 250), contextlib.redirect_stdout(output):
                transcribe.transcribe({"modelDirectory": directory, "audioPath": str(source),
                    "audioFormat": "s16le", "durationMs": 5000, "language": "en"})
            events = [json.loads(line) for line in output.getvalue().splitlines()]
        words = [word for event in events if event["type"] == "segment" for word in event["words"]]
        self.assertEqual([word["text"] for word in words], ["One", " boundary", " other", " end."])
        self.assertEqual([(word["startMs"], word["endMs"]) for word in words],
            [(100, 500), (1800, 2200), (3800, 4200), (4500, 4800)])
        self.assertTrue(words[1]["timingNeedsReview"])
        self.assertTrue(words[2]["timingNeedsReview"])
        self.assertNotIn("timingNeedsReview", words[0])
        self.assertNotIn("timingNeedsReview", words[3])
        self.assertEqual(lengths, [36000, 40000, 20000])
        self.assertEqual(events[-1]["type"], "complete")
        self.assertEqual(events[-1]["segmentCount"], 3)
        progress = [event["processedMs"] for event in events if "processedMs" in event]
        self.assertEqual(progress, sorted(progress))

    def test_automatic_detection_waits_for_speech_after_a_silent_first_window(self):
        import contextlib
        import io
        import json
        import sys
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import numpy as np
        import transcribe
        speech_calls, languages = [], []
        def speech(audio):
            speech_calls.append(len(audio))
            return [] if len(speech_calls) == 1 else [{"start": 4000, "end": len(audio)}]
        class Tokenizer:
            @staticmethod
            def from_file(_path):
                return Tokenizer()
            def encode(self, text, add_special_tokens=False):
                return SimpleNamespace(ids=list(range(len(text))))
        class Model:
            def __init__(self, *_args, **_kwargs):
                pass
            def detect_language(self, audio):
                return "zh", 0.9, []
            def transcribe(self, audio, **options):
                languages.append(options["language"])
                return iter([]), SimpleNamespace(language="zh")
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "silent-intro.pcm"
            np.zeros(80000, dtype="<i2").tofile(source)
            output = io.StringIO()
            with patch.dict(sys.modules, {"faster_whisper": SimpleNamespace(WhisperModel=Model),
                "faster_whisper.vad": SimpleNamespace(get_speech_timestamps=speech,
                    collect_chunks=lambda audio, spans: ([audio[spans[0]["start"]:spans[0]["end"]]], {})),
                "tokenizers": SimpleNamespace(Tokenizer=Tokenizer)}), \
                patch.object(transcribe, "check_model", return_value={}), patch.object(transcribe, "preflight", return_value={}), \
                patch.object(transcribe, "AUDIO_CHUNK_MS", 2000), patch.object(transcribe, "AUDIO_OVERLAP_MS", 250), \
                contextlib.redirect_stdout(output):
                transcribe.transcribe({"modelDirectory": directory, "audioPath": str(source), "audioFormat": "s16le",
                    "durationMs": 5000, "language": "auto"})
        events = [json.loads(line) for line in output.getvalue().splitlines()]
        self.assertEqual(speech_calls, [36000, 40000])
        self.assertEqual(languages, ["zh", "zh"])
        self.assertEqual(events[0], {"type": "progress", "processedMs": 2000})
        self.assertTrue(events[-1]["simplifiedChinese"])
        self.assertEqual(events[-1]["language"], "zh")

    def test_oversized_sparse_pcm_is_rejected_without_reading_audio_or_loading_a_model(self):
        import os
        import tempfile
        from pathlib import Path
        from unittest.mock import patch
        import transcribe
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "oversized.pcm"
            with source.open("wb") as file:
                file.truncate((21600 + 2) * 16000 * 2 + 2)
            with patch.object(transcribe, "check_model", side_effect=AssertionError("model must not be loaded")):
                with self.assertRaisesRegex(ValueError, "supported"):
                    transcribe.transcribe({"modelDirectory": directory, "audioPath": str(source),
                        "audioFormat": "s16le", "durationMs": 21600000, "language": "en"})
            self.assertEqual(os.stat(source).st_blocks, 0)

    def test_declared_source_over_limit_is_rejected_before_model_verification(self):
        from unittest.mock import patch
        import transcribe
        with patch.object(transcribe, "check_model", side_effect=AssertionError("model must not be loaded")):
            with self.assertRaisesRegex(ValueError, "six hours"):
                transcribe.transcribe({"modelDirectory": "/unavailable", "audioPath": "/unavailable",
                    "durationMs": 21600001, "language": "en"})

    def test_pcm_windows_are_bounded_and_keep_the_original_sample_offsets(self):
        import tempfile
        from pathlib import Path
        import numpy as np
        import transcribe
        with tempfile.TemporaryDirectory() as directory:
            source = Path(directory) / "samples.pcm"
            np.arange(16000 * 5, dtype="<i2").tofile(source)
            with transcribe.PCMSource({"audioPath": str(source), "audioFormat": "s16le", "durationMs": 5000}) as audio:
                self.assertEqual(audio.frames, 80000)
                window = audio.read_window(16000, 48000)
                self.assertEqual(len(window), 32000)
                self.assertAlmostEqual(float(window[0]), 16000 / 32768)
                self.assertEqual(window.dtype, np.float32)
                with self.assertRaisesRegex(ValueError, "window"):
                    audio.read_window(0, (transcribe.AUDIO_CHUNK_MS + 4001) * 16)


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

            def encode(self, text, add_special_tokens=False):
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
    def test_context_boundary_matches_the_pinned_decoder_without_special_tokens(self):
        import os
        from tokenizers import Tokenizer
        from faster_whisper.tokenizer import Tokenizer as DecoderTokenizer

        raw = Tokenizer.from_file(os.path.expanduser(
            "~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json"
        ))
        decoder = DecoderTokenizer(raw, True, task="transcribe", language="en")
        for count, expected in [(106, 123), (111, 128)]:
            vocabulary = " ".join(["alpha"] * count)
            try:
                options = decode_options("en", vocabulary, raw)
            except ValueError as error:
                self.fail(f"Decoder context {expected} within 128 was rejected: {error}")
            self.assertEqual(options["hotwords"], vocabulary)
            self.assertEqual(len(decoder.encode(" " + options["initial_prompt"]))
                             + len(decoder.encode(" " + options["hotwords"])), expected)
        with self.assertRaisesRegex(ValueError, "Keep only the most important"):
            decode_options("en", " ".join(["alpha"] * 112), raw)

    def test_seven_short_terms_fit_without_duplicating_the_vocabulary(self):
        import os
        from tokenizers import Tokenizer

        tokenizer = Tokenizer.from_file(os.path.expanduser(
            "~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120/tokenizer.json"
        ))
        vocabulary = "张示例，项目管理，关键路径，范围变更，资源平衡，风险评估，干系人"
        try:
            options = decode_options("zh", vocabulary, tokenizer)
        except ValueError as error:
            self.fail(f"Seven short terms were unexpectedly rejected: {error}")
        self.assertEqual(options["hotwords"], vocabulary)
        self.assertNotIn(vocabulary, options["initial_prompt"])
        self.assertLessEqual(
            len(tokenizer.encode(" " + options["initial_prompt"]).ids)
            + len(tokenizer.encode(" " + options["hotwords"]).ids), 128,
        )

    def test_option_validation_runs_without_audio_and_returns_an_actionable_overflow(self):
        import json
        import os
        import subprocess
        import sys
        from pathlib import Path

        directory = os.path.expanduser(
            "~/.cache/huggingface/hub/models--Systran--faster-whisper-small/snapshots/536b0662742c02347bc0e980a01041f333bce120"
        )
        for language, vocabulary, valid in [
            ("auto", "Example, project management", True),
            ("zh", "张示例，项目管理，关键路径，范围变更，资源平衡，风险评估，干系人", True),
            ("en", "复杂" * 200, False),
        ]:
            result = subprocess.run(
                [sys.executable, str(Path(__file__).with_name("transcribe.py"))],
                input=json.dumps({"mode": "validate-options", "modelDirectory": directory,
                                  "language": language, "vocabulary": vocabulary}),
                text=True, capture_output=True, timeout=15,
            )
            event = json.loads(result.stdout)
            if valid:
                self.assertEqual(result.returncode, 0, event)
                self.assertEqual(event, {"type": "options-validated"})
            else:
                self.assertEqual(result.returncode, 1)
                self.assertEqual(event["type"], "error")
                self.assertIn("Keep only the most important names and terms", event["message"])

    def test_decoder_does_not_feed_generated_text_into_later_windows(self):
        # This protects the documented upstream repetition-loop boundary while
        # retaining the same explicit vocabulary and initial prompt.
        class Tokenizer:
            def encode(self, text, add_special_tokens=False):
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
        self.assertIn("commas and full stops", decode_options("en", "", tokenizer)["initial_prompt"])
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
