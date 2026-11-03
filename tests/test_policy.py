from pokerogue_player.config import Config
from pokerogue_player.llm import LLMError
from pokerogue_player.policy import LLMPolicy, RulePolicy, RunMemory


def move_opt(i, name, power, type_, eff, category="SPECIAL", acc=100):
    return {
        "id": f"move:{i}",
        "label": name,
        "move": {"name": name, "power": power, "type": type_, "category": category,
                 "accuracy": acc, "effectiveness": {"Gyarados": eff}},
    }


COMMAND = {
    "kind": "command",
    "acting": "Pikachu",
    "state": {"wave": 5, "party": [{"slot": 0, "name": "Pikachu", "on_field": True, "types": ["ELECTRIC"],
                                    "hp": 30, "max_hp": 40, "fainted": False}]},
    "options": [
        move_opt(0, "Quick Attack", 40, "NORMAL", 1),
        move_opt(1, "Thunderbolt", 90, "ELECTRIC", 4),
        move_opt(2, "Growl", 0, "NORMAL", 1, category="STATUS"),
        {"id": "run", "label": "Run away"},
    ],
}


async def test_rule_picks_super_effective_stab_move():
    choice = await RulePolicy().choose(COMMAND)
    assert choice.option_id == "move:1"


async def test_rule_faint_switch_picks_healthiest():
    d = {
        "kind": "party",
        "state": {"party": [
            {"slot": 0, "hp": 0, "max_hp": 50, "fainted": True},
            {"slot": 1, "hp": 10, "max_hp": 50, "fainted": False},
            {"slot": 2, "hp": 40, "max_hp": 50, "fainted": False},
        ]},
        "options": [{"id": "slot:1", "label": "a"}, {"id": "slot:2", "label": "b"}],
    }
    assert (await RulePolicy().choose(d)).option_id == "slot:2"


async def test_rule_learn_move_replaces_weakest_only_if_better():
    def forget(i, power, cat="PHYSICAL"):
        return {"id": f"forget:{i}", "label": f"m{i}", "move": {"power": power, "category": cat}}

    d = {"kind": "learn_move", "new_move": {"power": 80, "category": "PHYSICAL"},
         "options": [forget(0, 90), forget(1, 0, "STATUS"), forget(2, 70), forget(3, 95), {"id": "keep", "label": "k"}]}
    assert (await RulePolicy().choose(d)).option_id == "forget:1"
    d["new_move"] = {"power": 0, "category": "STATUS"}
    assert (await RulePolicy().choose(d)).option_id == "keep"


class FakeClient:
    def __init__(self, outputs):
        self.outputs = list(outputs)
        self.calls = []

    async def chat_json(self, model, messages, temperature=0.2):
        self.calls.append((model, messages))
        out = self.outputs.pop(0)
        if isinstance(out, Exception):
            raise out
        return out


async def test_llm_policy_valid_choice_and_note():
    client = FakeClient([{"action": "move:0", "reason": "priority", "note": "Gyarados is slow"}])
    choice = await LLMPolicy(client, Config(api_key="x"), RunMemory()).choose(COMMAND)
    assert (choice.option_id, choice.source, choice.note) == ("move:0", "llm", "Gyarados is slow")
    user_msg = client.calls[0][1][1]["content"]
    assert "move:1: Thunderbolt" in user_msg and '"wave":5' in user_msg


async def test_llm_policy_retries_invalid_then_succeeds():
    client = FakeClient([{"action": "move:9"}, {"action": "run"}])
    choice = await LLMPolicy(client, Config(api_key="x"), RunMemory()).choose(COMMAND)
    assert choice.option_id == "run" and len(client.calls) == 2
    assert "not a valid option" in client.calls[1][1][-1]["content"]


async def test_llm_policy_falls_back_to_rules():
    client = FakeClient([LLMError("boom"), LLMError("boom")])
    choice = await LLMPolicy(client, Config(api_key="x"), RunMemory()).choose(COMMAND)
    assert choice.option_id == "move:1" and choice.reason.startswith("[fallback]")


