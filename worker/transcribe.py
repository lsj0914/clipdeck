"""Offline JSONL worker. Only predecoded 16 kHz mono signed-16 PCM WAV is accepted."""

import os

# Must precede any ONNX Runtime import; API-only disablement still initializes telemetry storage.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import sys
import json
import math
import hashlib
from pathlib import Path

MODEL_FILES = {
    "model.bin": (
        483546902,
        "3e305921506d8872816023e4c273e75d2419fb89b24da97b4fe7bce14170d671",
    ),
    "tokenizer.json": (
        2203239,
        "fb7b63191e9bb045082c79fd742a3106a12c99513ab30df4a0d47fa6cb6fd0ab",
    ),
    "config.json": (
        2370,
        "b55496ac7940a7ae47d2c01eab40edfd8701feec1229d9cce3b40014383fb828",
    ),
    "vocabulary.txt": (
        459861,
        "34ce3fe1c5041027b3f8d42912270993f986dbc4bb34cf27f951e34a1e453913",
    ),
}
VAD_DIGEST = "4cbf549b8326f60f80f2536d9eefeb450a9abe83365a098031c89719f1be17d2"


def digest(file):
    h = hashlib.sha256()
    with file.open("rb") as stream:
        while chunk := stream.read(1024 * 1024):
            h.update(chunk)
    return h.hexdigest()


def emit(event):
    print(json.dumps(event, ensure_ascii=False, allow_nan=False), flush=True)


def preflight(vad_resource=None):
    import importlib.metadata as metadata

    python_version = sys.version.split()[0]
    if python_version != "3.12.15":
        raise RuntimeError("Worker requires Python 3.12.15")
    pins = {
        "faster-whisper": "1.2.1",
        "numpy": "2.5.3",
        "ctranslate2": "4.8.2",
        "av": "16.0.1+clipdeck.ffmpeg8.1.2",
        "onnxruntime": "1.30.0",
        "tokenizers": "0.23.2",
    }
    versions = {name: metadata.version(name) for name in pins}
    for name, version in pins.items():
        if versions[name] != version:
            raise RuntimeError(f"Worker version mismatch: {name}; expected {version}")
    import onnxruntime

    onnxruntime.disable_telemetry_events()
    import faster_whisper

    vad = (
        Path(vad_resource)
        if vad_resource
        else Path(faster_whisper.__file__).parent / "assets/silero_vad_v6.onnx"
    )
    if not vad.is_file() or vad.stat().st_size != 1245151 or digest(vad) != VAD_DIGEST:
        raise RuntimeError("Missing or invalid local VAD resource: silero_vad_v6.onnx")
    return {
        "pythonVersion": python_version,
        "telemetryDisabled": True,
        "engine": {"name": "faster-whisper", "version": versions["faster-whisper"]},
        "versions": versions,
        "vadDigest": VAD_DIGEST,
    }


TURBO_FILES = {
    "config.json": (
        2263,
        "b0253ea6c0d3bea6b1e19e91a02acfd3b53f4467362efcb5a3e6b16c9b3a9b7e",
    ),
    "preprocessor_config.json": (
        340,
        "7ccc62c6f2765af1f3b46c00c9b5894426835a05021c8b9c01eecb6dfb542711",
    ),
    "tokenizer.json": (
        2710337,
        "297b13372ac43916285644fb9687add3cc62ee2a1adb60da3dc25cc94c1871fd",
    ),
    "vocabulary.json": (
        1068114,
        "c69260f2ab26d659b7c398f9a2b2b48ed0df16c3b47d7326782fd9cba71690c1",
    ),
    "model.bin": (
        1617884929,
        "e76620f83d5f5b69efd3d87e3dc180c1bd21df9fbebacfd4335e5e1efcc018da",
    ),
}
MODEL_MANIFESTS = {
    "small": {"id": "Systran/faster-whisper-small", "files": MODEL_FILES},
    "turbo": {"id": "dropbox-dash/faster-whisper-large-v3-turbo", "files": TURBO_FILES},
}


def check_model(directory, choice="small"):
    if choice not in MODEL_MANIFESTS:
        raise ValueError("Unsupported local model choice")
    manifest = MODEL_MANIFESTS[choice]
    for name, (size, sha) in manifest["files"].items():
        file = Path(directory) / name
        if not file.is_file():
            raise FileNotFoundError(
                f"Missing local model resource: {name}; online fallback forbidden"
            )
        if file.stat().st_size != size or digest(file) != sha:
            raise ValueError(f"Local model hash/size mismatch: {name}")
    resources = [
        {"name": name, "bytes": size, "sha256": sha}
        for name, (size, sha) in manifest["files"].items()
    ]
    return {
        "modelChoice": choice,
        "modelId": manifest["id"],
        "modelDigest": hashlib.sha256(
            json.dumps(resources, separators=(",", ":")).encode()
        ).hexdigest(),
    }


def decode_options(language, vocabulary, tokenizer):
    import re

    if (
        not isinstance(vocabulary, str)
        or len(vocabulary) > 1000
        or re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f]", vocabulary)
    ):
        raise ValueError("Vocabulary must contain at most 1000 characters")
    vocabulary = vocabulary.strip()
    if len([term for term in re.split(r"[,，;；\n]", vocabulary) if term.strip()]) > 64:
        raise ValueError("Vocabulary must contain at most 64 terms")
    prompt = "请使用简体中文转写。" if language == "zh" else ""
    if vocabulary:
        prompt += ("\n词汇：" if language == "zh" else "") + vocabulary
    if len(tokenizer.encode(prompt).ids) + len(tokenizer.encode(vocabulary).ids) > 128:
        raise ValueError("Vocabulary and prompt exceed the 128-token context budget")
    return {
        "initial_prompt": prompt or None,
        "hotwords": vocabulary or None,
        # Generated text from an earlier window can reinforce repetition loops.
        # Keep the explicit prompt/hotwords, but reset recognition history.
        "condition_on_previous_text": False,
    }


