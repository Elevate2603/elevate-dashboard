"""
voice/config.py
Single config object loaded from .env. Everything else imports this.
"""

import os
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

from dotenv import load_dotenv

# Load voice/.env (does nothing if missing — we fall back to defaults)
_VOICE_DIR = Path(__file__).resolve().parent
load_dotenv(_VOICE_DIR / ".env")


def _int_or_none(val: Optional[str]) -> Optional[int]:
    if val is None or val.strip() == "":
        return None
    try:
        return int(val)
    except ValueError:
        return None


def _resolve_path(env_var: str, fallback: Path) -> str:
    """Read a path from env; if it's relative, resolve against the repo root."""
    raw = os.getenv(env_var)
    if not raw:
        return str(fallback)
    p = Path(raw)
    if not p.is_absolute():
        # Relative paths in .env are anchored to the repo root (parent of voice/)
        p = (_VOICE_DIR.parent / p).resolve()
    return str(p)


@dataclass
class Config:
    # Brain
    jarvis_url: str = os.getenv("JARVIS_URL", "https://elevate-sales-nav.netlify.app/jarvis-stream")

    # STT
    whisper_model: str = os.getenv("WHISPER_MODEL", "small.en")
    whisper_device: str = os.getenv("WHISPER_DEVICE", "auto")
    whisper_compute_type: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")

    # VAD
    vad_threshold: float = float(os.getenv("VAD_THRESHOLD", "0.5"))
    vad_min_silence_ms: int = int(os.getenv("VAD_MIN_SILENCE_MS", "350"))
    vad_min_speech_ms: int = int(os.getenv("VAD_MIN_SPEECH_MS", "200"))

    # TTS — paths in .env may be relative to repo root; resolve to absolute
    piper_voice_model: str = _resolve_path(
        "PIPER_VOICE_MODEL", _VOICE_DIR / "models" / "en_GB-cori-medium.onnx"
    )
    piper_voice_config: str = _resolve_path(
        "PIPER_VOICE_CONFIG", _VOICE_DIR / "models" / "en_GB-cori-medium.onnx.json"
    )

    # Audio
    sample_rate_in: int = 16000              # Whisper + Silero both want 16 kHz
    sample_rate_out: int = 22050             # Piper en_GB-cori-medium default
    input_device: Optional[int] = _int_or_none(os.getenv("INPUT_DEVICE"))
    output_device: Optional[int] = _int_or_none(os.getenv("OUTPUT_DEVICE"))

    # Wake-word — same regex shape as the browser side
    wake_pattern: str = r"\b(j[aeo]rv[iy]s+t?|g[aeo]rv[iy]s+|h[ae]rv[iy]s+|jervic)\b"

    # State store (history + memory facts) — keeps Travis's voice path in sync with browser
    state_file: Path = _VOICE_DIR / "state.json"
    history_max: int = 60
    memory_max: int = 50


CONFIG = Config()
