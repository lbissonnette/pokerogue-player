"""Decision policies: an LLM policy with a rule-based fallback."""

from __future__ import annotations

import logging
import re
from collections import deque
from dataclasses import dataclass
from typing import Protocol

from .llm import LLMError, OpenRouterClient
from .prompts import build_messages

log = logging.getLogger(__name__)


@dataclass
class Choice:
    option_id: str
    reason: str = ""
    note: str = ""
    source: str = "rule"  # "rule" | "llm" | "only" (single legal option)


class Policy(Protocol):
    async def choose(self, decision: dict) -> Choice: ...


class RunMemory:
    """Short-lived memory the LLM sees on each decision."""

    def __init__(self, max_notes: int = 12, max_history: int = 8):
        self.notes: deque[str] = deque(maxlen=max_notes)
        self.history: deque[str] = deque(maxlen=max_history)

    def record(self, decision: dict, choice: Choice) -> None:
        label = next((o["label"] for o in decision.get("options", []) if o["id"] == choice.option_id), "?")
        wave = (decision.get("state") or {}).get("wave")
        self.history.append(f"wave {wave} {decision.get('kind')}: {label}")
        if choice.note:
            self.notes.append(choice.note.strip()[:200])


_REVIVE = re.compile(r"revive|sacred ash", re.I)
_HEAL = re.compile(r"potion|restore|heal|berry juice|full heal|elixir|ether|status", re.I)


def _item_name(option: dict) -> str:
    """The item an option takes or buys ('' for reroll/skip)."""
    if option.get("item"):
        return option["item"]
    name = option.get("label", "").split(" - ", 1)[0]
    name = re.sub(r" and use it on .*$", "", name)
    name = re.sub(r"^(Take reward: |Buy )", "", name)
    return re.sub(r" for \d+$", "", name)


def _move_score(move: dict, attacker_types: list[str]) -> float:
    if move.get("category") == "STATUS" or not move.get("power") or move.get("power", 0) <= 0:
        return 0.0
    eff_values = [v for v in (move.get("effectiveness") or {}).values() if v is not None]
    eff = max(eff_values) if eff_values else 1.0
    stab = 1.5 if move.get("type") in attacker_types else 1.0
    acc = move.get("accuracy", 100)
    acc = 1.0 if acc is None or acc < 0 else acc / 100
    return move["power"] * eff * stab * acc


