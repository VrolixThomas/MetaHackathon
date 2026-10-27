#!/usr/bin/env python3
"""Launch an actual frozen sidecar, verify stdout/auth/validation/shutdown without providers."""

import asyncio
import json
import os
from pathlib import Path
import socket
import sys
import time

import aiohttp


async def check(executable):
    names = ("VOICE_AUTH_TOKEN", "MODEL_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID")
    empty_env = {key: value for key, value in os.environ.items() if key not in names}
    env = dict(empty_env)
    # Dummy values only; no offer/provider call is made by this smoke test.
    env.update(dict(zip(names, ("smoke-token", "not-a-meta-key", "not-an-eleven-key", "fake-voice"))))
    started = time.monotonic()
    process = await asyncio.create_subprocess_exec(
        executable, "--port", "0", env=env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    port = None
    try:
        line = await asyncio.wait_for(process.stdout.readline(), 180)
        readiness = json.loads(line)
        assert set(readiness) == {"port"} and type(readiness["port"]) is int
        port = readiness["port"]
        launch_seconds = round(time.monotonic() - started, 3)
        base = f"http://127.0.0.1:{port}"
        async with aiohttp.ClientSession() as client:
            for route in ("offer", "release", "speak", "cancel", "poll", "docs", "missing"):
                async with client.post(f"{base}/{route}", json={}) as response:
                    assert response.status == 401
            headers = {"Authorization": "Bearer smoke-token"}
            async with client.post(f"{base}/offer", json={}, headers=headers) as response:
                assert response.status == 422
            identity = {"sessionId": "smoke", "turnId": "one", "generation": 1}
            for _ in range(2):
                async with client.post(f"{base}/cancel", json=identity, headers=headers) as response:
                    assert response.status == 200 and await response.json() == {}
            async with client.post(f"{base}/offer", headers=headers,
                                   json={**identity, "type": "offer", "sdp": "cancelled"}) as response:
                assert response.status == 409
    finally:
        process.terminate()
        out, err = await asyncio.wait_for(process.communicate(), 15)
    assert process.returncode in (0, -15) and out == b"", (process.returncode, out, err)
    assert not any(secret.encode() in err for secret in ("smoke-token", "not-a-meta-key", "not-an-eleven-key"))
    with socket.socket() as sock:
        assert sock.connect_ex(("127.0.0.1", port)) != 0
    missing = await asyncio.create_subprocess_exec(
        executable, "--port", "0", env=empty_env,
        stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
    )
    out, err = await asyncio.wait_for(missing.communicate(), 180)
    assert missing.returncode == 2 and out == b"" and b"Missing required environment" in err
    return {"ok": True, "launchSeconds": launch_seconds, "readiness": "single JSON port line",
            "authPathsChecked": 7, "cancelBeforeOffer": True, "portClosedAfterExit": True,
            "liveProviders": False}


if __name__ == "__main__":
    executable = str(Path(sys.argv[1]).resolve())
    print(json.dumps(asyncio.run(check(executable)), indent=2))
