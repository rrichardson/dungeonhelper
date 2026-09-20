import { test } from "node:test";
import assert from "node:assert/strict";
import { savingThrow, abilityCheck, concentrationSave } from "./checks.ts";
import { rollDeathSave, stabilise } from "./death.ts";
import { rollInitiative, sortInitiative } from "./initiative.ts";
import { makeFixedRng } from "./rng.ts";
import type { Combatant } from "./types.ts";

function make(id: string, over: Partial<Combatant> = {}): Combatant {
  return {
    id, name: id, ac: 15,
    hp: { current: 30, max: 30, temp: 0 },
    abilities: { str: 14, dex: 12, con: 16, int: 10, wis: 8, cha: 10 },
    proficiencyBonus: 3, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: false,
    ...over,
  };
}

test("a save adds the ability modifier", () => {
  const o = savingThrow({ creature: make("a"), ability: "con", dc: 15 }, makeFixedRng([12]));
  assert.equal(o.roll?.total, 15);
  assert.equal(o.success, true);
  assert.equal(o.margin, 0);
});

test("meeting the DC exactly succeeds", () => {
  const o = savingThrow({ creature: make("a"), ability: "str", dc: 14 }, makeFixedRng([12]));
  assert.equal(o.roll?.total, 14);
  assert.equal(o.success, true);
});

test("save proficiency from the stat block is applied", () => {
  const o = savingThrow(
    { creature: make("a", { saveProficiencies: ["con"] }), ability: "con", dc: 20 },
    makeFixedRng([14]),
  );
  assert.equal(o.roll?.total, 14 + 3 + 3);
});

test("paralysis auto-fails STR and DEX saves without rolling", () => {
  const c = make("a", { conditions: [{ condition: "paralyzed" }] });
  const str = savingThrow({ creature: c, ability: "str", dc: 5 }, makeFixedRng([20]));
  assert.equal(str.autoFailed, true);
  assert.equal(str.success, false);
  assert.equal(str.roll, null, "an auto-failed save must not roll a die");

  const wis = savingThrow({ creature: c, ability: "wis", dc: 5 }, makeFixedRng([20]));
  assert.equal(wis.autoFailed, false);
});

test("restrained gives disadvantage on DEX saves only", () => {
  const c = make("a", { conditions: [{ condition: "restrained" }] });
  const dex = savingThrow({ creature: c, ability: "dex", dc: 10 }, makeFixedRng([18, 4]));
  assert.equal(dex.roll?.resolution.state, "disadvantage");
  assert.equal(dex.roll?.used, 4);

  const con = savingThrow({ creature: c, ability: "con", dc: 10 }, makeFixedRng([18]));
  assert.equal(con.roll?.resolution.state, "normal");
});

test("exhaustion penalises saves by 2 per level", () => {
  const o = savingThrow({ creature: make("a", { exhaustion: 2 }), ability: "con", dc: 10 }, makeFixedRng([10]));
  assert.equal(o.roll?.total, 10 + 3 - 4);
});

test("poisoned gives disadvantage on ability checks but not saves", () => {
  const c = make("a", { conditions: [{ condition: "poisoned" }] });
  const check = abilityCheck({ creature: c, ability: "str", dc: 10 }, makeFixedRng([19, 6]));
  assert.equal(check.roll?.resolution.state, "disadvantage");

  const save = savingThrow({ creature: c, ability: "str", dc: 10 }, makeFixedRng([19]));
  assert.equal(save.roll?.resolution.state, "normal");
});

test("expertise doubles proficiency on a check", () => {
  const o = abilityCheck(
    { creature: make("a"), ability: "dex", dc: 10, proficient: true, expertise: true },
    makeFixedRng([10]),
  );
  assert.equal(o.roll?.total, 10 + 1 + 6);
});

test("concentration is a CON save at the given DC", () => {
  const o = concentrationSave(make("a", { saveProficiencies: ["con"] }), 15, makeFixedRng([9]));
  assert.equal(o.ability, "con");
  assert.equal(o.roll?.total, 9 + 3 + 3);
  assert.equal(o.success, true);
});

// ── Death saves ───────────────────────────────────────────────────────────

const downed = (over: Partial<Combatant> = {}) =>
  make("pc", { isPlayer: true, hp: { current: 0, max: 30, temp: 0 }, ...over });

test("a death save of 10 or more succeeds", () => {
  const r = rollDeathSave(downed(), makeFixedRng([10]));
  assert.ok(r.ok);
  assert.equal(r.value.success, true);
  assert.equal(r.value.combatant.deathSaves.successes, 1);
});

