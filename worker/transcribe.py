"""Offline JSONL worker. Reads bounded windows of predecoded 16 kHz mono PCM."""

import os

# Must precede any ONNX Runtime import; API-only disablement still initializes telemetry storage.
os.environ["ORT_DISABLE_TELEMETRY"] = "1"
os.environ["HF_HUB_OFFLINE"] = "1"
os.environ["TRANSFORMERS_OFFLINE"] = "1"

import sys
import json
import math
import hashlib
import stat
from pathlib import Path
from types import SimpleNamespace

MAX_TRANSCRIPTION_MS = 21600000
AUDIO_CHUNK_MS = 300000
AUDIO_OVERLAP_MS = 2000
PCM_RATE = 16000


class PCMSource:
    def __init__(self, request):
        duration = request["durationMs"]
        if type(duration) is not int or not 1 <= duration <= MAX_TRANSCRIPTION_MS:
            raise ValueError("Local transcription supports sources up to six hours. Split this source first; time-based editing remains available.")
        self.file = self.wav = None
        try:
            self.file = os.fdopen(os.open(request["audioPath"], os.O_RDONLY | os.O_NOFOLLOW), "rb")
            size = os.fstat(self.file.fileno())
            maximum = math.ceil((duration + AUDIO_OVERLAP_MS) * PCM_RATE / 1000)
            if not stat.S_ISREG(size.st_mode) or size.st_size > maximum * 2 + 65536:
                raise ValueError("PCM audio exceeds supported duration")
            audio_format = request.get("audioFormat", "wav")
            if audio_format == "s16le":
                if size.st_size % 2:
                    raise ValueError("Decoded audio is incomplete")
                self.frames = size.st_size // 2
            elif audio_format == "wav":
                import wave
                self.wav = wave.open(self.file, "rb")
                if (self.wav.getnchannels() != 1 or self.wav.getframerate() != PCM_RATE
                    or self.wav.getsampwidth() != 2 or self.wav.getcomptype() != "NONE"):
                    raise ValueError("Worker input must be predecoded mono 16k signed-16 PCM")
                self.frames = self.wav.getnframes()
            else:
                raise ValueError("Unsupported PCM format")
            if not 0 < self.frames <= maximum:
                raise ValueError("PCM audio exceeds supported duration")
        except BaseException:
            self.close()
            raise

    def read_window(self, start, end):
        import numpy as np
        maximum = (AUDIO_CHUNK_MS + 2 * AUDIO_OVERLAP_MS) * PCM_RATE // 1000
        if (type(start) is not int or type(end) is not int or
            not 0 <= start < end <= self.frames or end - start > maximum):
            raise ValueError("Invalid bounded PCM window")
        if self.wav:
            self.wav.setpos(start)
            payload = self.wav.readframes(end - start)
        else:
            self.file.seek(start * 2)
            payload = self.file.read((end - start) * 2)
        if len(payload) != (end - start) * 2:
            raise ValueError("Decoded audio is incomplete")
        audio = np.frombuffer(payload, dtype="<i2").astype(np.float32)
        audio /= 32768.0
        return audio

    def close(self):
        if self.wav:
            self.wav.close()
        if self.file:
            self.file.close()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.close()

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
    prompt = (
        "请使用简体中文转写。" if language == "zh"
        else "Hello, welcome. We use normal punctuation, with commas and full stops."
        if language == "en" else ""
    )
    # faster-whisper adds hotwords to the decoder prompt itself. Including them
    # again in initial_prompt wastes context, especially for Chinese names.
    if sum(len(tokenizer.encode(" " + value, add_special_tokens=False).ids)
           for value in (prompt, vocabulary) if value) > 128:
        raise ValueError(
            "Vocabulary is too long for this model. Keep only the most important names and terms."
        )
    return {
        "initial_prompt": prompt or None,
        "hotwords": vocabulary or None,
        # Generated text from an earlier window can reinforce repetition loops.
        # Keep the explicit prompt/hotwords, but reset recognition history.
        "condition_on_previous_text": False,
    }


def validate_options(request):
    from tokenizers import Tokenizer

    language = request.get("language", "auto")
    if language not in ("auto", "en", "zh"):
        raise ValueError("Unsupported recognition language")
    tokenizer = Tokenizer.from_file(str(Path(request["modelDirectory"]) / "tokenizer.json"))
    # Auto detection happens after decoding. Check both supported prompts now;
    # other detected languages have no longer language-specific prompt.
    for candidate in ("en", "zh") if language == "auto" else (language,):
        decode_options(candidate, request.get("vocabulary", ""), tokenizer)
    emit({"type": "options-validated"})


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
    # Check source/decoded size before model hashing, imports or waveform allocation.
    with PCMSource(request) as audio:
        return transcribe_chunks(request, audio)