async def test_llm_policy_skips_call_for_single_option():
    client = FakeClient([])
    d = {"kind": "party", "options": [{"id": "slot:1", "label": "only"}]}
    choice = await LLMPolicy(client, Config(api_key="x"), RunMemory()).choose(d)
    assert choice.source == "only" and not client.calls


async def test_per_kind_model_override():
    cfg = Config(api_key="x", model="cheap/model", models={"command": "smart/model"})
    client = FakeClient([{"action": "move:1"}])
    await LLMPolicy(client, cfg, RunMemory()).choose(COMMAND)
    assert client.calls[0][0] == "smart/model"


def test_memory_records_history_and_notes():
    from pokerogue_player.policy import Choice

    m = RunMemory(max_history=2)
    for i in range(3):
        m.record(COMMAND, Choice("move:1", note=f"n{i}"))
    assert len(m.history) == 2 and "Thunderbolt" in m.history[-1] and list(m.notes)[-1] == "n2"


async def test_rule_mystery_defaults_to_last_option():
    d = {"kind": "mystery", "options": [{"id": "me:0", "label": "Fight"}, {"id": "me:2", "label": "Leave"}]}
    assert (await RulePolicy().choose(d)).option_id == "me:2"


async def test_rule_command_without_moves_does_not_default_to_switch():
    d = {"kind": "command", "acting": "A", "state": {}, "options": [
        {"id": "switch:1", "label": "Switch"}, {"id": "ball:0", "label": "Ball"}, {"id": "run", "label": "Run"}]}
    assert (await RulePolicy().choose(d)).option_id == "ball:0"


def _party_state(*members):
    return {
        "party": [
            {"slot": i, "name": n, "hp": hp, "max_hp": 100, "fainted": hp == 0}
            for i, (n, hp) in enumerate(members)
        ]
    }


def _party_options(n):
    return [{"id": f"slot:{i}", "label": f"slot {i}"} for i in range(n)]


async def test_rule_potion_goes_to_least_healthy_alive():
    state = _party_state(("A", 100), ("B", 40), ("C", 0), ("D", 70))
    d = {"kind": "party", "item": "Super Potion", "state": state, "options": _party_options(4)}
    assert (await RulePolicy().choose(d)).option_id == "slot:1"


async def test_rule_revive_goes_to_fainted():
    state = _party_state(("A", 100), ("B", 40), ("C", 0))
    d = {"kind": "party", "item": "Max Revive", "state": state, "options": _party_options(3)}
    assert (await RulePolicy().choose(d)).option_id == "slot:2"


async def test_rule_faint_switch_without_item_still_healthiest():
    state = _party_state(("A", 0), ("B", 40), ("C", 90))
    d = {"kind": "party", "state": state, "options": _party_options(3)}
    assert (await RulePolicy().choose(d)).option_id == "slot:2"


def _modifier_options():
    return [
        {"id": "reward:0", "label": "Take reward: Rare Candy - Raises level"},
        {"id": "reward:1", "label": "Take reward: Revive - Revives one Pokemon"},
        {"id": "shop:0:0", "label": "Buy Max Revive for 3000 - Revives one Pokemon"},
        {"id": "skip", "label": "Skip taking a reward"},
    ]


async def test_rule_modifier_prefers_revive_when_someone_fainted():
    d = {"kind": "modifier", "state": _party_state(("A", 50), ("B", 0)), "options": _modifier_options()}
    assert (await RulePolicy().choose(d)).option_id == "reward:1"
    opts = [o for o in _modifier_options() if o["id"] != "reward:1"]
    d = {"kind": "modifier", "state": _party_state(("A", 50), ("B", 0)), "options": opts}
    assert (await RulePolicy().choose(d)).option_id == "shop:0:0"


async def test_rule_modifier_ignores_revive_when_nobody_fainted():
    d = {"kind": "modifier", "state": _party_state(("A", 50), ("B", 30)), "options": _modifier_options()}
    assert (await RulePolicy().choose(d)).option_id == "reward:0"


