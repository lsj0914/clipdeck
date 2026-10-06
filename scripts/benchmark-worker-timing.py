"""Optional benchmark observer; runs the unchanged production worker and real model.

This is diagnostic instrumentation, not the authoritative throughput run.
No worker function, model class, parameter, request or emitted response is replaced.
"""

import json
import os
from pathlib import Path
import runpy
import sys
import time
import wave

worker = Path(os.environ["CLIPDECK_BENCHMARK_WORKER"]).resolve()
destination = Path(os.environ["CLIPDECK_BENCHMARK_TIMING"])
started = time.perf_counter_ns()
spans = {}
events = []
active = {}
audio = None


def observe(frame, event, arg):
    global audio
    filename = frame.f_code.co_filename
    name = frame.f_code.co_name
    phase = None
    if filename == str(worker):
        if name in ("check_model", "preflight"):
            phase = name
        if event == "call" and name == "transcribe":
            request = frame.f_locals["request"]
            with wave.open(request["audioPath"], "rb") as wav:
                audio = {
                    "sampleRate": wav.getframerate(),
                    "samples": wav.getnframes(),
                    "channels": wav.getnchannels(),
                    "durationSeconds": wav.getnframes() / wav.getframerate(),
                }
        if event == "call" and name == "emit":
            payload = frame.f_locals["event"]
            events.append({"atMs": (time.perf_counter_ns() - started) / 1e6, "event": payload})
    if (
        filename.endswith("/faster_whisper/transcribe.py")
        and name == "__init__"
        and type(frame.f_locals.get("self")).__name__ == "WhisperModel"
    ):
        phase = "model_constructor"
    if phase and event == "call":
        active[id(frame)] = (phase, time.perf_counter_ns())
    elif phase and event == "return":
        current = active.pop(id(frame), None)
        if current:
            spans[current[0]] = {
                "startMs": (current[1] - started) / 1e6,
                "endMs": (time.perf_counter_ns() - started) / 1e6,
            }


try:
    sys.setprofile(observe)
    runpy.run_path(str(worker), run_name="__main__")
finally:
    sys.setprofile(None)
    destination.parent.mkdir(parents=True, exist_ok=True)
    destination.write_text(json.dumps({
        "method": "sys.setprofile observation only; unchanged worker/model/runtime/requests; instrumentation overhead included",
        "elapsedMs": (time.perf_counter_ns() - started) / 1e6,
        "spans": spans,
        "events": events,
        "audio": audio,
    }, ensure_ascii=False, indent=2) + "\n")