class RulePolicy:
    """Simple, deterministic heuristics. Used when the LLM is off, fails, or is unnecessary."""

    async def choose(self, decision: dict) -> Choice:
        options = decision.get("options") or []
        if not options:
            raise ValueError(f"decision {decision.get('kind')} has no options")
        kind = decision.get("kind")
        state = decision.get("state") or {}
        handler = getattr(self, f"_{kind}", None)
        if handler:
            picked = handler(options, decision, state)
            if picked:
                return picked
        return Choice(options[0]["id"], "default: first option")

    def _command(self, options, decision, state):
        acting = decision.get("acting")
        me = next((p for p in state.get("party", []) if p.get("name") == acting and p.get("on_field")), None)
        types = me.get("types", []) if me else []
        best, best_score = None, -1.0
        for o in options:
            if not o["id"].startswith("move:"):
                continue
            score = _move_score(o.get("move") or {}, types)
            if score > best_score:
                best, best_score = o, score
        if best:
            return Choice(best["id"], f"highest expected damage (score {best_score:.0f})")
        # No move listed: never switch "by default". Prefer anything that isn't a switch.
        other = next((o for o in options if not o["id"].startswith("switch:")), None)
        if other:
            return Choice(other["id"], "no move available; avoiding a pointless switch")
        return None

    def _party(self, options, decision, state):
        party = {f"slot:{p['slot']}": p for p in state.get("party", [])}
        members = [o for o in options if o["id"] in party]

        def frac(o):
            p = party[o["id"]]
            return p["hp"] / max(1, p["max_hp"])

        alive = [o for o in members if not party[o["id"]].get("fainted")]
        item = decision.get("item") or ""
        if item and _REVIVE.search(item):
            fainted = [o for o in members if party[o["id"]].get("fainted")]
            if fainted:
                return Choice(fainted[0]["id"], f"{item} on a fainted party member")
        if item and _HEAL.search(item) and alive:
            hurt = [o for o in alive if frac(o) < 1] or alive
            worst = min(hurt, key=frac)
            return Choice(worst["id"], f"{item} on the least healthy alive party member")
        if not alive:
            return None
        best = max(alive, key=frac)
        return Choice(best["id"], "healthiest available party member")

    def _target(self, options, decision, state):
        enemy = next((o for o in options if "(enemy)" in o["label"]), None)
        return Choice(enemy["id"], "target an enemy") if enemy else None

    def _learn_move(self, options, decision, state):
        new = decision.get("new_move") or {}
        new_power = (new.get("power") or 0) if new.get("category") != "STATUS" else 0
        forget = [o for o in options if o["id"].startswith("forget:")]

        def power(o):
            m = o.get("move") or {}
            return 0 if m.get("category") == "STATUS" else (m.get("power") or 0)

        weakest = min(forget, key=power, default=None)
        if weakest and new_power > power(weakest):
            return Choice(weakest["id"], "new move is stronger than the weakest current move")
        return Choice("keep", "current moves are at least as good")

    def _mystery(self, options, decision, state):
        # Without judgement, the last option (usually "leave" / decline) is the safest.
        return Choice(options[-1]["id"], "safest default: last option (usually leave)")

    def _modifier(self, options, decision, state):
        party = {p["slot"]: p for p in state.get("party", [])}

        def frac(o):
            p = party.get(o.get("target"))
            return p["hp"] / max(1, p["max_hp"]) if p else 1.0

        fainted = [p for p in party.values() if p.get("fainted")]
        if fainted:
            # Someone is down: a revive beats anything else on offer. Free reward first, then the shop.
            for prefix in ("reward:", "shop:"):
                revive = next(
                    (
                        o
                        for o in options
                        if o["id"].startswith(prefix)
                        and _REVIVE.search(_item_name(o))
                        and (o.get("target") is None or party.get(o["target"], {}).get("fainted", True))
                    ),
                    None,
                )
                if revive:
                    who = party.get(revive.get("target"), fainted[0]).get("name", "party member")
                    return Choice(revive["id"], f"revive for fainted {who}")
        rewards = [o for o in options if o["id"].startswith("reward:")]
        if not rewards:
            return None
        # Take the first reward; if it goes on a Pokemon, heal the one that needs it most.
        first = rewards[0]["id"].split("@", 1)[0]
        same = [o for o in rewards if o["id"].split("@", 1)[0] == first]
        if len(same) > 1 and _HEAL.search(_item_name(same[0])):
            pick = min(same, key=frac)
            return Choice(pick["id"], "take the first reward, on the least healthy Pokemon")
        return Choice(same[0]["id"], "take the first reward")


class LLMPolicy:
    def __init__(self, client: OpenRouterClient, config, memory: RunMemory, fallback: Policy | None = None):
        self.client = client
        self.config = config
        self.memory = memory
        self.fallback = fallback or RulePolicy()

    async def choose(self, decision: dict) -> Choice:
        options = decision.get("options") or []
        valid = {o["id"] for o in options}
        if len(options) == 1:
            return Choice(options[0]["id"], "only legal option", source="only")

        messages = build_messages(decision, list(self.memory.notes), list(self.memory.history))
        model = self.config.model_for(decision.get("kind", "default"))
        for attempt in range(2):
            try:
                out = await self.client.chat_json(model, messages, temperature=self.config.temperature)
            except (LLMError, Exception) as e:  # network errors, bad JSON, etc.
                log.warning("LLM call failed (attempt %d): %s", attempt + 1, e)
                continue
            action = str(out.get("action", "")).strip()
            if action in valid:
                return Choice(action, str(out.get("reason", ""))[:300], str(out.get("note", "") or ""), "llm")
            log.warning("LLM picked invalid option %r", action)
            messages = messages + [
                {"role": "assistant", "content": str(out)},
                {
                    "role": "user",
                    "content": f"'{action}' is not a valid option id. Choose one of: {', '.join(sorted(valid))}.",
                },
            ]
        choice = await self.fallback.choose(decision)
        choice.reason = f"[fallback] {choice.reason}"
        return choice
