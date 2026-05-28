"""
voice/tts.py
Piper TTS with sentence-streaming. Receives prose chunks, splits at sentence
boundaries, synthesizes each sentence, and queues raw int16 PCM for playback.

Two coroutines:
  feed_text(delta)        — append to the in-flight sentence buffer
  end_speaking()          — flush remaining text as final sentence
  cancel()                — drop everything, stop audio mid-sentence

A background task runs synth → playback as fast as Piper produces it.
"""

import asyncio
import re
import threading
from concurrent.futures import ThreadPoolExecutor
from typing import Optional

import numpy as np
import sounddevice as sd
from piper import PiperVoice


# Split at . ? ! \n but only when followed by space-or-end, so "Dr. Smith" stays intact.
_SENTENCE_BOUNDARY = re.compile(r"(?<=[.!?])\s+(?=[A-Z0-9\"'(])|\n+")

# Per-delta markdown sanitization — what we couldn't do server-side
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

        self._buffer = ""                                    # in-flight sentence text
        self._sentence_q: "asyncio.Queue[Optional[str]]" = asyncio.Queue()
        self._audio_q: "asyncio.Queue[Optional[np.ndarray]]" = asyncio.Queue()
        self._cancelled = False
        self._cancel_token = 0                               # bumped on every cancel
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="piper")

        # Background tasks (started on first feed)
        self._synth_task: Optional[asyncio.Task] = None
        self._play_task: Optional[asyncio.Task] = None

    # ── Public API ───────────────────────────────────────────────────────

    def is_speaking(self) -> bool:
        return (
            not self._sentence_q.empty()
            or not self._audio_q.empty()
            or self._buffer.strip() != ""
            or (self._synth_task is not None and not self._synth_task.done())
            or (self._play_task is not None and not self._play_task.done())
        )

    async def start(self) -> None:
        if self._synth_task is None:
            self._synth_task = asyncio.create_task(self._synth_loop())
        if self._play_task is None:
            self._play_task = asyncio.create_task(self._play_loop())

    async def feed_text(self, delta: str) -> None:
        """Append streaming text. Auto-flushes any complete sentences."""
        if self._cancelled:
            return
        await self.start()
        self._buffer += delta
        # Pull off any complete sentences from the buffer
        while True:
            m = _SENTENCE_BOUNDARY.search(self._buffer)
            if m is None:
                # If buffer is getting long with no boundary, force a flush after ~120 chars
                if len(self._buffer) >= 220:
                    sentence = self._buffer
                    self._buffer = ""
                    sentence = _sanitize(sentence)
                    if sentence:
                        await self._sentence_q.put(sentence)
                break
            end = m.end()
            sentence = self._buffer[:end]
            self._buffer = self._buffer[end:]
            sentence = _sanitize(sentence)
            if sentence:
                await self._sentence_q.put(sentence)

    async def end_speaking(self) -> None:
        """Flush whatever is in the buffer as the last sentence."""
        if self._cancelled:
            return
        if self._buffer.strip():
            tail = _sanitize(self._buffer)
            self._buffer = ""
            if tail:
                await self._sentence_q.put(tail)
        # Signal end-of-stream to the synth loop
        await self._sentence_q.put(None)

    async def cancel(self) -> None:
        """Drop everything in flight, stop audio mid-sentence."""
        self._cancelled = True
        self._cancel_token += 1
        self._buffer = ""

        # Drain queues
        for q in (self._sentence_q, self._audio_q):
            while not q.empty():
                try: q.get_nowait()
                except asyncio.QueueEmpty: break

        # Send None to wake any awaiting consumer so it can re-check cancellation
        await self._sentence_q.put(None)
        await self._audio_q.put(None)

        # Stop sounddevice immediately
        sd.stop()

        # Reset for next turn
        await asyncio.sleep(0.05)  # give playback loop a beat to bail out
        self._cancelled = False

    def close(self) -> None:
        self._executor.shutdown(wait=False, cancel_futures=True)

    # ── Internals ────────────────────────────────────────────────────────

    async def _synth_loop(self) -> None:
        """Pull sentences, synthesize via Piper in a thread, enqueue audio."""
        loop = asyncio.get_running_loop()
        while True:
            sentence = await self._sentence_q.get()
            if sentence is None:
                # End-of-stream marker; signal playback to drain.
                await self._audio_q.put(None)
                continue
            if self._cancelled:
                continue
            token = self._cancel_token
            try:
                audio = await loop.run_in_executor(self._executor, self._synth_sentence, sentence)
            except Exception as exc:
                print(f"[tts] synth error: {exc}")
                continue
            if self._cancelled or token != self._cancel_token:
                continue
            if audio is not None and audio.size:
                await self._audio_q.put(audio)

    def _synth_sentence(self, sentence: str) -> np.ndarray:
        """Run Piper synchronously (called from executor thread)."""
        raw = bytearray()
        for chunk in self._voice.synthesize_stream_raw(sentence):
            raw.extend(chunk)
        if not raw:
            return np.zeros(0, dtype=np.int16)
        return np.frombuffer(bytes(raw), dtype=np.int16)

    async def _play_loop(self) -> None:
        """Pull audio chunks, push to sounddevice OutputStream."""
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
                    continue
                token = self._cancel_token
                try:
                    # stream.write is blocking — run in executor so cancel can interrupt
                    await loop.run_in_executor(None, stream.write, audio)
                except Exception as exc:
                    print(f"[tts] playback error: {exc}")
                if token != self._cancel_token:
                    # cancellation happened mid-write; sd.stop() already fired
                    continue
        finally:
            if stream is not None:
                try:
                    stream.stop()
                    stream.close()
                except Exception:
                    pass
