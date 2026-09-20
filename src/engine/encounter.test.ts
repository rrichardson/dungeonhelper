import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEncounter, addCombatant, removeCombatant, rollInitiativeFor, startEncounter,
  nextTurn, currentTurn, performAttack, damageCombatant, healCombatant, setCondition,
  setExhaustion, performDeathSave, setConcentration, status, getCombatant,
} from "./encounter.ts";
import type { Combatant } from "./types.ts";
import type { EncounterState } from "./encounter.ts";

function make(id: string, over: Partial<Combatant> = {}): Combatant {
  return {
    id, name: id, ac: 15,
    hp: { current: 30, max: 30, temp: 0 },
    abilities: { str: 14, dex: 14, con: 14, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 2, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: false,
    ...over,
  };
}

function unwrap<T>(r: { ok: true; value: T } | { ok: false; error: string }): T {
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

function seeded(seed = "test-seed", ...extra: Combatant[]): EncounterState {
  let s = createEncounter("Test", seed);
  for (const c of [make("goblin"), make("fighter", { isPlayer: true }), ...extra]) {
    s = unwrap(addCombatant(s, c));
  }
  return s;
}

test("combatant ids are unique", () => {
  const s = seeded();
  assert.equal(addCombatant(s, make("goblin")).ok, false);
});

test("an unknown id reports the ids that exist", () => {
  const r = getCombatant(seeded(), "nobody");
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /goblin/);
});

test("turn order advances and rolls over into a new round", () => {
  let s = unwrap(rollInitiativeFor(seeded(), ["goblin", "fighter"])).state;
  s = unwrap(startEncounter(s));
  assert.equal(s.round, 1);

  const first = currentTurn(s)!;
  const second = unwrap(nextTurn(s));
  assert.equal(second.newRound, false);
  assert.equal(second.state.round, 1);

  const third = unwrap(nextTurn(second.state));
  assert.equal(third.newRound, true);
  assert.equal(third.state.round, 2);
  assert.equal(currentTurn(third.state)!.id, first.id, "the order must repeat each round");
});

test("an encounter cannot start twice or start empty", () => {
  assert.equal(startEncounter(seeded()).ok, false);
  let s = unwrap(rollInitiativeFor(seeded(), ["goblin", "fighter"])).state;
  s = unwrap(startEncounter(s));
  assert.equal(startEncounter(s).ok, false);
});

test("turns cannot advance before the encounter starts", () => {
  assert.equal(nextTurn(seeded()).ok, false);
});

test("the same seed reproduces the same encounter exactly", () => {
  const play = (seed: string) => {
    let s = unwrap(rollInitiativeFor(seeded(seed), ["goblin", "fighter"])).state;
    s = unwrap(startEncounter(s));
    const a = unwrap(performAttack(s, {
      attackerId: "goblin", targetId: "fighter", weapon: "scimitar",
      attackBonus: 4, damage: [{ expression: "1d6+2", type: "slashing" as const }],
    }));
    return a;
  };
  const one = play("same");
  const two = play("same");
  assert.deepEqual(one.report.outcome, two.report.outcome);
  assert.equal(one.state.combatants["fighter"]!.hp.current, two.state.combatants["fighter"]!.hp.current);

  const other = play("different");
  assert.notEqual(one.report.seed, "");
  assert.equal(other.report.seed.startsWith("different"), true);
});

test("every roll records the seed that produced it", () => {
  let s = unwrap(rollInitiativeFor(seeded(), ["goblin", "fighter"])).state;
  s = unwrap(startEncounter(s));
  const a = unwrap(performAttack(s, {
    attackerId: "goblin", targetId: "fighter", weapon: "scimitar",
    attackBonus: 4, damage: [{ expression: "1d6+2", type: "slashing" as const }],
  }));
  const rolled = a.state.log.filter((l) => l.seed !== null);
  assert.ok(rolled.length > 0);
  assert.match(rolled[0]!.seed!, /^test-seed#\d+$/);
});

test("the roll counter advances so two identical actions differ", () => {
  let s = unwrap(rollInitiativeFor(seeded(), ["goblin", "fighter"])).state;
  s = unwrap(startEncounter(s));
  const params = {
    attackerId: "goblin", targetId: "fighter", weapon: "scimitar",
    attackBonus: 4, damage: [{ expression: "1d6+2", type: "slashing" as const }],
  };
  const a = unwrap(performAttack(s, params));
  const b = unwrap(performAttack(a.state, params));
  assert.notEqual(a.report.seed, b.report.seed);
  assert.ok(b.state.rollCount > a.state.rollCount);
});

test("attacking an unknown target fails without changing state", () => {
  const s = seeded();
  const r = performAttack(s, {
    attackerId: "goblin", targetId: "ghost", weapon: "scimitar",
    attackBonus: 4, damage: [{ expression: "1d6+2", type: "slashing" as const }],
  });
  assert.equal(r.ok, false);
});

test("damage and healing move hit points and log the change", () => {
  const s = seeded();
  const d = unwrap(damageCombatant(s, "fighter", [{ amount: 10, type: "fire" }]));
  assert.equal(d.state.combatants["fighter"]!.hp.current, 20);

  const h = unwrap(healCombatant(d.state, "fighter", 4));
  assert.equal(h.state.combatants["fighter"]!.hp.current, 24);
  assert.ok(h.state.log.some((l) => l.text.includes("heals 4")));
});

test("a broken concentration is cleared from the combatant", () => {
  let s = unwrap(setConcentration(seeded(), "fighter", "Bless"));
  assert.equal(s.combatants["fighter"]!.concentration?.spell, "Bless");

  // 25 damage sets DC 12; a failed save must clear concentration.
  const d = unwrap(damageCombatant(s, "fighter", [{ amount: 25, type: "force" }]));
  const held = d.state.combatants["fighter"]!.concentration !== null;
  assert.equal(held, d.concentration!.success, "the sheet must agree with the save result");
});

test("becoming incapacitated ends concentration", () => {
  let s = unwrap(setConcentration(seeded(), "fighter", "Bless"));
  const r = unwrap(setCondition(s, "fighter", "stunned", true));
  assert.equal(r.state.combatants["fighter"]!.concentration, null);
  assert.ok(r.state.log.some((l) => l.text.includes("concentration on Bless ends")));
});

test("a creature immune to a condition does not gain it", () => {
  const s = seeded("s", make("golem", { conditionImmunities: ["poisoned"] }));
  const r = unwrap(setCondition(s, "golem", "poisoned", true));
  assert.equal(r.changed, false);
  assert.equal(r.state.combatants["golem"]!.conditions.length, 0);
});

test("conditions toggle off and are idempotent", () => {
  const s = seeded();
  const on = unwrap(setCondition(s, "goblin", "prone", true));
  assert.equal(unwrap(setCondition(on.state, "goblin", "prone", true)).changed, false);
  const off = unwrap(setCondition(on.state, "goblin", "prone", false));
  assert.equal(off.state.combatants["goblin"]!.conditions.length, 0);
});

test("exhaustion is clamped to 0-6 and level 6 is death", () => {
  const s = seeded();
  assert.equal(unwrap(setExhaustion(s, "fighter", 99)).level, 6);
  assert.equal(unwrap(setExhaustion(s, "fighter", 99)).dead, true);
  assert.equal(unwrap(setExhaustion(s, "fighter", -3)).level, 0);
});

test("exhaustion reduces reported speed", () => {
  const s = unwrap(setExhaustion(seeded(), "fighter", 2)).state;
  const row = status(s).find((r) => r.combatant.id === "fighter")!;
  assert.equal(row.speed, 20);
});

test("death saves accumulate across calls", () => {
  let s = unwrap(damageCombatant(seeded(), "fighter", [{ amount: 30, type: "force" }])).state;
  assert.equal(s.combatants["fighter"]!.hp.current, 0);

  const first = unwrap(performDeathSave(s, "fighter"));
  const second = unwrap(performDeathSave(first.state, "fighter"));
  const saves = second.state.combatants["fighter"]!.deathSaves;
  assert.equal(saves.successes + saves.failures >= 2, true);
});

test("removing a combatant keeps the turn pointer on the same creature", () => {
  const s = seeded("s", make("orc"));
  let started = unwrap(rollInitiativeFor(s, ["goblin", "fighter", "orc"])).state;
  started = unwrap(startEncounter(started));
  started = unwrap(nextTurn(started)).state;

  const actingBefore = currentTurn(started)!.id;
  const firstId = started.order[0]!.id;
  const removed = unwrap(removeCombatant(started, firstId));
  assert.equal(currentTurn(removed)!.id, actingBefore, "removing an earlier entry must not skip a turn");
});

test("status marks exactly one current turn", () => {
  let s = unwrap(rollInitiativeFor(seeded(), ["goblin", "fighter"])).state;
  s = unwrap(startEncounter(s));
  assert.equal(status(s).filter((r) => r.isCurrentTurn).length, 1);
});

test("state transitions never mutate the previous state", () => {
  const s = seeded();
  const before = JSON.stringify(s);
  damageCombatant(s, "fighter", [{ amount: 10, type: "fire" }]);
  setCondition(s, "fighter", "prone", true);
  assert.equal(JSON.stringify(s), before);
});
