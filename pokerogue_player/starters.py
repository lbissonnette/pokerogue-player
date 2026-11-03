"""Choosing a starting team."""

from __future__ import annotations

import json
import logging

from .llm import LLMError
from .prompts import build_starter_messages, starter_feedback

log = logging.getLogger(__name__)

MAX_PARTY = 6


def pokerus_required(candidates: list[dict], budget: int) -> bool:
    """A team must include a Pokerus starter whenever one is affordable."""
    return any(c.get("pokerus") and 0 < c["cost"] <= budget for c in candidates)


def validate_team(ids: list, candidates: list[dict], budget: int) -> str | None:
    """Return an error message, or None if `ids` is a legal team."""
    by_id = {c["id"]: c for c in candidates}
    if not isinstance(ids, list) or not ids:
        return "starters must be a non-empty list of species ids"
    if len(ids) > MAX_PARTY:
        return f"at most {MAX_PARTY} starters"
    if len(set(ids)) != len(ids):
        return "duplicate starters"
    unknown = [i for i in ids if i not in by_id]
    if unknown:
        return f"not available: {unknown}"
    cost = sum(by_id[i]["cost"] for i in ids)
    if cost > budget:
        return f"total cost {cost} exceeds budget {budget}"
    if pokerus_required(candidates, budget) and not any(by_id[i].get("pokerus") for i in ids):
        return "the team must include at least one Pokemon marked pokerus"
    seen: dict[str, str] = {}
    for i in ids:
        for t in by_id[i]["types"]:
            if t in seen:
                return (
                    f"{seen[t]} and {by_id[i]['name']} are both {t} type; every starter must have "
                    "different types so the team covers more matchups"
                )
            seen[t] = by_id[i]["name"]
    left = budget - cost
    if len(ids) < MAX_PARTY and left > 0:
        fillers = [
            c for c in candidates
            if c["id"] not in ids and 0 < c["cost"] <= left and not set(c["types"]) & seen.keys()
        ]
        if fillers:
            best = max(fillers, key=lambda c: c["bst"])
            return (
                f"{left} of the {budget} points are unspent; spend the whole budget "
                f"(for example, add {best['name']} for {best['cost']}, or swap for stronger Pokemon)"
            )
    return None


def _knapsack(candidates: list[dict], budget: int, max_size: int, used_types=frozenset(),
              keep: int = 40) -> tuple[int, list[int]]:
    """Best total BST within budget and size, with no two Pokemon sharing a type.

    Keeps the `keep` best partial teams per (cost, size), so it's a close approximation
    rather than exhaustive, which is plenty for picking a fallback team."""
    best: dict[tuple[int, int], list[tuple[int, list[int], frozenset]]] = {(0, 0): [(0, [], frozenset(used_types))]}
    for c in sorted(candidates, key=lambda c: c["id"]):
        if c["cost"] <= 0 or c["cost"] > budget:
            continue
        ctypes = frozenset(c["types"])
        for (cost, count), teams in list(best.items()):
            nc, nn = cost + c["cost"], count + 1
            if nc > budget or nn > max_size:
                continue
            for bst, ids, types in list(teams):
                if ctypes & types:
                    continue
                slot = best.setdefault((nc, nn), [])
                slot.append((bst + c["bst"], ids + [c["id"]], types | ctypes))
                slot.sort(key=lambda t: -t[0])
                del slot[keep:]
    bst, ids, _ = max((t for teams in best.values() for t in teams), key=lambda t: t[0])
    return bst, ids


def heuristic_team(candidates: list[dict], budget: int) -> list[int]:
    """Maximise total base stats within the budget and party size, with no shared types,
    including a Pokerus starter when one is affordable."""
    if not pokerus_required(candidates, budget):
        return _knapsack(candidates, budget, MAX_PARTY)[1]
    best: tuple[int, list[int]] = (-1, [])
    for p in candidates:
        if not p.get("pokerus") or not 0 < p["cost"] <= budget:
            continue
        rest = [c for c in candidates if c["id"] != p["id"]]
        bst, ids = _knapsack(rest, budget - p["cost"], MAX_PARTY - 1, frozenset(p["types"]))
        if bst + p["bst"] > best[0]:
            best = (bst + p["bst"], [p["id"]] + ids)
    return best[1]


async def choose_team(candidates: list[dict], budget: int, client=None, model: str | None = None,
                      temperature: float = 0.2) -> tuple[list[int], str]:
    """Ask the LLM for a team (three tries, each told what was wrong), falling back to the
    heuristic."""
    if client is not None and candidates:
        # One conversation: each retry shows the model its own answer and what was wrong
        # with it, so it fixes the team instead of repeating it.
        messages = build_starter_messages(candidates, budget)
        rejected: list[list[int]] = []
        for _ in range(3):
            try:
                out = await client.chat_json(model, messages, temperature=temperature)
            except (LLMError, Exception) as e:
                log.warning("starter LLM call failed: %s", e)
                continue
            ids = out.get("starters")
            if isinstance(ids, list):
                ids = [int(i) for i in ids if str(i).lstrip("-").isdigit()]
            error = validate_team(ids, candidates, budget)
            if error is None:
                return ids, str(out.get("reason", ""))[:300]
            log.warning("LLM starter team %s invalid: %s", ids, error)
            rejected.append(ids if isinstance(ids, list) else [])
            messages = messages + [
                {"role": "assistant", "content": json.dumps(out)},
                {"role": "user", "content": starter_feedback(ids, candidates, budget, error, rejected)},
            ]
    return heuristic_team(candidates, budget), "[fallback] highest total base stats within budget"
