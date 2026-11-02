"""Minimal OpenRouter client (OpenAI-compatible chat completions with JSON output)."""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field

import httpx

OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"


class LLMError(RuntimeError):
    pass


@dataclass
class Usage:
    calls: int = 0
    prompt_tokens: int = 0
    completion_tokens: int = 0
    cost_usd: float = 0.0
    by_model: dict[str, int] = field(default_factory=dict)

    def add(self, model: str, usage: dict | None) -> None:
        self.calls += 1
        self.by_model[model] = self.by_model.get(model, 0) + 1
        if usage:
            self.prompt_tokens += int(usage.get("prompt_tokens") or 0)
            self.completion_tokens += int(usage.get("completion_tokens") or 0)
            self.cost_usd += float(usage.get("cost") or 0.0)


def parse_json_object(text: str) -> dict:
    """Parse a JSON object from model output, tolerating code fences and surrounding prose."""
    text = text.strip()
    fence = re.search(r"```(?:json)?\s*(\{.*?\})\s*```", text, re.S)
    if fence:
        text = fence.group(1)
    try:
        obj = json.loads(text)
    except json.JSONDecodeError:
        start, end = text.find("{"), text.rfind("}")
        if start < 0 or end <= start:
            raise LLMError(f"no JSON object in model output: {text[:200]!r}") from None
        try:
            obj = json.loads(text[start : end + 1])
        except json.JSONDecodeError as e:
            raise LLMError(f"invalid JSON in model output: {e}") from None
    if not isinstance(obj, dict):
        raise LLMError("model output is not a JSON object")
    return obj


class OpenRouterClient:
    def __init__(self, api_key: str, timeout_s: float = 60.0, app_name: str = "pokerogue-player"):
        if not api_key:
            raise LLMError("OPENROUTER_API_KEY is not set")
        self._client = httpx.AsyncClient(
            timeout=timeout_s,
            headers={
                "Authorization": f"Bearer {api_key}",
                "X-Title": app_name,
            },
        )
        self.usage = Usage()

    async def close(self) -> None:
        await self._client.aclose()

    async def chat_json(self, model: str, messages: list[dict], temperature: float = 0.2) -> dict:
        payload = {
            "model": model,
            "messages": messages,
            "temperature": temperature,
            "response_format": {"type": "json_object"},
            "usage": {"include": True},
        }
        resp = await self._client.post(OPENROUTER_URL, json=payload)
        if resp.status_code >= 400:
            raise LLMError(f"OpenRouter {resp.status_code}: {resp.text[:300]}")
        data = resp.json()
        self.usage.add(model, data.get("usage"))
        try:
            content = data["choices"][0]["message"]["content"] or ""
        except (KeyError, IndexError) as e:
            raise LLMError(f"unexpected OpenRouter response: {str(data)[:300]}") from e
        return parse_json_object(content)
