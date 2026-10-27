#!/usr/bin/env python3
"""Inventory every regular file, symlink and Mach-O without following directory links."""

import hashlib
import json
import os
from pathlib import Path
import platform
import subprocess
import sys

MACHO = {bytes.fromhex(magic) for magic in (
    "feedface", "cefaedfe", "feedfacf", "cffaedfe", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"
)}


def inventory(root):
    files, links = [], []
    for directory, dirs, names in os.walk(root, followlinks=False):
        for name in sorted(dirs + names):
            path = Path(directory) / name
            relative = path.relative_to(root).as_posix()
            if path.is_symlink():
                links.append({"path": relative, "target": os.readlink(path)})
            elif path.is_file():
                digest = hashlib.sha256()
                with path.open("rb") as stream:
                    magic = stream.read(4)
                    digest.update(magic)
                    while chunk := stream.read(1024 * 1024):
                        digest.update(chunk)
                record = {"path": relative, "bytes": path.stat().st_size,
                          "sha256": digest.hexdigest(), "machO": magic in MACHO}
                if record["machO"]:
                    record["architectures"] = subprocess.check_output(
                        ["lipo", "-archs", str(path)], text=True
                    ).strip()
                files.append(record)
    files.sort(key=lambda file: file["path"])
    return {"platform": platform.platform(), "architecture": platform.machine(),
            "totalBytes": sum(file["bytes"] for file in files), "fileCount": len(files),
            "machOCount": sum(file["machO"] for file in files),
            "files": files, "symlinks": sorted(links, key=lambda link: link["path"])}


if __name__ == "__main__":
    result = inventory(Path(sys.argv[1]).resolve())
    Path(sys.argv[2]).write_text(json.dumps(result, indent=2) + "\n")
    print(json.dumps({k: v for k, v in result.items() if k not in ("files", "symlinks")}))
