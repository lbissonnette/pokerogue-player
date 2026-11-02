# pokerogue-player

Plays [PokeRogue](https://pokerogue.net) on pokerogue.net with an LLM making the decisions, through
[OpenRouter](https://openrouter.ai).

A Playwright-controlled Chromium opens pokerogue.net with your own (persistent) login. A small
script injected into the page (`pokerogue_player/bridge.js`) reads the game's live state: party,
movesets with PP, HP, status, stat stages, enemies, weather, money and items. It also works out
which decision the game is waiting on and lists the legal options. The Python harness sends that
to the model, checks the answer is one of the legal options, and performs it. If the model fails
it falls back to simple rules. Text boxes and animations are advanced automatically.

The design and the reasoning behind it (including why this isn't built on Google ADK) are in the
[design doc](https://claude.ai/artifact/4bZS492s8kni63XZMMbtqx).

## Setup

```bash
python -m venv .venv && source .venv/bin/activate
pip install -e '.[dev]'
playwright install chromium

cp .env.example .env   # then put your OpenRouter key in .env (it's git-ignored)
```

Log in once. The browser profile is kept in `.browser-profile/`, so later runs stay logged in:

```bash
pokerogue-player login
```

Recommended in-game settings (set once, by hand): **Game Speed** 5x, **Battle Style** Set, and
tutorials off. The bot works without them, just slower.

## Usage

```bash
# Continue the run in progress (default)
pokerogue-player play

# Start a new Classic run with Charmander, Squirtle and Bulbasaur (national dex numbers)
pokerogue-player play --new --starters 4,7,1

# Choose models: a cheap one for battle turns, a stronger one for rewards and move learning
pokerogue-player play --model some/cheap-model --model-for modifier=some/strong-model --model-for learn_move=some/strong-model

# No LLM at all, rules only (handy for checking the plumbing)
pokerogue-player play --no-llm --max-decisions 20

# Watch what the bridge sees without acting
pokerogue-player inspect
```

Each run writes `runs/<timestamp>/decisions.jsonl` (state, options, choice, reasoning, source)
plus screenshots when the bot gets stuck. Token usage and cost are logged at the end.

By default the model only sees what a human would see: enemy HP as a percentage and only enemy
moves that have been used. `--reveal-hidden` gives it exact HP, natures and full enemy movesets.

Save slots are never overwritten unless you pass `--allow-overwrite-save`.

## What it handles today

| Situation | Who decides |
|---|---|
| Battle turn: move, switch, Poké Ball, run | LLM (rules fallback) |
| Target selection in double battles | LLM |
| Replacement after a faint | LLM |
| Reward / shop / reroll / skip, and which Pokémon gets an item | LLM |
| Learning a move when the moveset is full | LLM |
| Biome choice and other yes/no or option menus | LLM |
| Title screen, starter selection, save slot | Config |
| "Switch before the next trainer Pokémon?" | Always no |
| Mystery encounters | First option (to be improved) |
| Text, animations, evolutions | Auto-advance |

## How it reads the game

PokeRogue's production build keeps class and function names (`keepNames`), so the bridge can
find the `BattleScene` and call the same UI handlers and phase methods the game's own test suite
uses (`CommandPhase.handleCommand`, `PartyUiHandler.processInput`, ...). It finds the scene in
two ways: a one-shot `Object.prototype.sys` setter that catches Phaser's scene construction, and,
as a fallback, a patch to `initGlobalScene` in the bundle as it's downloaded. The small enum tables
it needs (types, statuses, natures, biomes) are mirrored at the top of `bridge.js`. If PokeRogue
changes those, update them there.

## Development

```bash
pytest                              # Python: policy, LLM parsing, runner, CLI
node --test tests/bridge.test.mjs   # bridge.js against a fake game scene
```
