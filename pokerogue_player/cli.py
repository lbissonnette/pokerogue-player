"""Command line entry point: `pokerogue-player play|inspect|login`."""

from __future__ import annotations

import argparse
import asyncio
import json
import logging
import os
from pathlib import Path

from .config import DEFAULT_URL, Config


def load_dotenv(path: Path = Path(".env")) -> None:
    """Load KEY=VALUE lines from .env without overriding variables already set."""
    if not path.is_file():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


def _parse_models(values: list[str]) -> dict[str, str]:
    out = {}
    for v in values:
        kind, _, model = v.partition("=")
        if not model:
            raise argparse.ArgumentTypeError(f"--model-for expects KIND=MODEL, got {v!r}")
        out[kind] = model
    return out


def build_config(args: argparse.Namespace) -> Config:
    cfg = Config(url=args.url, profile_dir=Path(args.profile), headless=args.headless)
    if getattr(args, "model", None):
        cfg.model = args.model
    if getattr(args, "model_for", None):
        cfg.models = _parse_models(args.model_for)
    for name in ("reveal_hidden", "max_decisions"):
        if hasattr(args, name) and getattr(args, name) is not None:
            setattr(cfg, name, getattr(args, name))
    if getattr(args, "resume", False):
        cfg.title_choice = "continue"
    if getattr(args, "starters", None):
        cfg.starters = [int(x) for x in args.starters.split(",")]
    if getattr(args, "no_llm", False):
        cfg.use_llm = False
    if getattr(args, "no_auto_settings", False):
        cfg.auto_settings = False
    return cfg


async def _inspect(cfg: Config) -> None:
    from .game import Game

    game = Game(cfg)
    await game.start()
    try:
        print("Waiting for the game to load. Press Ctrl+C to quit.")
        last = None
        while True:
            d = await game.decision()
            summary = (d.get("kind"), d.get("phase"), d.get("handler"))
            if summary != last:
                last = summary
                print(json.dumps(d, indent=2)[:6000])
                print("-" * 60)
            await asyncio.sleep(1)
    finally:
        await game.stop()


async def _login(cfg: Config) -> None:
    from .game import Game

    game = Game(cfg)
    await game.start()
    print("Log in to pokerogue.net in the browser window, then close it (or press Ctrl+C here).")
    try:
        while not game.page.is_closed():
            await asyncio.sleep(1)
    finally:
        await game.stop()


def main(argv: list[str] | None = None) -> None:
    p = argparse.ArgumentParser(prog="pokerogue-player", description="Play PokeRogue with an LLM.")
    p.add_argument("--url", default=DEFAULT_URL)
    p.add_argument("--profile", default=".browser-profile", help="Browser profile dir (keeps you logged in)")
    p.add_argument("--headless", action="store_true")
    p.add_argument("-v", "--verbose", action="store_true")
    sub = p.add_subparsers(dest="cmd", required=True)

    play = sub.add_parser("play", help="Play the game")
    play.add_argument("--model", help="OpenRouter model id (default: $OPENROUTER_MODEL)")
    play.add_argument("--model-for", action="append", metavar="KIND=MODEL",
                      help="Per-decision model override, e.g. modifier=some/model (repeatable)")
    play.add_argument("--no-llm", action="store_true", help="Use only the rule-based policy")
    play.add_argument("--continue", dest="resume", action="store_true",
                      help="Resume the run the bot started last time (default: start a new run in an empty slot)")
    play.add_argument("--starters", help="Comma-separated national dex numbers, e.g. 4,7,1 (default: LLM picks)")
    play.add_argument("--no-auto-settings", action="store_true",
                      help="Don't change game speed/tutorial/battle-style settings")
    play.add_argument("--reveal-hidden", action="store_true", help="Show the model hidden enemy info")
    play.add_argument("--max-decisions", type=int)

    sub.add_parser("inspect", help="Print what the bridge sees, without acting")
    sub.add_parser("login", help="Open the browser so you can log in once")

    args = p.parse_args(argv)
    load_dotenv()
    logging.basicConfig(
        level=logging.DEBUG if args.verbose else logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
    )
    cfg = build_config(args)
    try:
        if args.cmd == "play":
            from .runner import play as run_play

            asyncio.run(run_play(cfg))
        elif args.cmd == "inspect":
            asyncio.run(_inspect(cfg))
        elif args.cmd == "login":
            asyncio.run(_login(cfg))
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
