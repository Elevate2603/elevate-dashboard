"""
voice/stt.py
faster-whisper wrapper. Transcribe(audio_np) → str.

Heavy CPU/GPU work runs in an executor thread so it doesn't block the asyncio loop.
"""

import asyncio
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np
from faster_whisper import WhisperModel


class STT:
    def __init__(self, model_size: str = "small.en", device: str = "auto", compute_type: str = "int8") -> None:
        # device="auto" picks CUDA if available, else CPU.
        # compute_type="int8" keeps CPU latency under ~500ms for typical utterances.
        self._model = WhisperModel(model_size, device=device, compute_type=compute_type)
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="whisper")

    async def transcribe(self, audio: np.ndarray, language: str = "en") -> str:
        """Audio is mono float32 at 16 kHz."""
        if audio is None or audio.size == 0:
            return ""
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(self._executor, self._sync_transcribe, audio, language)

    def _sync_transcribe(self, audio: np.ndarray, language: str) -> str:
        segments, _ = self._model.transcribe(
            audio,
            language=language,
            beam_size=1,                  # greedy = ~30% faster, fine for conversational
            vad_filter=False,             # we already VAD'd upstream
            condition_on_previous_text=False,
        )
        return " ".join(s.text.strip() for s in segments).strip()

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)
