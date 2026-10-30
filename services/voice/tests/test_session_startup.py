"""Deterministic startup barriers; no network, providers, microphone or native app."""

import asyncio
import sys
import unittest
from pathlib import Path
from unittest.mock import AsyncMock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from fastapi import HTTPException
from pipecat.frames.frames import InputAudioRawFrame
from pipecat.processors.frame_processor import FrameDirection, FrameProcessor

from voice_sidecar.protocol import Identity, Offer
from voice_sidecar.providers import Config, ProviderError, RATE
from voice_sidecar.session import Manager

IDENTITY = {"sessionId": "startup", "turnId": "turn-one", "generation": 1}


class Barrier:
    def __init__(self):
        self.entered = asyncio.Event()
        self.release = asyncio.Event()
        self.finished = asyncio.Event()
        self.cancelled = asyncio.Event()
        self.ignore_cancel = False
        self.error = None

    async def wait(self):
        self.entered.set()
        while not self.release.is_set():
            try:
                await self.release.wait()
            except asyncio.CancelledError:
                self.cancelled.set()
                if not self.ignore_cancel:
                    raise
        if self.error:
            raise self.error


class Events:
    def __init__(self):
        self.handlers = {}

    def event_handler(self, name):
        def register(callback):
            self.handlers[name] = callback
            return callback
        return register


class Meta:
    def __init__(self):
        self.barrier = Barrier()
        self.opened = False
        self.close_calls = 0
        self.close_error = None
        self.closed = asyncio.Event()
        self.pcm = []

    async def open(self):
        await self.barrier.wait()
        self.opened = True
        self.closed.clear()
        self.barrier.finished.set()

    def feed(self, pcm):
        assert self.opened and not self.closed.is_set(), "PCM reached unready ASR"
        self.pcm.append(pcm)

    async def close(self):
        self.close_calls += 1
        self.opened = False
        self.closed.set()
        if self.close_error:
            raise self.close_error


class Peer(Events):
    def __init__(self):
        super().__init__()
        self.barrier = Barrier()
        self.initialized = False
        self.close_calls = 0
        self.closed = asyncio.Event()

    async def initialize(self, sdp, kind):
        assert (sdp, kind) == ("controlled-offer", "offer")
        await self.barrier.wait()
        self.initialized = True
        self.closed.clear()
        self.barrier.finished.set()

    async def disconnect(self):
        self.close_calls += 1
        self.initialized = False
        self.closed.set()

    def get_answer(self):
        assert self.initialized and not self.closed.is_set()
        return {"sdp": "controlled-answer", "type": "answer"}


class Transport(Events):
    def input(self):
        return object()

    def output(self):
        return object()


class Worker(Events):
    def __init__(self):
        super().__init__()
        self.stopped = asyncio.Event()
        self.cancel_calls = 0

    async def cancel(self):
        self.cancel_calls += 1
        self.stopped.set()


class Runner:
    def __init__(self, meta, peer, worker):
        self.meta, self.peer, self.worker = meta, peer, worker
        self.preparation = Barrier()
        self.preparation.release.set()
        self.started = asyncio.Event()

    async def add_workers(self, worker):
        assert worker is self.worker
        await self.preparation.wait()
        self.preparation.finished.set()

    async def run(self):
        assert self.meta.opened and self.peer.initialized
        self.started.set()
        await self.worker.handlers["on_pipeline_started"](self.worker, None)
        await self.worker.stopped.wait()


class StartupTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.meta, self.peer = Meta(), Peer()
        self.transport, self.worker = Transport(), Worker()
        self.runner = Runner(self.meta, self.peer, self.worker)
        self.http = type("Http", (), {"close": AsyncMock()})()
        replacements = {
            "MetaStream": self.make_meta,
            "SmallWebRTCConnection": lambda **kwargs: self.peer,
            "SmallWebRTCTransport": lambda *args: self.transport,
            "Pipeline": lambda processors: processors,
            "PipelineWorker": lambda *args, **kwargs: self.worker,
            "WorkerRunner": lambda **kwargs: self.runner,
            "aiohttp.ClientSession": lambda **kwargs: self.http,
            "aiohttp.TCPConnector": lambda **kwargs: None,
            "tls_context": lambda: None,
        }
        for target, replacement in replacements.items():
            patcher = patch(f"voice_sidecar.session.{target}", replacement)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.manager = Manager(Config("dummy", "dummy", "dummy", "dummy"))
        self.offer = Offer(**IDENTITY, type="offer", sdp="controlled-offer")
        self.opening = None

    def make_meta(self, config, identity, keywords, emit):
        self.assertEqual(identity.identity(), IDENTITY)
        self.meta.emit = emit
        return self.meta

    @property
    def session(self):
        return self.manager.sessions[IDENTITY["sessionId"]]

    async def asyncTearDown(self):
        self.meta.barrier.release.set()
        self.peer.barrier.release.set()
        self.runner.preparation.release.set()
        await asyncio.wait_for(self.manager.close(), 2)
        if self.opening:
            await asyncio.gather(self.opening, return_exceptions=True)

    async def begin(self):
        self.opening = asyncio.create_task(self.manager.offer(self.offer))
        # Both must enter while neither is released: serialization deadlocks
        # here and fails, independent of machine speed or latency thresholds.
        await asyncio.wait_for(asyncio.gather(
            self.meta.barrier.entered.wait(), self.peer.barrier.entered.wait(),
        ), 2)
        self.setup_tasks = set(self.session.tasks)
        self.assertEqual(len(self.setup_tasks), 2)

    async def result_error(self, status, detail):
        with self.assertRaises(HTTPException) as result:
            await asyncio.wait_for(asyncio.shield(self.opening), 2)
        self.assertEqual(result.exception.status_code, status)
        self.assertEqual(result.exception.detail, detail)

    async def stopped(self):
        await asyncio.wait_for(asyncio.shield(self.session.ensure_stop()), 2)
        self.assertTrue(self.meta.closed.is_set())
        self.assertTrue(self.peer.closed.is_set())
        self.http.close.assert_awaited_once()

    def expire_teardown(self):
        real_wait = asyncio.wait

        async def wait(tasks, *, timeout=None, **kwargs):
            # Advance only the two existing teardown grace waits. Startup still
            # uses an untimed wait; no real five/six-second sleeps in these tests.
            return await real_wait(tasks, timeout=0 if timeout in (5, 1) else timeout, **kwargs)

        return patch("voice_sidecar.session.asyncio.wait", wait)

    async def feed(self, pcm):
        # Exercise the actual input gate; bypass only Pipecat's unrelated
        # processor lifecycle, which the real local-peer suite covers.
        with patch.object(FrameProcessor, "process_frame", AsyncMock()):
            await self.session.gate.process_frame(
                InputAudioRawFrame(pcm, RATE, 1), FrameDirection.DOWNSTREAM,
            )

    async def test_peer_can_finish_while_meta_waits_but_pipeline_cannot_run(self):
        await self.begin()
        self.peer.barrier.release.set()
        await asyncio.wait_for(self.peer.barrier.finished.wait(), 2)
        self.assertFalse(self.runner.started.is_set())
        self.assertIsNone(self.session.run_task)
        self.assertFalse(self.opening.done())
        self.assertEqual(self.meta.pcm, [])
        self.meta.barrier.release.set()
        answer = await asyncio.wait_for(self.opening, 2)
        self.assertEqual(answer.model_dump(), {"sdp": "controlled-answer", "type": "answer"})
        self.assertTrue(self.runner.started.is_set())
        pcm = bytes(range(256)) * 4
        await self.feed(pcm)
        self.assertEqual(self.meta.pcm, [pcm])
        self.meta.emit("transcript", text="controlled", final=False)
        event = self.session.poll(0).events[0].model_dump()
        self.assertEqual({key: event[key] for key in IDENTITY}, IDENTITY)
        self.assertEqual(event["sequence"], 1)
        await self.manager.cancel(Identity(**IDENTITY))
        await self.manager.cancel(Identity(**IDENTITY))
        await self.stopped()
        self.assertTrue(self.session.run_task.done())
        self.assertEqual(self.worker.cancel_calls, 1)
        self.assertTrue(all(task.done() for task in self.setup_tasks))
        await self.feed(pcm)
        self.assertEqual(self.meta.pcm, [pcm])

    async def test_meta_can_finish_while_peer_waits(self):
        await self.begin()
        self.meta.barrier.release.set()
        await asyncio.wait_for(self.meta.barrier.finished.wait(), 2)
        self.assertEqual(self.session.start_stage, "media")
        self.assertFalse(self.runner.started.is_set())
        self.assertFalse(self.opening.done())
        self.peer.barrier.release.set()
        await asyncio.wait_for(self.opening, 2)
        self.assertTrue(self.session.ready.is_set())

    async def test_meta_failure_cancels_peer_and_keeps_original_diagnostic(self):
        await self.begin()
        diagnostic = {"stage": "meta", "code": "auth", "httpStatus": 401}
        self.meta.barrier.error = ProviderError("meta", "auth", http_status=401)
        self.meta.barrier.release.set()
        await self.result_error(502, diagnostic)
        await self.stopped()
        self.assertTrue(self.peer.barrier.cancelled.is_set())
        self.assertEqual(self.session.failure, diagnostic)
        self.assertFalse(self.runner.started.is_set())

    async def test_rtc_failure_cancels_meta_and_is_not_misclassified_as_meta(self):
        await self.begin()
        self.peer.barrier.error = OSError("private-rtc-error")
        self.peer.barrier.release.set()
        await self.result_error(502, {"stage": "media", "code": "network"})
        await self.stopped()
        self.assertTrue(self.meta.barrier.cancelled.is_set())
        self.assertNotIn("private", str(list(self.session.events)))
        self.assertFalse(self.runner.started.is_set())

    async def test_provider_callback_during_peer_setup_wins_over_teardown_cancel(self):
        await self.begin()
        self.meta.barrier.release.set()
        await asyncio.wait_for(self.meta.barrier.finished.wait(), 2)
        diagnostic = {"stage": "meta", "code": "rate-limit", "closeCode": 1013}
        self.meta.emit("error", message="Voice meta rate-limit", diagnostic=diagnostic)
        await self.result_error(502, diagnostic)
        await self.stopped()
        sequence = self.session.sequence
        await self.peer.handlers["failed"](self.peer)
        self.assertEqual(self.session.failure, diagnostic)
        self.assertEqual(self.session.sequence, sequence)

    async def test_cancel_during_both_connections_is_idempotent_and_owns_tasks(self):
        await self.begin()
        await self.manager.cancel(Identity(**IDENTITY))
        await self.result_error(409, "Generation cancelled")
        await self.manager.cancel(Identity(**IDENTITY))
        await self.stopped()
        self.assertTrue(self.meta.barrier.cancelled.is_set())
        self.assertTrue(self.peer.barrier.cancelled.is_set())
        self.assertTrue(all(task.done() for task in self.setup_tasks))
        self.assertFalse(self.runner.started.is_set())
        self.assertEqual(list(self.session.events), [])

    async def test_request_cancellation_closes_parallel_connections(self):
        await self.begin()
        self.opening.cancel()
        await self.result_error(409, "Generation cancelled")
        await self.stopped()
        self.assertTrue(all(task.done() for task in self.setup_tasks))

    async def test_late_worker_preparation_cannot_launch_pipeline_after_cancel(self):
        self.runner.preparation.release.clear()
        self.runner.preparation.ignore_cancel = True
        await self.begin()
        self.meta.barrier.release.set()
        self.peer.barrier.release.set()
        await asyncio.wait_for(self.runner.preparation.entered.wait(), 2)
        self.session.invalidate()
        self.session.ensure_stop()
        await asyncio.wait_for(self.runner.preparation.cancelled.wait(), 2)
        self.runner.preparation.release.set()
        await self.result_error(409, "Generation cancelled")
        await self.stopped()
        self.assertFalse(self.runner.started.is_set())
        self.assertIsNone(self.session.run_task)

    async def test_offer_deadline_keeps_pending_meta_category_and_cancels_both(self):
        timeout = asyncio.timeout(None)
        real_timeout = asyncio.timeout
        with patch("voice_sidecar.session.asyncio.timeout",
                   side_effect=lambda seconds: timeout if seconds == 12 else real_timeout(seconds)):
            await self.begin()
            # Expire the existing overall deadline only after both barriers enter.
            timeout.reschedule(asyncio.get_running_loop().time() - 1)
            await self.result_error(502, {"stage": "meta", "code": "timeout"})
            await self.stopped()
        self.assertTrue(all(task.done() for task in self.setup_tasks))

    async def test_offer_deadline_after_meta_ready_is_media_timeout(self):
        timeout = asyncio.timeout(None)
        real_timeout = asyncio.timeout
        with patch("voice_sidecar.session.asyncio.timeout",
                   side_effect=lambda seconds: timeout if seconds == 12 else real_timeout(seconds)):
            await self.begin()
            self.meta.barrier.release.set()
            await asyncio.wait_for(self.meta.barrier.finished.wait(), 2)
            timeout.reschedule(asyncio.get_running_loop().time() - 1)
            await self.result_error(502, {"stage": "media", "code": "timeout"})
            await self.stopped()

    async def test_noncooperating_connections_close_late_resources_and_drop_callbacks(self):
        self.meta.barrier.ignore_cancel = self.peer.barrier.ignore_cancel = True
        await self.begin()
        with self.expire_teardown():
            await self.manager.cancel(Identity(**IDENTITY))
        await self.result_error(409, "Generation cancelled")
        await self.stopped()
        self.assertTrue(all(not task.done() for task in self.setup_tasks))
        closes = (self.meta.close_calls, self.peer.close_calls)
        self.meta.barrier.release.set()
        self.peer.barrier.release.set()
        await asyncio.wait_for(asyncio.gather(*self.setup_tasks), 2)
        self.assertEqual((self.meta.close_calls, self.peer.close_calls),
                         (closes[0] + 1, closes[1] + 1))
        self.assertTrue(self.meta.closed.is_set())
        self.assertTrue(self.peer.closed.is_set())
        await self.worker.handlers["on_pipeline_started"](self.worker, None)
        await self.transport.handlers["on_client_connected"](self.transport, None)
        await self.transport.handlers["on_client_disconnected"](self.transport, None)
        await self.peer.handlers["failed"](self.peer)
        self.meta.emit("transcript", text="late", final=True)
        self.meta.emit("error", message="late", diagnostic={"stage": "meta", "code": "failed"})
        self.assertFalse(self.session.ready.is_set())
        self.assertFalse(self.session.connected.is_set())
        self.assertFalse(self.runner.started.is_set())
        self.assertIsNone(self.session.failure)
        self.assertEqual(list(self.session.events), [])
        await self.manager.cancel(Identity(**IDENTITY))
        self.http.close.assert_awaited_once()

    async def test_first_rtc_failure_survives_noncooperating_late_meta_and_close_errors(self):
        self.meta.barrier.ignore_cancel = True
        self.meta.barrier.error = ProviderError("meta", "auth", http_status=401)
        self.meta.close_error = RuntimeError("private-close-error")
        await self.begin()
        self.peer.barrier.error = OSError("private-rtc-error")
        self.peer.barrier.release.set()
        with self.expire_teardown():
            await self.result_error(502, {"stage": "media", "code": "network"})
            await self.stopped()
        self.assertTrue(any(not task.done() for task in self.setup_tasks))
        closes = self.meta.close_calls
        self.meta.barrier.release.set()
        await asyncio.wait_for(asyncio.gather(*self.setup_tasks, return_exceptions=True), 2)
        self.assertEqual(self.meta.close_calls, closes + 1)
        self.assertEqual(self.session.failure, {"stage": "media", "code": "network"})
        self.assertFalse(self.runner.started.is_set())
        self.assertTrue(all(task.cancelled() or task.exception() is None for task in self.setup_tasks))

    async def test_deadline_unwinds_even_if_both_setup_operations_ignore_cancel(self):
        self.meta.barrier.ignore_cancel = self.peer.barrier.ignore_cancel = True
        timeout = asyncio.timeout(None)
        real_timeout = asyncio.timeout
        with patch("voice_sidecar.session.asyncio.timeout",
                   side_effect=lambda seconds: timeout if seconds == 12 else real_timeout(seconds)):
            await self.begin()
            with self.expire_teardown():
                timeout.reschedule(asyncio.get_running_loop().time() - 1)
                await self.result_error(502, {"stage": "meta", "code": "timeout"})
                await self.stopped()
        self.assertTrue(all(not task.done() for task in self.setup_tasks))
        self.meta.barrier.release.set()
        self.peer.barrier.release.set()
        await asyncio.wait_for(asyncio.gather(*self.setup_tasks), 2)
        self.assertTrue(self.meta.closed.is_set())
        self.assertTrue(self.peer.closed.is_set())
        self.assertFalse(self.runner.started.is_set())

    async def test_late_cancel_after_resource_acquisition_still_closes_it(self):
        self.meta.barrier.ignore_cancel = True

        async def open_then_cancel():
            await self.meta.barrier.wait()
            self.meta.opened = True
            self.meta.closed.clear()
            raise asyncio.CancelledError

        self.meta.open = open_then_cancel
        await self.begin()
        with self.expire_teardown():
            await self.manager.cancel(Identity(**IDENTITY))
        await self.result_error(409, "Generation cancelled")
        await self.stopped()
        closes = self.meta.close_calls
        self.meta.barrier.release.set()
        await asyncio.wait_for(asyncio.gather(*self.setup_tasks, return_exceptions=True), 2)
        self.assertTrue(self.meta.closed.is_set())
        self.assertFalse(self.meta.opened)
        self.assertEqual(self.meta.close_calls, closes + 1)


if __name__ == "__main__":
    unittest.main()
