"""
voice/state.py
Persistent conversation history + memory facts. Mirrors the localStorage layer
in the browser dashboard so JARVIS keeps memory regardless of which client Travis used.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Dict, List


@dataclass
class State:
    history: List[Dict[str, str]] = field(default_factory=list)  # [{role, text}]
    memory_facts: List[str] = field(default_factory=list)

    def append_turn(self, role: str, text: str, max_turns: int) -> None:
        if not text or not text.strip():
            return
        self.history.append({"role": role, "text": text.strip()})
        if len(self.history) > max_turns:
            self.history = self.history[-max_turns:]

    def add_memory(self, facts: List[str], max_facts: int) -> None:
        if not facts:
            return
        existing = {f.lower() for f in self.memory_facts}
        for fact in facts:
            if not fact or not isinstance(fact, str):
                continue
            f = fact.strip()
            if f and f.lower() not in existing:
                self.memory_facts.append(f)
                existing.add(f.lower())
        if len(self.memory_facts) > max_facts:
            self.memory_facts = self.memory_facts[-max_facts:]


def load(path: Path) -> State:
    if not path.exists():
        return State()
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
        return State(
            history=list(data.get("history", [])),
            memory_facts=list(data.get("memory_facts", [])),
        )
    except (json.JSONDecodeError, OSError):
        return State()


def save(path: Path, state: State) -> None:
    try:
        path.write_text(
            json.dumps(
                {"history": state.history, "memory_facts": state.memory_facts},
                ensure_ascii=False,
                indent=2,
            ),
            encoding="utf-8",
        )
    except OSError as exc:
        print(f"[state] save failed: {exc}")
