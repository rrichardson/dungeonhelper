import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveSpell } from "./spell.ts";
import { spendSlot, restoreSlots, shortRest, longRest, slotsOf } from "./resources.ts";
import { makeFixedRng, makeRng } from "./rng.ts";
import type { Combatant } from "./types.ts";
import { spellSaveDc } from "./types.ts";

function make(id: string, over: Partial<Combatant> = {}): Combatant {
  return {
    id, name: id, ac: 15,
    hp: { current: 40, max: 40, temp: 0 },
    abilities: { str: 10, dex: 10, con: 14, int: 10, wis: 16, cha: 10 },
    proficiencyBonus: 3, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: false,
    ...over,
  };
}

const fireball = (targets: Combatant[], onSuccess: "half" | "none" = "half") => ({
  name: "Fireball", dc: 15, ability: "dex" as const,
  damage: [{ expression: "8d6", type: "fire" as const }],
  onSuccess, targets,
});

test("area damage is rolled once and shared by every target", () => {
  // 8 sixes, then one d20 per target.
  const rng = makeFixedRng([6, 6, 6, 6, 6, 6, 6, 6, 1, 1, 1]);
  const r = resolveSpell(fireball([make("a"), make("b"), make("c")]), rng);
  assert.ok(r.ok);
  assert.equal(r.value.baseTotal, 48);
  for (const t of r.value.targets) {
    assert.equal(t.damage!.adjustedTotal, 48, `${t.targetId} must take the shared roll`);
  }
});

test("a successful save halves damage and rounds down", () => {
  // 8d6 totalling 33, then a save that beats DC 15.
  const rng = makeFixedRng([5, 4, 4, 4, 4, 4, 4, 4, 20]);
  const r = resolveSpell(fireball([make("a")]), rng);
  assert.ok(r.ok);
  assert.equal(r.value.baseTotal, 33);
  const t = r.value.targets[0]!;
  assert.equal(t.save.success, true);
  assert.equal(t.halved, true);
  assert.equal(t.damage!.adjustedTotal, 16, "33 halved rounds down to 16");
});

test("a failed save takes the damage in full", () => {
  const rng = makeFixedRng([6, 6, 6, 6, 6, 6, 6, 6, 1]);
  const r = resolveSpell(fireball([make("a")]), rng);
  assert.ok(r.ok);
  assert.equal(r.value.targets[0]!.damage!.adjustedTotal, 48);
});

test("on-success none means a save avoids the damage entirely", () => {
  const rng = makeFixedRng([6, 6, 6, 6, 6, 6, 6, 6, 20]);
  const r = resolveSpell(fireball([make("a")], "none"), rng);
  assert.ok(r.ok);
  const t = r.value.targets[0]!;
  assert.equal(t.avoided, true);
  assert.equal(t.damage, null);
  assert.equal(t.save.success, true);
});

test("a save and resistance compound to a quarter of the damage", () => {
  const rng = makeFixedRng([5, 5, 5, 5, 5, 5, 5, 5, 20]);
  const r = resolveSpell(fireball([make("a", { resistances: ["fire"] })]), rng);
  assert.ok(r.ok);
  assert.equal(r.value.baseTotal, 40);
  assert.equal(r.value.targets[0]!.damage!.adjustedTotal, 10, "40 → 20 by save → 10 by resistance");
});

test("immunity still zeroes the damage after a failed save", () => {
  const rng = makeFixedRng([6, 6, 6, 6, 6, 6, 6, 6, 1]);
  const r = resolveSpell(fireball([make("a", { immunities: ["fire"] })]), rng);
  assert.ok(r.ok);
  assert.equal(r.value.targets[0]!.damage!.adjustedTotal, 0);
});

test("a target that auto-fails its save takes full damage without rolling", () => {
  const rng = makeFixedRng([6, 6, 6, 6, 6, 6, 6, 6]);
  const r = resolveSpell(fireball([make("a", { conditions: [{ condition: "paralyzed" }] })]), rng);
  assert.ok(r.ok);
  const t = r.value.targets[0]!;
  assert.equal(t.save.autoFailed, true);
  assert.equal(t.save.roll, null);
  assert.equal(t.damage!.adjustedTotal, 48);
});

test("a spell with no damage still reports each save", () => {
  const rng = makeFixedRng([18, 3]);
  const r = resolveSpell({
    name: "Hold Person", dc: 15, ability: "wis", damage: [], onSuccess: "none",
    targets: [make("a"), make("b")],
  }, rng);
  assert.ok(r.ok);
  assert.equal(r.value.targets.length, 2);
  assert.equal(r.value.targets[0]!.damage, null);
  assert.notEqual(r.value.targets[0]!.save.success, r.value.targets[1]!.save.success);
});

test("targets must be distinct and non-empty", () => {
  const rng = makeRng("x");
  assert.equal(resolveSpell(fireball([]), rng).ok, false);
  const dup = make("a");
  assert.equal(resolveSpell(fireball([dup, dup]), rng).ok, false);
});

test("a malformed damage expression fails before any dice are rolled", () => {
  const r = resolveSpell({
    name: "Bad", dc: 15, ability: "dex",
    damage: [{ expression: "8d", type: "fire" }], onSuccess: "half",
    targets: [make("a")],
  }, makeFixedRng([1]));
  assert.equal(r.ok, false);
});

test("spell save DC is 8 + proficiency + ability modifier", () => {
  assert.equal(spellSaveDc(make("a", { spellcastingAbility: "wis" })), 8 + 3 + 3);
  assert.equal(spellSaveDc(make("a")), null, "a non-caster has no DC");
});

