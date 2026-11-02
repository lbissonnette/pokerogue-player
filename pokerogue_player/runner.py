"""The main loop: poll the game for a decision point, decide, act, log."""

from __future__ import annotations

import asyncio
import json
import logging
import re
import time
from datetime import datetime, timezone
from pathlib import Path

from .config import Config
from .game import Game
from .llm import OpenRouterClient
from .policy import LLMPolicy, Policy, RulePolicy, RunMemory
from .starters import choose_team

log = logging.getLogger(__name__)

PASSIVE_KINDS = {"loading", "busy", "wait"}
# Never offered to the policy, whatever the bridge sends (the bridge filters these too).
DANGEROUS_LABEL = re.compile(r"delete|overwrite|erase|wipe|clear data|reset", re.I)
AUTO_KINDS = {"advance", "auto"}


class StopRun(Exception):
    pass


def pick_by_label(options: list[dict], *needles: str) -> dict | None:
    for needle in needles:
        for o in options:
            if needle.lower() in o["label"].lower() and not o.get("disabled"):
                return o
    return None


class Runner:
    def __init__(self, config: Config, game: Game, policy: Policy, memory: RunMemory, run_dir: Path,
                 client=None):
        self.config = config
        self.client = client
        self.game = game
        self.policy = policy
        self.memory = memory
        self.run_dir = run_dir
        self.decisions = 0
        self._log_file = (run_dir / "decisions.jsonl").open("a", encoding="utf-8")
        self._last_progress = time.monotonic()
        self._last_signature = None
        self._started_run = False
        self._title_seen = 0
        self._repeat_sig = None
        self._repeat_counts: dict[str, int] = {}
        self._login_warned = False

    def close(self) -> None:
        self._log_file.close()

    def _write(self, record: dict) -> None:
        record["ts"] = datetime.now(timezone.utc).isoformat()
        self._log_file.write(json.dumps(record, ensure_ascii=False) + "\n")
        self._log_file.flush()

    async def run(self) -> None:
        while True:
            if self.config.max_decisions is not None and self.decisions >= self.config.max_decisions:
                log.info("reached max_decisions=%d", self.config.max_decisions)
                return
            try:
                await self.step()
            except StopRun as e:
                log.info("stopping: %s", e)
                return
            await asyncio.sleep(self.config.poll_interval_s)

    async def step(self) -> None:
        d = await self.game.decision()
        kind = d.get("kind")
        await self._watchdog(d)

        if kind == "error":
            log.warning("bridge error in %s/%s: %s", d.get("phase"), d.get("handler"), d.get("error"))
            await asyncio.sleep(1)
            return
        if kind in PASSIVE_KINDS:
            return
        if kind == "login_required":
            if not self._login_warned:
                log.warning("Not logged in. Log in to pokerogue.net in the browser window; the bot will wait.")
                self._login_warned = True
            await asyncio.sleep(2)
            return
        if kind in AUTO_KINDS:
            await self._act(d, "__auto__")
            return
        if kind == "starter_select":
            await self._starters()
            return
        if kind == "save_slot":
            await self._save_slot(d)
            return
        if kind == "title" or (kind == "menu" and d.get("phase") == "TitlePhase"):
            if not d.get("options"):
                return  # menu is mid-transition (e.g. right after saving); look again next poll
            await self._title(d)
            return
        self._title_seen = 0

        options = [o for o in (d.get("options") or []) if not DANGEROUS_LABEL.search(o.get("label", ""))]
        d["options"] = options
        if not options:
            log.debug("no safe options for %s", kind)
            return

        # Loop protection: if we keep making the same choice on what is the same decision
        # (same screen, wave, turn and options), it isn't working; stop offering it.
        state = d.get("state") or {}
        battle = state.get("battle") or {}
        sig = (kind, d.get("phase"), state.get("wave"), battle.get("turn"),
               tuple(o["id"] for o in options), d.get("acting"))
        if sig != self._repeat_sig:
            self._repeat_sig, self._repeat_counts = sig, {}
        blocked = {oid for oid, n in self._repeat_counts.items() if n >= 2}
        if blocked:
            remaining = [o for o in options if o["id"] not in blocked]
            if not remaining:
                log.warning("every option in %s has failed repeatedly; backing out", kind)
                await self.game.cancel()
                self._repeat_counts = {}
                return
            log.warning("options %s keep failing in %s; excluding them", sorted(blocked), kind)
            options = remaining
            d["options"] = options

        t0 = time.monotonic()
        choice = await self.policy.choose(d)
        self._repeat_counts[choice.option_id] = self._repeat_counts.get(choice.option_id, 0) + 1
        latency = time.monotonic() - t0
        result = await self._act(d, choice.option_id)
        self.decisions += 1
        self.memory.record(d, choice)
        label = next((o["label"] for o in options if o["id"] == choice.option_id), choice.option_id)
        state = d.get("state") or {}
        log.info("[wave %s] %s -> %s (%s: %s)", state.get("wave"), kind, label, choice.source, choice.reason)
        self._write(
            {
                "kind": kind,
                "phase": d.get("phase"),
                "wave": state.get("wave"),
                "state": state,
                "options": [{"id": o["id"], "label": o["label"]} for o in options],
                "choice": choice.option_id,
                "label": label,
                "source": choice.source,
                "reason": choice.reason,
                "note": choice.note,
                "latency_s": round(latency, 2),
                "result": result,
            }
        )

    async def _act(self, d: dict, option_id: str) -> dict:
        result = await self.game.act(d["seq"], option_id)
        if not result.get("ok"):
            log.warning("action %s failed in %s/%s: %s", option_id, d.get("phase"), d.get("handler"), result)
        return result

    async def _title(self, d: dict) -> None:
        options = d.get("options") or []
        if self._started_run and d.get("kind") == "title" and d.get("handler") == "TitleUiHandler":
            # Back at the real title screen after our run: the run is over. Require it on a
            # few consecutive polls so a screen flashing by during a transition doesn't count.
            self._title_seen += 1
            if self._title_seen >= 5:
                raise StopRun("back at the title screen (run over)")
            return
        if self._started_run:
            return  # a TitlePhase menu after we've started is a transition; never re-pick
        if self.config.title_choice == "continue":
            # Never the title's "Continue": it resumes whichever slot was played last, which
            # may be one of your own runs. "Load Game" lets us pick the bot's recorded slot.
            if self._bot_slot() is None:
                raise StopRun(f"no bot-started run recorded in {self.config.state_file}; use a new run")
            o = pick_by_label(options, "Load Game")
        else:
            o = pick_by_label(options, self.config.game_mode_label, "New Game")
        if not o:
            raise StopRun(f"can't find a title option for {self.config.title_choice!r}: {[x['label'] for x in options]}")
        log.info("title: %s", o["label"])
        if self.config.game_mode_label.lower() in o["label"].lower():
            self._started_run = True
        await self._act(d, o["id"])

    def _bot_slot(self) -> int | None:
        try:
            return int(json.loads(self.config.state_file.read_text())["slot"])
        except (OSError, ValueError, KeyError, TypeError):
            return None

    def _record_bot_slot(self, slot: int) -> None:
        self.config.state_file.write_text(json.dumps({
            "slot": slot,
            "url": self.config.url,
            "started": datetime.now(timezone.utc).isoformat(),
        }))

    async def _starters(self) -> None:
        ids = self.config.starters
        reason = "from config"
        if not ids:
            info = await self.game.starter_candidates()
            if not info.get("ok"):
                raise StopRun(f"can't read starters: {info.get('error')}")
            ids, reason = await choose_team(
                info["candidates"], info.get("budget", 10), self.client,
                self.config.model_for("starters"), self.config.temperature,
            )
        log.info("choosing starters %s (%s)", ids, reason)
        self._write({"kind": "starters", "choice": ids, "reason": reason})
        result = await self.game.choose_starters(ids)
        if not result.get("ok"):
            raise StopRun(f"starter selection failed: {result.get('error')}")

    async def _save_slot(self, d: dict) -> None:
        """Pick a save slot. The bot NEVER saves over an occupied slot: it uses an empty one or
        stops. It only ever loads the slot it recorded when it started its own run."""
        options = d.get("options") or []
        if d.get("save_mode") == "SAVE":
            empty = [o for o in options if o.get("has_data") is False]
            if not empty:
                raise StopRun("every save slot is in use; the bot won't overwrite one. Free a slot to start a new run.")
            target = empty[0]
            slot = int(target["id"].split(":")[1])
        else:
            slot = self._bot_slot()
            target = next((o for o in options if o["id"] == f"slot:{slot}" and o.get("has_data")), None)
            if not target:
                raise StopRun(f"the bot's recorded run (slot {slot}) isn't there any more")
        log.info("save slot: %s", target["label"])
        result = await self._act(d, target["id"])
        if result.get("ok"):
            if d.get("save_mode") == "SAVE":
                self._record_bot_slot(slot)
            self._started_run = True

    async def _watchdog(self, d: dict) -> None:
        state = d.get("state") or {}
        signature = (d.get("kind"), d.get("phase"), d.get("handler"), state.get("wave"), state.get("battle", {}) and state["battle"].get("turn"))
        now = time.monotonic()
        if signature != self._last_signature:
            self._last_signature = signature
            self._last_progress = now
            return
        if now - self._last_progress > self.config.stall_timeout_s:
            shot = self.run_dir / f"stall-{int(now)}.png"
            await self.game.screenshot(shot)
            status = await self.game.status()
            log.error("no progress for %.0fs in %s; screenshot %s; status %s", now - self._last_progress, signature, shot, status)
            self._last_progress = now