def normalize_words(words, duration_ms, *, fold_leading=True):
    result = []
    untimed = 0
    prefix = ""
    previous = -1
    for word in words:
        start = float(word.start)
        end = float(word.end)
        text = str(word.word)
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or (end < start)
        ):
            raise ValueError("Invalid nonfinite/reversed word timestamp")
        if start < previous:
            raise ValueError("Nonmonotonic word timestamp")
        previous = start
        s = min(duration_ms, round(start * 1000))
        e = min(duration_ms, round(end * 1000))
        if e <= s:
            untimed += 1
            if result:
                result[-1]["text"] += text
                if text:
                    result[-1]["timingNeedsReview"] = True
            else:
                prefix += text
            continue
        anchor = {
            "text": (prefix if fold_leading else "") + text,
            "startMs": int(s),
            "endMs": int(e),
        }
        if prefix and fold_leading:
            anchor["timingNeedsReview"] = True
        result.append(anchor)
        prefix = ""
    return (result, untimed)


def normalize_batch(words, duration_ms):
    batch = list(words)
    # Main transfers batch-leading text; flag only anchors retaining folded text here.
    normalized, count = normalize_words(batch, duration_ms, fold_leading=False)
    leading = ""
    for word in batch:
        start = min(duration_ms, round(float(word.start) * 1000))
        end = min(duration_ms, round(float(word.end) * 1000))
        if end > start:
            break
        leading += str(word.word)
    return normalized, count, leading


def transcribe(request):
    identity = check_model(
        request["modelDirectory"], request.get("modelChoice", "small")
    )
    ready = preflight(request.get("vadResource"))
    import wave
    import numpy as np
    from faster_whisper import WhisperModel
    from tokenizers import Tokenizer

    duration_ms = request["durationMs"]
    if not isinstance(duration_ms, int) or duration_ms < 1:
        raise ValueError("Invalid source duration")
    language = request["language"]
    if language not in ("auto", "en", "zh"):
        raise ValueError("Unsupported language")
    with wave.open(request["audioPath"], "rb") as wav:
        if (
            wav.getnchannels() != 1
            or wav.getframerate() != 16000
            or wav.getsampwidth() != 2
            or (wav.getcomptype() != "NONE")
        ):
            raise ValueError("Worker input must be predecoded mono 16k signed-16 PCM")
        if wav.getnframes() > 16000 * 86400:
            raise ValueError("PCM audio exceeds supported duration")
        audio = (
            np.frombuffer(wav.readframes(wav.getnframes()), dtype="<i2").astype(
                np.float32
            )
            / 32768.0
        )
    if not np.isfinite(audio).all():
        raise ValueError("Nonfinite decoded PCM")
    decode = decode_options(
        language,
        request.get("vocabulary", ""),
        Tokenizer.from_file(str(Path(request["modelDirectory"]) / "tokenizer.json")),
    )
    ready = {
        **ready,
        **identity,
        "simplifiedChinese": language == "zh",
        "conditionOnPreviousText": decode["condition_on_previous_text"],
        "wordTimingReview": True,
    }
    model = WhisperModel(
        request["modelDirectory"],
        device="cpu",
        compute_type="int8",
        local_files_only=True,
        cpu_threads=4,
    )
    emit({"type": "ready", **ready})
    (segments, info) = model.transcribe(
        audio,
        language=None if language == "auto" else language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=5,
        **decode,
    )
    count = 0
    untimed_count = 0
    last_start = -1
    for segment in segments:
        start = float(segment.start)
        end = float(segment.end)
        if (
            not math.isfinite(start)
            or not math.isfinite(end)
            or start < 0
            or (end <= start)
            or (start < last_start)
        ):
            raise ValueError("Invalid segment timing")
        last_start = start
        s = min(duration_ms, round(start * 1000))
        e = min(duration_ms, round(end * 1000))
        if e <= s:
            raise ValueError("Segment lies outside source duration")
        (words, untimed, leading) = normalize_batch(segment.words or [], duration_ms)
        untimed_count += untimed
        emit(
            {
                "type": "segment",
                "index": count,
                "language": str(info.language),
                "text": str(segment.text),
                "startMs": int(s),
                "endMs": int(e),
                "words": words,
                "processedMs": int(e),
                "untimedWordCount": untimed,
                "leadingUntimedText": leading,
            }
        )
        count += 1
    emit(
        {
            "type": "complete",
            "language": str(info.language),
            "segmentCount": count,
            "untimedWordCount": untimed_count,
            **ready,
        }
    )


def main():
    try:
        line = sys.stdin.buffer.readline(65537)
        if len(line) > 65536:
            raise ValueError("Worker request exceeds byte limit")
        request = json.loads(line)
        if request.get("mode") == "check":
            emit(
                {
                    "type": "ready",
                    **preflight(request.get("vadResource")),
                }
            )
        elif request.get("mode") == "transcribe":
            transcribe(request)
        else:
            raise ValueError("Unsupported worker mode")
    except Exception as error:
        message = str(error)
        request_values = locals().get("request", {})
        for value in (
            request_values.values() if isinstance(request_values, dict) else []
        ):
            if isinstance(value, str) and value.startswith("/"):
                message = message.replace(value, "[local resource]")
        emit({"type": "error", "message": message, "errorType": type(error).__name__})
        sys.exit(1)


if __name__ == "__main__":
    main()