// ── Resources ─────────────────────────────────────────────────────────────

const caster = (used = 0) =>
  make("c", { spellSlots: { "1": { max: 4, used }, "3": { max: 2, used: 0 } } });

test("spending a slot decrements that level only", () => {
  const r = spendSlot(caster(), 1);
  assert.ok(r.ok);
  assert.equal(r.value.spellSlots!["1"]!.used, 1);
  assert.equal(r.value.spellSlots!["3"]!.used, 0);
});

test("spending a slot the caster lacks is refused", () => {
  assert.equal(spendSlot(caster(), 2).ok, false, "no level 2 slots exist");
  assert.equal(spendSlot(caster(4), 1).ok, false, "all level 1 slots are spent");
  assert.equal(spendSlot(caster(), 0).ok, false);
  assert.equal(spendSlot(caster(), 10).ok, false);
});

test("restoring returns slots of one level or all", () => {
  const spent = make("c", { spellSlots: { "1": { max: 4, used: 4 }, "3": { max: 2, used: 2 } } });
  assert.equal(restoreSlots(spent, 1).spellSlots!["1"]!.used, 0);
  assert.equal(restoreSlots(spent, 1).spellSlots!["3"]!.used, 2);
  const all = restoreSlots(spent, null);
  assert.equal(all.spellSlots!["1"]!.used, 0);
  assert.equal(all.spellSlots!["3"]!.used, 0);
});

test("slotsOf reports remaining counts and skips empty pools", () => {
  const view = slotsOf(make("c", { spellSlots: { "1": { max: 2, used: 1 }, "2": { max: 0, used: 0 } } }));
  assert.equal(view.length, 1);
  assert.deepEqual(view[0], { level: 1, max: 2, used: 1, remaining: 1 });
});

test("a short rest heals the die roll plus Constitution", () => {
  const hurt = make("h", {
    hp: { current: 10, max: 40, temp: 0 },
    hitDice: { size: 8, max: 5, used: 0 },
  });
  const r = shortRest(hurt, 2, makeFixedRng([5, 3]));
  assert.ok(r.ok);
  assert.equal(r.value.healed, (5 + 2) + (3 + 2));
  assert.equal(r.value.combatant.hitDice!.used, 2);
});

test("each hit die restores at least one hit point", () => {
  const frail = make("f", {
    hp: { current: 1, max: 40, temp: 0 },
    abilities: { str: 10, dex: 10, con: 1, int: 10, wis: 10, cha: 10 },
    hitDice: { size: 6, max: 3, used: 0 },
  });
  const r = shortRest(frail, 1, makeFixedRng([1]));
  assert.ok(r.ok);
  assert.equal(r.value.healed, 1, "1 - 5 CON must floor at 1, never negative");
});

test("a short rest cannot spend hit dice that are gone", () => {
  const spent = make("s", { hitDice: { size: 8, max: 2, used: 2 } });
  assert.equal(shortRest(spent, 1, makeFixedRng([4])).ok, false);
  assert.equal(shortRest(make("n"), 1, makeFixedRng([4])).ok, false, "no hit dice recorded");
});

test("a short rest spending more dice than remain uses what is left", () => {
  const some = make("s", {
    hp: { current: 5, max: 40, temp: 0 },
    hitDice: { size: 8, max: 3, used: 2 },
  });
  const r = shortRest(some, 3, makeFixedRng([6]));
  assert.ok(r.ok);
  assert.equal(r.value.combatant.hitDice!.used, 3);
  assert.match(r.value.notes.join(" "), /only 1 hit dice remained/);
});

test("short rest healing stops at the hit point maximum", () => {
  const nearly = make("n", {
    hp: { current: 38, max: 40, temp: 0 },
    hitDice: { size: 10, max: 5, used: 0 },
  });
  const r = shortRest(nearly, 1, makeFixedRng([10]));
  assert.ok(r.ok);
  assert.equal(r.value.combatant.hp.current, 40);
  assert.equal(r.value.healed, 2);
});

test("a long rest refills hit points, slots and half the hit dice", () => {
  const worn = make("w", {
    hp: { current: 3, max: 40, temp: 6 },
    hitDice: { size: 8, max: 6, used: 6 },
    spellSlots: { "1": { max: 4, used: 4 } },
    exhaustion: 2,
  });
  const r = longRest(worn);
  assert.equal(r.combatant.hp.current, 40);
  assert.equal(r.combatant.hp.temp, 0, "temp HP does not survive a long rest");
  assert.equal(r.combatant.spellSlots!["1"]!.used, 0);
  assert.equal(r.combatant.hitDice!.used, 3, "half of 6 hit dice come back");
  assert.equal(r.combatant.exhaustion, 1, "a long rest removes one level");
});

test("a long rest recovers at least one hit die", () => {
  const r = longRest(make("w", { hitDice: { size: 8, max: 1, used: 1 } }));
  assert.equal(r.combatant.hitDice!.used, 0);
});

test("a long rest revives a downed character", () => {
  const downed = make("d", {
    isPlayer: true,
    hp: { current: 0, max: 30, temp: 0 },
    deathSaves: { successes: 1, failures: 2 },
    conditions: [{ condition: "unconscious" }],
  });
  const r = longRest(downed);
  assert.equal(r.combatant.hp.current, 30);
  assert.deepEqual(r.combatant.deathSaves, { successes: 0, failures: 0 });
  assert.equal(r.combatant.conditions.length, 0);
});
