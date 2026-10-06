"""Local CT-Transformer punctuation with immutable recognition anchors.

The bounded look-ahead strategy follows FunASR's MIT-licensed ONNX runtime.
See packaging/notices/models/FunASR-LICENSE for attribution. Model weights are
Apache-2.0, pinned independently, and never fetched by this worker.
"""

import hashlib
import json
from pathlib import Path

MODEL_ID = "iic/punc_ct-transformer_zh-cn-common-vocab272727-onnx"
MODEL_REVISION = "8f239ff78c6267c4d859233e7eb3bbdb68c61824"
FILES = {
    "model_quant.onnx": (282752912, "e6cd8399bf7d0e75f8d9af4a107310e1968ecab1d50135e765b8f0265b27a83d"),
    "tokens.json": (4207480, "c960ab87bccea4aa15cf49a59f71973c2c330b46668048cd8da253749ec71ee3"),
}
PUNCTUATION = ("", "", "，", "。", "？", "、")
REPLACEABLE = frozenset("，。？、,?;；")


def check_resources(directory):
    root = Path(directory)
    for name, (size, expected) in FILES.items():
        file = root / name
        if not file.is_file() or file.stat().st_size != size:
            raise ValueError(f"Missing or invalid local punctuation resource: {name}")
        digest = hashlib.sha256()
        with file.open("rb") as stream:
            for chunk in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(chunk)
        if digest.hexdigest() != expected:
            raise ValueError(f"Local punctuation integrity mismatch: {name}")
    return {"id": MODEL_ID, "revision": MODEL_REVISION, "sha256": FILES["model_quant.onnx"][1]}


def replaceable(text, offset):
    char = text[offset]
    # Decimal/version/identifier punctuation and thousands separators carry
    # lexical meaning. Preserve them even across recognition word boundaries.
    between_ascii = (
        offset > 0 and offset + 1 < len(text)
        and text[offset - 1].isascii() and text[offset + 1].isascii()
        and text[offset - 1].isalnum() and text[offset + 1].isalnum()
    )
    if char == ".":
        return not between_ascii
    if char == "," and between_ascii and text[offset - 1].isdigit() and text[offset + 1].isdigit():
        return False
    return char in REPLACEABLE


def lexical_content(text):
    """Exact non-replaceable content, including whitespace and meaningful punctuation."""
    return "".join(char for offset, char in enumerate(text) if not replaceable(text, offset))


def tokenize(text):
    tokens, ends, current = [], [], ""
    for offset, char in enumerate(text):
        # Preserve quotes/exclamation marks in the output, but do not ask a word
        # classifier to treat a punctuation glyph as a spoken word.
        boundary = char.isspace() or replaceable(text, offset) or char in "!！:：\"“”‘’「」『』（）()[]【】"
        if boundary:
            if current:
                tokens.append(current)
                ends.append(offset - 1)
                current = ""
        elif char.isascii():
            current += char
        else:
            if current:
                tokens.append(current)
                ends.append(offset - 1)
                current = ""
            tokens.append(char)
            ends.append(offset)
    if current:
        tokens.append(current)
        ends.append(len(text) - 1)
    return tokens, ends


def apply_predictions(fragments, ends, labels):
    """Map predictions to original character owners, never create timed words."""
    if len(ends) != len(labels) or any(label not in range(6) for label in labels):
        raise ValueError("Invalid punctuation predictions")
    original = "".join(fragments)
    # ASR may give a punctuation token a positive-duration anchor of its own.
    # Route its prediction to that owner; erasing it would create an invalid word.
    punctuation_owners, punctuation_starts, position = {}, {}, 0
    for fragment in fragments:
        positions = [position + index for index, char in enumerate(fragment) if not char.isspace()]
        if positions and all(replaceable(original, index) for index in positions):
            punctuation_owners[positions[0]] = position
            punctuation_starts[position] = positions[0]
        position += len(fragment)
    additions = {}
    for offset, label in zip(ends, labels):
        if offset < 0 or offset >= len(original):
            raise ValueError("Punctuation offset outside recognized text")
        next_offset = offset + 1
        while next_offset < len(original) and original[next_offset].isspace():
            next_offset += 1
        # An existing exclamation/colon is stronger evidence than a model that
        # has no such output class. Keep it instead of producing '？！'.
        if next_offset < len(original) and original[next_offset] in "!！:：":
            continue
        owner = next_offset if next_offset in punctuation_owners else offset
        additions[owner] = PUNCTUATION[label]
    result, offset = [], 0
    for fragment in fragments:
        if offset in punctuation_starts:
            owner = punctuation_starts[offset]
            mark = additions.get(owner, "")
            if mark:
                value = "".join(char if char.isspace() else mark if offset + index == owner else ""
                                for index, char in enumerate(fragment))
            else:
                value = fragment.translate(str.maketrans({",": "，", ".": "。", "?": "？", ";": "；"}))
            result.append(value)
            offset += len(fragment)
            continue
        value = ""
        for char in fragment:
            if not replaceable(original, offset):
                value += char
            value += additions.get(offset, "")
            offset += 1
        result.append(value)
    if lexical_content(original) != lexical_content("".join(result)):
        raise ValueError("Punctuation changed recognized content")
    return result


class Restorer:
    def __init__(self, directory):
        self.identity = check_resources(directory)
        import numpy as np
        import onnxruntime as ort

        ort.disable_telemetry_events()
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(
            str(Path(directory) / "model_quant.onnx"), options,
            providers=["CPUExecutionProvider"],
        )
        vocabulary = json.loads((Path(directory) / "tokens.json").read_text(encoding="utf-8"))
        if not isinstance(vocabulary, list) or len(vocabulary) != 272727 or vocabulary[-1] != "<unk>":
            raise ValueError("Invalid punctuation vocabulary")
        self.vocabulary = {token: index for index, token in enumerate(vocabulary)}
        self.np = np

    def predict(self, tokens):
        cache, result = [], []
        for start in range(0, len(tokens), 20):
            cache += tokens[start:start + 20]
            ids = self.np.asarray([[self.vocabulary.get(token, 272726) for token in cache]], dtype=self.np.int32)
            logits = self.session.run(None, {
                "inputs": ids,
                "text_lengths": self.np.asarray([len(cache)], dtype=self.np.int32),
            })[0][0]
            labels = self.np.argmax(logits, axis=-1).tolist()
            if len(labels) != len(cache):
                raise ValueError("Punctuation model returned an invalid length")
            if start + 20 >= len(tokens):
                if labels and labels[-1] in (0, 1, 2, 5):
                    labels[-1] = 3
                result += labels
                break
            end, comma = -1, -1
            for index in range(len(labels) - 2, 1, -1):
                if labels[index] in (3, 4):
                    end = index
                    break
                if comma == -1 and labels[index] == 2:
                    comma = index
            if end < 0 and len(cache) > 200:
                # Bound memory even for a pathological passage without a stop.
                end = comma if comma >= 0 else len(cache) - 21
                labels[end] = 3
            result += labels[:end + 1]
            cache = cache[end + 1:]
        if len(result) != len(tokens):
            raise ValueError("Incomplete punctuation result")
        return result

    def restore(self, fragments):
        if not isinstance(fragments, list) or len(fragments) > 500000 or any(not isinstance(value, str) or len(value) > 10000 for value in fragments):
            raise ValueError("Invalid punctuation input")
        tokens, ends = tokenize("".join(fragments))
        if not tokens:
            return fragments.copy()
        return apply_predictions(fragments, ends, self.predict(tokens))
