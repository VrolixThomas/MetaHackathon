"""One fresh Pipecat pipeline and WebRTC peer per generation."""

import asyncio
import json
import time
from collections import deque
from dataclasses import dataclass, field

import aiohttp
from fastapi import HTTPException
from pipecat.frames.frames import (
    ControlFrame, InputAudioRawFrame, InputTransportMessageFrame,
    TTSAudioRawFrame, TTSStartedFrame, TTSStoppedFrame,
)
from pipecat.pipeline.pipeline import Pipeline
from pipecat.pipeline.worker import PipelineParams, PipelineWorker
from pipecat.processors.frame_processor import FrameProcessor
from pipecat.transports.base_transport import TransportParams
from pipecat.transports.smallwebrtc.connection import SmallWebRTCConnection
from pipecat.transports.smallwebrtc.transport import SmallWebRTCTransport
from pipecat.workers.runner import WorkerRunner

from .protocol import Answer, Identity, PollResult
from .providers import MetaStream, ProviderError, RATE, eleven_pcm, tls_context

CAPTURE_SECONDS = 60
SESSION_SECONDS = 300
RTP_DRAIN_SECONDS = 0.2
MAX_EVENTS = 512
MAX_EVENT_BYTES = 262144
MAX_SPEECH = 32
MAX_SESSIONS = 4
MAX_IDENTITIES = 256


@dataclass
class Fence(ControlFrame):
    """FIFO marker observed after the output transport consumes preceding PCM."""
    done: asyncio.Event = field(default_factory=asyncio.Event)
    kind: str | None = None
    speech_id: str | None = None


class InputGate(FrameProcessor):
    def __init__(self, session):
        super().__init__()
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, InputAudioRawFrame):
            s = self.session
            if s.active and s.capturing and time.monotonic() <= s.capture_deadline:
                try:
                    if frame.sample_rate != RATE or frame.num_channels != 1:
                        raise ProviderError("Expected mono PCM at 24000 Hz")
                    s.audio_bytes += len(frame.audio)
                    if s.audio_bytes > RATE * 2 * CAPTURE_SECONDS:
                        raise ProviderError("Maximum capture duration reached")
                    s.meta.feed(frame.audio)
                except ProviderError as error:
                    s.fail(str(error))
            return
        if isinstance(frame, InputTransportMessageFrame):
            return  # Signalling stays in SmallWebRTC; application commands use authenticated HTTP.
        await self.push_frame(frame, direction)


class EventSink(FrameProcessor):
    def __init__(self, session):
        super().__init__()
        self.session = session

    async def process_frame(self, frame, direction):
        await super().process_frame(frame, direction)
        if isinstance(frame, Fence):
            if frame.kind:
                self.session.emit(frame.kind, speechId=frame.speech_id)
            frame.done.set()
        await self.push_frame(frame, direction)


