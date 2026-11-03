// Tests bridge.js against a hand-built fake of the PokeRogue objects it touches.
// Run with: node --test tests/
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";

const BRIDGE = readFileSync(new URL("../pokerogue_player/bridge.js", import.meta.url), "utf8");

// Values from the vm realm have different prototypes; compare plain copies.
const plain = x => JSON.parse(JSON.stringify(x));

function loadBridge() {
  const ctx = { setTimeout: (fn, ms) => (ms > 10_000 ? 0 : setTimeout(fn, ms)), performance, console };
  ctx.window = ctx;
  vm.createContext(ctx);
  vm.runInContext(BRIDGE, ctx);
  return ctx;
}

class PokemonMove {
  constructor(moveId, move, ppUsed = 0) {
    this.moveId = moveId;
    this.ppUsed = ppUsed;
    this._move = move ?? MOVES[moveId];
  }
  getMove() {
    return this._move;
  }
  getMovePp() {
    return this._move.pp;
  }
  isUsable() {
    return [this.ppUsed < this._move.pp, ""];
  }
  getName() {
    return this._move.name;
  }
}
const MOVES = {
  1: { name: "Thunderbolt", type: 12, category: 1, power: 90, accuracy: 100, priority: 0, pp: 15, effect: "May paralyze." },
  2: { name: "Quick Attack", type: 0, category: 0, power: 40, accuracy: 100, priority: 1, pp: 30, effect: "" },
  3: { name: "Growl", type: 0, category: 2, power: -1, accuracy: 100, priority: 0, pp: 40, effect: "" },
  4: { name: "Surf", type: 10, category: 1, power: 90, accuracy: 100, priority: 0, pp: 15, effect: "" },
  5: { name: "Iron Tail", type: 8, category: 0, power: 100, accuracy: 75, priority: 0, pp: 15, effect: "" },
};

function mon(name, { hp = 50, maxHp = 50, types = [0], moves = [], onField = false, player = true, id = 1 } = {}) {
  return {
    id,
    name,
    species: { speciesId: id },
    level: 10,
    nature: 3,
    hp,
    shiny: false,
    status: null,
    getMaxHp: () => maxHp,
    getHpRatio: () => hp / maxHp,
    getTypes: () => types,
    getAbility: () => ({ name: "Static" }),
    hasPassive: () => false,
    isFainted: () => hp <= 0,
    isOnField: () => onField,
    isActive: () => onField && hp > 0,
    isAllowedInBattle: () => hp > 0,
    isTrapped: () => false,
    isBoss: () => false,
    getStatStages: () => [1, 0, 0, 0, 0, 0, 0],
    getHeldItems: () => [],
    getMoveset: () => moves,
    getMoveHistory: () => [],
    getMoveType: m => m.type,
    // Electric is 2x vs this fake enemy, everything else 1x.
    getMoveEffectiveness: (_user, m) => (player ? 1 : m.type === 12 ? 2 : 1),
    isPlayer: () => player,
  };
}

class CommandUiHandler {
  constructor() {
    this.cursor = 0;
  }
  setCursor(c) {
    this.cursor = c;
  }
  processInput() {}
}
class CommandPhase {
  phaseName = "CommandPhase";
  constructor(user) {
    this.user = user;
    this.calls = [];
  }
  getFieldIndex() {
    return 0;
  }
  getPokemon() {
    return this.user;
  }
  handleCommand(...args) {
    this.calls.push(args);
    return true;
  }
}

function makeScene() {
  const pika = mon("Pikachu", {
    onField: true,
    types: [12],
    moves: [new PokemonMove(1), new PokemonMove(2), new PokemonMove(3, undefined, 40)],
  });
  const squirtle = mon("Squirtle", { id: 7, types: [10], moves: [new PokemonMove(4)] });
  const fainted = mon("Charmander", { id: 4, hp: 0 });
  const enemy = mon("Gyarados", { id: 130, onField: true, player: false, types: [10, 2], moves: [new PokemonMove(4)] });
  const phase = new CommandPhase(pika);
  const handlers = { cmd: new CommandUiHandler() };
  const scene = {
    money: 500,
    pokeballCounts: { 0: 5, 1: 0, 2: 1, 3: 0, 4: 0 },
    arena: { biomeId: 1, weather: { weatherType: 2 }, terrain: null },
    gameMode: { getName: () => "Classic" },
    gameData: { dexData: { 130: { caughtAttr: 0 } } },
    currentBattle: { waveIndex: 7, battleType: 0, double: false, turn: 2, trainer: null, enemyParty: [enemy] },
    getPlayerParty: () => [pika, squirtle, fainted],
    getEnemyParty: () => [enemy],
    getEnemyField: () => [enemy],
    getField: () => [pika, null, enemy],
    phaseManager: { getCurrentPhase: () => scene._phase },
    _phase: phase,
    ui: {
      _handler: handlers.cmd,
      modes: [],
      getHandler: () => scene.ui._handler,
      processInput(b) {
        return scene.ui._handler.processInput?.(b);
      },
      async setMode(m, ...args) {
        scene.ui.modes.push([m, ...args]);
      },
      showText() {},
    },
  };
  return { scene, phase, pika, enemy };
}

