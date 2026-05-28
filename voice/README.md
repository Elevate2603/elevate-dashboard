# JARVIS Voice — Ultra-low-latency Python loop

Runs alongside the browser dashboard. Same JARVIS brain, far faster perceived response.

| Stage | Browser path | This path |
|---|---|---|
| Endpoint detection | Chrome SpeechRecognition (~1.5s silence) | Silero VAD (~80ms) |
| STT | Chrome cloud STT | faster-whisper `small.en` local (~300–600ms) |
| Brain | Non-streaming Claude (waits for full reply) | Streaming SSE via `/jarvis-stream` (first token ~300ms) |
| TTS | Browser SpeechSynthesis (waits for full text) | Piper `en_GB-cori-medium` per-sentence streaming |
| **Time-to-first-word** | ~2.5–5 s | **~600–900ms** |

## One-time setup

```powershell
# 1. Install Python deps
pip install -r voice/requirements.txt

# 2. Download the Piper voice + scaffold .env
python voice/setup_voice.py

# 3. (Optional) edit voice/.env if you need to change device indices or model
```

## Run it

```powershell
python voice/jarvis_voice.py
```

You'll see:

```
[init] loading state from C:\...\voice\state.json
[init] loading whisper small.en ...
[init] loading piper voice en_GB-cori-medium.onnx
[init] loading silero VAD
[ready] listening for voice. say JARVIS or just start talking — Ctrl+C to quit.
```

Say "Jarvis, what's the daily report" — first audio should hit the speakers under a second.

## Interrupt

Just start talking while JARVIS is speaking. The VAD picks up your voice, the brain stream + TTS playback are cancelled mid-sentence, and your new utterance becomes the next turn.

## State

`voice/state.json` holds conversation history + extracted memory facts.
This file is the Python-side mirror of the browser's localStorage memory.
Delete it to start fresh.

## Tuning latency

Edit `voice/.env`:

- `WHISPER_MODEL=tiny.en` — fastest STT, slightly less accurate
- `WHISPER_COMPUTE_TYPE=int8` — fastest CPU path (default)
- `VAD_MIN_SILENCE_MS=250` — more aggressive endpoint (may cut off long pauses)
- `VAD_THRESHOLD=0.4` — more sensitive (catches quieter speech)

## Choosing audio devices

```powershell
python -m sounddevice
```

Note the index of your mic and speakers, then set `INPUT_DEVICE` and `OUTPUT_DEVICE` in `.env`.

## What this DOESN'T do (yet)

- **No dashboard UI rendering.** When JARVIS replies with a `stats_modal` or `daily_report` directive, the Python loop just speaks it. To see the visual popup, use the browser tab.
- **No echo cancellation.** If your speakers are loud, the mic may pick up JARVIS's voice and trigger a false interrupt. Use headphones or a directional mic for cleanest interaction. The VAD threshold raises during speech to reduce this, but Windows AEC at the OS level is the real fix.
- **No song playback.** "Good morning Jarvis" → Fortunate Son only plays in the browser tab.

## Architecture notes

- `vad.py` runs sounddevice in callback mode → daemon thread → asyncio queue. Audio capture never blocks the event loop.
- `stt.py` runs faster-whisper in a single executor thread (model is heavy to load, cheap to call).
- `brain.py` uses `httpx.AsyncClient` for true streaming SSE.
- `tts.py` has two concurrent loops: **synth** (sentence → audio) and **playback** (audio → speakers). Either can be cancelled with `sd.stop()` for sub-100ms interrupt response.
- All four stages can be in flight at once: VAD chunking the *next* utterance, STT finishing the *previous* one, brain streaming *this* reply's tail, TTS playing *this* reply's head.
