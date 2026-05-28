"""
voice/brain.py
Async streaming client for /jarvis-stream. Yields prose deltas as they arrive
so TTS can start speaking before Claude has finished generating.
"""

import json
from dataclasses import dataclass, field
from typing import Any, AsyncIterator, Dict, List, Optional

import httpx


@dataclass
class BrainEvent:
    """One event from the streaming brain."""
    kind: str                       # speak_delta | speak_done | final | error | done
    data: Dict[str, Any] = field(default_factory=dict)


class BrainClient:
    """Calls /jarvis-stream with SSE. Cancellable via stream context."""

    def __init__(self, url: str, timeout_s: float = 30.0) -> None:
        self.url = url
        self.timeout_s = timeout_s

    async def stream(
        self,
        transcript: str,
        context: Optional[Dict[str, Any]] = None,
    ) -> AsyncIterator[BrainEvent]:
        """POST transcript + context, yield SSE events as BrainEvent objects.

        The caller can stop consuming at any time (e.g. on interrupt) — the
        httpx context manager closes the connection cleanly.
        """
        payload = {"transcript": transcript, "context": context or {}}
        headers = {"content-type": "application/json", "accept": "text/event-stream"}

        async with httpx.AsyncClient(timeout=self.timeout_s) as client:
            async with client.stream("POST", self.url, json=payload, headers=headers) as resp:
                if resp.status_code != 200:
                    err_body = (await resp.aread()).decode("utf-8", errors="replace")
                    yield BrainEvent("error", {"error": f"HTTP {resp.status_code}", "detail": err_body[:300]})
                    yield BrainEvent("done", {})
                    return

                buffer = ""
                async for chunk in resp.aiter_text():
                    buffer += chunk
                    while True:
                        boundary = buffer.find("\n\n")
                        if boundary == -1:
                            break
                        raw = buffer[:boundary]
                        buffer = buffer[boundary + 2:]
                        evt = _parse_sse(raw)
                        if evt is not None:
                            yield evt
                            if evt.kind == "done":
                                return


def _parse_sse(raw: str) -> Optional[BrainEvent]:
    """Parse a single SSE event block.

    Expected shape:
        event: speak_delta
        data: {"text":"..."}
    """
    event_name: Optional[str] = None
    data_lines: List[str] = []
    for line in raw.split("\n"):
        if not line:
            continue
        if line.startswith("event:"):
            event_name = line[6:].strip()
        elif line.startswith("data:"):
            data_lines.append(line[5:].lstrip())
    if event_name is None:
        return None
    payload_str = "\n".join(data_lines) if data_lines else "{}"
    try:
        payload = json.loads(payload_str) if payload_str else {}
    except json.JSONDecodeError:
        payload = {"raw": payload_str}
    return BrainEvent(event_name, payload)
