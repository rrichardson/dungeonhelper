/**
 * Homebrew effects end to end through the engine, using fixture notes that
 * mirror the campaign's real items (test/fixtures/homebrew).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyDamage } from "../damage.ts";
import { resolveAttack, type AttackRequest } from "../attack.ts";
import { resolveSpell } from "../spell.ts";
import { savingThrow } from "../checks.ts";
import { makeFixedRng } from "../rng.ts";
import { parseStatBlock } from "../import/statblock.ts";
import { parseCombatant } from "../../adapters/sheets.ts";
import { createEncounter, addCombatant, rollInitiativeFor, startEncounter, nextTurn } from "../encounter.ts";
import type { Combatant } from "../types.ts";
import { parseNoteDefs } from "./note.ts";
import { attach, detach } from "./equip.ts";
import { endTurn, resetResources, startTurn, findResource, spendUse, expiryFor, addTimed } from "./active.ts";
import { parseYaml } from "./yaml.ts";
import { validateDef } from "./schema.ts";

const FIXTURES = join(import.meta.dirname, "../../../test/fixtures/homebrew");

function make(id: string, over: Partial<Combatant> = {}): Combatant {
  return {
    id, name: id, ac: 15,
    hp: { current: 100, max: 100, temp: 0 },
    abilities: { str: 16, dex: 10, con: 16, int: 10, wis: 10, cha: 10 },
    proficiencyBonus: 6, saveProficiencies: [], speed: 30,
    resistances: [], immunities: [], vulnerabilities: [], conditionImmunities: [],
    conditions: [], exhaustion: 0, concentration: null,
    deathSaves: { successes: 0, failures: 0 }, stable: false, isPlayer: true,
    ...over,
  };
}

function note(name: string): string {
  return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

function equip(c: Combatant, item: string, attuned = true, asAttack?: string): Combatant {
  const defs = parseNoteDefs(note(item), item);
  assert.ok(defs.ok, defs.ok ? "" : defs.error);
  const d = defs.value[0]!;
  const r = attach(c, { def: d.def, source: d.source, attuned, origin: "loadout", ...(asAttack ? { asAttack } : {}) });
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

function harmer(): Combatant {
  const parsed = parseStatBlock(note("Continuance Harmer"));
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  const defs = parseNoteDefs(note("Continuance Harmer"), "harmer");
  assert.ok(defs.ok);
  const r = attach(parsed.value.combatant, { def: defs.value[0]!.def, source: defs.value[0]!.source, attuned: true, origin: "trait" });
  assert.ok(r.ok);
  return r.value;
}

function sporeling(): Combatant {
  const parsed = parseStatBlock(note("Sporeling"));
  assert.ok(parsed.ok);
  return parsed.value.combatant;
}

function swing(req: Partial<AttackRequest> & Pick<AttackRequest, "attacker" | "target" | "weapon">, ...dice: number[]) {
  const r = resolveAttack({
    attackBonus: 10, damage: [{ expression: "1d6", type: "slashing" }], within5: true, ...req,
  }, makeFixedRng(dice));
  assert.ok(r.ok, r.ok ? "" : r.error);
  return r.value;
}

// ── Phased: the damage pipeline ───────────────────────────────────────────

test("phased quarters incoming damage, rounding down", () => {
  const r = applyDamage(harmer(), [{ amount: 13, type: "slashing" }]);
  assert.equal(r.adjustedTotal, 3);
  assert.match(r.packets[0]!.homebrew![0]!, /Phased: ×1\/4 \(round down\) 13 → 3/);
});

test("phased does not reduce damage tagged unphased", () => {
  const r = applyDamage(harmer(), [{ amount: 13, type: "slashing" }], { tags: ["unphased"] });
  assert.equal(r.adjustedTotal, 13);
});

test("homebrew scaling applies after resistance", () => {
  const r = applyDamage({ ...harmer(), resistances: ["fire"] }, [{ amount: 13, type: "fire" }]);
  // 13 → 6 (resistance) → 1 (quarter, rounded down)
  assert.equal(r.adjustedTotal, 1);
});

test("homebrew scaling applies after vulnerability", () => {
  const r = applyDamage({ ...harmer(), vulnerabilities: ["cold"] }, [{ amount: 13, type: "cold" }]);
  // 13 → 26 (vulnerable) → 6
  assert.equal(r.adjustedTotal, 6);
});

test("immunity zeroes a packet before any scaling", () => {
  const r = applyDamage({ ...harmer(), immunities: ["poison"] }, [{ amount: 40, type: "poison" }]);
  assert.equal(r.adjustedTotal, 0);
});

test("scaling is applied to each damage packet separately", () => {
  const r = applyDamage(harmer(), [{ amount: 7, type: "slashing" }, { amount: 7, type: "fire" }]);
  // floor(7/4) + floor(7/4) = 2, not floor(14/4) = 3
  assert.equal(r.adjustedTotal, 2);
});

test("temporary hit points absorb damage after scaling", () => {
  const t = { ...harmer(), hp: { current: 120, max: 120, temp: 5 } };
  const r = applyDamage(t, [{ amount: 40, type: "slashing" }]);
  assert.equal(r.adjustedTotal, 10);
  assert.equal(r.tempAbsorbed, 5);
  assert.equal(r.combatant.hp.current, 115);
});

test("a stat block's Tags line becomes creature tags", () => {
  assert.deepEqual(harmer().tags, ["continuance", "construct"]);
  assert.deepEqual(sporeling().tags, ["fungal"]);
});

// ── Voidfang Katars ───────────────────────────────────────────────────────

function djarrak(): Combatant {
  return equip(make("djarrak", {
    attacks: [{ name: "ice katars", bonus: 11, damage: [{ expression: "1d6+5", type: "piercing" }, { expression: "1d6", type: "cold" }] }],
  }), "Voidfang Katars");
}

test("replaces-attack renames the sheet attack to the weapon", () => {
  const d = djarrak();
  assert.deepEqual(d.attacks!.map((a) => a.name), ["Voidfang Katars"]);
});

test("detaching a weapon restores the attack's original name", () => {
  const r = detach(djarrak(), "Voidfang Katars");
  assert.ok(r.ok);
  assert.deepEqual(r.value.attacks!.map((a) => a.name), ["ice katars"]);
  assert.deepEqual(r.value.resources, {});
});

test("cold damage from the katars ignores resistance; other types do not", () => {
  const o = swing({
    attacker: djarrak(), target: sporeling(), weapon: "Voidfang Katars",
    damage: [{ expression: "1d6", type: "cold" }],
  }, 15, 6);
  assert.equal(o.damage!.adjustedTotal, 6);
  assert.match(o.damage!.packets[0]!.homebrew![0]!, /Cold That Does Not Care: ignores resistance to cold/);
});

test("the katars' effects do not fire for a different weapon", () => {
  const o = swing({
    attacker: djarrak(), target: sporeling(), weapon: "dagger",
    damage: [{ expression: "1d6", type: "cold" }],
  }, 15, 6);
  assert.equal(o.damage!.adjustedTotal, 3);
});

test("a critical hit with the katars forces a DC 20 Con save; failure petrifies until the end of the holder's next turn", () => {
  const o = swing({
    attacker: djarrak(), target: make("victim", { isPlayer: false }), weapon: "Voidfang Katars", turnId: "djarrak",
  }, 20, 3, 3, 2);
  // d20 20 (crit), 2d6 damage [3,3], Con save d20 [2] +3 = 5 vs DC 20
  assert.ok(o.critical);
  assert.ok(o.target.conditions.some((c) => c.condition === "petrified"));
  assert.ok(o.effectNotes.some((n) => /Frozen in Stasis: victim CON save .* vs DC 20 → FAILURE/.test(n)));
  // Applied during D'jarrak's own turn: lasts through the end of his next one.
  assert.deepEqual(o.target.timed![0]!.expires, { kind: "end-of-turn", of: "djarrak", skip: 1 });
});

test("a successful save against stasis leaves the target unaffected", () => {
  const o = swing({
    attacker: djarrak(), target: make("victim", { isPlayer: false }), weapon: "Voidfang Katars",
  }, 20, 3, 3, 20);
  assert.ok(!o.target.conditions.some((c) => c.condition === "petrified"));
});

// ── Timers ────────────────────────────────────────────────────────────────

test("'until the end of X's next turn' set during X's turn survives that turn and ends after the next", () => {
  let t = addTimed(make("t"), { label: "Stasis", condition: "petrified", expires: expiryFor({ kind: "end-of-turn", whose: "holder" }, { holder: "x" }, "x") });
  t = endTurn(t, "x").combatant;
  assert.ok(t.conditions.some((c) => c.condition === "petrified"));
  t = endTurn(t, "x").combatant;
  assert.ok(!t.conditions.some((c) => c.condition === "petrified"));
  assert.deepEqual(t.timed, []);
});

test("'until the end of X's next turn' set on someone else's turn ends at the end of X's coming turn", () => {
  let t = addTimed(make("t"), { label: "Stasis", condition: "petrified", expires: expiryFor({ kind: "end-of-turn", whose: "holder" }, { holder: "x" }, "y") });
  t = endTurn(t, "y").combatant;
  assert.ok(t.conditions.some((c) => c.condition === "petrified"));
  t = endTurn(t, "x").combatant;
  assert.ok(!t.conditions.some((c) => c.condition === "petrified"));
});

test("a duration of N rounds ends at the start of the applier's turn N rounds later", () => {
  let t = addTimed(make("t"), { label: "Glow", grant: { ac: 2 }, expires: expiryFor({ kind: "rounds", n: 2 }, { holder: "x" }, "x") });
  t = startTurn(t, "x").combatant;
  assert.equal(t.timed!.length, 1);
  t = startTurn(t, "x").combatant;
  assert.equal(t.timed!.length, 0);
});

test("nextTurn expires timed conditions and logs it", () => {
  let state = createEncounter("t", "seed");
  const a = addTimed(make("a"), { label: "Voidfang Katars: Frozen in Stasis", condition: "petrified", expires: { kind: "end-of-turn", of: "b", skip: 0 } });
  for (const c of [a, make("b")]) {
    const r = addCombatant(state, c);
    assert.ok(r.ok);
    state = r.value;
  }
  const init = rollInitiativeFor(state, ["a", "b"], { a: { fixed: 20 }, b: { fixed: 10 } });
  assert.ok(init.ok);
  const started = startEncounter(init.value.state);
  assert.ok(started.ok);
  let s = started.value;
  let n = nextTurn(s); // a's turn ends, b's begins
  assert.ok(n.ok);
  s = n.value.state;
  assert.ok(s.combatants["a"]!.conditions.some((c) => c.condition === "petrified"));
  n = nextTurn(s); // b's turn ends
  assert.ok(n.ok);
  assert.ok(!n.value.state.combatants["a"]!.conditions.some((c) => c.condition === "petrified"));
  assert.ok(n.value.state.log.some((l) => /petrified \(Voidfang Katars: Frozen in Stasis\) ends/.test(l.text)));
});

test("per-round uses refresh at the start of the holder's turn", () => {
  let d = djarrak();
  const key = findResource(d, "Shadowstep");
  assert.ok(key.ok);
  const spent = spendUse(d, key.value);
  assert.ok(spent.ok);
  d = spent.value;
  assert.ok(!spendUse(d, key.value).ok);
  d = startTurn(d, "someone-else").combatant;
  assert.ok(!spendUse(d, key.value).ok);
  d = startTurn(d, "djarrak").combatant;
  assert.ok(spendUse(d, key.value).ok);
});

// ── Mantle of the Undying Wall ────────────────────────────────────────────

function bokun(): Combatant {
  return equip(make("bokun", { classLevels: { fighter: 20 }, level: 20, hp: { current: 30, max: 184, temp: 0 } }), "Mantle of the Undying Wall");
}

test("would-drop-to-0 leaves the holder at 1 HP and spends its use", () => {
  const r = applyDamage(bokun(), [{ amount: 50, type: "slashing" }], { turnId: "ogre" });
  assert.equal(r.hpAfter, 1);
  assert.ok(!r.droppedToZero);
  assert.ok(!r.combatant.conditions.some((c) => c.condition === "unconscious"));
  const key = findResource(r.combatant, "The Wall Does Not Fall");
  assert.ok(key.ok);
  assert.equal(r.combatant.resources![key.value]!.used, 1);
});

test("would-drop-to-0 grants resistance to all damage until the end of the holder's next turn", () => {
  const first = applyDamage(bokun(), [{ amount: 50, type: "slashing" }], { turnId: "ogre" });
  const again = applyDamage({ ...first.combatant, hp: { ...first.combatant.hp, current: 40 } }, [{ amount: 20, type: "fire" }]);
  assert.equal(again.adjustedTotal, 10);
  const after = endTurn(again.combatant, "bokun").combatant;
  const third = applyDamage(after, [{ amount: 20, type: "fire" }]);
  assert.equal(third.adjustedTotal, 20);
});

test("would-drop-to-0 prevents death from massive damage", () => {
  const r = applyDamage(bokun(), [{ amount: 500, type: "slashing" }]);
  assert.equal(r.hpAfter, 1);
  assert.ok(!r.died);
  assert.ok(!r.instantDeath);
});

test("would-drop-to-0 does nothing once its use is spent", () => {
  const first = applyDamage(bokun(), [{ amount: 50, type: "slashing" }]);
  const second = applyDamage(first.combatant, [{ amount: 200, type: "slashing" }]);
  assert.equal(second.hpAfter, 0);
  assert.ok(second.notes.some((n) => /no uses remain/.test(n)));
});

test("a long rest restores a per-long-rest use", () => {
  const first = applyDamage(bokun(), [{ amount: 50, type: "slashing" }]);
  const rested = resetResources(first.combatant, "long-rest");
  assert.ok(rested.ok);
  const key = findResource(rested.value.combatant, "The Wall Does Not Fall");
  assert.ok(key.ok);
  assert.equal(rested.value.combatant.resources![key.value]!.used, 0);
});

test("reducing a creature to 0 grants temp HP equal to fighter level + Con modifier", () => {
  const o = swing({
    attacker: bokun(), target: make("minion", { isPlayer: false, hp: { current: 2, max: 10, temp: 0 } }), weapon: "spear",
  }, 15, 6);
  assert.equal(o.damage!.hpAfter, 0);
  // fighter 20 + CON 16 (+3) = 23
  assert.equal(o.attacker.hp.temp, 23);
  assert.ok(o.effectNotes.some((n) => /Blood of the Wall: level\(fighter\) \+ mod\(con\) = 23/.test(n)));
});

// ── Crown of Cataclysm ────────────────────────────────────────────────────

function dagant(): Combatant {
  return equip(make("dagant", { spellcastingAbility: "cha" }), "Crown of Cataclysm");
}

test("an optional effect is reported, not applied, without an opt-in", () => {
  const r = resolveSpell({
    name: "Cone of Cold", dc: 20, ability: "con", onSuccess: "half",
    damage: [{ expression: "8d8", type: "cold" }], targets: [make("a", { isPlayer: false })], caster: dagant(),
  }, makeFixedRng([4, 4, 4, 4, 4, 4, 4, 4, 1]));
  assert.ok(r.ok, r.ok ? "" : r.error);
  assert.equal(r.value.riderRolls.length, 0);
  assert.ok(r.value.available.some((a) => /Force of the Fall/.test(a) && /--effect/.test(a)));
});

test("opting in adds 2d10 force to one target only, and the save halves it with the rest", () => {
  const r = resolveSpell({
    name: "Cone of Cold", dc: 20, ability: "con", onSuccess: "half",
    damage: [{ expression: "8d8", type: "cold" }],
    targets: [make("a", { isPlayer: false, hp: { current: 200, max: 200, temp: 0 } }), make("b", { isPlayer: false, hp: { current: 200, max: 200, temp: 0 } })],
    caster: dagant(), optIn: ["Force of the Fall"], effectTarget: "b",
  }, makeFixedRng([4, 4, 4, 4, 4, 4, 4, 4, /* rider */ 10, 10, /* saves */ 1, 1]));
  assert.ok(r.ok, r.ok ? "" : r.error);
  const [a, b] = r.value.targets;
  assert.equal(a!.damage!.adjustedTotal, 32);
  assert.equal(b!.damage!.adjustedTotal, 52);
  const saved = resolveSpell({
    name: "Cone of Cold", dc: 20, ability: "con", onSuccess: "half",
    damage: [{ expression: "8d8", type: "cold" }],
    targets: [make("b", { isPlayer: false, hp: { current: 200, max: 200, temp: 0 } })],
    caster: dagant(), optIn: ["Force of the Fall"],
  }, makeFixedRng([4, 4, 4, 4, 4, 4, 4, 4, 10, 10, 20]));
  assert.ok(saved.ok);
  // (32 + 20) halved per packet: 16 + 10
  assert.equal(saved.value.targets[0]!.damage!.adjustedTotal, 26);
});

