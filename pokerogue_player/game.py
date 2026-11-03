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
# `getMoveTargets(user, moveId)` is a module function (not on any object), and it's what the
# game uses to decide whether a move needs the target screen. Expose it so the bridge can
# offer "move on target" options. Function declarations are hoisted, so assigning just
# before the declaration is safe. Only patch at statement boundaries.
_MOVE_TARGETS_RE = re.compile(r"(^|[;{}\n])(\s*)function getMoveTargets\s*\(")


# Species data for "what does this evolve into": the evolution table and the species list
# are module constants. Expose them by chaining an assignment onto their declarations.
_EVOLUTIONS_RE = re.compile(r"\b(const|let|var)\s+pokemonEvolutions\s*=(?!=)")
_ALL_SPECIES_RE = re.compile(r"\b(const|let|var)\s+allSpecies\s*=(?!=)")
# Newer builds: species live in a registry set once at startup via setSpeciesDataRegistry(r).
_SPECIES_REGISTRY_RE = re.compile(r"function setSpeciesDataRegistry\s*\(\s*([\w$]+)\s*\)\s*\{")


def patch_bundle_text(body: str) -> tuple[str, list[str]]:
    """Apply the bridge hooks to one JS file. Returns the new text and the hooks applied."""
    applied = []
    if "initGlobalScene" in body:
        body, n = _INIT_SCENE_RE.subn(
            lambda m: f"function initGlobalScene({m.group(1)}){{window.__prScene={m.group(1)};", body
        )
        if n:
            applied.append("initGlobalScene")
    if "getMoveTargets" in body:
        body, n = _MOVE_TARGETS_RE.subn(
            lambda m: f"{m.group(1)}{m.group(2)}window.__prGetMoveTargets=getMoveTargets;function getMoveTargets(",
            body,
            count=1,
        )
        if n:
            applied.append("getMoveTargets")
    if "pokemonEvolutions" in body:
        body, n = _EVOLUTIONS_RE.subn(lambda m: f"{m.group(1)} pokemonEvolutions=window.__prEvolutions=", body, count=1)
        if n:
            applied.append("pokemonEvolutions")
    if "allSpecies" in body:
        body, n = _ALL_SPECIES_RE.subn(lambda m: f"{m.group(1)} allSpecies=window.__prAllSpecies=", body, count=1)
        if n:
            applied.append("allSpecies")
    if "setSpeciesDataRegistry" in body:
        body, n = _SPECIES_REGISTRY_RE.subn(
            lambda m: f"function setSpeciesDataRegistry({m.group(1)}){{window.__prSpeciesRegistry={m.group(1)};",
            body,
            count=1,
        )
        if n:
            applied.append("speciesDataRegistry")
    return body, applied


class Game:
    def __init__(self, config: Config):
        self.config = config
        self._pw = None
        self._ctx = None
        self.page = None

    async def start(self) -> None:
        from playwright.async_api import async_playwright

        log.info("launching Chromium (profile: %s)", self.config.profile_dir)
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
        self.page.on("console", self._on_console)
        log.info("opening %s", self.config.url)
        await self.page.goto(self.config.url, wait_until="domcontentloaded", timeout=90_000)
        log.info("page loaded; game is starting")

    @staticmethod
    def _on_console(msg) -> None:
        if msg.type == "error":
            log.debug("console error: %s", msg.text)

    async def _patch_bundle(self, route) -> None:
        try:
            response = await route.fetch()
            body = await response.text()
            patched, applied = patch_bundle_text(body)
            if applied:
                log.info("patched %s: %s", route.request.url.rsplit("/", 1)[-1], ", ".join(applied))
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

    async def cancel(self) -> None:
        await self._call("() => window.__prBot.cancel()")

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
