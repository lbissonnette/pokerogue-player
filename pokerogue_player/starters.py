"""Choosing a starting team."""

from __future__ import annotations

import logging

from .llm import LLMError
from .prompts import build_starter_messages

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
    return None


def _knapsack(candidates: list[dict], budget: int, max_size: int) -> tuple[int, list[int]]:
    # best[(cost, count)] = (bst_total, ids)
    best: dict[tuple[int, int], tuple[int, list[int]]] = {(0, 0): (0, [])}
    for c in sorted(candidates, key=lambda c: c["id"]):
        if c["cost"] <= 0 or c["cost"] > budget:
            continue
        for (cost, count), (bst, ids) in list(best.items()):
            nc, nn = cost + c["cost"], count + 1
            if nc > budget or nn > max_size:
                continue
            cand = (bst + c["bst"], ids + [c["id"]])
            if cand[0] > best.get((nc, nn), (-1, []))[0]:
                best[(nc, nn)] = cand
    return max(best.values(), key=lambda v: v[0])


def heuristic_team(candidates: list[dict], budget: int) -> list[int]:
    """Maximise total base stats within the budget and party size, including a Pokerus
    starter when one is affordable."""
    if not pokerus_required(candidates, budget):
        return _knapsack(candidates, budget, MAX_PARTY)[1]
    best: tuple[int, list[int]] = (-1, [])
    for p in candidates:
        if not p.get("pokerus") or not 0 < p["cost"] <= budget:
            continue
        rest = [c for c in candidates if c["id"] != p["id"]]
        bst, ids = _knapsack(rest, budget - p["cost"], MAX_PARTY - 1)
        if bst + p["bst"] > best[0]:
            best = (bst + p["bst"], [p["id"]] + ids)
    return best[1]


async def choose_team(candidates: list[dict], budget: int, client=None, model: str | None = None,
                      temperature: float = 0.2) -> tuple[list[int], str]:
    """Ask the LLM for a team (two tries), falling back to the heuristic."""
    if client is not None and candidates:
        error = None
        for _ in range(2):
            try:
                out = await client.chat_json(model, build_starter_messages(candidates, budget, error),
                                             temperature=temperature)
            except (LLMError, Exception) as e:
                log.warning("starter LLM call failed: %s", e)
                continue
            ids = out.get("starters")
            if isinstance(ids, list):
                ids = [int(i) for i in ids if str(i).lstrip("-").isdigit()]
            error = validate_team(ids, candidates, budget)
            if error is None:
                return ids, str(out.get("reason", ""))[:300]
            log.warning("LLM starter team invalid: %s", error)
    return heuristic_team(candidates, budget), "[fallback] highest total base stats within budget"
