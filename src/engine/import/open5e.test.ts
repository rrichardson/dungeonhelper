import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { normalizeCreature, proficiencyForCr, parseHitDice } from "./open5e.ts";
import { searchConditions, findCreature, type Open5eDeps } from "../../adapters/open5e.ts";
import type { FetchLike } from "../../adapters/ddb.ts";

const fixture = JSON.parse(readFileSync("test/fixtures/open5e/goblin-warrior.json", "utf8"));
const goblin = fixture.results[0];

test("proficiency bonus follows the challenge rating bands", () => {
  assert.equal(proficiencyForCr(0), 2);
  assert.equal(proficiencyForCr(4), 2);
  assert.equal(proficiencyForCr(5), 3);
  assert.equal(proficiencyForCr(9), 4);
  assert.equal(proficiencyForCr(17), 6);
  assert.equal(proficiencyForCr(30), 9);
});

test("hit dice parse into a pool", () => {
  assert.deepEqual(parseHitDice("3d6"), { max: 3, size: 6 });
  assert.deepEqual(parseHitDice("12d10 + 24"), { max: 12, size: 10 });
  assert.equal(parseHitDice("nonsense"), null);
  assert.equal(parseHitDice(undefined), null);
});

test("a real SRD creature normalizes into a usable stat block", () => {
  const r = normalizeCreature(goblin);
  assert.ok(r.ok, r.ok ? "" : r.error);
  const c = r.value.combatant;
  assert.equal(c.name, "Goblin Warrior");
  assert.equal(c.id, "goblin-warrior");
  assert.equal(c.ac, 15);
  assert.equal(c.hp.max, 10);
  assert.equal(c.speed, 30);
  assert.equal(c.abilities.dex, 15);
  assert.equal(c.isPlayer, false);
  assert.deepEqual(c.hitDice, { size: 6, max: 3, used: 0 });
});

test("proficiency bonus is derived when the payload omits it", () => {
  assert.equal(goblin.proficiency_bonus, null, "fixture should exercise the null case");
  const r = normalizeCreature(goblin);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.proficiencyBonus, 2);
});

test("attacks carry a to-hit bonus and a full damage expression", () => {
  const r = normalizeCreature(goblin);
  assert.ok(r.ok);
  const scimitar = r.value.combatant.attacks!.find((a) => a.name === "scimitar")!;
  assert.equal(scimitar.bonus, 4);
  assert.equal(scimitar.damage[0]!.expression, "1d6+2");
  assert.equal(scimitar.damage[0]!.type, "slashing");
  assert.equal(scimitar.melee, true);
});

test("a ranged attack is marked ranged and keeps its range", () => {
  const r = normalizeCreature(goblin);
  assert.ok(r.ok);
  const bow = r.value.combatant.attacks!.find((a) => a.name === "shortbow")!;
  assert.equal(bow.melee, false);
  assert.match(bow.note ?? "", /range 80/);
});

test("a null damage type falls back to the extra damage type", () => {
  assert.equal(goblin.actions[0].attacks[0].damage_type, null, "fixture should exercise the fallback");
  const r = normalizeCreature(goblin);
  assert.ok(r.ok);
  assert.equal(r.value.combatant.attacks![0]!.damage[0]!.type, "slashing");
});

test("a conditional damage rider stated only in prose is still flagged", () => {
  const r = normalizeCreature(goblin);
  assert.ok(r.ok);
  assert.match(
    r.value.warnings.join(" "),
    /conditional extra damage that is not applied automatically/,
  );
});

test("save proficiency is inferred from a bonus above the ability modifier", () => {
  const proficient = {
    ...goblin,
    ability_scores: { strength: 10, dexterity: 10, constitution: 10, intelligence: 10, wisdom: 10, charisma: 10 },
    saving_throws: { strength: 0, dexterity: 4, constitution: 0, intelligence: 0, wisdom: 0, charisma: 0 },
  };
  const r = normalizeCreature(proficient);
  assert.ok(r.ok);
  assert.deepEqual(r.value.combatant.saveProficiencies, ["dex"]);
});

test("damage types the engine does not model are dropped with a warning", () => {
  const odd = {
    ...goblin,
    resistances_and_immunities: {
      damage_resistances: [{ key: "fire" }, { key: "sonic" }],
      damage_immunities: [], damage_vulnerabilities: [], condition_immunities: [],
    },
  };
  const r = normalizeCreature(odd);
  assert.ok(r.ok);
  assert.deepEqual(r.value.combatant.resistances, ["fire"]);
  assert.match(r.value.warnings.join(" "), /resistance "sonic" is not modelled/);
});

test("a payload missing the essentials is refused", () => {
  assert.equal(normalizeCreature({}).ok, false);
  assert.equal(normalizeCreature({ name: "X" }).ok, false);
  assert.equal(normalizeCreature({ name: "X", ability_scores: { strength: 10 } }).ok, false);
  assert.equal(normalizeCreature("nope").ok, false);
});

// ── Client behaviour ──────────────────────────────────────────────────────

function stubFetch(byUrl: (url: string) => unknown): FetchLike {
  return async (url: string) => ({
    ok: true,
    status: 200,
    text: async () => JSON.stringify(byUrl(url)),
  });
}

const deps = (fetch: FetchLike): Open5eDeps => ({ fetch });

test("conditions are filtered locally because the endpoint ignores the filter", async () => {
  // The real endpoint returns every condition regardless of the query.
  const all = { results: [{ name: "Bloodied" }, { name: "Grappled" }, { name: "Confused" }] };
  const r = await searchConditions("grappled", deps(stubFetch(() => all)));
  assert.ok(r.ok);
  assert.equal(r.value.length, 1);
  assert.equal((r.value[0] as { name: string }).name, "Grappled");
});

test("an exact creature name wins over a substring search", async () => {
  const r = await findCreature("Goblin", deps(stubFetch((url) =>
    url.includes("iexact")
      ? { results: [{ name: "Goblin", exact: true }] }
      : { results: [{ name: "Goblin Boss" }, { name: "Goblin Minion" }] },
  )));
  assert.ok(r.ok);
  assert.equal((r.value as { exact?: boolean }).exact, true);
});

test("an ambiguous name is refused with the candidates named", async () => {
  const r = await findCreature("goblin", deps(stubFetch((url) =>
    url.includes("iexact")
      ? { results: [] }
      : { results: [{ name: "Goblin Boss" }, { name: "Goblin Minion" }] },
  )));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /Goblin Boss, Goblin Minion/);
});

test("no match at all is reported plainly", async () => {
  const r = await findCreature("wyrm of nothing", deps(stubFetch(() => ({ results: [] }))));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /no creature matching/);
});

test("an HTTP error surfaces rather than being swallowed", async () => {
  const failing: FetchLike = async () => ({ ok: false, status: 503, text: async () => "" });
  const r = await searchConditions("x", deps(failing));
  assert.equal(r.ok, false);
  assert.match(r.ok ? "" : r.error, /HTTP 503/);
});