test("a casts-spell effect does not fire for spells of other damage types", () => {
  const r = resolveSpell({
    name: "Fireball", dc: 20, ability: "dex", onSuccess: "half",
    damage: [{ expression: "8d6", type: "fire" }], targets: [make("a", { isPlayer: false })],
    caster: dagant(), optIn: ["Force of the Fall"],
  }, makeFixedRng([3, 3, 3, 3, 3, 3, 3, 3, 1]));
  assert.ok(r.ok);
  assert.equal(r.value.riderRolls.length, 0);
  assert.equal(r.value.available.length, 0);
});

test("charges regain by the stated amount at dawn, never above the maximum", () => {
  let d = dagant();
  const key = findResource(d, "Crown Eternal");
  assert.ok(key.ok);
  const spent = spendUse(d, key.value, 3);
  assert.ok(spent.ok);
  d = spent.value;
  const dawn = resetResources(d, "dawn");
  assert.ok(dawn.ok);
  assert.equal(dawn.value.combatant.resources![key.value]!.used, 2);
  const rest = resetResources(dawn.value.combatant, "long-rest");
  assert.ok(rest.ok);
  assert.equal(rest.value.combatant.resources![key.value]!.used, 2, "dawn charges do not come back on a long rest");
});

// ── Fungicide Blade ───────────────────────────────────────────────────────

