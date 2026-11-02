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
    assert validate_team([1, 4, 7], CANDS, 10) is None
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
    client = FakeClient([{"starters": [147, 1, 4]}, {"starters": [147, 7], "reason": "dragon + water"}])
    ids, reason = await choose_team(CANDS, 10, client, "m")
    assert ids == [147, 7] and reason == "dragon + water"
    assert "exceeds budget" in client.calls[1][1]["content"]


async def test_llm_failure_falls_back():
    ids, reason = await choose_team(CANDS, 10, FakeClient([LLMError("x"), LLMError("y")]), "m")
    assert sorted(ids) == [1, 4, 7, 10] and reason.startswith("[fallback]")
