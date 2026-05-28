"""
voice/setup_voice.py
Bootstrap: downloads the en_GB-cori-medium Piper voice + copies .env.example to .env.

Run once after `pip install -r voice/requirements.txt`:

    python voice/setup_voice.py
"""

import os
import shutil
import sys
import urllib.request
from pathlib import Path

VOICE_DIR = Path(__file__).resolve().parent
MODELS_DIR = VOICE_DIR / "models"
ENV_FILE = VOICE_DIR / ".env"
ENV_EXAMPLE = VOICE_DIR / ".env.example"

VOICE_NAME = "en_GB-cori-medium"
BASE_URL = "https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_GB/cori/medium"
FILES = [
    f"{VOICE_NAME}.onnx",
    f"{VOICE_NAME}.onnx.json",
]


def download(url: str, dest: Path) -> None:
    if dest.exists() and dest.stat().st_size > 0:
        print(f"  already present: {dest.name}")
        return
    print(f"  fetching {dest.name} ...", end=" ", flush=True)
    tmp = dest.with_suffix(dest.suffix + ".part")
    try:
        with urllib.request.urlopen(url, timeout=60) as resp:
            total = int(resp.headers.get("content-length", 0))
            with open(tmp, "wb") as f:
                read = 0
                while True:
                    chunk = resp.read(64 * 1024)
                    if not chunk:
                        break
                    f.write(chunk)
                    read += len(chunk)
                    if total:
                        pct = read * 100 // total
                        print(f"\r  fetching {dest.name} ... {pct}% ({read//1024} KB)", end="", flush=True)
        tmp.rename(dest)
        print(f"\r  fetched {dest.name} ({dest.stat().st_size//1024} KB){' '*20}")
    except Exception as exc:
        if tmp.exists():
            tmp.unlink()
        print(f"FAILED: {exc}")
        sys.exit(1)


def main() -> None:
    print("JARVIS voice setup")
    print("==================\n")

    MODELS_DIR.mkdir(parents=True, exist_ok=True)
    print(f"Downloading Piper voice: {VOICE_NAME}")
    for fname in FILES:
        download(f"{BASE_URL}/{fname}", MODELS_DIR / fname)

    print()
    if not ENV_FILE.exists():
        if ENV_EXAMPLE.exists():
            shutil.copy2(ENV_EXAMPLE, ENV_FILE)
            print(f"Created {ENV_FILE.relative_to(VOICE_DIR.parent)} from .env.example")
        else:
            print("No .env.example found — skipping .env scaffold")
    else:
        print(f"{ENV_FILE.name} already present — leaving as-is")

    print("\nDone.")
    print("Next:")
    print("  1. Edit voice/.env if you need to change the Netlify URL or device indices.")
    print("  2. Run: python voice/jarvis_voice.py")


if __name__ == "__main__":
    main()