async def test_rule_modifier_combined_revive_and_potion_targets():
    state = _party_state(("A", 30), ("B", 80), ("C", 0))
    opts = [
        {"id": "reward:0@slot:0", "label": "Take reward: Potion and use it on A", "item": "Potion", "target": 0},
        {"id": "reward:0@slot:1", "label": "Take reward: Potion and use it on B", "item": "Potion", "target": 1},
        {"id": "shop:0:0@slot:2", "label": "Buy Revive for 400 and use it on C", "item": "Revive", "target": 2},
        {"id": "skip", "label": "Skip taking a reward"},
    ]
    d = {"kind": "modifier", "state": state, "options": opts}
    assert (await RulePolicy().choose(d)).option_id == "shop:0:0@slot:2"
    state = _party_state(("A", 30), ("B", 80), ("C", 50))
    d = {"kind": "modifier", "state": state, "options": opts[:2] + opts[3:]}
    assert (await RulePolicy().choose(d)).option_id == "reward:0@slot:0"


async def test_rule_command_with_targets_picks_best_enemy_never_ally():
    tb = {"name": "Thunderbolt", "type": "ELECTRIC", "category": "SPECIAL", "power": 90, "accuracy": 100}
    opts = [
        {"id": "move:0@target:1", "label": "on ally", "move": tb, "target": 1, "target_name": "Pal",
         "target_side": "ally", "target_effectiveness": 4},
        {"id": "move:0@target:2", "label": "on A", "move": tb, "target": 2, "target_name": "A",
         "target_side": "enemy", "target_effectiveness": 0.5},
        {"id": "move:0@target:3", "label": "on B", "move": tb, "target": 3, "target_name": "B",
         "target_side": "enemy", "target_effectiveness": 2},
    ]
    d = {"kind": "command", "acting": "Pika", "state": {"party": []}, "options": opts}
    assert (await RulePolicy().choose(d)).option_id == "move:0@target:3"


async def test_rule_catch_full_keeps_the_team():
    d = {"kind": "catch_full", "options": [{"id": "release:0", "label": "x"}, {"id": "decline", "label": "y"}]}
    assert (await RulePolicy().choose(d)).option_id == "decline"


PAIR = {
    "kind": "command",
    "acting": "Pika",
    "state": {"party": []},
    "options": [
        {"id": "move:0@target:2", "label": "Use Thunderbolt on Gyarados"},
        {"id": "switch:2", "label": "Switch to Mew"},
        {"id": "run", "label": "Run away"},
    ],
    "partner": {
        "acting": "Squirtle",
        "options": [{"id": "move:0@target:2", "label": "Use Surf on Gyarados"}, {"id": "switch:2", "label": "Switch to Mew"}],
    },
}


async def test_llm_double_battle_pair_in_one_call():
    from pokerogue_player.policy import option_label

    client = FakeClient([
        {"action": "switch:2", "partner_action": "switch:2"},
        {"action": "move:0@target:2", "partner_action": "nope"},
        {"action": "move:0@target:2", "partner_action": "move:0@target:2", "reason": "focus Gyarados"},
    ])
    cfg = Config(api_key="x")
    cfg.models = {}
    choice = await LLMPolicy(client, cfg, RunMemory()).choose(PAIR)
    # One retry per call budget is 2, so the third answer isn't reached: falls back to rules.
    assert len(client.calls) == 2
    assert "same party member" in client.calls[1][1][-1]["content"]
    assert "partner_action" in client.calls[0][1][1]["content"]
    assert "Options for Squirtle" in client.calls[0][1][1]["content"]

    client = FakeClient([{"action": "move:0@target:2", "partner_action": "move:0@target:2"}])
    choice = await LLMPolicy(client, cfg, RunMemory()).choose(PAIR)
    assert choice.option_id == "move:0@target:2+move:0@target:2"
    assert option_label(PAIR, choice.option_id) == "Use Thunderbolt on Gyarados | Squirtle: Use Surf on Gyarados"

    client = FakeClient([{"action": "run", "partner_action": "whatever"}])
    assert (await LLMPolicy(client, cfg, RunMemory()).choose(PAIR)).option_id == "run"
