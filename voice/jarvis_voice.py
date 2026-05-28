"""
voice/jarvis_voice.py
Low-latency JARVIS voice loop.

Pipeline:
    sounddevice mic
       → Silero VAD (endpoint in ~80ms after silence)
       → faster-whisper "small.en" STT
       → wake-word / direct-command gate
       → POST /jarvis-stream (SSE)
       → sentence chunker
       → Piper TTS (en_GB-cori-medium)
       → sounddevice speaker

Interrupt:
    While JARVIS is speaking, the VAD continues to listen. If a new voiced
    utterance arrives, the in-flight brain request + TTS playback are
    cancelled immediately and we re-enter LISTENING.

Run:
    python voice/jarvis_voice.py
"""

import asyncio
import re
import signal
import sys
from pathlib import Path
from typing import Any, Dict, List, Optional

from config import CONFIG
from vad import VADStream
from stt import STT
from brain import BrainClient, BrainEvent
from tts import TTS
import state as state_mod


# ────────────────────────────────────────────────────────────────────────
# Helpers
# ────────────────────────────────────────────────────────────────────────

WAKE_RE = re.compile(CONFIG.wake_pattern, re.IGNORECASE)


def has_wake_word(text: str) -> bool:
    return bool(WAKE_RE.search(text))


def strip_wake_word(text: str) -> str:
    return WAKE_RE.sub("", text, count=1).strip(" ,.?!")


def log(level: str, msg: str) -> None:
    print(f"[{level}] {msg}", flush=True)


# ────────────────────────────────────────────────────────────────────────
# Main loop
# ────────────────────────────────────────────────────────────────────────

