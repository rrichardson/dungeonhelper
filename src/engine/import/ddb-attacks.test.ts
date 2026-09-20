import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  cantripTier, weaponAttacks, spellAttacks, deriveAttacks,
  proficiencySubtypes, spellcastingAbility, damageRiders,
} from "./ddb-attacks.ts";
import { normalizeDdb } from "./ddb.ts";
import type { Ability } from "../types.ts";

const scores = (over: Partial<Record<Ability, number>> = {}) => ({
  str: 10, dex: 10, con: 10, int: 10, wis: 10, cha: 10, ...over,
});

const weapon = (over: Record<string, unknown> = {}) => ({
  equipped: true,
  definition: {
    name: "Shortsword", filterType: "Weapon", attackType: 1, categoryId: 1,
    damageType: "Piercing", damage: { diceString: "1d6" }, properties: [],
    ...over,
  },
});

const payload = (inventory: unknown[], modifiers: unknown = {}) => ({ inventory, modifiers });

const simpleProf = { class: [{ type: "proficiency", subType: "simple-weapons" }] };

test("cantrip tiers step at 5, 11 and 17", () => {
  assert.equal(cantripTier(1), 1);
  assert.equal(cantripTier(4), 1);
  assert.equal(cantripTier(5), 2);
  assert.equal(cantripTier(10), 2);
  assert.equal(cantripTier(11), 3);
  assert.equal(cantripTier(16), 3);
  assert.equal(cantripTier(17), 4);
  assert.equal(cantripTier(20), 4);
});