test("captures BattleScene through the sys trap", () => {
  const ctx = loadBridge();
  vm.runInContext("class BattleScene { constructor() { this.sys = { ok: 1 }; } }; globalThis.s = new BattleScene();", ctx);
  assert.equal(ctx.__prBot.status().sceneFound, true);
  assert.equal(ctx.s.sys.ok, 1);
  // Trap removed once the scene is found.
  assert.equal(vm.runInContext("'sys' in {}", ctx), false);
});

test("command decision lists usable moves, switches, balls and run with state", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "command");
  const ids = plain(d.options.map(o => o.id));
  // Growl has no PP left, Charmander is fainted, Great Ball count is 0.
  assert.deepEqual(ids, ["move:0", "move:1", "switch:1", "ball:0", "ball:2", "run"]);
  const tb = d.options[0].move;
  assert.equal(tb.type, "ELECTRIC");
  assert.equal(tb.effectiveness.Gyarados, 2);
  assert.equal(tb.pp, 15);
  assert.equal(d.state.wave, 7);
  assert.equal(d.state.field.weather, "RAIN");
  assert.equal(d.state.enemies[0].hp_pct, 100);
  assert.equal(d.state.enemies[0].known_moves.length, 0, "unrevealed enemy moves are hidden");
  assert.equal(d.state.enemies[0].hp, undefined, "exact enemy HP hidden by default");
  assert.deepEqual(plain(d.state.party[0].stat_stages), { ATK: 1 });
  // Lean state: no internal ids, no per-target numbers in the party's moves (they're in labels).
  assert.equal(d.state.party[0].id, undefined);
  assert.equal(d.state.party[0].species_id, undefined);
  assert.equal(d.state.party[0].moves[0].effectiveness, undefined);
  assert.equal(d.state.party[0].moves[0].effect, "May paralyze.", "on-field moves keep their effect text");
  assert.equal(d.state.party[1].moves[0].effect, undefined);
  assert.ok(d.state.pokeballs && Array.isArray(d.state.recent_log));
});

test("non-battle decisions get the team and the run, not the battlefield or the log", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  class ModifierSelectUiHandler {
    awaitingActionInput = true;
    onActionInput = () => true;
    options = [{ modifierTypeOption: { cost: 0, type: { name: "Rare Candy", getDescription: () => "" } } }];
    shopOptionsRows = [];
    rerollCost = -1;
  }
  scene.ui._handler = new ModifierSelectUiHandler();
  scene._phase = { phaseName: "SelectModifierPhase" };
  const st = ctx.__prBot.getDecision().state;
  assert.deepEqual(Object.keys(st).sort(), ["biome", "money", "party", "pokeballs", "wave"]);
  assert.equal(st.party[0].on_field, undefined);
});

test("revealHidden exposes enemy movesets and exact HP", () => {
  const ctx = loadBridge();
  ctx.__prScene = makeScene().scene;
  const d = ctx.__prBot.getDecision({ revealHidden: true });
  assert.equal(d.state.enemies[0].known_moves[0].name, "Surf");
  assert.equal(d.state.enemies[0].hp, 50);
});

test("fight action enters the fight menu then issues the command", async () => {
  const ctx = loadBridge();
  const { scene, phase } = makeScene();
  ctx.__prScene = scene;
  const d = ctx.__prBot.getDecision();
  const r = await ctx.__prBot.act(d.seq, "move:1");
  assert.equal(r.ok, true);
  assert.deepEqual(plain(scene.ui.modes[0]), [3, 0]);
  assert.deepEqual(phase.calls, [[0, 1]]);
});

