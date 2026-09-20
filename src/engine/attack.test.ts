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

// ── Distance-driven rules ─────────────────────────────────────────────────

const bow = {
  weapon: "shortbow", attackBonus: 4, within5: false,
  damage: [{ expression: "1d6+2", type: "piercing" as const }],
  range: 80, longRange: 320,
};

test("a bow fired from within 5 feet at a prone target gains advantage", () => {
  // Prone turns on the attacker's distance, not on what they are holding.
  const prone = make("fighter", { conditions: [{ condition: "prone" }] });
  const o = run({ ...bow, target: prone, distance: 3 }, 8, 17, 3);
  assert.equal(o.roll.resolution.state, "advantage");
  assert.ok(o.roll.resolution.advantage.includes("target prone"));
});

test("the same bow at 60 feet takes disadvantage against a prone target", () => {
  const prone = make("fighter", { conditions: [{ condition: "prone" }] });
  const o = run({ ...bow, target: prone, distance: 60 }, 17, 8, 3);
  assert.equal(o.roll.resolution.state, "disadvantage");
});

test("a ranged hit from within 5 feet on an unconscious target still auto-crits", () => {
  const out = make("fighter", { conditions: [{ condition: "unconscious" }] });
  const o = run({ ...bow, target: out, distance: 5 }, 12, 12, 4, 5);
  assert.equal(o.critical, true);
  assert.equal(o.criticalReason, "target unconscious within 5 ft");
});

test("beyond normal range gives disadvantage, and says why", () => {
  const o = run({ ...bow, distance: 150 }, 17, 8, 3);
  assert.equal(o.roll.resolution.state, "disadvantage");
  assert.match(o.roll.resolution.disadvantage.join(" "), /long range \(150 ft, normal 80 ft\)/);
});

test("within normal range there is no range penalty", () => {
  const o = run({ ...bow, distance: 80 }, 14, 3);
  assert.equal(o.roll.resolution.state, "normal");
});

test("beyond long range the shot is refused", () => {
  const r = resolveAttack(attack({ ...bow, distance: 400 }), makeFixedRng([17, 3]));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /beyond shortbow's long range of 320 ft/);
});

test("a melee attack beyond reach is refused", () => {
  const r = resolveAttack(
    attack({ weapon: "longsword", within5: true, range: 5, distance: 15 }),
    makeFixedRng([17, 3]),
  );
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /beyond longsword's 5 ft reach/);
});

test("a reach weapon may strike at 10 feet", () => {
  const o = run({ weapon: "glaive", within5: true, range: 10, distance: 10, attackBonus: 5 }, 14, 3);
  assert.equal(o.hit, true);
});

test("force overrides a range refusal", () => {
  const r = resolveAttack(attack({ ...bow, distance: 400, force: true }), makeFixedRng([17, 3]));
  assert.equal(r.ok, true);
});

test("a ranged attack with a hostile adjacent takes disadvantage", () => {
  const o = run({ ...bow, distance: 60, threatened: true }, 17, 8, 3);
  assert.equal(o.roll.resolution.state, "disadvantage");
  assert.match(o.roll.resolution.disadvantage.join(" "), /hostile within 5 ft/);
});

test("being threatened does not penalise a melee attack", () => {
  const o = run({ weapon: "longsword", within5: true, distance: 5, range: 5, threatened: true }, 14, 3);
  assert.equal(o.roll.resolution.state, "normal");
});

test("adjacency advantage and a threatened shot cancel to a flat roll", () => {
  // Point blank at a prone target while an enemy is adjacent: advantage from
  // prone, disadvantage for shooting while threatened.
  const prone = make("fighter", { conditions: [{ condition: "prone" }] });
  const o = run({ ...bow, target: prone, distance: 5, threatened: true }, 11, 3);
  assert.equal(o.roll.dice.length, 1);
  assert.equal(o.roll.resolution.cancelled, true);
});

test("distance is recorded on the outcome for the log", () => {
  const o = run({ ...bow, distance: 45 }, 14, 3);
  assert.ok(o.notes.some((n) => n.includes("distance 45 ft")));
});

test("without a distance the weapon's own kind decides adjacency, as before", () => {
  const prone = make("fighter", { conditions: [{ condition: "prone" }] });
  const melee = run({ weapon: "longsword", within5: true, target: prone }, 8, 17, 3);
  assert.equal(melee.roll.resolution.state, "advantage");
  const ranged = run({ ...bow, target: prone }, 17, 8, 3);
  assert.equal(ranged.roll.resolution.state, "disadvantage");
});
