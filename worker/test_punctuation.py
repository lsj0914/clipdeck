import os
import unittest
from punctuation import tokenize, apply_predictions, lexical_content, Restorer, check_resources


class PunctuationOwnership(unittest.TestCase):
    def test_timed_punctuation_only_anchor_stays_nonempty_in_its_original_position(self):
        fragments = ["你好", ",", " 今天", "好"]
        tokens, ends = tokenize("".join(fragments))
        labels = [1] * len(tokens)
        labels[1] = 2
        labels[-1] = 3
        result = apply_predictions(fragments, ends, labels)
        self.assertEqual(result, ["你好", "，", " 今天", "好。"])
        self.assertTrue(all(result))
        # A no-punctuation prediction cannot erase an existing timed anchor.
        labels[1] = 1
        self.assertEqual(apply_predictions(fragments, ends, labels)[1], "，")

    def test_punctuation_only_anchor_keeps_whitespace_and_protected_numeric_separators(self):
        fragments = ["你好", " , ", "价格1", ",", "000", "版本v1", ".", "2"]
        original = "".join(fragments)
        tokens, ends = tokenize(original)
        labels = [1] * len(tokens)
        labels[1] = 2
        labels[-1] = 3
        result = apply_predictions(fragments, ends, labels)
        self.assertEqual(result[1], " ， ")
        self.assertEqual(result[3], ",")
        self.assertEqual(result[6], ".")
        self.assertEqual(lexical_content(original), lexical_content("".join(result)))

    def test_replaces_missing_or_ascii_punctuation_without_changing_fragments(self):
        fragments = ["大家", "好,", " 我是", "老师", "现在", "开始"]
        original = "".join(fragments)
        tokens, ends = tokenize(original)
        labels = [1] * len(tokens)
        labels[2] = 2
        labels[-1] = 3
        result = apply_predictions(fragments, ends, labels)
        self.assertEqual(result, ["大家", "好，", " 我是", "老师", "现在", "开始。"])
        self.assertEqual(lexical_content(original), lexical_content("".join(result)))

    def test_protects_decimals_versions_thousands_and_quoted_names_across_anchors(self):
        fragments = ["“ClipDeck”,", " v1.", "2", "花费", "1", ",000", "元!", " 好吗?"]
        original = "".join(fragments)
        tokens, ends = tokenize(original)
        labels = [1] * len(tokens)
        labels[tokens.index("元")] = 3
        labels[-1] = 4
        result = apply_predictions(fragments, ends, labels)
        self.assertEqual(result[1:3], [" v1.", "2"])
        self.assertEqual(result[4:6], ["1", ",000"])
        self.assertEqual(result[6], "元!")
        self.assertEqual(result[-1], " 好吗？")
        self.assertEqual(lexical_content(original), lexical_content("".join(result)))

    def test_empty_or_punctuation_only_input_does_not_lose_recognized_text(self):
        tokens, ends = tokenize(" …！")
        self.assertEqual(tokens, ["…"])
        self.assertEqual(apply_predictions([" …！"], ends, [3]), [" …！"])
        self.assertEqual(apply_predictions([], [], []), [])

    def test_invalid_labels_and_offsets_cannot_write_a_result(self):
        for ends, labels in [([0], [6]), ([0], []), ([10], [3])]:
            with self.assertRaises(ValueError):
                apply_predictions(["好"], ends, labels)

    def test_english_fills_gaps_while_preserving_existing_stops_and_punctuation_anchors(self):
        fragments = ["Hello", ".", " I", " am", " home,", " are", " you", " here", "?"]
        tokens, ends = tokenize("".join(fragments))
        labels = [1] * len(tokens)
        labels[tokens.index("home")] = 3
        labels[tokens.index("am")] = 2
        labels[-1] = 3
        result = apply_predictions(fragments, ends, labels, "en")
        self.assertEqual(result, ["Hello", ".", " I", " am,", " home,", " are", " you", " here", "?"])
        self.assertEqual(lexical_content("".join(fragments)), lexical_content("".join(result)))

    def test_english_preserves_numeric_and_quoted_content_with_ascii_punctuation(self):
        fragments = ["“ClipDeck”", " v1.", "2", " costs", " 1", ",000", " today", "!"]
        tokens, ends = tokenize("".join(fragments))
        labels = [1] * len(tokens)
        labels[tokens.index("costs")] = 2
        labels[-1] = 3
        result = apply_predictions(fragments, ends, labels, "en")
        self.assertEqual(result, ["“ClipDeck”", " v1.", "2", " costs,", " 1", ",000", " today", "!"])

    def test_unknown_punctuation_language_is_rejected(self):
        with self.assertRaisesRegex(ValueError, "language"):
            apply_predictions(["Hello"], [4], [3], "fr")

    def test_english_does_not_duplicate_stops_outside_closing_quotes_or_brackets(self):
        for value in ['He called it "safe".', 'He called it “safe”.', '(This is fine).', '“Is this fine”?']:
            fragments = [value]
            tokens, ends = tokenize(value)
            labels = [1] * len(tokens)
            labels[-1] = 3
            self.assertEqual(apply_predictions(fragments, ends, labels, "en"), fragments)

    def test_english_retains_existing_ellipsis_in_its_original_anchor(self):
        for fragments in [["Hello…"], ["Hello", "…"], ["Hello..."]]:
            tokens, ends = tokenize("".join(fragments))
            labels = [3] * len(tokens)
            self.assertEqual(apply_predictions(fragments, ends, labels, "en"), fragments)

    def test_missing_model_is_an_explicit_failure(self):
        with self.assertRaisesRegex(ValueError, "punctuation resource"):
            check_resources("missing-local-model")


@unittest.skipUnless(os.environ.get("CLIPDECK_PUNCTUATION_MODEL"), "explicit real pinned punctuation resource required")
class NativePunctuation(unittest.TestCase):
    def test_real_model_restores_chinese_sentences_without_rewriting_words(self):
        model = Restorer(os.environ["CLIPDECK_PUNCTUATION_MODEL"])
        values = ["大家", "好", ",", "我是", "老师", "今天", "我们", "学习", "如何", "使用", "电脑", "你们", "准备", "好了", "吗"]
        result = model.restore(values)
        self.assertEqual(len(values), len(result))
        self.assertIn("，", "".join(result))
        self.assertIn("？", "".join(result))
        self.assertEqual(result[2], "，")
        self.assertTrue(all(result))
        self.assertEqual(lexical_content("".join(values)), lexical_content("".join(result)))


if __name__ == "__main__":
    unittest.main()