function wielder(): Combatant {
  return equip(make("bokun", { attacks: [{ name: "spear", bonus: 9, damage: [{ expression: "1d6+3", type: "piercing" }] }] }), "Fungicide Blade");
}

test("grants-attack adds an attack computed from the wielder's numbers", () => {
  const blade = wielder().attacks!.find((a) => a.name === "Fungicide Blade")!;
  // prof 6 + STR 16 (+3) = 9; damage 2d6 + 3
  assert.equal(blade.bonus, 9);
  assert.deepEqual(blade.damage, [{ expression: "2d6+3", type: "slashing" }]);
});

test("the blade's +3 applies to attack and damage with the blade, and not with other weapons", () => {
  const withBlade = swing({ attacker: wielder(), target: make("t"), weapon: "Fungicide Blade", attackBonus: 9, damage: [{ expression: "2d6+3", type: "slashing" }] }, 3, 1, 1);
  // d20 3 + 9 + 3 = 15 vs AC 15: hit; 1 + 1 + 3 + 3 = 8
  assert.equal(withBlade.roll.total, 15);
  assert.equal(withBlade.damage!.adjustedTotal, 8);
  const withSpear = swing({ attacker: wielder(), target: make("t"), weapon: "spear", attackBonus: 9, damage: [{ expression: "1d6+3", type: "piercing" }] }, 3);
  assert.equal(withSpear.roll.total, 12);
  assert.ok(!withSpear.hit);
});