class JarvisVoice:
    def __init__(self) -> None:
        log("init", f"loading state from {CONFIG.state_file}")
        self.state = state_mod.load(CONFIG.state_file)

        log("init", f"loading whisper {CONFIG.whisper_model} (device={CONFIG.whisper_device}, compute={CONFIG.whisper_compute_type})")
        self.stt = STT(CONFIG.whisper_model, CONFIG.whisper_device, CONFIG.whisper_compute_type)

        log("init", f"loading piper voice {Path(CONFIG.piper_voice_model).name}")
        self.tts = TTS(CONFIG.piper_voice_model, CONFIG.piper_voice_config, CONFIG.output_device)

        log("init", "loading silero VAD")
        self.vad = VADStream(
            threshold=CONFIG.vad_threshold,
            min_silence_ms=CONFIG.vad_min_silence_ms,
            min_speech_ms=CONFIG.vad_min_speech_ms,
            input_device=CONFIG.input_device,
        )

        self.brain = BrainClient(CONFIG.jarvis_url)

        self._current_brain_task: Optional[asyncio.Task] = None
        self._speaking = False
        self._shutdown = asyncio.Event()

    async def run(self) -> None:
        await self.vad.start()
        log("ready", "listening for voice. say JARVIS or just start talking — Ctrl+C to quit.")

        try:
            async for kind, payload in self.vad.events():
                if self._shutdown.is_set():
                    break

                if kind == "speech_start":
                    # If JARVIS is mid-sentence, the user interrupted.
                    if self._speaking:
                        log("evt", "user voice detected during speech — interrupting JARVIS")
                        await self._interrupt()

                elif kind == "speech_end":
                    if payload is None or payload.size == 0:
                        continue
                    text = await self.stt.transcribe(payload)
                    if not text:
                        continue
                    log("user", text)
                    await self._handle_utterance(text)
        finally:
            await self._shutdown_clean()

    # ── Utterance handling ────────────────────────────────────────────

    async def _handle_utterance(self, text: str) -> None:
        """Decide if this transcript should go to the brain, then stream the reply."""
        # If we were speaking, the speech_start handler already cancelled. Move on.
        # Gate: either wake word OR we're already in an active conversation.
        # Active conversation = last assistant turn within recent history.
        in_convo = self._is_in_active_conversation()
        wake = has_wake_word(text)
        if not wake and not in_convo:
            log("gate", "no wake word + not in active convo — ignoring")
            return

        cleaned = strip_wake_word(text) if wake else text
        if not cleaned:
            # Bare "Jarvis" → quick acknowledge
            cleaned = "(Travis just said your name with no follow-up command — acknowledge briefly and ask what he wants.)"

        self.state.append_turn("user", text, CONFIG.history_max)

        ctx: Dict[str, Any] = {
            "history": self.state.history,
            "memoryFacts": self.state.memory_facts,
            "activeAgent": "jarvis",
        }

        if self._current_brain_task and not self._current_brain_task.done():
            self._current_brain_task.cancel()

        self._current_brain_task = asyncio.create_task(self._run_brain_turn(cleaned, ctx))

    async def _run_brain_turn(self, transcript: str, context: Dict[str, Any]) -> None:
        self._speaking = True
        full_speak = ""
        final_payload: Dict[str, Any] = {}

        try:
            async for evt in self.brain.stream(transcript, context):
                if evt.kind == "speak_delta":
                    delta = evt.data.get("text", "")
                    if delta:
                        full_speak += delta
                        await self.tts.feed_text(delta)
                elif evt.kind == "speak_done":
                    await self.tts.end_speaking()
                elif evt.kind == "final":
                    final_payload = evt.data or {}
                elif evt.kind == "error":
                    err = (evt.data or {}).get("error", "unknown error")
                    log("brain-err", err)
                    await self.tts.feed_text(f"Brain hiccup: {err}. ")
                    await self.tts.end_speaking()
                elif evt.kind == "done":
                    break

            # Wait for TTS to finish actually speaking before we stop "speaking" state
            await self._wait_for_tts_done()

            if full_speak:
                self.state.append_turn("assistant", full_speak, CONFIG.history_max)
            mem = final_payload.get("memory") if final_payload else None
            if isinstance(mem, list):
                self.state.add_memory(mem, CONFIG.memory_max)
            state_mod.save(CONFIG.state_file, self.state)
            if final_payload:
                log("assistant", f"agent={final_payload.get('agent')} action={final_payload.get('action')}")
        except asyncio.CancelledError:
            log("brain", "cancelled mid-stream")
            raise
        except Exception as exc:
            log("brain-exc", str(exc))
        finally:
            self._speaking = False

    async def _wait_for_tts_done(self) -> None:
        # Poll briefly until the TTS queues drain.
        for _ in range(600):  # cap ~30s
            if not self.tts.is_speaking():
                return
            await asyncio.sleep(0.05)

    async def _interrupt(self) -> None:
        if self._current_brain_task and not self._current_brain_task.done():
            self._current_brain_task.cancel()
        await self.tts.cancel()
        self._speaking = False

    def _is_in_active_conversation(self) -> bool:
        """Heuristic: if the last assistant turn was recent (within current session), allow no-wake replies."""
        # We don't store timestamps right now — simplest: always require wake word.
        # Refine later by tracking last-turn time in memory.
        return False

    # ── Shutdown ─────────────────────────────────────────────────────

    def request_shutdown(self) -> None:
        self._shutdown.set()

    async def _shutdown_clean(self) -> None:
        log("shutdown", "stopping...")
        try: self.vad.stop()
        except Exception: pass
        try:
            if self._current_brain_task and not self._current_brain_task.done():
                self._current_brain_task.cancel()
            await self.tts.cancel()
        except Exception: pass
        try: self.stt.close()
        except Exception: pass
        try: self.tts.close()
        except Exception: pass
        state_mod.save(CONFIG.state_file, self.state)
        log("shutdown", "done")


# ────────────────────────────────────────────────────────────────────────
# Entrypoint
# ────────────────────────────────────────────────────────────────────────

async def amain() -> None:
    jarvis = JarvisVoice()

    # Graceful Ctrl+C on Windows: asyncio's add_signal_handler isn't supported, so we
    # rely on KeyboardInterrupt bubbling and the finally clause handling cleanup.
    try:
        await jarvis.run()
    except KeyboardInterrupt:
        jarvis.request_shutdown()


def main() -> None:
    # Verify Piper model files exist before we start.
    for p in (CONFIG.piper_voice_model, CONFIG.piper_voice_config):
        if not Path(p).exists():
            print(f"\nMISSING: {p}", file=sys.stderr)
            print("Run: python voice/setup_voice.py", file=sys.stderr)
            sys.exit(1)

    try:
        asyncio.run(amain())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