async def play(config: Config) -> None:
    run_dir = config.log_dir / datetime.now().strftime("%Y%m%d-%H%M%S")
    run_dir.mkdir(parents=True, exist_ok=True)
    memory = RunMemory()
    client = None
    if config.use_llm:
        client = OpenRouterClient(config.api_key or "", timeout_s=config.llm_timeout_s)
        policy: Policy = LLMPolicy(client, config, memory)
    else:
        policy = RulePolicy()

    game = Game(config)
    await game.start()
    runner = Runner(config, game, policy, memory, run_dir, client)
    try:
        if not await _wait_for_scene(game):
            raise SystemExit("Could not find the game scene. Is the bridge compatible with this PokeRogue version?")
        if config.auto_settings:
            result = await game.apply_settings(config.settings)
            log.info("settings: %s", result)
            if result.get("changed"):
                await game.reload()
                if not await _wait_for_scene(game):
                    raise SystemExit("Game didn't come back after applying settings.")
        await runner.run()
    finally:
        runner.close()
        if client:
            u = client.usage
            log.info(
                "LLM usage: %d calls, %d prompt + %d completion tokens, $%.4f",
                u.calls, u.prompt_tokens, u.completion_tokens, u.cost_usd,
            )
            await client.close()
        await game.stop()


async def _wait_for_scene(game: Game, timeout_s: float = 120) -> bool:
    t0 = time.monotonic()
    while time.monotonic() - t0 < timeout_s:
        status = await game.status()
        if status.get("sceneFound"):
            log.info("bridge attached: %s", status)
            return True
        await asyncio.sleep(1)
    return False
