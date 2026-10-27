"""Fixed error categories. Never copy exception text, response bodies or close reasons."""

import asyncio
import json
import ssl

import aiohttp
from websockets.exceptions import ConnectionClosed, InvalidStatus

from .protocol import Diagnostic


class ProviderError(Exception):
    def __init__(self, stage, code="failed", *, http_status=None, close_code=None):
        self.diagnostic = Diagnostic(stage=stage, code=code, httpStatus=http_status,
                                     closeCode=close_code).model_dump(exclude_none=True)
        # Main reconstructs user-facing copy from this same validated diagnostic.
        super().__init__(f"Voice {stage} {code}")


def http_error(stage, status):
    code = {401: "auth", 403: "access", 404: "not-found", 408: "timeout", 429: "rate-limit"}.get(status)
    if code is None:
        code = "unavailable" if status >= 500 else "protocol" if status in (400, 422) else "failed"
    return ProviderError(stage, code, http_status=status)


def close_error(stage, code):
    category = {1000: "protocol", 1008: "protocol", 1011: "unavailable", 1013: "rate-limit"}.get(code, "network")
    return ProviderError(stage, category, close_code=code if isinstance(code, int) and 1000 <= code <= 4999 else None)


def classify(error, stage):
    if isinstance(error, ProviderError):
        return error
    if isinstance(error, (asyncio.TimeoutError, TimeoutError)):
        return ProviderError(stage, "timeout")
    if isinstance(error, InvalidStatus):
        return http_error(stage, error.response.status_code)
    if isinstance(error, ConnectionClosed):
        return close_error(stage, error.rcvd.code if error.rcvd else None)
    if isinstance(error, aiohttp.ClientResponseError):
        return http_error(stage, error.status) if 100 <= error.status <= 599 else ProviderError(stage)
    if isinstance(error, (ssl.SSLError, aiohttp.ClientSSLError)):
        return ProviderError(stage, "tls")
    if isinstance(error, (aiohttp.ClientError, OSError)):
        return ProviderError(stage, "network")
    if isinstance(error, (json.JSONDecodeError, UnicodeError)):
        return ProviderError(stage, "protocol")
    return ProviderError(stage)
