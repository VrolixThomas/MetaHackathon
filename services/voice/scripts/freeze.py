#!/usr/bin/env python3
"""Build on the target OS/architecture, then probe and inventory the onedir bundle."""

import json
from pathlib import Path
import subprocess
import sys
import time

ROOT = Path(__file__).resolve().parents[1]
DIST = ROOT / "dist"


def main():
    subprocess.run([
        sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onedir",
        "--name", "metahackathon-voice", "--distpath", str(DIST),
        "--workpath", str(ROOT / "build"), "--specpath", str(ROOT / "build"),
        "--paths", str(ROOT), "--copy-metadata", "pipecat-ai",
        "--collect-data", "pipecat", "--collect-submodules", "av",
        "--hidden-import", "uvicorn.logging", "--hidden-import", "uvicorn.loops.asyncio",
        "--hidden-import", "uvicorn.protocols.http.h11_impl",
        "--hidden-import", "uvicorn.lifespan.on",
        str(ROOT / "sidecar.py"),
    ], check=True, cwd=ROOT)
    executable = DIST / "metahackathon-voice" / "metahackathon-voice"
    # Measure the first server boot BEFORE self-test warms the native libraries.
    for name in ("cold-launch-smoke.json", "launch-smoke.json"):
        smoke = subprocess.run([
            sys.executable, str(ROOT / "scripts" / "launch_smoke.py"), str(executable),
        ], check=True, capture_output=True, text=True, timeout=400)
        (DIST / name).write_text(smoke.stdout)
    started = time.monotonic()
    result = subprocess.run([str(executable), "--self-test"], capture_output=True, text=True, timeout=180)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    result.check_returncode()
    probe = json.loads(result.stdout)
    probe["elapsedSeconds"] = round(time.monotonic() - started, 3)
    assert probe["ok"] and probe["frozen"]
    (DIST / "self-test.json").write_text(json.dumps(probe, indent=2) + "\n")
    subprocess.run([
        sys.executable, str(ROOT / "scripts" / "inventory.py"), str(executable.parent),
        str(DIST / "bundle-inventory.json"),
    ], check=True)
    print(result.stdout.strip())


if __name__ == "__main__":
    main()
