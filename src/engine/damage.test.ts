import { test } from "node:test";
import assert from "node:assert/strict";
import { applyDamage, applyHealing, applyTempHp } from "./damage.ts";
import type { Combatant } from "./types.ts";

function make(over: Partial<Combatant> = {}): Combatant {
  return {
    id: "t", name: "Target", ac: 15,
    hp: { current: 30, max: 30, temp: 0 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 2, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: false,
    ...over,
  };
}

test("plain damage reduces hit points", () => {
  const r = applyDamage(make(), [{ amount: 7, type: "slashing" }]);
  assert.equal(r.adjustedTotal, 7);
  assert.equal(r.combatant.hp.current, 23);
});

test("resistance halves and rounds down", () => {
  const r = applyDamage(make({ resistances: ["fire"] }), [{ amount: 7, type: "fire" }]);
  assert.equal(r.adjustedTotal, 3);
  assert.equal(r.packets[0]!.adjustment, "resistant");
});

test("immunity zeroes the packet", () => {
  const r = applyDamage(make({ immunities: ["poison"] }), [{ amount: 12, type: "poison" }]);
  assert.equal(r.adjustedTotal, 0);
  assert.equal(r.combatant.hp.current, 30);
});

test("vulnerability doubles", () => {
  const r = applyDamage(make({ vulnerabilities: ["cold"] }), [{ amount: 6, type: "cold" }]);
  assert.equal(r.adjustedTotal, 12);
});

test("resistance and vulnerability to the same type cancel", () => {
  const r = applyDamage(
    make({ resistances: ["fire"], vulnerabilities: ["fire"] }),
    [{ amount: 9, type: "fire" }],
  );
  assert.equal(r.adjustedTotal, 9);
  assert.equal(r.packets[0]!.adjustment, "resist+vulnerable cancel");
});

test("mixed packets are adjusted independently", () => {
  const r = applyDamage(
    make({ resistances: ["fire"], immunities: ["poison"] }),
    [{ amount: 8, type: "fire" }, { amount: 5, type: "poison" }, { amount: 3, type: "piercing" }],
  );
  assert.equal(r.adjustedTotal, 4 + 0 + 3);
});

test("petrified grants resistance to everything", () => {
  const r = applyDamage(
    make({ conditions: [{ condition: "petrified" }] }),
    [{ amount: 11, type: "force" }],
  );
  assert.equal(r.adjustedTotal, 5);
});

test("temp HP absorbs first and is spent before hit points", () => {
  const r = applyDamage(make({ hp: { current: 30, max: 30, temp: 5 } }), [{ amount: 8, type: "force" }]);
  assert.equal(r.tempAbsorbed, 5);
  assert.equal(r.combatant.hp.temp, 0);
  assert.equal(r.combatant.hp.current, 27);
});

test("temp HP can absorb a hit entirely", () => {
  const r = applyDamage(make({ hp: { current: 30, max: 30, temp: 10 } }), [{ amount: 4, type: "force" }]);
  assert.equal(r.combatant.hp.current, 30);
  assert.equal(r.combatant.hp.temp, 6);
});

test("a player dropped to 0 falls unconscious rather than dying", () => {
  const r = applyDamage(make({ isPlayer: true, hp: { current: 5, max: 30, temp: 0 } }), [
    { amount: 9, type: "slashing" },
  ]);
  assert.equal(r.combatant.hp.current, 0);
  assert.equal(r.droppedToZero, true);
  assert.equal(r.died, false);
  assert.ok(r.combatant.conditions.some((c) => c.condition === "unconscious"));
});

test("massive damage kills a player outright", () => {
  const r = applyDamage(make({ isPlayer: true, hp: { current: 5, max: 30, temp: 0 } }), [
    { amount: 40, type: "slashing" },
  ]);
  assert.equal(r.instantDeath, true);
  assert.equal(r.died, true);
});

test("overflow exactly equal to HP max is instant death", () => {
  const r = applyDamage(make({ isPlayer: true, hp: { current: 5, max: 30, temp: 0 } }), [
    { amount: 35, type: "slashing" },
  ]);
  assert.equal(r.instantDeath, true);
});

test("overflow one short of HP max is not instant death", () => {
  const r = applyDamage(make({ isPlayer: true, hp: { current: 5, max: 30, temp: 0 } }), [
    { amount: 34, type: "slashing" },
  ]);
  assert.equal(r.instantDeath, false);
  assert.equal(r.droppedToZero, true);
});

test("damage at 0 HP adds one death save failure, two on a crit", () => {
  const downed = make({ isPlayer: true, hp: { current: 0, max: 30, temp: 0 } });
  assert.equal(applyDamage(downed, [{ amount: 3, type: "slashing" }]).deathSaveFailuresAdded, 1);
  assert.equal(
    applyDamage(downed, [{ amount: 3, type: "slashing" }], { critical: true }).deathSaveFailuresAdded,
    2,
  );
});

test("a third death save failure is death", () => {
  const downed = make({
    isPlayer: true,
    hp: { current: 0, max: 30, temp: 0 },
    deathSaves: { successes: 1, failures: 2 },
  });
  const r = applyDamage(downed, [{ amount: 2, type: "slashing" }]);
  assert.equal(r.died, true);
  assert.equal(r.combatant.deathSaves.failures, 3);
});

test("a monster reduced to 0 dies", () => {
  const r = applyDamage(make({ hp: { current: 4, max: 20, temp: 0 } }), [{ amount: 6, type: "fire" }]);
  assert.equal(r.died, true);
});

test("concentration check DC is half damage, minimum 10", () => {
  const caster = make({ hp: { current: 100, max: 100, temp: 0 }, concentration: { spell: "Bless" } });
  assert.equal(applyDamage(caster, [{ amount: 9, type: "force" }]).concentrationCheck?.dc, 10);
  assert.equal(applyDamage(caster, [{ amount: 19, type: "force" }]).concentrationCheck?.dc, 10);
  assert.equal(applyDamage(caster, [{ amount: 30, type: "force" }]).concentrationCheck?.dc, 15);
  assert.equal(applyDamage(caster, [{ amount: 31, type: "force" }]).concentrationCheck?.dc, 15);
});

test("damage fully absorbed by immunity requires no concentration check", () => {
  const caster = make({ hp: { current: 100, max: 100, temp: 0 }, concentration: { spell: "Bless" }, immunities: ["poison"] });
  assert.equal(applyDamage(caster, [{ amount: 20, type: "poison" }]).concentrationCheck, null);
});

test("death ends concentration outright", () => {
  const caster = make({ hp: { current: 2, max: 20, temp: 0 }, concentration: { spell: "Bless" } });
  const r = applyDamage(caster, [{ amount: 10, type: "force" }]);
  assert.equal(r.died, true);
  assert.equal(r.combatant.concentration, null);
  assert.equal(r.concentrationCheck, null);
});

test("healing revives and resets death saves", () => {
  const downed = make({
    isPlayer: true,
    hp: { current: 0, max: 30, temp: 0 },
    deathSaves: { successes: 1, failures: 2 },
    conditions: [{ condition: "unconscious" }],
  });
  const r = applyHealing(downed, 5);
  assert.equal(r.revived, true);
  assert.equal(r.combatant.hp.current, 5);
  assert.deepEqual(r.combatant.deathSaves, { successes: 0, failures: 0 });
  assert.equal(r.combatant.conditions.length, 0);
});

test("healing cannot exceed HP max", () => {
  const r = applyHealing(make({ hp: { current: 28, max: 30, temp: 0 } }), 10);
  assert.equal(r.combatant.hp.current, 30);
  assert.equal(r.healed, 2);
});

test("temp HP does not stack — the larger pool wins", () => {
  const withTemp = make({ hp: { current: 30, max: 30, temp: 8 } });
  assert.equal(applyTempHp(withTemp, 5).combatant.hp.temp, 8);
  assert.equal(applyTempHp(withTemp, 12).combatant.hp.temp, 12);
});

test("damage application never mutates the input combatant", () => {
  const c = make({ hp: { current: 30, max: 30, temp: 4 } });
  applyDamage(c, [{ amount: 10, type: "fire" }]);
  assert.equal(c.hp.current, 30);
  assert.equal(c.hp.temp, 4);
});
