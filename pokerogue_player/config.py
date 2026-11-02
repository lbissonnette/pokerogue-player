"""Runtime configuration. Everything can be set from the CLI or environment."""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_URL = "https://pokerogue.net/"
DEFAULT_MODEL = "anthropic/claude-haiku-4.5"

# Values mirror pokerogue's settings enums (src/system/settings/default-settings.ts).
BOT_SETTINGS = {
    "general": {
        "gameSpeed": 5,  # GameSpeed.TURBO
        "battleStyle": 1,  # BattleStyle.SET: no "switch Pokemon?" prompt before trainer sends
        "enableTutorials": False,
        "expGainsSpeed": 3,  # ExpGainsSpeed.SKIP
        "hpBarSpeed": 3,  # HpBarSpeed.SKIP
        "partyExpNotificationMode": 2,  # ExpNotification.SKIP
        "skipSeenDialogues": True,
    },
    "display": {"enableMoveAnimations": False},
}


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
    # "new": start a new Classic run in an EMPTY save slot (the bot never overwrites saves).
    # "continue": resume the run the bot itself started last time (recorded in state_file).
    title_choice: str = "new"
    game_mode_label: str = "Classic"
    # National dex numbers. None = let the LLM (or, without an LLM, a simple heuristic) pick.
    starters: list[int] | None = None
    state_file: Path = Path(".bot-state.json")

    # Loop control.
    poll_interval_s: float = 0.15
    max_decisions: int | None = None
    stall_timeout_s: float = 90.0
    use_llm: bool = True

    log_dir: Path = Path("runs")

    # Change in-game settings (in this browser profile) so the bot plays fast and
    # isn't interrupted. Applied once at startup, then the page reloads.
    auto_settings: bool = True
    settings: dict = field(default_factory=lambda: dict(BOT_SETTINGS))

    def model_for(self, kind: str) -> str:
        return self.models.get(kind, self.model)
