import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeDdb, proficiencyBonusForLevel } from "./ddb.ts";
import { abilityModifier } from "../types.ts";

const FIXTURE = "test/fixtures/ddb/167935384.json";
const raw = JSON.parse(readFileSync(FIXTURE, "utf8"));

function imported() {
  const r = normalizeDdb(raw);
  assert.ok(r.ok, `import failed: ${r.ok ? "" : r.error}`);
  return r.value;
}

test("imports the character identity", () => {
  const { combatant, meta } = imported();
  assert.equal(combatant.name, "Moab Yebàn");
  assert.equal(combatant.id, "moab-yeban");
  assert.equal(meta.ddbId, 167935384);
  assert.equal(meta.totalLevel, 5);
  assert.deepEqual(meta.classes, [{ name: "Warlock", subclass: "Future You Patron", level: 5 }]);
  assert.equal(meta.background, "Zhentarim Mercenary");
  assert.equal(meta.ruleset, "2024");
});

test("stacks ability score bonuses from distinct sources", () => {
  const { combatant, derivations } = imported();
  // Base 15 Dex, +1 Moderately Armored, +1 Zhentarim background ASI.
  assert.equal(combatant.abilities.dex, 17);
  // Base 15 Cha, +2 Zhentarim background ASI.
  assert.equal(combatant.abilities.cha, 17);
  assert.equal(combatant.abilities.str, 11);
  assert.equal(combatant.abilities.con, 15);
  assert.equal(combatant.abilities.int, 13);
  assert.equal(combatant.abilities.wis, 12);
  assert.match(derivations.abilities.dex.explanation, /base 15/);
});

test("isGranted:false does not suppress an applied bonus", () => {
  // Moderately Armored's +1 Dex carries isGranted:false in the payload yet is
  // applied on the real sheet. Guard against re-introducing that filter.
  const { combatant } = imported();
  assert.equal(combatant.abilities.dex, 17, "Dex bonuses with isGranted:false must still apply");
});

test("derives proficiency bonus from total level", () => {
  assert.equal(imported().combatant.proficiencyBonus, 3);
});

test("caps Dex under medium armor and adds the shield", () => {
  const { combatant, derivations } = imported();
  // Chain Shirt 13 (medium, +2 Dex cap) + Dex +2 of +3 + Shield 2 = 17.
  assert.equal(abilityModifier(combatant.abilities.dex), 3);
  assert.equal(combatant.ac, 17);
  assert.match(derivations.armorClass.explanation, /capped from \+3/);
  assert.match(derivations.armorClass.explanation, /Shield \+2/);
});

test("a Potion of Healing in the pack does not inflate maximum HP", () => {
  // The flattened `modifiers.item` bucket contains the potion's 4d4+4 as
  // bonus/hit-points. Reading that bucket would yield 42 instead of 38.
  const { combatant, warnings } = imported();
  assert.equal(combatant.hp.max, 38, "28 class hit dice + (Con +2 x 5 levels)");
  assert.ok(
    !warnings.some((w) => w.includes("Potion")),
    "the potion should be excluded outright, not applied with a warning",
  );
});

test("carries current and temporary hit points from the sheet", () => {
  const { combatant } = imported();
  assert.equal(combatant.hp.current, 38);
  assert.equal(combatant.hp.temp, 14);
});

test("adds feat speed bonuses to the species walk speed", () => {
  const { combatant, derivations } = imported();
  assert.equal(combatant.speed, 40);
  assert.match(derivations.speed.explanation, /species walk 30/);
});

test("reads saving throw proficiencies", () => {
  const { combatant } = imported();
  assert.deepEqual([...combatant.saveProficiencies].sort(), ["cha", "wis"]);
});

test("starts with a clean combat state", () => {
  const { combatant } = imported();
  assert.deepEqual(combatant.conditions, []);
  assert.equal(combatant.exhaustion, 0);
  assert.equal(combatant.concentration, null);
  assert.deepEqual(combatant.deathSaves, { successes: 0, failures: 0 });
  assert.equal(combatant.stable, false);
  assert.equal(combatant.isPlayer, true);
});

test("every derived number explains itself", () => {
  const { derivations } = imported();
  for (const d of [derivations.armorClass, derivations.maxHitPoints, derivations.speed]) {
    assert.ok(d.explanation.length > 0, "derivation must carry an explanation");
  }
});

test("accepts the bare character object as well as the service envelope", () => {
  const bare = normalizeDdb(raw.data);
  const wrapped = normalizeDdb(raw);
  assert.ok(bare.ok && wrapped.ok);
  assert.deepEqual(bare.value.combatant, wrapped.value.combatant);
});

test("rejects malformed payloads with an error value, never a throw", () => {
  for (const bad of [null, 42, "nope", {}, { data: {} }, { data: { name: "x" } }]) {
    const r = normalizeDdb(bad);
    assert.equal(r.ok, false, `expected ${JSON.stringify(bad)} to be rejected`);
  }
});

test("surfaces a service-level failure message", () => {
  const r = normalizeDdb({ success: false, message: "Character not found or is private." });
  assert.equal(r.ok, false);
  if (!r.ok) assert.match(r.error, /private/);
});

test("warns when a 2014 character is imported into the 2024 engine", () => {
  const legacy = structuredClone(raw);
  legacy.data.race.isLegacy = true;
  const r = normalizeDdb(legacy);
  assert.ok(r.ok);
  assert.equal(r.value.meta.ruleset, "2014");
  assert.ok(r.value.warnings.some((w) => w.includes("2014")));
});

test("falls back to 10 + Dex with no armor, and says so", () => {
  const naked = structuredClone(raw);
  naked.data.inventory = naked.data.inventory.filter(
    (i: { definition: { armorClass: number | null } }) => i.definition.armorClass == null,
  );
  const r = normalizeDdb(naked);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.ac, 13); // 10 + Dex 3
  assert.ok(r.value.warnings.some((w) => w.includes("Unarmored Defense")));
});

test("an override on the sheet wins over computed values", () => {
  const o = structuredClone(raw);
  o.data.overrideHitPoints = 99;
  o.data.overrideStats = o.data.overrideStats.map((s: { id: number }) =>
    s.id === 1 ? { ...s, value: 20 } : s,
  );
  const r = normalizeDdb(o);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.hp.max, 99);
  assert.equal(r.value.combatant.abilities.str, 20);
});

test("proficiency bonus follows the level table", () => {
  const expected: [number, number][] = [
    [1, 2], [4, 2], [5, 3], [8, 3], [9, 4], [12, 4], [13, 5], [16, 5], [17, 6], [20, 6],
  ];
  for (const [level, pb] of expected) {
    assert.equal(proficiencyBonusForLevel(level), pb, `level ${level}`);
  }
});

test("derivations name the granting feature, not the generic subtype", () => {
  const { derivations } = imported();
  assert.match(derivations.abilities.dex.explanation, /Moderately Armored \+1/);
  assert.match(derivations.abilities.cha.explanation, /Zhentarim Mercenary Ability Score Increase \+2/);
  assert.match(derivations.speed.explanation, /I Survived to Tell the Tale \+10/);
  assert.ok(
    !derivations.abilities.dex.explanation.includes("Dexterity Score"),
    "should not fall back to the generic subtype label when a source name is known",
  );
});
