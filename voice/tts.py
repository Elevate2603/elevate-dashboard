"""
voice/tts.py
Piper TTS with sentence-streaming. Receives prose chunks, splits at sentence
boundaries, synthesizes each sentence, and queues raw int16 PCM for playback.

Public API:
  await feed_text(delta)        — append to the in-flight sentence buffer
  await end_speaking()          — flush remaining text as final sentence
  await wait_until_quiet()      — block until every queued sentence has finished playback
  is_speaking()                 — true if anything is in flight
  await cancel()                — drop everything, stop audio mid-sentence

Background tasks run synth → playback concurrently so first audio leaves the
speakers as soon as the first sentence is ready.
"""

import asyncio
import re
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np
import sounddevice as sd
from piper import PiperVoice


# Split at . ? ! \n but only when followed by space-or-end, so "Dr. Smith" stays intact.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])|\n+")


def _sanitize(text: str) -> str:
    text = re.sub(r"```[a-z]*|```", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\*\*([^*]+)\*\*", r"\1", text)
    text = re.sub(r"\*([^*]+)\*", r"\1", text)
    text = re.sub(r"`([^`]+)`", r"\1", text)
    text = re.sub(r"^#{1,6}\s+", "", text, flags=re.MULTILINE)
    return text.strip()


class TTS:
    def __init__(
        self,
        model_path: str,
        config_path: str,
        output_device: Optional[int] = None,
    ) -> None:
        self._voice = PiperVoice.load(model_path, config_path=config_path)
        self._sample_rate = self._voice.config.sample_rate
        self._output_device = output_device

        self._buffer = ""
        self._sentence_q: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
        self._audio_q: "asyncio.Queue[Optional[np.ndarray]]" = asyncio.Queue()

        # Pending-work tracking: incremented when we enqueue work, decremented after
        # playback for that sentence finishes. wait_until_quiet() awaits the event.
        self._pending = 0
        self._quiet_event = asyncio.Event()
        self._quiet_event.set()

        self._cancelled = False
        self._cancel_token = 0
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="piper")

        self._synth_task: Optional[asyncio.Task] = None
        self._play_task: Optional[asyncio.Task] = None

    # ── Public API ───────────────────────────────────────────────────────

    def is_speaking(self) -> bool:
        return self._pending > 0 or bool(self._buffer.strip())

    async def wait_until_quiet(self, timeout: float = 30.0) -> bool:
        try:
            await asyncio.wait_for(self._quiet_event.wait(), timeout=timeout)
            return True
        except asyncio.TimeoutError:
            return False

    async def start(self) -> None:
        if self._synth_task is None:
            self._synth_task = asyncio.create_task(self._synth_loop())
        if self._play_task is None:
            self._play_task = asyncio.create_task(self._play_loop())

    async def feed_text(self, delta: str) -> None:
        if self._cancelled:
            return
        await self.start()
        self._buffer += delta
        while True:
            m = _SENTENCE_BOUNDARY.search(self._buffer)
            if m is None:
                if len(self._buffer) >= 220:
                    sentence = _sanitize(self._buffer)
                    self._buffer = ""
                    if sentence:
                        await self._enqueue_sentence(sentence)
                break
            end = m.end()
            sentence = _sanitize(self._buffer[:end])
            self._buffer = self._buffer[end:]
            if sentence:
                await self._enqueue_sentence(sentence)

    async def end_speaking(self) -> None:
        if self._cancelled:
            return
        if self._buffer.strip():
            tail = _sanitize(self._buffer)
            self._buffer = ""
            if tail:
                await self._enqueue_sentence(tail)

    async def cancel(self) -> None:
        """Drop everything in flight, stop audio mid-sentence."""
        self._cancelled = True
        self._cancel_token += 1
        self._buffer = ""

        for q in (self._sentence_q, self._audio_q):
            while not q.empty():
                try: q.get_nowait()
                except asyncio.QueueEmpty: break

        sd.stop()

        self._pending = 0
        self._quiet_event.set()

        await asyncio.sleep(0.05)
        self._cancelled = False

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ── Internals ────────────────────────────────────────────────────────

    async def _enqueue_sentence(self, sentence: str) -> None:
        self._pending += 1
        self._quiet_event.clear()
        await self._sentence_q.put(sentence)

    def _decrement_pending(self) -> None:
        self._pending = max(0, self._pending - 1)
        if self._pending == 0:
            self._quiet_event.set()

    async def _synth_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while True:
            sentence = await self._sentence_q.get()
            if sentence is None:
                continue
            if self._cancelled:
                self._decrement_pending()
                continue
            token = self._cancel_token
            try:
                audio = await loop.run_in_executor(self._executor, self._synth_sentence, sentence)
            except Exception as exc:
                print(f"[tts] synth error: {exc}")
                self._decrement_pending()
                continue
            if self._cancelled or token != self._cancel_token:
                self._decrement_pending()
                continue
            if audio is not None and audio.size:
                await self._audio_q.put(audio)
            else:
                self._decrement_pending()

    def _synth_sentence(self, sentence: str) -> np.ndarray:
        parts: list[np.ndarray] = []
        for chunk in self._voice.synthesize(sentence):
            arr = getattr(chunk, "audio_int16_array", None)
            if arr is not None and arr.size:
                parts.append(arr)
        if not parts:
            return np.zeros(0, dtype=np.int16)
        return np.concatenate(parts)

    async def _play_loop(self) -> None:
        stream: Optional[sd.OutputStream] = None
        try:
            stream = sd.OutputStream(
                samplerate=self._sample_rate,
                channels=1,
                dtype="int16",
                device=self._output_device,
            )
            stream.start()

            loop = asyncio.get_running_loop()
            while True:
                audio = await self._audio_q.get()
                if audio is None:
                    continue
                if self._cancelled:
                    self._decrement_pending()
                    continue
                token = self._cancel_token
                try:
                    # stream.write blocks until the OS audio buffer accepts the data
                    # (≈ duration of the clip). When it returns, audio has finished playing.
                    await loop.run_in_executor(None, stream.write, audio)
                except Exception as exc:
                    print(f"[tts] playback error: {exc}")
                if token == self._cancel_token:
                    self._decrement_pending()
        finally:
            if stream is not None:
                try:
                    stream.stop()
                    stream.close()
                except Exception:
                    pass
