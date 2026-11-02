"""Runtime configuration. Everything can be set from the CLI or environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_URL = "https://pokerogue.net/"
DEFAULT_MODEL = "anthropic/claude-haiku-4.5"


@dataclass
class Config:
    url: str = DEFAULT_URL
    # A persistent browser profile keeps you logged in to pokerogue.net between runs.
    profile_dir: Path = Path(".browser-profile")
    headless: bool = False

    # OpenRouter. The key is read from the environment and never written anywhere.
    api_key: str | None = field(default_factory=lambda: os.environ.get("OPENROUTER_API_KEY"))
    model: str = field(default_factory=lambda: os.environ.get("OPENROUTER_MODEL", DEFAULT_MODEL))
    # Optional per-decision-kind overrides, e.g. {"modifier": "some/stronger-model"}.
    models: dict[str, str] = field(default_factory=dict)
    temperature: float = 0.2
    llm_timeout_s: float = 60.0

    # What the model is allowed to see. False = only what a human player sees.
    reveal_hidden: bool = False

    # Run setup.
    title_choice: str = "continue"  # "continue" an existing run, or "new" (Classic)
    game_mode_label: str = "Classic"
    starters: list[int] = field(default_factory=lambda: [4, 7, 1])  # Charmander, Squirtle, Bulbasaur
    allow_overwrite_save: bool = False

    # Loop control.
    poll_interval_s: float = 0.15
    max_decisions: int | None = None
    stall_timeout_s: float = 90.0
    use_llm: bool = True

    log_dir: Path = Path("runs")

    def model_for(self, kind: str) -> str:
        return self.models.get(kind, self.model)
