"""
voice/vad.py
Silero VAD + sounddevice mic capture. Produces an async stream of events:
  ("speech_start", None)
  ("speech_chunk", np.float32 chunk at 16 kHz)
  ("speech_end",  np.float32 full utterance buffer)

Silero operates on 512-sample chunks at 16 kHz (32 ms windows).
"""

import asyncio
import queue
import threading
from typing import AsyncIterator, Optional, Tuple

import numpy as np
import sounddevice as sd
from silero_vad import load_silero_vad, VADIterator


CHUNK_SAMPLES = 512  # required by Silero at 16 kHz
SAMPLE_RATE = 16000


class VADStream:
    """Async wrapper over sounddevice + Silero VAD.

    Use:
        vad = VADStream(threshold=0.5, min_silence_ms=350)
        await vad.start()
        async for event in vad.events():
            ...
    """

    def __init__(
        self,
        threshold: float = 0.5,
        min_silence_ms: int = 350,
        min_speech_ms: int = 200,
        input_device: Optional[int] = None,
    ) -> None:
        self.threshold = threshold
        self.min_silence_ms = min_silence_ms
        self.min_speech_ms = min_speech_ms
        self.input_device = input_device
        self._loop: Optional[asyncio.AbstractEventLoop] = None
        self._raw_q: "queue.Queue[np.ndarray]" = queue.Queue(maxsize=200)
        self._evt_q: "asyncio.Queue[Tuple[str, Optional[np.ndarray]]]" = asyncio.Queue()
        self._stream: Optional[sd.InputStream] = None
        self._worker: Optional[threading.Thread] = None
        self._stop = threading.Event()
        # Loaded lazily so the import is cheap
        self._model = load_silero_vad()
        self._vad = VADIterator(self._model, threshold=threshold, sampling_rate=SAMPLE_RATE)

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()

        def callback(indata, frames, time_info, status):  # noqa: ARG001
            # Mono float32 input. sounddevice gives us shape (frames, 1).
            try:
                self._raw_q.put_nowait(indata[:, 0].copy())
            except queue.Full:
                pass  # drop frame rather than block the audio thread

        self._stream = sd.InputStream(
            samplerate=SAMPLE_RATE,
            channels=1,
            dtype="float32",
            blocksize=CHUNK_SAMPLES,
            callback=callback,
            device=self.input_device,
        )
        self._stream.start()

        self._worker = threading.Thread(target=self._worker_loop, daemon=True)
        self._worker.start()

    def stop(self) -> None:
        self._stop.set()
        if self._stream is not None:
            self._stream.stop()
            self._stream.close()
            self._stream = None
        if self._worker is not None:
            self._worker.join(timeout=1.0)

    def _emit(self, event: Tuple[str, Optional[np.ndarray]]) -> None:
        if self._loop is None:
            return
        self._loop.call_soon_threadsafe(self._evt_q.put_nowait, event)

    def _worker_loop(self) -> None:
        """Pull mic chunks, run VAD, push speech_start / chunk / end events."""
        active = False
        utterance: list[np.ndarray] = []
        silence_run = 0
        speech_run = 0
        min_silence_chunks = max(1, self.min_silence_ms * SAMPLE_RATE // 1000 // CHUNK_SAMPLES)
        min_speech_chunks = max(1, self.min_speech_ms * SAMPLE_RATE // 1000 // CHUNK_SAMPLES)

        while not self._stop.is_set():
            try:
                chunk = self._raw_q.get(timeout=0.2)
            except queue.Empty:
                continue

            # Silero's VADIterator returns dict on start/end transitions.
            speech_prob = float(self._model(chunk, SAMPLE_RATE))
            is_speech = speech_prob >= self.threshold

            if is_speech:
                silence_run = 0
                speech_run += 1
                if not active and speech_run >= min_speech_chunks:
                    active = True
                    # Include the priming chunks so we don't clip the first phoneme
                    utterance = [chunk]
                    self._emit(("speech_start", None))
                elif active:
                    utterance.append(chunk)
                    self._emit(("speech_chunk", chunk))
            else:
                speech_run = 0
                if active:
                    utterance.append(chunk)
                    silence_run += 1
                    if silence_run >= min_silence_chunks:
                        # Endpoint reached
                        full = np.concatenate(utterance) if utterance else np.zeros(0, dtype=np.float32)
                        self._emit(("speech_end", full))
                        active = False
                        utterance = []
                        silence_run = 0
                        self._vad.reset_states()

    async def events(self) -> AsyncIterator[Tuple[str, Optional[np.ndarray]]]:
        while True:
            evt = await self._evt_q.get()
            yield evt
