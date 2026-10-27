"""Bounded provider clients. Provider response bodies/credentials never enter logs."""

import asyncio
import json
import ssl
from dataclasses import dataclass
from urllib.parse import quote

import aiohttp
import truststore
from websockets.asyncio.client import connect
from .diagnostics import ProviderError, classify, close_error, http_error

RATE = 24_000
PCM_CHUNK = 1920  # 40 ms, mono signed s16le


def tls_context():
    # Frozen builds must use the OS trust store, not the build machine's
    # Homebrew OpenSSL CA path. Verification and hostname checks remain enabled.
    return truststore.SSLContext(ssl.PROTOCOL_TLS_CLIENT)


@dataclass(frozen=True)
class Config:
    auth_token: str
    meta_key: str
    eleven_key: str
    voice_id: str
    # Injectable only in Python tests, never controlled through HTTP/environment.
    meta_url: str = "wss://api.meta.ai/v1/asr/realtime"
    eleven_url: str = "https://api.elevenlabs.io"
    tts_model: str = "eleven_flash_v2_5"


class MetaStream:
    def __init__(self, config, identity, keywords, emit):
        self.config, self.identity, self.keywords, self.emit = config, identity, keywords, emit
        self.audio = asyncio.Queue(maxsize=100)  # <= 4 seconds, hard fail on overload
        self.ws = None
        self.receiver = None
        self.sender = None
        self.ended = False
        self.final = False
        self.failure = None

    async def open(self):
        query = quote(
            f"{self.identity.sessionId}:{self.identity.turnId}:{self.identity.generation}", safe=""
        )
        try:
            self.ws = await connect(
                f"{self.config.meta_url}?sessionId={query}",
                open_timeout=5, close_timeout=2, max_size=256_000, max_queue=8,
                **({"ssl": tls_context()} if self.config.meta_url.startswith("wss:") else {}),
            )
            await self.ws.send(json.dumps({
                "authorization": {"accessToken": f"Bearer {self.config.meta_key}"},
                "audioEncoding": "PCM_24KHZ", "model": "muse-voice-transcribe-1.0",
                "mode": "PUSH_TO_TALK", "partialMode": "CUMULATIVE",
                "keywords": self.keywords,
            }))
            ack = json.loads(await asyncio.wait_for(self.ws.recv(), 5))
            if not isinstance(ack, dict) or not isinstance(ack.get("sessionId"), str) or "type" in ack:
                raise ProviderError("meta", "failed" if isinstance(ack, dict) and ack.get("type") == "error" else "protocol")
        except asyncio.CancelledError:
            if self.ws:
                await self.ws.close()
            raise
        except Exception as error:
            failure = classify(error, "meta")
            if self.ws:
                try:
                    await self.ws.close()
                except Exception:
                    pass
            raise failure from None
        self.receiver = asyncio.create_task(self._receive(), name="meta-receive")
        self.sender = asyncio.create_task(self._send(), name="meta-send")

    def feed(self, pcm):
        if self.ended:
            return
        if len(pcm) % 2:
            raise ProviderError("media", "protocol")
        for offset in range(0, len(pcm), PCM_CHUNK):
            try:
                self.audio.put_nowait(pcm[offset:offset + PCM_CHUNK])
            except asyncio.QueueFull:
                raise ProviderError("meta", "busy") from None

    def fail(self, error):
        if self.failure is None:
            self.failure = classify(error, "meta")
            self.emit("error", message=str(self.failure), diagnostic=self.failure.diagnostic)

    async def _send(self):
        loop = asyncio.get_running_loop()
        next_send = loop.time()
        try:
            while True:
                pcm = await self.audio.get()
                try:
                    # RTP is normally live, but buffered input must not burst into
                    # Meta faster than realtime. Never accrue catch-up credit.
                    await asyncio.sleep(max(0, next_send - loop.time()))
                    if pcm is None:
                        await self.ws.send('{"type":"endStream"}')
                        return
                    await asyncio.wait_for(self.ws.send(pcm), 3)
                    next_send = loop.time() + len(pcm) / (RATE * 2)
                finally:
                    self.audio.task_done()
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.fail(error)

    async def _receive(self):
        try:
            async for raw in self.ws:
                if not isinstance(raw, str):
                    raise ProviderError("meta", "protocol")
                event = json.loads(raw)
                if not isinstance(event, dict):
                    raise ProviderError("meta", "protocol")
                if event.get("type") == "error":
                    raise ProviderError("meta")
                if event.get("type") == "transcript":
                    text, final = event.get("transcript"), event.get("final")
                    if not isinstance(text, str) or len(text) > 32000 or type(final) is not bool:
                        raise ProviderError("meta", "protocol")
                    if self.final:
                        continue
                    self.final = final
                    self.emit("transcript", text=text, final=final)
            if self.ws.close_code != 1000 or not self.final:
                raise close_error("meta", self.ws.close_code)
        except asyncio.CancelledError:
            raise
        except Exception as error:
            self.fail(error)

    async def finish(self):
        if self.ended:
            return
        self.ended = True
        # FIFO sentinel drains accepted PCM before endStream. Keep receiving the final.
        async with asyncio.timeout(15):
            await self.audio.put(None)
            await self.sender
            await self.receiver
        if self.failure:
            raise self.failure

    async def close(self):
        self.ended = True
        tasks = [t for t in (self.sender, self.receiver) if t]
        for task in tasks:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        if self.ws:
            await self.ws.close()
        while not self.audio.empty():
            self.audio.get_nowait()
            self.audio.task_done()


async def eleven_pcm(http, config, text):
    """Documented ElevenLabs /stream API; raw PCM avoids decoding/container ambiguity."""
    url = f"{config.eleven_url}/v1/text-to-speech/{quote(config.voice_id, safe='')}/stream"
    try:
        async with http.post(
            url, params={"output_format": "pcm_24000"},
            headers={"xi-api-key": config.eleven_key, "Content-Type": "application/json"},
            json={"text": text, "model_id": config.tts_model},
            # Never forward the custom API-key header or speech body to a redirect.
            allow_redirects=False,
            timeout=aiohttp.ClientTimeout(total=120, connect=10, sock_read=15),
        ) as response:
            if response.status != 200:
                raise http_error("elevenlabs", response.status)
            pending = b""
            count = 0
            async for chunk in response.content.iter_chunked(PCM_CHUNK):
                count += len(chunk)
                if count > RATE * 2 * 120:
                    raise ProviderError("elevenlabs", "protocol")
                pending += chunk
                while len(pending) >= PCM_CHUNK:
                    yield pending[:PCM_CHUNK]
                    pending = pending[PCM_CHUNK:]
            if count == 0 or len(pending) % 2:
                raise ProviderError("elevenlabs", "protocol")
            if pending:
                # Transport writes multiples of 10ms. Pad only the final frame.
                yield pending + bytes((-len(pending)) % PCM_CHUNK)
    except asyncio.CancelledError:
        raise
    except ProviderError:
        raise
    except Exception as error:
        raise classify(error, "elevenlabs") from None
