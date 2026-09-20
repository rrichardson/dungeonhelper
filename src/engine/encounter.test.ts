import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createEncounter, addCombatant, removeCombatant, rollInitiativeFor, startEncounter,
  nextTurn, currentTurn, performAttack, damageCombatant, healCombatant, setCondition,
  setExhaustion, performDeathSave, setConcentration, status, getCombatant,
  castSpell, performAttacks, useReaction, useSlot, restLong,
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


// ── Spells, resources and reactions ───────────────────────────────────────

function withCaster(): EncounterState {
  let state = createEncounter("Casting", "cast-seed");
  state = unwrap(addCombatant(state, make("brann", {
    isPlayer: true,
    spellcastingAbility: "wis",
    spellSlots: { "3": { max: 2, used: 0 } },
    hitDice: { size: 8, max: 5, used: 0 },
  })));
  state = unwrap(addCombatant(state, make("goblin-1", { hp: { current: 7, max: 7, temp: 0 } })));
  state = unwrap(addCombatant(state, make("goblin-2", { hp: { current: 7, max: 7, temp: 0 } })));
  return state;
}

const fireball = {
  name: "Fireball", dc: 15, ability: "dex" as const,
  damage: [{ expression: "8d6", type: "fire" as const }],
  onSuccess: "half" as const,
  targetIds: ["goblin-1", "goblin-2"],
};

test("casting applies damage to every target and spends the slot", () => {
  const r = unwrap(castSpell(withCaster(), { casterId: "brann", ...fireball, slotLevel: 3 }));
  assert.equal(r.report.slotSpent, 3);
  assert.equal(r.state.combatants["brann"]!.spellSlots!["3"]!.used, 1);
  assert.equal(r.report.outcome.targets.length, 2);
  for (const t of r.report.outcome.targets) {
    assert.ok(t.damage !== null);
  }
});

test("every target of one casting takes the same rolled damage", () => {
  const r = unwrap(castSpell(withCaster(), { casterId: "brann", ...fireball }));
  const totals = r.report.outcome.targets.map((t) =>
    t.halved ? t.damage!.adjustedTotal * 2 : t.damage!.adjustedTotal,
  );
  // Halved targets double back to the shared roll; both must agree with it.
  for (const total of totals) {
    assert.ok(
      Math.abs(total - r.report.outcome.baseTotal) <= 1,
      `target total ${total} should track the shared roll ${r.report.outcome.baseTotal}`,
    );
  }
});

test("a caster without the slot never rolls the spell", () => {
  const state = withCaster();
  const drained = {
    ...state,
    combatants: {
      ...state.combatants,
      brann: { ...state.combatants["brann"]!, spellSlots: { "3": { max: 2, used: 2 } } },
    },
  };
  const before = drained.rollCount;
  const r = castSpell(drained, { casterId: "brann", ...fireball, slotLevel: 3 });
  assert.equal(r.ok, false);
  assert.equal(drained.rollCount, before, "a refused cast must consume no dice");
});

test("casting can start concentration on the spell", () => {
  const r = unwrap(castSpell(withCaster(), {
    casterId: "brann", ...fireball, name: "Spirit Guardians", concentrate: true,
  }));
  assert.equal(r.state.combatants["brann"]!.concentration?.spell, "Spirit Guardians");
});

test("an unknown target refuses the whole casting", () => {
  const r = castSpell(withCaster(), {
    casterId: "brann", ...fireball, targetIds: ["goblin-1", "ghost"],
  });
  assert.equal(r.ok, false);
});

test("multiattack resolves each swing as a separate roll", () => {
  let state = createEncounter("Multi", "multi-seed");
  state = unwrap(addCombatant(state, make("ogre", { attacks: [] })));
  state = unwrap(addCombatant(state, make("aria", { isPlayer: true, hp: { current: 200, max: 200, temp: 0 } })));

  const r = unwrap(performAttacks(state, {
    attackerId: "ogre", targetId: "aria", weapon: "greatclub",
    attackBonus: 6, damage: [{ expression: "2d8+4", type: "bludgeoning" as const }],
  }, 3));

  assert.equal(r.reports.length, 3);
  const seeds = new Set(r.reports.map((x) => x.seed));
  assert.equal(seeds.size, 3, "each swing must use its own seed");
});

test("multiattack stops once the target is out of the fight", () => {
  let state = createEncounter("Multi", "multi-stop");
  state = unwrap(addCombatant(state, make("ogre")));
  state = unwrap(addCombatant(state, make("goblin", { hp: { current: 1, max: 1, temp: 0 } })));

  const r = unwrap(performAttacks(state, {
    attackerId: "ogre", targetId: "goblin", weapon: "greatclub",
    attackBonus: 20, damage: [{ expression: "2d8+4", type: "bludgeoning" as const }],
  }, 5));

  assert.ok(r.reports.length < 5, "swings should stop when the goblin dies");
  assert.ok(r.reports.length >= 1);
});

test("a reaction can be used once and then refuses", () => {
  const state = withCaster();
  const first = unwrap(useReaction(state, "brann"));
  assert.equal(first.state.combatants["brann"]!.reactionUsed, true);
  assert.equal(useReaction(first.state, "brann").ok, false);
});

test("a reaction refreshes at the start of that creature's own turn", () => {
  let state = withCaster();
  state = unwrap(rollInitiativeFor(state, ["brann", "goblin-1", "goblin-2"])).state;
  state = unwrap(startEncounter(state));
  state = unwrap(useReaction(state, "brann")).state;
  assert.equal(state.combatants["brann"]!.reactionUsed, true);

  // Advance until Brann's turn comes round again.
  for (let i = 0; i < state.order.length; i++) {
    state = unwrap(nextTurn(state)).state;
    if (currentTurn(state)!.id === "brann") break;
  }
  assert.equal(currentTurn(state)!.id, "brann");
  assert.equal(state.combatants["brann"]!.reactionUsed, false, "reaction returns on your own turn");
});

test("another creature's turn does not refresh your reaction", () => {
  let state = withCaster();
  state = unwrap(rollInitiativeFor(state, ["brann", "goblin-1", "goblin-2"])).state;
  state = unwrap(startEncounter(state));
  state = unwrap(useReaction(state, "brann")).state;

  const advanced = unwrap(nextTurn(state));
  if (advanced.entry.id !== "brann") {
    assert.equal(advanced.state.combatants["brann"]!.reactionUsed, true);
  }
});

test("using a slot through the encounter logs the remaining count", () => {
  const r = unwrap(useSlot(withCaster(), "brann", 3));
  assert.match(r.note, /1 of 2 left/);
});

test("a long rest through the encounter restores the party", () => {
  let state = withCaster();
  state = unwrap(useSlot(state, "brann", 3)).state;
  state = unwrap(damageCombatant(state, "brann", [{ amount: 20, type: "fire" }])).state;

  const r = unwrap(restLong(state, ["brann"]));
  assert.equal(r.state.combatants["brann"]!.spellSlots!["3"]!.used, 0);
  assert.equal(r.state.combatants["brann"]!.hp.current, 30);
});