test("stale or unknown actions are rejected", async () => {
  const ctx = loadBridge();
  ctx.__prScene = makeScene().scene;
  const d = ctx.__prBot.getDecision();
  assert.equal((await ctx.__prBot.act(d.seq + 1, "move:0")).ok, false);
  const d2 = ctx.__prBot.getDecision();
  assert.equal((await ctx.__prBot.act(d2.seq, "move:7")).ok, false);
});

test("modifier decision maps rewards, shop rows and reroll to callback coordinates", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const opt = (name, cost = 0) => ({
    modifierTypeOption: { cost, type: { name, getDescription: () => `${name} desc` } },
  });
  const calls = [];
  const cb = (row, col) => {
    calls.push([row, col]);
    return true;
  };
  class ModifierSelectUiHandler {
    awaitingActionInput = true;
    onActionInput = cb;
    options = [opt("Potion"), opt("Rare Candy")];
    shopOptionsRows = [[opt("Super Potion", 300), opt("Revive", 900)], [opt("Ether", 400)]];
    rerollCost = 250;
  }
  scene.ui._handler = new ModifierSelectUiHandler();
  scene._phase = { phaseName: "SelectModifierPhase" };
  let d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "modifier");
  assert.deepEqual(
    plain(d.options.map(o => o.id)),
    ["reward:0", "reward:1", "shop:0:0", "shop:1:0", "reroll"], // Revive is unaffordable
  );
  await ctx.__prBot.act(d.seq, "shop:0:0");
  // The phase re-opens the menu with a fresh callback after a purchase.
  Object.assign(scene.ui._handler, { awaitingActionInput: true, onActionInput: cb });
  d = ctx.__prBot.getDecision();
  await ctx.__prBot.act(d.seq, "shop:1:0");
  // The phase re-opens the menu with a fresh callback after a purchase.
  Object.assign(scene.ui._handler, { awaitingActionInput: true, onActionInput: cb });
  d = ctx.__prBot.getDecision();
  await ctx.__prBot.act(d.seq, "reward:1");
  // Two shop rows: first row is rowCursor 3, second row is rowCursor 2 (matches SelectModifierPhase).
  assert.deepEqual(calls, [[3, 0], [2, 0], [1, 1]]);
});

test("faint switch: party decision excludes fainted and on-field, then sends out", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  class PartyUiHandler {
    partyUiMode = 1;
    optionsMode = false;
    options = [];
    cursor = 0;
    log = [];
    setCursor(c) {
      if (this.optionsMode) {
        this.optionsCursor = c;
      } else {
        this.cursor = c;
      }
    }
    processInput(b) {
      this.log.push(b);
      if (!this.optionsMode) {
        this.optionsMode = true;
        this.options = [0 /* SEND_OUT */, 6 /* SUMMARY */, -1 /* CANCEL */];
      } else {
        this.sent = this.options[this.optionsCursor];
      }
    }
    allowCancel() {
      return false;
    }
  }
  const h = new PartyUiHandler();
  scene.ui._handler = h;
  scene._phase = { phaseName: "SwitchPhase" };
  const d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "party");
  assert.deepEqual(plain(d.options.map(o => o.id)), ["slot:1"]);
  assert.match(d.options[0].label, /Squirtle \(Lv10, 50\/50 HP; WATER; best move Surf 1x vs Gyarados\)/);
  assert.match(d.prompt, /send out against Gyarados/);
  await ctx.__prBot.act(d.seq, "slot:1");
  assert.equal(h.cursor, 1);
  assert.equal(h.sent, 0, "SEND_OUT chosen automatically as the only real option");
});

test("learn move: decision at the first confirm, then plan drives summary selection", async () => {
  const ctx = loadBridge();
  const { scene, pika } = makeScene();
  ctx.__prScene = scene;
  const picked = [];
  class ConfirmUiHandler {
    options = [
      { label: "Yes", handler: () => picked.push("yes") || true },
      { label: "No", handler: () => picked.push("no") || true },
    ];
    clear() {}
  }
  const phase = { phaseName: "LearnMovePhase", moveId: 5, getPokemon: () => pika };
  scene._phase = phase;
  scene.ui._handler = new ConfirmUiHandler();
  let d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "learn_move");
  assert.equal(d.new_move.name, "Iron Tail");
  assert.deepEqual(plain(d.options.map(o => o.id)), ["forget:0", "forget:1", "forget:2", "keep"]);
  await ctx.__prBot.act(d.seq, "forget:2");
  assert.deepEqual(picked, ["yes"]);

  const chosen = [];
  class SummaryUiHandler {
    moveSelectFunction = i => chosen.push(i);
  }
  scene.ui._handler = new SummaryUiHandler();
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(chosen, [2]);
});

