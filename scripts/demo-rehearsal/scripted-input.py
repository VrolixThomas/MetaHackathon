"""Explicit test bootstrap: scripted ASR and optional synthetic PCM TTS; real RTC/Pipecat."""
import asyncio
import hashlib
import json
import math
import struct
from pathlib import Path
import runpy
import sys
import time
import uuid
import wave

ROOT = Path(__file__).resolve().parent
SOURCE = Path(sys.argv[1]).resolve()
sys.path.insert(0, str(SOURCE.parent))
import voice_sidecar.session as session


def record(value):
    with (ROOT / "speech.jsonl").open("a", encoding="utf8") as target:
        target.write(json.dumps({"at": time.time() * 1000, **value}) + "\n")


class ScriptedInput:
    def __init__(self, config, identity, keywords, emit):
        self.identity, self.emit = identity, emit
        self.ended = False

    async def open(self):
        pass  # No ASR socket, credential or transcription request.

    def feed(self, pcm):
        pass  # Only a synthetic local stream reaches this test session.

    async def finish(self):
        if self.ended:
            return
        self.ended = True
        item = json.loads((ROOT / "input.json").read_text())
        if not isinstance(item["text"], str) or not 0 < len(item["text"]) <= 32000:
            raise ValueError("Invalid scripted utterance")
        record({"kind": "scripted-text-accepted", "id": item["id"], **self.identity.identity()})
        self.emit("transcript", text=item["text"], final=True)

    async def close(self):
        self.ended = True


original_tts = session.eleven_pcm
MOCK_TTS = (ROOT / "mock-tts.enabled").exists()


async def mock_tts(http, config, text):
    # Test-only tone, never a claimed spoken rendition or live provider measurement.
    await asyncio.sleep(0.08)
    frames = max(100, min(800, len(text.split()) * 12))
    for frame in range(frames):
        chunk = b"".join(struct.pack("<h", int(1800 * math.sin(2 * math.pi * 330 * (frame * 240 + i) / 24000))) for i in range(240))
        yield chunk
        await asyncio.sleep(0.01)



async def capture_tts(http, config, text):
    audio = ROOT / "audio"
    audio.mkdir(exist_ok=True)
    file = audio / (str(uuid.uuid4()) + ".pcm")
    digest = hashlib.sha256(text.encode()).hexdigest()
    prefix = "mock-tts" if MOCK_TTS else "live-tts"
    record({"kind": prefix + "-start", "textDigest": digest, "path": str(file), "chars": len(text)})
    count = 0
    with file.open("wb") as target:
        try:
            async for chunk in (mock_tts if MOCK_TTS else original_tts)(http, config, text):
                if count == 0:
                    record({"kind": prefix + "-first-pcm", "textDigest": digest, "path": str(file)})
                target.write(chunk)
                count += len(chunk)
                yield chunk
        except Exception as error:
            record({"kind": prefix + "-error", "diagnostic": session.classify(error, "elevenlabs").diagnostic})
            raise
    wav = file.with_suffix(".wav")
    with wave.open(str(wav), "wb") as target:
        target.setnchannels(1)
        target.setsampwidth(2)
        target.setframerate(24000)
        target.writeframes(file.read_bytes())
    record({"kind": prefix + "-ended", "textDigest": digest, "path": str(file), "wav": str(wav), "bytes": count})


session.MetaStream = ScriptedInput
session.eleven_pcm = capture_tts
sys.argv = sys.argv[1:]
runpy.run_path(str(SOURCE), run_name="__main__")