class SeamBuffer:
    """Hold the two-second edge until the adjacent window has been recognized.
    Publication remains globally ordered without changing any measured word time.
    """
    def __init__(self, publish):
        self.publish = publish
        self.pending = []
        self.sequence = 0
        self.last_word_start = -1
        self.published = set()

    def flush(self, packets, safe_start):
        for packet in packets:
            for word in packet["words"] or [None]:
                start = word["startMs"] if word is not None else packet["startMs"]
                self.pending.append((start, self.sequence, packet, word))
                self.sequence += 1
        self.pending.sort(key=lambda item: (item[0], item[1]))
        ready = [item for item in self.pending if item[0] < safe_start]
        self.pending = [item for item in self.pending if item[0] >= safe_start]
        index = 0
        while index < len(ready):
            _, _, packet, word = ready[index]
            group = []
            while index < len(ready) and ready[index][2] is packet and (ready[index][3] is None) == (word is None):
                if ready[index][3] is not None:
                    group.append(ready[index][3])
                index += 1
            event = dict(packet)
            key = id(packet)
            first_publication = key not in self.published
            self.published.add(key)
            event["untimedWordCount"] = packet["untimedWordCount"] if first_publication else 0
            if group:
                if group[0]["startMs"] < self.last_word_start:
                    raise ValueError("Invalid word timing across audio windows")
                for item in group:
                    if item["startMs"] < self.last_word_start:
                        raise ValueError("Invalid word timing across audio windows")
                    self.last_word_start = item["startMs"]
                event["words"] = group
                event["startMs"] = group[0]["startMs"]
                event["endMs"] = max(item["endMs"] for item in group)
                event["leadingUntimedText"] = packet["leadingUntimedText"] if group[0] is packet["words"][0] else ""
                if len(group) != len(packet["words"]):
                    event["text"] = event["leadingUntimedText"] + "".join(item["text"] for item in group)
            self.publish(event)
        # Retain only identities still pending; packet objects cannot be reused
        # as Python ids while they are held by pending rows.
        held = {id(item[2]) for item in self.pending}
        self.published.intersection_update(held)


