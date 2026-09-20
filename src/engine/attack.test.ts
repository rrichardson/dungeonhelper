import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveAttack, attackAdvantage, autoCritApplies, type AttackRequest } from "./attack.ts";
import { makeFixedRng } from "./rng.ts";
import type { Combatant } from "./types.ts";

function make(id: string, over: Partial<Combatant> = {}): Combatant {
  return {
    id, name: id, ac: 15,
    hp: { current: 40, max: 40, temp: 0 },
    abilities: { str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 2, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: false,
    ...over,
  };
}

function attack(over: Partial<AttackRequest> = {}): AttackRequest {
  return {
    attacker: make("goblin"),
    target: make("fighter"),
    weapon: "scimitar",
    attackBonus: 4,
    damage: [{ expression: "1d6+2", type: "slashing" }],
    within5: true,
    ...over,
  };
}

const run = (req: Partial<AttackRequest>, ...dice: number[]) => {
  const r = resolveAttack(attack(req), makeFixedRng(dice));
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
};

test("a beaten AC is a hit and applies damage", () => {
  const o = run({}, 14, 3);
  assert.equal(o.roll.total, 18);
  assert.equal(o.hit, true);
  assert.equal(o.damage?.adjustedTotal, 5);
  assert.equal(o.damage?.combatant.hp.current, 35);
});

test("exactly meeting AC hits", () => {
  const o = run({ attackBonus: 4, target: make("fighter", { ac: 18 }) }, 14, 1);
  assert.equal(o.roll.total, 18);
  assert.equal(o.hit, true);
});

test("one short of AC misses and rolls no damage", () => {
  const o = run({ attackBonus: 4, target: make("fighter", { ac: 19 }) }, 14);
  assert.equal(o.hit, false);
  assert.equal(o.damageRolls.length, 0);
  assert.equal(o.damage, null);
});

test("a natural 20 hits regardless of AC and crits", () => {
  const o = run({ attackBonus: 0, target: make("fighter", { ac: 30 }) }, 20, 4, 5);
  assert.equal(o.hit, true);
  assert.equal(o.automatic, "hit");
  assert.equal(o.critical, true);
  assert.equal(o.criticalReason, "natural 20");
});

test("a natural 1 misses regardless of bonus", () => {
  const o = run({ attackBonus: 50, target: make("fighter", { ac: 5 }) }, 1);
  assert.equal(o.hit, false);
  assert.equal(o.automatic, "miss");
});

test("a critical doubles the damage dice but not the modifier", () => {
  const o = run({ damage: [{ expression: "1d8+3", type: "slashing" }] }, 20, 5, 6);
  assert.equal(o.critical, true);
  assert.equal(o.damageRolls[0]!.result.expression, "2d8+3");
  assert.equal(o.damage?.adjustedTotal, 14);
});

test("an extended crit range crits without a natural 20", () => {
  const o = run({ critRange: 19 }, 19, 3, 4);
  assert.equal(o.critical, true);
  assert.equal(o.criticalReason, "natural 19 within crit range 19+");
});

test("a hit on an unconscious target within 5 feet is an automatic crit", () => {
  const target = make("fighter", { conditions: [{ condition: "unconscious" }], isPlayer: true, hp: { current: 0, max: 40, temp: 0 } });
  const o = run({ target, within5: true }, 12, 12, 4, 5);
  assert.equal(o.hit, true);
  assert.equal(o.critical, true);
  assert.equal(o.criticalReason, "target unconscious within 5 ft");
  assert.equal(o.damage?.deathSaveFailuresAdded, 2, "a crit at 0 HP costs two death saves");
});

test("the same target beyond 5 feet gets no auto-crit", () => {
  const target = make("fighter", { conditions: [{ condition: "unconscious" }] });
  assert.equal(autoCritApplies(target, false), null);
});

test("a prone target is easier to hit in melee and harder at range", () => {
  const prone = make("fighter", { conditions: [{ condition: "prone" }] });
  const melee = attackAdvantage(make("goblin"), prone, true);
  assert.ok(melee.advantage.includes("target prone"));
  assert.equal(melee.disadvantage.length, 0);

  const ranged = attackAdvantage(make("goblin"), prone, false);
  assert.ok(ranged.disadvantage.includes("target prone"));
  assert.equal(ranged.advantage.length, 0);
});

test("advantage rolls two dice and keeps the higher", () => {
  const target = make("fighter", { conditions: [{ condition: "restrained" }] });
  const o = run({ target }, 7, 16, 3);
  assert.deepEqual(o.roll.dice, [7, 16]);
  assert.equal(o.roll.used, 16);
  assert.equal(o.roll.resolution.state, "advantage");
});

test("disadvantage rolls two dice and keeps the lower", () => {
  const attacker = make("goblin", { conditions: [{ condition: "poisoned" }] });
  const o = run({ attacker }, 17, 5);
  assert.deepEqual(o.roll.dice, [17, 5]);
  assert.equal(o.roll.used, 5);
  assert.equal(o.roll.resolution.state, "disadvantage");
});

test("advantage and disadvantage cancel to a single normal roll", () => {
  const attacker = make("goblin", { conditions: [{ condition: "poisoned" }] });
  const target = make("fighter", { conditions: [{ condition: "restrained" }] });
  const o = run({ attacker, target }, 11, 3);
  assert.equal(o.roll.dice.length, 1, "cancellation must consume only one die");
  assert.equal(o.roll.resolution.state, "normal");
  assert.equal(o.roll.resolution.cancelled, true);
});

test("many sources on both sides still cancel to normal", () => {
  const attacker = make("goblin", { conditions: [{ condition: "poisoned" }, { condition: "prone" }] });
  const target = make("fighter", { conditions: [{ condition: "restrained" }, { condition: "stunned" }] });
  const { advantage, disadvantage } = attackAdvantage(attacker, target, true);
  assert.ok(advantage.length >= 2 && disadvantage.length >= 2);
  const o = run({ attacker, target }, 11, 3);
  assert.equal(o.roll.resolution.state, "normal");
});

test("a grappled attacker has disadvantage against anyone but the grappler", () => {
  const attacker = make("goblin", { conditions: [{ condition: "grappled", source: "fighter" }] });
  const vsGrappler = attackAdvantage(attacker, make("fighter"), true);
  assert.equal(vsGrappler.disadvantage.length, 0);

  const vsOther = attackAdvantage(attacker, make("wizard"), true);
  assert.equal(vsOther.disadvantage.length, 1);
});

test("a frightened attacker who cannot see the source is unaffected", () => {
  const attacker = make("goblin", { conditions: [{ condition: "frightened", source: "paladin" }] });
  assert.equal(attackAdvantage(attacker, make("fighter"), true, true).disadvantage.length, 1);
  assert.equal(attackAdvantage(attacker, make("fighter"), true, false).disadvantage.length, 0);
});

test("unconscious implies incapacitated and prone", () => {
  const target = make("fighter", { conditions: [{ condition: "unconscious" }] });
  const { advantage } = attackAdvantage(make("goblin"), target, true);
  assert.ok(advantage.includes("target unconscious"));
  assert.ok(advantage.includes("target prone"), "unconscious must carry prone");
});

test("cover raises effective AC", () => {
  const o = run({ target: make("fighter", { ac: 15 }), cover: "half", attackBonus: 0 }, 16);
  assert.equal(o.effectiveAc, 17);
  assert.equal(o.hit, false);

  const o2 = run({ target: make("fighter", { ac: 15 }), cover: "three-quarters", attackBonus: 0 }, 19, 2);
  assert.equal(o2.effectiveAc, 20);
  assert.equal(o2.hit, false);
});

test("total cover refuses the attack", () => {
  const r = resolveAttack(attack({ cover: "total" }), makeFixedRng([20, 5]));
  assert.equal(r.ok, false);
});

test("an incapacitated attacker is refused unless forced", () => {
  const attacker = make("goblin", { conditions: [{ condition: "stunned" }] });
  assert.equal(resolveAttack(attack({ attacker }), makeFixedRng([15, 3])).ok, false);
  assert.equal(resolveAttack(attack({ attacker, force: true }), makeFixedRng([15, 15, 3])).ok, true);
});

test("exhaustion subtracts 2 per level from the attack roll", () => {
  const attacker = make("goblin", { exhaustion: 3 });
  const o = run({ attacker, attackBonus: 4 }, 15, 2);
  assert.equal(o.roll.total, 15 + 4 - 6);
  assert.ok(o.roll.modifiers.some((m) => m.source === "exhaustion 3" && m.value === -6));
});

test("a bad damage expression fails before any dice are rolled", () => {
  const r = resolveAttack(attack({ damage: [{ expression: "1d", type: "fire" }] }), makeFixedRng([20]));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /damage "1d"/);
});

test("multiple damage types are rolled and adjusted separately", () => {
  const target = make("fighter", { resistances: ["fire"] });
  const o = run({
    target,
    damage: [
      { expression: "1d6+2", type: "slashing" },
      { expression: "1d6", type: "fire" },
    ],
  }, 18, 4, 5);
  assert.equal(o.damageRolls.length, 2);
  assert.equal(o.damage?.adjustedTotal, 6 + 2);
});

test("resolution never mutates the input combatants", () => {
  const target = make("fighter");
  run({ target }, 18, 5);
  assert.equal(target.hp.current, 40);
});