test("unknown screens fall back to pressing Action", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  class BattleMessageUiHandler {}
  scene.ui._handler = new BattleMessageUiHandler();
  scene._phase = { phaseName: "MessagePhase" };
  const d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "advance");
});

function fakeLocalStorage(initial = {}) {
  const store = { ...initial };
  return {
    store,
    getItem: k => (k in store ? store[k] : null),
    setItem: (k, v) => {
      store[k] = String(v);
    },
  };
}

test("applySettings merges into existing settings and reports changes", () => {
  const ctx = loadBridge();
  const ls = fakeLocalStorage({ settings: JSON.stringify({ meta: { gameVersion: "1.12.2" }, general: { gameSpeed: 3, playerGender: 1 } }) });
  ctx.localStorage = ls;
  ctx.__prScene = makeScene().scene;
  const desired = { general: { gameSpeed: 5, battleStyle: 1 }, display: { enableMoveAnimations: false } };
  assert.deepEqual(plain(ctx.__prBot.applySettings(desired)), { ok: true, changed: true });
  const saved = JSON.parse(ls.store.settings);
  assert.deepEqual(saved.general, { gameSpeed: 5, playerGender: 1, battleStyle: 1 });
  assert.equal(saved.meta.gameVersion, "1.12.2");
  assert.deepEqual(plain(ctx.__prBot.applySettings(desired)), { ok: true, changed: false });
});

test("applySettings creates settings with the game version when none exist", () => {
  const ctx = loadBridge();
  const ls = fakeLocalStorage();
  ctx.localStorage = ls;
  const { scene } = makeScene();
  scene.game = { config: { gameVersion: "1.12.2.3" } };
  ctx.__prScene = scene;
  assert.equal(ctx.__prBot.applySettings({ general: { gameSpeed: 5 } }).changed, true);
  assert.equal(JSON.parse(ls.store.settings).meta.gameVersion, "1.12.2.3");
});

test("starterCandidates lists only unlocked species with cost and types", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  scene.gameData.dexData = { 1: { caughtAttr: 1 }, 4: { caughtAttr: 0 } };
  scene.gameData.getSpeciesStarterValue = () => 3;
  class StarterSelectUiHandler {
    pokerusSpeciesIds = [1];
    starterContainers = [
      { species: { speciesId: 1, name: "Bulbasaur", type1: 11, type2: 3, baseTotal: 318 }, cost: 3 },
      { species: { speciesId: 4, name: "Charmander", type1: 9, type2: null, baseTotal: 309 }, cost: 3 },
    ];
  }
  scene.ui._handler = new StarterSelectUiHandler();
  const r = plain(ctx.__prBot.starterCandidates());
  assert.deepEqual(r.candidates, [
    { id: 1, name: "Bulbasaur", types: ["GRASS", "POISON"], cost: 3, bst: 318, pokerus: true },
  ]);
});

function saveSlotHandler(slots, uiMode) {
  class SaveSlotSelectUiHandler {
    cursor = 0;
    scrollCursor = 0;
    pressed = 0;
    constructor() {
      this.uiMode = uiMode;
      this.sessionSlots = slots;
    }
    setCursor(c) {
      this.cursor = c;
    }
    processInput() {
      this.pressed++;
    }
  }
  return new SaveSlotSelectUiHandler();
}

test("save slot: never saves over an occupied (or malformed) slot", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const h = saveSlotHandler([{ hasData: true }, { hasData: false, malformed: true }, { hasData: false }], 1);
  scene.ui._handler = h;
  scene._phase = { phaseName: "SelectStarterPhase" };
  let d = ctx.__prBot.getDecision();
  assert.deepEqual(plain(d.slots.map(x => x.has_data)), [true, true, false]);
  for (const id of ["slot:0", "slot:1"]) {
    const r = await ctx.__prBot.act(d.seq, id);
    assert.equal(r.ok, false);
    assert.match(r.error, /refusing to save over occupied slot/);
    d = ctx.__prBot.getDecision();
  }
  assert.equal(h.pressed, 0);
  assert.equal((await ctx.__prBot.act(d.seq, "slot:2")).ok, true);
  assert.equal(h.pressed, 1);
});

