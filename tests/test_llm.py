import pytest

from pokerogue_player.llm import LLMError, Usage, parse_json_object


def test_parse_plain_json():
    assert parse_json_object('{"action": "move:0"}') == {"action": "move:0"}


def test_parse_fenced_json():
    text = 'Sure!\n```json\n{"action": "switch:2", "reason": "bad matchup"}\n```'
    assert parse_json_object(text)["action"] == "switch:2"


def test_parse_json_with_prose():
    assert parse_json_object('I pick {"action": "run"} because...')["action"] == "run"


def test_parse_garbage_raises():
    with pytest.raises(LLMError):
        parse_json_object("no json here")


def test_usage_accumulates():
    u = Usage()
    u.add("m", {"prompt_tokens": 10, "completion_tokens": 5, "cost": 0.001})
    u.add("m", None)
    assert (u.calls, u.prompt_tokens, u.completion_tokens, u.by_model["m"]) == (2, 10, 5, 2)
