"""Provider security regressions using only local HTTP servers and dummy keys."""

import sys
import ssl
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice_sidecar.providers import Config, ProviderError, MetaStream, eleven_pcm
from voice_sidecar.diagnostics import classify
from voice_sidecar.protocol import Diagnostic, Identity


class ElevenRedirectTests(unittest.IsolatedAsyncioTestCase):
    async def test_redirects_never_forward_credentials_or_speech(self):
        received = []
        requested = []

        async def target(request):
            received.append((dict(request.headers), await request.read()))
            return web.Response(body=bytes(1920))

        destination_app = web.Application()
        destination_app.router.add_route("*", "/capture", target)
        async with TestServer(destination_app) as destination:
            status = 307

            async def redirect(request):
                requested.append((request.headers["xi-api-key"], await request.json()))
                return web.Response(status=status,
                                    headers={"Location": str(destination.make_url("/capture"))},
                                    text="private-provider-response")

            provider_app = web.Application()
            provider_app.router.add_post("/v1/text-to-speech/voice-test/stream", redirect)
            async with TestServer(provider_app) as provider, aiohttp.ClientSession() as http:
                config = Config("local", "fake-meta", "fake-eleven-secret", "voice-test",
                                eleven_url=str(provider.make_url("")).rstrip("/"))
                for status in (301, 302, 303, 307, 308):
                    with self.subTest(status=status):
                        with self.assertRaises(ProviderError) as error:
                            async for _ in eleven_pcm(http, config, "private speech"):
                                self.fail("Redirect response produced audio")
                        self.assertEqual(error.exception.diagnostic, {
                            "stage": "elevenlabs", "code": "failed", "httpStatus": status,
                        })
                        self.assertNotIn("private-provider-response", str(error.exception))
                        self.assertEqual(received, [], "Redirect destination received a request")

        self.assertEqual(requested, [("fake-eleven-secret", {
            "text": "private speech", "model_id": "eleven_flash_v2_5",
        })] * 5)

    async def test_http_failures_keep_status_and_provider_but_never_body(self):
        status = 401

        async def rejected(request):
            return web.Response(status=status, text="secret-provider-body-and-key")

        app = web.Application()
        app.router.add_route("*", "/{tail:.*}", rejected)
        async with TestServer(app) as server, aiohttp.ClientSession() as http:
            config = Config("local", "meta", "eleven", "voice", meta_url=str(server.make_url("/meta")).replace("http:", "ws:"),
                            eleven_url=str(server.make_url("")).rstrip("/"))
            for status, code in [(401, "auth"), (403, "access"), (404, "not-found"),
                                 (429, "rate-limit"), (503, "unavailable")]:
                with self.subTest(status=status):
                    with self.assertRaises(ProviderError) as tts:
                        async for _ in eleven_pcm(http, config, "private speech"):
                            self.fail("Rejected synthesis produced audio")
                    self.assertEqual(tts.exception.diagnostic, {"stage": "elevenlabs", "code": code, "httpStatus": status})
                    meta = MetaStream(config, Identity(sessionId="s", turnId="t", generation=1), [], lambda *a, **k: None)
                    with self.assertRaises(ProviderError) as stt:
                        await meta.open()
                    self.assertEqual(stt.exception.diagnostic, {"stage": "meta", "code": code, "httpStatus": status})
                    for error in [tts.exception, stt.exception]:
                        self.assertNotIn("secret", str(error))

    async def test_websocket_close_category_survives_and_no_close_reason_escapes(self):
        async def meta(request):
            ws = web.WebSocketResponse()
            await ws.prepare(request)
            await ws.receive_json()
            await ws.send_json({"sessionId": "s"})
            await ws.close(code=1013, message=b"private-close-reason")
            return ws

        app = web.Application()
        app.router.add_get("/meta", meta)
        events = []
        async with TestServer(app) as server:
            config = Config("local", "meta", "eleven", "voice", meta_url=str(server.make_url("/meta")).replace("http:", "ws:"))
            stream = MetaStream(config, Identity(sessionId="s", turnId="t", generation=1), [], lambda kind, **payload: events.append(payload))
            try:
                await stream.open()
                await stream.receiver
                self.assertEqual(events[0]["diagnostic"], {"stage": "meta", "code": "rate-limit", "closeCode": 1013})
                self.assertNotIn("private-close-reason", str(events))
                stream.fail(RuntimeError("later-private-error"))
                self.assertEqual(len(events), 1)
            finally:
                await stream.close()

    def test_classifier_drops_exception_text_and_diagnostic_rejects_extra_fields(self):
        for error, code in [(TimeoutError("secret"), "timeout"),
                            (ssl.SSLCertVerificationError("secret"), "tls"),
                            (RuntimeError("secret"), "failed")]:
            diagnostic = classify(error, "meta")
            self.assertEqual(diagnostic.diagnostic, {"stage": "meta", "code": code})
            self.assertNotIn("secret", str(diagnostic))
        with self.assertRaises(ValueError):
            Diagnostic(stage="meta", code="failed", message="private")


if __name__ == "__main__":
    unittest.main()
