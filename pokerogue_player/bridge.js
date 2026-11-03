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
  const UiMode = {
    MESSAGE: 0, TITLE: 1, COMMAND: 2, FIGHT: 3, BALL: 4, TARGET_SELECT: 5, MODIFIER_SELECT: 6,
    SAVE_SLOT: 7, PARTY: 8, CONFIRM: 14, OPTION_SELECT: 15, MENU: 16, MENU_OPTION_SELECT: 17,
  };
  /**
   * Labels the bot must never select, anywhere. Save data is the user's; nothing that
   * deletes, overwrites or erases it is ever a legal option.
   */
  const DANGEROUS_LABEL = /delete|overwrite|erase|wipe|clear data|reset/i;
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
    allowLoad: false,
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

  // Compact move info for the state: what the move is, without per-target numbers (those
  // are in the option labels where they matter). `withEffect` adds the effect text.
  function moveBrief(p, pm, withEffect) {
    const m = moveInfo(p, pm, null);
    const out = { name: m.name, type: m.type, category: m.category, power: m.power, accuracy: m.accuracy, pp: m.pp, max_pp: m.max_pp };
    if (withEffect && m.effect) {
      out.effect = m.effect;
    }
    return out;
  }

  function playerPokemon(p, i, inBattle) {
    const onField = safe(() => p.isOnField(), false);
    const out = {
      slot: i,
      name: p.name,
      bst: safe(() => p.species.baseTotal),
      level: p.level,
      types: safe(() => p.getTypes().map(typeName), []),
      ability: safe(() => p.getAbility().name),
      passive: safe(() => (p.hasPassive() ? p.getPassiveAbility().name : null)),
      nature: NATURES[p.nature] ?? null,
      hp: p.hp,
      max_hp: p.getMaxHp(),
      status: STATUS[safe(() => p.status?.effect, 0)] ?? "NONE",
      fainted: p.isFainted(),
      held_items: heldItems(p),
      moves: p.getMoveset().filter(Boolean).map(pm => moveBrief(p, pm, inBattle && onField)),
    };
    if (inBattle) {
      out.on_field = onField;
      if (onField) {
        out.stat_stages = safe(() => statStages(p), {});
      }
    }
    return out;
  }

  function enemyPokemon(e, players, revealAll) {
    const s = scene();
    const seenIds = new Set(safe(() => e.getMoveHistory().map(m => m.move), []));
    const moves = e
      .getMoveset()
      .filter(Boolean)
      .filter(pm => revealAll || seenIds.has(pm.moveId))
      .map(pm => moveInfo(e, pm, players));
    const out = {
      name: e.name,
      bst: safe(() => e.species.baseTotal),
      level: e.level,
      types: safe(() => e.getTypes().map(typeName), []),
      ability: safe(() => e.getAbility().name),
      hp_pct: Math.round(safe(() => e.getHpRatio(true), 0) * 100),
      status: STATUS[safe(() => e.status?.effect, 0)] ?? "NONE",
      fainted: e.isFainted(),
      stat_stages: statStages(e),
      boss: safe(() => e.isBoss(), false),
      shiny: !!e.shiny,
      known_moves: moves,
    };
    if (revealAll) {
      out.hp = e.hp;
      out.max_hp = e.getMaxHp();
      out.nature = NATURES[e.nature] ?? null;
    }
    return out;
  }

  // Decision kinds that are about the fight in front of us. Everything else (rewards, move
  // learning, a full party after a catch, events, biome) gets the team and the run, not the
  // battlefield or the battle log.
  const BATTLE_KINDS = new Set(["command", "target"]);
  const BALL_KINDS = new Set(["command", "modifier"]);
  const LOG_LINES = { command: 6, target: 6, party: 6, confirm: 3, menu: 3 };

  function snapshot(opts = {}, d = {}) {
    const s = scene();
    const battle = s.currentBattle;
    const kind = d.kind;
    // A party screen during battle (send-out after a faint) is a battle decision; the same
    // screen while handing out a reward item is not.
    const inBattle = BATTLE_KINDS.has(kind) || (kind === "party" && !d.item);
    const party = s.getPlayerParty();
    const out = {
      wave: safe(() => battle.waveIndex),
      biome: safe(() => BIOMES[s.arena.biomeId] ?? s.arena.biomeId),
      money: s.money,
      party: party.map((p, i) => playerPokemon(p, i, inBattle)),
    };
    if (inBattle) {
      const enemiesOnField = safe(() => s.getEnemyField().filter(e => e.isActive(true)), []);
      const playersOnField = party.filter(p => safe(() => p.isActive(true), false));
      out.battle = battle
        ? {
            type: BATTLE_TYPE[battle.battleType] ?? battle.battleType,
            double: !!battle.double,
            turn: battle.turn,
            trainer: safe(() => battle.trainer?.getName(0, true)),
            enemies_remaining: safe(() => battle.enemyParty.filter(e => !e.isFainted()).length),
          }
        : null;
      out.field = {
        weather: WEATHER[safe(() => s.arena.weather?.weatherType, 0)] ?? "NONE",
        terrain: TERRAIN[safe(() => s.arena.terrain?.terrainType, 0)] ?? "NONE",
      };
      out.enemies = enemiesOnField.map(e => enemyPokemon(e, playersOnField, !!opts.revealHidden));
    }
    if (BALL_KINDS.has(kind)) {
      const balls = {};
      BALLS.forEach((b, i) => {
        balls[b] = safe(() => s.pokeballCounts[i], 0);
      });
      out.pokeballs = balls;
    }
    const lines = LOG_LINES[kind] ?? 0;
    if (lines) {
      out.recent_log = BOT.log.slice(-lines);
    }
    return out;
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
    if (DANGEROUS_LABEL.test(cleanText(opt.label))) {
      throw new Error(`refusing to select "${cleanText(opt.label)}"`);
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

  // Short matchup summary for a switch-in: its types, its best attack against the enemies on
  // the field (the game's own effectiveness numbers), and the worst it takes from their types.
  function matchup(p, enemies) {
    const types = safe(() => p.getTypes().map(typeName), []);
    const parts = [types.join("/")];
    let best = null;
    for (const pm of p.getMoveset().filter(Boolean)) {
      const move = safe(() => pm.getMove());
      if (!move || move.category === 2 || !(move.power > 0)) {
        continue;
      }
      const mtype = typeName(safe(() => p.getMoveType(move), move.type));
      const stab = types.includes(mtype) ? 1.5 : 1;
      for (const e of enemies) {
        const x = safe(() => e.getMoveEffectiveness(p, move), null);
        if (x === null) {
          continue;
        }
        const score = move.power * x * stab;
        if (!best || score > best.score) {
          best = { score, text: `best move ${move.name} ${x}x vs ${e.name}` };
        }
      }
    }
    if (best) {
      parts.push(best.text);
    }
    let worst = null;
    for (const e of enemies) {
      for (const t of safe(() => e.getTypes(), [])) {
        const x = safe(() => p.getAttackTypeEffectiveness(t, e), null);
        if (x !== null && (!worst || x > worst.x)) {
          worst = { x, text: `takes ${x}x from ${e.name}'s ${typeName(t)} moves` };
        }
      }
    }
    if (worst) {
      parts.push(worst.text);
    }
    return parts.filter(Boolean).length ? `; ${parts.filter(Boolean).join("; ")}` : "";
  }

  /** Legal commands for `user`. `turnWide` adds Poke Balls and Run, which end the whole turn. */
  function commandOptions(user, turnWide = true) {
    const s = scene();
    const enemies = s.getEnemyField().filter(e => e.isActive(true));
    const options = [];
    const moveset = user.getMoveset().filter(Boolean);
    const anyUsable = moveset.some(pm => safe(() => pm.isUsable(user, false, true)[0], true));
    const field = s.getField();
    const getTargets = window.__prGetMoveTargets;
    moveset.forEach((pm, i) => {
      const usable = safe(() => pm.isUsable(user, false, true)[0], true);
      if (!usable && anyUsable) {
        return;
      }
      const m = moveInfo(user, pm, enemies);
      const stats = `${m.type} ${m.category}, pow ${m.power}, acc ${m.accuracy}, PP ${m.pp ?? "-"}/${m.max_pp ?? "-"}`;
      // In doubles, a single-target move makes the game ask for a target. Offer each
      // target as its own option so move and target are one decision. getMoveTargets is
      // the game's own function (exposed by the bundle patch in game.py).
      const mt = typeof getTargets === "function" ? safe(() => getTargets(user, pm.moveId), null) : null;
      const targets = (mt?.targets ?? []).filter(bi => field[bi]);
      if (mt && !mt.multiple && targets.length > 1) {
        for (const bi of targets) {
          const t = field[bi];
          const side = bi >= 2 ? "enemy" : "ally";
          const x = m.category === "STATUS" ? null : safe(() => t.getMoveEffectiveness(user, pm.getMove()), null);
          options.push(
            opt(
              `move:${i}@target:${bi}`,
              `Use ${m.name} on ${t.name} (${side}${x === null ? "" : `, ${x}x`}) (${stats})`,
              { type: "fight", move: i, target: bi },
              { move: m, target: bi, target_name: t.name, target_side: side, target_effectiveness: x },
            ),
          );
        }
        return;
      }
      const eff = m.effectiveness ? Object.entries(m.effectiveness).map(([n, x]) => `${x}x vs ${n}`).join(", ") : "";
      const hits =
        mt?.multiple && targets.length > 1 ? `, hits ${targets.map(bi => field[bi].name).join(" and ")}` : "";
      options.push(
        opt(
          `move:${i}`,
          `Use ${m.name} (${stats}${eff ? `, ${eff}` : ""}${hits})`,
          { type: "fight", move: i, multiple: !!(mt?.multiple && targets.length > 1) },
          { move: m },
        ),
      );
    });
    const party = s.getPlayerParty();
    const canSwitch = safe(() => !user.isTrapped(), true);
    party.forEach((p, i) => {
      if (canSwitch && !p.isOnField() && !p.isFainted() && safe(() => p.isAllowedInBattle(), true)) {
        options.push(
          opt(`switch:${i}`, `Switch to ${p.name} (Lv${p.level}, ${p.hp}/${p.getMaxHp()} HP${matchup(p, enemies)})`, {
            type: "switch",
            slot: i,
          }),
        );
      }
    });
    const battle = s.currentBattle;
    const wild = battle.battleType === 0;
    if (!turnWide) {
      return options;
    }
    if (wild && enemies.length === 1) {
      BALLS.forEach((b, i) => {
        const n = safe(() => s.pokeballCounts[i], 0);
        if (n > 0) {
          const e = enemies[0];
          const info = [
            safe(() => e.getTypes().map(typeName).join("/"), ""),
            safe(() => `BST ${e.species.baseTotal}`, ""),
            e.shiny ? "SHINY" : "",
          ].filter(Boolean).join(", ");
          options.push(opt(`ball:${i}`, `Throw ${b} (${n} left) at ${e.name} (${info})`, { type: "ball", ball: i }));
        }
      });
    }
    if (wild) {
      options.push(opt("run", "Run away", { type: "run" }));
    }
    return options;
  }

  function commandDecision() {
    const s = scene();
    const phase = currentPhase();
    const fieldIndex = phase.getFieldIndex();
    const user = phase.getPokemon();
    BOT.pendingMoveTarget = null;
    const options = commandOptions(user, true);
    const battle = s.currentBattle;
    const turn = safe(() => battle.turn);
    const wave = safe(() => battle.waveIndex);

    // Second Pokemon of a double battle: its command was already chosen together with the
    // first one's. Use it if it is still legal; otherwise decide it on its own.
    const plan = BOT.partnerPlan;
    BOT.partnerPlan = null;
    if (plan && fieldIndex === 1 && plan.turn === turn && plan.wave === wave) {
      const o = options.find(x => x.id === plan.id);
      if (o) {
        return { kind: "auto", act: o.act, planned: `${user.name}: ${o.label}` };
      }
    }

    const out = {
      kind: "command",
      prompt: `What should ${user.name} do? (field slot ${fieldIndex})`,
      acting: user.name,
      options,
    };
    // First Pokemon of a double battle: offer the partner's commands too, so both are
    // decided together (focus one enemy or split up). Balls and Run are first-slot only,
    // since they use up the whole turn.
    const partner = fieldIndex === 0 && battle?.double
      ? safe(() => s.getPlayerField().find((p, i) => i === 1 && p && p.isActive(true)), null)
      : null;
    if (partner) {
      out.partner = { acting: partner.name, options: commandOptions(partner, false) };
      out.prompt =
        `Double battle: choose what ${user.name} (left) and ${partner.name} (right) do this turn, together.`;
    }
    return out;
  }

  function targetDecision() {
    const s = scene();
    const h = handler();
    const field = s.getField();
    const targets = h.targets ?? [];
    const planned = BOT.pendingMoveTarget;
    if (h.isMultipleTargets || (planned?.multiple && !planned.used)) {
      // Spread move: the game still shows the target screen, but every target is hit and
      // there is nothing to choose. Confirm with all of them, as the handler itself does.
      return { kind: "auto", act: { type: "target", targets } };
    }
    if (planned && !planned.used && targets.includes(planned.target)) {
      // The command decision already picked the target.
      return { kind: "auto", act: { type: "target", target: planned.target } };
    }
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
    if (BOT.releasePlan?.stage === "party" && phase === "AttemptCapturePhase" && party[BOT.releasePlan.slot]) {
      return { kind: "auto", act: { type: "release_slot", slot: BOT.releasePlan.slot } };
    }
    const planned = BOT.pendingTarget;
    if (planned && !planned.used && phase === "SelectModifierPhase" && party[planned.slot]) {
      // The reward decision already chose who gets the item. Use it once; if the game
      // refuses it we come back here with the plan spent and ask normally.
      return { kind: "auto", act: { type: "party_slot", slot: planned.slot, planned: true } };
    }
    const options = [];
    party.forEach((p, i) => {
      if (phase === "SwitchPhase" || mode === 1 /* FAINT_SWITCH */) {
        if (p.isFainted() || p.isOnField()) {
          return;
        }
      }
      const sendOut = phase === "SwitchPhase" || mode === 1;
      const vs = sendOut ? safe(() => matchup(p, s.getEnemyField().filter(e => e.isActive(true))), "") : "";
      options.push(
        opt(
          `slot:${i}`,
          `${p.name} (Lv${p.level}, ${p.hp}/${p.getMaxHp()} HP${p.isFainted() ? ", fainted" : ""}${vs})`,
          { type: "party_slot", slot: i },
        ),
      );
    });
    if (safe(() => h.allowCancel(), false)) {
      options.push(opt("cancel", "Cancel / don't use on anyone", { type: "cancel" }));
    }
    const item = phase === "SelectModifierPhase" ? (BOT.pendingItem ?? null) : null;
    return {
      kind: "party",
      item,
      prompt: item
        ? `Choose which party member gets ${item}.`
        :
        phase === "SwitchPhase"
          ? `Choose a Pokemon to send out against ${safe(() => s.getEnemyField().filter(e => e.isActive(true)).map(e => e.name).join(" and "), "the enemy")}.`
          : `Choose a party member (${phase}). Context: ${BOT.log.slice(-3).join(" / ")}`,
      party_mode: mode,
      options,
    };
  }

  // Items that make the game ask which Pokemon gets them (SelectModifierPhase checks
  // `instanceof PokemonModifierType`). Splicers need two picks, so they stay separate.
  function classChain(o) {
    const names = [];
    for (let c = o?.constructor; c && c !== Object && c.name; c = Object.getPrototypeOf(c)) {
      names.push(c.name);
    }
    return names;
  }

  function isTargetedItem(t) {
    const chain = classChain(t);
    return chain.includes("PokemonModifierType") && !chain.includes("FusePokemonModifierType");
  }

  function hpText(p) {
    return p.isFainted() ? "fainted" : `${p.hp}/${p.getMaxHp()} HP`;
  }

  // One option per (item, valid target). Uses the item's own selectFilter, which is what
  // the party screen checks ("It won't have any effect"), so potions only list hurt
  // Pokemon, revives only fainted ones, TMs only compatible ones.
  function itemOptions(prefix, verb, t, coords, extraLabel = "") {
    const desc = cleanText(safe(() => t.getDescription(), ""));
    const base = { type: "modifier", ...coords, item: t.name };
    if (!isTargetedItem(t)) {
      return [opt(prefix, `${verb} ${t.name}${extraLabel} - ${desc}`, base, { item: t.name })];
    }
    const out = [];
    scene()
      .getPlayerParty()
      .forEach((p, i) => {
        const refusal = typeof t.selectFilter === "function" ? safe(() => t.selectFilter(p), null) : null;
        if (refusal) {
          return;
        }
        out.push(
          opt(
            `${prefix}@slot:${i}`,
            `${verb} ${t.name}${extraLabel} and use it on ${p.name} (Lv${p.level}, ${hpText(p)}) - ${desc}`,
            { ...base, target: i },
            { item: t.name, target: i },
          ),
        );
      });
    return out;
  }

  // ---------------------------------------------------------------------------
  // Upcoming waves (Classic). Shown only on the reward/shop screen, where it matters for
  // what to buy and keep.
  // ---------------------------------------------------------------------------
  // Mirrors ClassicFixedBossWaves in PokeRogue. If the game exposes its fixed-battle table,
  // its keys decide which waves are fixed; these names just label them.
  const CLASSIC_FIXED = {
    5: "trainer battle (Youngster)",
    8: "RIVAL battle",
    25: "RIVAL battle",
    35: "evil team grunt battle",
    55: "RIVAL battle",
    62: "evil team grunt battle",
    64: "evil team grunt battle",
    66: "evil team ADMIN battle",
    95: "RIVAL battle",
    112: "evil team grunt battle",
    114: "evil team ADMIN battle",
    115: "evil team BOSS battle (hard)",
    145: "RIVAL battle",
    165: "evil team BOSS battle (hard)",
    182: "ELITE FOUR battle (hard)",
    184: "ELITE FOUR battle (hard)",
    186: "ELITE FOUR battle (hard)",
    188: "ELITE FOUR battle (hard)",
    190: "CHAMPION battle (very hard)",
    195: "RIVAL battle (final, hard)",
    200: "FINAL BOSS (very hard)",
  };

  function waveKind(s, w, gymKnown) {
    // The game's own fixed-battle table, if it's a plain {wave: config} object.
    let fixed = safe(() => s.gameMode.battleConfig, null);
    if (!fixed || typeof fixed !== "object" || !Object.keys(fixed).some(k => /^\d+$/.test(k))) {
      fixed = null;
    }
    if (CLASSIC_FIXED[w] && (!fixed || fixed[w] || w === 200)) {
      return CLASSIC_FIXED[w];
    }
    if (fixed?.[w]) {
      return "special trainer battle";
    }
    if (w < 180 && w % 10 === 0) {
      // Gym leaders are on 20+30k or 30+30k, depending on the run. A player only finds out
      // which at wave 20, so the bot doesn't either.
      const gymSlot = w % 30 === 20 || w % 30 === 0;
      if (gymSlot && w >= 20) {
        if (!gymKnown) {
          return w === 20 || w === 30 ? "GYM LEADER battle if this run's gyms are on this wave (hard), else wild boss" : "wild boss or GYM LEADER (hard)";
        }
        const offset = !!safe(() => s.offsetGym, false);
        if ((offset && w % 30 === 0) || (!offset && w % 30 === 20)) {
          return "GYM LEADER battle (hard)";
        }
      }
      return "wild boss";
    }
    return null;
  }

  function upcomingWaves(horizon = 15) {
    const s = scene();
    if (!/classic/i.test(safe(() => s.gameMode.getName(), ""))) {
      return [];
    }
    const wave = safe(() => s.currentBattle.waveIndex, 0);
    const out = [];
    for (let w = wave + 1; w <= Math.min(200, wave + horizon); w++) {
      const k = waveKind(s, w, wave >= 20);
      if (k) {
        out.push(`wave ${w} (in ${w - wave}): ${k}`);
      }
    }
    return out;
  }

  function modifierDecision() {
    const s = scene();
    const h = handler();
    BOT.pendingItem = null;
    BOT.pendingTarget = null;
    const options = [];
    (h.options ?? []).forEach((o, i) => {
      options.push(...itemOptions(`reward:${i}`, "Take reward:", o.modifierTypeOption.type, { row: 1, col: i }));
    });
    const rows = h.shopOptionsRows ?? [];
    rows.forEach((row, r) => {
      const rowCursor = rows.length + 1 - r;
      row.forEach((o, c) => {
        const t = o.modifierTypeOption.type;
        const cost = o.modifierTypeOption.cost;
        if (cost <= s.money) {
          options.push(...itemOptions(`shop:${r}:${c}`, "Buy", t, { row: rowCursor, col: c }, ` for ${cost}`));
        }
      });
    });
    const reroll = h.rerollCost;
    if (reroll >= 0 && reroll <= s.money) {
      options.push(opt("reroll", `Reroll rewards for ${reroll}`, { type: "modifier", row: 0, col: 0 }));
    }
    const ahead = safe(() => upcomingWaves(), []);
    // Free rewards are always worth taking, so "skip" is only offered when no reward can be
    // taken at all (e.g. every reward is an item that would have no effect on anyone).
    if (!options.some(o => o.id.startsWith("reward:"))) {
      options.push(opt("skip", "Leave the reward screen (no reward can be used right now)", { type: "modifier", row: -1, col: -1 }));
    }
    return {
      kind: "modifier",
      prompt:
        `Choose a reward. Money: ${s.money}. Items used on a Pokemon are listed once per Pokemon ` +
        "they would have an effect on; picking one also picks the target." +
        (ahead.length ? `\nComing up: ${ahead.join("; ")}.` : ""),
      options,
    };
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

  const cleanBB = t => cleanText(String(t ?? "").replace(/\[\/?[a-z]+(=[^\]]*)?\]/gi, ""));
  const textsOf = container =>
    safe(
      () =>
        container
          .getAll()
          .filter(o => typeof o?.text === "string")
          .map(o => cleanBB(o.text))
          .filter(Boolean),
      [],
    );

  /**
   * Mystery encounter: read the rendered title/description, each option's label and its
   * tooltip (which describes what the option does), and skip options the game disables.
   */
  function mysteryDecision() {
    const h = handler();
    if (h.blockInput) {
      return { kind: "wait" }; // options are still animating in
    }
    const encounterOptions = h.encounterOptions ?? [];
    const labels = textsOf(h.optionsContainer);
    const description = textsOf(h.descriptionContainer);
    const prev = safe(() => h.getCursor(), 0);
    const options = [];
    encounterOptions.forEach((o, i) => {
      const meets = !!h.optionsMeetsReqs?.[i];
      // MysteryEncounterOptionMode.DISABLED_OR_DEFAULT = 1, DISABLED_OR_SPECIAL = 3
      const disabled = !meets && (o.optionMode === 1 || o.optionMode === 3);
      let tip = "";
      try {
        h.setCursor(i);
        h.displayOptionTooltip();
        tip = textsOf(h.tooltipContainer).join(" ");
      } catch (_) {
        /* tooltip is best-effort */
      }
      if (disabled) {
        return;
      }
      const label = labels[i] ?? `Option ${i + 1}`;
      options.push(
        opt(`me:${i}`, tip ? `${label} - ${tip}` : label, { type: "mystery", index: i }, { special: meets && o.optionMode >= 2 }),
      );
    });
    try {
      h.setCursor(prev);
      h.displayOptionTooltip();
    } catch (_) {
      /* ignore */
    }
    return { kind: "mystery", prompt: description.join(" "), options };
  }

  const YES = /^\s*yes\s*$/i;
  const NO = /^\s*no\s*$/i;

  function monSummary(p) {
    const types = safe(() => p.getTypes().map(typeName).join("/"), "?");
    const bst = safe(() => p.species.baseTotal, null);
    const extra = [p.shiny ? "shiny" : "", bst ? `BST ${bst}` : ""].filter(Boolean).join(", ");
    return `${p.name} (Lv${p.level}, ${types}${extra ? `, ${extra}` : ""}, ${hpText(p)})`;
  }

  // A catch with a full party: "release a Pokemon to make room for X?". Offered as one
  // decision: keep X by releasing a specific party member, or let X go.
  function catchFullDecision(phase) {
    const h = handler();
    const labels = (h.options ?? []).map(o => cleanText(o.label));
    const yes = labels.findIndex(l => YES.test(l));
    const no = labels.findIndex(l => NO.test(l));
    const plan = BOT.releasePlan;
    if (plan?.stage === "released" && yes >= 0) {
      // "Do you really want to release <party member>?" after picking them on the party screen.
      BOT.releasePlan = { ...plan, stage: "done" };
      return { kind: "auto", act: { type: "option", index: yes } };
    }
    if (yes < 0 || no < 0 || plan) {
      return menuDecision("menu");
    }
    const caught = safe(() => phase.getPokemon());
    const party = scene().getPlayerParty();
    const name = caught?.name ?? "the new Pokemon";
    const options = party.map((p, i) =>
      opt(`release:${i}`, `Keep ${name} and release ${monSummary(p)} (permanent)`, {
        type: "release_plan",
        slot: i,
        index: yes,
      }),
    );
    options.push(opt("decline", `Don't keep ${name}; the party stays as it is`, { type: "option", index: no }));
    return {
      kind: "catch_full",
      prompt:
        `You caught ${caught ? monSummary(caught) : name} but the party is full. Keep it by releasing ` +
        "one party member forever, or let the new Pokemon go. Judge only which team is stronger " +
        "for the rest of the run (Pokedex entries don't matter here).",
      options,
    };
  }

  function menuDecision(kind) {
    const h = handler();
    const options = (h.options ?? [])
      .map((o, i) => opt(`opt:${i}`, cleanText(o.label), { type: "option", index: i }, { disabled: o.selectable === false }))
      .filter(o => !DANGEROUS_LABEL.test(o.label));
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

    // Save-slot safety: anything layered over the save-slot screen (the overwrite
    // confirmation, the Load/Rename/Delete menu) is handled here and never reaches the LLM.
    const chain = safe(() => s.ui.modeChain, []) ?? [];
    if (hn !== "SaveSlotSelectUiHandler" && (s.ui.mode === UiMode.SAVE_SLOT || chain.includes(UiMode.SAVE_SLOT))) {
      return saveGuardDecision(hn);
    }
    if (hn !== "SaveSlotSelectUiHandler") {
      BOT.allowLoad = false;
    }
    if (pn !== "AttemptCapturePhase") {
      BOT.releasePlan = null;
    } else if (hn === "OptionSelectUiHandler" || hn === "ConfirmUiHandler") {
      return catchFullDecision(phase);
    }

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
        if (pn === "SelectModifierPhase" && BOT.skipRequested) {
          // "Skip taking a reward?" after the bot already decided to skip: yes.
          BOT.skipRequested = false;
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
        return mysteryDecision();
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

  function saveGuardDecision(hn) {
    const h = handler();
    if (hn === "ConfirmUiHandler") {
      // The only confirm over the save-slot screen is "overwrite this save?" -> always No.
      return { kind: "auto", act: { type: "option", index: 1, guard: "decline_overwrite" } };
    }
    const options = h?.options ?? [];
    if (options.length) {
      const load = options.findIndex(o => /^\s*load/i.test(cleanText(o.label)));
      if (load >= 0 && BOT.allowLoad) {
        return { kind: "auto", act: { type: "option", index: load, guard: "load_only" } };
      }
      const cancel = options.findIndex(o => /cancel/i.test(cleanText(o.label)));
      return { kind: "auto", act: { type: "option", index: cancel >= 0 ? cancel : options.length - 1, guard: "cancel" } };
    }
    return { kind: "auto", act: { type: "press", button: Button.ACTION } };
  }

  function slotOccupied(sl) {
    return !!sl && (!!sl.hasData || !!sl.malformed);
  }

  function saveSlotDecision() {
    const h = handler();
    const slots = (h.sessionSlots ?? []).map((sl, i) => ({ slot: i, has_data: slotOccupied(sl) }));
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
        d.state = snapshot(opts, d);
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
  BOT.snapshot = (opts, kind = "command") => snapshot(opts, { kind });

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
        BOT.pendingMoveTarget =
          act.target !== undefined ? { target: act.target } : act.multiple ? { multiple: true } : null;
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
        if (BOT.pendingMoveTarget) {
          BOT.pendingMoveTarget.used = true;
        }
        handler().targetSelectCallback(act.targets ?? [act.target]);
        return;
      case "party_slot":
        if (BOT.pendingTarget) {
          BOT.pendingTarget.used = true;
        }
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
      case "release_plan":
        BOT.releasePlan = { slot: act.slot, stage: "party" };
        optionSelect(act.index);
        return;
      case "release_slot":
        // One attempt only: if the game refuses, the party screen is asked about normally.
        BOT.releasePlan = { ...BOT.releasePlan, stage: "released" };
        await partySelect(act.slot, PartyOption.RELEASE);
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
        BOT.pendingItem = act.item ?? null;
        BOT.skipRequested = act.row === -1;
        BOT.pendingTarget = act.target === undefined ? null : { slot: act.target, item: act.item };
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
      case "mystery": {
        const h = handler();
        h.setCursor(act.index);
        safe(() => h.displayOptionTooltip());
        if (!h.processInput(Button.ACTION)) {
          throw new Error(`mystery encounter option ${act.index} was not accepted`);
        }
        return;
      }
      case "save_slot": {
        const h = handler();
        if (h.constructor.name !== "SaveSlotSelectUiHandler") {
          throw new Error("not on the save slot screen");
        }
        const saving = h.uiMode === 1; // SaveSlotUiMode.SAVE
        h.setCursor(act.slot - (h.scrollCursor ?? 0));
        const index = h.cursor + (h.scrollCursor ?? 0);
        const slot = h.sessionSlots?.[index];
        if (index !== act.slot || !slot) {
          throw new Error(`cursor landed on slot ${index}, wanted ${act.slot}`);
        }
        if (saving && slotOccupied(slot)) {
          throw new Error(`refusing to save over occupied slot ${index}`);
        }
        if (!saving && (!slot.hasData || slot.malformed)) {
          throw new Error(`slot ${index} has no loadable run`);
        }
        BOT.allowLoad = !saving;
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
      const [first, second] = String(optionId).split("+");
      act = d.options?.find(o => o.id === first)?.act;
      if (act && second && d.kind === "command") {
        if (!d.partner?.options?.some(o => o.id === second)) {
          return { ok: false, error: `unknown partner option ${second}` };
        }
        const battle = scene().currentBattle;
        BOT.partnerPlan = { id: second, turn: battle?.turn, wave: battle?.waveIndex };
      }
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

  /** Unlocked starters on the starter-select screen, for picking a team. */
  BOT.starterCandidates = () => {
    const s = scene();
    const h = handler();
    if (h?.constructor?.name !== "StarterSelectUiHandler") {
      return { ok: false, error: `not on starter select (${h?.constructor?.name})` };
    }
    const pokerus = new Set(h.pokerusSpeciesIds ?? []);
    const out = [];
    for (const c of h.starterContainers ?? []) {
      const sp = c.species;
      const dex = safe(() => s.gameData.dexData[sp.speciesId]);
      if (!dex || BigInt(dex.caughtAttr ?? 0) === 0n) {
        continue;
      }
      out.push({
        id: sp.speciesId,
        name: sp.name,
        types: [sp.type1, sp.type2].filter(t => t !== null && t !== undefined).map(typeName),
        cost: safe(() => s.gameData.getSpeciesStarterValue(sp.speciesId), c.cost),
        bst: sp.baseTotal,
        pokerus: pokerus.has(sp.speciesId),
      });
    }
    return { ok: true, budget: 10, candidates: out };
  };

  /**
   * Make game settings bot-friendly (fast speed, no tutorials, no "switch?" prompts).
   * Settings live in localStorage and are read at startup, so the caller reloads the
   * page when this reports `changed`.
   */
  BOT.applySettings = desired => {
    const key = "settings";
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem(key) || "null");
    } catch (_) {
      data = null;
    }
    if (!data || typeof data !== "object") {
      const v = safe(() => scene().game.config.gameVersion);
      if (!v) {
        return { ok: false, error: "no game version available" };
      }
      data = { meta: { gameVersion: v } };
    }
    if (!data.meta?.gameVersion) {
      return { ok: false, error: "settings have no version; leaving them alone" };
    }
    let changed = false;
    for (const [cat, values] of Object.entries(desired)) {
      data[cat] = data[cat] ?? {};
      for (const [k, v] of Object.entries(values)) {
        if (data[cat][k] !== v) {
          data[cat][k] = v;
          changed = true;
        }
      }
    }
    if (changed) {
      localStorage.setItem(key, JSON.stringify(data));
    }
    return { ok: true, changed };
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
    const pokerus = new Set(h.pokerusSpeciesIds ?? []);
    for (const id of speciesIds) {
      cost += safe(() => s.gameData.getSpeciesStarterValue(id), 0);
      const dex = s.gameData.dexData[id];
      if (!dex || BigInt(dex.caughtAttr ?? 0) === 0n) {
        return { ok: false, error: `species ${id} is not unlocked` };
      }
      // Use the starter screen's own logic for the moveset (saved moveset, learnable
      // starter moves and unlocked egg moves), exactly as picking it by hand would.
      let moveset = null;
      try {
        h.populateStarterMoveset(id, 0);
        moveset = Array.isArray(h.starterMoveset) ? h.starterMoveset.slice(0, 4) : null;
      } catch (e) {
        BOT.errors.push(`populateStarterMoveset(${id}) failed: ${e}`);
      }
      if (!moveset?.length) {
        return { ok: false, error: `could not determine a moveset for species ${id}; not starting a broken run` };
      }
      const natures = safe(() => s.gameData.getNaturesForAttr(dex.natureAttr), [0]);
      const passiveAttr = safe(() => s.gameData.starterData[id].passiveAttr, 0);
      starters.push({
        speciesId: id,
        shiny: false,
        variant: 0,
        formIndex: 0,
        abilityIndex: 0,
        // Passive.UNLOCKED = 1, Passive.ENABLED = 2; on only when unlocked and enabled.
        passive: (passiveAttr & 3) === 3,
        nature: natures[0] ?? 0,
        moveset,
        pokerus: pokerus.has(id),
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