test("the blade adds 3d8 radiant only against creatures tagged fungal", () => {
  const fungal = swing({ attacker: wielder(), target: sporeling(), weapon: "Fungicide Blade", damage: [{ expression: "2d6+3", type: "slashing" }] }, 15, 1, 1, 2, 2, 2);
  assert.equal(fungal.damage!.adjustedTotal, 8 + 6);
  const plain = swing({ attacker: wielder(), target: make("t"), weapon: "Fungicide Blade", damage: [{ expression: "2d6+3", type: "slashing" }] }, 15, 1, 1);
  assert.equal(plain.damage!.adjustedTotal, 8);
});

test("a feature's uses are tracked and refused once spent", () => {
  const w = wielder();
  const key = findResource(w, "Sunbeam");
  assert.ok(key.ok);
  const once = spendUse(w, key.value);
  assert.ok(once.ok);
  const twice = spendUse(once.value, key.value);
  assert.ok(!twice.ok);
  assert.match(twice.error, /no uses left/);
});

// ── Attunement, statics, persistence ──────────────────────────────────────

test("a creature can be attuned to at most three items", () => {
  let c = make("c", { classLevels: { fighter: 1 }, attacks: [{ name: "ice katars", bonus: 5, damage: [{ expression: "1d6", type: "piercing" }] }] });
  c = equip(c, "Mantle of the Undying Wall");
  c = equip(c, "Crown of Cataclysm");
  c = equip(c, "Voidfang Katars");
  const defs = parseNoteDefs(note("Fungicide Blade"), "blade");
  assert.ok(defs.ok);
  const fourth = attach(c, { def: defs.value[0]!.def, source: defs.value[0]!.source, attuned: true, origin: "loadout" });
  assert.ok(!fourth.ok);
  assert.match(fourth.error, /already attuned to 3 items/);
  const carried = attach(c, { def: defs.value[0]!.def, source: defs.value[0]!.source, attuned: false, origin: "loadout" });
  assert.ok(carried.ok, "carrying a fourth item unattuned is allowed");
});