test("save slot guard: overwrite confirm is always answered No, delete menus are cancelled", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const picked = [];
  const mk = name => ({ label: name, handler: () => picked.push(name) || true });
  class ConfirmUiHandler {
    options = [mk("Yes"), mk("No")];
    clear() {}
  }
  scene.ui._handler = new ConfirmUiHandler();
  scene.ui.mode = 14;
  scene.ui.modeChain = [7];
  let d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(picked, ["No"]);

  class OptionSelectUiHandler {
    options = [mk("Load Game"), mk("Rename Run"), mk("Delete Run"), mk("Cancel")];
    clear() {}
  }
  scene.ui._handler = new OptionSelectUiHandler();
  scene.ui.mode = 17;
  d = ctx.__prBot.getDecision();
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(picked, ["No", "Cancel"], "no load without the bot having picked its own slot");
});

test("dangerous menu options are never offered or executed", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  class OptionSelectUiHandler {
    options = [{ label: "Delete Run", handler: () => true }, { label: "Keep going", handler: () => true }];
    clear() {}
  }
  scene.ui._handler = new OptionSelectUiHandler();
  scene._phase = { phaseName: "SomePhase" };
  const d = ctx.__prBot.getDecision();
  assert.deepEqual(plain(d.options.map(o => o.label)), ["Keep going"]);
});

test("mystery encounter: reads labels and tooltips, skips disabled options, selects by index", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const texts = arr => ({ getAll: () => arr.map(t => ({ text: t })) });
  const tips = ["Battle the trainer for an item.", "Pay 500 money.", "Walk away."];
  class MysteryEncounterUiHandler {
    blockInput = false;
    cursor = 0;
    encounterOptions = [{ optionMode: 0 }, { optionMode: 1 }, { optionMode: 0 }];
    optionsMeetsReqs = [true, false, true];
    optionsContainer = texts(["[color=#f8f8f8]Fight[/color]", "Pay", "Leave", "View Party"]);
    descriptionContainer = texts(["A Rival Appears", "A trainer blocks the path."]);
    tooltipContainer = { getAll: () => [{ text: tips[this.cursor] }] };
    pressed = [];
    getCursor() {
      return this.cursor;
    }
    setCursor(c) {
      this.cursor = c;
    }
    displayOptionTooltip() {}
    processInput() {
      this.pressed.push(this.cursor);
      return true;
    }
  }
  const h = new MysteryEncounterUiHandler();
  scene.ui._handler = h;
  scene._phase = { phaseName: "MysteryEncounterPhase" };
  h.blockInput = true;
  assert.equal(ctx.__prBot.getDecision().kind, "wait");
  h.blockInput = false;
  const d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "mystery");
  assert.equal(d.prompt, "A Rival Appears A trainer blocks the path.");
  assert.deepEqual(plain(d.options.map(o => [o.id, o.label])), [
    ["me:0", "Fight - Battle the trainer for an item."],
    ["me:2", "Leave - Walk away."],
  ]);
  assert.equal(h.cursor, 0, "cursor restored after reading tooltips");
  await ctx.__prBot.act(d.seq, "me:2");
  assert.deepEqual(plain(h.pressed), [2]);
});

test("chooseStarters uses the starter screen's moveset, pokerus and passive; refuses empty movesets", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  scene.gameData.dexData = { 1: { caughtAttr: 1, natureAttr: 0, ivs: [31] }, 4: { caughtAttr: 1, natureAttr: 0, ivs: [1] } };
  scene.gameData.getSpeciesStarterValue = () => 3;
  scene.gameData.getNaturesForAttr = () => [5];
  scene.gameData.starterData = { 1: { passiveAttr: 3 }, 4: { passiveAttr: 1 } };
  scene.gameMode.getStartingMoney = () => 1000;
  const movesets = { 1: [33, 45, 75], 4: [] };
  let started = null;
  class StarterSelectUiHandler {
    pokerusSpeciesIds = [4];
    starterMoveset = null;
    starterSelectCallback = st => {
      started = st;
    };
    populateStarterMoveset(id) {
      this.starterMoveset = movesets[id];
    }
  }
  const h = new StarterSelectUiHandler();
  scene.ui._handler = h;
  const bad = plain(await ctx.__prBot.chooseStarters([1, 4]));
  assert.equal(bad.ok, false);
  assert.match(bad.error, /moveset/);
  assert.equal(started, null, "no run started with a broken moveset");
  movesets[4] = [10, 45];
  assert.equal((await ctx.__prBot.chooseStarters([1, 4])).ok, true);
  const st = plain(started);
  assert.deepEqual(st.map(x => x.moveset), [[33, 45, 75], [10, 45]]);
  assert.deepEqual(st.map(x => x.pokerus), [false, true]);
  assert.deepEqual(st.map(x => x.passive), [true, false]);
  assert.deepEqual(st.map(x => x.nature), [5, 5]);
});

