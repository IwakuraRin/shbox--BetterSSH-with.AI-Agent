#!/usr/bin/env python3
"""
Temporarily set wails.json \"build:dir\", run `wails build`, then restore wails.json.
Usage (from repo root):
  python3 scripts/wails-build-to-dir.py <build_dir> <platform> [extra wails args...]

Example:
  python3 scripts/wails-build-to-dir.py build/shbox_linux linux/amd64 -clean -o shbox-software
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def main() -> int:
    if len(sys.argv) < 3:
        print(__doc__.strip(), file=sys.stderr)
        return 2

    root = Path(__file__).resolve().parent.parent
    wails_path = root / "wails.json"
    build_dir = sys.argv[1]
    platform = sys.argv[2]
    extra = sys.argv[3:]

    raw = wails_path.read_text(encoding="utf-8")
    data = json.loads(raw)

    new_data = json.loads(json.dumps(data))
    new_data["build:dir"] = build_dir

    wails_path.write_text(json.dumps(new_data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    try:
        cmd = ["wails", "build", "-platform", platform, *extra]
        print("+", " ".join(cmd), flush=True)
        subprocess.check_call(cmd, cwd=root)
    finally:
        wails_path.write_text(raw, encoding="utf-8")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