class Session:
    def __init__(self, offer, config):
        self.identity = Identity(**offer.identity())
        self.offer, self.config = offer, config
        self.active = True
        self.capturing = True
        self.created = time.monotonic()
        self.capture_deadline = self.created + CAPTURE_SECONDS
        self.audio_bytes = 0
        self.sequence = 0
        self.events = deque()
        self.event_bytes = 0
        self.speech = asyncio.Queue(maxsize=MAX_SPEECH)
        self.speech_ids = {}  # Bounded per-generation duplicate suppression.
        self.tasks = set()
        self.start_task = None
        self.stop_task = None
        self.release_task = None
        self.run_task = None
        self.worker = None
        self.peer = None
        self.http = None
        self.connected = asyncio.Event()
        self.ready = asyncio.Event()
        self.meta = MetaStream(config, self.identity, offer.keywords, self.provider_event)

    def spawn(self, coroutine):
        task = asyncio.create_task(coroutine)
        self.tasks.add(task)
        task.add_done_callback(self.tasks.discard)
        return task

    def emit(self, kind, **payload):
        if not self.active:
            return
        self.sequence += 1
        event = {**self.identity.identity(), "sequence": self.sequence, "kind": kind, **payload}
        self.events.append(event)
        self.event_bytes += len(json.dumps(event).encode())
        while len(self.events) > MAX_EVENTS or self.event_bytes > MAX_EVENT_BYTES:
            self.event_bytes -= len(json.dumps(self.events.popleft()).encode())

    def provider_event(self, kind, **payload):
        if kind == "error":
            self.fail(payload["message"])
        else:
            self.emit(kind, **payload)

    def fail(self, message):
        if self.active:
            self.emit("error", message=message[:500])
            self.invalidate(clear_events=False)
            self.ensure_stop()

    def invalidate(self, *, clear_events=True):
        # No await before invalidation. Every asynchronous producer checks this gate.
        self.active = self.capturing = False
        if clear_events:
            self.events.clear()
            self.event_bytes = 0

    def ensure_stop(self):
        if self.stop_task is None:
            self.stop_task = asyncio.create_task(self._stop(), name="voice-teardown")
        return self.stop_task

    async def start(self):
        self.start_task = asyncio.current_task()
        if not self.active:
            raise HTTPException(409, "Generation cancelled")
        self.peer = SmallWebRTCConnection(ice_servers=[], connection_timeout_secs=15)
        transport = SmallWebRTCTransport(self.peer, TransportParams(
            audio_in_enabled=True, audio_out_enabled=True,
            audio_in_sample_rate=RATE, audio_out_sample_rate=RATE,
            audio_in_channels=1, audio_out_channels=1, audio_out_10ms_chunks=4,
            audio_out_end_silence_secs=0,
        ))
        self.gate = InputGate(self)
        self.worker = PipelineWorker(
            Pipeline([transport.input(), self.gate, transport.output(), EventSink(self)]),
            params=PipelineParams(audio_in_sample_rate=RATE, audio_out_sample_rate=RATE),
            enable_rtvi=False, enable_turn_tracking=False, idle_timeout_secs=None,
            cancel_timeout_secs=2, setup_timeout_secs=10,
        )

        @self.worker.event_handler("on_pipeline_started")
        async def on_started(worker, frame):
            self.ready.set()

        @self.worker.event_handler("on_pipeline_error")
        async def on_error(worker, frame):
            self.fail("Voice pipeline failed")

        @transport.event_handler("on_client_connected")
        async def on_connected(transport, client):
            self.connected.set()

        @transport.event_handler("on_client_disconnected")
        async def on_disconnected(transport, client):
            self.fail("Voice peer disconnected")

        @self.peer.event_handler("failed")
        async def on_failed(peer):
            self.fail("Voice peer connection failed")

        self.http = aiohttp.ClientSession(
            read_bufsize=16_384, trust_env=False,
            connector=aiohttp.TCPConnector(ssl=tls_context()),
        )
        async with asyncio.timeout(12):
            await self.meta.open()
            await self.peer.initialize(self.offer.sdp, self.offer.type)
            runner = WorkerRunner(handle_sigint=False, handle_sigterm=False)
            await runner.add_workers(self.worker)
            self.run_task = asyncio.create_task(runner.run(), name="voice-pipeline")
            await self.ready.wait()
        if not self.active:
            raise HTTPException(409, "Generation cancelled")
        self.spawn(self._speak_loop())
        self.spawn(self._watch_capture())
        self.spawn(self._watch_session())
        self.start_task = None
        answer = self.peer.get_answer()
        return Answer(sdp=answer["sdp"], type=answer["type"])

    async def _watch_capture(self):
        await asyncio.sleep(max(0, self.capture_deadline - time.monotonic()))
        if self.active and self.capturing:
            self.fail("Maximum capture duration reached")

    async def _watch_session(self):
        await asyncio.sleep(max(0, self.created + SESSION_SECONDS - time.monotonic()))
        self.fail("Voice generation expired")

    def release(self):
        if self.release_task is None and self.capturing:
            # Let already-in-flight RTP arrive, with a fixed wall-clock boundary.
            self.capture_deadline = min(self.capture_deadline, time.monotonic() + RTP_DRAIN_SECONDS)
            self.release_task = self.spawn(self._release())

    async def _release(self):
        try:
            await asyncio.sleep(max(0, self.capture_deadline - time.monotonic()))
            self.capturing = False
            if self.active:
                await self.meta.finish()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.fail("Meta STT did not finish after release")

    def enqueue(self, speech):
        prior = self.speech_ids.get(speech.speechId)
        if prior is not None:
            if prior != speech.text:
                raise HTTPException(409, "Speech ID already has different text")
            return
        if len(self.speech_ids) >= 256 or self.speech.full():
            raise HTTPException(429, "Speech queue limit reached")
        self.speech_ids[speech.speechId] = speech.text
        self.speech.put_nowait(speech)

    async def fence(self, kind=None, speech_id=None):
        marker = Fence(kind=kind, speech_id=speech_id)
        await self.gate.push_frame(marker)
        await asyncio.wait_for(marker.done.wait(), 5)

    async def _speak_loop(self):
        try:
            while self.active:
                speech = await self.speech.get()
                try:
                    await asyncio.wait_for(self.connected.wait(), 15)
                    # One synthesis request at a time. Chunk fences bound Pipecat's
                    # otherwise-unbounded internal output queues to ~40ms PCM.
                    async with asyncio.timeout(125):
                        first = True
                        async for pcm in eleven_pcm(self.http, self.config, speech.text):
                            if not self.active:
                                return
                            if first:
                                await self.gate.push_frame(TTSStartedFrame())
                                await self.fence("speech-started", speech.speechId)
                                first = False
                            await self.gate.push_frame(TTSAudioRawFrame(pcm, RATE, 1))
                            await self.fence()
                        await self.gate.push_frame(TTSStoppedFrame())
                        await self.fence("speech-ended", speech.speechId)
                finally:
                    self.speech.task_done()
        except asyncio.CancelledError:
            raise
        except Exception:
            self.fail("Speech synthesis or transport failed")

    def poll(self, after):
        if self.events and after < self.events[0]["sequence"] - 1:
            raise HTTPException(409, "Voice event cursor expired; cancel this generation")
        return PollResult(events=[e for e in self.events if e["sequence"] > after][:100])

    async def cancel(self):
        self.invalidate()
        await asyncio.shield(self.ensure_stop())

    async def _stop(self):
        # Teardown runs independently of cancelled request/producer tasks.
        tasks = list(self.tasks)
        if self.start_task and not self.start_task.done():
            tasks.append(self.start_task)
        for task in tasks:
            task.cancel()
        # Independently close every resource even if another close fails. Closing
        # the peer starts immediately, before any wait for provider/pipeline work.
        closers = [asyncio.create_task(self.meta.close())]
        if self.peer:
            closers.append(asyncio.create_task(self.peer.disconnect()))
        if self.http:
            closers.append(asyncio.create_task(self.http.close()))
        if self.worker and self.run_task:
            closers.append(asyncio.create_task(self.worker.cancel()))
            tasks.append(self.run_task)
        pending_work = tasks + closers
        if pending_work:
            done, pending = await asyncio.wait(pending_work, timeout=5)
            for task in pending:
                task.cancel()
            if pending:
                more_done, pending = await asyncio.wait(pending, timeout=1)
                done |= more_done
            for task in done:
                if not task.cancelled():
                    task.exception()  # Retrieve failures; never log provider bodies.
            for task in pending:
                task.add_done_callback(lambda t: None if t.cancelled() else t.exception())
        while not self.speech.empty():
            self.speech.get_nowait()
            self.speech.task_done()
        self.speech_ids.clear()

    def occupies_slot(self):
        return self.active or bool(self.stop_task and not self.stop_task.done())