def transcribe_chunks(request, source):
    identity = check_model(
        request["modelDirectory"], request.get("modelChoice", "small")
    )
    ready = preflight(request.get("vadResource"))
    import numpy as np
    from faster_whisper import WhisperModel
    from tokenizers import Tokenizer

    duration_ms = request["durationMs"]
    language = request["language"]
    if language not in ("auto", "en", "zh"):
        raise ValueError("Unsupported language")
    model = WhisperModel(
        request["modelDirectory"],
        device="cpu",
        compute_type="int8",
        local_files_only=True,
        cpu_threads=4,
    )
    tokenizer = Tokenizer.from_file(str(Path(request["modelDirectory"]) / "tokenizer.json"))
    ready_base = {
        **ready,
        **identity,
        "conditionOnPreviousText": False,
        "wordTimingReview": True,
    }
    effective_language = None if language == "auto" else language
    announced = False
    decode = None
    count = 0
    untimed_count = 0
    processed_ms = 0
    chunk_frames = AUDIO_CHUNK_MS * PCM_RATE // 1000
    overlap_frames = AUDIO_OVERLAP_MS * PCM_RATE // 1000
    def publish(packet):
        nonlocal count, untimed_count, processed_ms
        untimed_count += packet["untimedWordCount"]
        processed_ms = max(processed_ms, packet["endMs"])
        emit({**packet, "index": count, "processedMs": processed_ms})
        count += 1
    seam = SeamBuffer(publish) if source.frames > chunk_frames else None
    for core_start in range(0, source.frames, chunk_frames):
        core_end = min(source.frames, core_start + chunk_frames)
        window_start = max(0, core_start - overlap_frames)
        window_end = min(source.frames, core_end + overlap_frames)
        audio = source.read_window(window_start, window_end)
        offset = window_start / PCM_RATE
        if effective_language is None:
            from faster_whisper.vad import get_speech_timestamps, collect_chunks
            speech = get_speech_timestamps(audio)
            # Find the first speech-bearing window, including sources with a
            # long silent introduction. Never detect language on an empty array.
            if not speech:
                processed_ms = max(processed_ms, min(duration_ms, core_end * 1000 // PCM_RATE))
                emit({"type": "progress", "processedMs": processed_ms})
                continue
            detection_speech, remaining = [], PCM_RATE * 30
            for span in speech:
                end = min(span["end"], span["start"] + remaining)
                detection_speech.append({"start": span["start"], "end": end})
                remaining -= end - span["start"]
                if remaining == 0:
                    break
            chunks, _ = collect_chunks(audio, detection_speech)
            effective_language = model.detect_language(audio=np.concatenate(chunks))[0]
            del chunks
        if decode is None:
            decode = decode_options(effective_language, request.get("vocabulary", ""), tokenizer)
        if not announced:
            emit({"type": "ready", **ready_base, "simplifiedChinese": effective_language == "zh"})
            announced = True
        segments, info = model.transcribe(audio, language=effective_language,
            word_timestamps=True, vad_filter=True, beam_size=5, **decode)
        lower, upper = core_start * 1000 / PCM_RATE, core_end * 1000 / PCM_RATE
        owned = []
        last_start = -1
        for segment in segments:
            local_start, local_end = float(segment.start), float(segment.end)
            if (not math.isfinite(local_start) or not math.isfinite(local_end)
                or local_start < 0 or local_end <= local_start or local_start < last_start):
                raise ValueError("Invalid segment timing")
            last_start = local_start
            start, end = local_start + offset, local_end + offset
            shifted = [SimpleNamespace(word=word.word, start=float(word.start) + offset,
                end=float(word.end) + offset) for word in segment.words or []]
            words, untimed, leading = normalize_batch(shifted, duration_ms)
            selected = [word for word in words if lower <= (word["startMs"] + word["endMs"]) / 2 < upper]
            clipped = len(selected) != len(words)
            if words and not selected:
                continue
            if not words and not lower <= (start + end) * 500 < upper:
                continue
            if clipped:
                # Overlap supplies recognition context. Each measured word is
                # emitted by the core containing its midpoint, without retiming.
                if selected[0] is not words[0]:
                    leading = ""
                words = selected
                start, end = words[0]["startMs"] / 1000, words[-1]["endMs"] / 1000
                segment_text = leading + "".join(word["text"] for word in words)
            else:
                segment_text = str(segment.text)
            for word in words:
                if ((core_start and abs((word["startMs"] + word["endMs"]) / 2 - lower) <= 500)
                    or (core_start and word["startMs"] < lower < word["endMs"])
                    or (core_end < source.frames and (abs((word["startMs"] + word["endMs"]) / 2 - upper) <= 500
                        or word["startMs"] < upper < word["endMs"]))):
                    word["timingNeedsReview"] = True
            s, e = min(duration_ms, round(start * 1000)), min(duration_ms, round(end * 1000))
            if e <= s:
                raise ValueError("Segment lies outside source duration")
            packet = {"type": "segment", "language": str(info.language),
                "text": segment_text, "startMs": s, "endMs": e, "words": words,
                "untimedWordCount": untimed, "leadingUntimedText": leading}
            if seam:
                owned.append(packet)
            else:
                publish(packet)
        if seam:
            # A later window cannot have a valid local anchor before its input
            # begins. Keep that entire edge, then sort it with the next core.
            safe_start = float("inf") if core_end == source.frames else upper - AUDIO_OVERLAP_MS
            seam.flush(owned, safe_start)
        del segments, audio
        processed_ms = max(processed_ms, min(duration_ms, core_end * 1000 // PCM_RATE))
        emit({"type": "progress", "processedMs": processed_ms})
    effective_language = effective_language or "en"
    ready = {**ready_base, "simplifiedChinese": effective_language == "zh"}
    if not announced:
        emit({"type": "ready", **ready})
    emit(
        {
            "type": "complete",
            "language": effective_language,
            "segmentCount": count,
            "untimedWordCount": untimed_count,
            **ready,
        }
    )


def main():
    try:
        line = sys.stdin.buffer.readline(64 * 1024 * 1024 + 1)
        if len(line) > 64 * 1024 * 1024:
            raise ValueError("Worker request exceeds byte limit")
        request = json.loads(line)
        if request.get("mode") != "punctuate" and len(line) > 65536:
            raise ValueError("Worker request exceeds byte limit")
        if request.get("mode") == "check":
            emit(
                {
                    "type": "ready",
                    **preflight(request.get("vadResource")),
                }
            )
        elif request.get("mode") == "transcribe":
            transcribe(request)
        elif request.get("mode") == "validate-options":
            validate_options(request)
        elif request.get("mode") == "punctuate":
            from punctuation import Restorer

            restorer = Restorer(request["punctuationDirectory"])
            fragments = restorer.restore(request["fragments"])
            # Keep each JSONL packet bounded even when a word contains folded
            # untimed text. Main validates contiguous offsets before committing.
            start, batch, batch_bytes = 0, [], 0
            for fragment in fragments:
                size = len(fragment.encode("utf-8")) + 16
                if batch and batch_bytes + size > 128 * 1024:
                    emit({"type": "punctuation", "start": start, "fragments": batch})
                    start += len(batch)
                    batch, batch_bytes = [], 0
                batch.append(fragment)
                batch_bytes += size
            if batch:
                emit({"type": "punctuation", "start": start, "fragments": batch})
            emit({"type": "complete", "fragmentCount": len(fragments), "model": restorer.identity})
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