test("targeted rewards become one option per valid target, and the plan answers the party screen", async () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  const party = [mon("Rowlet", { hp: 20 }), mon("Litten"), mon("Popplio", { hp: 0 })];
  scene.getPlayerParty = () => party;
  class PokemonModifierType {}
  class PokemonHpRestoreModifierType extends PokemonModifierType {
    name = "Potion";
    getDescription = () => "Heals 20 HP";
    selectFilter = p => (p.isFainted() || p.hp >= p.getMaxHp() ? "It won't have any effect." : null);
  }
  class PokemonReviveModifierType extends PokemonModifierType {
    name = "Revive";
    getDescription = () => "Revives one Pokemon";
    selectFilter = p => (p.isFainted() ? null : "It won't have any effect.");
  }
  const calls = [];
  class ModifierSelectUiHandler {
    awaitingActionInput = true;
    onActionInput = (row, col) => calls.push([row, col]) || true;
    options = [
      { modifierTypeOption: { cost: 0, type: new PokemonHpRestoreModifierType() } },
      { modifierTypeOption: { cost: 0, type: { name: "Rare Candy", getDescription: () => "Level up" } } },
    ];
    shopOptionsRows = [[{ modifierTypeOption: { cost: 400, type: new PokemonReviveModifierType() } }]];
    rerollCost = -1;
  }
  scene.ui._handler = new ModifierSelectUiHandler();
  scene._phase = { phaseName: "SelectModifierPhase" };
  let d = ctx.__prBot.getDecision();
  assert.deepEqual(plain(d.options.map(o => o.id)), ["reward:0@slot:0", "reward:1", "shop:0:0@slot:2"]);
  assert.match(d.options[2].label, /Buy Revive for 400 and use it on Popplio \(Lv10, fainted\)/);
  assert.equal(d.options[2].target, 2);

  await ctx.__prBot.act(d.seq, "shop:0:0@slot:2");
  assert.deepEqual(calls, [[2, 0]]);

  // The game now opens the party screen: the bot answers it with the planned slot.
  class PartyUiHandler {
    partyUiMode = 2;
    optionsMode = false;
    options = [];
    cursor = 0;
    setCursor(c) {
      this.cursor = c;
    }
    processInput() {
      this.applied = this.cursor;
    }
    allowCancel() {
      return true;
    }
  }
  const ph = new PartyUiHandler();
  scene.ui._handler = ph;
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  assert.equal(d.act.slot, 2);
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.equal(ph.applied, 2);

  // If the game refused and is still on the party screen, ask normally instead of looping.
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "party");
  assert.equal(d.item, "Revive");
});

test("doubles: single-target moves become move-on-target options and the plan answers the target screen", async () => {
  const ctx = loadBridge();
  const { scene, phase, pika, enemy } = makeScene();
  ctx.__prScene = scene;
  const enemy2 = mon("Magikarp", { id: 129, onField: true, player: false, types: [10] });
  scene.getEnemyField = () => [enemy, enemy2];
  scene.getField = () => [pika, null, enemy, enemy2];
  scene.currentBattle.double = true;
  // Thunderbolt is single-target; Quick Attack pretends to be a spread move.
  ctx.__prGetMoveTargets = (_user, moveId) =>
    moveId === 1 ? { targets: [2, 3], multiple: false } : { targets: [2, 3], multiple: true };
  let d = ctx.__prBot.getDecision();
  const moves = d.options.filter(o => o.id.startsWith("move:"));
  assert.deepEqual(plain(moves.map(o => o.id)), ["move:0@target:2", "move:0@target:3", "move:1"]);
  assert.match(moves[0].label, /^Use Thunderbolt on Gyarados \(enemy, 2x\)/);
  assert.match(moves[2].label, /hits Gyarados and Magikarp/);

  await ctx.__prBot.act(d.seq, "move:0@target:3");
  assert.deepEqual(plain(phase.calls), [[0, 0]]);

  const picked = [];
  class TargetSelectUiHandler {
    targets = [2, 3];
    targetSelectCallback = t => picked.push(t);
  }
  scene.ui._handler = new TargetSelectUiHandler();
  scene._phase = { phaseName: "SelectTargetPhase" };
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(plain(picked), [[3]]);
  // Plan spent: if the screen comes back, ask normally.
  assert.equal(ctx.__prBot.getDecision().kind, "target");
});

