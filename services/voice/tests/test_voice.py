"""Real local HTTP, WebSocket, DTLS/SRTP and Pipecat; providers are deterministic mocks."""

import asyncio
import fractions
import json
import socket
import sys
import unittest
from unittest.mock import patch
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import aiohttp
from aiohttp import web
from aiortc import AudioStreamTrack, RTCConfiguration, RTCPeerConnection, RTCSessionDescription
from av import AudioFrame
from fastapi import HTTPException
from loguru import logger
import numpy as np
import uvicorn

logger.remove()
logger.add(sys.stderr, level="ERROR", backtrace=False, diagnose=False)

from voice_sidecar.protocol import Identity, Offer, Speak
from voice_sidecar.providers import Config, MetaStream, ProviderError
from voice_sidecar.server import create_app
from voice_sidecar.session import Manager, Session

IDENTITY = {"sessionId": "review", "turnId": "turn-one", "generation": 1}


async def until(predicate, timeout=5):
    async with asyncio.timeout(timeout):
        while not predicate():
            await asyncio.sleep(0.01)


class Tone(AudioStreamTrack):
    def __init__(self):
        super().__init__()
        self.pts = 0

    async def recv(self):
        await asyncio.sleep(0.02)
        data = (np.sin(np.arange(960) * (2 * np.pi * 440 / 48000)) * 8000).astype(np.int16)
        frame = AudioFrame.from_ndarray(data[None, :], format="s16", layout="mono")
        frame.sample_rate = 48000
        frame.pts = self.pts
        frame.time_base = fractions.Fraction(1, 48000)
        self.pts += 960
        return frame


class VoiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.handshakes = []
        self.pcm = []
        self.pcm_times = []
        self.ends = []
        self.tts_requests = []
        self.final_gate = asyncio.Event()
        self.final_gate.set()
        self.handshake_gate = asyncio.Event()
        self.handshake_gate.set()
        self.tts_gate = asyncio.Event()
        self.tts_gate.set()
        self.peers = []
        self.readers = []
        self.heard = asyncio.Event()
        self.provider_sockets = []
        self.active_tts = 0
        self.max_tts = 0
        self.bad_handshake = False
        self.omit_final = False

        async def meta(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            self.provider_sockets.append(ws)
            first = await ws.receive_json()
            self.handshakes.append((dict(request.headers), first, request.query["sessionId"]))
            await self.handshake_gate.wait()
            try:
                await ws.send_json({"type": "error", "message": "secret-provider-body"} if self.bad_handshake
                                   else {"sessionId": request.query["sessionId"]})
            except aiohttp.ClientConnectionError:
                return ws
            async for msg in ws:
                if msg.type == web.WSMsgType.BINARY:
                    self.pcm.append(msg.data)
                    self.pcm_times.append(asyncio.get_running_loop().time())
                    try:
                        await ws.send_json({"type": "transcript", "transcript": "why this", "final": False})
                    except aiohttp.ClientConnectionError:
                        break
                elif msg.type == web.WSMsgType.TEXT:
                    self.ends.append(json.loads(msg.data))
                    await self.final_gate.wait()
                    try:
                        if not self.omit_final:
                            await ws.send_json({"type": "transcript", "transcript": "Why this change?", "final": True})
                        await ws.close(code=1000)
                    except Exception:
                        pass
            return ws

        async def tts(request):
            self.tts_requests.append((dict(request.headers), dict(request.query), await request.json(), request.match_info["voice"]))
            self.active_tts += 1
            self.max_tts = max(self.max_tts, self.active_tts)
            try:
                await self.tts_gate.wait()
                data = (np.sin(np.arange(4800) * (2 * np.pi * 660 / 24000)) * 10000).astype("<i2").tobytes()
                response = web.StreamResponse(headers={"Content-Type": "audio/pcm"})
                await response.prepare(request)
                # Deliberately split odd-byte chunks to test sample reassembly.
                for offset in range(0, len(data), 733):
                    await response.write(data[offset:offset + 733])
                await response.write_eof()
                return response
            except aiohttp.ClientConnectionError:
                return web.Response()
            finally:
                self.active_tts -= 1

        provider = web.Application()
        provider.router.add_get("/meta", meta)
        provider.router.add_post("/v1/text-to-speech/{voice}/stream", tts)
        self.provider = web.AppRunner(provider)
        await self.provider.setup()
        self.provider_sock = socket.socket()
        self.provider_sock.bind(("127.0.0.1", 0))
        await web.SockSite(self.provider, self.provider_sock).start()
        port = self.provider_sock.getsockname()[1]
        self.config = Config("local-token", "fake-meta", "fake-eleven", "voice-test",
                             f"ws://127.0.0.1:{port}/meta", f"http://127.0.0.1:{port}")
        self.manager = Manager(self.config)
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.server = uvicorn.Server(uvicorn.Config(create_app(self.config, self.manager),
                log_level="error", access_log=False, ws="none", lifespan="on"))
        self.server_task = asyncio.create_task(self.server.serve(sockets=[self.sock]))
        await until(lambda: self.server.started)
        self.base = f"http://127.0.0.1:{self.sock.getsockname()[1]}"
        self.http = aiohttp.ClientSession(headers={"Authorization": "Bearer local-token"})

    async def asyncTearDown(self):
        self.final_gate.set()
        self.handshake_gate.set()
        self.tts_gate.set()
        await self.manager.close()
        for reader in self.readers:
            reader.cancel()
        await asyncio.gather(*self.readers, return_exceptions=True)
        for peer in self.peers:
            await peer.close()
        for ws in self.provider_sockets:
            await ws.close()
        await self.http.close()
        self.server.should_exit = True
        await asyncio.wait_for(self.server_task, 10)
        await self.provider.cleanup()

    async def post(self, path, body, status=200):
        async with self.http.post(self.base + path, json=body) as response:
            data = await response.json()
            self.assertEqual(response.status, status, data)
            return data

    async def local_offer(self, identity=IDENTITY):
        peer = RTCPeerConnection(RTCConfiguration(iceServers=[]))
        self.peers.append(peer)
        peer.createDataChannel("pipecat")
        peer.addTrack(Tone())

        @peer.on("track")
        def track(track):
            async def read():
                while True:
                    frame = await track.recv()
                    if np.max(np.abs(frame.to_ndarray().astype(np.int32))) > 500:
                        self.heard.set()
            self.readers.append(asyncio.create_task(read()))

        await peer.setLocalDescription(await peer.createOffer())
        body = {**identity, "sdp": peer.localDescription.sdp, "type": "offer", "keywords": ["Pipecat", "MET-28"]}
        return peer, body

    async def connect(self, identity=IDENTITY):
        peer, body = await self.local_offer(identity)
        answer = await self.post("/offer", body)
        self.assertEqual(set(answer), {"sdp", "type"})
        await peer.setRemoteDescription(RTCSessionDescription(**answer))
        await until(lambda: peer.connectionState == "connected")
        return peer

    async def test_real_peer_release_pcm_serial_tts_and_cancel(self):
        peer = await self.connect()
        await until(lambda: len(self.pcm) >= 3)
        headers, handshake, query = self.handshakes[0]
        self.assertNotIn("Authorization", headers)
        self.assertEqual(handshake, {"authorization": {"accessToken": "Bearer fake-meta"},
            "audioEncoding": "PCM_24KHZ", "model": "muse-voice-transcribe-1.0", "mode": "PUSH_TO_TALK",
            "partialMode": "CUMULATIVE", "keywords": ["Pipecat", "MET-28"]})
        self.assertTrue(all(len(chunk) % 2 == 0 and len(chunk) <= 1920 for chunk in self.pcm))
        self.assertTrue(any(np.max(np.abs(np.frombuffer(chunk, dtype="<i2"))) > 100 for chunk in self.pcm))
        self.assertEqual(query, "review:turn-one:1")
        await self.post("/release", IDENTITY)
        await self.post("/release", IDENTITY)
        await until(lambda: bool(self.ends))
        count = len(self.pcm)
        await asyncio.sleep(0.3)  # Mic still sends; the input gate must be closed.
        self.assertEqual(count, len(self.pcm))
        self.assertEqual(self.ends, [{"type": "endStream"}])
        events = (await self.post("/poll", {**IDENTITY, "afterSequence": 0}))["events"]
        self.assertEqual([e["text"] for e in events if e.get("final")], ["Why this change?"])
        for speech_id, text in [("ack", "Looking now."), ("answer", "Here is why.")]:
            await self.post("/speak", {**IDENTITY, "speechId": speech_id, "text": text})
        await self.post("/speak", {**IDENTITY, "speechId": "ack", "text": "Looking now."})
        session = self.manager.get(Identity(**IDENTITY))
        await until(lambda: sum(e["kind"] == "speech-ended" for e in session.events) == 2, 10)
        await asyncio.wait_for(self.heard.wait(), 5)
        speech_events = [(e["kind"], e.get("speechId")) for e in session.events if e["kind"].startswith("speech-")]
        self.assertEqual(speech_events, [("speech-started", "ack"), ("speech-ended", "ack"),
                                        ("speech-started", "answer"), ("speech-ended", "answer")])
        self.assertEqual(len(self.tts_requests), 2)
        self.assertEqual(self.max_tts, 1)
        h, q, body, voice = self.tts_requests[0]
        self.assertEqual(h["xi-api-key"], "fake-eleven")
        self.assertEqual(q, {"output_format": "pcm_24000"})
        self.assertEqual(body, {"text": "Looking now.", "model_id": "eleven_flash_v2_5"})
        self.assertEqual(voice, "voice-test")
        server_peer = session.peer.pc
        await self.post("/cancel", IDENTITY)
        await self.post("/cancel", IDENTITY)
        self.assertEqual(server_peer.connectionState, "closed")
        self.assertEqual((await self.post("/poll", {**IDENTITY, "afterSequence": 0}))["events"], [])
        await self.post("/speak", {**IDENTITY, "speechId": "late", "text": "No"}, 409)

    async def test_cancel_during_offer_and_cancel_before_offer(self):
        peer, body = await self.local_offer()
        self.handshake_gate.clear()
        opening = asyncio.create_task(self.post("/offer", body, 409))
        await until(lambda: bool(self.handshakes))
        await self.post("/cancel", IDENTITY)
        await asyncio.wait_for(opening, 3)
        self.handshake_gate.set()
        await self.post("/offer", body, 409)
        future = {**IDENTITY, "generation": 5, "turnId": "future"}
        await self.post("/cancel", future)
        await self.post("/cancel", future)
        await self.post("/offer", {**body, **future}, 409)

    async def test_cancel_late_final_and_inflight_tts(self):
        await self.connect()
        self.final_gate.clear()
        self.tts_gate.clear()
        await until(lambda: bool(self.pcm))
        await self.post("/release", IDENTITY)
        await self.post("/speak", {**IDENTITY, "speechId": "waiting", "text": "Wait"})
        await until(lambda: bool(self.ends) and bool(self.tts_requests))
        session = self.manager.get(Identity(**IDENTITY))
        await self.post("/cancel", IDENTITY)
        self.final_gate.set()
        self.tts_gate.set()
        await asyncio.sleep(0.1)
        self.assertFalse(session.active)
        self.assertEqual(list(session.events), [])
        self.assertTrue(session.run_task.done())
        self.assertTrue(session.meta.receiver.done())
        self.assertTrue(session.meta.sender.done())

    async def test_new_generation_replaces_peer_and_old_cancel_is_harmless(self):
        await self.connect()
        old = self.manager.get(Identity(**IDENTITY))
        newer = {**IDENTITY, "turnId": "turn-two", "generation": 2}
        await self.connect(newer)
        current = self.manager.get(Identity(**newer))
        self.assertIsNot(old.peer, current.peer)
        self.assertEqual(old.peer.pc.connectionState, "closed")
        await self.post("/cancel", IDENTITY)
        self.assertTrue(current.active)
        await self.post("/release", IDENTITY, 409)
        await self.post("/poll", {**IDENTITY, "afterSequence": 0}, 409)
        await self.post("/cancel", {**newer, "turnId": "wrong"}, 409)

    async def test_auth_every_path_body_bounds_and_validation(self):
        async with aiohttp.ClientSession() as anonymous:
            for path in ["/offer", "/release", "/speak", "/cancel", "/poll", "/docs", "/unknown"]:
                async with anonymous.post(self.base + path, json={}) as response:
                    self.assertEqual(response.status, 401)
        await self.post("/cancel", {**IDENTITY, "generation": True}, 422)
        await self.post("/cancel", {**IDENTITY, "extra": 1}, 422)
        async with self.http.post(self.base + "/offer", data=b"x" * 131073) as response:
            self.assertEqual(response.status, 413)

    async def test_bad_handshake_is_sanitized_and_tears_down(self):
        self.bad_handshake = True
        peer, offer = await self.local_offer()
        result = await self.post("/offer", offer, 502)
        self.assertNotIn("secret-provider-body", json.dumps(result))
        session = self.manager.sessions[IDENTITY["sessionId"]]
        await asyncio.wait_for(session.ensure_stop(), 7)
        self.assertEqual(session.peer.pc.connectionState, "closed")
        self.assertTrue(session.http.closed)

    async def test_missing_final_is_error_not_success(self):
        self.omit_final = True
        await self.connect()
        await until(lambda: bool(self.pcm))
        await self.post("/release", IDENTITY)
        session = self.manager.get(Identity(**IDENTITY))
        await until(lambda: not session.active)
        events = (await self.post("/poll", {**IDENTITY, "afterSequence": 0}))["events"]
        self.assertTrue(any(e["kind"] == "error" for e in events))
        self.assertFalse(any(e.get("final") for e in events))
        await asyncio.wait_for(session.ensure_stop(), 7)
        self.assertEqual(session.peer.pc.connectionState, "closed")

    async def test_capture_timeout_closes_peer(self):
        with patch("voice_sidecar.session.CAPTURE_SECONDS", 0.5):
            await self.connect()
            session = self.manager.get(Identity(**IDENTITY))
            await until(lambda: not session.active)
            self.assertTrue(any(e.get("message") == "Maximum capture duration reached" for e in session.events))
            await asyncio.wait_for(session.ensure_stop(), 7)
            self.assertEqual(session.peer.pc.connectionState, "closed")

    async def test_identity_and_concurrency_caps(self):
        for index in range(4):
            identity = {**IDENTITY, "sessionId": str(index)}
            session = Session(Offer(**identity, type="offer", sdp="unused"), self.config)
            self.manager.sessions[str(index)] = session
            self.manager.highwater[str(index)] = 1
        await self.post("/offer", {**IDENTITY, "type": "offer", "sdp": "unused"}, 429)
        await self.manager.close()
        for index in range(256):
            self.manager.highwater[str(index)] = 1
        await self.post("/cancel", IDENTITY, 429)
        await self.post("/offer", {**IDENTITY, "type": "offer", "sdp": "unused"}, 429)

    async def test_replaced_but_still_closing_sessions_count_toward_limit(self):
        # A rapid newer offer must not hide peers still tearing down from the cap.
        for index in range(4):
            identity = {**IDENTITY, "sessionId": f"retiring-{index}"}
            session = Session(Offer(**identity, type="offer", sdp="unused"), self.config)
            self.manager.retiring.add(session)
        await self.post("/offer", {**IDENTITY, "type": "offer", "sdp": "unused"}, 429)

    async def test_limits_pagination_and_duplicate_speech(self):
        offer = Offer(**IDENTITY, type="offer", sdp="unused")
        session = Session(offer, self.config)
        self.manager.sessions[offer.sessionId] = session
        self.manager.highwater[offer.sessionId] = 1
        for index in range(220):
            session.emit("transcript", text=str(index), final=False)
        page = session.poll(0).model_dump()["events"]
        self.assertEqual(len(page), 100)
        self.assertEqual(page[-1]["sequence"], 100)
        self.assertEqual(len(session.poll(100).events), 100)
        self.assertEqual(len(session.poll(200).events), 20)
        for index in range(20):
            session.emit("transcript", text="a" * 32000, final=False)
        self.assertLessEqual(session.event_bytes, 262144)
        with self.assertRaises(HTTPException):
            session.poll(0)
        for index in range(32):
            session.enqueue(Speak(**IDENTITY, speechId=str(index), text="sentence"))
        with self.assertRaises(HTTPException) as full:
            session.enqueue(Speak(**IDENTITY, speechId="overflow", text="sentence"))
        self.assertEqual(full.exception.status_code, 429)
        with self.assertRaises(HTTPException):
            session.enqueue(Speak(**IDENTITY, speechId="0", text="changed"))
        meta = MetaStream(self.config, Identity(**IDENTITY), [], lambda *a, **k: None)
        for _ in range(100):
            meta.feed(bytes(1920))
        with self.assertRaises(ProviderError):
            meta.feed(bytes(1920))

    async def test_buffered_meta_pcm_is_paced_at_realtime(self):
        events = []
        meta = MetaStream(self.config, Identity(**IDENTITY), [], lambda kind, **body: events.append((kind, body)))
        try:
            await meta.open()
            # Enqueue 200ms instantly, as could happen after RTP/event-loop jitter.
            meta.feed(bytes(1920 * 5))
            await meta.finish()
            self.assertEqual(len(self.pcm_times), 5)
            gaps = [b - a for a, b in zip(self.pcm_times, self.pcm_times[1:])]
            self.assertTrue(all(gap >= 0.035 for gap in gaps), gaps)
            self.assertGreaterEqual(self.pcm_times[-1] - self.pcm_times[0], 0.15)
            self.assertEqual(self.ends, [{"type": "endStream"}])
            self.assertTrue(events[-1][1]["final"])
        finally:
            await meta.close()


if __name__ == "__main__":
    unittest.main()