test("an item that requires attunement does nothing until attuned", () => {
  const unattuned = equip(make("bokun", { classLevels: { fighter: 20 }, hp: { current: 30, max: 184, temp: 0 } }), "Mantle of the Undying Wall", false);
  const r = applyDamage(unattuned, [{ amount: 50, type: "slashing" }]);
  assert.equal(r.hpAfter, 0);
});

function grantItem(yaml: string): Combatant {
  const y = parseYaml(yaml);
  assert.ok(y.ok);
  const def = validateDef(y.value);
  assert.ok(def.ok, def.ok ? "" : def.error);
  const r = attach(make("w", { isPlayer: false }), { def: def.value, source: y.value, attuned: true, origin: "attached" });
  assert.ok(r.ok);
  return r.value;
}

test("an AC grant raises the AC that attacks are rolled against, and names its source", () => {
  const target = grantItem("name: Ring of Protection\nkind: item\neffects:\n  - do: {ac: 1}");
  const o = swing({ attacker: make("a"), target, weapon: "club" }, 5);
  assert.equal(o.effectiveAc, 16);
  assert.ok(o.effectNotes.some((n) => /Ring of Protection: target AC \+1/.test(n)));
});

test("a save bonus grant appears as a named modifier on the save", () => {
  const c = grantItem("name: Cloak of Protection\nkind: item\neffects:\n  - do: {save-bonus: 1}");
  const save = savingThrow({ creature: c, ability: "dex", dc: 10 }, makeFixedRng([9]));
  assert.equal(save.roll!.total, 10);
  assert.ok(save.roll!.modifiers.some((m) => m.source === "Cloak of Protection" && m.value === 1));
});

