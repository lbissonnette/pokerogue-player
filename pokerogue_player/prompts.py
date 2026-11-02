"""Prompt construction for LLM decisions."""

from __future__ import annotations

import json

SYSTEM_PROMPT = """\
You are playing PokeRogue, a roguelite Pokemon battler, and your goal is to get as far as \
possible in a Classic run (wave 200 is the end). You are shown the current game state as \
JSON and a numbered list of legal options. Pick exactly one option.

Guidelines:
- Type matchups matter most. "effectiveness" is the damage multiplier the game itself \
computes for that move against that target (0 = immune, 0.5 = resisted, 2/4 = super effective).
- Same-type moves get a 1.5x bonus (STAB). Watch accuracy, PP and priority.
- Preserve HP across waves; there is no free healing between most battles. Switch out of bad \
matchups when the incoming hit is cheap to take.
- Catch Pokemon that fill a gap in the team (types, roles) or that are rare/shiny/not yet caught. \
Weaken them first if it's safe, and don't waste good balls on weak catches.
- Rewards: prioritize healing when the team is hurt, then items that permanently strengthen the \
team (EXP items, stat boosters, good held items), then everything else. Save money for revives \
and potions before boss waves (every 10 waves) when the shop is available.
- Only replace moves with clearly better ones (coverage, power, STAB).

Reply with a JSON object only:
{"action": "<option id>", "reason": "<one short sentence>", "note": "<optional short note to \
remember for later decisions, or empty>"}
"""


def _compact(obj) -> str:
    return json.dumps(obj, separators=(",", ":"), ensure_ascii=False)


def build_messages(decision: dict, notes: list[str], history: list[str]) -> list[dict]:
    state = decision.get("state") or {}
    options = [{"id": o["id"], "label": o["label"]} for o in decision.get("options", [])]
    parts = [
        f"Decision: {decision.get('kind')}",
        f"Prompt: {decision.get('prompt', '')}",
    ]
    if decision.get("new_move"):
        parts.append(f"New move: {_compact(decision['new_move'])}")
    if state:
        parts.append(f"State: {_compact(state)}")
    if notes:
        parts.append("Your notes so far:\n" + "\n".join(f"- {n}" for n in notes))
    if history:
        parts.append("Your recent decisions:\n" + "\n".join(f"- {h}" for h in history))
    parts.append("Options:\n" + "\n".join(f"{o['id']}: {o['label']}" for o in options))
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


STARTER_SYSTEM_PROMPT = """\
You are choosing the starting team for a PokeRogue Classic run (200 waves, gets much harder \
over time). Pick 1 to 6 Pokemon whose total cost is at most the budget. Good teams usually \
spend the whole budget, cover many types, and include Pokemon that evolve into strong forms. \
Pokemon marked pokerus gain experience faster.

Reply with a JSON object only:
{"starters": [<species id>, ...], "reason": "<one or two sentences>"}
"""


def build_starter_messages(candidates: list[dict], budget: int, error: str | None = None) -> list[dict]:
    lines = [
        f"{c['id']}: {c['name']} [{'/'.join(c['types'])}] cost {c['cost']} BST {c['bst']}"
        + (" pokerus" if c.get("pokerus") else "")
        for c in candidates
    ]
    content = f"Budget: {budget}\n\nAvailable starters (id: name [types] cost BST):\n" + "\n".join(lines)
    if error:
        content += f"\n\nYour previous answer was invalid: {error}. Try again."
    return [
        {"role": "system", "content": STARTER_SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]