test("a death save of 9 fails", () => {
  const r = rollDeathSave(downed(), makeFixedRng([9]));
  assert.ok(r.ok);
  assert.equal(r.value.combatant.deathSaves.failures, 1);
});

test("a natural 1 counts as two failures", () => {
  const r = rollDeathSave(downed(), makeFixedRng([1]));
  assert.ok(r.ok);
  assert.equal(r.value.failuresAdded, 2);
});

test("a natural 20 restores one hit point", () => {
  const r = rollDeathSave(downed({ conditions: [{ condition: "unconscious" }] }), makeFixedRng([20]));
  assert.ok(r.ok);
  assert.equal(r.value.effect, "revived");
  assert.equal(r.value.combatant.hp.current, 1);
  assert.equal(r.value.combatant.conditions.length, 0);
});

test("three successes stabilise", () => {
  const r = rollDeathSave(downed({ deathSaves: { successes: 2, failures: 0 } }), makeFixedRng([15]));
  assert.ok(r.ok);
  assert.equal(r.value.effect, "stabilised");
  assert.equal(r.value.combatant.stable, true);
});

test("three failures are death", () => {
  const r = rollDeathSave(downed({ deathSaves: { successes: 0, failures: 2 } }), makeFixedRng([5]));
  assert.ok(r.ok);
  assert.equal(r.value.effect, "dead");
});

test("a natural 1 at two failures is still death", () => {
  const r = rollDeathSave(downed({ deathSaves: { successes: 0, failures: 1 } }), makeFixedRng([1]));
  assert.ok(r.ok);
  assert.equal(r.value.combatant.deathSaves.failures, 3);
  assert.equal(r.value.effect, "dead");
});

test("a conscious, stable or dead creature cannot roll death saves", () => {
  assert.equal(rollDeathSave(make("a"), makeFixedRng([10])).ok, false);
  assert.equal(rollDeathSave(downed({ stable: true }), makeFixedRng([10])).ok, false);
  assert.equal(rollDeathSave(downed({ deathSaves: { successes: 0, failures: 3 } }), makeFixedRng([10])).ok, false);
});

test("stabilising clears death saves", () => {
  const r = stabilise(downed({ deathSaves: { successes: 1, failures: 2 } }));
  assert.ok(r.ok);
  assert.equal(r.value.stable, true);
  assert.deepEqual(r.value.deathSaves, { successes: 0, failures: 0 });
});

// ── Initiative ────────────────────────────────────────────────────────────

test("initiative adds the Dexterity modifier", () => {
  const e = rollInitiative(make("a", { abilities: { str: 10, dex: 18, con: 10, int: 10, wis: 10, cha: 10 } }), makeFixedRng([12, 500]));
  assert.equal(e.total, 16);
});

test("a fixed initiative skips the roll", () => {
  const e = rollInitiative(make("a"), makeFixedRng([500]), { fixed: 20 });
  assert.equal(e.total, 20);
  assert.equal(e.roll, null);
});

test("being incapacitated at initiative gives disadvantage", () => {
  const e = rollInitiative(make("a", { conditions: [{ condition: "stunned" }] }), makeFixedRng([18, 3, 500]));
  assert.equal(e.roll?.resolution.state, "disadvantage");
  assert.equal(e.roll?.used, 3);
});

test("being invisible at initiative gives advantage", () => {
  const e = rollInitiative(make("a", { conditions: [{ condition: "invisible" }] }), makeFixedRng([4, 17, 500]));
  assert.equal(e.roll?.resolution.state, "advantage");
});

test("order is highest first, ties broken by Dexterity", () => {
  const order = sortInitiative([
    { id: "a", name: "a", total: 15, dexMod: 1, tiebreak: 10, roll: null },
    { id: "b", name: "b", total: 20, dexMod: 0, tiebreak: 10, roll: null },
    { id: "c", name: "c", total: 15, dexMod: 4, tiebreak: 10, roll: null },
  ]);
  assert.deepEqual(order.map((e) => e.id), ["b", "c", "a"]);
});

test("exact ties fall to the recorded tiebreak, never to chance at read time", () => {
  const entries = [
    { id: "a", name: "a", total: 15, dexMod: 2, tiebreak: 3, roll: null },
    { id: "b", name: "b", total: 15, dexMod: 2, tiebreak: 9, roll: null },
  ];
  assert.deepEqual(sortInitiative(entries).map((e) => e.id), ["b", "a"]);
  assert.deepEqual(sortInitiative(entries).map((e) => e.id), ["b", "a"]);
});
