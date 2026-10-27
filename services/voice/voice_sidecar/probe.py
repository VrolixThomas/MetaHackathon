"""Executable import, PCM, peer and running-pipeline probe; no credentials/network."""

import asyncio
import platform
import sys

import numpy as np
from av import AudioFrame, AudioResampler
from pipecat.frames.frames import EndFrame, StartFrame
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.services.elevenlabs.tts import ElevenLabsHttpTTSService
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from .providers import tls_context


async def self_test():
    frame = AudioFrame.from_ndarray(np.full((1, 1920), 1234, dtype=np.int16), format="s16", layout="stereo")
    frame.sample_rate = 48000
    resampler = AudioResampler(format="s16", layout="mono", rate=24000)
    result = resampler.resample(frame) + resampler.resample(None)
    pcm = b"".join(f.to_ndarray().astype("<i2").tobytes() for f in result)
    assert len(pcm) == 960 and any(pcm)

    class Probe(FrameProcessor):
        def __init__(self):
            super().__init__()
            self.started = False

        async def process_frame(self, frame, direction):
            await super().process_frame(frame, direction)
            if isinstance(frame, StartFrame):
                self.started = True
            await self.push_frame(frame, direction)

    probe = Probe()
    worker = PipelineWorker(
        Pipeline([probe]), params=PipelineParams(audio_in_sample_rate=24000),
        enable_rtvi=False, enable_turn_tracking=False, idle_timeout_secs=None,
    )
    runner = WorkerRunner(handle_sigint=False)
    await worker.queue_frame(EndFrame())
    await runner.add_workers(worker)
    await asyncio.wait_for(runner.run(), 10)
    assert probe.started
    peer = SmallWebRTCConnection(ice_servers=[])
    await peer.disconnect()
    assert SmallWebRTCTransport and ElevenLabsHttpTTSService
    assert tls_context().check_hostname
    return {"ok": True, "python": platform.python_version(), "arch": platform.machine(),
            "frozen": bool(getattr(sys, "frozen", False)), "pcmBytes": len(pcm),
            "pipecat": "1.14.0", "capabilities": ["smallwebrtc", "pipeline", "pcm24k", "elevenlabs", "system-tls"]}
