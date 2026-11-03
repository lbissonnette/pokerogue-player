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


def test_parse_reasoning_default_and_per_model():
    from pokerogue_player.llm import parse_reasoning, reasoning_param

    levels = parse_reasoning("low, google/gemini-3.5-flash-lite=HIGH")
    assert levels == {"*": "low", "google/gemini-3.5-flash-lite": "high"}
    assert reasoning_param(levels, "google/gemini-3.5-flash-lite") == {"effort": "high", "exclude": True}
    assert reasoning_param(levels, "google/gemini-3.5-flash") == {"effort": "low", "exclude": True}
    assert reasoning_param(parse_reasoning("m=2000"), "m") == {"max_tokens": 2000, "exclude": True}
    assert reasoning_param({}, "m") is None
    with pytest.raises(ValueError):
        parse_reasoning("m=extreme")


async def test_reasoning_is_sent_only_for_configured_models():
    import httpx

    from pokerogue_player.llm import OpenRouterClient

    sent = []

    def handler(request):
        import json as _json

        sent.append(_json.loads(request.content))
        return httpx.Response(200, json={"choices": [{"message": {"content": '{"action": "run"}'}}]})

    client = OpenRouterClient("k", reasoning={"a/lite": "high"})
    client._client = httpx.AsyncClient(transport=httpx.MockTransport(handler))
    await client.chat_json("a/lite", [])
    await client.chat_json("a/full", [])
    await client.close()
    assert sent[0]["reasoning"] == {"effort": "high", "exclude": True}
    assert "reasoning" not in sent[1]
