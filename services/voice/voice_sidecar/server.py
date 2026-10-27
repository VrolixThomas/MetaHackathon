"""Loopback HTTP control plane. Authentication precedes routing and body parsing."""

import asyncio
import hmac
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.exceptions import RequestValidationError
from starlette.responses import JSONResponse

from .protocol import Answer, Identity, Offer, Poll, PollResult, Speak
from .session import Manager


class Boundary:
    def __init__(self, app, token):
        self.app, self.token = app, f"Bearer {token}".encode()
        self.inflight = 0

    async def __call__(self, scope, receive, send):
        if scope["type"] != "http":
            return await self.app(scope, receive, send)

        async def reject(status, detail):
            await JSONResponse({"detail": detail}, status_code=status)(scope, receive, send)

        auth = [v for k, v in scope["headers"] if k.lower() == b"authorization"]
        if len(auth) != 1 or not hmac.compare_digest(auth[0], self.token):
            return await reject(401, "Bearer authentication required")
        if self.inflight >= 64:
            return await reject(429, "Too many requests")
        self.inflight += 1
        try:
            body = bytearray()
            try:
                async with asyncio.timeout(5):
                    while True:
                        message = await receive()
                        if message["type"] == "http.disconnect":
                            return
                        body.extend(message.get("body", b""))
                        if len(body) > 131072:
                            return await reject(413, "Request body too large")
                        if not message.get("more_body"):
                            break
            except TimeoutError:
                return await reject(408, "Request body timeout")
            delivered = False

            async def bounded_receive():
                nonlocal delivered
                if not delivered:
                    delivered = True
                    return {"type": "http.request", "body": bytes(body), "more_body": False}
                return await receive()

            await self.app(scope, bounded_receive, send)
        finally:
            self.inflight -= 1


def create_app(config, manager=None):
    manager = manager or Manager(config)

    @asynccontextmanager
    async def lifespan(app):
        yield
        await manager.close()

    app = FastAPI(docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)
    app.state.manager = manager
    app.add_middleware(Boundary, token=config.auth_token)

    @app.exception_handler(RequestValidationError)
    async def validation_error(request, error):
        return JSONResponse({"detail": "Invalid voice protocol payload"}, status_code=422)

    @app.post("/offer", response_model=Answer)
    async def offer(body: Offer):
        return await manager.offer(body)

    @app.post("/release")
    async def release(body: Identity):
        manager.get(body).release()
        return {}

    @app.post("/speak")
    async def speak(body: Speak):
        manager.get(body).enqueue(body)
        return {}

    @app.post("/cancel")
    async def cancel(body: Identity):
        await manager.cancel(body)
        return {}

    @app.post("/poll", response_model=PollResult, response_model_exclude_none=True)
    async def poll(body: Poll):
        return manager.get(body, require_active=False).poll(body.afterSequence)

    return app
