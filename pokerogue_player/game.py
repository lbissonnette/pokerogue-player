"""Playwright wrapper around the PokeRogue tab and the injected bridge."""

from __future__ import annotations

import logging
import re
from pathlib import Path
from typing import Any
from urllib.parse import urlparse

from .config import Config

log = logging.getLogger(__name__)

BRIDGE_JS = Path(__file__).with_name("bridge.js")

# Fallback hook: PokeRogue is built with keepNames, so `initGlobalScene` keeps its name in
# the production bundle. If the Object.prototype trap in bridge.js ever stops working
# (e.g. a Phaser change), this exposes the scene by patching that one function.
_INIT_SCENE_RE = re.compile(r"function initGlobalScene\s*\(\s*([\w$]+)\s*\)\s*\{")


class Game:
    def __init__(self, config: Config):
        self.config = config
        self._pw = None
        self._ctx = None
        self.page = None

    async def start(self) -> None:
        from playwright.async_api import async_playwright

        self._pw = await async_playwright().start()
        self._ctx = await self._pw.chromium.launch_persistent_context(
            user_data_dir=str(self.config.profile_dir),
            headless=self.config.headless,
            viewport={"width": 1280, "height": 720},
        )
        await self._ctx.add_init_script(path=str(BRIDGE_JS))
        self.page = self._ctx.pages[0] if self._ctx.pages else await self._ctx.new_page()
        host = re.escape(urlparse(self.config.url).netloc)
        await self.page.route(re.compile(rf"^https?://{host}/.*\.js(\?.*)?$"), self._patch_bundle)
        self.page.on("pageerror", lambda e: log.debug("page error: %s", e))
        await self.page.goto(self.config.url, wait_until="domcontentloaded")

    async def _patch_bundle(self, route) -> None:
        try:
            response = await route.fetch()
            body = await response.text()
            if "initGlobalScene" not in body:
                await route.fulfill(response=response, body=body)
                return
            patched, n = _INIT_SCENE_RE.subn(
                lambda m: f"function initGlobalScene({m.group(1)}){{window.__prScene={m.group(1)};", body
            )
            if n:
                log.debug("patched initGlobalScene in %s", route.request.url)
            await route.fulfill(response=response, body=patched)
        except Exception:  # never block the game from loading
            log.exception("bundle patch failed; continuing unpatched")
            await route.continue_()

    async def stop(self) -> None:
        if self._ctx:
            await self._ctx.close()
        if self._pw:
            await self._pw.stop()

    async def _call(self, expr: str, arg: Any = None) -> Any:
        return await self.page.evaluate(expr, arg)

    async def status(self) -> dict:
        return await self._call("() => window.__prBot ? window.__prBot.status() : {sceneFound: false}")

    async def decision(self) -> dict:
        return await self._call(
            "(o) => window.__prBot.getDecision(o)", {"revealHidden": self.config.reveal_hidden}
        )

    async def act(self, seq: int, option_id: str) -> dict:
        return await self._call("([s, id]) => window.__prBot.act(s, id)", [seq, option_id])

    async def choose_starters(self, species_ids: list[int]) -> dict:
        return await self._call("(ids) => window.__prBot.chooseStarters(ids)", species_ids)

    async def starter_candidates(self) -> dict:
        return await self._call("() => window.__prBot.starterCandidates()")

    async def apply_settings(self, desired: dict) -> dict:
        return await self._call("(d) => window.__prBot.applySettings(d)", desired)

    async def reload(self) -> None:
        await self.page.reload(wait_until="domcontentloaded")

    async def screenshot(self, path: Path) -> None:
        path.parent.mkdir(parents=True, exist_ok=True)
        await self.page.screenshot(path=str(path))
