#!/usr/bin/env python3
"""Launcher: stdout is JSON readiness only (or --self-test JSON); stderr is logs."""

import argparse
import asyncio
import json
import os
import socket
import sys

from loguru import logger

logger.remove()
logger.add(sys.stderr, level="WARNING", backtrace=False, diagnose=False)

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=0, choices=range(0, 65536), metavar="PORT")
    parser.add_argument("--self-test", action="store_true")
    args = parser.parse_args()
    if args.self_test:
        from voice_sidecar.probe import self_test

        print(json.dumps(asyncio.run(self_test())), flush=True)
        return
    names = ("VOICE_AUTH_TOKEN", "MODEL_API_KEY", "ELEVENLABS_API_KEY", "ELEVENLABS_VOICE_ID")
    missing = [name for name in names if not os.environ.get(name, "").strip()]
    if missing:
        print("Missing required environment: " + ", ".join(missing), file=sys.stderr)
        raise SystemExit(2)
    # Configure logging before Pipecat imports; load probe-only dependencies only
    # for --self-test, and reject missing configuration before native library loads.
    from voice_sidecar.providers import Config
    from voice_sidecar.server import create_app

    config = Config(*(os.environ[name] for name in names))
    import uvicorn

    class ReadyServer(uvicorn.Server):
        async def startup(self, sockets=None):
            await super().startup(sockets=sockets)
            if self.started:
                print(json.dumps({"port": sockets[0].getsockname()[1]}), flush=True)

    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    sock.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    sock.bind(("127.0.0.1", args.port))
    sock.setblocking(False)
    server = ReadyServer(uvicorn.Config(
        create_app(config), host="127.0.0.1", port=args.port,
        loop="asyncio", http="h11", ws="none", access_log=False,
        log_level="warning", timeout_graceful_shutdown=10,
        h11_max_incomplete_event_size=16384,
    ))
    try:
        server.run(sockets=[sock])
    finally:
        sock.close()


if __name__ == "__main__":
    main()