class Manager:
    def __init__(self, config, session_factory=Session):
        self.config, self.session_factory = config, session_factory
        self.sessions = {}
        self.retiring = set()
        self.highwater = {}  # Never evict: prevents stale generation resurrection.
        self.turns = {}
        self.lock = asyncio.Lock()

    async def offer(self, offer):
        async with self.lock:
            previous = self.highwater.get(offer.sessionId, -1)
            if offer.generation <= previous:
                raise HTTPException(409, "Stale or duplicate generation")
            if offer.sessionId not in self.highwater and len(self.highwater) >= MAX_IDENTITIES:
                raise HTTPException(429, "Session identity limit reached; restart sidecar")
            old = self.sessions.get(offer.sessionId)
            owned = set(self.sessions.values()) | self.retiring
            if sum(s.occupies_slot() for s in owned) - bool(old and old.occupies_slot()) >= MAX_SESSIONS:
                raise HTTPException(429, "Concurrent session limit reached")
            if old:
                old.invalidate()
                self.retiring.add(old)
                old.ensure_stop().add_done_callback(lambda task: self.retiring.discard(old))
            self.highwater[offer.sessionId] = offer.generation
            self.turns[offer.sessionId] = offer.turnId
            session = self.session_factory(offer, self.config)
            self.sessions[offer.sessionId] = session
        try:
            if old:
                await old.cancel()
            return await session.start()
        except BaseException as error:
            # Do not make teardown wait for this very request.
            session.start_task = None
            session.invalidate()
            # Teardown may itself have cancelled this setup request. Do not
            # await it here (it is waiting for the request to unwind).
            session.ensure_stop()
            if isinstance(error, HTTPException):
                raise
            if isinstance(error, asyncio.CancelledError):
                raise HTTPException(409, "Generation cancelled") from None
            raise HTTPException(502, "Voice provider or peer setup failed") from None

    def get(self, identity, *, require_active=True):
        session = self.sessions.get(identity.sessionId)
        if not session or session.identity.identity() != identity.identity():
            raise HTTPException(409, "Unknown or stale voice generation")
        if require_active and not session.active:
            raise HTTPException(409, "Voice generation is closed")
        return session

    async def cancel(self, identity):
        async with self.lock:
            previous = self.highwater.get(identity.sessionId, -1)
            if identity.sessionId not in self.highwater and len(self.highwater) >= MAX_IDENTITIES:
                raise HTTPException(429, "Session identity limit reached; restart sidecar")
            if identity.generation < previous:
                return  # Idempotent old cancel must never affect the new generation.
            session = self.sessions.get(identity.sessionId)
            if identity.generation == previous and self.turns.get(identity.sessionId, identity.turnId) != identity.turnId:
                raise HTTPException(409, "Turn identity does not match generation")
            self.highwater[identity.sessionId] = identity.generation
            self.turns[identity.sessionId] = identity.turnId
            if session:
                session.invalidate()
        if session:
            await session.cancel()

    async def close(self):
        await asyncio.gather(*(s.cancel() for s in set(self.sessions.values()) | self.retiring))
