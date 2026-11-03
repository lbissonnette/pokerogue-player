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
- Attack options include "est. X-Y% of <enemy>'s max HP per hit" and how many hits it takes to \
KO from its current HP. Trust those numbers over your own guess (they ignore abilities, items, \
weather and crits). Only say a move will "finish" an enemy when it says "likely KO".
- Turn order: each turn the higher priority move goes first; within the same priority the \
faster Pokemon (higher Speed, "Spe") moves first (Trick Room reverses this). The command prompt \
lists the turn order and attack options say "you move first" or "<enemy> moves first, you \
attack second". When the enemy moves first, you take its hit before yours lands: a "likely \
KO" doesn't save a Pokemon the enemy can KO first, so consider switching, healing or a \
priority move. When you move first, a "likely KO" means you take no hit from that enemy. \
Speed drops/paralysis on the enemy (or boosts on you) can flip the order.
- Ball options include an estimated catch chance; weaken the target or inflict sleep/paralysis \
first when the chance is low and it's safe to do so.
- Preserve HP across waves; there is no free healing between most battles.
- Switching costs your turn and the incoming Pokemon takes the enemy's hit. Only switch when \
the switch-in clearly wins the matchup: use the "best move ... Nx" and "takes Nx" numbers in \
the switch options (computed by the game), not your own type chart. Never switch back to a \
Pokemon you just switched out of unless something changed.
- Battle start ("keep X in" or "switch to Y"): switching here is free, so treat every option \
equally and pick the Pokemon best suited to this enemy (type matchup numbers, HP, turn order, \
and an under-level-cap Pokemon for easy wild battles). Keeping the current Pokemon is not a \
safer default.
- Catching (wild battles only; the command prompt shows "party N/6"). For every wild Pokemon, \
decide: if the party has fewer than 6, catch it (weaken it first if safe). If the party is \
full, catch it only if it's shiny, or its fully evolved form ("evolves into ..., BST N" in the \
ball option; its own BST if none is listed) has a clearly higher BST (roughly 50+) than the \
fully evolved form of your \
weakest party member, or replacing a party member with it would add type coverage the team \
lacks. Otherwise just defeat it. Use the catch chance to pick the ball; save better balls \
for better targets.
- Full party after a catch: release a party member only if the new Pokemon is clearly better \
for the run by the same test: higher fully evolved BST than that member's fully evolved form, \
or type coverage the team lacks (or shiny). Release the weakest member by that measure. Never release a Pokemon \
the team relies on, or one holding valuable items.
- Level cap: "level_cap" is the highest level battle EXP can raise a Pokemon to right now; it \
rises every 10 waves. Pokemon marked "at_level_cap" gain little or no battle EXP, so aim EXP \
toward Pokemon below the cap and send under-cap Pokemon into easy battles so the whole team \
keeps up.
- Item values: Rare Candy (+1 level, even past the cap) is weak; rank it low. Lures double how \
many wild Pokemon you face, which is valuable: more EXP to reach the cap and to keep the rest of \
the party (via EXP Share) viable. Take Lures when the team is under the cap or behind.
- Rewards: if a party member has fainted, take a revive whenever one is offered (reward or \
shop) and give it to the fainted Pokemon. Otherwise prioritize healing when the team is hurt, then items that permanently strengthen the \
team (EXP items, stat boosters, good held items), then everything else. On the reward screen, \
"Coming up" lists the special waves ahead (rivals, gym leaders, evil team, Elite Four, bosses): \
before a hard one, prefer healing, revives and items that help win it, and keep money for the \
shop.
- Only replace moves with clearly better ones (coverage, power, STAB).
- Mystery encounters: read the description and each option's effect. Weigh the reward against \
the cost (HP, money, items, or losing a Pokemon) given the team's current state. Leaving is \
fine when every option is risky.

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
    partner = decision.get("partner")
    if partner:
        parts.append(
            f"Options for {decision.get('acting')} (\"action\"):\n"
            + "\n".join(f"{o['id']}: {o['label']}" for o in options)
        )
        parts.append(
            f"Options for {partner['acting']} (\"partner_action\"):\n"
            + "\n".join(f"{o['id']}: {o['label']}" for o in partner["options"])
        )
        parts.append(
            "Plan the turn for both Pokemon together: focus one enemy (e.g. to KO it before it acts) "
            "or split up, and don't both switch to the same Pokemon. If the first action throws a "
            "ball or runs, the partner action is ignored. Reply with "
            '{"action": "<id>", "partner_action": "<id>", "reason": "...", "note": "..."}.'
        )
    else:
        parts.append("Options:\n" + "\n".join(f"{o['id']}: {o['label']}" for o in options))
    return [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": "\n\n".join(parts)},
    ]


STARTER_SYSTEM_PROMPT = """\
You are choosing the starting team for a PokeRogue Classic run (200 waves, gets much harder \
over time). Pick 1 to 6 Pokemon whose total cost is at most the budget. Rules (an answer that \
breaks one is rejected): spend the whole budget if anything still fits, and no two Pokemon may \
share a type. Prefer Pokemon that evolve into strong forms. \
Pokemon marked pokerus gain experience faster: the team MUST include at least one of them when \
any is affordable.

Reply with a JSON object only:
{"starters": [<species id>, ...], "reason": "<one or two sentences>"}
"""


def _starter_line(c: dict) -> str:
    return (
        f"{c['id']}: {c['name']} [{'/'.join(c['types'])}] cost {c['cost']} BST {c['bst']}"
        + (" pokerus" if c.get("pokerus") else "")
    )


def build_starter_messages(candidates: list[dict], budget: int) -> list[dict]:
    # Pokerus first (one is required), then strongest first, so the useful choices are on top.
    ordered = sorted(candidates, key=lambda c: (not c.get("pokerus"), -c["bst"]))
    content = (
        f"Budget: {budget}\n\nAvailable starters (id: name [types] cost BST):\n"
        + "\n".join(_starter_line(c) for c in ordered)
    )
    return [
        {"role": "system", "content": STARTER_SYSTEM_PROMPT},
        {"role": "user", "content": content},
    ]


def starter_feedback(ids: list | None, candidates: list[dict], budget: int, error: str,
                     rejected: list[list[int]]) -> str:
    """Tell the model what it picked, why it's rejected, and which teams not to repeat."""
    by_id = {c["id"]: c for c in candidates}
    picked = [by_id[i] for i in ids or [] if i in by_id]
    lines = ["Your team was rejected."]
    if picked:
        total = sum(c["cost"] for c in picked)
        lines.append("You picked:\n" + "\n".join(f"- {_starter_line(c)}" for c in picked))
        lines.append(f"Total cost {total} of {budget} ({budget - total} left).")
    lines.append(f"Problem: {error}.")
    if len(rejected) > 1:
        lines.append("Already rejected, do not repeat: " + "; ".join(str(r) for r in rejected))
    lines.append(
        "Change the team to fix the problem (replace Pokemon if needed), check every rule again, "
        'and reply with the JSON object {"starters": [...], "reason": "..."}.'
    )
    return "\n".join(lines)