test("spread moves confirm the target screen with every target; switch labels show the matchup", async () => {
  const ctx = loadBridge();
  const { scene, pika, enemy } = makeScene();
  ctx.__prScene = scene;
  const enemy2 = mon("Magikarp", { id: 129, onField: true, player: false, types: [10] });
  scene.getEnemyField = () => [enemy, enemy2];
  scene.getField = () => [pika, null, enemy, enemy2];
  ctx.__prGetMoveTargets = () => ({ targets: [2, 3], multiple: true });
  let d = ctx.__prBot.getDecision();
  const sw = d.options.find(o => o.id === "switch:1");
  assert.match(sw.label, /Switch to Squirtle \(Lv10, 50\/50 HP; WATER; best move Surf 1x vs Gyarados\)/);
  await ctx.__prBot.act(d.seq, "move:0");

  const picked = [];
  class TargetSelectUiHandler {
    targets = [2, 3];
    isMultipleTargets = true;
    targetSelectCallback = t => picked.push(t);
  }
  scene.ui._handler = new TargetSelectUiHandler();
  scene._phase = { phaseName: "SelectTargetPhase" };
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(plain(picked), [[2, 3]]);
});

test("full party after a catch: one decision to release a specific member, then the release is automatic", async () => {
  const ctx = loadBridge();
  const { scene, pika, enemy } = makeScene();
  ctx.__prScene = scene;
  const picked = [];
  class OptionSelectUiHandler {
    options = [
      { label: "Yes", handler: () => picked.push("yes") || true },
      { label: "No", handler: () => picked.push("no") || true },
    ];
    clear() {}
  }
  scene._phase = { phaseName: "AttemptCapturePhase", getPokemon: () => enemy };
  scene.ui._handler = new OptionSelectUiHandler();
  let d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "catch_full");
  assert.deepEqual(plain(d.options.map(o => o.id)), ["release:0", "release:1", "release:2", "decline"]);
  assert.match(d.options[1].label, /^Keep Gyarados and release Squirtle \(Lv10, WATER/);
  assert.match(d.prompt, /You caught Gyarados/);
  assert.equal(d.state.enemies, undefined, "the caught Pokemon isn't shown again as an enemy");
  assert.ok(d.state.party.length === 3);
  await ctx.__prBot.act(d.seq, "release:1");
  assert.deepEqual(picked, ["yes"]);

  class PartyUiHandler {
    partyUiMode = 5;
    optionsMode = false;
    options = [];
    cursor = 0;
    setCursor(c) {
      if (this.optionsMode) this.optionsCursor = c;
      else this.cursor = c;
    }
    processInput() {
      if (!this.optionsMode) {
        this.optionsMode = true;
        this.options = [11 /* RELEASE */, 6 /* SUMMARY */, -1];
      } else {
        this.chosen = this.options[this.optionsCursor];
      }
    }
    allowCancel() {
      return true;
    }
  }
  const ph = new PartyUiHandler();
  scene.ui._handler = ph;
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.equal(ph.cursor, 1);
  assert.equal(ph.chosen, 11);

  // "Do you really want to release Squirtle?" -> yes, without asking.
  scene.ui._handler = new OptionSelectUiHandler();
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(picked, ["yes", "yes"]);
});

