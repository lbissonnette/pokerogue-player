from pokerogue_player.llm import LLMError
from pokerogue_player.starters import choose_team, heuristic_team, validate_team

CANDS = [
    {"id": 1, "name": "Bulbasaur", "types": ["GRASS", "POISON"], "cost": 3, "bst": 318},
    {"id": 4, "name": "Charmander", "types": ["FIRE"], "cost": 3, "bst": 309},
    {"id": 7, "name": "Squirtle", "types": ["WATER"], "cost": 3, "bst": 314},
    {"id": 147, "name": "Dratini", "types": ["DRAGON"], "cost": 5, "bst": 300},
    {"id": 10, "name": "Caterpie", "types": ["BUG"], "cost": 1, "bst": 195},
]


def test_validate_team():
    assert validate_team([1, 4, 7, 10], CANDS, 10) is None
    assert "unspent" in validate_team([1, 4, 7], CANDS, 10)
    assert "exceeds" in validate_team([1, 4, 147], CANDS, 10)
    assert "duplicate" in validate_team([1, 1], CANDS, 10)
    assert "not available" in validate_team([25], CANDS, 10)
    assert validate_team([], CANDS, 10)


def test_heuristic_maximises_bst_within_budget():
    team = heuristic_team(CANDS, 10)
    assert validate_team(team, CANDS, 10) is None
    assert sorted(team) == [1, 4, 7, 10]  # 3+3+3+1 = 10, highest total BST


class FakeClient:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    async def chat_json(self, model, messages, temperature=0.2):
        self.calls.append(messages)
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


async def test_llm_team_with_retry_on_invalid():
    client = FakeClient([{"starters": [147, 1, 4]}, {"starters": [147, 7, 10], "reason": "dragon + water"}])
    ids, reason = await choose_team(CANDS, 10, client, "m")
    assert ids == [147, 7, 10] and reason == "dragon + water"
    assert "exceeds budget" in client.calls[1][1]["content"]


async def test_llm_failure_falls_back():
    ids, reason = await choose_team(CANDS, 10, FakeClient([LLMError("x"), LLMError("y")]), "m")
    assert sorted(ids) == [1, 4, 7, 10] and reason.startswith("[fallback]")


PKRS = [dict(c) for c in CANDS]
PKRS[3]["pokerus"] = True  # Dratini


def test_pokerus_required_in_validation_and_heuristic():
    assert "pokerus" in validate_team([1, 4, 7], PKRS, 10)
    assert validate_team([147, 7, 10], PKRS, 10) is None
    team = heuristic_team(PKRS, 10)
    assert 147 in team and validate_team(team, PKRS, 10) is None


def test_pokerus_not_required_when_unaffordable():
    cands = [dict(c) for c in CANDS]
    cands[3]["cost"] = 11
    cands[3]["pokerus"] = True
    assert validate_team([1, 4, 7, 10], cands, 10) is None


async def test_llm_is_retried_when_it_skips_pokerus():
    client = FakeClient([{"starters": [1, 4, 7]}, {"starters": [147, 1, 10]}])
    ids, _ = await choose_team(PKRS, 10, client, "m")
    assert ids == [147, 1, 10] and "pokerus" in client.calls[1][1]["content"]


def test_shared_types_are_rejected_and_avoided_by_the_heuristic():
    cands = CANDS + [{"id": 393, "name": "Piplup", "types": ["WATER"], "cost": 3, "bst": 314}]
    err = validate_team([7, 393, 4, 10], cands, 10)
    assert "both WATER" in err
    team = heuristic_team(cands, 10)
    assert validate_team(team, cands, 10) is None
    assert not {7, 393} <= set(team)


async def test_llm_gets_three_tries_with_the_reason():
    client = FakeClient([{"starters": [7]}, {"starters": [1, 4]}, {"starters": [1, 4, 7, 10]}])
    ids, _ = await choose_team(CANDS, 10, client, "m")
    assert ids == [1, 4, 7, 10]
    assert "unspent" in client.calls[1][1]["content"] and "unspent" in client.calls[2][1]["content"]