test("a homebrew resistance halves damage and says where it came from", () => {
  const c = grantItem("name: Ember Ward\nkind: item\neffects:\n  - do: {resist: [fire]}");
  const r = applyDamage(c, [{ amount: 9, type: "fire" }]);
  assert.equal(r.adjustedTotal, 4);
  assert.match(r.packets[0]!.homebrew![0]!, /Ember Ward: resistant to fire/);
});

test("attached homebrew, uses and timers survive a round trip through the stored sheet", () => {
  let c = bokun();
  c = applyDamage(c, [{ amount: 50, type: "slashing" }], { turnId: "x" }).combatant;
  const back = parseCombatant(JSON.parse(JSON.stringify(c)), "roundtrip");
  assert.ok(back.ok, back.ok ? "" : back.error);
  assert.equal(back.value.homebrew!.length, 1);
  assert.deepEqual(back.value.resources, c.resources);
  assert.deepEqual(back.value.timed, c.timed);
  assert.deepEqual(back.value.classLevels, { fighter: 20 });
});

test("class levels are read from a D&D Beyond import's meta block", () => {
  const raw = { ...make("x"), meta: { classes: [{ name: "Sorcerer", level: 15 }, { name: "Warlock", level: 5 }], totalLevel: 20 } };
  const c = parseCombatant(JSON.parse(JSON.stringify(raw)), "meta");
  assert.ok(c.ok);
  assert.deepEqual(c.value.classLevels, { sorcerer: 15, warlock: 5 });
  assert.equal(c.value.level, 20);
});