test("doubles: both Pokemon's commands in one decision; the partner's is applied on its turn", async () => {
  const ctx = loadBridge();
  const { scene, phase, pika, enemy } = makeScene();
  ctx.__prScene = scene;
  const squirtle = scene.getPlayerParty()[1];
  squirtle.isOnField = () => true;
  squirtle.isActive = () => true;
  const enemy2 = mon("Magikarp", { id: 129, onField: true, player: false, types: [10] });
  scene.getEnemyField = () => [enemy, enemy2];
  scene.getField = () => [pika, squirtle, enemy, enemy2];
  scene.getPlayerField = () => [pika, squirtle];
  scene.currentBattle.double = true;
  ctx.__prGetMoveTargets = (_u, moveId) =>
    moveId === 1 ? { targets: [2, 3], multiple: false } : { targets: [2, 3], multiple: true };

  let d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "command");
  assert.equal(d.partner.acting, "Squirtle");
  const partnerIds = plain(d.partner.options.map(o => o.id));
  assert.ok(partnerIds.includes("move:0"));
  assert.ok(!partnerIds.some(id => id.startsWith("ball:") || id === "run"), "balls/run are first-slot only");
  assert.equal((await ctx.__prBot.act(d.seq, "move:0@target:3+nope")).ok, false);
  d = ctx.__prBot.getDecision();
  assert.equal((await ctx.__prBot.act(d.seq, "move:0@target:3+move:0")).ok, true);
  assert.deepEqual(plain(phase.calls), [[0, 0]]);

  const phase2 = new CommandPhase(squirtle);
  phase2.getFieldIndex = () => 1;
  scene._phase = phase2;
  d = ctx.__prBot.getDecision();
  assert.equal(d.kind, "auto");
  assert.match(d.planned, /^Squirtle: Use Surf/);
  await ctx.__prBot.act(d.seq, "__auto__");
  assert.deepEqual(plain(phase2.calls), [[0, 0]]);
  // Plan is used once: the next look at this phase is a normal decision.
  assert.equal(ctx.__prBot.getDecision().kind, "command");
});

test("skip is only offered when no free reward can be taken", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  class PokemonModifierType {}
  class PokemonReviveModifierType extends PokemonModifierType {
    name = "Revive";
    getDescription = () => "";
    selectFilter = () => "It won't have any effect.";
  }
  class ModifierSelectUiHandler {
    awaitingActionInput = true;
    onActionInput = () => true;
    options = [{ modifierTypeOption: { cost: 0, type: new PokemonReviveModifierType() } }];
    shopOptionsRows = [];
    rerollCost = -1;
  }
  scene.ui._handler = new ModifierSelectUiHandler();
  scene._phase = { phaseName: "SelectModifierPhase" };
  assert.deepEqual(plain(ctx.__prBot.getDecision().options.map(o => o.id)), ["skip"]);
});

test("reward screen previews upcoming special waves; gym waves stay unknown until wave 20", () => {
  const ctx = loadBridge();
  const { scene } = makeScene();
  ctx.__prScene = scene;
  scene.gameMode.getName = () => "Classic";
  class ModifierSelectUiHandler {
    awaitingActionInput = true;
    onActionInput = () => true;
    options = [{ modifierTypeOption: { cost: 0, type: { name: "Rare Candy", getDescription: () => "" } } }];
    shopOptionsRows = [];
    rerollCost = -1;
  }
  scene.ui._handler = new ModifierSelectUiHandler();
  scene._phase = { phaseName: "SelectModifierPhase" };
  scene.offsetGym = true; // gyms on 30, 60, ...
  scene.currentBattle.waveIndex = 7;
  let p = ctx.__prBot.getDecision().prompt;
  assert.match(p, /wave 8 \(in 1\): RIVAL battle/);
  assert.match(p, /wave 10 \(in 3\): wild boss/);
  assert.match(p, /wave 20 \(in 13\): GYM LEADER battle if this run's gyms are on this wave/);
  scene.currentBattle.waveIndex = 20;
  p = ctx.__prBot.getDecision().prompt;
  assert.match(p, /wave 25 \(in 5\): RIVAL battle/);
  assert.match(p, /wave 30 \(in 10\): GYM LEADER battle \(hard\)/);
  assert.match(p, /wave 35 \(in 15\): evil team grunt battle/);
  // The preview is only on the reward screen.
  scene.ui._handler = new CommandUiHandler();
  scene._phase = new CommandPhase(scene.getPlayerParty()[0]);
  assert.doesNotMatch(JSON.stringify(ctx.__prBot.getDecision()), /Coming up/);
});
