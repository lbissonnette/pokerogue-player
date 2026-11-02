import pytest

from pokerogue_player.config import Config
from pokerogue_player.policy import RulePolicy, RunMemory
from pokerogue_player.runner import Runner, StopRun


class FakeGame:
    def __init__(self, decisions):
        self.decisions = list(decisions)
        self.acts = []
        self.starters = None

    async def decision(self):
        return self.decisions.pop(0)

    async def act(self, seq, option_id):
        self.acts.append((seq, option_id))
        return {"ok": True}

    async def choose_starters(self, ids):
        self.starters = ids
        return {"ok": True}

    async def screenshot(self, path):
        pass

    async def status(self):
        return {}


def make_runner(tmp_path, decisions, **cfg):
    game = FakeGame(decisions)
    return Runner(Config(api_key="x", **cfg), game, RulePolicy(), RunMemory(), tmp_path), game


async def test_auto_and_decision_flow(tmp_path):
    runner, game = make_runner(tmp_path, [
        {"kind": "advance", "seq": 1},
        {"kind": "loading", "seq": 2},
        {"kind": "command", "seq": 3, "acting": "A", "state": {"wave": 1, "party": []},
         "options": [{"id": "run", "label": "Run"}]},
    ])
    for _ in range(3):
        await runner.step()
    runner.close()
    assert game.acts == [(1, "__auto__"), (3, "run")]
    assert '"choice": "run"' in (tmp_path / "decisions.jsonl").read_text()


async def test_title_new_game_then_stop_when_back_at_title(tmp_path):
    title = {"kind": "title", "phase": "TitlePhase", "options": [
        {"id": "opt:0", "label": "Continue"}, {"id": "opt:1", "label": "New Game"}]}
    modes = {"kind": "menu", "phase": "TitlePhase", "options": [
        {"id": "opt:0", "label": "Classic"}, {"id": "opt:1", "label": "Daily Run"}]}
    runner, game = make_runner(tmp_path, [dict(title, seq=1), dict(modes, seq=2), dict(title, seq=9)])
    runner.config.title_choice = "new"
    await runner.step()
    await runner.step()
    assert game.acts == [(1, "opt:1"), (2, "opt:0")]
    with pytest.raises(StopRun):
        await runner.step()


async def test_save_slot_never_overwrites_by_default(tmp_path):
    full = {"kind": "save_slot", "seq": 1, "save_mode": "SAVE",
            "options": [{"id": "slot:0", "label": "1", "has_data": True}]}
    runner, game = make_runner(tmp_path, [full, dict(full, seq=2, options=full["options"] + [
        {"id": "slot:1", "label": "2", "has_data": False}])])
    with pytest.raises(StopRun):
        await runner.step()
    await runner.step()
    assert game.acts == [(2, "slot:1")]


async def test_starter_select_uses_config(tmp_path):
    runner, game = make_runner(tmp_path, [{"kind": "starter_select", "seq": 1}], starters=[25])
    await runner.step()
    assert game.starters == [25]
