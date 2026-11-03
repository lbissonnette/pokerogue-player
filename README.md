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

After that, a run is fully hands-off: the bot picks the starters, makes every decision and
performs every input until the run ends. On startup it also switches this browser profile's
game settings to bot-friendly values (5x speed, Battle Style "Set", tutorials and EXP/HP-bar
animations off) and reloads once. Pass `--no-auto-settings` to leave your settings alone.

## Usage

```bash
# Start a new Classic run in an empty save slot; the LLM picks the starting team
pokerogue-player play

# ...or pick the team yourself (national dex numbers)
pokerogue-player play --starters 4,7,1

# Resume the run the bot started last time (never one of yours)
pokerogue-player play --continue

# Choose models: a cheap one for battle turns, a stronger one for rewards and move learning
pokerogue-player play --model some/cheap-model --model-for modifier=some/strong-model --model-for learn_move=some/strong-model

# Thinking level (xhigh, high, medium, low, minimal, none, or a token count). A bare level is
# the default for every model; MODEL=LEVEL sets one model. Also settable as
# OPENROUTER_REASONING in .env, e.g. OPENROUTER_REASONING=low,google/gemini-3.5-flash-lite=high
pokerogue-player play --reasoning google/gemini-3.5-flash-lite=high --reasoning google/gemini-3.5-flash=low

# No LLM at all, rules only (handy for checking the plumbing)
pokerogue-player play --no-llm --max-decisions 20

# Watch what the bridge sees without acting
pokerogue-player inspect
```

Each run writes `runs/<timestamp>/decisions.jsonl` (state, options, choice, reasoning, source)
plus screenshots when the bot gets stuck. Token usage and cost are logged at the end.

By default the model only sees what a human would see: enemy HP as a percentage and only enemy
moves that have been used. `--reveal-hidden` gives it exact HP, natures and full enemy movesets.

### Your save files are never touched

- A new run only ever goes into an **empty** save slot. If all slots are full, the bot stops
  and tells you; there is no option to override this.
- The bridge refuses to press Action on an occupied slot while saving, even if asked to.
- Anything that appears over the save-slot screen is answered by fixed rules and never reaches
  the LLM: the "overwrite this save?" confirmation is always answered **No**, and the slot menu
  (Load / Rename / Delete) is cancelled unless the bot is loading its own run.
- Any menu option labelled delete / overwrite / erase / reset is removed before the LLM sees the
  options, and is refused if anything tries to select it (checked in both Python and the bridge).
- The bot never uses the title screen's "Continue" (it resumes whichever slot you played last).
  `--continue` uses "Load Game" and only loads the slot recorded in `.bot-state.json` when the
  bot started its run.

## What it handles today

| Situation | Who decides |
|---|---|
| Battle turn: move, switch, Poké Ball, run. In doubles both Pokémon are planned in one call (`action` + `partner_action`) | LLM (rules fallback) |
| Target selection in double battles: offered as "move on target" options in the battle turn, so move and target are one decision | LLM |
| Replacement after a faint | LLM |
| Reward / shop / reroll / skip. Items used on a Pokémon are offered as "item on Pokémon" pairs (only targets the item would affect), so the item and target are one decision | LLM |
| Learning a move when the moveset is full | LLM |
| Biome choice and other yes/no or option menus | LLM |
| Starting team (10-point budget, always includes a Pokérus starter when one is affordable, no two starters share a type, the whole budget is spent if anything still fits; rejected teams are retried with the reason) | LLM (best-stats fallback), or `--starters` |
| Title screen, save slot | Fixed rules: new run in an empty slot, or `--continue` the bot's own run |
| "Switch before the next trainer Pokémon?" | Turned off via Battle Style "Set" |
| Mystery encounters (description, each option and its effect; disabled options hidden) | LLM (fallback: last option, usually leave) |
| Text, animations, evolutions | Auto-advance |

## How it reads the game

PokeRogue's production build keeps class and function names (`keepNames`), so the bridge can
find the `BattleScene` and call the same UI handlers and phase methods the game's own test suite
uses (`CommandPhase.handleCommand`, `PartyUiHandler.processInput`, ...). It finds the scene in
two ways: a one-shot `Object.prototype.sys` setter that catches Phaser's scene construction, and,
as a fallback, a patch to `initGlobalScene` in the bundle as it's downloaded. The same patch
exposes the game's `getMoveTargets`, which says whether a move needs a target in doubles. The small enum tables
it needs (types, statuses, natures, biomes) are mirrored at the top of `bridge.js`. If PokeRogue
changes those, update them there.

## Development

```bash
pytest                              # Python: policy, LLM parsing, runner, CLI
node --test tests/bridge.test.mjs   # bridge.js against a fake game scene
```
