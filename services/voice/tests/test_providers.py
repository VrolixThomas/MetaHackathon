"""Provider security regressions using only local HTTP servers and dummy keys."""

import sys
import unittest
from pathlib import Path

import aiohttp
from aiohttp import web
from aiohttp.test_utils import TestServer

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from voice_sidecar.providers import Config, ProviderError, eleven_pcm


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
                        self.assertEqual(str(error.exception), "ElevenLabs TTS request failed")
                        self.assertEqual(received, [], "Redirect destination received a request")

        self.assertEqual(requested, [("fake-eleven-secret", {
            "text": "private speech", "model_id": "eleven_flash_v2_5",
        })] * 5)


if __name__ == "__main__":
    unittest.main()
