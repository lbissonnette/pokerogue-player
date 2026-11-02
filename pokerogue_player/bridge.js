/*
 * PokeRogue bot bridge.
 *
 * Injected into pokerogue.net by Playwright (as an init script, before the game's
 * own code runs). It finds the game's BattleScene, then exposes:
 *
 *   window.__prBot.status()        -> { ready, sceneFound, ... }
 *   window.__prBot.getDecision()   -> the current decision point, with a state snapshot
 *                                     and an enumerated list of legal options
 *   window.__prBot.act(seq, id)    -> perform option `id` of decision `seq`
 *   window.__prBot.advance()       -> press Action (dismiss text, etc.)
 *
 * Everything here works on the production (minified) bundle because PokeRogue is
 * built with `keepNames`, so class names (`BattleScene`, `CommandUiHandler`, ...),
 * method names (`handleCommand`, `processInput`, ...) and phase names (`phaseName`)
 * survive minification. Enums are compiled to plain numbers, so the small enum tables
 * we need are mirrored below; keep them in sync with the game source if it changes.
 */
(() => {
  if (window.__prBot) {
    return;
  }

  // ---------------------------------------------------------------------------
  // Mirrored enums (from pagefaultgames/pokerogue src/enums, 2026-10)
  // ---------------------------------------------------------------------------
  const TYPES = [
    "NORMAL", "FIGHTING", "FLYING", "POISON", "GROUND", "ROCK", "BUG", "GHOST", "STEEL",
    "FIRE", "WATER", "GRASS", "ELECTRIC", "PSYCHIC", "ICE", "DRAGON", "DARK", "FAIRY", "STELLAR",
  ];
  const typeName = t => (t === -1 ? "UNKNOWN" : (TYPES[t] ?? `TYPE_${t}`));
  const STATUS = ["NONE", "POISON", "TOXIC", "PARALYSIS", "SLEEP", "FREEZE", "BURN", "FAINT"];
  const WEATHER = [
    "NONE", "SUNNY", "RAIN", "SANDSTORM", "HAIL", "SNOW", "FOG", "HEAVY_RAIN", "HARSH_SUN", "STRONG_WINDS",
  ];
  const TERRAIN = ["NONE", "MISTY", "ELECTRIC", "GRASSY", "PSYCHIC"];
  const CATEGORY = ["PHYSICAL", "SPECIAL", "STATUS"];
  const NATURES = [
    "HARDY", "LONELY", "BRAVE", "ADAMANT", "NAUGHTY", "BOLD", "DOCILE", "RELAXED", "IMPISH", "LAX",
    "TIMID", "HASTY", "SERIOUS", "JOLLY", "NAIVE", "MODEST", "MILD", "QUIET", "BASHFUL", "RASH",
    "CALM", "GENTLE", "SASSY", "CAREFUL", "QUIRKY",
  ];
  const BIOMES = {
    0: "TOWN", 1: "PLAINS", 2: "GRASS", 3: "TALL_GRASS", 4: "METROPOLIS", 5: "FOREST", 6: "SEA", 7: "SWAMP",
    8: "BEACH", 9: "LAKE", 10: "SEABED", 11: "MOUNTAIN", 12: "BADLANDS", 13: "CAVE", 14: "DESERT",
    15: "ICE_CAVE", 16: "MEADOW", 17: "POWER_PLANT", 18: "VOLCANO", 19: "GRAVEYARD", 20: "DOJO",
    21: "FACTORY", 22: "RUINS", 23: "WASTELAND", 24: "ABYSS", 25: "SPACE", 26: "CONSTRUCTION_SITE",
    27: "JUNGLE", 28: "FAIRY_CAVE", 29: "TEMPLE", 30: "SLUM", 31: "SNOWY_FOREST", 40: "ISLAND",
    41: "LABORATORY", 50: "END",
  };
  const BALLS = ["POKEBALL", "GREAT_BALL", "ULTRA_BALL", "ROGUE_BALL", "MASTER_BALL"];
  const BATTLE_TYPE = ["WILD", "TRAINER", "CLEAR", "MYSTERY_ENCOUNTER"];
  const STAT_NAMES = ["ATK", "DEF", "SPATK", "SPDEF", "SPD", "ACC", "EVA"];
  const UiMode = { MESSAGE: 0, TITLE: 1, COMMAND: 2, FIGHT: 3, BALL: 4, TARGET_SELECT: 5, MODIFIER_SELECT: 6, PARTY: 8 };
  const Command = { FIGHT: 0, BALL: 1, POKEMON: 2, RUN: 3, TERA: 4 };
  const Button = { UP: 0, DOWN: 1, LEFT: 2, RIGHT: 3, SUBMIT: 4, ACTION: 5, CANCEL: 6 };
  const PartyOption = {
    CANCEL: -1, SEND_OUT: 0, PASS_BATON: 1, REVIVE: 2, APPLY: 3, TEACH: 4, TRANSFER: 5, SUMMARY: 6,
    POKEDEX: 7, UNPAUSE_EVOLUTION: 8, SPLICE: 9, UNSPLICE: 10, RELEASE: 11, RENAME: 12, SELECT: 13,
    DISCARD: 14, SWITCH: 15, SCROLL_UP: 1000, SCROLL_DOWN: 1001, FORM_CHANGE_ITEM: 2000,
    MOVE_1: 3000, MOVE_2: 3001, MOVE_3: 3002, MOVE_4: 3003, ALL: 4000,
  };
  const PARTY_OPTION_NAMES = Object.fromEntries(Object.entries(PartyOption).map(([k, v]) => [v, k]));
  /** Party options that are never a meaningful choice for the bot. */
  const PARTY_NOISE = new Set([
    PartyOption.CANCEL, PartyOption.SUMMARY, PartyOption.POKEDEX, PartyOption.UNPAUSE_EVOLUTION,
    PartyOption.RENAME, PartyOption.RELEASE, PartyOption.SCROLL_UP, PartyOption.SCROLL_DOWN,
  ]);

  // ---------------------------------------------------------------------------
  // Finding the BattleScene
  // ---------------------------------------------------------------------------
  const BOT = {
    version: 1,
    scene: null,
    seq: 0,
    lastDecision: null,
    log: [],
    errors: [],
    hooked: false,
    busy: false,
  };
  window.__prBot = BOT;

  // Phaser's Scene constructor does `this.sys = new Systems(this, config)`. A setter on
  // Object.prototype catches that assignment for every scene; we keep the BattleScene.
  // The setter re-defines `sys` as a normal own property, so behaviour is unchanged.
  let trapInstalled = false;
  try {
    Object.defineProperty(Object.prototype, "sys", {
      configurable: true,
      enumerable: false,
      get() {
        return undefined;
      },
      set(v) {
        Object.defineProperty(this, "sys", { value: v, writable: true, configurable: true, enumerable: true });
        try {
          if (this?.constructor?.name === "BattleScene") {
            BOT.scene = this;
            removeTrap();
          }
        } catch (_) {
          /* ignore */
        }
      },
    });
    trapInstalled = true;
  } catch (e) {
    BOT.errors.push(`sys trap failed: ${e}`);
  }
  function removeTrap() {
    if (trapInstalled) {
      trapInstalled = false;
      try {
        delete Object.prototype.sys;
      } catch (_) {
        /* ignore */
      }
    }
  }
  // Never leave the trap around for long.
  setTimeout(removeTrap, 120_000);

  function scene() {
    // Fallback: game.py can patch `initGlobalScene` in the bundle to set window.__prScene.
    return BOT.scene ?? window.__prScene ?? null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  async function waitFor(pred, timeoutMs = 5000, stepMs = 50) {
    const t0 = performance.now();
    while (performance.now() - t0 < timeoutMs) {
      try {
        if (pred()) {
          return true;
        }
      } catch (_) {
        /* keep waiting */
      }
      await sleep(stepMs);
    }
    return false;
  }
  const safe = (fn, dflt = null) => {
    try {
      const v = fn();
      return v === undefined ? dflt : v;
    } catch (_) {
      return dflt;
    }
  };
  const cleanText = s =>
    String(s ?? "")
      .replace(/@\w\{[^}]*\}/g, "")
      .replace(/\$/g, " ")
      .replace(/\s+/g, " ")
      .trim();

  function pushLog(text) {
    const t = cleanText(text);
    if (!t) {
      return;
    }
    if (BOT.log.length && BOT.log[BOT.log.length - 1] === t) {
      return;
    }
    BOT.log.push(t);
    if (BOT.log.length > 200) {
      BOT.log.splice(0, BOT.log.length - 200);
    }
  }

  function ensureHooks() {
    const s = scene();
    if (BOT.hooked || !s?.ui) {
      return;
    }
    const ui = s.ui;
    for (const name of ["showText", "showDialogue"]) {
      const orig = ui[name];
      if (typeof orig !== "function") {
        continue;
      }
      ui[name] = function (...args) {
        try {
          pushLog(name === "showDialogue" ? `${args[1] ?? ""}: ${args[0]}` : args[0]);
        } catch (_) {
          /* ignore */
        }
        return orig.apply(this, args);
      };
    }
    BOT.hooked = true;
  }

  const handlerName = () => safe(() => scene().ui.getHandler().constructor.name, "?");
  const phaseName = () => safe(() => scene().phaseManager.getCurrentPhase().phaseName, "?");
  const currentPhase = () => safe(() => scene().phaseManager.getCurrentPhase());
  const handler = () => safe(() => scene().ui.getHandler());

  // ---------------------------------------------------------------------------
  // State extraction
  // ---------------------------------------------------------------------------
  function pokemonMoveClass() {
    const s = scene();
    for (const p of [...s.getPlayerParty(), ...s.getEnemyParty()]) {
      const pm = p.getMoveset()?.[0];
      if (pm) {
        return pm.constructor;
      }
    }
    return null;
  }

  function moveInfo(user, pm, targets) {
    const move = pm.getMove();
    const maxPp = safe(() => pm.getMovePp(), move.pp);
    const info = {
      name: move.name,
      type: typeName(safe(() => user.getMoveType(move), move.type)),
      category: CATEGORY[move.category] ?? String(move.category),
      power: move.power,
      accuracy: move.accuracy,
      priority: move.priority,
      pp: maxPp === -1 ? null : maxPp - pm.ppUsed,
      max_pp: maxPp === -1 ? null : maxPp,
      usable: safe(() => pm.isUsable(user, false, true)[0], true),
      effect: cleanText(move.effect).slice(0, 160),
    };
    if (targets?.length && move.category !== 2) {
      info.effectiveness = {};
      for (const t of targets) {
        info.effectiveness[t.name] = safe(() => t.getMoveEffectiveness(user, move), null);
      }
    }
    return info;
  }

  function statStages(p) {
    const stages = safe(() => p.getStatStages(), []);
    const out = {};
    stages.forEach((v, i) => {
      if (v) {
        out[STAT_NAMES[i]] = v;
      }
    });
    return out;
  }

  function heldItems(p) {
    return safe(
      () =>
        p.getHeldItems().map(m => ({
          name: safe(() => m.type.name, "?"),
          count: safe(() => m.getStackCount(), 1),
        })),
      [],
    );
  }

  function playerPokemon(p, i, enemies) {
    return {
      slot: i,
      id: p.id,
      name: p.name,
      species_id: safe(() => p.species.speciesId),
      level: p.level,
      types: safe(() => p.getTypes().map(typeName), []),
      ability: safe(() => p.getAbility().name),
      passive: safe(() => (p.hasPassive() ? p.getPassiveAbility().name : null)),
      nature: NATURES[p.nature] ?? null,
      hp: p.hp,
      max_hp: p.getMaxHp(),
      status: STATUS[safe(() => p.status?.effect, 0)] ?? "NONE",
      fainted: p.isFainted(),
      on_field: safe(() => p.isOnField(), false),
      stat_stages: safe(() => (p.isOnField() ? statStages(p) : {}), {}),
      held_items: heldItems(p),
      moves: p.getMoveset().filter(Boolean).map(pm => moveInfo(p, pm, enemies)),
    };
  }

  function enemyPokemon(e, players, revealAll) {
    const s = scene();
    const seenIds = new Set(safe(() => e.getMoveHistory().map(m => m.move), []));
    const moves = e
      .getMoveset()
      .filter(Boolean)
      .filter(pm => revealAll || seenIds.has(pm.moveId))
      .map(pm => moveInfo(e, pm, players));
    const dex = safe(() => s.gameData.dexData[e.species.speciesId]);
    const out = {
      name: e.name,
      species_id: safe(() => e.species.speciesId),
      level: e.level,
      types: safe(() => e.getTypes().map(typeName), []),
      ability: safe(() => e.getAbility().name),
      hp_pct: Math.round(safe(() => e.getHpRatio(true), 0) * 100),
      status: STATUS[safe(() => e.status?.effect, 0)] ?? "NONE",
      fainted: e.isFainted(),
      stat_stages: statStages(e),
      boss: safe(() => e.isBoss(), false),
      shiny: !!e.shiny,
      already_caught: safe(() => BigInt(dex?.caughtAttr ?? 0) > 0n, false),
      known_moves: moves,
    };
    if (revealAll) {
      out.hp = e.hp;
      out.max_hp = e.getMaxHp();
      out.nature = NATURES[e.nature] ?? null;
    }
    return out;
  }

  function snapshot(opts = {}) {
    const s = scene();
    const battle = s.currentBattle;
    const enemiesOnField = safe(() => s.getEnemyField().filter(e => e.isActive(true)), []);
    const party = s.getPlayerParty();
    const playersOnField = party.filter(p => safe(() => p.isActive(true), false));
    const balls = {};
    BALLS.forEach((b, i) => {
      balls[b] = safe(() => s.pokeballCounts[i], 0);
    });
    return {
      wave: safe(() => battle.waveIndex),
      biome: safe(() => BIOMES[s.arena.biomeId] ?? s.arena.biomeId),
      money: s.money,
      game_mode: safe(() => s.gameMode.getName()),
      battle: battle
        ? {
            type: BATTLE_TYPE[battle.battleType] ?? battle.battleType,
            double: !!battle.double,
            turn: battle.turn,
            trainer: safe(() => battle.trainer?.getName(0, true)),
            enemies_remaining: safe(() => battle.enemyParty.filter(e => !e.isFainted()).length),
          }
        : null,
      field: {
        weather: WEATHER[safe(() => s.arena.weather?.weatherType, 0)] ?? "NONE",
        terrain: TERRAIN[safe(() => s.arena.terrain?.terrainType, 0)] ?? "NONE",
      },
      party: party.map((p, i) => playerPokemon(p, i, enemiesOnField)),
      enemies: enemiesOnField.map(e => enemyPokemon(e, playersOnField, !!opts.revealHidden)),
      pokeballs: balls,
      recent_log: BOT.log.slice(-12),
    };
  }

  // ---------------------------------------------------------------------------
  // Low-level actuators
  // ---------------------------------------------------------------------------
  function press(button) {
    return safe(() => scene().ui.processInput(button), false);
  }

  function optionSelect(index) {
    // Mirrors AbstractOptionSelectUiHandler.processInput(ACTION) for a given option.
    const h = handler();
    const opt = h.options[index];
    if (!opt) {
      throw new Error(`no option ${index}`);
    }
    if (opt.handler()) {
      if (!opt.keepOpen) {
        h.clear();
      }
      return true;
    }
    return false;
  }

  async function partySelect(slot, optionValue) {
    const h = handler();
    if (h.constructor.name !== "PartyUiHandler") {
      throw new Error(`expected party UI, got ${h.constructor.name}`);
    }
    if (!h.optionsMode) {
      h.setCursor(slot);
      h.processInput(Button.ACTION);
      await waitFor(() => handler().optionsMode, 2000);
    }
    const hh = handler();
    if (!hh.optionsMode) {
      return; // Some modes act immediately on slot selection.
    }
    if (optionValue === undefined) {
      return; // Caller will make a follow-up party_option decision.
    }
    const idx = hh.options.indexOf(optionValue);
    if (idx < 0) {
      throw new Error(`party option ${PARTY_OPTION_NAMES[optionValue]} not available`);
    }
    hh.setCursor(idx);
    hh.processInput(Button.ACTION);
  }

  // ---------------------------------------------------------------------------
  // Decisions
  // ---------------------------------------------------------------------------
  function opt(id, label, act, extra = {}) {
    return { id, label, act, ...extra };
  }

  function commandDecision() {
    const s = scene();
    const phase = currentPhase();
    const fieldIndex = phase.getFieldIndex();
    const user = phase.getPokemon();
    const enemies = s.getEnemyField().filter(e => e.isActive(true));
    const options = [];
    const moveset = user.getMoveset().filter(Boolean);
    const anyUsable = moveset.some(pm => safe(() => pm.isUsable(user, false, true)[0], true));
    moveset.forEach((pm, i) => {
      const usable = safe(() => pm.isUsable(user, false, true)[0], true);
      if (!usable && anyUsable) {
        return;
      }
      const m = moveInfo(user, pm, enemies);
      const eff = m.effectiveness ? Object.entries(m.effectiveness).map(([n, x]) => `${x}x vs ${n}`).join(", ") : "";
      options.push(
        opt(
          `move:${i}`,
          `Use ${m.name} (${m.type} ${m.category}, pow ${m.power}, acc ${m.accuracy}, PP ${m.pp ?? "-"}/${m.max_pp ?? "-"}${eff ? `, ${eff}` : ""})`,
          { type: "fight", move: i },
          { move: m },
        ),
      );
    });
    const party = s.getPlayerParty();
    const canSwitch = safe(() => !user.isTrapped(), true);
    party.forEach((p, i) => {
      if (canSwitch && !p.isOnField() && !p.isFainted() && safe(() => p.isAllowedInBattle(), true)) {
        options.push(
          opt(`switch:${i}`, `Switch to ${p.name} (Lv${p.level}, ${p.hp}/${p.getMaxHp()} HP)`, {
            type: "switch",
            slot: i,
          }),
        );
      }
    });
    const battle = s.currentBattle;
    const wild = battle.battleType === 0;
    if (wild && enemies.length === 1) {
      BALLS.forEach((b, i) => {
        const n = safe(() => s.pokeballCounts[i], 0);
        if (n > 0) {
          options.push(opt(`ball:${i}`, `Throw ${b} (${n} left) at ${enemies[0].name}`, { type: "ball", ball: i }));
        }
      });
    }
    if (wild) {
      options.push(opt("run", "Run away", { type: "run" }));
    }
    return {
      kind: "command",
      prompt: `What should ${user.name} do? (field slot ${fieldIndex})`,
      acting: user.name,
      options,
    };
  }

  function targetDecision() {
    const s = scene();
    const h = handler();
    const field = s.getField();
    const targets = h.targets ?? [];
    return {
      kind: "target",
      prompt: "Choose a target for the move.",
      options: targets.map(bi => {
        const p = field[bi];
        const side = bi >= 2 ? "enemy" : "ally";
        return opt(`target:${bi}`, `${p?.name ?? bi} (${side})`, { type: "target", target: bi });
      }),
    };
  }

  function partyDecision() {
    const s = scene();
    const h = handler();
    const phase = phaseName();
    const party = s.getPlayerParty();
    if (h.optionsMode) {
      // We're inside a slot's option menu (e.g. which move to apply an Ether to).
      const p = party[h.cursor];
      const options = h.options
        .map((o, idx) => ({ o, idx }))
        .filter(({ o }) => !PARTY_NOISE.has(o))
        .map(({ o, idx }) => {
          let label = PARTY_OPTION_NAMES[o] ?? `OPTION_${o}`;
          if (o >= PartyOption.MOVE_1 && o <= PartyOption.MOVE_4) {
            label = `Move: ${safe(() => p.getMoveset()[o - PartyOption.MOVE_1].getName(), label)}`;
          }
          return opt(`popt:${idx}`, label, { type: "party_option", index: idx });
        });
      return { kind: "party_option", prompt: `Choose an option for ${p?.name}.`, options };
    }
    const mode = h.partyUiMode;
    const options = [];
    party.forEach((p, i) => {
      if (phase === "SwitchPhase" || mode === 1 /* FAINT_SWITCH */) {
        if (p.isFainted() || p.isOnField()) {
          return;
        }
      }
      options.push(
        opt(
          `slot:${i}`,
          `${p.name} (Lv${p.level}, ${p.hp}/${p.getMaxHp()} HP${p.isFainted() ? ", fainted" : ""})`,
          { type: "party_slot", slot: i },
        ),
      );
    });
    if (safe(() => h.allowCancel(), false)) {
      options.push(opt("cancel", "Cancel / don't use on anyone", { type: "cancel" }));
    }
    return {
      kind: "party",
      prompt: phase === "SwitchPhase" ? "Choose a Pokemon to send out." : "Choose a party member.",
      party_mode: mode,
      options,
    };
  }

  function modifierDecision() {
    const s = scene();
    const h = handler();
    const options = [];
    (h.options ?? []).forEach((o, i) => {
      const t = o.modifierTypeOption.type;
      options.push(
        opt(`reward:${i}`, `Take reward: ${t.name} - ${cleanText(safe(() => t.getDescription(), ""))}`, {
          type: "modifier",
          row: 1,
          col: i,
        }),
      );
    });
    const rows = h.shopOptionsRows ?? [];
    rows.forEach((row, r) => {
      const rowCursor = rows.length + 1 - r;
      row.forEach((o, c) => {
        const t = o.modifierTypeOption.type;
        const cost = o.modifierTypeOption.cost;
        if (cost <= s.money) {
          options.push(
            opt(`shop:${r}:${c}`, `Buy ${t.name} for ${cost} - ${cleanText(safe(() => t.getDescription(), ""))}`, {
              type: "modifier",
              row: rowCursor,
              col: c,
            }),
          );
        }
      });
    });
    const reroll = h.rerollCost;
    if (reroll >= 0 && reroll <= s.money) {
      options.push(opt("reroll", `Reroll rewards for ${reroll}`, { type: "modifier", row: 0, col: 0 }));
    }
    options.push(opt("skip", "Skip taking a reward", { type: "modifier", row: -1, col: -1 }));
    return { kind: "modifier", prompt: `Choose a reward. Money: ${s.money}.`, options };
  }

  function learnMoveDecision(phase) {
    const pokemon = phase.getPokemon();
    const PM = pokemonMoveClass();
    const newMove = PM ? new PM(phase.moveId) : null;
    const enemies = [];
    const newInfo = newMove ? moveInfo(pokemon, newMove, enemies) : { name: `move #${phase.moveId}` };
    const options = pokemon
      .getMoveset()
      .filter(Boolean)
      .map((pm, i) => {
        const m = moveInfo(pokemon, pm, enemies);
        return opt(
          `forget:${i}`,
          `Forget ${m.name} (${m.type} ${m.category}, pow ${m.power}, PP ${m.max_pp ?? "-"}) to learn ${newInfo.name}`,
          { type: "learn", slot: i },
          { move: m },
        );
      });
    options.push(opt("keep", `Don't learn ${newInfo.name}`, { type: "learn", slot: -1 }));
    return {
      kind: "learn_move",
      prompt: `${pokemon.name} wants to learn ${newInfo.name} but already knows 4 moves.`,
      new_move: newInfo,
      options,
    };
  }

  function menuDecision(kind) {
    const h = handler();
    const options = (h.options ?? []).map((o, i) =>
      opt(`opt:${i}`, cleanText(o.label), { type: "option", index: i }, { disabled: o.selectable === false }),
    );
    return { kind, prompt: BOT.log[BOT.log.length - 1] ?? "", options };
  }

  /** Decide what the current screen is and what the bot can do there. */
  function classify(opts) {
    const s = scene();
    if (!s?.ui || !s.phaseManager) {
      return { kind: "loading" };
    }
    if (BOT.busy) {
      return { kind: "busy" };
    }
    const hn = handlerName();
    const pn = phaseName();
    const phase = currentPhase();
    const plan = phase?.__prPlan;

    switch (hn) {
      case "LoginOrRegisterUiHandler":
      case "LoginFormUiHandler":
      case "RegistrationFormUiHandler":
        return { kind: "login_required" };
      case "LoadingModalUiHandler":
        return { kind: "loading" };
      case "TitleUiHandler":
        return menuDecision("title");
      case "CommandUiHandler":
        if (pn === "CommandPhase") {
          return commandDecision();
        }
        break;
      case "FightUiHandler":
      case "BallUiHandler":
        // We never leave the bot sitting in these sub-menus; if we see one, a selection
        // failed (e.g. a disabled move). Back out to the command menu and decide again.
        return { kind: "auto", act: { type: "press", button: Button.CANCEL } };
      case "TargetSelectUiHandler":
        return targetDecision();
      case "PartyUiHandler":
        return partyDecision();
      case "ModifierSelectUiHandler":
        if (h_awaiting()) {
          return modifierDecision();
        }
        return { kind: "wait" };
      case "SummaryUiHandler":
        if (pn === "LearnMovePhase" && plan) {
          return { kind: "auto", act: { type: "plan_summary" } };
        }
        return { kind: "auto", act: { type: "press", button: Button.CANCEL } };
      case "ConfirmUiHandler":
        if (pn === "LearnMovePhase") {
          if (!plan) {
            return learnMoveDecision(phase);
          }
          return { kind: "auto", act: { type: "plan_confirm" } };
        }
        if (pn === "CheckSwitchPhase") {
          // "Will you switch Pokemon?" before a trainer's next Pokemon. Slice 1: never.
          return { kind: "auto", act: { type: "option", index: 1 } };
        }
        if (pn === "SelectStarterPhase") {
          return { kind: "auto", act: { type: "option", index: 0 } };
        }
        return menuDecision("confirm");
      case "OptionSelectUiHandler":
        return menuDecision(pn === "SelectBiomePhase" ? "biome" : pn === "TitlePhase" ? "title" : "menu");
      case "StarterSelectUiHandler":
        return { kind: "starter_select" };
      case "SaveSlotSelectUiHandler":
        return saveSlotDecision();
      case "MysteryEncounterUiHandler":
        // Slice 1: take the first option. Proper handling comes later.
        return { kind: "auto", act: { type: "press", button: Button.ACTION } };
      case "MenuUiHandler":
        return { kind: "auto", act: { type: "press", button: Button.CANCEL } };
      default:
        break;
    }
    return { kind: "advance", act: { type: "press", button: Button.ACTION } };

    function h_awaiting() {
      return !!handler().awaitingActionInput;
    }
  }

  function saveSlotDecision() {
    const h = handler();
    const slots = (h.sessionSlots ?? []).map((sl, i) => ({ slot: i, has_data: !!sl.hasData }));
    return {
      kind: "save_slot",
      save_mode: h.uiMode === 1 ? "SAVE" : "LOAD",
      slots,
      options: slots.map(sl =>
        opt(`slot:${sl.slot}`, `Save slot ${sl.slot + 1}${sl.has_data ? " (has data)" : " (empty)"}`, {
          type: "save_slot",
          slot: sl.slot,
        }, { has_data: sl.has_data }),
      ),
    };
  }

  BOT.status = () => ({
    sceneFound: !!scene(),
    trapInstalled,
    handler: handlerName(),
    phase: phaseName(),
    errors: BOT.errors.slice(-5),
  });

  BOT.getDecision = (opts = {}) => {
    try {
      ensureHooks();
      const d = classify(opts);
      d.seq = ++BOT.seq;
      d.handler = handlerName();
      d.phase = phaseName();
      const needsState = !["loading", "busy", "wait", "advance", "auto", "login_required"].includes(d.kind);
      if (needsState && scene()?.currentBattle) {
        d.state = snapshot(opts);
      }
      BOT.lastDecision = d;
      return JSON.parse(
        JSON.stringify(d, (k, v) => (typeof v === "bigint" ? v.toString() : v)),
      );
    } catch (e) {
      BOT.errors.push(String(e?.stack ?? e));
      return { kind: "error", error: String(e?.message ?? e), handler: handlerName(), phase: phaseName() };
    }
  };

  BOT.advance = () => press(Button.ACTION);
  BOT.cancel = () => press(Button.CANCEL);
  BOT.snapshot = opts => snapshot(opts);

  // ---------------------------------------------------------------------------
  // Executing actions
  // ---------------------------------------------------------------------------
  async function execute(act) {
    const s = scene();
    const ui = s.ui;
    const phase = currentPhase();
    switch (act.type) {
      case "press":
        press(act.button);
        return;
      case "option":
        optionSelect(act.index);
        return;
      case "fight":
        await ui.setMode(UiMode.FIGHT, phase.getFieldIndex());
        phase.handleCommand(Command.FIGHT, act.move);
        return;
      case "switch": {
        const h = handler();
        h.setCursor(Command.POKEMON);
        h.processInput(Button.ACTION);
        await waitFor(() => handlerName() === "PartyUiHandler", 3000);
        await partySelect(act.slot, PartyOption.SEND_OUT);
        return;
      }
      case "ball": {
        const h = handler();
        h.setCursor(Command.BALL);
        h.processInput(Button.ACTION);
        await waitFor(() => handlerName() === "BallUiHandler", 3000);
        const bh = handler();
        bh.setCursor(act.ball);
        bh.processInput(Button.ACTION);
        return;
      }
      case "run": {
        const h = handler();
        h.setCursor(Command.RUN);
        h.processInput(Button.ACTION);
        return;
      }
      case "target":
        handler().targetSelectCallback([act.target]);
        return;
      case "party_slot":
        await partySelect(act.slot);
        // If exactly one meaningful option appears (e.g. SEND_OUT / APPLY), take it.
        if (handlerName() === "PartyUiHandler" && handler().optionsMode) {
          const h = handler();
          const real = h.options.map((o, i) => ({ o, i })).filter(({ o }) => !PARTY_NOISE.has(o));
          if (real.length === 1) {
            h.setCursor(real[0].i);
            h.processInput(Button.ACTION);
          }
        }
        return;
      case "party_option": {
        const h = handler();
        h.setCursor(act.index);
        h.processInput(Button.ACTION);
        return;
      }
      case "cancel":
        press(Button.CANCEL);
        return;
      case "modifier": {
        const h = handler();
        const cb = h.onActionInput;
        if (!cb) {
          throw new Error("modifier select is not awaiting input");
        }
        h.awaitingActionInput = false;
        h.onActionInput = null;
        if (!cb(act.row, act.col)) {
          h.awaitingActionInput = true;
          h.onActionInput = cb;
        }
        return;
      }
      case "learn": {
        phase.__prPlan = { slot: act.slot, declined: false };
        // First confirm: "Should a move be forgotten?" -> yes if replacing, no if keeping.
        optionSelect(act.slot >= 0 ? 0 : 1);
        if (act.slot < 0) {
          phase.__prPlan.declined = true;
        }
        return;
      }
      case "plan_confirm":
        // Follow-up confirm inside LearnMovePhase. If we declined, it's "Stop trying to
        // teach X?" -> yes. Otherwise the game re-asked "forget a move?" -> yes.
        optionSelect(0);
        return;
      case "plan_summary": {
        const plan = phase.__prPlan;
        const h = handler();
        const slot = plan.slot >= 0 ? plan.slot : 4;
        h.moveSelectFunction?.(slot);
        return;
      }
      case "save_slot": {
        const h = handler();
        h.setCursor(act.slot);
        h.processInput(Button.ACTION);
        return;
      }
      default:
        throw new Error(`unknown action type ${act.type}`);
    }
  }

  BOT.act = async (seq, optionId) => {
    const d = BOT.lastDecision;
    if (!d || d.seq !== seq) {
      return { ok: false, error: `stale decision (have ${d?.seq}, got ${seq})` };
    }
    let act;
    if (optionId === "__auto__") {
      act = d.act;
    } else {
      act = d.options?.find(o => o.id === optionId)?.act;
    }
    if (!act) {
      return { ok: false, error: `unknown option ${optionId}` };
    }
    BOT.busy = true;
    try {
      await execute(act);
      return { ok: true };
    } catch (e) {
      BOT.errors.push(String(e?.stack ?? e));
      return { ok: false, error: String(e?.message ?? e) };
    } finally {
      BOT.busy = false;
      BOT.lastDecision = null;
    }
  };

  /**
   * Start a run with the given starters, bypassing the starter-select grid.
   * `speciesIds` are national dex numbers (e.g. 4 = Charmander). Each must be unlocked.
   */
  BOT.chooseStarters = async speciesIds => {
    const s = scene();
    const h = handler();
    if (h.constructor.name !== "StarterSelectUiHandler") {
      return { ok: false, error: `not on starter select (${h.constructor.name})` };
    }
    const starters = [];
    let cost = 0;
    for (const id of speciesIds) {
      cost += safe(() => s.gameData.getSpeciesStarterValue(id), 0);
      const dex = s.gameData.dexData[id];
      if (!dex || BigInt(dex.caughtAttr ?? 0) === 0n) {
        return { ok: false, error: `species ${id} is not unlocked` };
      }
      const natures = safe(() => s.gameData.getNaturesForAttr(dex.natureAttr), [0]);
      starters.push({
        speciesId: id,
        shiny: false,
        variant: 0,
        formIndex: 0,
        abilityIndex: 0,
        passive: false,
        nature: natures[0] ?? 0,
        pokerus: false,
        ivs: dex.ivs,
      });
    }
    if (cost > 10) {
      return { ok: false, error: `starter team costs ${cost} points; the limit is 10` };
    }
    const cb = h.starterSelectCallback;
    if (!cb) {
      return { ok: false, error: "starter select callback missing" };
    }
    h.starterSelectCallback = null;
    s.money = s.gameMode.getStartingMoney();
    cb(starters);
    return { ok: true };
  };
})();