test("a melee weapon uses Strength", () => {
  const w: string[] = [];
  const out = weaponAttacks(
    payload([weapon()], simpleProf),
    { scores: scores({ str: 18, dex: 12 }), proficiencyBonus: 3, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out[0]!.bonus, 4 + 3);
  assert.equal(out[0]!.damage[0]!.expression, "1d6+4");
});

test("finesse takes whichever ability is better", () => {
  const w: string[] = [];
  const finesse = weapon({ name: "Dagger", properties: [{ name: "Finesse" }] });
  const out = weaponAttacks(
    payload([finesse], simpleProf),
    { scores: scores({ str: 8, dex: 18 }), proficiencyBonus: 3, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out[0]!.bonus, 4 + 3, "should use DEX +4, not STR -1");
});

test("a ranged weapon uses Dexterity", () => {
  const w: string[] = [];
  const bow = weapon({ name: "Shortbow", attackType: 2 });
  const out = weaponAttacks(
    payload([bow], simpleProf),
    { scores: scores({ str: 18, dex: 14 }), proficiencyBonus: 2, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out[0]!.bonus, 2 + 2);
  assert.equal(out[0]!.melee, false);
});

test("lacking proficiency drops the bonus and says so", () => {
  const w: string[] = [];
  const martial = weapon({ name: "Greatsword", categoryId: 2 });
  const out = weaponAttacks(
    payload([martial], simpleProf),
    { scores: scores({ str: 16 }), proficiencyBonus: 3, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out[0]!.bonus, 3, "STR +3 only, no proficiency");
  assert.match(w.join(" "), /not proficient with "Greatsword"/);
});

test("a versatile weapon gains a two-handed entry", () => {
  const w: string[] = [];
  const spear = weapon({
    name: "Spear",
    properties: [{ name: "Versatile", notes: "1d8" }],
  });
  const out = weaponAttacks(
    payload([spear], simpleProf),
    { scores: scores({ str: 14 }), proficiencyBonus: 2, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out.length, 2);
  assert.equal(out[0]!.damage[0]!.expression, "1d6+2");
  assert.equal(out[1]!.damage[0]!.expression, "1d8+2");
  assert.match(out[1]!.name, /two-handed/);
});

test("identical duplicate weapons collapse to one named attack", () => {
  const w: string[] = [];
  const out = weaponAttacks(
    payload([weapon({ name: "Dagger" }), weapon({ name: "Dagger" })], simpleProf),
    { scores: scores(), proficiencyBonus: 2, proficiencies: new Set(["simple-weapons"]) },
    w,
  );
  assert.equal(out.length, 1, "two identical daggers must not produce two attacks");
  assert.match(out[0]!.note ?? "", /x2/);
});

// ── Spell availability ────────────────────────────────────────────────────

const spell = (definition: Record<string, unknown>, entry: Record<string, unknown> = {}) => ({
  countsAsKnownSpell: false, prepared: false, alwaysPrepared: false,
  ...entry,
  definition: { level: 0, requiresAttackRoll: true, attackType: 2, modifiers: [], ...definition },
});

const spellPayload = (spells: unknown[]) => ({
  classes: [{ definition: { name: "Warlock", spellCastingAbilityId: 6 } }],
  classSpells: [{ spells }],
});

const eldritchBlast = (entry: Record<string, unknown> = {}) =>
  spell(
    {
      name: "Eldritch Blast",
      modifiers: [{ type: "damage", subType: "force", die: { diceString: "1d10" } }],
    },
    { usesSpellSlot: false, countsAsKnownSpell: true, ...entry },
  );

test("a cantrip is available even though prepared is false", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([eldritchBlast({ prepared: false, alwaysPrepared: false, countsAsKnownSpell: false })]),
    { scores: scores({ cha: 16 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out.length, 1, "a warlock's cantrip must import despite prepared=false");
  assert.equal(out[0]!.name, "eldritch blast");
});

test("spell attack bonus is the spellcasting modifier plus proficiency", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([eldritchBlast()]),
    { scores: scores({ cha: 17 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out[0]!.bonus, 3 + 3);
});

test("Eldritch Blast reports its beam count rather than inflating one roll", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([eldritchBlast()]),
    { scores: scores({ cha: 16 }), proficiencyBonus: 3, totalLevel: 11, ability: "cha" },
    w,
  );
  assert.equal(out[0]!.damage[0]!.expression, "1d10", "beams must not be folded into one damage roll");
  assert.match(out[0]!.note ?? "", /3 beams/);
});

test("an unknown, unprepared levelled spell is excluded with a reason", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([
      spell(
        { name: "Chromatic Orb", level: 1, modifiers: [{ type: "damage", subType: "fire", die: { diceString: "3d8" } }] },
        { usesSpellSlot: true },
      ),
    ]),
    { scores: scores({ cha: 16 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out.length, 0);
  assert.match(w.join(" "), /not prepared and was not imported/);
});

test("sustained damage is not added to the initial hit", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([
      spell(
        {
          name: "Witch Bolt", level: 1,
          modifiers: [
            { type: "damage", subType: "lightning", die: { diceString: "2d12" } },
            { type: "damage", subType: "lightning", die: { diceString: "1d12" } },
          ],
        },
        { usesSpellSlot: true, countsAsKnownSpell: true },
      ),
    ]),
    { scores: scores({ cha: 16 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out[0]!.damage.length, 1);
  assert.equal(out[0]!.damage[0]!.expression, "2d12");
  assert.match(w.join(" "), /sustained or upcast damage is not applied/);
});

test("spells that need no attack roll are ignored", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([spell({ name: "Mage Hand", requiresAttackRoll: false })]),
    { scores: scores(), proficiencyBonus: 2, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out.length, 0);
});

test("an unscaled damage cantrip warns rather than guessing its dice", () => {
  const w: string[] = [];
  spellAttacks(
    spellPayload([
      spell(
        { name: "Fire Bolt", modifiers: [{ type: "damage", subType: "fire", die: { diceString: "1d10" } }] },
        { usesSpellSlot: false, countsAsKnownSpell: true },
      ),
    ]),
    { scores: scores(), proficiencyBonus: 3, totalLevel: 11, ability: "cha" },
    w,
  );
  assert.match(w.join(" "), /scaling was NOT applied automatically/);
});

test("Agonizing Blast adds the spellcasting modifier to each beam", () => {
  const w: string[] = [];
  const data = {
    ...spellPayload([eldritchBlast()]),
    options: { class: [{ definition: { name: "Agonizing Blast (Eldritch Blast)" } }] },
  };
  const out = spellAttacks(
    data,
    { scores: scores({ cha: 17 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out[0]!.damage[0]!.expression, "1d10+3");
  assert.match(out[0]!.note ?? "", /Agonizing Blast/);
});

test("a cantrip without the invocation keeps its bare damage", () => {
  const w: string[] = [];
  const out = spellAttacks(
    spellPayload([eldritchBlast()]),
    { scores: scores({ cha: 17 }), proficiencyBonus: 3, totalLevel: 5, ability: "cha" },
    w,
  );
  assert.equal(out[0]!.damage[0]!.expression, "1d10");
});

test("damageRiders names the spell the invocation targets", () => {
  const riders = damageRiders({
    options: { class: [{ definition: { name: "Agonizing Blast (Eldritch Blast)" } }] },
  });
  assert.ok(riders.has("eldritch blast"));
});

// ── Against the pinned live payload ───────────────────────────────────────

const fixture = JSON.parse(readFileSync("test/fixtures/ddb/167935384.json", "utf8"));

test("the real payload yields the warlock's actual attacks", () => {
  const result = normalizeDdb(fixture);
  assert.ok(result.ok, result.ok ? "" : result.error);
  const attacks = result.value.combatant.attacks ?? [];
  const names = attacks.map((a) => a.name);

  assert.ok(names.includes("eldritch blast"), `expected eldritch blast, got ${names.join(", ")}`);
  assert.ok(names.includes("dagger"));
  assert.equal(names.filter((n) => n === "dagger").length, 1, "the two daggers must collapse");

  const eb = attacks.find((a) => a.name === "eldritch blast")!;
  assert.equal(eb.bonus, 6, "CHA +3 plus proficiency +3");
  assert.equal(eb.damage[0]!.expression, "1d10+3", "Agonizing Blast must be applied");
  assert.equal(eb.melee, false);
});

test("proficiencies and spellcasting ability read off the real payload", () => {
  const data = (fixture as { data: unknown }).data;
  assert.ok(proficiencySubtypes(data).has("simple-weapons"));
  assert.equal(spellcastingAbility(data), "cha");
});

test("derived attacks all carry usable dice expressions", () => {
  const result = normalizeDdb(fixture);
  assert.ok(result.ok);
  for (const a of result.value.combatant.attacks ?? []) {
    for (const d of a.damage) {
      assert.match(d.expression, /^\d*d\d+([+-]\d+)?$/, `${a.name} has odd damage "${d.expression}"`);
    }
  }
});
